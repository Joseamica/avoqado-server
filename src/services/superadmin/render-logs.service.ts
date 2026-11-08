/**
 * Render Logs Proxy
 *
 * Server-side wrapper around the Render Logs API
 * (https://api-docs.render.com/reference/list-logs). The superadmin console
 * consumes this so operators never have to open the Render dashboard.
 *
 * Auth: RENDER_API_KEY (server-side only — never reaches the browser).
 * Service ID: RENDER_SERVICE_ID (the avoqado-server's Render service).
 *
 * Failure modes handled:
 *   - Env vars missing → returns disabled marker so the UI shows a
 *     "configure your Render credentials" empty state instead of crashing.
 *   - Render returns 401/403/429/5xx → bubble the meaningful message up
 *     to the superadmin so they know whether to rotate the key or wait.
 */

import axios, { isAxiosError } from 'axios'
import logger from '../../config/logger'
import AppError from '../../errors/AppError'

const RENDER_API_BASE = 'https://api.render.com/v1'

export type RenderLogLevel = 'info' | 'warning' | 'error'
export type RenderLogType = 'app' | 'request' | 'build' | 'deploy'

export interface RenderLogEntry {
  id: string
  timestamp: string
  message: string
  level: RenderLogLevel | null
  type: RenderLogType | null
  /** Full labels array from Render — kept raw so the UI can show anything we missed. */
  labels: Array<{ name: string; value: string }>
}

export interface FetchRenderLogsParams {
  level?: RenderLogLevel
  type?: RenderLogType
  startTime?: string
  endTime?: string
  /** Render caps at 100 per request. */
  limit?: number
  /** Free-text search applied client-side against `message` after fetch. */
  search?: string
}

export interface RenderLogsResponse {
  enabled: boolean
  /** Friendly message when `enabled === false` (env vars missing, key revoked, etc.). */
  disabledReason?: string
  logs: RenderLogEntry[]
  hasMore: boolean
  nextEndTime?: string
  /** Desde cuándo se buscó (ISO). Sin fecha elegida son las 24 h antes de `endTime` (o de ahora). */
  windowStart?: string
  /**
   * Dónde sigue «Ver anteriores»: se manda como `endTime` (con el mismo `startTime` del operador, si eligió uno).
   * Sin valor = ya no hay nada más atrás que buscar.
   */
  olderEndTime?: string
}

const DAY_MS = 24 * 60 * 60 * 1000
/**
 * Sin fecha elegida se busca sólo en las últimas 24 h. Con un filtro escaso («Error» sale cada ~6 h) y sin
 * ventana, Render hojeaba TODO el historial hasta juntar 100: 1–5 s normalmente y más de 20 s cuando andaba
 * lento (3-nov-2026, 8 fallos seguidos). Lo más viejo se pide con «Ver anteriores», de 24 h en 24 h.
 */
const DEFAULT_WINDOW_MS = DAY_MS
/**
 * «Ver anteriores» no ofrece ir más atrás de lo que Render guarda. Medido el 8-nov-2026: no hay logs de hace más
 * de ~7.5 días. ponytail: fijo a 7 días; si se sube el plan de Render (más retención), súbelo aquí.
 */
const RENDER_RETENTION_MS = 7 * DAY_MS
/**
 * Render a veces se cuelga en una consulta que un instante después contesta en 0.4 s (medido el 8-nov: 1 de 13
 * consultas de 24 h se colgó 60 s; la siguiente, igual, tardó 0.4 s). Por eso se rinde pronto y reintenta una vez.
 * Todo junto (ownerId + 2 intentos) queda debajo del timeout del navegador (20 s): el SERVIDOR contesta primero.
 */
const OWNER_TIMEOUT_MS = 4_000
const LOGS_TIMEOUT_MS = 7_000
const LOGS_ATTEMPTS = 2

function isTimeout(error: unknown): boolean {
  return isAxiosError(error) && !error.response && (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT')
}

function isConfigured(): { ok: true; apiKey: string; serviceId: string } | { ok: false; reason: string } {
  const apiKey = process.env.RENDER_API_KEY?.trim()
  const serviceId = process.env.RENDER_SERVICE_ID?.trim()

  if (!apiKey) {
    return {
      ok: false,
      reason:
        'RENDER_API_KEY no está configurada. Crea una API key en https://dashboard.render.com/u/settings#api-keys y agrégala al .env de avoqado-server.',
    }
  }
  if (!serviceId) {
    return {
      ok: false,
      reason:
        'RENDER_SERVICE_ID no está configurada. Ve a tu servicio en Render — el ID empieza con `srv-` y aparece en la URL del dashboard.',
    }
  }
  return { ok: true, apiKey, serviceId }
}

/**
 * Cache the ownerId in memory after the first lookup. Owner ID is a stable
 * property of the service — it doesn't change unless the service is moved
 * across accounts (rare). One extra HTTP roundtrip on cold start, zero on
 * subsequent requests.
 */
let cachedOwnerId: string | null = null

async function getOwnerId(apiKey: string, serviceId: string): Promise<string> {
  if (cachedOwnerId) return cachedOwnerId
  const { data } = await axios.get<{ ownerId: string }>(`${RENDER_API_BASE}/services/${serviceId}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    timeout: OWNER_TIMEOUT_MS,
  })
  if (!data.ownerId) {
    throw new Error('Render API returned a service without an ownerId — verify RENDER_SERVICE_ID.')
  }
  cachedOwnerId = data.ownerId
  return cachedOwnerId
}

function findLabel(labels: Array<{ name: string; value: string }>, name: string): string | null {
  return labels.find(l => l.name === name)?.value ?? null
}

function normalizeLevel(value: string | null): RenderLogLevel | null {
  if (!value) return null
  const lower = value.toLowerCase()
  if (lower === 'info' || lower === 'warning' || lower === 'error') return lower
  return null
}

function normalizeType(value: string | null): RenderLogType | null {
  if (!value) return null
  const lower = value.toLowerCase()
  if (lower === 'app' || lower === 'request' || lower === 'build' || lower === 'deploy') {
    return lower
  }
  return null
}

export async function fetchRenderLogs(params: FetchRenderLogsParams = {}): Promise<RenderLogsResponse> {
  const config = isConfigured()
  if (!config.ok) {
    return { enabled: false, disabledReason: config.reason, logs: [], hasMore: false }
  }

  try {
    // Render requires an `ownerId` query param on /v1/logs. We resolve it
    // dynamically from the service itself (one-time, cached) so the operator
    // only has to set RENDER_API_KEY + RENDER_SERVICE_ID, not three vars.
    const ownerId = await getOwnerId(config.apiKey, config.serviceId)

    // Ventana: el inicio del operador, o las 24 h antes del final (o de ahora), nunca más atrás de lo que Render guarda.
    const now = Date.now()
    const oldestAllowed = now - RENDER_RETENTION_MS
    const endMs = params.endTime ? Date.parse(params.endTime) : now
    const windowStart =
      params.startTime ?? new Date(Math.max((Number.isNaN(endMs) ? now : endMs) - DEFAULT_WINDOW_MS, oldestAllowed)).toISOString()

    // Render API espera params repetidos (`?resource=srv-x&resource=srv-y`),
    // NO el `resource[]=...` que axios serializa por default. Construimos la
    // URL con URLSearchParams para tener control fino y no depender de `qs`.
    const search = new URLSearchParams()
    search.append('ownerId', ownerId)
    search.append('resource', config.serviceId)
    search.append('direction', 'backward')
    search.append('limit', String(Math.min(Math.max(params.limit || 100, 1), 100)))
    if (params.level) search.append('level', params.level)
    if (params.type) search.append('type', params.type)
    search.append('startTime', windowStart)
    if (params.endTime) search.append('endTime', params.endTime)
    const pedirLogs = () =>
      axios.get<{
        hasMore: boolean
        nextEndTime?: string
        logs: Array<{
          id: string
          timestamp: string
          message: string
          labels: Array<{ name: string; value: string }>
        }>
      }>(`${RENDER_API_BASE}/logs?${search.toString()}`, {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          Accept: 'application/json',
        },
        timeout: LOGS_TIMEOUT_MS,
      })
    let respuesta: Awaited<ReturnType<typeof pedirLogs>> | undefined
    for (let intento = 1; !respuesta; intento++) {
      try {
        respuesta = await pedirLogs()
      } catch (error) {
        if (!isTimeout(error) || intento >= LOGS_ATTEMPTS) throw error
        logger.warn(`[render-logs] Render no contestó en ${LOGS_TIMEOUT_MS} ms; reintento ${intento + 1}/${LOGS_ATTEMPTS}`)
      }
    }
    const { data } = respuesta

    let logs: RenderLogEntry[] = (data.logs ?? []).map(entry => ({
      id: entry.id,
      timestamp: entry.timestamp,
      message: entry.message,
      level: normalizeLevel(findLabel(entry.labels, 'level')),
      type: normalizeType(findLabel(entry.labels, 'type')),
      labels: entry.labels,
    }))

    // Server-side filtro de búsqueda (Render no la expone como query).
    if (params.search) {
      const needle = params.search.toLowerCase()
      logs = logs.filter(l => l.message.toLowerCase().includes(needle))
    }

    return {
      enabled: true,
      logs,
      hasMore: data.hasMore,
      nextEndTime: data.nextEndTime,
      windowStart,
      // Más dentro de la ventana → sigue desde el más viejo devuelto; si no, desde el inicio de la ventana (salvo que
      // el operador haya elegido ese inicio, o ya sea el límite de Render).
      olderEndTime: data.hasMore
        ? data.nextEndTime
        : !params.startTime && Date.parse(windowStart) > oldestAllowed
          ? windowStart
          : undefined,
    }
  } catch (error) {
    if (isAxiosError(error)) {
      const status = error.response?.status
      const renderMessage = (error.response?.data as { message?: string } | undefined)?.message ?? error.message

      if (isTimeout(error)) {
        logger.warn(`[render-logs] Render API no contestó a tiempo: ${renderMessage}`)
        throw new AppError(
          'Render tardó demasiado en contestar. Vuelve a intentar en unos segundos o elige un rango de fecha más corto.',
          504,
        )
      }

      if (status === 401 || status === 403) {
        return {
          enabled: false,
          disabledReason: `Render rechazó la API key (${status}). Verifica que esté activa y tenga permisos sobre el servicio.`,
          logs: [],
          hasMore: false,
        }
      }
      logger.warn(`[render-logs] Render API ${status ?? 'no-status'}: ${renderMessage}`)
      throw error
    }
    throw error
  }
}
