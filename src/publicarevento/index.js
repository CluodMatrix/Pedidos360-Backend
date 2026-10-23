// Lambda pedidos360-publicar-evento
//
// Lambda PRODUCTORA. Publica un evento en el SNS Topic `pedidos360-eventos`.
//
// El productor solo conoce el topic: no sabe qué colas ni qué consumidores hay
// detrás. Quien decide a qué cola llega el evento es la filter policy de cada
// suscripción.
//
// A diferencia del resto de Lambdas del proyecto, NO usa el router de
// src/shared/http.js: se invoca directamente con un evento de prueba desde la
// consola de Lambda o, opcionalmente, desde una ruta POST /eventos de API
// Gateway (ver docs/GUIA-SNS-SQS.md).
import { config, TIPOS_EVENTO } from '../shared/config.js';
import { publicarEvento } from '../shared/sns.js';

const TIPOS_VALIDOS = Object.values(TIPOS_EVENTO);

function error(mensaje, statusCode = 400, details, codigo = 'BAD_REQUEST') {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ error: codigo, message: mensaje, ...(details ? { details } : {}) }),
  };
}

export const handler = async (event) => {
  // Funciona con API Gateway (event.body es un string) o con un evento de
  // prueba directo de la consola de Lambda.
  let input;
  if (typeof event?.body === 'string') {
    try {
      input = JSON.parse(event.body);
    } catch {
      return error('El cuerpo debe ser JSON válido.');
    }
  } else {
    input = event ?? {};
  }

  const pedidoId = typeof input.pedidoId === 'string' ? input.pedidoId.trim() : '';
  const tipoEvento = typeof input.tipoEvento === 'string' ? input.tipoEvento.trim() : '';

  if (!pedidoId) return error('El campo pedidoId es obligatorio.');
  if (!tipoEvento) return error('El campo tipoEvento es obligatorio.');
  if (!TIPOS_VALIDOS.includes(tipoEvento)) {
    return error(`tipoEvento debe ser uno de: ${TIPOS_VALIDOS.join(', ')}.`);
  }
  if (!config.topicArn) {
    return error(
      'El backend no tiene configurado el topic de eventos (TOPIC_ARN).',
      500,
      undefined,
      'NOT_CONFIGURED',
    );
  }

  try {
    const { eventId, messageId } = await publicarEvento({
      tipoEvento,
      pedidoId,
      simularError: input.simularError === true,
      datos: input.datos ?? {},
    });

    console.log(
      `Evento publicado: tipo=${tipoEvento} pedido=${pedidoId} eventId=${eventId}`,
    );

    return {
      statusCode: 202,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ publicado: eventId, messageId, tipoEvento, pedidoId }),
    };
  } catch (err) {
    console.error('No se pudo publicar el evento:', err.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: 'PUBLISH_ERROR', message: 'No se pudo publicar el evento.' }),
    };
  }
};
