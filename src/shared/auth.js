// Autorización dentro de Lambda.
// API Gateway (JWT Authorizer) ya validó firma, issuer, audience y expiración.
// Aquí se REAUTORIZA por rol y scope en cada operación (defensa en profundidad).
import { HttpError } from './http.js';

// El JWT Authorizer de HTTP API entrega los claims como strings. Los claims de tipo
// arreglo (p. ej. roles) llegan como "[Admin Operador]"; scp llega como "a b c".
function parseList(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return [];
  return value
    .replace(/^\[|\]$/g, '')
    .split(/[\s,]+/)
    .map((item) => item.replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

export function getIdentity(event) {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  if (!claims || !claims.sub) {
    throw new HttpError(401, 'UNAUTHORIZED', 'Token ausente o inválido.');
  }
  const id = String(claims.oid ?? claims.sub); // oid = identificador estable del usuario en Entra
  return {
    id,
    name: String(claims.name ?? claims.preferred_username ?? claims.email ?? id),
    roles: parseList(claims.roles),
    scopes: parseList(claims.scp),
  };
}

/** Exige un scope y al menos uno de los roles indicados. Devuelve la identidad. */
export function authorize(event, { roles, scope }) {
  const identity = getIdentity(event);
  if (!identity.scopes.includes(scope)) {
    throw new HttpError(403, 'FORBIDDEN', `Falta el permiso ${scope}.`);
  }
  if (!identity.roles.some((role) => roles.includes(role))) {
    throw new HttpError(403, 'FORBIDDEN', 'Tu rol no permite esta operación.');
  }
  return identity;
}
