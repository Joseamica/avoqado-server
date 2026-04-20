/**
 * Impersonation Service
 *
 * Backend logic for the SUPERADMIN impersonation feature.
 *
 * See: avoqado-web-dashboard/docs/superpowers/specs/2026-04-20-superadmin-impersonation-design.md
 */
import { StaffRole } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { generateAccessToken, generateImpersonationAccessToken } from '../../jwt.service'
import { revokeJti } from '../../utils/tokenRevocation'
import { logAction } from './activity-log.service'
import {
  ImpersonationActClaim,
  ImpersonationMode,
  ImpersonationContext,
  IMPERSONATION_ERROR_CODES,
  IMPERSONATION_INITIAL_DURATION_SECONDS,
  IMPERSONATION_EXTENSION_DURATION_SECONDS,
  IMPERSONATION_REASON_MIN_LENGTH,
  MAX_IMPERSONATION_EXTENSIONS,
} from '../../types/impersonation'

export class ImpersonationError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ImpersonationError'
  }
}

export interface StartImpersonationParams {
  realUserId: string
  realRole: StaffRole
  venueId: string
  organizationId: string
  mode: ImpersonationMode
  targetUserId?: string
  targetRole?: StaffRole
  reason: string
  ipAddress?: string
  userAgent?: string
  /** The `jti` of the current token being replaced, for revocation. */
  currentJti?: string
  /** Unix seconds when the current token would have expired (for revocation TTL). */
  currentTokenExp?: number
}

export interface StartImpersonationResult {
  accessToken: string
  /** The full JWT payload's `act` claim for convenience. */
  act: ImpersonationActClaim
  /** Cookie Max-Age in ms. */
  cookieMaxAgeMs: number
  /** The effective role the session will see. */
  effectiveRole: StaffRole
  /** The user id embedded as `sub` in the new token (target for user-mode, superadmin for role-mode). */
  effectiveUserId: string
}

/**
 * Start an impersonation session.
 *
 * Validates that the caller is a real SUPERADMIN, that the target is valid, and
 * that the mode-specific parameters are present. On success, issues a new JWT
 * with the RFC 8693 `act` claim and revokes the previous token.
 *
 * The controller is responsible for setting the resulting cookie on the response.
 */
export async function startImpersonation(params: StartImpersonationParams): Promise<StartImpersonationResult> {
  // Guard 1: only real SUPERADMIN may start impersonation. Defends against nested impersonation.
  if (params.realRole !== StaffRole.SUPERADMIN) {
    throw new ImpersonationError(403, IMPERSONATION_ERROR_CODES.NOT_SUPERADMIN, 'Solo un SUPERADMIN puede impersonar.')
  }

  // Guard 2: reason must be meaningful — this is audit metadata.
  const trimmedReason = (params.reason ?? '').trim()
  if (trimmedReason.length < IMPERSONATION_REASON_MIN_LENGTH) {
    throw new ImpersonationError(
      400,
      IMPERSONATION_ERROR_CODES.INVALID_TARGET,
      `El motivo es requerido (mínimo ${IMPERSONATION_REASON_MIN_LENGTH} caracteres).`,
    )
  }

  let effectiveUserId: string
  let effectiveRole: StaffRole

  if (params.mode === 'user') {
    if (!params.targetUserId) {
      throw new ImpersonationError(400, IMPERSONATION_ERROR_CODES.INVALID_TARGET, 'targetUserId es requerido para mode=user.')
    }
    if (params.targetUserId === params.realUserId) {
      throw new ImpersonationError(400, IMPERSONATION_ERROR_CODES.INVALID_TARGET, 'No puedes impersonarte a ti mismo.')
    }

    // Look up the target's StaffVenue to get their role and confirm active membership.
    const staffVenue = await prisma.staffVenue.findFirst({
      where: {
        staffId: params.targetUserId,
        venueId: params.venueId,
        active: true,
      },
      select: { role: true, staff: { select: { id: true, active: true } } },
    })

    if (!staffVenue) {
      throw new ImpersonationError(
        404,
        IMPERSONATION_ERROR_CODES.INVALID_TARGET,
        'El usuario objetivo no pertenece a este venue o está inactivo.',
      )
    }
    if (!staffVenue.staff.active) {
      throw new ImpersonationError(404, IMPERSONATION_ERROR_CODES.INVALID_TARGET, 'La cuenta del usuario objetivo está deshabilitada.')
    }
    if (staffVenue.role === StaffRole.SUPERADMIN) {
      throw new ImpersonationError(403, IMPERSONATION_ERROR_CODES.INVALID_TARGET, 'No puedes impersonar a otro SUPERADMIN.')
    }

    effectiveUserId = params.targetUserId
    effectiveRole = staffVenue.role
  } else if (params.mode === 'role') {
    if (!params.targetRole) {
      throw new ImpersonationError(400, IMPERSONATION_ERROR_CODES.INVALID_TARGET, 'targetRole es requerido para mode=role.')
    }
    if (params.targetRole === StaffRole.SUPERADMIN) {
      throw new ImpersonationError(403, IMPERSONATION_ERROR_CODES.INVALID_TARGET, 'No puedes impersonar el rol SUPERADMIN.')
    }
    if (!Object.values(StaffRole).includes(params.targetRole)) {
      throw new ImpersonationError(400, IMPERSONATION_ERROR_CODES.INVALID_TARGET, 'Rol objetivo inválido.')
    }
    // Role mode: stays as SUPERADMIN's sub, only the role is swapped.
    effectiveUserId = params.realUserId
    effectiveRole = params.targetRole
  } else {
    throw new ImpersonationError(400, IMPERSONATION_ERROR_CODES.INVALID_TARGET, 'mode debe ser "user" o "role".')
  }

  const nowSeconds = Math.floor(Date.now() / 1000)
  const expiresAt = nowSeconds + IMPERSONATION_INITIAL_DURATION_SECONDS

  const act: ImpersonationActClaim = {
    sub: params.realUserId,
    role: params.realRole,
    mode: params.mode,
    expiresAt,
    extensionsUsed: 0,
    reason: trimmedReason,
  }

  const accessToken = generateImpersonationAccessToken(effectiveUserId, params.organizationId, params.venueId, effectiveRole, act)

  // Revoke the previous (non-impersonation) token so it cannot be reused to bypass the new read-only session.
  if (params.currentJti && params.currentTokenExp) {
    const ttl = Math.max(0, params.currentTokenExp - nowSeconds)
    await revokeJti(params.currentJti, ttl)
  }

  // Audit — fire-and-forget.
  logAction({
    staffId: params.realUserId,
    venueId: params.venueId,
    action: 'impersonation.start',
    entity: 'Staff',
    entityId: params.targetUserId ?? params.realUserId,
    data: {
      mode: params.mode,
      targetUserId: params.targetUserId ?? null,
      targetRole: effectiveRole,
      expiresAt,
      reason: trimmedReason,
    },
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  })

  logger.info('[Impersonation] Session started', {
    realUserId: params.realUserId,
    venueId: params.venueId,
    mode: params.mode,
    targetUserId: params.targetUserId,
    targetRole: effectiveRole,
    expiresAt,
  })

  return {
    accessToken,
    act,
    cookieMaxAgeMs: IMPERSONATION_INITIAL_DURATION_SECONDS * 1000,
    effectiveRole,
    effectiveUserId,
  }
}

export interface ExtendImpersonationParams {
  realUserId: string
  realRole: StaffRole
  venueId: string
  organizationId: string
  /** Current effective sub embedded in the JWT (impersonated user or superadmin for role-mode). */
  effectiveUserId: string
  /** Current effective role embedded in the JWT. */
  effectiveRole: StaffRole
  /** Current impersonation context (from req.authContext.impersonation). */
  impersonation: ImpersonationContext
  currentJti: string
  currentTokenExp: number
  ipAddress?: string
  userAgent?: string
}

export interface ExtendImpersonationResult {
  accessToken: string
  act: ImpersonationActClaim
  cookieMaxAgeMs: number
}

/**
 * Extend an active impersonation session by 15 min. Max 2 extensions per session (45 min total cap).
 */
export async function extendImpersonation(params: ExtendImpersonationParams): Promise<ExtendImpersonationResult> {
  if (!params.impersonation) {
    throw new ImpersonationError(400, IMPERSONATION_ERROR_CODES.NOT_ACTIVE, 'No hay sesión de impersonación activa.')
  }

  if (params.impersonation.extensionsUsed >= MAX_IMPERSONATION_EXTENSIONS) {
    throw new ImpersonationError(
      400,
      IMPERSONATION_ERROR_CODES.MAX_EXTENSIONS,
      `Alcanzaste el máximo de ${MAX_IMPERSONATION_EXTENSIONS} extensiones. Debes salir y reiniciar la impersonación.`,
    )
  }

  const nowSeconds = Math.floor(Date.now() / 1000)
  // Extend from current expiresAt if still in the future, otherwise from now.
  const base = Math.max(nowSeconds, params.impersonation.expiresAt)
  const newExpiresAt = base + IMPERSONATION_EXTENSION_DURATION_SECONDS
  const newExtensionsUsed = params.impersonation.extensionsUsed + 1

  const act: ImpersonationActClaim = {
    sub: params.realUserId,
    role: params.realRole,
    mode: params.impersonation.mode,
    expiresAt: newExpiresAt,
    extensionsUsed: newExtensionsUsed,
    ...(params.impersonation.reason ? { reason: params.impersonation.reason } : {}),
  }

  const accessToken = generateImpersonationAccessToken(
    params.effectiveUserId,
    params.organizationId,
    params.venueId,
    params.effectiveRole,
    act,
  )

  // Revoke previous token so it cannot be reused.
  const ttl = Math.max(0, params.currentTokenExp - nowSeconds)
  await revokeJti(params.currentJti, ttl)

  logAction({
    staffId: params.realUserId,
    venueId: params.venueId,
    action: 'impersonation.extend',
    entity: 'Staff',
    entityId: params.impersonation.impersonatedUserId ?? params.realUserId,
    data: {
      mode: params.impersonation.mode,
      targetUserId: params.impersonation.impersonatedUserId ?? null,
      targetRole: params.effectiveRole,
      expiresAt: newExpiresAt,
      extensionsUsed: newExtensionsUsed,
    },
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  })

  return {
    accessToken,
    act,
    cookieMaxAgeMs: (newExpiresAt - nowSeconds) * 1000,
  }
}

export interface StopImpersonationParams {
  realUserId: string
  realRole: StaffRole
  venueId: string
  organizationId: string
  impersonation: ImpersonationContext
  currentJti: string
  currentTokenExp: number
  ipAddress?: string
  userAgent?: string
}

export interface StopImpersonationResult {
  /** A freshly-issued non-impersonation access token for the SUPERADMIN. */
  accessToken: string
  /** Cookie Max-Age in ms — matches the superadmin's normal 24h session. */
  cookieMaxAgeMs: number
}

/**
 * Terminate an active impersonation session.
 * Revokes the impersonation token and issues a fresh normal access token for the superadmin.
 */
export async function stopImpersonation(params: StopImpersonationParams): Promise<StopImpersonationResult> {
  if (!params.impersonation) {
    throw new ImpersonationError(400, IMPERSONATION_ERROR_CODES.NOT_ACTIVE, 'No hay sesión de impersonación activa.')
  }

  // Issue a fresh non-impersonation token for the superadmin.
  const accessToken = generateAccessToken(params.realUserId, params.organizationId, params.venueId, params.realRole, /* rememberMe */ false)

  // Revoke the impersonation token.
  const nowSeconds = Math.floor(Date.now() / 1000)
  const ttl = Math.max(0, params.currentTokenExp - nowSeconds)
  await revokeJti(params.currentJti, ttl)

  logAction({
    staffId: params.realUserId,
    venueId: params.venueId,
    action: 'impersonation.stop',
    entity: 'Staff',
    entityId: params.impersonation.impersonatedUserId ?? params.realUserId,
    data: {
      mode: params.impersonation.mode,
      targetUserId: params.impersonation.impersonatedUserId ?? null,
      targetRole: params.impersonation.impersonatedRole,
      extensionsUsed: params.impersonation.extensionsUsed,
    },
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  })

  return {
    accessToken,
    cookieMaxAgeMs: 24 * 60 * 60 * 1000,
  }
}

export interface EligibleTarget {
  id: string
  firstName: string
  lastName: string
  email: string
  photoUrl: string | null
  role: StaffRole
}

export interface EligibleTargetsResult {
  users: EligibleTarget[]
  /** Non-SUPERADMIN roles available as role-only impersonation targets. */
  roles: StaffRole[]
}

/**
 * Fetch the staff members a SUPERADMIN may impersonate within a specific venue,
 * plus the list of non-SUPERADMIN roles available for role-only impersonation.
 */
export async function getEligibleTargets(params: { venueId: string; realUserId: string }): Promise<EligibleTargetsResult> {
  const staffVenues = await prisma.staffVenue.findMany({
    where: {
      venueId: params.venueId,
      active: true,
      role: { not: StaffRole.SUPERADMIN },
      staffId: { not: params.realUserId },
      staff: { active: true },
    },
    select: {
      role: true,
      staff: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          photoUrl: true,
        },
      },
    },
    orderBy: [{ staff: { firstName: 'asc' } }, { staff: { lastName: 'asc' } }],
  })

  const users: EligibleTarget[] = staffVenues.map(sv => ({
    id: sv.staff.id,
    firstName: sv.staff.firstName,
    lastName: sv.staff.lastName,
    email: sv.staff.email,
    photoUrl: sv.staff.photoUrl,
    role: sv.role,
  }))

  const roles: StaffRole[] = Object.values(StaffRole).filter(r => r !== StaffRole.SUPERADMIN)

  return { users, roles }
}

export interface ImpersonationStatusResult {
  isImpersonating: boolean
  mode: ImpersonationMode | null
  impersonatedUserId: string | null
  impersonatedRole: StaffRole | null
  expiresAt: number | null
  extensionsUsed: number
  maxExtensions: number
  reason: string | null
  /**
   * Real actor's role (always SUPERADMIN in v1). Exposed so the frontend knows
   * "this user is a SUPERADMIN right now" even when the effective `role` in
   * AuthContext is the impersonated one (e.g., WAITER) — without this, the
   * frontend can't reliably show SUPERADMIN-only UI elements like the exit
   * button after a reload.
   */
  realRole: StaffRole | null
  /** Real actor's staffId, for display/diagnostics. */
  realUserId: string | null
}

/**
 * Returns the current impersonation state from the request's authContext.
 * Cheap, does not hit the database.
 */
export function getImpersonationStatus(
  impersonation: ImpersonationContext | null,
  realUserId?: string,
  realRole?: StaffRole,
): ImpersonationStatusResult {
  if (!impersonation) {
    return {
      isImpersonating: false,
      mode: null,
      impersonatedUserId: null,
      impersonatedRole: null,
      expiresAt: null,
      extensionsUsed: 0,
      maxExtensions: MAX_IMPERSONATION_EXTENSIONS,
      reason: null,
      realRole: realRole ?? null,
      realUserId: realUserId ?? null,
    }
  }

  return {
    isImpersonating: true,
    mode: impersonation.mode,
    impersonatedUserId: impersonation.impersonatedUserId,
    impersonatedRole: impersonation.impersonatedRole,
    expiresAt: impersonation.expiresAt,
    extensionsUsed: impersonation.extensionsUsed,
    maxExtensions: MAX_IMPERSONATION_EXTENSIONS,
    reason: impersonation.reason ?? null,
    realRole: realRole ?? null,
    realUserId: realUserId ?? null,
  }
}
