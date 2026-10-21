// Crea la topología de mensajería asíncrona del proyecto Pedidos360.
//
//   node scripts/create-messaging.js
//
// Qué crea (los nombres salen de src/shared/config.js, no de este archivo):
//
//   · 3 colas DLQ      : q-email-dlq, q-kitchen-dlq, q-invoice-dlq
//   · 3 colas principale: q-email, q-kitchen, q-invoice
//                       (con DLQ y maxReceiveCount = 3, visibility timeout 30 s)
//   · 1 SNS Topic      : pedidos360-eventos
//   · 3 suscripciones  : cada cola al topic, con su filter policy
//
// Es idempotente: si un recurso ya existe, se actualiza en vez de fallar.
// Para borrar todo y empezar de cero: node scripts/create-messaging.js --reset
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  CreateTopicCommand,
  GetSubscriptionAttributesCommand,
  ListSubscriptionsByTopicCommand,
  SetSubscriptionAttributesCommand,
  SNSClient,
  SubscribeCommand,
  UnsubscribeCommand,
} from '@aws-sdk/client-sns';

import { FILTROS, NOMBRES, TOPOLOGIA } from '../src/shared/config.js';

const region = process.env.AWS_REGION ?? 'us-east-1';
const sqs = new SQSClient({ region });
const sns = new SNSClient({ region });
const reset = process.argv.includes('--reset');

/** Dominios en el orden en que aparecen en la guía, más el de notificaciones. */
const DOMINIOS = ['email', 'cocina', 'boleta', 'notificaciones'];

// ---------------------------------------------------------------- topic

async function asegurarTopic() {
  const { TopicArn } = await sns.send(new CreateTopicCommand({ Name: NOMBRES.topic }));
  console.log(`+ Topic ${NOMBRES.topic} (${TopicArn})`);
  return TopicArn;
}

// ---------------------------------------------------------------- colas

async function urlDeCola(nombre) {
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: nombre }));
  return QueueUrl;
}

async function asegurarCola(nombre) {
  try {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: nombre,
        Attributes: {
          VisibilityTimeout: String(TOPOLOGIA.visibilityTimeout),
          MessageRetentionPeriod: String(TOPOLOGIA.retentionPeriod * 86400),
        },
      }),
    );
    console.log(`+ Cola ${nombre}`);
    return QueueUrl;
  } catch (err) {
    // La cola ya existe: se reutiliza tal cual (sus atributos se ajustan
    // despues con configurarRedrive).
    if (err?.name === 'QueueAlreadyExists' || err?.name === 'QueueNameExists') {
      const QueueUrl = await urlDeCola(nombre);
      console.log(`= Cola ${nombre} ya existe`);
      return QueueUrl;
    }
    throw err;
  }
}

async function atributosDeCola(url) {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn', 'RedrivePolicy'] }),
  );
  return Attributes ?? {};
}

/**
 * Aplica la redrive policy (cola principal -> DLQ) y fija maxReceiveCount.
 * Es lo que hace que, tras 3 recepciones fallidas, el mensaje aterrice en la DLQ.
 */
async function configurarRedrive(urlCola, urlDlq, maxReceiveCount) {
  const { QueueArn } = await atributosDeCola(urlCola);
  const { QueueArn: dlqArn } = await atributosDeCola(urlDlq);

  await sqs.send(
    new SetQueueAttributesCommand({
      QueueUrl: urlCola,
      Attributes: {
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount: String(maxReceiveCount),
        }),
        VisibilityTimeout: String(TOPOLOGIA.visibilityTimeout),
      },
    }),
  );
  console.log(`  redrive: ${QueueArn} -> ${dlqArn} (maxReceiveCount=${maxReceiveCount})`);
}

/**
 * Permite que el topic de SNS escriba en la cola.
 * Sin este permiso, el topic publica y la cola nunca recibe nada
 * (es el error mas comun: "No llega nada a las colas").
 */
async function permitirSnsSobreCola(urlCola, topicArn) {
  const { QueueArn } = await atributosDeCola(urlCola);
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: urlCola, AttributeNames: ['Policy'] }),
  );

  const politica = Attributes?.Policy ? JSON.parse(Attributes.Policy) : { Version: '2012-10-17', Statement: [] };
  const yaPermitido = (politica.Statement ?? []).some(
    (s) =>
      s.Effect === 'Allow' &&
      s.Principal?.Service === 'sns.amazonaws.com' &&
      s.Condition?.ArnEquals?.['aws:SourceArn'] === topicArn &&
      (s.Action === 'SQS:SendMessage' || s.Action === 'sqs:SendMessage'),
  );
  if (yaPermitido) return;

  politica.Statement = [
    ...(politica.Statement ?? []),
    {
      Sid: 'PermitirPublicacionDesdeElTopic',
      Effect: 'Allow',
      Principal: { Service: 'sns.amazonaws.com' },
      Action: 'SQS:SendMessage',
      Resource: QueueArn,
      Condition: { ArnEquals: { 'aws:SourceArn': topicArn } },
    },
  ];

  await sqs.send(
    new SetQueueAttributesCommand({ QueueUrl: urlCola, Attributes: { Policy: JSON.stringify(politica) } }),
  );
  console.log(`  permiso SNS -> ${QueueArn}`);
}

// ---------------------------------------------------------------- suscripciones

/**
 * Suscribe una cola al topic.
 *  · FilterPolicy: define a que eventos llega (equivale al binding de RabbitMQ).
 *  · RawMessageDelivery: el mensaje llega sin el sobre de SNS, tal cual lo
 *    publico el productor. El consumidor tambien sabe desenvolverlo.
 */
/** Busca la suscripción de una cola al topic, si ya existe. */
async function buscarSuscripcion(topicArn, queueArn) {
  const { Subscriptions } = await sns.send(
    new ListSubscriptionsByTopicCommand({ TopicArn: topicArn }),
  );
  return (Subscriptions ?? []).find((s) => s.Endpoint === queueArn);
}

/** Suscribe la cola al topic. */
async function suscribir(topicArn, queueArn, filtro) {
  const { SubscriptionArn } = await sns.send(
    new SubscribeCommand({
      TopicArn: topicArn,
      Protocol: 'sqs',
      Endpoint: queueArn,
      Attributes: {
        RawMessageDelivery: 'true',
        ...(filtro ? { FilterPolicy: JSON.stringify(filtro) } : {}),
      },
    }),
  );
  return SubscriptionArn;
}

async function asegurarSuscripcion(topicArn, urlCola, filtro) {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: urlCola, AttributeNames: ['QueueArn'] }),
  );
  const queueArn = Attributes.QueueArn;

  const existente = await buscarSuscripcion(topicArn, queueArn);
  let SubscriptionArn = existente?.SubscriptionArn;

  if (!SubscriptionArn) {
    SubscriptionArn = await suscribir(topicArn, queueArn, filtro);
  } else {
    // Si la suscripción ya estaba CONFIRMADA, `Subscribe` devuelve la
    // existente e IGNORA los atributos nuevos: hay que fijarlos aparte.
    const { Attributes: attrs } = await sns.send(
      new GetSubscriptionAttributesCommand({ SubscriptionArn }),
    );
    const actual = attrs?.FilterPolicy;
    const actualObj = actual && actual !== 'null' ? JSON.parse(actual) : null;
    const mismo = JSON.stringify(actualObj) === JSON.stringify(filtro ?? null);

    if (mismo) {
      // El filtro ya es el correcto: solo se refresca el raw delivery.
    } else if (filtro) {
      await sns.send(
        new SetSubscriptionAttributesCommand({
          SubscriptionArn,
          AttributeName: 'FilterPolicy',
          AttributeValue: JSON.stringify(filtro),
        }),
      );
    } else {
      // Hay que QUITAR un filtro que ya estaba puesto. SNS no permite
      // unsetearlo, asi que se desuscribe y se vuelve a suscribir: las
      // suscripciones a SQS se confirman solas, asi que queda lista al toque.
      await sns.send(new UnsubscribeCommand({ SubscriptionArn }));
      SubscriptionArn = await suscribir(topicArn, queueArn, null);
    }
  }

  await sns.send(
    new SetSubscriptionAttributesCommand({
      SubscriptionArn,
      AttributeName: 'RawMessageDelivery',
      AttributeValue: 'true',
    }),
  );

  console.log(
    `  suscripción ${queueArn} <- ${topicArn} ` +
      `(filtro: ${filtro ? JSON.stringify(filtro) : 'sin filtro'}) [${SubscriptionArn}]`,
  );
}

// ---------------------------------------------------------------- main

async function borrarTodo() {
  for (const dominio of DOMINIOS) {
    for (const nombre of [NOMBRES.colas[dominio].cola, NOMBRES.colas[dominio].dlq]) {
      try {
        const url = await urlDeCola(nombre);
        await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
        console.log(`- Cola ${nombre} eliminada`);
      } catch {
        // no existia
      }
    }
  }
}

async function main() {
  if (reset) await borrarTodo();

  const topicArn = await asegurarTopic();

  for (const dominio of DOMINIOS) {
    const { cola, dlq } = NOMBRES.colas[dominio];

    const urlDlq = await asegurarCola(dlq);
    const urlCola = await asegurarCola(cola);

    await configurarRedrive(urlCola, urlDlq, TOPOLOGIA.maxReceiveCount);
    await permitirSnsSobreCola(urlCola, topicArn);
    await asegurarSuscripcion(topicArn, urlCola, FILTROS[dominio]);
  }

  console.log('\nMensajería lista.');
  console.log(`  TOPIC_ARN=${topicArn}`);
  for (const dominio of DOMINIOS) {
    const { cola, dlq } = NOMBRES.colas[dominio];
    console.log(`  QUEUE_${dominio.toUpperCase()}_URL=${await urlDeCola(cola)}`);
    console.log(`  DLQ_${dominio.toUpperCase()}_URL=${await urlDeCola(dlq)}`);
  }
}

await main();
