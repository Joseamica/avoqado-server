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

function findLabel(labels: Array<{ name: string; value: string }>, name: string): string | null {
  return labels.find((l) => l.name === name)?.value ?? null
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

export async function fetchRenderLogs(
  params: FetchRenderLogsParams = {},
): Promise<RenderLogsResponse> {
  const config = isConfigured()
  if (!config.ok) {
    return { enabled: false, disabledReason: config.reason, logs: [], hasMore: false }
  }

  const query: Record<string, string | string[]> = {
    'resource[]': [config.serviceId],
    direction: 'backward',
    limit: String(Math.min(params.limit ?? 100, 100)),
  }
  if (params.level) query['level[]'] = [params.level]
  if (params.type) query['type[]'] = [params.type]
  if (params.startTime) query.startTime = params.startTime
  if (params.endTime) query.endTime = params.endTime

  try {
    const { data } = await axios.get<{
      hasMore: boolean
      nextEndTime?: string
      logs: Array<{
        id: string
        timestamp: string
        message: string
        labels: Array<{ name: string; value: string }>
      }>
    }>(`${RENDER_API_BASE}/logs`, {
      params: query,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: 'application/json',
      },
      timeout: 10_000,
    })

    let logs: RenderLogEntry[] = data.logs.map((entry) => ({
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
      logs = logs.filter((l) => l.message.toLowerCase().includes(needle))
    }

    return {
      enabled: true,
      logs,
      hasMore: data.hasMore,
      nextEndTime: data.nextEndTime,
    }
  } catch (error) {
    if (isAxiosError(error)) {
      const status = error.response?.status
      const renderMessage =
        (error.response?.data as { message?: string } | undefined)?.message ?? error.message

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
