/**
 * GoogleOAuthSession service (Phase 1).
 *
 * Short-lived (10 minute) one-shot bridge row used to hand the OAuth tokens
 * produced by the redirect callback to the authenticated dashboard session that
 * completes the calendar-selection step.
 *
 * Security properties:
 *   - The session token is generated with `crypto.randomBytes(32)` and never
 *     stored in plaintext — only its SHA-256 hash lives in the DB. A leaked
 *     DB row therefore cannot be replayed against the API.
 *   - `consumeSession` uses `updateMany({ id, consumedAt: null })` so the
 *     atomic UPDATE+returning-count is the single source of truth: only one
 *     concurrent call can succeed.
 *   - `loadAndAuthorizeSession` enforces caller identity matches the user that
 *     started the OAuth flow. Cross-user consumption is only permitted when the
 *     caller has `calendar:disconnect_staff` (audit-able admin action).
 */
import crypto from 'crypto'
import { Prisma, PrismaClient, StaffRole } from '@prisma/client'

import prisma from '@/utils/prismaClient'
import { ConflictError, ForbiddenError, NotFoundError } from '@/errors/AppError'
import { AuthContext } from '@/security'

const SESSION_TTL_MS = 10 * 60 * 1000

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

export interface CreateOAuthSessionArgs {
  authUserId: string
  intent: 'staff_personal' | 'venue_master'
  venueId?: string
  staffId?: string
  encryptedRefreshToken: Buffer
  encryptedAccessToken: Buffer
  accessTokenExpiresAt: Date
  googleAccountEmail: string
  googleAccountSub: string
}

export async function createOAuthSession(args: CreateOAuthSessionArgs) {
  const sessionToken = crypto.randomBytes(32).toString('hex')
  const tokenHash = sha256(sessionToken)

  const session = await prisma.googleOAuthSession.create({
    data: {
      tokenHash,
      authUserId: args.authUserId,
      intent: args.intent,
      venueId: args.venueId,
      staffId: args.staffId,
      encryptedRefreshToken: args.encryptedRefreshToken,
      encryptedAccessToken: args.encryptedAccessToken,
      accessTokenExpiresAt: args.accessTokenExpiresAt,
      googleAccountEmail: args.googleAccountEmail,
      googleAccountSub: args.googleAccountSub,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  })

  return { sessionToken, session }
}

/**
 * Looks up the session by hash, validates it (not expired / not consumed),
 * then enforces caller identity. Throws an AppError-derived class so the global
 * error middleware maps it to the right HTTP status.
 *
 * Notes for callers:
 *  - This does NOT consume the session — call `consumeSession` after you
 *    successfully create the connection row inside the same transaction.
 *  - For `staff_personal` intent, the session is only consumable by the staff
 *    that started the OAuth flow. An OWNER/ADMIN with `calendar:disconnect_staff`
 *    may consume on behalf of another staff member (audit case).
 */
export async function loadAndAuthorizeSession(sessionToken: string, ctx: AuthContext) {
  const tokenHash = sha256(sessionToken)
  const session = await prisma.googleOAuthSession.findUnique({ where: { tokenHash } })

  if (!session) throw new NotFoundError('oauth_session_not_found')
  if (session.consumedAt) throw new ConflictError('oauth_session_already_consumed')
  if (session.expiresAt < new Date()) throw new ConflictError('oauth_session_expired')

  // Strict same-user rule: the staff that started the OAuth flow is the only
  // one allowed to consume the bridge row. The dashboard delivers the session
  // token in a signed cookie scoped to the same session that initiated the
  // redirect, so a mismatch here means token replay / session-bridge tampering.
  if (session.authUserId !== ctx.userId) {
    throw new ForbiddenError('oauth_session_user_mismatch', 'OAUTH_SESSION_USER_MISMATCH')
  }

  // Audit case: an OWNER/ADMIN starts a `staff_personal` flow on behalf of a
  // colleague (rare — typically used to force-disconnect after an offboarding).
  // `authUserId` and `staffId` differ at the start, but only privileged callers
  // may complete the connection. Role check keeps the service DB-free; the
  // controller must re-verify the permission via middleware.
  if (session.intent === 'staff_personal' && session.staffId && session.staffId !== session.authUserId) {
    const isAdminLike = ctx.role === StaffRole.OWNER || ctx.role === StaffRole.ADMIN || ctx.role === StaffRole.SUPERADMIN
    if (!isAdminLike) {
      throw new ForbiddenError('cross_user_oauth_denied', 'CROSS_USER_OAUTH_DENIED')
    }
  }

  return session
}

/**
 * Atomically marks a session consumed. Pass a transaction client when consuming
 * inside the same transaction that creates the connection row — that's the only
 * way to guarantee "tokens are written exactly once".
 */
export async function consumeSession(tx: Prisma.TransactionClient | PrismaClient, sessionId: string): Promise<void> {
  const res = await tx.googleOAuthSession.updateMany({
    where: { id: sessionId, consumedAt: null },
    data: { consumedAt: new Date() },
  })
  if (res.count === 0) throw new ConflictError('oauth_session_already_consumed')
}
