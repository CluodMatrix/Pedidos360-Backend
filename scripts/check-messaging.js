// Verifica que la topología de mensajería quedó como la pide la guía y la pauta.
//
//   node scripts/check-messaging.js
//
// No crea ni modifica nada: solo comprueba. Sirve para:
//   · el checklist final antes de entregar;
//   · responder en la oral "sí, está todo bien configurado".
import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ListQueuesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  GetSubscriptionAttributesCommand,
  ListSubscriptionsByTopicCommand,
  ListTopicsCommand,
  SNSClient,
} from '@aws-sdk/client-sns';
import {
  GetFunctionConfigurationCommand,
  LambdaClient,
  ListEventSourceMappingsCommand,
} from '@aws-sdk/client-lambda';

import { FILTROS, NOMBRES, TOPOLOGIA, VARIABLES } from '../src/shared/config.js';

const region = process.env.AWS_REGION ?? 'us-east-1';
const sqs = new SQSClient({ region });
const sns = new SNSClient({ region });
const lambda = new LambdaClient({ region });

let fallos = 0;
let avisos = 0;

function ok(mensaje) {
  console.log(`  [ok]   ${mensaje}`);
}
function mal(mensaje) {
  console.log(`  [FALLA] ${mensaje}`);
  fallos += 1;
}
function aviso(mensaje) {
  console.log(`  [aviso] ${mensaje}`);
  avisos += 1;
}
function titulo(texto) {
  console.log(`\n=== ${texto} ===`);
}

// ------------------------------------------------------------------ topic

async function verificarTopic() {
  titulo('SNS Topic');
  const { Topics } = await sns.send(new ListTopicsCommand({}));
  const topic = Topics.find((t) => t.TopicArn.endsWith(`:${NOMBRES.topic}`));
  if (!topic) {
    mal(`No existe el topic ${NOMBRES.topic}. Ejecuta: npm run messaging`);
    return null;
  }
  ok(`${NOMBRES.topic} -> ${topic.TopicArn}`);

  const { Subscriptions } = await sns.send(
    new ListSubscriptionsByTopicCommand({ TopicArn: topic.TopicArn }),
  );

  for (const dominio of ['email', 'cocina', 'boleta']) {
    const cola = NOMBRES.colas[dominio].cola;
    const sub = Subscriptions.find((s) => s.Endpoint?.endsWith(`:${cola}`));
    if (!sub) {
      mal(`La cola ${cola} no está suscrita a ${NOMBRES.topic}.`);
      continue;
    }
    if (sub.SubscriptionArn.endsWith(':pending-confirmation')) {
      mal(`La suscripción de ${cola} está SIN CONFIRMAR.`);
      continue;
    }
    ok(`suscripción de ${cola}: Confirmed`);

    // Atributos reales de la suscripción (filter policy, raw delivery).
    const { Attributes } = await sns.send(
      new GetSubscriptionAttributesCommand({ SubscriptionArn: sub.SubscriptionArn }),
    );

    // Raw message delivery: el mensaje llega sin el sobre de SNS.
    if (Attributes?.RawMessageDelivery !== 'true') {
      aviso(`La suscripción de ${cola} no tiene RawMessageDelivery activo.`);
    }

    const politica = Attributes?.FilterPolicy;
    const esperado = FILTROS[dominio];
    if (!esperado) {
      if (politica && politica !== 'null') {
        mal(`La suscripción de ${cola} debería NO tener filtro, pero tiene: ${politica}`);
      } else {
        ok(`filtro de ${cola}: sin filtro (recibe todos los eventos)`);
      }
    } else {
      const actual = politica && politica !== 'null' ? JSON.parse(politica) : null;
      if (JSON.stringify(actual) !== JSON.stringify(esperado)) {
        mal(
          `Filtro de ${cola} incorrecto. Esperado ${JSON.stringify(esperado)}, hay ${JSON.stringify(actual)}`,
        );
      } else {
        // El prefijo se representa como { prefix: "..." } dentro del array.
        const primer = esperado.tipo_evento?.[0];
        const estilo = primer && typeof primer === 'object' ? 'por prefijo' : 'exacto';
        ok(`filtro de ${cola}: ${estilo} -> ${JSON.stringify(esperado.tipo_evento)}`);
      }
    }
  }
  return topic.TopicArn;
}

// ------------------------------------------------------------------ colas

async function verificarColas() {
  titulo('Colas SQS');
  const { QueueUrls } = await sqs.send(new ListQueuesCommand({}));
  const nombres = QueueUrls.map((u) => u.split('/').pop());

  for (const dominio of ['email', 'cocina', 'boleta']) {
    const { cola, dlq } = NOMBRES.colas[dominio];

    if (!nombres.includes(dlq)) {
      mal(`Falta la DLQ ${dlq}.`);
      continue;
    }
    ok(`DLQ ${dlq} existe`);

    if (!nombres.includes(cola)) {
      mal(`Falta la cola ${cola}.`);
      continue;
    }
    ok(`cola ${cola} existe`);

    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: cola }));
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl,
        AttributeNames: ['VisibilityTimeout', 'RedrivePolicy', 'Policy'],
      }),
    );

    const visibility = Number(Attributes.VisibilityTimeout);
    if (visibility < TOPOLOGIA.lambdaTimeout) {
      mal(
        `Visibility timeout de ${cola} (${visibility}s) <= timeout de la Lambda (${TOPOLOGIA.lambdaTimeout}s). ` +
          'Un mensaje podria reaparecer mientras se procesa.',
      );
    } else {
      ok(`visibility timeout de ${cola}: ${visibility}s (> ${TOPOLOGIA.lambdaTimeout}s)`);
    }

    if (!Attributes.RedrivePolicy) {
      mal(`La cola ${cola} no tiene DLQ asociada (redrive policy).`);
    } else {
      const redrive = JSON.parse(Attributes.RedrivePolicy);
      // SNS/SQS devuelven maxReceiveCount como numero (no como string).
      if (Number(redrive.maxReceiveCount) !== Number(TOPOLOGIA.maxReceiveCount)) {
        mal(`maxReceiveCount de ${cola} es ${redrive.maxReceiveCount}, deberia ser ${TOPOLOGIA.maxReceiveCount}.`);
      } else {
        ok(`${cola} -> ${dlq} con maxReceiveCount=${redrive.maxReceiveCount}`);
      }
    }

    if (!Attributes.Policy || !Attributes.Policy.includes('sns.amazonaws.com')) {
      mal(`La cola ${cola} no tiene permiso para que SNS le escriba.`);
    } else {
      ok(`${cola} permite publicar desde sns.amazonaws.com`);
    }
  }
}

// ------------------------------------------------------------------ lambdas

const LAMBDA_CONSUMIDORAS = {
  'notificar-email': 'email',
  'ticket-cocina': 'cocina',
  'generar-boleta': 'boleta',
};

async function verificarLambdas(topicArn) {
  titulo('Lambdas');

  for (const [nombre, dominio] of Object.entries(LAMBDA_CONSUMIDORAS)) {
    let config;
    try {
      config = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: nombre }));
    } catch {
      mal(`No existe la Lambda ${nombre}.`);
      continue;
    }

    const env = config.Environment?.Variables ?? {};
    const esperado = {
      [VARIABLES.colas[dominio].url]: true,
      [VARIABLES.colas[dominio].dlqUrl]: true,
    };
    const faltan = Object.keys(esperado).filter((k) => !env[k]);
    if (faltan.length) {
      mal(`${nombre}: faltan variables de entorno: ${faltan.join(', ')}`);
    } else {
      ok(`${nombre}: variables de entorno completas`);
    }

    if (Number(config.Timeout) >= TOPOLOGIA.visibilityTimeout) {
      mal(
        `${nombre}: timeout ${config.Timeout}s >= visibility timeout ${TOPOLOGIA.visibilityTimeout}s. ` +
          'El mensaje podría reaparecer mientras se procesa.',
      );
    } else {
      ok(`${nombre}: timeout ${config.Timeout}s (< ${TOPOLOGIA.visibilityTimeout}s)`);
    }

    // Trigger SQS con Report batch item failures
    const { EventSourceMappings } = await lambda.send(
      new ListEventSourceMappingsCommand({ FunctionName: nombre }),
    );
    const mapping = (EventSourceMappings ?? [])[0];
    if (!mapping) {
      mal(`${nombre} no tiene trigger SQS.`);
    } else if (mapping.State !== 'Enabled') {
      mal(`El trigger SQS de ${nombre} esta ${mapping.State}, no Enabled.`);
    } else if (!mapping.FunctionResponseTypes?.includes('ReportBatchItemFailures')) {
      mal(
        `${nombre}: el trigger NO tiene "Report batch item failures". ` +
          'Sin esto los mensajes fallidos se confirmarian: no habria reintento ni DLQ.',
      );
    } else {
      ok(`${nombre}: trigger SQS Enabled con ReportBatchItemFailures (batch ${mapping.BatchSize})`);
    }
  }

  // Productora
  try {
    const config = await lambda.send(
      new GetFunctionConfigurationCommand({ FunctionName: 'pedidos360-publicar-evento' }),
    );
    const env = config.Environment?.Variables ?? {};
    if (!env[VARIABLES.topicArn]) {
      mal(`pedidos360-publicar-evento: falta ${VARIABLES.topicArn}.`);
    } else if (topicArn && env[VARIABLES.topicArn] !== topicArn) {
      mal(`pedidos360-publicar-evento: ${VARIABLES.topicArn} apunta a otro topic.`);
    } else {
      ok('pedidos360-publicar-evento: TOPIC_ARN configurado');
    }
  } catch {
    mal('No existe la Lambda pedidos360-publicar-evento.');
  }

  // Lambda de pedidos: debe poder publicar
  try {
    const config = await lambda.send(
      new GetFunctionConfigurationCommand({ FunctionName: 'pedidos360-pedidos' }),
    );
    const env = config.Environment?.Variables ?? {};
    if (env[VARIABLES.topicArn]) {
      ok('pedidos360-pedidos: TOPIC_ARN configurado (publica eventos del pedido)');
    } else {
      aviso('pedidos360-pedidos: sin TOPIC_ARN. Los pedidos NO publicaran eventos.');
    }
  } catch {
    mal('No existe la Lambda pedidos360-pedidos.');
  }
}

// ------------------------------------------------------------------ main

console.log(`Región: ${region}`);

try {
  const topicArn = await verificarTopic();
  await verificarColas();
  await verificarLambdas(topicArn);
} catch (err) {
  if (err?.name === 'CredentialsProviderError' || /credential/i.test(err?.message ?? '')) {
    console.error(
      '\nFaltan credenciales de AWS.\n' +
        'En el Learner Lab: AWS Details -> AWS CLI -> Show, y pon los tres valores en\n' +
        '~/.aws/credentials bajo el perfil [default] (aws_access_key_id, aws_secret_access_key,\n' +
        'aws_session_token). Expiran al terminar la sesion del lab.',
    );
    process.exit(2);
  }
  throw err;
}

console.log('\n========================================');
if (fallos === 0) {
  console.log(`TODO CORRECTO${avisos ? ` (${avisos} avisos por revisar)` : ''}.`);
} else {
  console.log(`${fallos} problema(s) por corregir. Revisa el checklist de docs/GUIA-SNS-SQS.md.`);
}
process.exit(fallos === 0 ? 0 : 1);
