// src/shared/errores.js
//
// Distinción entre los dos tipos de fallo que maneja un consumidor de SQS.
//
//   Error recuperable     -> el servicio está caído o algo falló de forma
//                           temporal. El mensaje debe REINTENTARSE: se devuelve
//                           en `batchItemFailures` y SQS lo reentrega tras el
//                           visibility timeout, hasta maxReceiveCount.
//
//   Error no recuperable  -> el dato es inválido y ningún reintento lo
//                           arreglará (falta el pedidoId, el JSON está roto).
//                           Reintentar es tiempo perdido: va directo a la DLQ
//                           y se registra en el log.

/**
 * Error que NO tiene sentido reintentar.
 * El consumidor lo manda a la DLQ y confirma el mensaje original.
 */
export class ErrorNoRecuperable extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.name = 'ErrorNoRecuperable';
    // Marca explícita: permite distinguirlo aunque el bundle se minifique
    // o la comprobación por `instanceof` se rompa entre copias de la clase.
    this.noRecuperable = true;
  }
}

/** Devuelve true si el error es no recuperable (por marca o por tipo). */
export function esNoRecuperable(err) {
  return Boolean(err?.noRecuperable) || err?.name === 'ErrorNoRecuperable';
}
