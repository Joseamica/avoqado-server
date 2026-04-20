import { StaffRole } from '@prisma/client'

/**
 * Impersonation mode.
 * - 'user': Impersonate a specific staff member within the venue. Their userId becomes the JWT sub.
 * - 'role': Impersonate a role only (permission lens). The superadmin stays as sub; only the role is swapped.
 */
export type ImpersonationMode = 'user' | 'role'

/**
 * The `act` claim embedded in the JWT during impersonation sessions.
 *
 * Follows the OAuth 2.0 Token Exchange (RFC 8693) `act` claim pattern:
 * when present, it identifies the real actor who initiated the session
 * while the JWT's `sub` reflects the identity being impersonated (user mode)
 * or still the actor (role mode).
 *
 * Presence of this claim is the signal that the session is an impersonation session.
 */
export interface ImpersonationActClaim {
  /** Real actor (the SUPERADMIN who started impersonation). Used for audit. */
  sub: string

  /** Real actor's role — always SUPERADMIN in v1. */
  role: StaffRole

  /** Whether we're impersonating a specific user or just a role. */
  mode: ImpersonationMode

  /** Absolute Unix timestamp (seconds) when the impersonation session expires. */
  expiresAt: number

  /** How many +15min extensions have been used. Max 2. */
  extensionsUsed: number

  /** Short human-readable reason for the session, captured at /start. Stored in audit log. */
  reason?: string
}

/**
 * Runtime context for impersonation, derived from the `act` claim and exposed on `req.authContext`.
 */
export interface ImpersonationContext {
  mode: ImpersonationMode
  /** Impersonated user ID (only set in 'user' mode; null in 'role' mode). */
  impersonatedUserId: string | null
  /** Impersonated role (target role, never SUPERADMIN). */
  impersonatedRole: StaffRole
  /** Unix seconds when the session expires. Source of truth is the signed JWT. */
  expiresAt: number
  extensionsUsed: number
  reason?: string
}

/**
 * Error codes surfaced to the frontend when impersonation rules reject a request.
 */
export const IMPERSONATION_ERROR_CODES = {
  EXPIRED: 'IMPERSONATION_EXPIRED',
  READ_ONLY: 'IMPERSONATION_READ_ONLY',
  BLOCKED_ROUTE: 'IMPERSONATION_BLOCKED_ROUTE',
  TARGET_INVALID: 'IMPERSONATION_TARGET_INVALID',
  NESTED_NOT_ALLOWED: 'IMPERSONATION_NESTED_NOT_ALLOWED',
  NOT_SUPERADMIN: 'IMPERSONATION_NOT_SUPERADMIN',
  INVALID_TARGET: 'IMPERSONATION_INVALID_TARGET',
  MAX_EXTENSIONS: 'IMPERSONATION_MAX_EXTENSIONS',
  NOT_ACTIVE: 'IMPERSONATION_NOT_ACTIVE',
} as const

export type ImpersonationErrorCode = (typeof IMPERSONATION_ERROR_CODES)[keyof typeof IMPERSONATION_ERROR_CODES]

/** Maximum number of +15 min extensions allowed per session. */
export const MAX_IMPERSONATION_EXTENSIONS = 2

/** Initial session length in seconds (15 min). */
export const IMPERSONATION_INITIAL_DURATION_SECONDS = 15 * 60

/** Per-extension duration in seconds (15 min). */
export const IMPERSONATION_EXTENSION_DURATION_SECONDS = 15 * 60

/** Minimum characters required for the reason field at /start. */
export const IMPERSONATION_REASON_MIN_LENGTH = 10
