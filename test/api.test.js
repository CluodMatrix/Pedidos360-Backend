import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { handler as catalogo } from '../src/catalogo/index.js';
import { handler as pedidos } from '../src/pedidos/index.js';
import { TABLE_PEDIDOS, TABLE_PRODUCTOS, db } from '../src/shared/dynamo.js';
import { instalarFakeDynamo } from './fake-dynamo.js';

const TODOS_LOS_SCOPES = ['catalog.read', 'catalog.write', 'orders.read', 'orders.write'];

// Simula el evento que entrega API Gateway (HTTP API v2) después del JWT Authorizer.
function evento({ method, path, body, roles, scopes = TODOS_LOS_SCOPES, oid = 'oid-ana', name = 'Ana Pérez', sinToken = false }) {
  return {
    rawPath: path,
    requestContext: {
      stage: '$default',
      http: { method },
      authorizer: sinToken
        ? undefined
        : { jwt: { claims: { sub: `sub-${oid}`, oid, name, roles: roles ? `[${roles.join(' ')}]` : undefined, scp: scopes.join(' ') } } },
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

const llamar = async (fn, opts) => {
  const res = await fn(evento(opts));
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};

const productoSeed = (id, stock = 10, precio = 1000) => ({ id, nombre: `Producto ${id}`, descripcion: 'desc', precio, stock });

let fake;
beforeEach(() => {
  fake = instalarFakeDynamo(db);
  fake.sembrar(TABLE_PRODUCTOS, [productoSeed('p1', 10, 1000), productoSeed('p2', 5, 2500.5), productoSeed('p3', 1, 100)]);
});
const stock = (id) => fake.tabla(TABLE_PRODUCTOS).get(id)?.stock;

describe('catalogo', () => {
  it('rechaza solicitudes sin token (401) y rutas inexistentes (404/405)', async () => {
    assert.equal((await llamar(catalogo, { method: 'GET', path: '/catalogo', sinToken: true })).status, 401);
    assert.equal((await llamar(catalogo, { method: 'GET', path: '/otra', roles: ['Admin'] })).status, 404);
    assert.equal((await llamar(catalogo, { method: 'PATCH', path: '/catalogo', roles: ['Admin'] })).status, 405);
  });

  it('Cliente no puede leer el catálogo; Operador sí pero no escribir', async () => {
    assert.equal((await llamar(catalogo, { method: 'GET', path: '/catalogo', roles: ['Cliente'] })).status, 403);
    const lista = await llamar(catalogo, { method: 'GET', path: '/catalogo', roles: ['Operador'] });
    assert.equal(lista.status, 200);
    assert.equal(lista.body.length, 3);
    const crear = await llamar(catalogo, { method: 'POST', path: '/catalogo', roles: ['Operador'], body: { nombre: 'x', descripcion: 'y', precio: 1, stock: 1 } });
    assert.equal(crear.status, 403);
  });

  it('exige el scope además del rol', async () => {
    const res = await llamar(catalogo, { method: 'GET', path: '/catalogo', roles: ['Admin'], scopes: ['orders.read'] });
    assert.equal(res.status, 403);
  });

  it('Admin crea, lee, actualiza parcialmente y elimina', async () => {
    const admin = { roles: ['Admin'] };
    const nuevo = { nombre: '  Monitor  ', descripcion: 'Monitor 24"', precio: 99990, stock: 7 };
    const creado = await llamar(catalogo, { method: 'POST', path: '/catalogo', body: nuevo, ...admin });
    assert.equal(creado.status, 201);
    assert.match(creado.body.id, /^prod-[0-9a-f]{8}$/);
    assert.equal(creado.body.nombre, 'Monitor');

    const { id } = creado.body;
    assert.equal((await llamar(catalogo, { method: 'GET', path: `/catalogo/${id}`, ...admin })).body.stock, 7);

    const upd = await llamar(catalogo, { method: 'PUT', path: `/catalogo/${id}`, body: { stock: 3, id: 'ignorado' }, ...admin });
    assert.equal(upd.status, 200);
    assert.equal(upd.body.stock, 3);
    assert.equal(upd.body.precio, 99990);
    assert.equal(upd.body.id, id);

    assert.equal((await llamar(catalogo, { method: 'DELETE', path: `/catalogo/${id}`, ...admin })).status, 204);
    assert.equal((await llamar(catalogo, { method: 'GET', path: `/catalogo/${id}`, ...admin })).status, 404);
    assert.equal((await llamar(catalogo, { method: 'DELETE', path: `/catalogo/${id}`, ...admin })).status, 404);
  });

  it('valida los datos (400) y responde 404 al actualizar algo inexistente', async () => {
    const admin = { roles: ['Admin'] };
    const malo = await llamar(catalogo, { method: 'POST', path: '/catalogo', body: { nombre: '', precio: -1, stock: 1.5 }, ...admin });
    assert.equal(malo.status, 400);
    assert.ok(malo.body.details.length >= 3);
    assert.equal((await llamar(catalogo, { method: 'PUT', path: '/catalogo/p1', body: {}, ...admin })).status, 400);
    assert.equal((await llamar(catalogo, { method: 'PUT', path: '/catalogo/no-existe', body: { stock: 1 }, ...admin })).status, 404);
    assert.equal((await llamar(catalogo, { method: 'POST', path: '/catalogo', ...admin })).status, 400);
  });
});

describe('pedidos: creación', () => {
  const cliente = { roles: ['Cliente'] };

  it('crea el pedido, calcula total en el backend, descuenta stock y toma el cliente del JWT', async () => {
    const res = await llamar(pedidos, {
      method: 'POST', path: '/pedidos', ...cliente,
      // el body intenta colar cliente y precios: deben ignorarse
      body: { clienteId: 'otro', total: 1, productos: [{ productoId: 'p1', cantidad: 2, precio: 1 }, { productoId: 'p2', cantidad: 1 }] },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.estado, 'CREADO');
    assert.equal(res.body.clienteId, 'oid-ana');
    assert.equal(res.body.clienteNombre, 'Ana Pérez');
    assert.equal(res.body.total, 4500.5);
    assert.deepEqual(res.body.productos[0], { productoId: 'p1', nombre: 'Producto p1', cantidad: 2, precio: 1000 });
    assert.equal(stock('p1'), 8);
    assert.equal(stock('p2'), 4);
    assert.equal(fake.tabla(TABLE_PEDIDOS).size, 1);
  });

  it('fusiona líneas repetidas del mismo producto', async () => {
    const res = await llamar(pedidos, { method: 'POST', path: '/pedidos', ...cliente, body: { productos: [{ productoId: 'p1', cantidad: 1 }, { productoId: 'p1', cantidad: 2 }] } });
    assert.equal(res.status, 201);
    assert.equal(res.body.productos.length, 1);
    assert.equal(res.body.productos[0].cantidad, 3);
    assert.equal(stock('p1'), 7);
  });

  it('valida el body y la existencia de productos (400)', async () => {
    for (const body of [{}, { productos: [] }, { productos: [{ productoId: 'p1', cantidad: 0 }] }, { productos: [{ cantidad: 1 }] }, { productos: [{ productoId: 'p1', cantidad: 1.5 }] }]) {
      assert.equal((await llamar(pedidos, { method: 'POST', path: '/pedidos', ...cliente, body })).status, 400);
    }
    const inexistente = await llamar(pedidos, { method: 'POST', path: '/pedidos', ...cliente, body: { productos: [{ productoId: 'nope', cantidad: 1 }] } });
    assert.equal(inexistente.status, 400);
  });

  it('stock insuficiente => 409 y la transacción no deja descuentos parciales', async () => {
    const res = await llamar(pedidos, { method: 'POST', path: '/pedidos', ...cliente, body: { productos: [{ productoId: 'p1', cantidad: 2 }, { productoId: 'p3', cantidad: 2 }] } });
    assert.equal(res.status, 409);
    assert.equal(stock('p1'), 10);
    assert.equal(stock('p3'), 1);
    assert.equal(fake.tabla(TABLE_PEDIDOS).size, 0);
  });

  it('dos compras simultáneas del último producto: solo una se concreta (sin sobreventa)', async () => {
    const compra = (oid) => llamar(pedidos, { method: 'POST', path: '/pedidos', roles: ['Cliente'], oid, body: { productos: [{ productoId: 'p3', cantidad: 1 }] } });
    const [a, b] = await Promise.all([compra('oid-a'), compra('oid-b')]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    assert.equal(stock('p3'), 0);
    assert.equal(fake.tabla(TABLE_PEDIDOS).size, 1);
  });

  it('Admin no crea pedidos; sin scope orders.write tampoco', async () => {
    const body = { productos: [{ productoId: 'p1', cantidad: 1 }] };
    assert.equal((await llamar(pedidos, { method: 'POST', path: '/pedidos', roles: ['Admin'], body })).status, 403);
    assert.equal((await llamar(pedidos, { method: 'POST', path: '/pedidos', roles: ['Cliente'], scopes: ['orders.read'], body })).status, 403);
    assert.equal((await llamar(pedidos, { method: 'POST', path: '/pedidos', roles: ['Operador'], body })).status, 201);
  });
});

describe('pedidos: consulta y ownership', () => {
  async function crearComo(oid, name) {
    const res = await llamar(pedidos, { method: 'POST', path: '/pedidos', roles: ['Cliente'], oid, name, body: { productos: [{ productoId: 'p1', cantidad: 1 }] } });
    return res.body.id;
  }

  it('el Cliente lista solo sus pedidos (Query por índice) y el staff ve todos', async () => {
    const idAna = await crearComo('oid-ana', 'Ana');
    await new Promise((r) => setTimeout(r, 5));
    await crearComo('oid-luis', 'Luis');
    await crearComo('oid-ana', 'Ana');

    fake.llamadas.length = 0;
    const mios = await llamar(pedidos, { method: 'GET', path: '/pedidos', roles: ['Cliente'], oid: 'oid-ana' });
    assert.equal(mios.status, 200);
    assert.equal(mios.body.length, 2);
    assert.ok(mios.body.every((p) => p.clienteId === 'oid-ana'));
    assert.deepEqual(fake.llamadas, ['QueryCommand:clienteId-fechaCreacion-index']);
    assert.ok(mios.body.some((p) => p.id === idAna));

    for (const rol of ['Operador', 'Admin']) {
      assert.equal((await llamar(pedidos, { method: 'GET', path: '/pedidos', roles: [rol] })).body.length, 3);
    }
  });

  it('GET /pedidos/{id}: el dueño y el staff pueden; otro cliente recibe 403; inexistente 404', async () => {
    const id = await crearComo('oid-ana', 'Ana');
    assert.equal((await llamar(pedidos, { method: 'GET', path: `/pedidos/${id}`, roles: ['Cliente'], oid: 'oid-ana' })).status, 200);
    assert.equal((await llamar(pedidos, { method: 'GET', path: `/pedidos/${id}`, roles: ['Cliente'], oid: 'oid-luis' })).status, 403);
    assert.equal((await llamar(pedidos, { method: 'GET', path: `/pedidos/${id}`, roles: ['Operador'] })).status, 200);
    assert.equal((await llamar(pedidos, { method: 'GET', path: '/pedidos/ZZZ', roles: ['Operador'] })).status, 404);
  });

  it('interpreta roles múltiples ("[Admin Operador]") del authorizer', async () => {
    const res = await llamar(pedidos, { method: 'GET', path: '/pedidos', roles: ['Cliente', 'Operador'] });
    assert.equal(res.status, 200);
  });
});

describe('pedidos: cambio de estado', () => {
  const staff = { roles: ['Operador'] };
  const estado = (id, e, opts = staff) => llamar(pedidos, { method: 'PUT', path: `/pedidos/${id}/estado`, body: { estado: e }, ...opts });
  async function nuevoPedido(productos = [{ productoId: 'p1', cantidad: 3 }]) {
    return (await llamar(pedidos, { method: 'POST', path: '/pedidos', roles: ['Cliente'], body: { productos } })).body.id;
  }

  it('recorre el flujo completo y rechaza saltos o retrocesos con 409', async () => {
    const id = await nuevoPedido();
    assert.equal((await estado(id, 'ENTREGADO')).status, 409);
    for (const e of ['ACEPTADO', 'EN_PREPARACION', 'DESPACHADO', 'ENTREGADO']) {
      const res = await estado(id, e);
      assert.equal(res.status, 200, e);
      assert.equal(res.body.estado, e);
    }
    assert.equal((await estado(id, 'CANCELADO')).status, 409);
    assert.equal((await estado(id, 'CREADO')).status, 409);
    assert.equal(stock('p1'), 7);
  });

  it('validaciones: estado inválido 400, pedido inexistente 404', async () => {
    const id = await nuevoPedido();
    assert.equal((await estado(id, 'VOLANDO')).status, 400);
    assert.equal((await estado('NOPE', 'ACEPTADO')).status, 404);
  });

  it('el Cliente no puede cambiar estados; el Admin sí', async () => {
    const id = await nuevoPedido();
    assert.equal((await estado(id, 'CANCELADO', { roles: ['Cliente'] })).status, 403);
    assert.equal((await estado(id, 'ACEPTADO', { roles: ['Admin'] })).status, 200);
  });

  it('cancelar devuelve el stock (solo una vez)', async () => {
    const id = await nuevoPedido([{ productoId: 'p1', cantidad: 3 }, { productoId: 'p2', cantidad: 2 }]);
    assert.equal(stock('p1'), 7);
    assert.equal(stock('p2'), 3);
    assert.equal((await estado(id, 'CANCELADO')).status, 200);
    assert.equal(stock('p1'), 10);
    assert.equal(stock('p2'), 5);
    assert.equal((await estado(id, 'CANCELADO')).status, 409);
    assert.equal(stock('p1'), 10);
  });

  it('cancelar con un producto borrado del catálogo no crea ítems fantasma', async () => {
    const id = await nuevoPedido([{ productoId: 'p1', cantidad: 1 }, { productoId: 'p2', cantidad: 1 }]);
    fake.tabla(TABLE_PRODUCTOS).delete('p2');
    assert.equal((await estado(id, 'CANCELADO')).status, 200);
    assert.equal(fake.tabla(TABLE_PRODUCTOS).has('p2'), false);
    assert.equal(stock('p1'), 10);
  });
});
