/**
 * "Cerrar sesión en todos mis dispositivos" — option A of the revocation work.
 *
 * The tokens are self-contained JWTs, so the only lever that kills a live
 * session is the cutoff `passwordChangeGuard` compares each token's `iat`
 * against. Until now that cutoff had exactly one trigger: changing the
 * password. That covers "I fired someone", but not "I left a tablet with my
 * session open in a taxi" — the owner had to change their own password (and
 * memorise a new one) to get out of a device they no longer hold.
 *
 * So the cutoff grows a second trigger, `Staff.sessionsRevokedAt`, and the
 * guard takes whichever of the two is LATER. One comparison, two reasons.
 */
import prisma from '@/utils/prismaClient'
import {
  sesionInvalidadaPorCambioDeContrasena,
  _limpiarCacheDeCambiosDeContrasena,
  revokeAllSessions,
  motivoDeSesionInvalidada,
} from '../../../src/utils/passwordChangeGuard'

const prismaMock = prisma as any
const iatOf = (d: Date) => Math.floor(d.getTime() / 1000)
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000)

beforeEach(() => {
  _limpiarCacheDeCambiosDeContrasena()
  prismaMock.staff.findUnique.mockReset()
  prismaMock.staff.update.mockReset()
  prismaMock.staff.update.mockResolvedValue({ id: 'staff_1' })
})

describe('the session cutoff has two triggers', () => {
  it('🔴 kicks a token issued before a manual revoke, with no password change at all', async () => {
    prismaMock.staff.findUnique.mockResolvedValue({ lastPasswordReset: null, sessionsRevokedAt: minutesAgo(1) })

    expect(await sesionInvalidadaPorCambioDeContrasena('staff_1', iatOf(minutesAgo(60)))).toBe(true)
  })

  it('takes whichever trigger is LATER — a recent revoke beats an old password change', async () => {
    prismaMock.staff.findUnique.mockResolvedValue({
      lastPasswordReset: minutesAgo(60 * 24 * 30),
      sessionsRevokedAt: minutesAgo(1),
    })

    expect(await sesionInvalidadaPorCambioDeContrasena('staff_1', iatOf(minutesAgo(10)))).toBe(true)
  })

  it('and the other way round — a recent password change beats an old revoke', async () => {
    prismaMock.staff.findUnique.mockResolvedValue({
      lastPasswordReset: minutesAgo(1),
      sessionsRevokedAt: minutesAgo(60 * 24 * 30),
    })

    expect(await sesionInvalidadaPorCambioDeContrasena('staff_1', iatOf(minutesAgo(10)))).toBe(true)
  })

  it('lets the session that was opened AFTER the revoke survive — otherwise the button locks you out for good', async () => {
    prismaMock.staff.findUnique.mockResolvedValue({ lastPasswordReset: null, sessionsRevokedAt: minutesAgo(10) })

    expect(await sesionInvalidadaPorCambioDeContrasena('staff_1', iatOf(minutesAgo(1)))).toBe(false)
  })

  // REGRESSION — neither trigger set is still the case for almost every account.
  it('kicks nobody when neither trigger has ever fired', async () => {
    prismaMock.staff.findUnique.mockResolvedValue({ lastPasswordReset: null, sessionsRevokedAt: null })

    expect(await sesionInvalidadaPorCambioDeContrasena('staff_1', iatOf(minutesAgo(60 * 24 * 90)))).toBe(false)
  })
})

describe('revokeAllSessions', () => {
  it('stamps sessionsRevokedAt', async () => {
    const before = Date.now()

    await revokeAllSessions('staff_1')

    const args = prismaMock.staff.update.mock.calls.at(-1)![0]
    expect(args.where).toEqual({ id: 'staff_1' })
    expect(args.data.sessionsRevokedAt.getTime()).toBeGreaterThanOrEqual(before)
  })

  it('🔴 takes effect immediately: it drops the cached cutoff instead of waiting out the TTL', async () => {
    // Warm the cache with "nothing revoked" — this is the state of anyone who
    // used the app in the last 30 seconds, which is exactly the person pressing
    // the button. Without dropping it, the stolen tablet keeps working.
    prismaMock.staff.findUnique.mockResolvedValue({ lastPasswordReset: null, sessionsRevokedAt: null })
    expect(await sesionInvalidadaPorCambioDeContrasena('staff_1', iatOf(minutesAgo(60)))).toBe(false)

    await revokeAllSessions('staff_1')

    prismaMock.staff.findUnique.mockResolvedValue({ lastPasswordReset: null, sessionsRevokedAt: new Date() })
    expect(await sesionInvalidadaPorCambioDeContrasena('staff_1', iatOf(minutesAgo(60)))).toBe(true)
  })
})

describe('the message must match the trigger', () => {
  it('🔴 says SESSIONS_REVOKED when nobody touched the password', async () => {
    prismaMock.staff.findUnique.mockResolvedValue({ lastPasswordReset: null, sessionsRevokedAt: minutesAgo(1) })

    // Telling someone who just pressed "close my sessions" that their password
    // changed sends them to password recovery for a problem that doesn't exist.
    expect(await motivoDeSesionInvalidada('staff_1', iatOf(minutesAgo(60)))).toBe('SESSIONS_REVOKED')
  })

  it('says PASSWORD_CHANGED when that is what happened', async () => {
    prismaMock.staff.findUnique.mockResolvedValue({ lastPasswordReset: minutesAgo(1), sessionsRevokedAt: null })

    expect(await motivoDeSesionInvalidada('staff_1', iatOf(minutesAgo(60)))).toBe('PASSWORD_CHANGED')
  })

  it('reports the trigger that actually cut the session, not the older one', async () => {
    prismaMock.staff.findUnique.mockResolvedValue({
      lastPasswordReset: minutesAgo(60 * 24),
      sessionsRevokedAt: minutesAgo(1),
    })

    expect(await motivoDeSesionInvalidada('staff_1', iatOf(minutesAgo(10)))).toBe('SESSIONS_REVOKED')
  })

  it('returns null for a session that survives', async () => {
    prismaMock.staff.findUnique.mockResolvedValue({ lastPasswordReset: null, sessionsRevokedAt: minutesAgo(10) })

    expect(await motivoDeSesionInvalidada('staff_1', iatOf(minutesAgo(1)))).toBeNull()
  })
})
