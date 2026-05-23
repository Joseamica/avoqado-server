/**
 * Superadmin System Logs Routes
 *
 * Proxies the Render Logs API so the operations console can show stdout /
 * stderr / build / request logs without anyone opening Render Dashboard.
 * Auth + role check come from the parent router (superadmin.routes.ts).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import {
  fetchRenderLogs,
  type RenderLogLevel,
  type RenderLogType,
} from '@/services/superadmin/render-logs.service'

const router = Router()

const VALID_LEVELS: RenderLogLevel[] = ['info', 'warning', 'error']
const VALID_TYPES: RenderLogType[] = ['app', 'request', 'build', 'deploy']

function asLevel(value: unknown): RenderLogLevel | undefined {
  return typeof value === 'string' && (VALID_LEVELS as string[]).includes(value)
    ? (value as RenderLogLevel)
    : undefined
}

function asType(value: unknown): RenderLogType | undefined {
  return typeof value === 'string' && (VALID_TYPES as string[]).includes(value)
    ? (value as RenderLogType)
    : undefined
}

/**
 * GET /api/v1/superadmin/system-logs
 * Returns the last 100 (max) logs from the avoqado-server's Render service,
 * filtered server-side. Falls back to a disabled marker if the env vars are
 * missing — the UI handles that case with a friendly empty state.
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { level, type, startTime, endTime, search, limit } = req.query

    const result = await fetchRenderLogs({
      level: asLevel(level),
      type: asType(type),
      startTime: typeof startTime === 'string' ? startTime : undefined,
      endTime: typeof endTime === 'string' ? endTime : undefined,
      search: typeof search === 'string' ? search : undefined,
      limit: typeof limit === 'string' ? parseInt(limit, 10) : undefined,
    })

    res.json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
})

export default router
