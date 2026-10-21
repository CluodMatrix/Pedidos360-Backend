// Lambda pedidos360-pedidos
//
//   GET  /pedidos               Admin, Operador, Cliente   orders.read   (Cliente: solo los suyos)
//   GET  /pedidos/{id}          Admin, Operador, Cliente   orders.read   (Cliente: solo si es el dueño)
//   POST /pedidos               Cliente, Operador          orders.write  (crea en estado CREADO)
//   PUT  /pedidos/{id}/estado   Admin, Operador            orders.write  (valida la máquina de estados)
//
// Reglas clave:
//  - El cliente (clienteId / clienteNombre) SIEMPRE sale del JWT, nunca del body.
//  - Precios y total los calcula el backend a partir de la tabla de productos.
//  - Crear pedido descuenta stock y guarda el pedido en UNA transacción (sin sobreventa).
//  - Cancelar un pedido devuelve el stock en la misma transacción que cambia el estado.
//  - Una vez guardado el pedido, se publica un evento en SNS (EP2). El productor
//    no conoce a los consumidores: el fan-out y los filtros los decide el topic.
import { randomUUID } from 'node:crypto';
import { BatchGetCommand, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

import { authorize } from '../shared/auth.js';
import { INDEX_PEDIDOS_CLIENTE, TABLE_NOTIFICACIONES, TABLE_PEDIDOS, TABLE_PRODUCTOS, db, queryAll, scanAll } from '../shared/dynamo.js';
import { HttpError, badRequest, conflict, createHandler, json, notFound, parseBody } from '../shared/http.js';
import { config } from '../shared/config.js';
import { eventoDeEstado, publicarEvento } from '../shared/sns.js';

const ESTADOS = ['CREADO', 'ACEPTADO', 'EN_PREPARACION', 'DESPACHADO', 'ENTREGADO', 'CANCELADO'];

// Misma máquina de estados que transicionesPermitidas() del frontend.
export const TRANSICIONES = {
  CREADO: ['ACEPTADO', 'CANCELADO'],
  ACEPTADO: ['EN_PREPARACION', 'CANCELADO'],
  EN_PREPARACION: ['DESPACHADO', 'CANCELADO'],
  DESPACHADO: ['ENTREGADO'],
  ENTREGADO: [],
  CANCELADO: [],
};

const STAFF = ['Admin', 'Operador'];
const LECTURA = ['Admin', 'Operador', 'Cliente'];
const CREAR = ['Cliente', 'Operador'];

const MAX_LINEAS = 20;
const MAX_CANTIDAD = 1000;

const esStaff = (identity) => identity.roles.some((rol) => STAFF.includes(rol));

const toPedido = (item) => ({
  id: item.id,
  clienteId: item.clienteId,
  clienteNombre: item.clienteNombre,
  estado: item.estado,
  fechaCreacion: item.fechaCreacion,
  fechaActualizacion: item.fechaActualizacion,
  total: item.total,
  productos: item.productos ?? [],
});

const redondear = (n) => Math.round(n * 100) / 100;

function validarId(id) {
  if (!id || id.length > 100) throw badRequest('El identificador del pedido no es válido.');
  return id;
}

/** Valida body.productos y fusiona líneas repetidas del mismo producto. */
export function validarLineas(body) {
  const { productos } = body;
  if (!Array.isArray(productos) || productos.length === 0) {
    throw badRequest('productos debe ser un arreglo con al menos un elemento.');
  }
  if (productos.length > MAX_LINEAS) {
    throw badRequest(`Un pedido admite como máximo ${MAX_LINEAS} líneas.`);
  }

  const errores = [];
  const fusion = new Map();
  productos.forEach((linea, i) => {
    const bruto = linea?.productoId;
    const productoId = typeof bruto === 'number' ? String(bruto) : typeof bruto === 'string' ? bruto.trim() : '';
    const { cantidad } = linea ?? {};
    if (!productoId || productoId.length > 100) errores.push(`productos[${i}].productoId es obligatorio.`);
    if (!Number.isInteger(cantidad) || cantidad < 1) errores.push(`productos[${i}].cantidad debe ser un entero mayor que 0.`);
    if (productoId && Number.isInteger(cantidad) && cantidad >= 1) {
      fusion.set(productoId, (fusion.get(productoId) ?? 0) + cantidad);
    }
  });
  for (const [productoId, cantidad] of fusion) {
    if (cantidad > MAX_CANTIDAD) errores.push(`La cantidad de ${productoId} supera el máximo de ${MAX_CANTIDAD}.`);
  }
  if (errores.length > 0) throw badRequest('Datos del pedido inválidos.', errores);
  return [...fusion].map(([productoId, cantidad]) => ({ productoId, cantidad }));
}

/** BatchGet de productos por id. Devuelve Map(id -> item). Reintenta claves no procesadas. */
async function obtenerProductos(ids) {
  const encontrados = new Map();
  let pendientes = [...new Set(ids.map(String))].map((id) => ({ id }));
  for (let intento = 0; pendientes.length > 0 && intento < 4; intento += 1) {
    const { Responses, UnprocessedKeys } = await db.send(new BatchGetCommand({
      RequestItems: { [TABLE_PRODUCTOS]: { Keys: pendientes } },
    }));
    for (const item of Responses?.[TABLE_PRODUCTOS] ?? []) encontrados.set(item.id, item);
    pendientes = UnprocessedKeys?.[TABLE_PRODUCTOS]?.Keys ?? [];
  }
  return encontrados;
}

function cancelacionPorCondicion(err, lineas) {
  if (err?.name !== 'TransactionCanceledException') return null;
  const razones = err.CancellationReasons ?? [];
  const idx = razones.findIndex((r, i) => r?.Code === 'ConditionalCheckFailed' && i < lineas.length);
  if (idx >= 0) return conflict(`Stock insuficiente para "${lineas[idx].nombre}".`, { productoId: lineas[idx].productoId });
  return conflict('El pedido no pudo procesarse por un cambio simultáneo. Inténtalo nuevamente.');
}

/**
 * Publica un evento del pedido en el SNS Topic.
 *
 * El pedido ya está guardado en DynamoDB cuando se llama a esta función, así
 * que el pedido NO puede fallar por un problema de mensajería: si la
 * publicación falla, se registra el error y se responde igual. Perder un
 * correo es un incidente; perder un pedido cobrado es peor.
 *
 * (En producción lo correcto es un patrón "outbox": se escribe el evento en la
 * misma transacción que el pedido y un reproductor lo publica a SNS.)
 */
let avisoSinTopic = false;

async function notificarCambio(pedido, tipoEvento) {
  if (!config.topicArn) {
    // La mensajería no está desplegada todavía: no es un fallo del pedido.
    if (!avisoSinTopic) {
      avisoSinTopic = true;
      console.warn(
        `Sin TOPIC_ARN configurado: no se publican eventos (pedido ${pedido.id}, "${tipoEvento}").`,
      );
    }
    return;
  }

  try {
    const { eventId } = await publicarEvento({
      tipoEvento,
      pedidoId: pedido.id,
      datos: {
        estado: pedido.estado,
        total: pedido.total,
        clienteId: pedido.clienteId,
        clienteNombre: pedido.clienteNombre,
        productos: pedido.productos,
      },
    });
    console.log(`Evento "${tipoEvento}" publicado para el pedido ${pedido.id} (${eventId}).`);
  } catch (err) {
    console.error(
      `No se pudo publicar el evento "${tipoEvento}" del pedido ${pedido.id}: ${err.message}. ` +
        'El pedido quedó guardado en DynamoDB.',
    );
  }
}

// ---------------------------------------------------------------- handlers

/**
 * GET /notificaciones
 *
 * Eventos ya consumidos por la Lambda de notificaciones, del mas reciente al
 * mas antiguo. Es lo que la interfaz consulta para mostrar los avisos.
 *
 * Se lee con un Query sobre el GSI (clave constante + fecha), no con un Scan
 * de toda la tabla.
 */
async function listarNotificaciones({ event }) {
  authorize(event, { roles: LECTURA, scope: 'orders.read' });

  const { Items } = await db.send(
    new QueryCommand({
      TableName: TABLE_NOTIFICACIONES,
      IndexName: 'notificaciones-fecha-index',
      KeyConditionExpression: '#c = :c',
      ExpressionAttributeNames: { '#c': 'clave' },
      ExpressionAttributeValues: { ':c': 'notificaciones' },
      ScanIndexForward: false, // del mas reciente al mas antiguo
      Limit: 20,
    }),
  );

  return json(
    200,
    (Items ?? []).map((item) => ({
      id: item.id,
      tipo: item.tipo,
      pedidoId: item.pedidoId,
      clienteNombre: item.clienteNombre,
      total: item.total,
      texto: item.texto,
      fecha: item.fecha,
    })),
  );
}

async function listar({ event }) {
  const identity = authorize(event, { roles: LECTURA, scope: 'orders.read' });
  const items = esStaff(identity)
    ? await scanAll({ TableName: TABLE_PEDIDOS })
    : await queryAll({
        TableName: TABLE_PEDIDOS,
        IndexName: INDEX_PEDIDOS_CLIENTE,
        KeyConditionExpression: '#c = :c',
        ExpressionAttributeNames: { '#c': 'clienteId' },
        ExpressionAttributeValues: { ':c': identity.id },
        ScanIndexForward: false,
      });
  items.sort((a, b) => String(b.fechaCreacion).localeCompare(String(a.fechaCreacion)));
  return json(200, items.map(toPedido));
}

async function obtener({ event, params }) {
  const identity = authorize(event, { roles: LECTURA, scope: 'orders.read' });
  const { Item } = await db.send(new GetCommand({ TableName: TABLE_PEDIDOS, Key: { id: validarId(params.id) } }));
  if (!Item) throw notFound('Pedido no encontrado.');
  if (!esStaff(identity) && Item.clienteId !== identity.id) {
    throw new HttpError(403, 'FORBIDDEN', 'No puedes consultar pedidos de otros clientes.');
  }
  return json(200, toPedido(Item));
}

async function crear({ event }) {
  const identity = authorize(event, { roles: CREAR, scope: 'orders.write' });
  const lineas = validarLineas(parseBody(event));

  const productos = await obtenerProductos(lineas.map((l) => l.productoId));
  const detalle = lineas.map(({ productoId, cantidad }) => {
    const producto = productos.get(productoId);
    if (!producto) throw badRequest(`El producto "${productoId}" no existe.`, { productoId });
    if (producto.stock < cantidad) {
      throw conflict(`Stock insuficiente para "${producto.nombre}" (disponible: ${producto.stock}).`, { productoId });
    }
    return { productoId, nombre: producto.nombre, cantidad, precio: producto.precio };
  });

  const ahora = new Date().toISOString();
  const pedido = {
    id: randomUUID().slice(0, 8).toUpperCase(),
    clienteId: identity.id,
    clienteNombre: identity.name,
    estado: 'CREADO',
    fechaCreacion: ahora,
    fechaActualizacion: ahora,
    total: redondear(detalle.reduce((suma, l) => suma + l.precio * l.cantidad, 0)),
    productos: detalle,
  };

  // La condición stock >= cantidad se evalúa en DynamoDB: es la que evita la sobreventa.
  const TransactItems = [
    ...detalle.map((l) => ({
      Update: {
        TableName: TABLE_PRODUCTOS,
        Key: { id: l.productoId },
        UpdateExpression: 'SET #stock = #stock - :c',
        ConditionExpression: 'attribute_exists(#id) AND #stock >= :c',
        ExpressionAttributeNames: { '#id': 'id', '#stock': 'stock' },
        ExpressionAttributeValues: { ':c': l.cantidad },
      },
    })),
    {
      Put: {
        TableName: TABLE_PEDIDOS,
        Item: pedido,
        ConditionExpression: 'attribute_not_exists(#id)',
        ExpressionAttributeNames: { '#id': 'id' },
      },
    },
  ];

  try {
    await db.send(new TransactWriteCommand({ TransactItems }));
  } catch (err) {
    throw cancelacionPorCondicion(err, detalle) ?? err;
  }

  // El pedido ya está en DynamoDB: ahora se avisa al resto del sistema.
  await notificarCambio(pedido, eventoDeEstado('CREADO'));

  return json(201, toPedido(pedido));
}

async function cambiarEstado({ event, params }) {
  authorize(event, { roles: STAFF, scope: 'orders.write' });
  const id = validarId(params.id);
  const { estado } = parseBody(event);
  if (!ESTADOS.includes(estado)) {
    throw badRequest(`estado debe ser uno de: ${ESTADOS.join(', ')}.`);
  }

  const { Item: actual } = await db.send(new GetCommand({ TableName: TABLE_PEDIDOS, Key: { id } }));
  if (!actual) throw notFound('Pedido no encontrado.');
  if (!TRANSICIONES[actual.estado]?.includes(estado)) {
    throw new HttpError(409, 'INVALID_TRANSITION', `No se puede cambiar un pedido de ${actual.estado} a ${estado}.`, {
      estadoActual: actual.estado,
      permitidos: TRANSICIONES[actual.estado] ?? [],
    });
  }

  const ahora = new Date().toISOString();
  const TransactItems = [
    {
      Update: {
        TableName: TABLE_PEDIDOS,
        Key: { id },
        UpdateExpression: 'SET #estado = :nuevo, #fecha = :ahora',
        // Concurrencia optimista: si otro usuario cambió el estado entre la lectura y la escritura, falla.
        ConditionExpression: '#estado = :actual',
        ExpressionAttributeNames: { '#estado': 'estado', '#fecha': 'fechaActualizacion' },
        ExpressionAttributeValues: { ':nuevo': estado, ':ahora': ahora, ':actual': actual.estado },
      },
    },
  ];

  if (estado === 'CANCELADO') {
    // Se devuelve stock solo de productos que aún existen (evita crear ítems "fantasma").
    const existentes = await obtenerProductos((actual.productos ?? []).map((p) => p.productoId));
    for (const linea of actual.productos ?? []) {
      if (!existentes.has(String(linea.productoId))) continue;
      TransactItems.push({
        Update: {
          TableName: TABLE_PRODUCTOS,
          Key: { id: String(linea.productoId) },
          UpdateExpression: 'SET #stock = #stock + :c',
          ConditionExpression: 'attribute_exists(#id)',
          ExpressionAttributeNames: { '#id': 'id', '#stock': 'stock' },
          ExpressionAttributeValues: { ':c': linea.cantidad },
        },
      });
    }
  }

  try {
    await db.send(new TransactWriteCommand({ TransactItems }));
  } catch (err) {
    if (err?.name === 'TransactionCanceledException') {
      throw conflict('El pedido cambió mientras se procesaba. Actualiza la lista e inténtalo nuevamente.');
    }
    throw err;
  }

  const actualizado = { ...actual, estado, fechaActualizacion: ahora };
  // PedidoAceptado y PedidoDespachado son los eventos que espera el topic
  // (las filter policies de q-kitchen y q-invoice los filtran por tipo).
  const tipoEvento = eventoDeEstado(estado);
  if (tipoEvento) await notificarCambio(actualizado, tipoEvento);

  return json(200, toPedido(actualizado));
}

export const handler = createHandler([
  ['GET', '/pedidos', listar],
  ['POST', '/pedidos', crear],
  ['GET', '/pedidos/{id}', obtener],
  ['PUT', '/pedidos/{id}/estado', cambiarEstado],
  ['GET', '/notificaciones', listarNotificaciones],
]);
