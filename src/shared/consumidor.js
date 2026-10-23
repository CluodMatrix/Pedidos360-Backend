// src/shared/consumidor.js
//
// Lógica compartida por las Lambdas consumidoras (email, cocina, boleta).
//
// Indicador evaluado: "Confirmación y errores (20%)".
//
// El ciclo de vida de un mensaje en SQS con Lambda es:
//
//   ACK implícito   -> el handler termina sin error y el mensaje NO aparece en
//                      `batchItemFailures`: SQS lo borra.
//   Reintento       -> el mensaje aparece en `batchItemFailures`: SQS no lo
//                      borra, vuelve a ser visible tras el visibility timeout
//                      y se reintenta hasta maxReceiveCount.
//   DLQ             -> se agotaron los reintentos (redrive policy) o el
//                      consumidor decidió que el error no es recuperable y lo
//                      envió a la DLQ a mano.
//
// Para que esto funcione el trigger SQS debe tener activada la opción
// "Report batch item failures" (en el script: FunctionResponseTypes).
import { ErrorNoRecuperable, esNoRecuperable } from './errores.js';
import { crearEnviadorDLQ } from './sqs.js';
import { crearGuardaIdempotencia } from './idempotencia.js';
import { config } from './config.js';

export { ErrorNoRecuperable };

/**
 * Interpreta el cuerpo de un registro de SQS.
 *
 * Normally llega el cuerpo del mensaje tal cual (raw message delivery). Pero
 * si la suscripción de SNS NO tiene activada esa opción, el cuerpo llega
 * envuelto en el sobre de SNS. Se desenvuelve en ambos casos para que el
 * consumidor no dependa de esa configuración.
 */
export function parseMensaje(body) {
  let crudo;
  try {
    crudo = JSON.parse(body);
  } catch {
    throw new ErrorNoRecuperable('El cuerpo del mensaje no es JSON válido.');
  }

  if (!crudo || typeof crudo !== 'object' || Array.isArray(crudo)) {
    throw new ErrorNoRecuperable('El cuerpo del mensaje no es un objeto JSON.');
  }

  // Sobre de SNS (raw message delivery desactivado).
  if (crudo.Type === 'Notification' && typeof crudo.Message === 'string') {
    try {
      crudo = JSON.parse(crudo.Message);
    } catch {
      throw new ErrorNoRecuperable('El mensaje de SNS no contiene un JSON válido.');
    }
    if (!crudo || typeof crudo !== 'object' || Array.isArray(crudo)) {
      throw new ErrorNoRecuperable('El mensaje de SNS no contiene un objeto JSON.');
    }
  }

  return crudo;
}

/**
 * Crea el handler de una Lambda consumidora.
 *
 * @param {object} params
 * @param {string} params.dominio    Nombre del dominio (solo para los logs).
 * @param {object} params.cola       Entrada de `config.colas` (con `dlqUrl`).
 * @param {(mensaje, ctx) => Promise<void>} params.procesar  Trabajo del dominio.
 * @param {Function} [params.enviarADLQ]  Inyectable para los tests.
 * @param {object} [params.guarda]      Inyectable para los tests.
 */
export function crearHandler({ dominio, cola, procesar, enviarADLQ, guarda }) {
  const enviar = enviarADLQ ?? crearEnviadorDLQ(cola?.dlqUrl);
  const idempotencia =
    guarda ?? crearGuardaIdempotencia({ tabla: config.tablaEventos, consumidor: dominio });

  return async function handler(event) {
    const batchItemFailures = [];
    const registros = event?.Records ?? [];

    for (const record of registros) {
      const intento = record.attributes?.ApproximateReceiveCount ?? '?';
      let mensaje;
      let reclamado = false;

      try {
        mensaje = parseMensaje(record.body);

        // Validación de negocio: sin pedidoId no hay nada que hacer. Reintentar
        // un mensaje sin pedidoId nunca va a funcionar -> no recuperable.
        if (!mensaje.pedidoId) {
          throw new ErrorNoRecuperable('Falta pedidoId en el mensaje.');
        }

        // Interruptor de la Prueba 2 de la guía: provoca un fallo RECUPERABLE
        // para ver el ciclo reintento -> DLQ (redrive policy de SQS).
        if (mensaje.simularError === true) {
          throw new Error('Error simulado: este mensaje va a terminar en la DLQ');
        }

        // Idempotencia: se reclama el evento antes de procesarlo.
        reclamado = await idempotencia.reclamar(mensaje.eventId);
        if (!reclamado) {
          console.log(
            `[${dominio}] Duplicado ignorado (pedido ${mensaje.pedidoId}, ` +
              `evento ${mensaje.eventId ?? 'sin eventId'}).`,
          );
          continue; // ACK: no va en batchItemFailures.
        }

        await procesar(mensaje, { record, intento, dominio });
      } catch (err) {
        // Si habíamos reclamado el evento y algo falla, se libera el reclamo
        // para que el reintento pueda procesarlo de nuevo.
        if (reclamado) {
          await idempotencia.liberar(mensaje?.eventId).catch(() => {});
        }

        if (esNoRecuperable(err)) {
          console.error(
            `[${dominio}] No recuperable -> DLQ (messageId=${record.messageId}): ${err.message}`,
          );
          try {
            await enviar(record.body, { motivo: err.message, messageId: record.messageId });
            // Se confirma el original (no entra en batchItemFailures) para que
            // no se reintente: el mensaje ya está a salvo en la DLQ.
          } catch (falloDlq) {
            console.error(
              `[${dominio}] No se pudo enviar a la DLQ, se reintentará: ${falloDlq.message}`,
            );
            batchItemFailures.push({ itemIdentifier: record.messageId });
          }
        } else {
          console.warn(
            `[${dominio}] Recuperable -> reintento (messageId=${record.messageId}, intento ${intento}): ${err.message}`,
          );
          batchItemFailures.push({ itemIdentifier: record.messageId });
        }
      }
    }

    // Solo estos mensajes se reintentan; el resto se confirma (ACK).
    return { batchItemFailures };
  };
}
