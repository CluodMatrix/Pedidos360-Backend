// Lambda notificar-frontend
//
// Consumidor del dominio "notificaciones". Lee de la cola `q-notificaciones`,
// cuya suscripción NO tiene filter policy: recibe TODOS los eventos del topic.
//
// Para que un navegador pueda ver la mensajería (los navegadores no pueden
// suscribirse a SQS), este consumidor deja cada evento en una tabla de
// DynamoDB y el frontend lo consulta con GET /notificaciones.
//
// Es el mismo patrón de los otros tres consumidores: SNS -> SQS -> Lambda, con
// ACK explicito, reintentos y DLQ.
import { PutCommand } from '@aws-sdk/lib-dynamodb';

import { crearHandler } from '../shared/consumidor.js';
import { config } from '../shared/config.js';
import { db, TABLE_NOTIFICACIONES } from '../shared/dynamo.js';

/** Texto legible que se muestra en la notificacion de la interfaz. */
function redactar(mensaje) {
  const pedido = mensaje.pedidoId ?? '?';
  switch (mensaje.type) {
    case 'PedidoCreado':
      return `Pedido ${pedido} creado`;
    case 'PedidoAceptado':
      return `Pedido ${pedido} aceptado`;
    case 'PedidoEnPreparacion':
      return `Pedido ${pedido} en preparación`;
    case 'PedidoDespachado':
      return `Pedido ${pedido} despachado`;
    case 'PedidoEntregado':
      return `Pedido ${pedido} entregado`;
    case 'PedidoCancelado':
      return `Pedido ${pedido} cancelado`;
    default:
      return `Evento ${mensaje.type ?? 'desconocido'} (${pedido})`;
  }
}

/**
 * Trabajo propio del dominio: guardar el evento para que la interfaz lo
 * muestre. La escritura es condicional (`attribute_not_exists`) para que un
 * reintento del mismo mensaje no duplique la notificacion.
 */
async function registrarNotificacion(mensaje, ctx) {
  const id = mensaje.eventId ?? `sin-id-${mensaje.pedidoId ?? '?'}-${Date.now()}`;
  const item = {
    id,
    clave: 'notificaciones', // clave constante del GSI: permite pedir las más recientes
    tipo: mensaje.type ?? 'desconocido',
    pedidoId: mensaje.pedidoId ?? '',
    clienteNombre: mensaje.clienteNombre ?? '',
    total: mensaje.total ?? null,
    texto: redactar(mensaje),
    fecha: mensaje.timestamp ?? new Date().toISOString(),
  };

  try {
    await db.send(
      new PutCommand({
        TableName: TABLE_NOTIFICACIONES,
        Item: item,
        // Si ya existe (el mismo evento reentregado), no se duplica.
        ConditionExpression: 'attribute_not_exists(id)',
      }),
    );
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      console.log(`[notificaciones] El evento ${id} ya estaba registrado (intento ${ctx.intento}).`);
      return;
    }
    throw err;
  }

  console.log(`[notificaciones] ${item.texto} (evento ${id})`);
}

export const handler = crearHandler({
  dominio: 'notificaciones',
  cola: config.colas.notificaciones,
  procesar: registrarNotificacion,
});
