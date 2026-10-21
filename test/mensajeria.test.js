// Pruebas de la mensajería asíncrona (SNS + SQS) del proyecto Pedidos360.
//
//   node --test test/mensajeria.test.js
//
// Cubren lo que la pauta de la EP2 evalúa:
//   · Configuración centralizada: nombres y filter policies en un solo lugar.
//   · Confirmación y errores: ACK explícito, recuperable -> reintento,
//     no recuperable -> DLQ.
//   · Publicación en SNS con el atributo `tipo_evento` que leen los filtros.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FILTROS, NOMBRES, TIPOS_EVENTO, TOPOLOGIA, VARIABLES } from '../src/shared/config.js';
import { crearHandler, parseMensaje } from '../src/shared/consumidor.js';
import { ErrorNoRecuperable, esNoRecuperable } from '../src/shared/errores.js';
import { crearPublicador } from '../src/shared/sns.js';
import { crearEnviadorDLQ } from '../src/shared/sqs.js';

// ----------------------------------------------------------------- utilidades

/** Construye un evento de SQS con el cuerpo dado. */
function registro(body, { messageId = 'msg-1', receiveCount = 1 } = {}) {
  return {
    messageId,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    attributes: { ApproximateReceiveCount: String(receiveCount) },
  };
}

/** Guarda de idempotencia falsa: recuerda lo reclamado y dejaLiberar. */
function guardaFalsa(yaReclamados = new Set()) {
  const liberados = [];
  return {
    liberados,
    guarda: {
      activa: true,
      async reclamar(eventId) {
        if (!eventId) return true;
        if (yaReclamados.has(eventId)) return false;
        yaReclamados.add(eventId);
        return true;
      },
      async liberar(eventId) {
        liberados.push(eventId);
        yaReclamados.delete(eventId);
      },
    },
  };
}

// ----------------------------------------------------------------- configuración

describe('configuración centralizada', () => {
  it('los nombres coinciden con los de la guía', () => {
    assert.equal(NOMBRES.topic, 'pedidos360-eventos');
    assert.equal(NOMBRES.colas.email.cola, 'q-email');
    assert.equal(NOMBRES.colas.email.dlq, 'q-email-dlq');
    assert.equal(NOMBRES.colas.cocina.cola, 'q-kitchen');
    assert.equal(NOMBRES.colas.cocina.dlq, 'q-kitchen-dlq');
    assert.equal(NOMBRES.colas.boleta.cola, 'q-invoice');
    assert.equal(NOMBRES.colas.boleta.dlq, 'q-invoice-dlq');
  });

  it('las filter policies cubren elfanout, el exacto y el prefijo', () => {
    // q-email: sin filtro -> recibe todos los eventos.
    assert.equal(FILTROS.email, null);
    // q-kitchen: coincidencia exacta.
    assert.deepEqual(FILTROS.cocina, { tipo_evento: ['PedidoAceptado'] });
    // q-invoice: coincidencia por prefijo.
    assert.deepEqual(FILTROS.boleta, { tipo_evento: [{ prefix: 'PedidoDespachado' }] });
  });

  it('el visibility timeout es mayor que el timeout de la Lambda consumidora', () => {
    assert.ok(TOPOLOGIA.visibilityTimeout > TOPOLOGIA.lambdaTimeout);
    assert.equal(TOPOLOGIA.maxReceiveCount, 3);
  });

  it('los tipos de evento coinciden con los que usan los filtros', () => {
    assert.equal(TIPOS_EVENTO.PEDIDO_ACEPTADO, 'PedidoAceptado');
    assert.equal(TIPOS_EVENTO.PEDIDO_DESPACHADO, 'PedidoDespachado');
    assert.equal(TIPOS_EVENTO.PEDIDO_CREADO, 'PedidoCreado');
  });

  it('los nombres de las variables de entorno son los que inyecta el deploy', () => {
    assert.equal(VARIABLES.topicArn, 'TOPIC_ARN');
    assert.equal(VARIABLES.colas.email.dlqUrl, 'DLQ_EMAIL_URL');
    assert.equal(VARIABLES.colas.cocina.dlqUrl, 'DLQ_KITCHEN_URL');
    assert.equal(VARIABLES.colas.boleta.dlqUrl, 'DLQ_INVOICE_URL');
  });
});

// ----------------------------------------------------------------- parseo

describe('parseo del mensaje', () => {
  it('interpreta el cuerpo tal cual (raw message delivery)', () => {
    const mensaje = parseMensaje(JSON.stringify({ pedidoId: 'P-1', type: 'PedidoCreado' }));
    assert.equal(mensaje.pedidoId, 'P-1');
  });

  it('desenvuelve el sobre de SNS si no hay raw message delivery', () => {
    const sobre = JSON.stringify({
      Type: 'Notification',
      Message: JSON.stringify({ pedidoId: 'P-2', type: 'PedidoAceptado' }),
    });
    const mensaje = parseMensaje(sobre);
    assert.equal(mensaje.pedidoId, 'P-2');
    assert.equal(mensaje.type, 'PedidoAceptado');
  });

  it('un JSON roto es un error NO recuperable', () => {
    assert.throws(() => parseMensaje('esto no es json'), (err) => esNoRecuperable(err));
  });

  it('un cuerpo que no es objeto es un error NO recuperable', () => {
    assert.throws(() => parseMensaje('[1,2,3]'), (err) => esNoRecuperable(err));
  });
});

// ----------------------------------------------------------------- consumidor

describe('consumidor: confirmación y errores', () => {
  it('procesa bien y NO devuelve fallos: el mensaje queda confirmado (ACK)', async () => {
    const procesados = [];
    const { guarda } = guardaFalsa();
    const handler = crearHandler({
      dominio: 'email',
      cola: { dlqUrl: 'https://dlq/email' },
      procesar: async (mensaje) => procesados.push(mensaje.pedidoId),
      enviarADLQ: async () => assert.fail('no deberia ir a la DLQ'),
      guarda,
    });

    const resultado = await handler({ Records: [registro({ pedidoId: 'P-1', eventId: 'e1' })] });

    assert.deepEqual(resultado.batchItemFailures, []);
    assert.deepEqual(procesados, ['P-1']);
  });

  it('error recuperable: devuelve el mensaje en batchItemFailures (reintento)', async () => {
    const { guarda } = guardaFalsa();
    const handler = crearHandler({
      dominio: 'cocina',
      cola: { dlqUrl: 'https://dlq/kitchen' },
      procesar: async () => {
        throw new Error('la cocina esta caída');
      },
      enviarADLQ: async () => assert.fail('un error recuperable no va directo a la DLQ'),
      guarda,
    });

    const resultado = await handler({
      Records: [registro({ pedidoId: 'P-2', eventId: 'e2' }, { messageId: 'msg-2' })],
    });

    assert.equal(resultado.batchItemFailures.length, 1);
    assert.equal(resultado.batchItemFailures[0].itemIdentifier, 'msg-2');
  });

  it('simularError produce un fallo recuperable (así lo espera la Prueba 2)', async () => {
    const { guarda } = guardaFalsa();
    const handler = crearHandler({
      dominio: 'cocina',
      cola: { dlqUrl: 'https://dlq/kitchen' },
      procesar: async () => {},
      enviarADLQ: async () => assert.fail('no debe ir a la DLQ directamente'),
      guarda,
    });

    const resultado = await handler({
      Records: [registro({ pedidoId: 'P-ERR', eventId: 'e3', simularError: true }, { messageId: 'msg-3' })],
    });

    // Se reintenta hasta 3 veces y ahí lo manda SQS a la DLQ (redrive policy).
    assert.equal(resultado.batchItemFailures.length, 1);
  });

  it('error NO recuperable: lo manda a la DLQ y confirma el original', async () => {
    const aDlq = [];
    const { guarda } = guardaFalsa();
    const handler = crearHandler({
      dominio: 'boleta',
      cola: { dlqUrl: 'https://dlq/invoice' },
      procesar: async () => assert.fail('no deberia procesar un mensaje invalido'),
      enviarADLQ: async (cuerpo, ctx) => aDlq.push({ cuerpo, motivo: ctx.motivo }),
      guarda,
    });

    // Sin pedidoId: ningún reintento lo va a arreglar.
    const resultado = await handler({ Records: [registro({ eventId: 'e4' }, { messageId: 'msg-4' })] });

    assert.equal(aDlq.length, 1);
    assert.match(aDlq[0].motivo, /pedidoId/);
    // Confirmado: no se reintenta.
    assert.deepEqual(resultado.batchItemFailures, []);
  });

  it('si el envío a la DLQ falla, el mensaje vuelve a la cola para reintentarse', async () => {
    const { guarda } = guardaFalsa();
    const handler = crearHandler({
      dominio: 'boleta',
      cola: { dlqUrl: 'https://dlq/invoice' },
      procesar: async () => assert.fail('no deberia procesar'),
      enviarADLQ: async () => {
        throw new Error('no se pudo enviar a la DLQ');
      },
      guarda,
    });

    const resultado = await handler({ Records: [registro({ eventId: 'e5' }, { messageId: 'msg-5' })] });

    assert.equal(resultado.batchItemFailures.length, 1);
    assert.equal(resultado.batchItemFailures[0].itemIdentifier, 'msg-5');
  });

  it('libera el reclamo de idempotencia cuando el procesamiento falla', async () => {
    const { guarda, liberados } = guardaFalsa();
    const handler = crearHandler({
      dominio: 'email',
      cola: { dlqUrl: 'https://dlq/email' },
      procesar: async () => {
        throw new Error('fallo recuperable');
      },
      enviarADLQ: async () => {},
      guarda,
    });

    await handler({ Records: [registro({ pedidoId: 'P-6', eventId: 'e6' })] });

    assert.deepEqual(liberados, ['e6']);
  });

  it('un evento repetido no se procesa dos veces (idempotencia)', async () => {
    let veces = 0;
    const { guarda } = guardaFalsa();
    const handler = crearHandler({
      dominio: 'email',
      cola: { dlqUrl: 'https://dlq/email' },
      procesar: async () => {
        veces += 1;
      },
      enviarADLQ: async () => {},
      guarda,
    });

    const mensaje = { pedidoId: 'P-7', eventId: 'e7' };
    await handler({ Records: [registro(mensaje)] });
    await handler({ Records: [registro(mensaje, { messageId: 'msg-7b' })] });

    assert.equal(veces, 1);
  });

  it('procesa cada registro del lote de forma independiente', async () => {
    const ok = [];
    const { guarda } = guardaFalsa();
    const handler = crearHandler({
      dominio: 'email',
      cola: { dlqUrl: 'https://dlq/email' },
      procesar: async (mensaje) => {
        if (mensaje.pedidoId === 'malo') throw new Error('recoverable');
        ok.push(mensaje.pedidoId);
      },
      enviarADLQ: async () => {},
      guarda,
    });

    const resultado = await handler({
      Records: [
        registro({ pedidoId: 'bueno', eventId: 'e8' }, { messageId: 'm-ok' }),
        registro({ pedidoId: 'malo', eventId: 'e9' }, { messageId: 'm-fail' }),
        registro({ pedidoId: 'bueno2', eventId: 'e10' }, { messageId: 'm-ok2' }),
      ],
    });

    assert.deepEqual(ok, ['bueno', 'bueno2']);
    assert.equal(resultado.batchItemFailures.length, 1);
    assert.equal(resultado.batchItemFailures[0].itemIdentifier, 'm-fail');
  });

  it('un evento sin Records no rompe el handler', async () => {
    const { guarda } = guardaFalsa();
    const handler = crearHandler({
      dominio: 'email',
      cola: { dlqUrl: 'https://dlq/email' },
      procesar: async () => {},
      enviarADLQ: async () => {},
      guarda,
    });
    assert.deepEqual(await handler({}), { batchItemFailures: [] });
  });
});

// ----------------------------------------------------------------- SNS

describe('publicación en SNS', () => {
  it('publica con el atributo tipo_evento que evalúan los filtros', async () => {
    const enviados = [];
    const cliente = {
      async send(comando) {
        enviados.push(comando);
        return { MessageId: 'sns-1' };
      },
    };

    const publicar = crearPublicador({ topicArn: 'arn:aws:sns:us-east-1:1:pedidos360-eventos', cliente });
    const { eventId } = await publicar({ tipoEvento: 'PedidoAceptado', pedidoId: 'P-9' });

    assert.equal(enviados.length, 1);
    assert.equal(enviados[0].input.TopicArn, 'arn:aws:sns:us-east-1:1:pedidos360-eventos');
    assert.equal(enviados[0].input.MessageAttributes.tipo_evento.DataType, 'String');
    assert.equal(enviados[0].input.MessageAttributes.tipo_evento.StringValue, 'PedidoAceptado');

    const cuerpo = JSON.parse(enviados[0].input.Message);
    assert.equal(cuerpo.pedidoId, 'P-9');
    assert.equal(cuerpo.type, 'PedidoAceptado');
    assert.equal(cuerpo.eventId, eventId);
    assert.ok(cuerpo.timestamp);
  });

  it('sin TOPIC_ARN falla con un mensaje claro', async () => {
    const publicar = crearPublicador({ topicArn: undefined, cliente: { async send() {} } });
    await assert.rejects(() => publicar({ tipoEvento: 'PedidoCreado', pedidoId: 'P-10' }), /TOPIC_ARN/);
  });
});

// ----------------------------------------------------------------- DLQ

describe('envío a la DLQ', () => {
  it('envía el cuerpo original con el motivo del error', async () => {
    const enviados = [];
    const cliente = {
      async send(comando) {
        enviados.push(comando);
        return {};
      },
    };

    const enviar = crearEnviadorDLQ('https://sqs.us-east-1.amazonaws.com/1/q-email-dlq', cliente);
    await enviar('{"pedidoId":"P-11"}', { motivo: 'Falta pedidoId' });

    assert.equal(enviados.length, 1);
    assert.equal(enviados[0].input.QueueUrl, 'https://sqs.us-east-1.amazonaws.com/1/q-email-dlq');
    assert.equal(enviados[0].input.MessageBody, '{"pedidoId":"P-11"}');
    assert.equal(enviados[0].input.MessageAttributes.motivo.StringValue, 'Falta pedidoId');
  });

  it('sin URL de DLQ configurada falla con un mensaje claro', async () => {
    const enviar = crearEnviadorDLQ(undefined, { async send() {} });
    await assert.rejects(() => enviar('{}'), /DLQ/);
  });
});

// ----------------------------------------------------------------- errores

describe('clasificación de errores', () => {
  it('un Error normal es recuperable', () => {
    assert.equal(esNoRecuperable(new Error('normal')), false);
  });

  it('ErrorNoRecuperable se reconoce por tipo y por marca', () => {
    const err = new ErrorNoRecuperable('malo');
    assert.equal(esNoRecuperable(err), true);
    assert.equal(err.noRecuperable, true);
  });
});
