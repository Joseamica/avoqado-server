/**
 * AngelPay Integrations API Client
 *
 * Cliente HTTP crudo para la integrations-api de AngelPay (auth por apiKey +
 * registro de webhooks). Patrón calcado de `deliverect.client.ts`: axios
 * instance con timeout de 15s, clase de error tipada con status+body, y un
 * normalizador `toApiError` para errores no tipados.
 *
 * A diferencia de Deliverect (una sola base URL fija al crear el cliente),
 * AngelPay expone DOS ambientes (QA/PROD) que el caller elige POR LLAMADA —
 * por eso `http` NO fija `baseURL` en `axios.create()`; cada request pasa
 * `{ baseURL: baseUrlFor(environment) }`.
 *
 * 🚨 NUNCA loguear el apiKey, el access_token, ni el webhook secret — ni aquí
 * ni en los callers. `toApiError` solo captura status + body de la RESPUESTA
 * de AngelPay (nunca el request), y este archivo no llama a `logger` en
 * ningún punto — los callers deciden qué (no) loguear del error tipado.
 *
 * Hechos verificados en vivo (spec 2026-07-21-angelpay-connect-via-apikey):
 *   POST /auth/token                    { apiKey } → 200 { access_token, token_type, expires_in }
 *     — access_token es un JWT; el claim `sub` (string, ej. "990") es el merchant_id.
 *     — apiKey inválida o de otro ambiente → 401.
 *   GET  /api/v1/webhooks/endpoints     (Bearer) → 200 [{ id, url, ... }]  (SIN secret)
 *   POST /api/v1/webhooks/endpoints     (Bearer) { url, description?, events } → 200/201
 *        { id (uuid), id_merchant, url, secret ("whsec_..."), is_active, events, created_at }
 *     — 🚨 `secret` SOLO se devuelve en el create. No hay GET ni regenerate — persistir de inmediato.
 *   DELETE /api/v1/webhooks/endpoints/{id}  (Bearer)
 */
import axios, { AxiosInstance } from 'axios'

export type AngelPayEnvironment = 'QA' | 'PROD'

/** Error de frontera: SIEMPRE trae status+body para que el caller lo loguee útilmente. */
export class AngelPayIntegrationsApiError extends Error {
  readonly status: number | undefined
  readonly body: unknown

  constructor(message: string, status: number | undefined, body: unknown) {
    super(message)
    this.name = 'AngelPayIntegrationsApiError'
    this.status = status
    this.body = body
  }
}

const BASE_URL_PROD = process.env.ANGELPAY_INTEGRATIONS_API_BASE_URL_PROD ?? 'https://integrations-api.angelpay.com.mx'
const BASE_URL_QA = process.env.ANGELPAY_INTEGRATIONS_API_BASE_URL_QA ?? 'https://integrations-api.angelpay-qa.com.mx'

/** Resolves the integrations-api base URL for the given AngelPay environment. */
function baseUrlFor(environment: AngelPayEnvironment): string {
  return environment === 'PROD' ? BASE_URL_PROD : BASE_URL_QA
}

const http: AxiosInstance = axios.create({
  timeout: 15_000,
  headers: { 'Content-Type': 'application/json' },
})

function toApiError(prefix: string, error: unknown): AngelPayIntegrationsApiError {
  const err = error as any
  const message = err?.response?.data?.message || err?.message || 'Error desconocido'
  return new AngelPayIntegrationsApiError(`${prefix}: ${message}`, err?.response?.status, err?.response?.data)
}

interface AngelPayAuthResponse {
  access_token: string
  token_type: string
  expires_in: number // segundos
}

/**
 * Decodifica el claim `sub` del payload del JWT `access_token` (base64url,
 * con relleno de padding) — es el merchant_id de AngelPay como string. No
 * valida la firma: el token viene de una respuesta 200 sobre HTTPS directo
 * de AngelPay, no hay una llave pública nuestra contra la que verificarla aquí.
 */
function decodeMerchantIdFromJwt(accessToken: string): string {
  const parts = accessToken.split('.')
  if (parts.length < 2) {
    throw new AngelPayIntegrationsApiError('AngelPay: access_token no es un JWT válido', undefined, undefined)
  }
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
    return String(payload.sub)
  } catch {
    throw new AngelPayIntegrationsApiError('AngelPay: no se pudo decodificar el access_token', undefined, undefined)
  }
}

/**
 * POST /auth/token — intercambia un apiKey por un access_token JWT de corta
 * vida. El merchant_id vive en el claim `sub` del JWT.
 */
async function auth(apiKey: string, environment: AngelPayEnvironment): Promise<{ accessToken: string; merchantId: string }> {
  try {
    const response = await http.post<AngelPayAuthResponse>('/auth/token', { apiKey }, { baseURL: baseUrlFor(environment) })
    if (response.status !== 200) {
      throw new AngelPayIntegrationsApiError('AngelPay: /auth/token respondió con status inesperado', response.status, response.data)
    }
    const accessToken = response.data?.access_token
    if (!accessToken) {
      throw new AngelPayIntegrationsApiError('AngelPay: /auth/token sin access_token', response.status, response.data)
    }
    return { accessToken, merchantId: decodeMerchantIdFromJwt(accessToken) }
  } catch (error) {
    if (error instanceof AngelPayIntegrationsApiError) throw error
    throw toApiError('AngelPay: fallo autenticando apiKey', error)
  }
}

interface AngelPayWebhookEndpoint {
  id: string
  id_merchant?: string
  url: string
  description?: string
  secret?: string
  is_active?: boolean
  events?: string[]
  created_at?: string
}

/**
 * Registra (o re-registra) el webhook de AngelPay para un merchant.
 *
 * AngelPay solo entrega `secret` en la respuesta de create — no hay GET ni
 * regenerate — así que si ya existe un endpoint con la misma `url` lo
 * borramos primero (constraint de "un secret por create") para poder emitir
 * uno fresco y persistirlo.
 */
async function registerWebhook(
  accessToken: string,
  environment: AngelPayEnvironment,
  params: { url: string; events: string[]; description?: string },
): Promise<{ endpointId: string; secret: string }> {
  const baseURL = baseUrlFor(environment)
  const headers = { Authorization: `Bearer ${accessToken}` }

  try {
    const existingResp = await http.get<AngelPayWebhookEndpoint[]>('/api/v1/webhooks/endpoints', { baseURL, headers })
    const existing = Array.isArray(existingResp.data) ? existingResp.data : []
    const duplicate = existing.find(e => e.url === params.url)
    if (duplicate) {
      await http.delete(`/api/v1/webhooks/endpoints/${duplicate.id}`, { baseURL, headers })
    }

    const createResp = await http.post<AngelPayWebhookEndpoint>(
      '/api/v1/webhooks/endpoints',
      { url: params.url, description: params.description, events: params.events },
      { baseURL, headers },
    )
    if (createResp.status !== 200 && createResp.status !== 201) {
      throw new AngelPayIntegrationsApiError(
        'AngelPay: creación de webhook respondió con status inesperado',
        createResp.status,
        createResp.data,
      )
    }
    const { id: endpointId, secret } = createResp.data ?? ({} as AngelPayWebhookEndpoint)
    if (!endpointId || !secret) {
      throw new AngelPayIntegrationsApiError('AngelPay: respuesta de creación de webhook sin id/secret', createResp.status, createResp.data)
    }
    return { endpointId, secret }
  } catch (error) {
    if (error instanceof AngelPayIntegrationsApiError) throw error
    throw toApiError('AngelPay: fallo registrando webhook', error)
  }
}

export const angelPayIntegrationsApiClient = {
  auth,
  registerWebhook,
  baseUrlFor,
}
