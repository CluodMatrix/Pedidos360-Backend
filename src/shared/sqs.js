// src/shared/sqs.js
//
// Utilidades de SQS. Hoy se usan solo para enviar un mensaje a la DLQ cuando
// el consumidor detecta un error NO recuperable.
//
// Hay dos caminos posibles hacia la DLQ y ambos conviven:
//
//   1. Redrive policy de la cola (automático). Si el mensaje se recibe más de
//      `maxReceiveCount` veces sin borrarse, SQS lo mueve a la DLQ.
//      -> Es lo que usa el error RECUPERABLE de la Prueba 2 de la guía.
//
//   2. Envío manual (este archivo). El consumidor detecta que el dato es
//      inválido, publica el mensaje en la DLQ y CONFIRMA el original para que
//      no se reintente. -> Es lo que pide la sección 9 de la guía.
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

import { config } from './config.js';

const sqs = new SQSClient({ region: config.region });

/**
 * Devuelve una función que publica el cuerpo crudo en la DLQ indicada.
 * @param {string} queueUrl URL de la cola DLQ (viene de config, nunca del handler)
 * @param {object} [cliente] Cliente SQS (los tests inyectan uno falso).
 */
export function crearEnviadorDLQ(queueUrl, cliente = sqs) {
  return async function enviarADLQ(cuerpo, contexto = {}) {
    if (!queueUrl) {
      throw new Error(
        'Falta la URL de la DLQ en la configuración: no se puede enviar el mensaje a la DLQ.',
      );
    }
    await cliente.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: cuerpo,
        // Se propaga el motivo para poder analizarlo en la DLQ.
        MessageAttributes: {
          motivo: {
            DataType: 'String',
            StringValue: String(contexto.motivo ?? 'error no recuperable').slice(0, 900),
          },
        },
      }),
    );
  };
}
