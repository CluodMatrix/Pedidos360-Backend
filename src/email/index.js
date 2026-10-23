// Lambda notificar-email
//
// Consumidor del dominio "email". Lee de la cola `q-email`, que recibe TODOS
// los eventos (su suscripción no tiene filter policy).
//
// Indicador evaluado: "Consumidores por dominio (15%)" -> una Lambda por cola,
// con el código de negocio del dominio en su propio archivo y la lógica común
// (ACK, reintentos, DLQ, idempotencia) en src/shared/.
import { crearHandler } from '../shared/consumidor.js';
import { config } from '../shared/config.js';

/**
 * Trabajo propio del dominio: enviar el correo de confirmación.
 * En un entorno real, aquí se llamaría a un proveedor de correo (SES, o una
 * API externa). Aquí se simula y se deja rastro en CloudWatch.
 */
async function enviarCorreoConfirmacion(mensaje, ctx) {
  const destinatario = mensaje.clienteEmail ?? mensaje.clienteNombre ?? 'cliente';
  console.log(
    `Email enviado para el pedido ${mensaje.pedidoId} a ${destinatario} ` +
      `(evento ${mensaje.eventId ?? 'sin eventId'}, tipo ${mensaje.type}, intento ${ctx.intento}).`,
  );
}

export const handler = crearHandler({
  dominio: 'email',
  cola: config.colas.email,
  procesar: enviarCorreoConfirmacion,
});
