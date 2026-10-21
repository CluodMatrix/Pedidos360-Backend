// src/shared/sns.js
//
// Publicador sobre el SNS Topic. Es el ÚNICO punto del proyecto que publica
// eventos: lo usan tanto la Lambda que crea pedidos (publica PedidoCreado y
// los cambios de estado) como la Lambda productora `pedidos360-publicar-evento`.
//
// El productor solo conoce el topic. No sabe qué consumidores hay detrás:
// ese es el punto del fan-out y de los filter policies.
import { randomUUID } from 'node:crypto';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';

import { config, TIPOS_EVENTO } from './config.js';

const sns = new SNSClient({ region: config.region });

/**
 * Nombres de los atributos de mensaje que usa la filter policy.
 * El atributo `tipo_evento` es el que decide a qué cola llega el evento.
 */
export const ATRIBUTO_TIPO_EVENTO = 'tipo_evento';

/**
 * Crea un publicador sobre un topic. Se puede inyectar un cliente SNS propio
 * (los tests lo hacen para no tocar AWS).
 * @param {object} [params]
 * @param {string} [params.topicArn]
 * @param {object} [params.cliente] Cliente SNS (por defecto, el compartido).
 */
export function crearPublicador({ topicArn = config.topicArn, cliente = sns } = {}) {
  return async function publicar({ tipoEvento, pedidoId, datos = {}, simularError = false }) {
    if (!topicArn) {
      throw new Error(
        `Falta la variable de entorno TOPIC_ARN: no se puede publicar el evento "${tipoEvento}".`,
      );
    }

    const mensaje = {
      type: tipoEvento,
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      pedidoId,
      simularError: simularError === true,
      ...datos,
    };

    const resultado = await cliente.send(
      new PublishCommand({
        TopicArn: topicArn,
        Message: JSON.stringify(mensaje),
        // El atributo es lo que evalúa la filter policy de cada suscripción.
        // Si solo se mandara dentro del cuerpo, ninguna cola filtraría.
        MessageAttributes: {
          [ATRIBUTO_TIPO_EVENTO]: { DataType: 'String', StringValue: tipoEvento },
        },
      }),
    );

    return { eventId: mensaje.eventId, messageId: resultado.MessageId, mensaje };
  };
}

/**
 * Publica un evento en el topic configurado.
 * @see crearPublicador
 */
export async function publicarEvento({ tipoEvento, pedidoId, datos = {}, simularError = false }) {
  return crearPublicador()({ tipoEvento, pedidoId, datos, simularError });
}

/** Traduce el estado interno de un pedido al evento de dominio que se publica. */
export function eventoDeEstado(estado) {
  switch (estado) {
    case 'CREADO':
      return TIPOS_EVENTO.PEDIDO_CREADO;
    case 'ACEPTADO':
      return TIPOS_EVENTO.PEDIDO_ACEPTADO;
    case 'EN_PREPARACION':
      return TIPOS_EVENTO.PEDIDO_EN_PREPARACION;
    case 'DESPACHADO':
      return TIPOS_EVENTO.PEDIDO_DESPACHADO;
    case 'ENTREGADO':
      return TIPOS_EVENTO.PEDIDO_ENTREGADO;
    case 'CANCELADO':
      return TIPOS_EVENTO.PEDIDO_CANCELADO;
    default:
      return undefined;
  }
}
