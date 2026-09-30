// Lambda pedidos360-catalogo
//
//   GET    /catalogo        Admin, Operador   catalog.read
//   GET    /catalogo/{id}   Admin, Operador   catalog.read
//   POST   /catalogo        Admin             catalog.write
//   PUT    /catalogo/{id}   Admin             catalog.write   (actualización parcial)
//   DELETE /catalogo/{id}   Admin             catalog.write
//
// El rol Cliente NO puede leer el catálogo administrativo (el front usa una lista demo).
import { randomUUID } from 'node:crypto';
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { authorize } from '../shared/auth.js';
import { TABLE_PRODUCTOS, db, scanAll } from '../shared/dynamo.js';
import { badRequest, createHandler, json, noContent, notFound, parseBody } from '../shared/http.js';

const LECTURA = ['Admin', 'Operador'];
const ESCRITURA = ['Admin'];

const MAX_NOMBRE = 120;
const MAX_DESCRIPCION = 1000;
const MAX_PRECIO = 1_000_000_000;
const MAX_STOCK = 1_000_000;

const toProducto = (item) => ({
  id: item.id,
  nombre: item.nombre,
  descripcion: item.descripcion,
  precio: item.precio,
  stock: item.stock,
  fechaCreacion: item.fechaCreacion,
  fechaActualizacion: item.fechaActualizacion,
});

/** Valida el body. Con partial=true solo valida los campos presentes (PUT). Ignora campos desconocidos. */
export function validarProducto(body, { partial }) {
  const errores = [];
  const datos = {};
  const presente = (campo) => body[campo] !== undefined;

  const texto = (campo, max) => {
    if (!presente(campo)) {
      if (!partial) errores.push(`${campo} es obligatorio.`);
      return;
    }
    const valor = typeof body[campo] === 'string' ? body[campo].trim() : '';
    if (!valor || valor.length > max) {
      errores.push(`${campo} debe ser un texto de 1 a ${max} caracteres.`);
      return;
    }
    datos[campo] = valor;
  };

  texto('nombre', MAX_NOMBRE);
  texto('descripcion', MAX_DESCRIPCION);

  if (!presente('precio')) {
    if (!partial) errores.push('precio es obligatorio.');
  } else if (typeof body.precio !== 'number' || !Number.isFinite(body.precio) || body.precio < 0 || body.precio > MAX_PRECIO) {
    errores.push('precio debe ser un número mayor o igual a 0.');
  } else {
    datos.precio = body.precio;
  }

  if (!presente('stock')) {
    if (!partial) errores.push('stock es obligatorio.');
  } else if (!Number.isInteger(body.stock) || body.stock < 0 || body.stock > MAX_STOCK) {
    errores.push('stock debe ser un entero mayor o igual a 0.');
  } else {
    datos.stock = body.stock;
  }

  if (partial && errores.length === 0 && Object.keys(datos).length === 0) {
    errores.push('Indica al menos un campo a actualizar: nombre, descripcion, precio o stock.');
  }
  if (errores.length > 0) throw badRequest('Datos de producto inválidos.', errores);
  return datos;
}

function validarId(id) {
  if (!id || id.length > 100) throw badRequest('El identificador del producto no es válido.');
  return id;
}

const esCondicionFallida = (err) => err?.name === 'ConditionalCheckFailedException';

async function listar({ event }) {
  authorize(event, { roles: LECTURA, scope: 'catalog.read' });
  const items = await scanAll({ TableName: TABLE_PRODUCTOS });
  items.sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), 'es'));
  return json(200, items.map(toProducto));
}

async function obtener({ event, params }) {
  authorize(event, { roles: LECTURA, scope: 'catalog.read' });
  const { Item } = await db.send(new GetCommand({ TableName: TABLE_PRODUCTOS, Key: { id: validarId(params.id) } }));
  if (!Item) throw notFound('Producto no encontrado.');
  return json(200, toProducto(Item));
}

async function crear({ event }) {
  authorize(event, { roles: ESCRITURA, scope: 'catalog.write' });
  const datos = validarProducto(parseBody(event), { partial: false });
  const ahora = new Date().toISOString();
  const item = { id: `prod-${randomUUID().slice(0, 8)}`, ...datos, fechaCreacion: ahora, fechaActualizacion: ahora };

  await db.send(new PutCommand({
    TableName: TABLE_PRODUCTOS,
    Item: item,
    ConditionExpression: 'attribute_not_exists(#id)',
    ExpressionAttributeNames: { '#id': 'id' },
  }));
  return json(201, toProducto(item));
}

async function actualizar({ event, params }) {
  authorize(event, { roles: ESCRITURA, scope: 'catalog.write' });
  const id = validarId(params.id);
  const cambios = { ...validarProducto(parseBody(event), { partial: true }), fechaActualizacion: new Date().toISOString() };

  const names = { '#id': 'id' };
  const values = {};
  const sets = [];
  Object.entries(cambios).forEach(([campo, valor], i) => {
    names[`#f${i}`] = campo;
    values[`:v${i}`] = valor;
    sets.push(`#f${i} = :v${i}`);
  });

  try {
    const { Attributes } = await db.send(new UpdateCommand({
      TableName: TABLE_PRODUCTOS,
      Key: { id },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: 'attribute_exists(#id)',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }));
    return json(200, toProducto(Attributes));
  } catch (err) {
    if (esCondicionFallida(err)) throw notFound('Producto no encontrado.');
    throw err;
  }
}

async function eliminar({ event, params }) {
  authorize(event, { roles: ESCRITURA, scope: 'catalog.write' });
  try {
    await db.send(new DeleteCommand({
      TableName: TABLE_PRODUCTOS,
      Key: { id: validarId(params.id) },
      ConditionExpression: 'attribute_exists(#id)',
      ExpressionAttributeNames: { '#id': 'id' },
    }));
  } catch (err) {
    if (esCondicionFallida(err)) throw notFound('Producto no encontrado.');
    throw err;
  }
  return noContent();
}

export const handler = createHandler([
  ['GET', '/catalogo', listar],
  ['POST', '/catalogo', crear],
  ['GET', '/catalogo/{id}', obtener],
  ['PUT', '/catalogo/{id}', actualizar],
  ['DELETE', '/catalogo/{id}', eliminar],
]);
