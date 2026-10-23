// Crea o actualiza las Lambdas del proyecto Pedidos360.
//
//   node scripts/deploy.js                -> despliega todo
//   node scripts/deploy.js --mensajeria   -> solo las Lambdas de mensajeria
//   node scripts/deploy.js --sin-mensajeria -> solo catalogo y pedidos
//
// AWS Academy no permite crear roles IAM: se reutiliza el rol existente "LabRole".
// Puedes forzar otro con LAMBDA_ROLE_ARN=arn:aws:iam::<cuenta>:role/<rol>.
//
// Nombres de recursos, variables de entorno y tiempos: todo sale de
// src/shared/config.js (configuración centralizada).
import AdmZip from 'adm-zip';
import {
  AddPermissionCommand,
  CreateEventSourceMappingCommand,
  CreateFunctionCommand,
  GetFunctionCommand,
  LambdaClient,
  ListEventSourceMappingsCommand,
  UpdateEventSourceMappingCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
  waitUntilFunctionActiveV2,
  waitUntilFunctionUpdatedV2,
} from '@aws-sdk/client-lambda';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { ListTopicsCommand, SNSClient } from '@aws-sdk/client-sns';
// Este SDK es CommonJS y no expone todos sus simbolos como named exports en
// ESM, asi que se importa por defecto.
import apigatewayv2Sdk from '@aws-sdk/client-apigatewayv2';

const { GetApisCommand, ApiGatewayV2Client } = apigatewayv2Sdk;
const {
  CreateIntegrationCommand,
  CreateRouteCommand,
  GetAuthorizersCommand,
  GetIntegrationsCommand,
  GetRoutesCommand,
  UpdateRouteCommand,
} = apigatewayv2Sdk;

import { NOMBRES, TOPOLOGIA, VARIABLES } from '../src/shared/config.js';

const region = process.env.AWS_REGION ?? 'us-east-1';
const lambda = new LambdaClient({ region });
const sqs = new SQSClient({ region });
const sns = new SNSClient({ region });
const apigatewayv2 = new ApiGatewayV2Client({ region });
const TABLE_PRODUCTOS = process.env.TABLE_PRODUCTOS ?? 'Pedidos360-Productos';
const TABLE_PEDIDOS = process.env.TABLE_PEDIDOS ?? 'Pedidos360-Pedidos';
const TABLE_EVENTOS = process.env.TABLE_EVENTOS_PROCESADOS ?? 'Pedidos360-EventosProcesados';
const TABLE_NOTIFICACIONES = process.env.TABLA_NOTIFICACIONES ?? 'Pedidos360-Notificaciones';

const soloMensajeria = process.argv.includes('--mensajeria');
const sinMensajeria = process.argv.includes('--sin-mensajeria');

/**
 * Runtime de cada familia de funciones.
 * La guia de la EP2 pide Node.js 20 para las Lambdas de mensajeria; las del
 * proyecto base ya migraron a Node.js 22. Se puede forzar con
 * LAMBDA_RUNTIME=nodejs22.x para dejar todo igual.
 */
const RUNTIME = {
  base: process.env.LAMBDA_RUNTIME ?? 'nodejs22.x',
  mensajeria: process.env.LAMBDA_RUNTIME_MENSAJERIA ?? 'nodejs20.x',
};

/** ---------------------------------------------------------------- recursos */

/** Busca el ARN del topic por nombre. Devuelve undefined si no existe. */
async function arnDelTopic(nombre) {
  if (process.env.TOPIC_ARN) return process.env.TOPIC_ARN;
  try {
    const { Topics } = await sns.send(new ListTopicsCommand({}));
    const encontrado = Topics.find((t) => t.TopicArn.endsWith(`:${nombre}`));
    if (!encontrado) return undefined;
    return encontrado.TopicArn;
  } catch {
    return undefined;
  }
}

/** Devuelve la URL de una cola por nombre, o undefined si no existe. */
async function urlDeCola(nombre) {
  try {
    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: nombre }));
    return QueueUrl;
  } catch {
    return undefined;
  }
}

/** ---------------------------------------------------------------- funciones */

const funciones = [
  {
    nombre: 'pedidos360-catalogo',
    dir: 'catalogo',
    familia: 'base',
    env: { TABLE_PRODUCTOS },
  },
  {
    nombre: 'pedidos360-pedidos',
    dir: 'pedidos',
    familia: 'base',
    // Publica los eventos del pedido (PedidoCreado, PedidoAceptado...).
    env: { TABLE_PRODUCTOS, TABLE_PEDIDOS },
    topico: true,
  },
  {
    nombre: 'pedidos360-publicar-evento',
    dir: 'publicarevento',
    familia: 'mensajeria',
    env: {},
    topico: true,
    timeout: 10,
  },
  {
    nombre: 'notificar-email',
    dir: 'email',
    familia: 'mensajeria',
    env: {},
    cola: 'email',
    dominio: 'email',
  },
  {
    nombre: 'ticket-cocina',
    dir: 'cocina',
    familia: 'mensajeria',
    env: {},
    cola: 'cocina',
    dominio: 'cocina',
  },
  {
    nombre: 'generar-boleta',
    dir: 'boleta',
    familia: 'mensajeria',
    env: {},
    cola: 'boleta',
    dominio: 'boleta',
  },
  {
    nombre: 'notificar-frontend',
    dir: 'notificaciones',
    familia: 'mensajeria',
    env: {},
    cola: 'notificaciones',
    dominio: 'notificaciones',
  },
];

async function resolverRol() {
  if (process.env.LAMBDA_ROLE_ARN) return process.env.LAMBDA_ROLE_ARN;
  const { Account } = await new STSClient({ region }).send(new GetCallerIdentityCommand({}));
  return `arn:aws:iam::${Account}:role/LabRole`;
}

function empaquetar(dir) {
  const zip = new AdmZip();
  zip.addLocalFile(`dist/${dir}/index.mjs`);
  return zip.toBuffer();
}

async function existe(FunctionName) {
  try {
    await lambda.send(new GetFunctionCommand({ FunctionName }));
    return true;
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') return false;
    throw err;
  }
}

function configDe(fn) {
  const esConsumidor = Boolean(fn.cola);
  return {
    Runtime: fn.familia === 'mensajeria' ? RUNTIME.mensajeria : RUNTIME.base,
    Handler: 'index.handler',
    Timeout: fn.timeout ?? (esConsumidor ? TOPOLOGIA.lambdaTimeout : 10),
    MemorySize: 256,
    Architectures: ['arm64'], // más barata que x86_64
  };
}

/**
 * Construye el mapa de variables de entorno de una función.
 * Los NOMBRES de las variables vienen de src/shared/config.js.
 */
async function entornoDe(fn, topicArn) {
  const env = { ...fn.env };
  if (fn.topico) {
    if (topicArn) env[VARIABLES.topicArn] = topicArn;
  }
  if (fn.cola) {
    const nombres = NOMBRES.colas[fn.dominio];
    const url = await urlDeCola(nombres.cola);
    const dlqUrl = await urlDeCola(nombres.dlq);
    if (url) env[VARIABLES.colas[fn.dominio].url] = url;
    if (dlqUrl) env[VARIABLES.colas[fn.dominio].dlqUrl] = dlqUrl;
    env[VARIABLES.tablaEventos] = TABLE_EVENTOS;
    env[VARIABLES.tablaNotificaciones] = TABLE_NOTIFICACIONES;
  }
  return env;
}

// ---------------------------------------------------------------- triggers SQS

/**
 * Crea o actualiza el event source mapping entre la cola y la Lambda.
 *
 * `FunctionResponseTypes: ['ReportBatchItemFailures']` es OBLIGATORIO: sin eso
 * la Lambda no puede devolver `batchItemFailures` y los mensajes fallidos se
 * confirman igual (no habria reintentos ni DLQ).
 */
async function asegurarTrigger(fn, queueArn) {
  const { EventSourceMappings } = await lambda.send(
    new ListEventSourceMappingsCommand({ FunctionName: fn.nombre }),
  );
  const porCola = (EventSourceMappings ?? []).find((m) => m.EventSourceArn === queueArn);

  if (porCola) {
    await lambda.send(
      new UpdateEventSourceMappingCommand({
        UUID: porCola.UUID,
        BatchSize: TOPOLOGIA.batchSize,
        FunctionResponseTypes: ['ReportBatchItemFailures'],
        Enabled: true,
        ScalingConfig: { MaximumConcurrency: 10 },
      }),
    );
    console.log(`  ~ trigger SQS actualizado (${porCola.UUID})`);
    return porCola.UUID;
  }

  const { UUID } = await lambda.send(
    new CreateEventSourceMappingCommand({
      EventSourceArn: queueArn,
      FunctionName: fn.nombre,
      BatchSize: TOPOLOGIA.batchSize,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      Enabled: true,
      ScalingConfig: { MaximumConcurrency: 10 },
    }),
  );
  console.log(`  + trigger SQS creado (${UUID})`);
  return UUID;
}

/** Permite que SQS invoque la funcion. */
async function permitirInvocacionDesdeSqs(fn, queueArn) {
  try {
    await lambda.send(
      new AddPermissionCommand({
        FunctionName: fn.nombre,
        StatementId: 'PermitirInvocacionDesdeSqs',
        Action: 'lambda:InvokeFunction',
        Principal: 'sqs.amazonaws.com',
        SourceArn: queueArn,
      }),
    );
  } catch (err) {
    // ResourceConflictException / InvalidParameterValueException: el permiso ya
    // existe con esos mismos parametros. No es un problema, se sigue.
    if (err?.name !== 'ResourceConflictException' && err?.name !== 'InvalidParameterValueException') {
      throw err;
    }
  }
}

async function arnDeCola(queueUrl) {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
  );
  return Attributes?.QueueArn;
}

// ---------------------------------------------------------------- API Gateway

/**
 * API Gateway HTTP API necesita que la RESOURCE POLICY de la Lambda permita
 * la invocacion para cada ruta que la sirve. Si falta ese permiso, la API
 * responde 500 con API_CONFIGURATION_ERROR (no es un error del codigo de la
 * Lambda, y no aparece en sus logs).
 *
 * Se resuelve aqui para que un despliegue en otra cuenta no falle igual.
 */
async function idDeApiGateway() {
  if (process.env.API_ID) return process.env.API_ID;
  try {
    const { Items } = await apigatewayv2.send(new GetApisCommand({}));
    const api = (Items ?? []).find((a) => a.Name === 'pedidos360-api');
    return api?.ApiId;
  } catch {
    return undefined;
  }
}

/** Rutas que sirve cada funcion, para poder concederle la invocacion. */
const RUTAS_POR_FUNCION = {
  'pedidos360-pedidos': ['GET /notificaciones'],
  'pedidos360-publicar-evento': ['POST /eventos'],
  'pedidos360-catalogo': ['GET /catalogo/comprar'],
};

/**
 * Rutas que este script crea en API Gateway (integracion + ruta + permiso).
 * Las 9 rutas del proyecto base ya existen y NO se tocan: se crean aparte.
 */
const RUTAS_API = [
  { fn: 'pedidos360-catalogo', ruta: 'GET /catalogo/comprar' },
  { fn: 'pedidos360-pedidos', ruta: 'GET /notificaciones' },
  { fn: 'pedidos360-publicar-evento', ruta: 'POST /eventos' },
];

/** Crea la integracion AWS_PROXY hacia la Lambda, o la reutiliza. */
async function asegurarIntegracion(fn, apiId) {
  const { Items } = await apigatewayv2.send(new GetIntegrationsCommand({ ApiId: apiId }));
  const uri = `arn:aws:lambda:${region}:${cuenta}:function:${fn.nombre}`;
  const existente = (Items ?? []).find((i) => i.IntegrationUri === uri);
  if (existente) return existente.IntegrationId;

  const { IntegrationId } = await apigatewayv2.send(
    new CreateIntegrationCommand({
      ApiId: apiId,
      IntegrationType: 'AWS_PROXY',
      IntegrationUri: uri,
      PayloadFormatVersion: '2.0',
    }),
  );
  console.log(`  integracion creada -> ${fn.nombre} (${IntegrationId})`);
  return IntegrationId;
}

/**
 * Asegura que exista la ruta en API Gateway, con el authorizer JWT.
 * Idempotente: si ya existe, solo la actualiza.
 */
async function asegurarRutaApiGateway(ruta, fn, apiId) {
  const { Items } = await apigatewayv2.send(new GetRoutesCommand({ ApiId: apiId }));
  const [metodo, ...resto] = ruta.ruta.split(' ');
  const clave = `${metodo} ${resto.join(' ')}`;
  const existente = (Items ?? []).find((r) => r.RouteKey === clave);

  const { Items: authorizers } = await apigatewayv2.send(new GetAuthorizersCommand({ ApiId: apiId }));
  const authorizer = (authorizers ?? []).find((a) => a.Name === 'entra-jwt') ?? (authorizers ?? [])[0];
  const authorizerId = authorizer?.AuthorizerId;

  if (existente) {
    await apigatewayv2.send(
      new UpdateRouteCommand({
        ApiId: apiId,
        RouteId: existente.RouteId,
        RouteKey: clave,
        AuthorizationType: authorizerId ? 'JWT' : 'NONE',
        ...(authorizerId ? { AuthorizerId: authorizerId } : {}),
      }),
    );
    console.log(`  ruta actualizada: ${clave}`);
    return;
  }

  const integracion = await asegurarIntegracion(fn, apiId);
  const { RouteId } = await apigatewayv2.send(
    new CreateRouteCommand({
      ApiId: apiId,
      RouteKey: clave,
      Target: `integrations/${integracion}`,
      AuthorizationType: authorizerId ? 'JWT' : 'NONE',
      ...(authorizerId ? { AuthorizerId: authorizerId } : {}),
    }),
  );
  console.log(`  ruta creada: ${clave} (${RouteId})`);
}

async function permitirInvocacionDesdeApiGateway(fn, apiId, account) {
  const rutas = RUTAS_POR_FUNCION[fn.nombre];
  if (!rutas || !apiId) return;
  for (const ruta of rutas) {
    const [metodo, ...resto] = ruta.split(' ');
    const recurso = resto.join(' ');
    // Formato del SourceArn de execute-api: .../<stage>/<metodo><recurso>
    // OJO: metodo y recurso van PEGADOS, sin espacio ("GET/notificaciones").
    const sourceArn = `arn:aws:execute-api:${region}:${account}:${apiId}/*/${metodo}${recurso}`;
    const statementId = `ApiGatewayInvoke${metodo}${recurso.replace(/[^A-Za-z0-9]/g, '')}`;
    try {
      await lambda.send(
        new AddPermissionCommand({
          FunctionName: fn.nombre,
          StatementId: statementId,
          Action: 'lambda:InvokeFunction',
          Principal: 'apigateway.amazonaws.com',
          SourceArn: sourceArn,
        }),
      );
      console.log(`  permiso API Gateway -> ${ruta}`);
    } catch (err) {
      // ResourceConflictException: el permiso ya existe. No es un problema.
      if (err?.name !== 'ResourceConflictException' && err?.name !== 'InvalidParameterValueException') {
        throw err;
      }
    }
  }
}

// ---------------------------------------------------------------- main

const Role = await resolverRol();
const topicArn = await arnDelTopic(NOMBRES.topic);
const apiId = await idDeApiGateway();
const cuenta = (await new STSClient({ region }).send(new GetCallerIdentityCommand({}))).Account;
console.log(`Región: ${region} | Rol: ${Role}`);
console.log(`Topic: ${topicArn ?? 'NO ENCONTRADO (ejecuta: npm run messaging)'}`);
console.log(`API Gateway: ${apiId ?? 'no encontrada'}`);

const seleccionadas = funciones.filter((fn) => {
  if (soloMensajeria) return fn.familia === 'mensajeria';
  if (sinMensajeria) return fn.familia === 'base';
  return true;
});

for (const fn of seleccionadas) {
  const ZipFile = empaquetar(fn.dir);
  const wait = { client: lambda, maxWaitTime: 120 };
  const cfg = configDe(fn);
  const Environment = { Variables: await entornoDe(fn, topicArn) };
  let arn;

  if (await existe(fn.nombre)) {
    await lambda.send(
      new UpdateFunctionCodeCommand({ FunctionName: fn.nombre, ZipFile, Architectures: cfg.Architectures }),
    );
    await waitUntilFunctionUpdatedV2(wait, { FunctionName: fn.nombre });

    // Mismo respaldo que en la creacion: si el runtime guardado ya no es
    // valido, se actualiza con el disponible.
    const runtimes = [cfg.Runtime];
    if (cfg.Runtime !== RUNTIME.base) runtimes.push(RUNTIME.base);

    let actualizado = null;
    for (const runtime of runtimes) {
      try {
        actualizado = await lambda.send(
          new UpdateFunctionConfigurationCommand({
            FunctionName: fn.nombre,
            Runtime: runtime,
            Handler: cfg.Handler,
            Timeout: cfg.Timeout,
            MemorySize: cfg.MemorySize,
            Environment,
          }),
        );
        if (runtime !== cfg.Runtime) {
          console.log(`  ! el runtime ${cfg.Runtime} ya no esta disponible: se actualizo con ${runtime}.`);
        }
        break;
      } catch (err) {
        const runtimeNoDisponible =
          err?.name === 'InvalidParameterValueException' &&
          /runtime|Runtime/i.test(err?.message ?? '');
        if (runtimeNoDisponible && runtimes.indexOf(runtime) < runtimes.length - 1) {
          console.log(`  ! AWS rechazo el runtime ${runtime}: se intenta con ${runtimes[runtimes.indexOf(runtime) + 1]}.`);
          continue;
        }
        throw err;
      }
    }
    const { FunctionArn } = actualizado;
    await waitUntilFunctionUpdatedV2(wait, { FunctionName: fn.nombre });
    arn = FunctionArn;
    console.log(`~ ${fn.nombre} actualizada`);
  } else {
    // La guia pide Node.js 20 para las Lambdas de mensajeria, pero AWS ya
    // podria haber retirado ese runtime. Si lo rechaza, se cae a nodejs22.x
    // automaticamente en vez de abortar el despliegue.
    const runtimes = [cfg.Runtime];
    if (cfg.Runtime !== RUNTIME.base) runtimes.push(RUNTIME.base);

    let creado = null;
    for (const runtime of runtimes) {
      try {
        creado = await lambda.send(
          new CreateFunctionCommand({
            FunctionName: fn.nombre,
            Role,
            Code: { ZipFile },
            Runtime: runtime,
            Handler: cfg.Handler,
            Timeout: cfg.Timeout,
            MemorySize: cfg.MemorySize,
            Architectures: cfg.Architectures,
            Environment,
          }),
        );
        if (runtime !== cfg.Runtime) {
          console.log(`  ! el runtime ${cfg.Runtime} ya no esta disponible: se creo con ${runtime}.`);
        }
        break;
      } catch (err) {
        const runtimeNoDisponible =
          err?.name === 'InvalidParameterValueException' &&
          /runtime|Runtime/i.test(err?.message ?? '');
        if (runtimeNoDisponible && runtimes.indexOf(runtime) < runtimes.length - 1) {
          console.log(`  ! AWS rechazo el runtime ${runtime}: se intenta con ${runtimes[runtimes.indexOf(runtime) + 1]}.`);
          continue;
        }
        throw err;
      }
    }
    const { FunctionArn } = creado;
    await waitUntilFunctionActiveV2(wait, { FunctionName: fn.nombre });
    arn = FunctionArn;
    console.log(`+ ${fn.nombre} creada`);
  }
  console.log(`  ${arn}`);

  // La Lambda debe poder ser invocada por API Gateway para las rutas que sirve.
  await permitirInvocacionDesdeApiGateway(fn, apiId, cuenta);

  // Trigger SQS para las consumidoras.
  if (fn.cola) {
    const cola = NOMBRES.colas[fn.dominio];
    const queueUrl = await urlDeCola(cola.cola);
    if (!queueUrl) {
      console.log(`  ! falta la cola ${cola.cola}: ejecuta "npm run messaging" y vuelve a desplegar.`);
    } else {
      const queueArn = await arnDeCola(queueUrl);
      await permitirInvocacionDesdeSqs(fn, queueArn);
      await asegurarTrigger(fn, queueArn);
    }
  }
}

// Las rutas de API Gateway que este proyecto agrega (las del proyecto base
// ya existen y no se tocan). Se crean aqui para que un despliegue en una
// cuenta nueva no deje la app a medias.
if (apiId) {
  console.log('\nRutas de API Gateway:');
  for (const ruta of RUTAS_API) {
    const fn = funciones.find((f) => f.nombre === ruta.fn);
    if (!fn) continue;
    await asegurarRutaApiGateway(ruta, fn, apiId);
    await permitirInvocacionDesdeApiGateway(fn, apiId, cuenta);
  }
}
