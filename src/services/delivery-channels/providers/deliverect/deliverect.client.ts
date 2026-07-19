/**
 * Deliverect API Client
 *
 * Cliente HTTP crudo para la API de Deliverect (aggregator de Uber Eats/Rappi/DiDi Food).
 * OAuth 2.0 client-credentials con cache de token en memoria (patrón calcado de
 * `blumonAuth.service.ts`: authenticate + expiresAt + buffer de expiración).
 *
 * Doc: developers.deliverect.com — REVALIDAR EN STAGING todos los paths exactos
 * marcados abajo; no hay credenciales reales todavía para verificarlos contra la API viva.
 *
 * NO requiere tests unitarios exhaustivos propios (frontera HTTP credential-gated) —
 * `statusDispatcher.test.ts` lo mockea con `jest.mock` y ejercita el resto del flujo
 * (registry → adapter → mapper) contra el client mockeado.
 */
import axios, { AxiosInstance } from 'axios'

/** Error de frontera: SIEMPRE trae status+body para que el caller (dispatcher) lo loguee útilmente. */
export class DeliverectApiError extends Error {
  readonly status: number | undefined
  readonly body: unknown

  constructor(message: string, status: number | undefined, body: unknown) {
    super(message)
    this.name = 'DeliverectApiError'
    this.status = status
    this.body = body
  }
}

interface DeliverectTokenResponse {
  access_token: string
  token_type: string
  expires_in: number // segundos
}

interface CachedToken {
  accessToken: string
  expiresAt: number // epoch ms
}

// Margen de seguridad: renovar el token 60s ANTES de su expiry real para no
// arriesgar una llamada en vuelo con un token que expira a mitad del request.
const TOKEN_EXPIRY_BUFFER_MS = 60_000

let cachedToken: CachedToken | null = null

const http: AxiosInstance = axios.create({
  baseURL: process.env.DELIVERECT_API_URL,
  timeout: 15_000,
  headers: { 'Content-Type': 'application/json' },
})

function toApiError(prefix: string, error: unknown): DeliverectApiError {
  const err = error as any
  const message = err?.response?.data?.message || err?.message || 'Error desconocido'
  return new DeliverectApiError(`${prefix}: ${message}`, err?.response?.status, err?.response?.data)
}

/**
 * OAuth 2.0 client-credentials. Cachea el access_token en memoria (proceso único —
 * suficiente para un server sin múltiples réplicas por región; revisar si escala horizontal).
 * REVALIDAR EN STAGING: path exacto '/oauth/token' y shape del body (asumido JSON estándar
 * OAuth2 client_credentials; Deliverect podría exigir form-urlencoded o Basic Auth en su lugar).
 */
async function getToken(): Promise<string> {
  const now = Date.now()
  if (cachedToken && cachedToken.expiresAt - TOKEN_EXPIRY_BUFFER_MS > now) {
    return cachedToken.accessToken
  }

  try {
    const response = await http.post<DeliverectTokenResponse>('/oauth/token', {
      client_id: process.env.DELIVERECT_CLIENT_ID,
      client_secret: process.env.DELIVERECT_CLIENT_SECRET,
      grant_type: 'client_credentials',
    })
    const { access_token, expires_in } = response.data
    if (!access_token) {
      throw new DeliverectApiError('Deliverect: respuesta de /oauth/token sin access_token', response.status, response.data)
    }
    cachedToken = { accessToken: access_token, expiresAt: now + expires_in * 1000 }
    return access_token
  } catch (error) {
    cachedToken = null
    if (error instanceof DeliverectApiError) throw error
    throw toApiError('Deliverect: fallo obteniendo token OAuth', error)
  }
}

async function authHeaders(): Promise<{ Authorization: string }> {
  const token = await getToken()
  return { Authorization: `Bearer ${token}` }
}

/**
 * Notifica el status de un pedido al canal.
 * Fix C2 (auditoría G-Stack + Codex, 2026-07-19, spec §10.1.6): el scaffold asumió
 * `POST /orders/{id}/status` — la doc real es `POST /orderStatus/{externalId}`.
 * Doc: https://developers.deliverect.com/reference/update-order-status-1
 * REVALIDAR EN STAGING: la doc menciona campos de body adicionales sobre este endpoint
 * que no están 100% enumerados en lo revisado — hoy solo mandamos `{ status }`.
 */
async function postOrderStatus(channelOrderId: string, statusCode: number): Promise<void> {
  try {
    const headers = await authHeaders()
    await http.post(`/orderStatus/${channelOrderId}`, { status: statusCode }, { headers })
  } catch (error) {
    if (error instanceof DeliverectApiError) throw error
    throw toApiError(`Deliverect: fallo notificando status del pedido ${channelOrderId}`, error)
  }
}

/**
 * Publica el catálogo (PLU/precio/modifiers) de un location en Deliverect.
 * REVALIDAR EN STAGING: path exacto — asumido 'POST /products/{accountId}/{locationId}'.
 */
async function pushProducts(accountId: string, locationId: string, payload: unknown): Promise<void> {
  try {
    const headers = await authHeaders()
    await http.post(`/products/${accountId}/${locationId}`, payload, { headers })
  } catch (error) {
    if (error instanceof DeliverectApiError) throw error
    throw toApiError(`Deliverect: fallo publicando menú (account ${accountId}, location ${locationId})`, error)
  }
}

/**
 * Pausa/reanuda el canal (busy mode) para un location.
 * Fix C3 (auditoría G-Stack + Codex, 2026-07-19, spec §10.1.7): el scaffold asumió
 * `POST /locations/{id}/busy` con `{ paused }` — la doc real es
 * `POST /updateStoreStatus/{locationId}` con `{ isActive }`, el INVERSO de `paused`
 * (`isActive: false` == pausado/cerrado al marketplace). Doc:
 * https://developers.deliverect.com/reference/update-store-status
 *
 * Este método SIEMPRE propaga el error (nunca lo traga) — es la capa de arriba
 * (`deliveryChannelLink.service.ts::pauseChannelLink`, fuera del scope de este fix)
 * la que decide si un fallo del proveedor debe o no revertir/reportar el cambio de
 * status local. Tragarlo AQUÍ reportaría éxito falso mientras el marketplace sigue
 * abierto — ver spec §10.1.7.
 */
async function setBusyMode(locationId: string, paused: boolean): Promise<void> {
  try {
    const headers = await authHeaders()
    await http.post(`/updateStoreStatus/${locationId}`, { isActive: !paused }, { headers })
  } catch (error) {
    if (error instanceof DeliverectApiError) throw error
    throw toApiError(`Deliverect: fallo cambiando busy mode del location ${locationId}`, error)
  }
}

export const deliverectClient = {
  getToken,
  postOrderStatus,
  pushProducts,
  setBusyMode,
}
