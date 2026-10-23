// Prueba automatica de la topologia de mensajeria (Pruebas 1 y 2 de la guia).
//
//   node scripts/probar-topologia.js             -> Prueba 1 + Prueba 2
//   node scripts/probar-topologia.js --solo-1     -> solo fan-out y filtros
//   node scripts/probar-topologia.js --solo-2     -> solo reintentos y DLQ
//
// Que hace:
//   1. Publica un evento por cada tipo (PedidoCreado / PedidoAceptado /
//      PedidoDespachado) usando la Lambda productora.
//   2. Espera a que las consumidoras los procesen.
//   3. Lee los logs de CloudWatch de las 3 consumidoras y arma la tabla de
//      "quien recibio que" (la tabla de la Prueba 1 de la guia).
//   4. Publica un evento con simularError y comprueba que tras 3 intentos
//      el mensaje aterriza en la DLQ (la Prueba 2).
//
// No crea ni modifica recursos: solo publica eventos y lee logs.
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { FilterLogEventsCommand, CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { GetQueueUrlCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

import { NOMBRES } from '../src/shared/config.js';

const region = process.env.AWS_REGION ?? 'us-east-1';
const lambda = new LambdaClient({ region });
const logs = new CloudWatchLogsClient({ region });
const sqs = new SQSClient({ region });

const solo1 = process.argv.includes('--solo-1');
const solo2 = process.argv.includes('--solo-2');

const PRODUCTORA = 'pedidos360-publicar-evento';
const CONSUMIDORAS = {
  'notificar-email': 'email',
  'ticket-cocina': 'cocina',
  'generar-boleta': 'boleta',
};

/** Minutos de espera antes de leer los logs (margen para el polling del trigger). */
const ESPERA = Number(process.env.ESPERA_PROBA ?? 25);
// La DLQ: 3 intentos x 30 s de visibility timeout + margen.
const ESPERA_DLQ = Number(process.env.ESPERA_DLQ ?? 110);

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function publicar(payload) {
  const { Payload } = await lambda.send(
    new InvokeCommand({
      FunctionName: PRODUCTORA,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
  const cuerpo = Payload ? Buffer.from(Payload).toString('utf8') : '';
  console.log(`  -> publicado ${payload.tipoEvento} (pedido ${payload.pedidoId}): ${cuerpo.slice(0, 160)}`);
  return cuerpo;
}

/**
 * Lee los logs recientes de una Lambda y devuelve las líneas que menciona un pedido.
 * No se usa filterPattern: los niveles (INFO/WARN/ERROR) varian y un patron
 * mal puesto deja fuera justo las lineas que hay que ver.
 */
async function logsDe(nombreLambda, desde) {
  try {
    const { events } = await logs.send(
      new FilterLogEventsCommand({
        logGroupName: `/aws/lambda/${nombreLambda}`,
        startTime: desde,
      }),
    );
    return (events ?? []).map((e) => e.message).join('\n');
  } catch (err) {
    if (err?.name === 'ResourceNotFoundException') return '';
    throw err;
  }
}

// ------------------------------------------------------------------ Prueba 1

async function prueba1() {
  console.log('\n=== PRUEBA 1: fan-out y filtros ===\n');
  const desde = Date.now() - 5000;
  const eventos = [
    { pedidoId: 'P-001', tipoEvento: 'PedidoCreado' },
    { pedidoId: 'P-002', tipoEvento: 'PedidoAceptado' },
    { pedidoId: 'P-003', tipoEvento: 'PedidoDespachado' },
  ];

  for (const evento of eventos) {
    await publicar(evento);
  }

  console.log(`\n  Esperando ${ESPERA}s a que las consumidoras procesen...`);
  await dormir(ESPERA * 1000);

  const pedidos = eventos.map((e) => e.pedidoId);
  const filas = [];

  for (const [nombreLambda, dominio] of Object.entries(CONSUMIDORAS)) {
    const texto = await logsDe(nombreLambda, desde);
    const recibio = pedidos.filter((p) => texto.includes(p));
    filas.push({ lambda: nombreLambda, dominio, recibio });
  }

  console.log('\n  Evento          notificar-email   ticket-cocina   generar-boleta');
  console.log('  --------------- ----------------- --------------- ---------------');
  for (const evento of eventos) {
    const celdas = filas.map((f) => (f.recibio.includes(evento.pedidoId) ? 'si' : 'no '));
    console.log(`  ${evento.tipoEvento.padEnd(15)} ${celdas[0].padEnd(17)} ${celdas[1].padEnd(15)} ${celdas[2]}`);
  }

  const esperado = {
    'P-001': [true, false, false],
    'P-002': [true, true, false],
    'P-003': [true, false, true],
  };

  console.log('');
  let todoBien = true;
  for (const evento of eventos) {
    const esperadoFila = esperado[evento.pedidoId];
    filas.forEach((f, i) => {
      const real = f.recibio.includes(evento.pedidoId);
      if (real !== esperadoFila[i]) {
        todoBien = false;
        console.log(
          `  [FALLA] ${evento.tipoEvento}: ${f.lambda} ${real ? 'si lo recibio' : 'NO lo recibio'} ` +
            `(se esperaba ${esperadoFila[i] ? 'si' : 'no'})`,
        );
      }
    });
  }
  if (todoBien) {
    console.log('  [ok] Fan-out y filtros correctos: coincide con la tabla esperada.');
  }
  return todoBien;
}

// ------------------------------------------------------------------ Prueba 2

async function prueba2() {
  console.log('\n=== PRUEBA 2: reintentos y DLQ ===\n');
  const desde = Date.now() - 5000;
  const pedido = 'P-ERR';

  await publicar({ pedidoId: pedido, tipoEvento: 'PedidoAceptado', simularError: true });
  console.log(`\n  Esperando ${ESPERA_DLQ}s (3 intentos x 30s de visibility timeout)...`);
  await dormir(ESPERA_DLQ * 1000);

  console.log('\n  Intentos registrados en ticket-cocina:');
  const texto = await logsDe('ticket-cocina', desde);
  const intentos = [...texto.matchAll(/intento (\d+)/g)].map((m) => m[1]);
  console.log(`    ${intentos.length ? intentos.join(', ') : '(sin registro de intentos)'}`);
  if (intentos.length >= 3) {
    console.log('    [ok] El mensaje se reintento 3 veces antes de ir a la DLQ.');
  }

  console.log('\n  Mensajes en q-kitchen-dlq:');
  const { QueueUrl } = await sqs.send(
    new GetQueueUrlCommand({ QueueName: NOMBRES.colas.cocina.dlq }),
  );
  const recibido = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl,
      MaxNumberOfMessages: 10,
      // Visibility timeout normal: con 0, SQS puede devolver el MISMO mensaje
      // repetido dentro del mismo lote y el conteo sale inflado.
      VisibilityTimeout: 30,
      WaitTimeSeconds: 2,
    }),
  );
  const mensajes = recibido.Messages ?? [];
  if (mensajes.length === 0) {
    console.log('    (vacio)');
    return false;
  }
  for (const m of mensajes) {
    console.log(`    - ${m.Body?.slice(0, 200)}`);
  }
  const llego = mensajes.some((m) => m.Body?.includes(pedido));
  console.log(
    llego
      ? `\n  [ok] El mensaje fallido llego a la DLQ (${pedido}).`
      : `\n  [FALLA] El mensaje ${pedido} no aparece en la DLQ.`,
  );
  return llego;
}

// ------------------------------------------------------------------ main

console.log(`Region: ${region}`);
console.log(`Productora: ${PRODUCTORA}`);

let ok1 = true;
let ok2 = true;

if (!solo2) ok1 = await prueba1();
if (!solo1) ok2 = await prueba2();

console.log('\n========================================');
console.log(`Prueba 1 (fan-out y filtros): ${ok1 ? 'OK' : 'FALLA'}`);
console.log(`Prueba 2 (reintentos y DLQ):  ${ok2 ? 'OK' : 'FALLA'}`);
process.exit(ok1 && ok2 ? 0 : 1);
