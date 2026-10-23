// Lambda ticket-cocina
//
// Consumidor del dominio "cocina". Lee de la cola `q-kitchen`, cuya suscripción
// tiene una filter policy EXACTA: solo recibe los eventos `PedidoAceptado`.
import { crearHandler } from '../shared/consumidor.js';
import { config } from '../shared/config.js';

/**
 * Trabajo propio del dominio: imprimir el ticket de cocina.
 * En un entorno real, aquí se enviaría el ticket a una impresora o a un POS.
 */
async function imprimirTicketCocina(mensaje, ctx) {
  const detalle = Array.isArray(mensaje.productos)
    ? mensaje.productos
        .map((p) => `${p.cantidad ?? 1} x ${p.nombre ?? p.productoId}`)
        .join(', ')
    : 'sin detalle de productos';

  console.log(
    `Ticket de cocina impreso para el pedido ${mensaje.pedidoId} ` +
      `(${detalle}) - intento ${ctx.intento}.`,
  );
}

export const handler = crearHandler({
  dominio: 'cocina',
  cola: config.colas.cocina,
  procesar: imprimirTicketCocina,
});
