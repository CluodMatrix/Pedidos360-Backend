# Pedidos360 Backend (Node.js + AWS Lambda + DynamoDB)

Migración a Node.js 22 del backend de Pedidos360. Serverless, sin VPC, sin capacidad
provisionada: pensado para AWS Academy (sin consumo relevante de créditos).

```
Navegador (localhost:5173) ──Bearer JWT──▶ API Gateway HTTP API (JWT Authorizer = Entra ID)
                                             ├─ /catalogo*  ─▶ Lambda pedidos360-catalogo ─▶ DynamoDB Productos
                                             └─ /pedidos*   ─▶ Lambda pedidos360-pedidos  ─▶ DynamoDB Pedidos + Productos
```

## Estructura

```
src/
  catalogo/index.js   Lambda de catálogo (CRUD de productos)
  pedidos/index.js    Lambda de pedidos (crear, listar, cambiar estado)
  shared/             auth (roles/scopes), http (router, errores), dynamo (cliente)
scripts/              build · create-tables · seed · deploy  (Node, funcionan igual en Windows)
test/                 19 pruebas con un DynamoDB falso en memoria
docs/GUIA-ENTRA-APIGATEWAY.md
```

## Puesta en marcha

Requisitos: Node 20+ (recomendado 22) y credenciales de AWS Academy.

1. **Credenciales.** En el Learner Lab: *AWS Details → AWS CLI → Show*. Pega los tres valores en
   `~/.aws/credentials` (perfil `[default]`: `aws_access_key_id`, `aws_secret_access_key`,
   `aws_session_token`). Expiran al terminar la sesión del lab: hay que repetirlo cada vez.
2. **Instalar y probar:**
   ```bash
   npm install
   npm test
   ```
3. **Tablas y datos de demo** (región `us-east-1` por defecto; cambia con `AWS_REGION`):
   ```bash
   npm run tables      # crea Pedidos360-Productos y Pedidos360-Pedidos (on-demand)
   npm run seed        # 6 productos demo (no pisa el stock si ya existen; --reset lo restablece)
   ```
4. **Desplegar las Lambdas** (reutiliza el rol `LabRole`; no crea roles IAM):
   ```bash
   npm run deploy      # build + crea/actualiza pedidos360-catalogo y pedidos360-pedidos
   ```
5. **Entra ID y API Gateway:** sigue `docs/GUIA-ENTRA-APIGATEWAY.md`.

Volver a ejecutar `npm run deploy` actualiza el código sin recrear nada.

## Tablas DynamoDB

| Tabla | Clave | Índices | Contenido |
|---|---|---|---|
| `Pedidos360-Productos` | `id` (S) | — | `nombre, descripcion, precio, stock, fechaCreacion, fechaActualizacion` |
| `Pedidos360-Pedidos` | `id` (S) | GSI `clienteId-fechaCreacion-index` (`clienteId` + `fechaCreacion`) | `clienteId, clienteNombre, estado, total, productos[{productoId,nombre,cantidad,precio}], fechas` |

El GSI permite que un Cliente liste **sus** pedidos con `Query` en vez de `Scan`. Los pedidos
guardan una copia (nombre y precio) de cada producto: si el catálogo cambia después, el pedido no se altera.

## Contrato de la API

| Método y ruta | Roles | Scope | Respuestas |
|---|---|---|---|
| `GET /catalogo` | Admin, Operador | `catalog.read` | 200 lista |
| `GET /catalogo/{id}` | Admin, Operador | `catalog.read` | 200 · 404 |
| `POST /catalogo` | Admin | `catalog.write` | 201 · 400 |
| `PUT /catalogo/{id}` | Admin | `catalog.write` | 200 · 400 · 404 (parcial: solo los campos enviados) |
| `DELETE /catalogo/{id}` | Admin | `catalog.write` | 204 · 404 |
| `GET /pedidos` | Admin, Operador, Cliente | `orders.read` | 200 (Cliente: solo los suyos) |
| `GET /pedidos/{id}` | Admin, Operador, Cliente | `orders.read` | 200 · 403 (pedido ajeno) · 404 |
| `POST /pedidos` | Cliente, Operador | `orders.write` | 201 · 400 · 409 (sin stock) |
| `PUT /pedidos/{id}/estado` | Admin, Operador | `orders.write` | 200 · 400 · 404 · 409 (transición inválida) |

Errores: `{ "error": "CODIGO", "message": "...", "details": ... }`. Las validaciones de rol y scope se
repiten en Lambda aunque el JWT Authorizer ya validó el token.

## Reglas de negocio (decisiones tomadas)

- **Crear pedido:** `clienteId`/`clienteNombre` salen del JWT (`oid`/`name`), nunca del body. Precios y total
  se calculan en el backend. Las líneas repetidas del mismo producto se suman.
- **Sin sobreventa:** el descuento de stock y el guardado del pedido ocurren en **una sola transacción**
  con la condición `stock >= cantidad`. Si algo falla, no se descuenta nada.
- **Cancelar devuelve el stock**, en la misma transacción que cambia el estado. Solo se repone stock de
  productos que aún existen en el catálogo.
- **Flujo de estados** (igual al del front): `CREADO → ACEPTADO → EN_PREPARACION → DESPACHADO → ENTREGADO`;
  `CANCELADO` se permite desde `CREADO`, `ACEPTADO` y `EN_PREPARACION`. Cualquier otro cambio devuelve 409.
- **Quién crea pedidos:** Cliente y Operador (el front ya le muestra el formulario al Operador). Admin no.
- **Quién cambia estados:** Admin y Operador. El Cliente no puede cancelar sus propios pedidos (igual que en el front).
  Si quieres permitirlo, es un cambio pequeño en `cambiarEstado` (`src/pedidos/index.js`).

## Frontend

No hay cambios de código imprescindibles: el contrato coincide con `src/api/*.ts`. Solo hay que actualizar el `.env`
del front (Client ID, Tenant ID, scopes y `VITE_API_BASE_URL`) con los valores de tu propia cuenta.

Mejoras opcionales para más adelante (no bloquean nada):
- `Comprar.tsx` muestra stock fijo (lista hardcodeada); el backend igual rechaza con 409 si no alcanza.
- README/comentarios del front aún mencionan Python.
