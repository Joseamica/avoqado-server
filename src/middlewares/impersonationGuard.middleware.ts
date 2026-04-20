import { Request } from 'express'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { IMPERSONATION_ERROR_CODES } from '../types/impersonation'

/**
 * Read-only methods that are always allowed during impersonation sessions.
 * All other methods are default-denied.
 */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Absolute paths that are allowed during impersonation regardless of method.
 * These are the endpoints needed to manage the impersonation session itself
 * (so the superadmin can always extend or exit). Keep this list minimal.
 */
const IMPERSONATION_CONTROL_PATHS = [
  '/api/v1/dashboard/impersonation/stop',
  '/api/v1/dashboard/impersonation/extend',
  '/api/v1/dashboard/impersonation/status',
]

/**
 * Path prefixes that are BLOCKED during impersonation (even for GET).
 * Rationale: `/superadmin/*` surfaces platform-wide admin data that the
 * impersonated user would never see, so exposing it would break the illusion.
 */
const BLOCKED_PREFIXES = ['/api/v1/dashboard/superadmin', '/api/v1/superadmin']

// Simple per-process TTL cache for "is target still an active venue member?".
// Caches answers for 60s to avoid a DB hit on every request.
const targetValidityCache = new Map<string, { valid: boolean; checkedAt: number }>()
const TARGET_CACHE_TTL_MS = 60 * 1000

/**
 * Result of enforcing impersonation rules on a single request.
 * `ok: true` means the request should continue; `ok: false` carries the exact
 * status/code/message to return to the client.
 */
export type ImpersonationEnforcementResult =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string; clearCookie?: boolean }

/**
 * Enforces the read-only, scope-limited contract of impersonation sessions.
 *
 * Called from `authenticateTokenMiddleware` after `req.authContext` is built,
 * so every authenticated request automatically passes through this guard —
 * new endpoints are protected by default without requiring per-route opt-in.
 *
 * Contract:
 * 1. Non-impersonation requests pass through untouched.
 * 2. Expired impersonation sessions return 401.
 * 3. `/impersonation/{stop,extend,status}` always pass (allow exit/extend).
 * 4. `/superadmin/*` prefixes are blocked with 403.
 * 5. Non-read methods are blocked with 403.
 * 6. In user-mode, the target must still be an active StaffVenue member.
 */
export async function enforceImpersonationRules(req: Request): Promise<ImpersonationEnforcementResult> {
  const ctx = req.authContext
  if (!ctx || !ctx.isImpersonating || !ctx.impersonation) {
    return { ok: true }
  }

  // Defense-in-depth expiry check. authenticateToken also checks this via JWT exp + act.expiresAt.
  const nowSeconds = Math.floor(Date.now() / 1000)
  if (ctx.impersonation.expiresAt <= nowSeconds) {
    return {
      ok: false,
      status: 401,
      code: IMPERSONATION_ERROR_CODES.EXPIRED,
      message: 'La sesión de impersonación ha expirado.',
      clearCookie: true,
    }
  }

  const method = req.method.toUpperCase()
  const path = req.originalUrl.split('?')[0]

  // Endpoints needed to manage the impersonation session itself always pass.
  if (IMPERSONATION_CONTROL_PATHS.includes(path)) {
    return { ok: true }
  }

  // Superadmin-only routes are always blocked during impersonation.
  if (BLOCKED_PREFIXES.some(prefix => path.startsWith(prefix))) {
    return {
      ok: false,
      status: 403,
      code: IMPERSONATION_ERROR_CODES.BLOCKED_ROUTE,
      message: 'Esta sección no es accesible mientras impersonas. Sal de impersonación para continuar.',
    }
  }

  // Default-deny for non-read methods.
  if (!READ_METHODS.has(method)) {
    return {
      ok: false,
      status: 403,
      code: IMPERSONATION_ERROR_CODES.READ_ONLY,
      message: 'No puedes realizar esta acción en modo impersonación (solo lectura).',
    }
  }

  // Target validity check (user-mode only). Verifies the impersonated user still has an active
  // StaffVenue at this venue. Cached for 60s to avoid a DB hit on every request.
  if (ctx.impersonation.mode === 'user' && ctx.impersonation.impersonatedUserId) {
    const cacheKey = `${ctx.impersonation.impersonatedUserId}:${ctx.venueId}`
    const cached = targetValidityCache.get(cacheKey)
    const fresh = cached && Date.now() - cached.checkedAt < TARGET_CACHE_TTL_MS
    let valid = fresh ? cached!.valid : false

    if (!fresh) {
      try {
        const membership = await prisma.staffVenue.findFirst({
          where: {
            staffId: ctx.impersonation.impersonatedUserId,
            venueId: ctx.venueId,
            active: true,
          },
          select: { id: true },
        })
        valid = !!membership
        targetValidityCache.set(cacheKey, { valid, checkedAt: Date.now() })
        if (targetValidityCache.size > 500) {
          // Opportunistic cleanup
          const cutoff = Date.now() - TARGET_CACHE_TTL_MS
          for (const [k, v] of targetValidityCache.entries()) {
            if (v.checkedAt < cutoff) targetValidityCache.delete(k)
          }
        }
      } catch (err) {
        logger.error('[ImpersonationGuard] Target validity check failed', {
          error: err instanceof Error ? err.message : String(err),
        })
        // Fail-open: short session windows + audit trail make this acceptable.
        valid = true
      }
    }

    if (!valid) {
      return {
        ok: false,
        status: 403,
        code: IMPERSONATION_ERROR_CODES.TARGET_INVALID,
        message: 'El usuario que estabas viendo ya no está activo en este venue.',
        clearCookie: true,
      }
    }
  }

  return { ok: true }
}

/**
 * For tests: reset the internal target-validity cache.
 */
export function _resetImpersonationGuardCacheForTests(): void {
  targetValidityCache.clear()
}
