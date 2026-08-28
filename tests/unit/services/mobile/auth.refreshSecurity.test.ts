/**
 * The mobile refresh rail must close a session as hard as the middleware does.
 *
 * Found in production by a Codex audit (2026-08-27). `authenticateTokenMiddleware`
 * rejects an access token issued before the last password change, and the TPV
 * refresh does the same — but the MOBILE refresh checked neither. So the owner
 * fired a manager, changed the password, and nothing happened: the phone's
 * access token died, the app silently refreshed, and out came a new one with a
 * fresh `iat` that sailed straight past the guard. A session has to be closed on
 * BOTH rails or it isn't closed at all.
 *
 * Same file, second hole: the refresh read `venue.status` and never looked at
 * it, so a SUSPENDED / ADMIN_SUSPENDED / CLOSED venue kept minting tokens.
 */
import prisma from '../../../../src/utils/prismaClient'
import * as jwtService from '../../../../src/jwt.service'
import { refreshAccessToken } from '../../../../src/services/mobile/auth.mobile.service'
import { _limpiarCacheDeCambiosDeContrasena } from '../../../../src/utils/passwordChangeGuard'

const prismaMock = prisma as any

const venue = (id: string, status = 'ACTIVE') => ({
  venueId: id,
  role: 'MANAGER',
  venue: { id, status, organizationId: 'org_1', timezone: 'America/Mexico_City' },
})

const STAFF_ID = 'staff_1'

/** Seconds since the epoch, N minutes ago — the `iat` of a token issued back then. */
const iatMinutesAgo = (minutes: number) => Math.floor((Date.now() - minutes * 60_000) / 1000)

/**
 * The staff row the service reads, and (separately) the password-change date the
 * guard reads. Both come from `staff.findUnique`, told apart by their `select`.
 */
function primeStaff(venues: ReturnType<typeof venue>[], lastPasswordReset: Date | null) {
  prismaMock.staff.findUnique.mockImplementation((args: any) => {
    if (args?.select?.lastPasswordReset) return Promise.resolve({ lastPasswordReset })
    return Promise.resolve({ id: STAFF_ID, email: 'gerente@local.com', active: true, venues })
  })
}

function refreshTokenIssued(iat: number, venueId?: string) {
  jest.spyOn(jwtService, 'verifyRefreshToken').mockReturnValue({ sub: STAFF_ID, tokenId: 't1', iat, venueId } as any)
}

/** The venueId sealed into the access token that was just minted. */
function venueOfMintedToken(): string {
  const call = (jwtService.generateAccessToken as jest.Mock).mock.calls.at(-1)!
  return call[2] as string
}

beforeEach(() => {
  jest.restoreAllMocks()
  _limpiarCacheDeCambiosDeContrasena()
  prismaMock.staff.findUnique.mockReset()
  jest.spyOn(jwtService, 'generateAccessToken').mockReturnValue('new-access')
  jest.spyOn(jwtService, 'generateRefreshToken').mockReturnValue('new-refresh')
})

describe('mobile refreshAccessToken — password change', () => {
  it('🔴 refuses a refresh token issued BEFORE the last password change', async () => {
    primeStaff([venue('venue_1')], new Date())
    refreshTokenIssued(iatMinutesAgo(60), 'venue_1')

    await expect(refreshAccessToken('stolen-refresh')).rejects.toThrow(/contraseña/i)
    expect(jwtService.generateAccessToken).not.toHaveBeenCalled()
  })

  it('lets through a token issued AFTER the change — the new session must survive', async () => {
    primeStaff([venue('venue_1')], new Date(Date.now() - 60 * 60_000))
    refreshTokenIssued(iatMinutesAgo(1), 'venue_1')

    await expect(refreshAccessToken('fresh-refresh')).resolves.toMatchObject({ accessToken: 'new-access' })
  })

  it('does not lock out anyone who never changed their password (most accounts today)', async () => {
    primeStaff([venue('venue_1')], null)
    refreshTokenIssued(iatMinutesAgo(60 * 24 * 30), 'venue_1')

    await expect(refreshAccessToken('old-refresh')).resolves.toMatchObject({ accessToken: 'new-access' })
  })

  it('fails OPEN: a database error must not log every customer out at once', async () => {
    prismaMock.staff.findUnique.mockImplementation((args: any) => {
      if (args?.select?.lastPasswordReset) return Promise.reject(new Error('db down'))
      return Promise.resolve({ id: STAFF_ID, email: 'gerente@local.com', active: true, venues: [venue('venue_1')] })
    })
    refreshTokenIssued(iatMinutesAgo(60), 'venue_1')

    await expect(refreshAccessToken('any-refresh')).resolves.toMatchObject({ accessToken: 'new-access' })
  })
})

describe('mobile refreshAccessToken — non-operational venue', () => {
  it.each(['SUSPENDED', 'ADMIN_SUSPENDED', 'CLOSED'])('🔴 refuses to renew a session on a %s venue', async status => {
    primeStaff([venue('venue_1', status)], null)
    refreshTokenIssued(iatMinutesAgo(1), 'venue_1')

    await expect(refreshAccessToken('any-refresh')).rejects.toThrow(/operativo/i)
    expect(jwtService.generateAccessToken).not.toHaveBeenCalled()
  })

  it('🔴 refuses an explicit switch INTO a suspended venue', async () => {
    primeStaff([venue('venue_ok'), venue('venue_suspended', 'SUSPENDED')], null)
    refreshTokenIssued(iatMinutesAgo(1), 'venue_ok')

    await expect(refreshAccessToken('any-refresh', 'venue_suspended')).rejects.toThrow(/operativo/i)
  })

  it('falls back to an operational venue when the one in the token got suspended', async () => {
    primeStaff([venue('venue_ok'), venue('venue_suspended', 'ADMIN_SUSPENDED')], null)
    refreshTokenIssued(iatMinutesAgo(1), 'venue_suspended')

    await refreshAccessToken('any-refresh')

    expect(venueOfMintedToken()).toBe('venue_ok')
  })

  // REGRESSION — the statuses that must keep working, or a whole tier of
  // customers (onboarding, trials, the public demo) loses its session.
  it.each(['LIVE_DEMO', 'TRIAL', 'ONBOARDING', 'PENDING_ACTIVATION', 'ACTIVE'])('still renews on a %s venue', async status => {
    primeStaff([venue('venue_1', status)], null)
    refreshTokenIssued(iatMinutesAgo(1), 'venue_1')

    await expect(refreshAccessToken('any-refresh')).resolves.toMatchObject({ accessToken: 'new-access' })
  })

  // REGRESSION — the venue the token carries is still honoured (auth.refreshVenue.test.ts).
  it('still keeps the venue the refresh token carried', async () => {
    primeStaff([venue('venue_first'), venue('venue_working')], null)
    refreshTokenIssued(iatMinutesAgo(1), 'venue_working')

    await refreshAccessToken('any-refresh')

    expect(venueOfMintedToken()).toBe('venue_working')
  })
})
