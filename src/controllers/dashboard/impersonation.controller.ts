import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import { StaffRole } from '@prisma/client'
import {
  ImpersonationError,
  startImpersonation,
  extendImpersonation,
  stopImpersonation,
  getEligibleTargets,
  getImpersonationStatus,
  resolveImpersonationVenueId,
} from '../../services/dashboard/impersonation.service'
import { IMPERSONATION_REASON_MIN_LENGTH } from '../../types/impersonation'
import { getRealRole, getRealUserId, isImpersonatingRequest } from '../../security'
import logger from '../../config/logger'

const NODE_ENV = process.env.NODE_ENV
const IS_SECURE_COOKIE_ENV = NODE_ENV === 'production' || NODE_ENV === 'staging'

/**
 * Cookie options aligned with the existing auth flow
 * (see auth.dashboard.controller.ts `login` handler).
 */
function buildAccessTokenCookieOptions(maxAgeMs: number) {
  return {
    httpOnly: true,
    secure: IS_SECURE_COOKIE_ENV,
    sameSite: IS_SECURE_COOKIE_ENV ? ('none' as const) : ('lax' as const),
    maxAge: maxAgeMs,
    path: '/',
  }
}

/**
 * Decode (without verifying — verification already happened in authenticateToken)
 * the incoming access token so we can revoke its `jti` when rotating tokens.
 */
function readCurrentTokenMetadata(req: Request): { jti: string | undefined; exp: number | undefined } {
  const token = req.cookies?.accessToken
  if (!token) return { jti: undefined, exp: undefined }
  try {
    const decoded = jwt.decode(token) as { jti?: string; exp?: number } | null
    return { jti: decoded?.jti, exp: decoded?.exp }
  } catch {
    return { jti: undefined, exp: undefined }
  }
}

const staffRoleValues = Object.values(StaffRole) as [StaffRole, ...StaffRole[]]

const startSchema = z
  .object({
    mode: z.enum(['user', 'role'], { required_error: 'mode es requerido.' }),
    targetUserId: z.string().min(1).optional(),
    targetRole: z.enum(staffRoleValues).optional(),
    /**
     * Explicit venueId override. The frontend passes the venue currently shown
     * in the URL (which may differ from the JWT venueId when the user navigated
     * directly to another venue without switchVenue) so impersonation is scoped
     * to what the user sees, not what the stale JWT says.
     */
    venueId: z.string().min(1).optional(),
    reason: z
      .string({ required_error: 'El motivo es requerido.' })
      .trim()
      .min(IMPERSONATION_REASON_MIN_LENGTH, `El motivo debe tener al menos ${IMPERSONATION_REASON_MIN_LENGTH} caracteres.`),
  })
  .superRefine((value, ctx) => {
    if (value.mode === 'user' && !value.targetUserId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetUserId'],
        message: 'targetUserId es requerido cuando mode = user.',
      })
    }
    if (value.mode === 'role' && !value.targetRole) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetRole'],
        message: 'targetRole es requerido cuando mode = role.',
      })
    }
  })

function sendImpersonationError(res: Response, err: unknown, defaultMessage: string): void {
  if (err instanceof ImpersonationError) {
    res.status(err.status).json({ error: err.status === 403 ? 'Forbidden' : 'BadRequest', code: err.code, message: err.message })
    return
  }
  if (err instanceof z.ZodError) {
    res.status(400).json({
      error: 'BadRequest',
      message: 'Datos inválidos.',
      details: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
    })
    return
  }
  logger.error(`[Impersonation] ${defaultMessage}`, { error: err instanceof Error ? err.message : String(err) })
  res.status(500).json({ error: 'InternalServerError', message: defaultMessage })
}

export async function startHandler(req: Request, res: Response, _next: NextFunction): Promise<void> {
  try {
    const ctx = req.authContext
    if (!ctx) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const realRole = getRealRole(ctx)
    const realUserId = getRealUserId(ctx)
    // Only real SUPERADMINs may start a session — defense-in-depth (service layer enforces this too).
    if (realRole !== StaffRole.SUPERADMIN) {
      res.status(403).json({ error: 'Forbidden', message: 'Solo un SUPERADMIN puede impersonar.' })
      return
    }
    // Cannot start while already in a session — must stop first.
    if (isImpersonatingRequest(ctx)) {
      res.status(400).json({ error: 'BadRequest', message: 'Ya hay una sesión de impersonación activa. Debes salir primero.' })
      return
    }

    const body = startSchema.parse(req.body)
    const { jti, exp } = readCurrentTokenMetadata(req)

    // Use the venueId the frontend sent (venue in URL) if present, otherwise the
    // JWT's venueId. Validates existence for cross-venue requests.
    const effectiveVenueId = await resolveImpersonationVenueId(ctx.venueId, body.venueId)

    // If the caller asked for a different venue than the one in their JWT, look
    // up its organizationId so the impersonation JWT carries the correct orgId
    // (otherwise the downstream access service resolves org from venue anyway,
    // but we want the JWT claim to be coherent).
    let organizationId = ctx.orgId
    if (effectiveVenueId !== ctx.venueId) {
      const venue = await (
        await import('../../utils/prismaClient')
      ).default.venue.findUnique({
        where: { id: effectiveVenueId },
        select: { organizationId: true },
      })
      if (venue?.organizationId) organizationId = venue.organizationId
    }

    const result = await startImpersonation({
      realUserId,
      realRole,
      venueId: effectiveVenueId,
      organizationId,
      mode: body.mode,
      targetUserId: body.targetUserId,
      targetRole: body.targetRole,
      reason: body.reason,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      currentJti: jti,
      currentTokenExp: exp,
    })

    res.cookie('accessToken', result.accessToken, buildAccessTokenCookieOptions(result.cookieMaxAgeMs))

    res.status(200).json({
      success: true,
      impersonation: {
        isImpersonating: true,
        mode: body.mode,
        impersonatedUserId: body.mode === 'user' ? body.targetUserId : null,
        impersonatedRole: result.effectiveRole,
        expiresAt: result.act.expiresAt,
        extensionsUsed: 0,
        reason: result.act.reason ?? null,
      },
    })
  } catch (err) {
    sendImpersonationError(res, err, 'No se pudo iniciar la impersonación.')
  }
}

export async function extendHandler(req: Request, res: Response, _next: NextFunction): Promise<void> {
  try {
    const ctx = req.authContext
    if (!ctx || !isImpersonatingRequest(ctx) || !ctx.impersonation) {
      res.status(400).json({ error: 'BadRequest', message: 'No hay sesión de impersonación activa.' })
      return
    }
    const { jti, exp } = readCurrentTokenMetadata(req)
    if (!jti || !exp) {
      res.status(400).json({ error: 'BadRequest', message: 'Sesión inválida.' })
      return
    }

    const result = await extendImpersonation({
      realUserId: getRealUserId(ctx),
      realRole: getRealRole(ctx),
      venueId: ctx.venueId,
      organizationId: ctx.orgId,
      effectiveUserId: ctx.userId,
      effectiveRole: ctx.role,
      impersonation: ctx.impersonation,
      currentJti: jti,
      currentTokenExp: exp,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    })

    res.cookie('accessToken', result.accessToken, buildAccessTokenCookieOptions(result.cookieMaxAgeMs))

    res.status(200).json({
      success: true,
      impersonation: {
        isImpersonating: true,
        mode: ctx.impersonation.mode,
        impersonatedUserId: ctx.impersonation.impersonatedUserId,
        impersonatedRole: ctx.role,
        expiresAt: result.act.expiresAt,
        extensionsUsed: result.act.extensionsUsed,
        reason: result.act.reason ?? null,
      },
    })
  } catch (err) {
    sendImpersonationError(res, err, 'No se pudo extender la impersonación.')
  }
}

export async function stopHandler(req: Request, res: Response, _next: NextFunction): Promise<void> {
  try {
    const ctx = req.authContext
    if (!ctx || !isImpersonatingRequest(ctx) || !ctx.impersonation) {
      // Idempotent — if nothing to stop, just acknowledge.
      res.status(200).json({ success: true, impersonation: { isImpersonating: false } })
      return
    }
    const { jti, exp } = readCurrentTokenMetadata(req)
    if (!jti || !exp) {
      res.status(400).json({ error: 'BadRequest', message: 'Sesión inválida.' })
      return
    }

    const result = await stopImpersonation({
      realUserId: getRealUserId(ctx),
      realRole: getRealRole(ctx),
      venueId: ctx.venueId,
      organizationId: ctx.orgId,
      impersonation: ctx.impersonation,
      currentJti: jti,
      currentTokenExp: exp,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    })

    res.cookie('accessToken', result.accessToken, buildAccessTokenCookieOptions(result.cookieMaxAgeMs))

    res.status(200).json({
      success: true,
      impersonation: { isImpersonating: false },
    })
  } catch (err) {
    sendImpersonationError(res, err, 'No se pudo terminar la impersonación.')
  }
}

export async function statusHandler(req: Request, res: Response, _next: NextFunction): Promise<void> {
  try {
    const ctx = req.authContext
    if (!ctx) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    res.status(200).json(getImpersonationStatus(ctx.impersonation ?? null, getRealUserId(ctx), getRealRole(ctx)))
  } catch (err) {
    sendImpersonationError(res, err, 'No se pudo obtener el estado de impersonación.')
  }
}

export async function eligibleTargetsHandler(req: Request, res: Response, _next: NextFunction): Promise<void> {
  try {
    const ctx = req.authContext
    if (!ctx) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const realRole = getRealRole(ctx)
    if (realRole !== StaffRole.SUPERADMIN) {
      res.status(403).json({ error: 'Forbidden', message: 'Solo un SUPERADMIN puede consultar targets.' })
      return
    }
    // Optional ?venueId= — the frontend passes the venue currently shown in
    // the URL so targets reflect what the UI sees, not the stale JWT venueId.
    const requestedVenueId = typeof req.query.venueId === 'string' ? req.query.venueId : undefined
    const effectiveVenueId = await resolveImpersonationVenueId(ctx.venueId, requestedVenueId)

    const targets = await getEligibleTargets({ venueId: effectiveVenueId, realUserId: getRealUserId(ctx) })
    res.status(200).json(targets)
  } catch (err) {
    sendImpersonationError(res, err, 'No se pudieron obtener los targets disponibles.')
  }
}
