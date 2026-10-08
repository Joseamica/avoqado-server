import { SHOPIFY_API_VERSION, SHOPIFY_TIMEOUT_MS } from './shopify.constants'
import { appCredentials } from './shopify.crypto'

export type ShopifyFailureCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'THROTTLED'
  | 'HTTP_5XX'
  | 'HTTP_4XX'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'BAD_RESPONSE'
  | 'GRAPHQL_ERROR'
export type ShopifyFailure = {
  ok: false
  code: ShopifyFailureCode
  retryable: boolean
  ambiguous: boolean
  message: string
  status?: number
}
export type ShopifyResult<T> = { ok: true; data: T } | ShopifyFailure

const MAX_MENSAJE = 300
/** Texto apto para `lastError` y logs: sin el token ni el secreto, y acotado. */
function corta(texto: string, secretos: string[]): string {
  return secretos.reduce((t, s) => (s ? t.split(s).join('***') : t), texto).slice(0, MAX_MENSAJE)
}
function falla(code: ShopifyFailureCode, retryable: boolean, ambiguous: boolean, message: string, status?: number): ShopifyFailure {
  return { ok: false, code, retryable, ambiguous, message, status }
}

// ponytail: el cupo vive en la memoria del proceso. Es un CONSEJO para no vaciar el balde de una tienda, no la verdad:
// Shopify decide y contesta THROTTLED, que el llamador reintenta. Vale porque el server corre en UNA instancia
// (.claude/rules/una-sola-instancia.md); con 2+ cada proceso ve sólo su parte del gasto ⇒ moverlo a Redis o a una columna
// de ShopifyStore. Crece con el número de tiendas conectadas, no con el tráfico.
type Cupo = { maximo: number; disponible: number; recarga: number; leidoEn: number }
const cupos = new Map<string, Cupo>()
const CUPO_MINIMO = 200

function anotarCupo(shop: string, t: unknown): void {
  const x = t as { maximumAvailable?: unknown; currentlyAvailable?: unknown; restoreRate?: unknown } | undefined
  if (typeof x?.maximumAvailable !== 'number' || typeof x.currentlyAvailable !== 'number' || typeof x.restoreRate !== 'number') return
  cupos.set(shop, { maximo: x.maximumAvailable, disponible: x.currentlyAvailable, recarga: x.restoreRate, leidoEn: Date.now() })
}

/** ¿Le queda a esta tienda al menos `minimum` puntos, contando lo que se ha recargado desde la última respuesta? */
export function shopifyThrottleOk(shop: string, minimum: number = CUPO_MINIMO): boolean {
  const c = cupos.get(shop)
  if (!c) return true
  return Math.min(c.maximo, c.disponible + (c.recarga * (Date.now() - c.leidoEn)) / 1000) >= minimum
}

/**
 * Una llamada a Shopify. `fetch`, la lectura del cuerpo, el parseo y `interpretar` van TODOS dentro del mismo `try`: una
 * respuesta que se corta a media lectura no deja a nadie colgado (#25). Lo que no se sabe si llegó es `ambiguous`.
 */
async function llamar<T>(
  url: string,
  payload: unknown,
  headers: Record<string, string>,
  secretos: string[],
  interpretar: (body: unknown) => ShopifyResult<T>,
  timeoutMs: number = SHOPIFY_TIMEOUT_MS,
): Promise<ShopifyResult<T>> {
  let leyendoCuerpo = false
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
      // El llamador puede acortarlo (lo que le queda de presupuesto a su fase, N17 de B), nunca alargarlo.
      signal: AbortSignal.timeout(Math.max(1, Math.min(SHOPIFY_TIMEOUT_MS, timeoutMs))),
    })
    if (res.status === 401) return falla('UNAUTHORIZED', false, false, 'Shopify contestó 401', 401)
    if (res.status === 403) return falla('FORBIDDEN', false, false, 'Shopify contestó 403', 403)
    if (res.status === 429) return falla('THROTTLED', true, false, 'Shopify contestó 429', 429)
    leyendoCuerpo = true
    const text = await res.text()
    if (res.status >= 500) return falla('HTTP_5XX', true, true, corta(text, secretos), res.status)
    if (res.status >= 400) return falla('HTTP_4XX', false, false, corta(text, secretos), res.status)
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return falla('BAD_RESPONSE', true, true, `JSON inválido: ${corta(text, secretos)}`, res.status)
    }
    return interpretar(body)
  } catch (err) {
    const nombre = (err as { name?: string } | null)?.name
    const msg = corta(String((err as Error | null)?.message ?? err), secretos)
    if (nombre === 'TimeoutError' || nombre === 'AbortError') return falla('TIMEOUT', true, true, msg)
    return leyendoCuerpo ? falla('BAD_RESPONSE', true, true, msg) : falla('NETWORK', true, true, msg)
  }
}

type CuerpoGraphql = {
  data?: unknown
  errors?: Array<{ message?: string; extensions?: { code?: string } } | null>
  extensions?: { cost?: { throttleStatus?: unknown } }
} | null

export async function shopifyGraphql<T>(
  shop: string,
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
  opts: { validate?: (data: unknown) => data is T; timeoutMs?: number } = {},
): Promise<ShopifyResult<T>> {
  return llamar<T>(
    `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    { query, variables },
    { 'X-Shopify-Access-Token': token },
    [token],
    raw => {
      const body = raw as CuerpoGraphql
      anotarCupo(shop, body?.extensions?.cost?.throttleStatus)
      if (Array.isArray(body?.errors) && body.errors.length > 0) {
        const texto = corta(JSON.stringify(body.errors), [token])
        const codigos = body.errors.map(e => e?.extensions?.code)
        // Falta un scope (N5): Shopify lo dice con 200 + ACCESS_DENIED. Reintentar no lo arregla; reconectar sí.
        if (codigos.includes('ACCESS_DENIED')) return falla('FORBIDDEN', false, false, texto)
        if (codigos.includes('THROTTLED')) return falla('THROTTLED', true, false, texto)
        return falla('GRAPHQL_ERROR', true, true, texto)
      }
      const data = body?.data
      if (data === undefined || data === null) return falla('BAD_RESPONSE', true, true, 'respuesta sin data')
      if (opts.validate && !opts.validate(data)) return falla('BAD_RESPONSE', true, true, 'la respuesta no tiene la forma esperada')
      return { ok: true, data: data as T }
    },
    opts.timeoutMs,
  )
}

/** Canjea el `code` del callback OAuth por un token offline. */
export async function exchangeOAuthCode(
  shop: string,
  appKey: 'PILOTO' | 'PUBLICA',
  code: string,
): Promise<ShopifyResult<{ accessToken: string; scope: string }>> {
  const creds = appCredentials(appKey)
  if (!creds) return falla('UNAUTHORIZED', false, false, `Faltan las llaves de la app de Shopify (${appKey})`)
  return llamar(
    `https://${shop}/admin/oauth/access_token`,
    { client_id: creds.clientId, client_secret: creds.clientSecret, code },
    {},
    [creds.clientSecret, code],
    raw => {
      const body = raw as { access_token?: unknown; scope?: unknown } | null
      if (typeof body?.access_token !== 'string') return falla('BAD_RESPONSE', true, true, 'el canje no trajo access_token')
      return { ok: true, data: { accessToken: body.access_token, scope: typeof body.scope === 'string' ? body.scope : '' } }
    },
  )
}
