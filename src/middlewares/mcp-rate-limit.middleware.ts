/**
 * Rate limiting for the customer-facing MCP endpoint (`POST /mcp`).
 *
 * WHY: the MCP exposes ~250 tools behind a single endpoint. `requireBearerAuth` proves WHO is
 * calling, but nothing limited HOW MUCH — so a valid (or stolen) token could fuzz tool parameters,
 * probe permission boundaries, or simply exhaust the DB pool at full speed. Every tool still gates
 * its own access per venue/permission, so this is not the tenant boundary; it is the volume
 * boundary, and it was the only one missing. (The dashboard chatbot has had one since day one —
 * `chatbot-rate-limit.middleware.ts`, whose shape this mirrors.)
 *
 * NOT a tier/feature gate: this is infrastructure protection, identical for every plan.
 *
 * SHAPE OF THE RESPONSE: MCP is JSON-RPC over POST, so a rejection must be a JSON-RPC error object
 * — an MCP client cannot parse the REST-style `{success:false}` body the chatbot returns. Same
 * precedent as the 405 handler in `app.ts`. HTTP 429 + `Retry-After` are kept: clients honour them.
 *
 * LIMITS are generous on purpose. The MCP is stateless per request (every call rebuilds the server)
 * and one human question can fan out into a dozen tool calls, so a strict cap would break normal
 * use long before it stopped an attacker — who needs orders of magnitude more. Tune via env.
 */
import { Request, Response, NextFunction } from 'express'
import logger from '@/config/logger'
import { SecurityAuditLoggerService } from '../services/dashboard/security-audit-logger.service'

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const isProduction = process.env.NODE_ENV === 'production'

/** Window + ceiling per scope. `staff` is the real control (a token belongs to one person); org and IP are backstops. */
export const MCP_RATE_LIMITS = {
  STAFF: {
    windowMs: 60 * 1000,
    max: parsePositiveInt(process.env.MCP_STAFF_RATE_LIMIT_MAX, isProduction ? 120 : 600),
  },
  ORG: {
    windowMs: 60 * 60 * 1000,
    max: parsePositiveInt(process.env.MCP_ORG_RATE_LIMIT_MAX, isProduction ? 6000 : 60000),
  },
  IP: {
    windowMs: 60 * 1000,
    max: parsePositiveInt(process.env.MCP_IP_RATE_LIMIT_MAX, isProduction ? 300 : 3000),
  },
} as const

type Scope = keyof typeof MCP_RATE_LIMITS

interface Counter {
  count: number
  resetTime: number
}

/**
 * Fixed-window counters, in memory. Deliberately NOT Redis: this instance-local ceiling is enough
 * to stop a runaway client, costs nothing, and cannot itself become a dependency that takes the
 * MCP down. Move to Redis only if the server is scaled to many instances AND the per-instance
 * ceiling proves too loose.
 */
class RateLimitStore {
  private readonly buckets = new Map<Scope, Map<string, Counter>>()

  public hit(scope: Scope, key: string): { count: number; remaining: number; resetTime: number; exceeded: boolean } {
    const { windowMs, max } = MCP_RATE_LIMITS[scope]
    const bucket = this.buckets.get(scope) ?? new Map<string, Counter>()
    this.buckets.set(scope, bucket)

    const now = Date.now()
    const current = bucket.get(key)
    const record = !current || now >= current.resetTime ? { count: 0, resetTime: now + windowMs } : current
    record.count++
    bucket.set(key, record)

    return { count: record.count, remaining: Math.max(0, max - record.count), resetTime: record.resetTime, exceeded: record.count > max }
  }

  public cleanup(): void {
    const now = Date.now()
    for (const bucket of this.buckets.values()) {
      for (const [key, record] of bucket.entries()) if (now >= record.resetTime) bucket.delete(key)
    }
  }

  /** Test hook. */
  public reset(): void {
    this.buckets.clear()
  }
}

export const mcpRateLimitStore = new RateLimitStore()

const cleanupInterval = setInterval(() => mcpRateLimitStore.cleanup(), 5 * 60 * 1000)
cleanupInterval.unref?.()

/** JSON-RPC error body an MCP client can actually parse (`-32000` = implementation-defined server error). */
function jsonRpcRateLimitError(res: Response, message: string, retryAfterSeconds: number): void {
  res.setHeader('Retry-After', String(retryAfterSeconds))
  res.status(429).json({
    jsonrpc: '2.0',
    error: { code: -32000, message, data: { retryAfter: retryAfterSeconds } },
    id: null,
  })
}

/** Identity threaded by `requireBearerAuth` (`provider.verifyAccessToken`) onto the request. */
function identityOf(req: Request): { staffId?: string; activeOrg?: string } {
  const extra = (req as { auth?: { extra?: Record<string, unknown> } }).auth?.extra
  return {
    staffId: typeof extra?.staffId === 'string' ? extra.staffId : undefined,
    activeOrg: typeof extra?.activeOrg === 'string' ? extra.activeOrg : undefined,
  }
}

/**
 * Enforce the volume ceiling on `POST /mcp`. Mount AFTER `requireBearerAuth` so the caller's
 * identity is known; an unidentified request still gets the IP ceiling.
 */
export const mcpRateLimitMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  try {
    const { staffId, activeOrg } = identityOf(req)
    const ipAddress = req.ip || req.socket.remoteAddress || 'unknown'

    const checks: Array<{ scope: Scope; key: string; message: (count: number, max: number) => string }> = [
      {
        scope: 'IP',
        key: ipAddress,
        message: (c, m) => `Demasiadas solicitudes desde esta red (${c} en el último minuto; el límite es ${m}).`,
      },
    ]
    if (staffId) {
      checks.unshift({
        scope: 'STAFF',
        key: staffId,
        message: (c, m) =>
          `Demasiadas solicitudes de tu cuenta (${c} en el último minuto; el límite es ${m}). Espera unos segundos y vuelve a intentarlo.`,
      })
    }
    if (activeOrg) {
      checks.push({
        scope: 'ORG',
        key: activeOrg,
        message: (c, m) => `Tu organización alcanzó el límite de solicitudes por hora (${c} de ${m}).`,
      })
    }

    let staffRemaining: number | null = null
    for (const check of checks) {
      const result = mcpRateLimitStore.hit(check.scope, check.key)
      if (check.scope === 'STAFF') staffRemaining = result.remaining
      if (!result.exceeded) continue

      const { max, windowMs } = MCP_RATE_LIMITS[check.scope]
      const retryAfterSeconds = Math.max(1, Math.ceil((result.resetTime - Date.now()) / 1000))
      logger.warn(`[MCP] rate limit exceeded (${check.scope})`, {
        mcp: true,
        scope: check.scope,
        staffId,
        org: activeOrg,
        ipAddress,
        count: result.count,
        limit: max,
      })
      // Feeds the same security audit trail as the chatbot limiter. venueId is unknown here (the
      // MCP is org-scoped, not venue-scoped) — the org id is the meaningful tenant key.
      if (staffId) {
        SecurityAuditLoggerService.logRateLimitExceeded({
          userId: staffId,
          venueId: activeOrg ?? 'unknown',
          ipAddress,
          limit: max,
          windowMs,
        })
      }
      return jsonRpcRateLimitError(res, check.message(result.count, max), retryAfterSeconds)
    }

    // Informational headers from the counters already incremented above — never a second hit().
    if (staffRemaining !== null) {
      res.setHeader('X-RateLimit-Limit', String(MCP_RATE_LIMITS.STAFF.max))
      res.setHeader('X-RateLimit-Remaining', String(staffRemaining))
    }
    next()
  } catch (error) {
    // A bug in the limiter must NEVER take the MCP down — log and let the request through.
    logger.error('[MCP] rate limit middleware error', { mcp: true, error: (error as Error).message })
    next()
  }
}
