// Utilidades HTTP para API Gateway HTTP API (payload format 2.0).
// CORS NO se maneja aquí: lo responde API Gateway (ver docs/GUIA-ENTRA-APIGATEWAY.md).

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, 'BAD_REQUEST', message, details);
export const notFound = (message = 'Recurso no encontrado.') => new HttpError(404, 'NOT_FOUND', message);
export const conflict = (message, details) => new HttpError(409, 'CONFLICT', message, details);

export function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}

export const noContent = () => ({ statusCode: 204, headers: {} });

export function parseBody(event) {
  if (!event.body) throw badRequest('El cuerpo de la solicitud es obligatorio.');
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw badRequest('El cuerpo debe ser JSON válido.');
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw badRequest('El cuerpo debe ser un objeto JSON.');
  }
  return data;
}

function errorResponse(err) {
  if (err instanceof HttpError) {
    const body = { error: err.code, message: err.message };
    if (err.details !== undefined) body.details = err.details;
    return json(err.status, body);
  }
  // Nunca se registran tokens ni el evento completo, solo el error.
  console.error('Error no controlado:', err);
  return json(500, { error: 'INTERNAL_ERROR', message: 'Error interno del servidor.' });
}

function requestPath(event) {
  let path = event.rawPath ?? event.path ?? '/';
  const stage = event.requestContext?.stage;
  // Con un stage con nombre (distinto de $default) rawPath incluye el prefijo.
  if (stage && stage !== '$default' && path.startsWith(`/${stage}/`)) {
    path = path.slice(stage.length + 1);
  }
  return path;
}

/**
 * Crea el handler de una Lambda a partir de una tabla de rutas:
 *   [['GET', '/catalogo/{id}', async ({ event, params }) => respuesta], ...]
 */
export function createHandler(routes) {
  const compiled = routes.map(([method, pattern, fn]) => ({
    method,
    fn,
    regex: new RegExp(`^${pattern.replace(/\{(\w+)\}/g, '(?<$1>[^/]+)')}/?$`),
  }));

  return async (event) => {
    try {
      const method = (event.requestContext?.http?.method ?? event.httpMethod ?? '').toUpperCase();
      const path = requestPath(event);
      let pathMatched = false;

      for (const route of compiled) {
        const match = route.regex.exec(path);
        if (!match) continue;
        pathMatched = true;
        if (route.method !== method) continue;

        const params = {};
        for (const [key, value] of Object.entries(match.groups ?? {})) {
          try {
            params[key] = decodeURIComponent(value);
          } catch {
            throw badRequest('La URL contiene caracteres inválidos.');
          }
        }
        return await route.fn({ event, params });
      }

      if (pathMatched) throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Método no permitido.');
      throw notFound('Ruta no encontrada.');
    } catch (err) {
      return errorResponse(err);
    }
  };
}
