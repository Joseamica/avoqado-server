// src/services/commerce-channels/shopify/shopify.llave-comercio.ts
/**
 * 5a, «la app es del comercio» (spec 2026-10-11 §2): la llave de 24 h de la app que el comercio creó en SU Dev Dashboard, con
 * `grant_type=client_credentials`. Puro: sin base de datos y con `fetch` inyectable. El cuerpo de Shopify sólo se lee para
 * clasificar: nunca va a un mensaje ni al log. Lo que no se reconoce (un 4xx sin `error` o con texto libre en él, un 200 sin llave) NO
 * se da por definitivo (ruling P1 y Codex C1): se reintenta y deja un `logger.error` con el status, para que se vea en Better Stack.
 *
 * Medido en vivo el 11-oct: pedirla otra vez antes de que venza devuelve la MISMA llave con el tiempo que le queda; una nueva sólo
 * sale al vencer. Por eso renovarla es barato y no necesita candado (spec §4).
 */
import logger from '@/config/logger'
import { SHOPIFY_TIMEOUT_MS } from './shopify.constants'
import { isValidShopDomain } from './shopify.crypto'

/** Cuánto antes de que venza se pide otra llave (el worker y el asistente de conexión). */
export const RENOVAR_ANTES_MS = 60_000

/** Lo que Shopify dice de unas llaves. Todo es definitivo salvo `TRANSITORIO` (408, 429, 5xx, red, tiempo, lo no reconocido). */
export type MotivoLlave =
  | 'SECRET_INVALIDO'
  | 'CLIENT_ID_INVALIDO'
  | 'APP_DE_OTRA_ORGANIZACION'
  | 'TIENDA_NO_EXISTE'
  | 'RECHAZADA'
  | 'TRANSITORIO'
export type LlaveDelComercio =
  | { ok: true; token: string; scope: string; expiresIn: number }
  | { ok: false; motivo: MotivoLlave; codigoShopify?: string }

const TRANSITORIO: LlaveDelComercio = { ok: false, motivo: 'TRANSITORIO' }
/** El código de Shopify sólo si tiene forma de código (`invalid_request`): nunca texto libre ni una palabra con mayúsculas. */
const codigo = (x: unknown): string | undefined => (typeof x === 'string' && /^[a-z0-9_]{1,60}$/.test(x) ? x : undefined)
/** Lo que no se reconoce se reintenta y queda en el log de errores SÓLO con el status y el código (nunca el cuerpo ni las llaves). */
function noReconocida(status: number, codigoShopify: string | undefined): LlaveDelComercio {
  logger.error(
    `[SHOPIFY] llave del comercio: Shopify contestó algo que no se reconoce (HTTP ${status}, código ${codigoShopify ?? 'ninguno'}); se reintenta`,
  )
  return TRANSITORIO
}

export async function pedirLlaveDelComercio(
  i: { shop: string; clientId: string; clientSecret: string },
  o: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<LlaveDelComercio> {
  // Un dominio que no es de Shopify nunca recibe el secret.
  if (!isValidShopDomain(i.shop)) return { ok: false, motivo: 'TIENDA_NO_EXISTE' }
  let status: number
  let texto: string
  try {
    const res = await (o.fetch ?? fetch)(`https://${i.shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: i.clientId, client_secret: i.clientSecret }).toString(),
      // El cuerpo lleva el secret: jamás se sigue una redirección (fetch lo reenviaría a otro host). Si redirige, lanza.
      redirect: 'error',
      signal: AbortSignal.timeout(Math.max(1, Math.min(SHOPIFY_TIMEOUT_MS, o.timeoutMs ?? SHOPIFY_TIMEOUT_MS))),
    })
    status = res.status
    texto = await res.text()
  } catch {
    return TRANSITORIO // red, tiempo o redirección: no se sabe nada de las llaves
  }
  if (status === 408 || status === 429 || status >= 500) return TRANSITORIO
  let cuerpo: Record<string, unknown> | null = null
  try {
    const leido: unknown = JSON.parse(texto)
    cuerpo = leido && typeof leido === 'object' ? (leido as Record<string, unknown>) : null
  } catch {
    cuerpo = null
  }
  if (status >= 200 && status < 300) {
    const token = cuerpo?.access_token
    const expiresIn = cuerpo?.expires_in
    if (typeof token !== 'string' || !token || typeof expiresIn !== 'number' || !(expiresIn > 0)) return noReconocida(status, undefined)
    return { ok: true, token, scope: typeof cuerpo?.scope === 'string' ? cuerpo.scope : '', expiresIn }
  }
  // Medido: `{"errors":"Not Found"}`. Un 404 con otro cuerpo (la página de un proxy) no dice nada de la tienda: abajo, se reintenta.
  if (status === 404 && cuerpo?.errors === 'Not Found') return { ok: false, motivo: 'TIENDA_NO_EXISTE' }
  // Documentado (sin medir): «Oauth error shop_not_permitted: Client credentials cannot be performed on this shop.»
  if (texto.includes('shop_not_permitted')) return { ok: false, motivo: 'APP_DE_OTRA_ORGANIZACION' }
  // Ruling P1 y Codex C1: sólo un 4xx cuyo `error` ES un código de Shopify es un rechazo de las llaves. Sin él, o con texto libre
  // («Temporary upstream failure» de un proxy), no se sabe nada de las llaves: se reintenta, nunca se revoca.
  const error = codigo(cuerpo?.error)
  if (!error) return noReconocida(status, undefined)
  if (error === 'application_cannot_be_found') return { ok: false, motivo: 'CLIENT_ID_INVALIDO' }
  if (error === 'invalid_request' && /client secret/i.test(String(cuerpo?.error_description ?? ''))) {
    return { ok: false, motivo: 'SECRET_INVALIDO' }
  }
  return { ok: false, motivo: 'RECHAZADA', codigoShopify: error }
}
