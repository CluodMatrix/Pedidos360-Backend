# Guía: Mensajería asíncrona con SNS, SQS y Lambda (EP2)

Cómo queda la topología de mensajería de Pedidos360 y cómo desplegarla.
Complementa a `GUIA-ENTRA-APIGATEWAY.md` (esa es la parte de Entra ID + API Gateway).

---

## 1. El problema y cómo lo resolvemos

**EL PROBLEMA.** Cuando un cliente crea un pedido, el sistema debería además enviar un
correo, imprimir el ticket de cocina y generar la boleta. Si todo ocurre dentro de la
misma petición, un fallo en el correo hace fallar el pedido, y en hora punta todo se
vuelve lento.

**LA SOLUCIÓN.** La Lambda que crea el pedido guarda el pedido y publica un evento en un
SNS Topic. El topic copia el evento a tres colas SQS (`q-email`, `q-kitchen`,
`q-invoice`) y cada cola alimenta a su propia Lambda. Lo que falla repetidamente va a
una DLQ.

**POR QUÉ.** Se desacoplan los componentes y se absorben cargas variables. Cada consumidor
trabaja a su ritmo y sus fallas no afectan a los demás.

### Equivalencias con RabbitMQ (para la evaluación)

| Concepto | RabbitMQ | AWS |
|---|---|---|
| Recibe del productor | Exchange | **SNS Topic** |
| Almacena mensajes | Queue | **SQS Queue** |
| Unión exchange → cola | Binding / routing key | **Suscripción + filter policy** |
| Confirmación | ACK / NACK | **Lambda OK = mensaje borrado** |
| Mensajes fallidos | DLQ + DLX | **DLQ + redrive policy** |

## 2. Arquitectura final

```
 Cliente ──POST /pedidos──▶ API Gateway ──▶ Lambda pedidos360-pedidos
                                                ├─▶ DynamoDB (TransactWrite, sin sobreventa)
                                                └─▶ SNS  pedidos360-eventos          [1]
                                                        │
                        ┌───────────────────────────────┼───────────────────────────┐
                        ▼                               ▼                           ▼
                 q-email  (sin filtro)        q-kitchen  (exacto)         q-invoice  (prefijo)
                 recibe TODOS                 solo PedidoAceptado        solo PedidoDespachado
                        │                               │                           │
                        ▼                               ▼                           ▼
                notificar-email                 ticket-cocina               generar-boleta
                        │                               │                           │
                        ▼                               ▼                           ▼
                q-email-dlq                   q-kitchen-dlq                q-invoice-dlq
```

Los números del diagrama muestran el recorrido de un pedido: **1** el cliente llama a la
API, **2** se guarda en DynamoDB, **3** se publica en SNS, **4** el topic reparte a las
colas, **5** cada Lambda consume su cola.

## 3. Recursos que se crean

| Recurso | Nombre | Detalle |
|---|---|---|
| 3 colas DLQ | `q-email-dlq`, `q-kitchen-dlq`, `q-invoice-dlq` | SQS Standard |
| 3 colas principales | `q-email`, `q-kitchen`, `q-invoice` | SQS Standard, con DLQ y `maxReceiveCount = 3` |
| 1 cola de avisos | `q-notificaciones` (+ su DLQ) | SQS Standard, sin filtro: recibe todos los eventos |
| 1 SNS Topic | `pedidos360-eventos` | Standard |
| 3 Lambdas consumidoras | `notificar-email`, `ticket-cocina`, `generar-boleta` | Node.js 20, trigger SQS |
| 1 Lambda productora | `pedidos360-publicar-evento` | Node.js 20, publica en SNS |
| 1 Lambda consumidora | `notificar-frontend` | Node.js 20, trigger SQS, deja los eventos para la interfaz |
| 1 tabla | `Pedidos360-Notificaciones` | Eventos ya consumidos, para los avisos de la interfaz |

**Todos los nombres salen de `src/shared/config.js`.** No hay ni un nombre de cola ni un
ARN escrito dentro de un handler: es el indicador "Configuración centralizada" de la pauta.

## 4. Puesta en marcha

```bash
npm install
npm test                                   # 43 pruebas (19 del CRUD + 24 de mensajería)
npm run tables                             # crea también Pedidos360-EventosProcesados
npm run messaging                          # topic + 6 colas + 3 suscripciones
npm run deploy                             # despliega las 6 Lambdas y los triggers SQS
npm run messaging:check                    # VERIFICA que todo quedó bien (no crea nada)
```

`npm run messaging` es idempotente: si un recurso ya existe, lo actualiza en vez de fallar.
Para empezar de cero: `node scripts/create-messaging.js --reset`.

> **Antes de entregar, corre `npm run messaging:check`.** Revisa el topic, las 3
> suscripciones (confirmadas y con su filtro), las 6 colas (redrive policy, visibility
> timeout y permiso de SNS), las 6 Lambdas (variables de entorno y timeout) y los triggers
> SQS (**incluido que tengan "Report batch item failures"**). Imprime `[ok]` / `[FALLA]`
> por cada punto, así que te sirve de checklist para la oral.

### Qué hace cada script

| Script | Qué hace |
|---|---|
| `scripts/create-tables.js` | Crea `Pedidos360-Productos`, `Pedidos360-Pedidos` y `Pedidos360-EventosProcesados` (idempotencia de los consumidores). |
| `scripts/create-messaging.js` | Crea el topic, las 3 DLQ, las 3 colas con redrive policy, el permiso de SNS sobre cada cola y las 3 suscripciones con su filter policy. |
| `scripts/build.js` | Empaqueta los 6 módulos de `src/` en `dist/*/index.mjs`. |
| `scripts/deploy.js` | Crea/actualiza las 6 Lambdas, inyecta las variables de entorno y crea los event source mappings con `ReportBatchItemFailures`. |
| `scripts/check-messaging.js` | Solo verifica: no crea ni modifica nada. |

### Variables de entorno que inyecta el deploy

El deploy las resuelve solo (busca el topic y las colas por nombre). Se pueden forzar:

```bash
TOPIC_ARN=arn:aws:sns:us-east-1:<cuenta>:pedidos360-eventos
QUEUE_EMAIL_URL=...   DLQ_EMAIL_URL=...
QUEUE_KITCHEN_URL=... DLQ_KITCHEN_URL=...
QUEUE_INVOICE_URL=... DLQ_INVOICE_URL=...
TABLA_EVENTOS_PROCESADOS=Pedidos360-EventosProcesados
```

## 5. Filter policies: cómo decide cada cola

El productor publica con un **atributo de mensaje** `tipo_evento`. La filter policy de
cada suscripción decide si el evento entra a esa cola.

| Cola | Filtro | Policy | Recibe |
|---|---|---|---|
| `q-email` | sin filtro | — | todos los eventos (fanout) |
| `q-kitchen` | **exacto** | `{"tipo_evento": ["PedidoAceptado"]}` | solo `PedidoAceptado` |
| `q-invoice` | **prefijo** | `{"tipo_evento": [{"prefix": "PedidoDespachado"}]}` | solo lo que empieza por `PedidoDespachado` |

Están definidos en `FILTROS` (`src/shared/config.js`) y los aplica
`scripts/create-messaging.js`. En la consola, el *Scope* del filtro es **Message
attributes** (valor por defecto).

> **Si un evento no llega a una cola:** revisa que el productor mande `tipo_evento` como
> **Message Attribute** (no solo dentro del cuerpo), que las mayúsculas coincidan, y que
> la cola tenga permiso para `sns:SendMessage` desde el topic. El script ya lo resuelve.

## 6. Confirmación y errores (lo que más pesa en la pauta)

El consumidor vive en `src/shared/consumidor.js` y lo reutilizan las tres Lambdas. La
lógica de cada dominio (enviar el correo, imprimir el ticket, generar la boleta) está en
su propio archivo: `src/email/`, `src/cocina/`, `src/boleta/`.

| Situación | Qué hace el consumidor | Resultado en SQS |
|---|---|---|
| Todo va bien | No devuelve el mensaje en `batchItemFailures` | **ACK**: SQS borra el mensaje |
| Error **recuperable** (el servicio está caído) | Lo devuelve en `batchItemFailures` | **Reintento** tras el visibility timeout, hasta 3 veces |
| Error **no recuperable** (falta `pedidoId`, JSON roto) | Lo manda a la DLQ y lo registra en el log | **DLQ** y confirma el original (no reintenta) |

> **Requisito técnico:** el trigger SQS debe tener activada la opción **"Report batch item
> failures"**. Sin eso, la Lambda no puede devolver `batchItemFailures` y los mensajes
> fallidos se confirmarían igual: no habría reintentos ni DLQ.
> `scripts/deploy.js` lo activa con `FunctionResponseTypes: ['ReportBatchItemFailures']`.

### Idempotencia

SQS Standard entrega **al menos una vez**: el mismo mensaje puede llegar dos veces. Si el
consumidor no es idempotente, un cliente recibe dos correos.

El consumidor **reclama** el `eventId` en la tabla `Pedidos360-EventosProcesados` antes de
procesarlo (escritura condicional `attribute_not_exists`). Si el evento ya fue reclamado,
el duplicado se ignora y se confirma. Si el procesamiento falla de forma recuperable, el
reclamo se libera para que el reintento pueda volver a procesarlo.

### Visibility timeout

El visibility timeout de las colas es **30 s** y el timeout de las Lambdas consumidoras es
**5 s**. El primero debe ser mayor que el segundo (AWS sugiere 6 veces) para que un
mensaje no reaparezca mientras todavía se está procesando.

## 7. Probar la arquitectura

### Prueba 1 — fan-out y filtros

Publica tres eventos distintos y revisa qué Lambda reacciona a cada uno. Puedes usar la
Lambda `pedidos360-publicar-evento` con un evento de prueba directo (consola → Test):

```json
{ "pedidoId": "P-001", "tipoEvento": "PedidoCreado" }
{ "pedidoId": "P-002", "tipoEvento": "PedidoAceptado" }
{ "pedidoId": "P-003", "tipoEvento": "PedidoDespachado" }
```

| Evento | notificar-email | ticket-cocina | generar-boleta |
|---|---|---|---|
| PedidoCreado | ✅ | ❌ | ❌ |
| PedidoAceptado | ✅ | ✅ | ❌ |
| PedidoDespachado | ✅ | ❌ | ✅ |

*Resultado esperado: email recibe los tres; cocina solo PedidoAceptado; boleta solo
PedidoDespachado.*

En los logs (Lambda → Monitor → View CloudWatch logs) cada consumidor imprime qué
procesó y con qué número de intento.

### Prueba 2 — reintentos y DLQ

Publica un mensaje con `simularError` en `true` para que la Lambda falle a propósito:

```json
{ "pedidoId": "P-ERR", "tipoEvento": "PedidoAceptado", "simularError": true }
```

1. En los logs de `ticket-cocina` verás el error con "Intento n° 1", luego 2 y 3
   (separados ~30 s, el visibility timeout).
2. Tras 3 intentos, SQS → `q-kitchen-dlq` → *Send and receive messages* → el mensaje
   fallido está ahí.
3. `q-email` recibió el mismo evento y lo procesó sin problema: **la falla de cocina no
   afectó al correo** (fallas aisladas).

### Prueba 3 — error no recuperable (sección 9 de la guía)

Publica un evento **sin** `pedidoId`:

```json
{ "tipoEvento": "PedidoAceptado" }
```

Va directo a la DLQ **sin reintentos**, porque ningún reintento puede arreglar un mensaje
sin identificador de pedido.

### Prueba 4 — recuperar el mensaje (opcional)

En `q-kitchen-dlq` → *Start DLQ redrive* para devolver el mensaje a la cola de origen
una vez corregida la causa del error.

### Alternativa: eventos desde la app real

La Lambda `pedidos360-pedidos` ya publica eventos al crear un pedido y al cambiar su
estado:

| Acción en la app | Evento publicado | Llega a |
|---|---|---|
| `POST /pedidos` | `PedidoCreado` | `q-email`, `q-notificaciones` |
| Estado → `ACEPTADO` | `PedidoAceptado` | `q-email`, `q-kitchen`, `q-notificaciones` |
| Estado → `EN_PREPARACION` | `PedidoEnPreparacion` | `q-email`, `q-notificaciones` |
| Estado → `DESPACHADO` | `PedidoDespachado` | `q-email`, `q-invoice`, `q-notificaciones` |
| Estado → `CANCELADO` | `PedidoCancelado` | `q-email`, `q-notificaciones` |

Esto es más útil que la prueba manual: cualquier pedido real del panel de Operador
recorre la topología completa.

**Comprobado en la cuenta real** con los tres usuarios de prueba (Cliente, Operador,
Admin) iniciando sesión en Microsoft Entra ID: el Cliente crea el pedido y el Operador
lo va moviendo de estado. Resultado en CloudWatch para un mismo pedido:

```
notificar-email : PedidoCreado, PedidoAceptado, PedidoEnPreparacion, PedidoDespachado
ticket-cocina    : PedidoAceptado
generar-boleta  : PedidoDespachado
```

Es exactamente la tabla de la Prueba 1, pero generada por la aplicación real.

### Scripts de comprobación

| Comando | Qué hace |
|---|---|
| `npm run messaging:check` | Verifica la configuración de AWS (topic, suscripciones, colas, Lambdas, triggers). No crea nada. |
| `npm run probar` | Ejecuta la Prueba 1 y la Prueba 2 de esta guía de forma automática: publica los eventos, lee los logs de CloudWatch y comprueba que el mensaje fallido llega a la DLQ. |
| `npm run probar:integracion` | Crea un pedido invocando la Lambda de pedidos con un evento de API Gateway simulado y comprueba que su evento llega a la consumidora. |

```bash
npm run messaging:check   # antes de entregar
npm run probar            # evidencia de la demo
```

> **Nota:** en este tenant los "flujos de cliente público" de Entra están
> deshabilitados, así que el grant *password* (ROPC) y el *device code* no funcionan
> para pedir tokens. El login interactivo (Authorization Code + PKCE), que es el que
> usa la SPA, sí funciona con normalidad.

## 8. Ruta `POST /eventos` en API Gateway

**Ya está creada** en la API `pedidos360-api` (integración `AWS_PROXY` →
`pedidos360-publicar-evento`, con el authorizer `entra-jwt` adjunto). Se puede
invocar con un token válido:

```bash
curl -i -X POST https://<invoke-url>/eventos \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"pedidoId":"P-001","tipoEvento":"PedidoCreado"}'
```

Si prefieres crearla a mano en la consola (o en otra cuenta):

1. API Gateway → tu HTTP API → **Integrations** → Create integration → Lambda
   `pedidos360-publicar-evento`.
2. **Routes** → Create route: `POST /eventos` → esa integración.
3. En *Attach authorizers to routes*, adjunta `entra-jwt` a la ruta nueva (si no, la ruta
   queda sin protección).
4. CORS: la API ya tiene el CORS configurado a nivel de API, así que la ruta nueva lo hereda.

> API Gateway se configura a mano en este proyecto (ver `GUIA-ENTRA-APIGATEWAY.md`), por
> eso esta ruta no la crea ningún script.

## 9. Preguntas de reflexión (para entregar)

1. ¿Qué ocurriría con el pedido si el envío de correo se hiciera de forma síncrona y el
   servicio de correo estuviera caído? ¿Y con esta arquitectura?
2. ¿Qué elemento de RabbitMQ equivale al SNS Topic? ¿Y a la filter policy? ¿Y a la DLQ?
3. ¿Qué es el visibility timeout y por qué debe ser mayor que el timeout de la Lambda?
4. ¿Por qué conviene una DLQ por cada cola y no una sola compartida?
5. ¿Por qué SNS no basta por sí solo y se agregan colas SQS detrás de cada suscripción?
6. **Plus EDA:** ¿`PedidoAceptado` es un evento o un comando? Justifica. ¿Cuál sería un
   comando en este sistema?

**Respuestas breves:**

1. Síncrono: el pedido falla y el cliente pierde la operación aunque el correo no tenga
   nada que ver con el pedido. Con la topología asíncrona: el pedido se guarda y devuelve
   201 igual; el correo falla solo, se reintenta hasta 3 veces y, si sigue fallando, queda
   en su DLQ sin bloquear nada.
2. El SNS Topic equivale al exchange; la filter policy, al binding/routing key; la DLQ, a
   la dead letter queue (con DLX en RabbitMQ).
3. Es el tiempo que un mensaje permanece invisible mientras lo procesa un consumidor.
   Debe ser mayor que el timeout de la Lambda para que el mensaje no reaparezca en la cola
   mientras todavía se está trabajando.
4. Porque cada flujo puede fallar por motivos distintos: así se sabe **qué** proceso está
   fallando y se puede reprocesar solo ese. Con una DLQ compartida no se puede.
5. SNS reparte pero **no almacena**: si el consumidor está caído, el mensaje se descarta
   tras unos reintentos. La cola SQS detrás es la que guarda, reintenta y aplica la
   redrive policy a la DLQ.
6. `PedidoAceptado` es un **evento**: es un hecho que ya ocurrió ("el pedido fue
   aceptado") y puede interesar a varios consumidores (el email, la cocina, la
   auditoría). Un **comando** sería una orden a un destinatario concreto, por ejemplo
   `EnviarEmail` o `ImprimirTicket`: el tiempo verbal es imperativo y el receptor es uno
   solo (eso es exactamente una cola de trabajo: SQS, o `q.cmd.*` en RabbitMQ).

## 10. Problemas frecuentes

| Síntoma | Causa probable y solución |
|---|---|
| No llega nada a las colas | La cola no permite que el topic le escriba. `npm run messaging` lo resuelve (añade el permiso). Verifica también que topic, colas y Lambdas estén en la **misma región**. |
| Llega a `q-email` pero no a `q-kitchen` | La filter policy no coincide. Revisa mayúsculas (`PedidoAceptado`) y que el productor envíe `tipo_evento` como **Message Attribute**, no solo dentro del cuerpo. |
| El mensaje aparece varias veces | SQS Standard entrega "al menos una vez". Por eso los consumidores son idempotentes. También ocurre si el visibility timeout es menor que el timeout de la Lambda. |
| La Lambda no se dispara | Revisa que el trigger esté **Enabled** y que el rol (`LabRole`) permita leer de SQS. |
| El mensaje con error no llega a la DLQ | Espera ~90 s (3 intentos × 30 s). Revisa que la cola tenga la DLQ habilitada con *Maximum receives* = 3. |
| El consumidor no reintenta nada | El trigger no tiene activada la opción **"Report batch item failures"**. `npm run deploy` la activa. |
| No veo logs | Lambda → Monitor → View CloudWatch logs; elige el log stream más reciente. |
