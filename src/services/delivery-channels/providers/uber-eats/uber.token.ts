/**
 * Token de aplicación de Uber (client_credentials) — spec paso 2, PRIMITIVA DE CACHÉ.
 *
 * [api 2026-08-17] `expires_in` = 2592000 s (30 días), entero, SEGUNDOS.
 * [doc] Uber limita a 100 tokens/hora y el 101º invalida el más viejo ⇒ nunca
 * pedir por request ni en paralelo: caché con single-flight y renovación
 * anticipada de 24 h.
 *
 * ALCANCE: este módulo NO habla HTTP — el caller inyecta `fetchToken` (quien lee
 * env y URLs). El adaptador real (`POST /oauth/v2/token`, par inseparable
 * sandbox-login↔test-api vs auth↔api) es del Plan 2.
 *
 * ⚠️ Caché por PROCESO y para UNAS credenciales: válido mientras producción sea
 * una sola instancia (`render.yaml`, regla `una-sola-instancia.md`). Antes de
 * habilitar PM2 cluster (`ecosystem.config.js` tiene `instances:'max'` dormido)
 * hay que promoverlo a caché compartido.
 *
 * Módulo PURO (no importa `@/config/env`: eso hace `process.exit` al cargarse y
 * mataría workers de Jest — regla del repo).
 */
export interface UberTokenDeps {
  fetchToken: () => Promise<{ access_token: string; expires_in: number }>
  now?: () => number
}

const RENEW_MARGIN_MS = 24 * 3600 * 1000

let cached: { token: string; expiresAtMs: number } | null = null
let inflight: Promise<string> | null = null
let generation = 0 // sube en cada reset: una petición vieja no puede cachear tras un reset

export function _resetUberTokenCacheForTests(): void {
  cached = null
  inflight = null
  generation++
}

export async function getUberAppToken(deps: UberTokenDeps): Promise<string> {
  const now = deps.now ?? Date.now
  if (cached && cached.expiresAtMs - now() > RENEW_MARGIN_MS) return cached.token
  if (inflight) return inflight

  const gen = generation
  const request = (async () => {
    const r = await deps.fetchToken()
    // Nunca cachear basura del proveedor: token vacío o expires_in inválido ⇒ error visible
    if (
      !r ||
      typeof r.access_token !== 'string' ||
      r.access_token.length === 0 ||
      !Number.isFinite(r.expires_in) ||
      r.expires_in <= 0
    ) {
      throw new Error('Respuesta de token de Uber inválida (access_token/expires_in)')
    }
    if (gen === generation) cached = { token: r.access_token, expiresAtMs: now() + r.expires_in * 1000 }
    return r.access_token
  })()

  inflight = request
  try {
    return await request
  } finally {
    // Solo limpiar SI seguimos siendo el dueño: un finally incondicional borraría
    // el inflight de una petición nueva tras un reset (bug hallado en auditoría)
    if (inflight === request) inflight = null
  }
}
