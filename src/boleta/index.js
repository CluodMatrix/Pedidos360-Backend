// Lambda generar-boleta
//
// Consumidor del dominio "boleta". Lee de la cola `q-invoice`, cuya suscripción
// tiene una filter policy POR PREFIJO: recibe los eventos que empiezan por
// `PedidoDespachado`.
import { crearHandler } from '../shared/consumidor.js';
import { config } from '../shared/config.js';

/**
 * Trabajo propio del dominio: generar la boleta.
 * En un entorno real, aquí se generaría el documento y se guardaría en S3 o
 * se enviaría al sistema de facturación.
 */
async function generarBoleta(mensaje, ctx) {
  const total = typeof mensaje.total === 'number' ? mensaje.total : 'sin total';
  console.log(
    `Boleta generada para el pedido ${mensaje.pedidoId} (total ${total}) - intento ${ctx.intento}.`,
  );
}

export const handler = crearHandler({
  dominio: 'boleta',
  cola: config.colas.boleta,
  procesar: generarBoleta,
});
