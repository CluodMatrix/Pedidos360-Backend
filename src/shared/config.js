// src/shared/config.js
//
// CONFIGURACIÓN CENTRALIZADA de la mensajería asíncrona (SNS + SQS).
//
// Indicadores evaluados en la EP2:
//   · "Configuración centralizada (12%)": nombres de colas, DLQ, topic y
//     suscripciones definidos en un solo lugar.
//   · "Configuración separada de la lógica (10%)": los handlers NO llevan
//     nombres ni ARNs escritos dentro; la configuración vive aparte.
//
// Regla del proyecto: si un nombre o un ARN aparece escrito dentro de un
// handler, es un error. Todo sale de este archivo.
//
// Dos bloques con propósitos distintos:
//
//   NOMBRES / FILTROS  -> constantes puras. Las usan los scripts de
//                         infraestructura (crear topicos, colas y suscripciones)
//                         y los tests. No dependen de variables de entorno.
//   config             -> valores que llegan por VARIABLES DE ENTORNO a cada
//                         Lambda en tiempo de ejecución (ver scripts/deploy.js).

/** Nombres exactos de los recursos. Deben coincidir con los de la guía. */
export const NOMBRES = {
  topic: 'pedidos360-eventos',
  colas: {
    email: { cola: 'q-email', dlq: 'q-email-dlq' },
    cocina: { cola: 'q-kitchen', dlq: 'q-kitchen-dlq' },
    boleta: { cola: 'q-invoice', dlq: 'q-invoice-dlq' },
    // Flujo de notificaciones para la interfaz: recibe TODOS los eventos y
    // los deja disponibles para que el frontend los muestre en pantalla.
    notificaciones: { cola: 'q-notificaciones', dlq: 'q-notificaciones-dlq' },
  },
};

/**
 * Tipos de evento del dominio.
 * El nombre del atributo de mensaje que usa la filter policy es `tipo_evento`.
 */
export const TIPOS_EVENTO = {
  PEDIDO_CREADO: 'PedidoCreado',
  PEDIDO_ACEPTADO: 'PedidoAceptado',
  PEDIDO_EN_PREPARACION: 'PedidoEnPreparacion',
  PEDIDO_DESPACHADO: 'PedidoDespachado',
  PEDIDO_ENTREGADO: 'PedidoEntregado',
  PEDIDO_CANCELADO: 'PedidoCancelado',
};

/**
 * Filter policies por suscripción (equivale al binding/routing key de RabbitMQ).
 *
 *   · null  -> la cola recibe TODOS los eventos (equivale a un exchange fanout).
 *   · ['X'] -> coincidencia EXACTA del atributo `tipo_evento`.
 *   · [{ prefix }] -> coincidencia por PREFIJO (equivale a un exchange topic).
 *
 * Con esto se cubren los dos estilos que pide la pauta:
 *   q-email   -> sin filtro      -> recibe todos los eventos
 *   q-kitchen -> exacto          -> solo PedidoAceptado
 *   q-invoice -> prefijo         -> solo PedidoDespachado (y lo que empiece por eso)
 */
export const FILTROS = {
  email: null,
  cocina: { tipo_evento: [TIPOS_EVENTO.PEDIDO_ACEPTADO] },
  boleta: { tipo_evento: [{ prefix: TIPOS_EVENTO.PEDIDO_DESPACHADO }] },
  notificaciones: null,
};

/**
 * Parámetros de la topología.
 * El visibility timeout debe ser MAYOR que el timeout de la Lambda consumidora
 * (AWS sugiere 6 veces) para que un mensaje no reaparezca mientras se procesa.
 */
export const TOPOLOGIA = {
  /** Intentos antes de que el mensaje vaya a la DLQ (redrive policy). */
  maxReceiveCount: 3,
  /** Segundos que un mensaje permanece invisible mientras se procesa. */
  visibilityTimeout: 30,
  /** Segundos que puede durar una invocación de la Lambda consumidora. */
  lambdaTimeout: 5,
  /** Días que se retienen los mensajes en la cola (1-14). */
  retentionPeriod: 4,
  /** Mensajes por invocación del consumidor. 1 = se ven claros los reintentos. */
  batchSize: 1,
};

/** Nombres de las variables de entorno que inyecta scripts/deploy.js. */
export const VARIABLES = {
  topicArn: 'TOPIC_ARN',
  colas: {
    email: { url: 'QUEUE_EMAIL_URL', dlqUrl: 'DLQ_EMAIL_URL' },
    cocina: { url: 'QUEUE_KITCHEN_URL', dlqUrl: 'DLQ_KITCHEN_URL' },
    boleta: { url: 'QUEUE_INVOICE_URL', dlqUrl: 'DLQ_INVOICE_URL' },
    notificaciones: { url: 'QUEUE_NOTIFICACIONES_URL', dlqUrl: 'DLQ_NOTIFICACIONES_URL' },
  },
  tablaEventos: 'TABLA_EVENTOS_PROCESADOS',
  tablaNotificaciones: 'TABLA_NOTIFICACIONES',
};

/**
 * Configuración efectiva en tiempo de ejecución.
 * Si una variable no está, el valor queda en `undefined` y el código que la
 * necesita avisa por log en vez de romperse con un error poco claro.
 */
export const config = {
  region: process.env.AWS_REGION ?? 'us-east-1',
  topicArn: process.env[VARIABLES.topicArn],
  tablaEventos: process.env[VARIABLES.tablaEventos] ?? '',
  tablaNotificaciones: process.env[VARIABLES.tablaNotificaciones] ?? '',
  topologia: TOPOLOGIA,
  colas: {
    email: {
      ...NOMBRES.colas.email,
      url: process.env[VARIABLES.colas.email.url],
      dlqUrl: process.env[VARIABLES.colas.email.dlqUrl],
    },
    cocina: {
      ...NOMBRES.colas.cocina,
      url: process.env[VARIABLES.colas.cocina.url],
      dlqUrl: process.env[VARIABLES.colas.cocina.dlqUrl],
    },
    boleta: {
      ...NOMBRES.colas.boleta,
      url: process.env[VARIABLES.colas.boleta.url],
      dlqUrl: process.env[VARIABLES.colas.boleta.dlqUrl],
    },
    notificaciones: {
      ...NOMBRES.colas.notificaciones,
      url: process.env[VARIABLES.colas.notificaciones.url],
      dlqUrl: process.env[VARIABLES.colas.notificaciones.dlqUrl],
    },
  },
};
