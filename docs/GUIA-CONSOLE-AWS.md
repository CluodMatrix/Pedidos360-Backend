# Guía: ver y probar todo desde la consola de AWS

Ruta clic por clic para revisar y demostrar la topología de mensajería (EP2) en la
consola de AWS. Todos los valores son los **reales de tu cuenta**.

| | |
|---|---|
| Cuenta | `142780656952` |
| Región | **us-east-1** (todo debe estar aquí) |
| Topic SNS | `pedidos360-eventos` — `arn:aws:sns:us-east-1:142780656952:pedidos360-eventos` |
| API Gateway | `pedidos360-api` — https://0a01d31pn6.execute-api.us-east-1.amazonaws.com |

> **Regla de oro:** la región de la consola tiene que ser `us-east-1`. Si estás en otra,
> no ves nada y parece que no existe. El selector de región está arriba a la derecha.

---

## 1. SNS — el topic y sus 3 suscripciones

**Ruta:** [SNS → Topics](https://us-east-1.console.aws.amazon.com/sns/v3/home?region=us-east-1) → `pedidos360-eventos` → **Subscriptions**

Lo que tienes que ver (esto es la **captura 1** del checklist):

| Suscripción | Endpoint | Filter policy |
|---|---|---|
| `q-email` | `arn:aws:sqs:...:q-email` | *(vacía → recibe todos)* |
| `q-kitchen` | `arn:aws:sqs:...:q-kitchen` | `{"tipo_evento":["PedidoAceptado"]}` |
| `q-invoice` | `arn:aws:sqs:...:q-invoice` | `{"tipo_evento":[{"prefix":"PedidoDespachado"}]}` |
| `q-notificaciones` | `arn:aws:sqs:...:q-notificaciones` | *(vacía → recibe todos)* |

Las tres deben estar en **Confirmed** (no "Pending confirmation"). Para ver el filtro de
una: clic en la suscripción → **Subscription filter policy** (y **Raw message delivery**
en `true`).

**Qué mirar en "Topic details":** *Type* = Standard, *Subscriptions* = 3.

---

## 2. SQS — las 6 colas

**Ruta:** [SQS → Queues](https://us-east-1.console.aws.amazon.com/sqs/v2/home?region=us-east-1)

Te van a aparecer 6 (más las de otros labs). Las tuyas:

```
q-email      q-kitchen     q-invoice     q-notificaciones
q-email-dlq  q-kitchen-dlq q-invoice-dlq q-notificaciones-dlq
```

Para cada cola principal, clic en ella y mira la pestaña **Dead-letter queue**:
debe decir `q-<misma>-dlq` con *Maximum receives* = **3** (**captura 2**).

Y en **Queue settings**:
- *Visibility timeout* = **30 segundos**
- *Redrive policy* → `q-<misma>-dlq`, `maxReceiveCount: 3`

### Ver el mensaje fallido en la DLQ (captura 3)

`q-kitchen-dlq` → **Send and receive messages** → *Poll for messages* → te aparece:

```json
{"type":"PedidoAceptado","eventId":"afe0b489-...","timestamp":"2026-10-20T21:11:16.988Z","pedidoId":"P-ERR","simularError":true}
```

Ahí están los 2 mensajes de la Prueba 2 (los dejó `npm run probar`). **No los borres
antes de la entrega.**

> Ojo: si abres "Poll for messages" y pulsas **"Change message visibility"** con 0, el
> mensaje sigue visible; con 30 s desaparece un rato. Para la captura déjalo como está.

---

## 3. CloudWatch — la prueba de que todo funciona

**Ruta:** [CloudWatch → Logs → Log groups](https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#logsV2:log-groups)

Tus 6 log groups:

```
/aws/lambda/pedidos360-publicar-evento
/aws/lambda/notificar-email
/aws/lambda/ticket-cocina
/aws/lambda/generar-boleta
/aws/lambda/notificar-frontend
/aws/lambda/pedidos360-pedidos
/aws/lambda/pedidos360-catalogo
```

Abre **`/aws/lambda/ticket-cocina`** → el log stream más reciente (**captura 4**) y verás
las 3 cosas que importan:

```
[2026-10-20T21:31:21.571Z] INFO  [cocina] Ticket de cocina impreso para el pedido DA506979 (1 x Teclado Mecánico Compacto) - intento 1.
[2026-10-20T21:29:32.xxxZ] WARN  [cocina] Recuperable -> reintento (messageId=..., intento 1): Error simulado: ...
[2026-10-20T21:30:02.xxxZ] WARN  [cocina] Recuperable -> reintento (messageId=..., intento 2): Error simulado: ...
[2026-10-20T21:30:32.xxxZ] WARN  [cocina] Recuperable -> reintento (messageId=..., intento 3): Error simulado: ...
```

La primera línea = ACK. Las tres siguientes = los **3 reintentos** hasta la DLQ.

**Truco para la oral:** abre los 3 log groups a la vez en pestañas distintas y enseña
cómo un mismo evento llega a unos sí y a otros no.

---

## 4. Probar desde la consola (sin tocar nada del código)

### Prueba A — publicar un evento y ver el fan-out

**Ruta:** [Lambda](https://us-east-1.console.aws.amazon.com/lambda/home?region=us-east-1) →
`pedidos360-publicar-evento` → **Test**

Pega esto y dale a **Test**:

```json
{ "pedidoId": "P-DEMO-1", "tipoEvento": "PedidoAceptado" }
```

Debería responder `202` con un `publicado` (un UUID). En ~5 segundos:

- `/aws/lambda/notificar-email` → *"Email enviado para el pedido P-DEMO-1"*
- `/aws/lambda/ticket-cocina` → *"Ticket de cocina impreso para el pedido P-DEMO-1"*
- `/aws/lambda/generar-boleta` → **nada** (su filtro solo deja pasar `PedidoDespachado`)

Cambia `"tipoEvento": "PedidoDespachado"` → ahora sí aparece en `generar-boleta`.

### Prueba B — mandar un mensaje a la DLQ

Mismo Lambda → **Test**:

```json
{ "pedidoId": "P-ERR-2", "tipoEvento": "PedidoAceptado", "simularError": true }
```

- `notificar-email` y `ticket-cocina` lo reciben y **fallan a propósito**.
- En sus logs verás *"Recuperable -> reintento ... intento 1 / 2 / 3"*, separados ~30 s.
- A los ~90 s el mensaje aparece en `q-email-dlq` y en `q-kitchen-dlq`.
- **El email y la cocina fallan, la boleta no se entera**: los fallos están aislados. Eso es
  la mitad de la nota de la EP2.

### Prueba C — la app real (la mejor para la defensa)

1. `npm run dev` en el frontend → http://localhost:5173
2. Entra como **Cliente** → **Comprar** → agrega un producto → **Confirmar pedido**
3. Entra como **Operador** (cambia de cuenta en el menú lateral) → **Pedidos** →
   **Aceptar** → **Preparar** → **Despachar**
4. Mira los 3 log groups: verás el pedido pasando por email → email+cocina → email+boleta

Es la misma tabla de la Prueba 1 pero generada por la aplicación con tokens reales de
Entra ID.

---

## 5. Las 4 capturas del checklist

| # | Qué | Dónde | Qué tiene que verse |
|---|---|---|---|
| 1 | Diagrama de suscripciones del topic | SNS → `pedidos360-eventos` → Subscriptions | Las 3 suscripciones, sus endpoints y sus filter policies |
| 2 | Las 3 colas | SQS → `q-email` / `q-kitchen` / `q-invoice` → pestaña *Dead-letter queue* | La DLQ asociada y *Maximum receives* = 3 |
| 3 | El mensaje en la DLQ | SQS → `q-kitchen-dlq` → Send and receive messages → Poll for messages | El JSON del mensaje fallido |
| 4 | Los logs | CloudWatch → Logs → `/aws/lambda/ticket-cocina` | El "Ticket de cocina impreso" y los 3 reintentos |

---

## 6. Ver la configuración de las Lambdas y sus triggers

**Ruta:** Lambda → `notificar-email` → **Triggers**. Ahí debe verse:

- Event source mapping: **`q-email`**, estado **Enabled**
- *Batch size* = **1**
- *"Report batch item failures"* = **Enabled** ← **imprescindible**: sin esto los
  mensajes fallidos se confirmarían y no habría reintento ni DLQ
- *Maximum concurrency* = 10

Y en **Configuration → Environment variables**:

```
TABLE_EVENTOS_PROCESADOS = Pedidos360-EventosProcesados
DLQ_EMAIL_URL             = https://sqs.us-east-1.amazonaws.com/142780656952/q-email-dlq
QUEUE_EMAIL_URL           = https://sqs.us-east-1.amazonaws.com/142780656952/q-email
```

Repite en `ticket-cocina` (KITCHEN) y `generar-boleta` (INVOICE). En
`pedidos360-publicar-evento` y `pedidos360-pedidos` debe estar `TOPIC_ARN`.

---

## 7. Comprobación automática (para antes de entrar)

```bash
cd "D:\git\cloud v2\Pedidos360-Backend"
npm run messaging:check   # verifica toda la configuración, no crea nada
npm run probar            # ejecuta las 2 pruebas de la guía y lee CloudWatch
```

`messaging:check` imprime `[ok]` / `[FALLA]` por cada punto de la rúbrica. Si todo dice
`[ok]`, lo que vas a enseñar en la consola está bien.

---

## 8. Preguntas del profe y dónde está la respuesta

| Pregunta | Dónde lo enseñas |
|---|---|
| ¿Qué es el broker? | SNS (publica) + SQS (guarda) — los 2 servicios juntos |
| ¿Fan-out? | SNS → Subscriptions: 3 colas Suscritas al mismo topic |
| ¿Cómo se filtran? | La filter policy de cada suscripción (pestaña *Subscription filter policy*) |
| ¿Qué es el ACK? | El log: Lambda termina bien → SQS borra el mensaje (no aparece en la cola) |
| ¿Visibility timeout? | SQS → cola → Queue settings → 30 s; y Lambda → Timeout = 5 s |
| ¿DLQ? | La pestaña *Dead-letter queue* + el mensaje real en `q-kitchen-dlq` |
| ¿Idempotencia? | DynamoDB → `Pedidos360-EventosProcesados` (clave `eventId` + `consumidor`) |
| ¿Dónde se configura? | `src/shared/config.js` — un solo lugar |

---

## 9. Problemas frecuentes en la consola

| Síntoma | Causa |
|---|---|
| No aparece nada | estás en otra región → cambia a **us-east-1** |
| La cola está vacía pero el log dice que se procesó | normal: el mensaje se borró al hacer ACK |
| El log no tiene nada | el trigger acaba de crearse; espera ~1 min |
| La suscripción está "Pending confirmation" | re-ejecuta `npm run messaging` (la resuscribe) |
| No llega a `q-kitchen` | el `tipo_evento` del mensaje no es `PedidoAceptado` (mira mayúsculas) |
| La API devuelve **500 `Internal Server Error`** y el log de la Lambda está vacío | Es `API_CONFIGURATION_ERROR`: a la Lambda le falta el permiso de invocación para esa ruta. Se arregla con `npm run deploy` (el script lo concede solo) o en **Lambda → la función → Permissions → Add permissions** → *AWS service* = API Gateway |
