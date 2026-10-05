import crypto from 'crypto'
import { env } from '@/config/env'
import { ConnectionCtx } from '../../core/types'

/**
 * Cliente HTTP de TotalPass. Dos APIs con su propio `/partner/auth` (Booking y Check-in): un JWT por sucursal y host,
 * válido 24 h, sin refresh. Ninguna llave ni token sale en un mensaje: el núcleo guarda y loguea `message`.
 */

export type TotalPassHost = 'BOOKING' | 'CHECKIN'
export type HttpFailure = { ok: false; retryable: boolean; code: string; message: string; status?: number }
export type HttpResult = { ok: true; status: number; data: unknown } | HttpFailure

/**
 * Por llamada. publishSession puede encadenar hasta 4 (auth + baja INACTIVE + DELETE + alta): 4 × 20 s = 80 s, bajo el
 * lease de 2 min de la bandeja de salida (una re-autenticación por 401 es un caso aparte y raro).
 */
export const TOTALPASS_TIMEOUT_MS = 20_000
const TOKEN_TTL_MS = 23 * 3600e3 // TotalPass: 24 h; se renueva antes

const tokens = new Map<string, { token: string; until: number }>()
export const __resetTotalPassTokens = (): void => tokens.clear()

const baseUrl = (h: TotalPassHost): string =>
  (h === 'BOOKING' ? env.TOTALPASS_BOOKING_API_URL : env.TOTALPASS_CHECKIN_API_URL).replace(/\/+$/, '')

/** Conexión + host + huella corta de la llave: si el estudio pega una llave nueva, no se reusa el JWT de la vieja. */
const tokenKey = (ctx: ConnectionCtx, h: TotalPassHost): string =>
  `${ctx.id}:${baseUrl(h)}:${crypto
    .createHash('sha256')
    .update(ctx.credential ?? '')
    .digest('hex')
    .slice(0, 16)}`

/** Borra de un texto cualquier secreto conocido (llaves y token), por si el proveedor los devolviera. */
function scrub(msg: string, secrets: Array<string | null | undefined>): string {
  let out = msg
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('***')
  return out.slice(0, 500)
}

/** Un `fetch` que nunca cuelga la fila: timeout ⇒ TIMEOUT reintentable; red caída ⇒ NETWORK reintentable. */
export async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response | HttpFailure> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TOTALPASS_TIMEOUT_MS) })
  } catch (err: any) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return { ok: false, retryable: true, code: 'TIMEOUT', message: `TotalPass no respondió en ${TOTALPASS_TIMEOUT_MS / 1000} s` }
    }
    return { ok: false, retryable: true, code: 'NETWORK', message: `error de red con TotalPass (${String(err?.name ?? 'Error')})` }
  }
}

const isFailure = (r: Response | HttpFailure): r is HttpFailure => 'code' in r

export async function readBody(r: Response): Promise<{ text: string; data: unknown }> {
  let text = ''
  try {
    text = await r.text()
  } catch {
    return { text: '', data: null }
  }
  try {
    return { text, data: text ? JSON.parse(text) : null }
  } catch {
    return { text, data: text }
  }
}

/** 429 y 5xx se reintentan; 401 es llave rechazada; el resto de 4xx no mejora reintentando. */
function failureFor(status: number, text: string, secrets: Array<string | null | undefined>): HttpFailure {
  if (status === 401) return { ok: false, retryable: false, code: 'UNAUTHORIZED', message: 'TotalPass rechazó las llaves (401)', status }
  return {
    ok: false,
    retryable: status === 429 || status >= 500,
    code: `HTTP_${status}`,
    message: scrub(`TotalPass HTTP ${status}: ${text}`, secrets),
    status,
  }
}

async function authenticate(ctx: ConnectionCtx, h: TotalPassHost, force: boolean): Promise<{ token: string } | HttpFailure> {
  const key = tokenKey(ctx, h)
  const hit = tokens.get(key)
  if (!force && hit && hit.until > Date.now()) return { token: hit.token }
  tokens.delete(key)
  if (!ctx.credential) return { ok: false, retryable: false, code: 'UNAUTHORIZED', message: 'la conexión no tiene la llave de la sucursal' }
  const partnerKey = env.TOTALPASS_PARTNER_API_KEY
  // Falta configuración NUESTRA, no la llave del estudio: no se revoca la conexión; se reintenta tras corregirla.
  if (!partnerKey)
    return { ok: false, retryable: true, code: 'PARTNER_KEY_MISSING', message: 'falta TOTALPASS_PARTNER_API_KEY en el servidor' }

  const r = await fetchWithTimeout(`${baseUrl(h)}/partner/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ place_api_key: ctx.credential, partner_api_key: partnerKey }),
  })
  if (isFailure(r)) return r
  const { data } = await readBody(r)
  // El cuerpo del auth repite las llaves: nunca se copia a un mensaje.
  if (!r.ok) return failureFor(r.status, '(cuerpo omitido)', [])
  const token = data && typeof data === 'object' ? (data as any).token : null
  if (typeof token !== 'string' || !token)
    return { ok: false, retryable: true, code: 'BAD_AUTH_RESPONSE', message: 'TotalPass no devolvió token' }
  tokens.set(key, { token, until: Date.now() + TOKEN_TTL_MS })
  return { token }
}

/** Llamada autenticada. Un 401 re-autentica UNA vez; si vuelve a fallar, `UNAUTHORIZED` (el núcleo revoca). */
export async function totalPassCall(
  ctx: ConnectionCtx,
  h: TotalPassHost,
  method: string,
  path: string,
  payload?: unknown,
): Promise<HttpResult> {
  const secrets: Array<string | null | undefined> = [ctx.credential, env.TOTALPASS_PARTNER_API_KEY]
  const once = async (force: boolean): Promise<Response | HttpFailure> => {
    const auth = await authenticate(ctx, h, force)
    if ('ok' in auth) return auth
    secrets.push(auth.token)
    const headers: Record<string, string> = { Authorization: `Bearer ${auth.token}` }
    if (payload !== undefined) headers['Content-Type'] = 'application/json'
    return fetchWithTimeout(`${baseUrl(h)}${path}`, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
    })
  }

  let r = await once(false)
  if (!isFailure(r) && r.status === 401) {
    await readBody(r) // libera la conexión antes de repetir
    r = await once(true)
  }
  if (isFailure(r)) return r
  const { text, data } = await readBody(r)
  if (r.ok) return { ok: true, status: r.status, data }
  if (r.status === 401) tokens.delete(tokenKey(ctx, h))
  return failureFor(r.status, text, secrets)
}
