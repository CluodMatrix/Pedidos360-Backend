// Prueba de integracion: un pedido creado por la app dispara el evento y
// llega a los consumidores.
//
// Invoca la Lambda `pedidos360-pedidos` con un evento de API Gateway simulado
// (con los claims del JWT Authorizer) para comprobar la cadena completa:
//
//   POST /pedidos -> DynamoDB -> SNS -> SQS -> Lambda consumidora
//
// Uso: node scripts/probar-integracion.js
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';

const region = process.env.AWS_REGION ?? 'us-east-1';
const lambda = new LambdaClient({ region });
const logs = new CloudWatchLogsClient({ region });

const PRODUCEDORA = 'notificar-email';
const CLIENTE_ID = 'oid-prueba-integracion';
const CLIENTE_NOMBRE = 'Cliente de Integracion';

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** Evento de API Gateway con los claims que inyecta el JWT Authorizer. */
function eventoPostPedidos(productoId, cantidad) {
  return {
    version: '2.0',
    rawPath: '/pedidos',
    headers: { 'content-type': 'application/json' },
    requestContext: {
      http: { method: 'POST' },
      stage: '$default',
      authorizer: {
        jwt: {
          claims: {
            sub: CLIENTE_ID,
            oid: CLIENTE_ID,
            name: CLIENTE_NOMBRE,
            roles: 'Cliente',
            scp: 'orders.read orders.write catalog.read',
          },
        },
      },
    },
    body: JSON.stringify({ productos: [{ productoId, cantidad }] }),
  };
}

async function logsDe(nombreLambda, desde) {
  try {
    const { events } = await logs.send(
      new FilterLogEventsCommand({ logGroupName: `/aws/lambda/${nombreLambda}`, startTime: desde }),
    );
    return (events ?? []).map((e) => e.message).join('\n');
  } catch (err) {
    if (err?.name === 'ResourceNotFoundException') return '';
    throw err;
  }
}

const desde = Date.now() - 5000;

console.log('=== INTEGRACION: crear un pedido y ver el evento ===\n');
console.log('1) Invocando pedidos360-pedidos con POST /pedidos (rol Cliente)...');

const { Payload, FunctionError } = await lambda.send(
  new InvokeCommand({
    FunctionName: 'pedidos360-pedidos',
    InvocationType: 'RequestResponse',
    Payload: Buffer.from(JSON.stringify(eventoPostPedidos('prod-teclado-001', 1))),
  }),
);

const respuesta = Payload ? Buffer.from(Payload).toString('utf8') : '';
console.log(`   FunctionError: ${FunctionError ?? 'ninguno'}`);
console.log(`   Respuesta: ${respuesta.slice(0, 400)}`);

if (FunctionError) {
  console.log('\n[no se pudo crear el pedido: revisa el error de arriba]');
  process.exit(1);
}

let pedido;
try {
  // La Lambda responde con el sobre de API Gateway: {statusCode, headers, body}
  // y `body` es el JSON serializado.
  const sobre = JSON.parse(respuesta);
  pedido = typeof sobre.body === 'string' ? JSON.parse(sobre.body) : sobre;
} catch {
  console.log('\n[respuesta no es JSON: no se puede continuar]');
  process.exit(1);
}
const pedidoId = pedido.id;
if (!pedidoId) {
  console.log(`\n[la respuesta no trae id de pedido: ${respuesta.slice(0, 200)}]`);
  process.exit(1);
}
console.log(`\n   Pedido creado: ${pedidoId} (estado ${pedido.estado}, total ${pedido.total})`);

console.log('\n2) Esperando 25s a que el evento viaje por SNS -> SQS -> Lambda...');
await dormir(25000);

console.log('\n3) Logs de notificar-email:');
const texto = await logsDe(PRODUCEDORA, desde);
const lineas = texto.split('\n').filter((l) => l.includes(pedidoId) || l.includes('Email enviado'));
if (lineas.length) {
  for (const l of lineas) console.log('   ' + l.trim());
} else {
  console.log('   (no hay logs del pedido)');
}

const llego = texto.includes(pedidoId);
console.log(
  llego
    ? `\n[ok] El pedido ${pedidoId} se guardo y su evento llego a notificar-email.`
    : `\n[FALLA] El evento del pedido ${pedidoId} no llego a la consumidora.`,
);
process.exit(llego ? 0 : 1);
