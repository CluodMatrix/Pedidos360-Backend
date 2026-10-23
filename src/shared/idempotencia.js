// src/shared/idempotencia.js
//
// Idempotencia del consumidor.
//
// SQS Standard entrega "al menos una vez": el mismo mensaje puede llegar dos
// veces. Si el consumidor no es idempotente, un cliente recibe dos correos o
// se descuenta stock dos veces.
//
// La forma barata de garantizarlo es reclamar el evento ANTES de procesarlo,
// con una escritura condicional en DynamoDB:
//   · Put condicional `attribute_not_exists(eventId)`  -> soy el primero (reclamo)
//   · ConditionalCheckFailedException                  -> ya se procesó (duplicado)
//
// Si el procesamiento falla de forma recuperable, se LIBERA el reclamo para que
// el reintento pueda reclamarlo otra vez.
//
// Si la tabla no está configurada (TABLA_EVENTOS_PROCESADOS vacía), la guarda
// queda desactivada y el consumidor funciona igual, sin idempotencia.
import { DeleteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

import { db } from './dynamo.js';

/**
 * Crea la guarda de idempotencia.
 * @param {object} params
 * @param {string} params.tabla  Nombre de la tabla de eventos procesados.
 * @param {string} params.consumidor  Dominio (email | cocina | boleta).
 */
export function crearGuardaIdempotencia({ tabla, consumidor }) {
  const activa = Boolean(tabla);

  return {
    activa,

    /**
     * Intenta reservar el evento para ESTE consumidor.
     *
     * OJO: la clave es compuesta (eventId + consumidor). El mismo evento lo
     * reciben varias colas (fan-out), y cada consumidor debe poder procesarlo
     * una vez. Con una clave solo por eventId, el primero en reclamarlo
     * dejaba a los demas creyendo que era un duplicado y lo ignoraban.
     *
     * @returns {Promise<boolean>} true = me toca procesarlo; false = duplicado.
     */
    async reclamar(eventId) {
      if (!activa || !eventId) return true;
      try {
        await db.send(
          new PutCommand({
            TableName: tabla,
            Item: {
              eventId,
              consumidor,
              fechaReclamo: new Date().toISOString(),
            },
            ConditionExpression: 'attribute_not_exists(eventId) AND attribute_not_exists(consumidor)',
          }),
        );
        return true;
      } catch (err) {
        if (err?.name === 'ConditionalCheckFailedException') return false;
        throw err;
      }
    },

    /** Libera el reclamo para que un reintento pueda volver a procesarlo. */
    async liberar(eventId) {
      if (!activa || !eventId) return;
      try {
        await db.send(
          new DeleteCommand({ TableName: tabla, Key: { eventId, consumidor } }),
        );
      } catch (err) {
        // Si no se puede liberar, el mensaje se marcará como procesado en el
        // próximo intento. Es preferible a bloquear la cola.
        console.warn('No se pudo liberar el reclamo de idempotencia:', err.message);
      }
    },
  };
}
