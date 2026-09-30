# Guía corta: Entra ID + API Gateway

Orden recomendado: (1) Entra ID → (2) API Gateway → (3) probar → (4) actualizar el `.env` del front.
Las Lambdas y tablas ya deben estar desplegadas (`npm run tables`, `npm run seed`, `npm run deploy`).

## 1. Microsoft Entra ID

Portal: <https://entra.microsoft.com> → **Identity → Applications → App registrations**.

> **Azure for Students:** normalmente estás en el tenant de tu universidad y puede que no tengas permiso para
> registrar apps ni dar consentimiento. Si te bloquea, crea tu propio tenant gratuito (*Entra ID → Manage tenants → Create*)
> y haz todo ahí.

### 1.1 App `Pedidos360-API` (el recurso protegido)

1. **New registration** → nombre `Pedidos360-API` → *Single tenant* → Register. Anota el **Application (client) ID**
   y el **Directory (tenant) ID**.
2. **Expose an API** → *Application ID URI* → Set (deja el valor por defecto `api://<client-id>`).
3. En la misma pantalla, **Add a scope** cuatro veces: `catalog.read`, `catalog.write`, `orders.read`, `orders.write`
   (*Who can consent*: **Admins and users**; *State*: Enabled; los textos de consentimiento pueden ser cualquier frase).
4. **App roles → Create app role** tres veces: *Display name* y **Value** = `Admin`, `Operador`, `Cliente`;
   *Allowed member types*: **Users/Groups**; Enabled.
5. **Manifest** → busca `requestedAccessTokenVersion` (en el manifest antiguo se llama `accessTokenAcceptedVersion`)
   y ponlo en **`2`** → Save. *Sin esto los tokens salen en formato v1 y API Gateway los rechaza con 401.*

### 1.2 App `Pedidos360-Frontend` (la SPA)

1. **New registration** → `Pedidos360-Frontend` → *Single tenant*. En *Redirect URI* elige **Single-page application (SPA)**
   e ingresa `http://localhost:5173`. Anota su **client ID**.
2. **API permissions → Add a permission → My APIs → Pedidos360-API → Delegated permissions** → marca los 4 scopes → Add.
3. Pulsa **Grant admin consent for <tenant>** (si tu cuenta no puede, cada usuario verá una pantalla de consentimiento al iniciar sesión).

### 1.3 Asignar roles a los usuarios

**Enterprise applications → Pedidos360-API → Users and groups → Add user/group** → elige el usuario y el rol.
Crea al menos tres usuarios de prueba (uno por rol) en *Users → New user*. Asigna a **usuarios**, no a grupos
(los grupos requieren licencia P1).

Un usuario sin rol asignado entra a la app pero verá "Acceso restringido" y el backend responde 403.
Si cambias un rol, cierra sesión y vuelve a entrar para obtener un token nuevo.

## 2. API Gateway (HTTP API)

Consola AWS → **API Gateway → Create API → HTTP API → Build**.

1. **Integraciones:** agrega dos integraciones *Lambda*: `pedidos360-catalogo` y `pedidos360-pedidos` (región `us-east-1`,
   payload 2.0). Nombre de la API: `pedidos360-api`.
2. **Rutas** (una por fila; el asistente crea el permiso de invocación automáticamente):

   | Ruta | Integración |
   |---|---|
   | `GET /catalogo` · `POST /catalogo` | pedidos360-catalogo |
   | `GET /catalogo/{id}` · `PUT /catalogo/{id}` · `DELETE /catalogo/{id}` | pedidos360-catalogo |
   | `GET /pedidos` · `POST /pedidos` | pedidos360-pedidos |
   | `GET /pedidos/{id}` · `PUT /pedidos/{id}/estado` | pedidos360-pedidos |

   No agregues rutas `OPTIONS` ni `$default`: el preflight de CORS lo responde API Gateway.
3. **Stage:** `$default` con *auto-deploy* activado.
4. **Authorization → Manage authorizers → Create:**
   - Type: **JWT** · Name: `entra-jwt` · Identity source: `$request.header.Authorization`
   - Issuer URL: `https://login.microsoftonline.com/<TENANT_ID>/v2.0`
   - Audience: `<CLIENT_ID de Pedidos360-API>` (el GUID solo, **sin** `api://`)

   Luego, en la pestaña **Attach authorizers to routes**, adjunta `entra-jwt` a **las 9 rutas**.
5. **CORS → Configure:**
   - Access-Control-Allow-Origin: `http://localhost:5173`
   - Allow-Methods: `GET, POST, PUT, DELETE, OPTIONS`
   - Allow-Headers: `authorization, content-type`
   - Deja *Allow-Credentials* desactivado (se usa Bearer, no cookies).
6. Copia la **Invoke URL** (`https://xxxx.execute-api.us-east-1.amazonaws.com`).

## 3. Probar

Actualiza el `.env` del front:

```dotenv
VITE_AZURE_CLIENT_ID=<client id de Pedidos360-Frontend>
VITE_AZURE_TENANT_ID=<tenant id>
VITE_AZURE_REDIRECT_URI=http://localhost:5173
VITE_API_BASE_URL=<Invoke URL, sin "/" final>
VITE_API_SCOPE=api://<client id API>/catalog.read api://<client id API>/catalog.write api://<client id API>/orders.read api://<client id API>/orders.write
```

Luego `npm run dev` en el front, entra como Admin y abre `/admin`. El *Token Inspector* (solo en desarrollo) permite
comprobar `aud`, `iss`, `scp` y `roles`. Prueba por línea de comandos con el token copiado de ahí:

```bash
curl -i https://<invoke-url>/catalogo                                   # 401 (sin token)
curl -i -H "Authorization: Bearer $TOKEN" https://<invoke-url>/catalogo # 200 (Admin/Operador) · 403 (Cliente)
```

## Si algo falla

| Síntoma | Causa probable |
|---|---|
| 401 con token válido | `iss` distinto al Issuer configurado (token v1: revisa `requestedAccessTokenVersion = 2`), Audience con `api://`, o token expirado |
| 403 `Tu rol no permite…` | El usuario no tiene el App Role asignado, o el token es anterior a la asignación (cerrar sesión y volver a entrar) |
| 403 `Falta el permiso…` | El scope no fue solicitado/consentido (revisa `VITE_API_SCOPE` y el *admin consent*) |
| `AADSTS65001` al iniciar sesión | Falta el consentimiento de los permisos delegados (paso 1.2.3) |
| Error CORS en el navegador | Origen distinto de `http://localhost:5173` (sin `/` final) o falta `authorization` en Allow-Headers; revisa la pestaña Network para ver el código real |
| 500 | Revisa los logs en CloudWatch → grupo `/aws/lambda/pedidos360-catalogo` o `…-pedidos` |
