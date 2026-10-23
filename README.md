# Pedidos360 Backend (Node.js + AWS Lambda + DynamoDB + SNS/SQS)

Migración a Node.js 22 del backend de Pedidos360. Serverless, sin VPC, sin capacidad
provisionada: pensado para AWS Academy (sin consumo relevante de créditos).

```
Navegador (localhost:5173) ──Bearer JWT──▶ API Gateway HTTP API (JWT Authorizer = Entra ID)
                                             ├─ /catalogo*  ─▶ Lambda pedidos360-catalogo ─▶ DynamoDB Productos
                                             └─ /pedidos*   ─▶ Lambda pedidos360-pedidos  ─▶ DynamoDB Pedidos + Productos
                                                                            │
                                                                            └─▶ SNS pedidos360-eventos
                                                                                 ├─▶ q-email   ─▶ notificar-email ─▶ q-email-dlq
                                                                                 ├─▶ q-kitchen ─▶ ticket-cocina    ─▶ q-kitchen-dlq
                                                                                 └─▶ q-invoice ─▶ generar-boleta   ─▶ q-invoice-dlq
```

## Estructura

```
src/
  catalogo/index.js    Lambda de catálogo (CRUD de productos)
  pedidos/index.js     Lambda de pedidos (crear, listar, cambiar estado) + publica eventos
  publicarevento/      Lambda productora: publica un evento en el SNS Topic
  email/               Lambda consumidora del dominio "correo"
  cocina/              Lambda consumidora del dominio "cocina"
  boleta/              Lambda consumidora del dominio "boleta"
  shared/              auth (roles/scopes), http (router, errores), dynamo (cliente),
                       config (configuración centralizada), sns, sqs, consumidor, idempotencia
scripts/              build · create-tables · seed · create-messaging · deploy  (Node, funcionan igual en Windows)
test/                 43 pruebas: 19 del CRUD con un DynamoDB falso + 24 de mensajería
docs/GUIA-ENTRA-APIGATEWAY.md
docs/GUIA-SNS-SQS.md
docs/GUIA-CONSOLE-AWS.md
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
   npm run tables      # crea Pedidos360-Productos, Pedidos360-Pedidos y Pedidos360-EventosProcesados (on-demand)
   npm run seed        # 6 productos demo (no pisa el stock si ya existen; --reset lo restablece)
   ```
4. **Mensajería asíncrona** (SNS + SQS):
   ```bash
   npm run messaging        # topic + 3 colas + 3 DLQ + 3 suscripciones con filter policy (idempotente)
   ```
5. **Desplegar las Lambdas** (reutiliza el rol `LabRole`; no crea roles IAM):
   ```bash
   npm run deploy      # build + crea/actualiza las 6 Lambdas y sus triggers SQS
   ```
6. **Entra ID y API Gateway:** sigue `docs/GUIA-ENTRA-APIGATEWAY.md`.
   **Mensajería:** sigue `docs/GUIA-SNS-SQS.md`.
   **Para ver y probar todo en la consola de AWS:** `docs/GUIA-CONSOLE-AWS.md`.

6. **Verificar que todo quedó bien** (no crea nada, solo comprueba):
   ```bash
   npm run messaging:check
   ```

Volver a ejecutar `npm run deploy` actualiza el código sin recrear nada.

Volver a ejecutar `npm run deploy` actualiza el código sin recrear nada.

## Tablas DynamoDB

| Tabla | Clave | Índices | Contenido |
|---|---|---|---|
| `Pedidos360-Productos` | `id` (S) | — | `nombre, descripcion, precio, stock, fechaCreacion, fechaActualizacion` |
| `Pedidos360-Pedidos` | `id` (S) | GSI `clienteId-fechaCreacion-index` (`clienteId` + `fechaCreacion`) | `clienteId, clienteNombre, estado, total, productos[{productoId,nombre,cantidad,precio}], fechas` |
| `Pedidos360-EventosProcesados` | `eventId` (S) | — | `consumidor, fechaReclamo` — idempotencia de los consumidores de SQS |

El GSI permite que un Cliente liste **sus** pedidos con `Query` en vez de `Scan`. Los pedidos
guardan una copia (nombre y precio) de cada producto: si el catálogo cambia después, el pedido no se altera.

## Mensajería asíncrona (SNS + SQS)

Detalle completo en [`docs/GUIA-SNS-SQS.md`](docs/GUIA-SNS-SQS.md).

| Recurso | Nombre |
|---|---|
| Topic SNS | `pedidos360-eventos` |
| Colas SQS | `q-email`, `q-kitchen`, `q-invoice` (+ sus DLQ `q-*-dlq`) |
| Lambdas consumidoras | `notificar-email`, `ticket-cocina`, `generar-boleta` |
| Lambda productora | `pedidos360-publicar-evento` |

- **Configuración centralizada** en `src/shared/config.js`: nombres, filter policies, timeouts
  y variables de entorno. Ningún handler lleva un nombre de cola ni un ARN escrito dentro.
- **Filter policies**: `q-email` sin filtro (recibe todo), `q-kitchen` exacta
  (`PedidoAceptado`), `q-invoice` por prefijo (`PedidoDespachado`).
- **Confirmación explícita**: el consumidor devuelve `batchItemFailures`. Un error
  recuperable se reintenta (3 veces, 30 s de visibility timeout); uno no recuperable va
  directo a la DLQ. Requiere **"Report batch item failures"** en el trigger SQS.
- **Idempotencia**: el consumidor reclama el `eventId` antes de procesar, así un mensaje
  redentregado no produce dos correos.


## Contrato de la API

| Método y ruta | Roles | Scope | Respuestas |
|---|---|---|---|
| `GET /catalogo` | Admin, Operador | `catalog.read` | 200 lista |
| `GET /catalogo/comprar` | Admin, Operador, Cliente | `catalog.read` | 200 lista (vista de escaparate: solo datos públicos y stock real) |
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

Ruta opcional (no la crea ningún script, hay que agregarla a mano en API Gateway):
`POST /eventos` invoca la Lambda productora `pedidos360-publicar-evento`. Ver
`docs/GUIA-SNS-SQS.md` §8.

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
- **Catálogo de gestión vs. de escaparate:** `GET /catalogo` (Admin/Operador) devuelve el catálogo completo.
  `GET /catalogo/comprar` (también Cliente) devuelve solo los datos públicos y el stock real, que es lo
  que usa la pantalla de compra. Así el Cliente ve lo que el Admin crea, sin acceso al catálogo de gestión.
- **Quién cambia estados:** Admin y Operador. El Cliente no puede cancelar sus propios pedidos (igual que en el front).
  Si quieres permitirlo, es un cambio pequeño en `cambiarEstado` (`src/pedidos/index.js`).
- **Publicación de eventos:** al guardar un pedido se publica `PedidoCreado` y al cambiar su estado
  se publica el evento correspondiente (`PedidoAceptado`, `PedidoDespachado`, ...). La publicación
  ocurre **después** de la transacción de DynamoDB: si falla, el pedido NO se cae (perder un correo
  es un incidente; perder un pedido cobrado es peor) y el error queda en el log. En producción lo
  correcto es un patrón *outbox*.

## Frontend

No hay cambios de código imprescindibles: el contrato coincide con `src/api/*.ts`. Solo hay que actualizar el `.env`
del front (Client ID, Tenant ID, scopes y `VITE_API_BASE_URL`) con los valores de tu propia cuenta.

Mejoras opcionales para más adelante (no bloquean nada):
- `Comprar.tsx` muestra stock fijo (lista hardcodeada); el backend igual rechaza con 409 si no alcanza.
- README/comentarios del front aún mencionan Python.
