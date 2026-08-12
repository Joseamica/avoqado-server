/**
 * Access log: who logged in, who logged out, from where.
 *
 * The PITS matrix answers that the access log records "login and logout". That was not
 * true: the only thing audited were EMERGENCY accesses (`MASTER_LOGIN_*`). A normal login
 * only moved `Staff.lastLoginAt`, which keeps the latest one and wipes the previous one —
 * in other words, zero history. And the screen an owner audits reads `ActivityLog` and
 * nothing else, so as far as a compliance auditor was concerned the record did not exist.
 *
 * The delicate part is LOGOUT: that route deliberately carries no authentication
 * middleware (you have to be able to log out with an already-expired token). The identity
 * is taken by verifying the token's SIGNATURE, never by plainly decoding it: otherwise
 * anyone could send a forged cookie and fill the log with logouts under someone else's
 * name. A poisoned log is worse than an incomplete one.
 */

import * as fs from 'fs'
import * as path from 'path'

const SRC = path.join(__dirname, '../../../src')
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8')

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/jwt.service', () => ({ ...jest.requireActual('@/jwt.service'), verifyAccessToken: jest.fn() }))

import { logAction } from '@/services/dashboard/activity-log.service'
import { verifyAccessToken } from '@/jwt.service'
import { dashboardLogoutController } from '@/controllers/dashboard/auth.dashboard.controller'

const mockedVerify = verifyAccessToken as jest.Mock
const mockedLog = logAction as jest.Mock

function fakeReq(over: Record<string, unknown> = {}) {
  return {
    cookies: {},
    headers: {},
    ip: '187.190.1.1',
    get: (h: string) => (h.toLowerCase() === 'user-agent' ? 'Chrome/PITS' : undefined),
    ...over,
  } as never
}

function fakeRes() {
  const res: Record<string, unknown> = {}
  res.clearCookie = jest.fn().mockReturnValue(res)
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res as never
}

beforeEach(() => jest.clearAllMocks())

describe('dashboard logout', () => {
  it('🔴 leaves a record of who logged out, with IP and device', async () => {
    mockedVerify.mockReturnValue({ sub: 'staff-1', venueId: 'venue-1' })

    await dashboardLogoutController(fakeReq({ cookies: { accessToken: 'good-token' } }), fakeRes())

    expect(mockedLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'STAFF_LOGOUT',
        staffId: 'staff-1',
        venueId: 'venue-1',
        ipAddress: '187.190.1.1',
        userAgent: 'Chrome/PITS',
      }),
    )
  })

  it('🔴 SECURITY: an unverifiable token writes NOTHING to the access log', async () => {
    // If we took the identity without verifying the signature, anyone could forge a cookie
    // and record logouts under someone else's name. A fake row in the access log does more
    // damage than a missing row.
    mockedVerify.mockReturnValue(null)

    await dashboardLogoutController(fakeReq({ cookies: { accessToken: 'forged-token' } }), fakeRes())

    expect(mockedLog).not.toHaveBeenCalled()
  })

  it('🔴 and logout still works anyway: nobody can ever get stuck logged in', async () => {
    mockedVerify.mockReturnValue(null)
    const res = fakeRes()

    await dashboardLogoutController(fakeReq({ cookies: { accessToken: 'forged-token' } }), res)

    expect((res as unknown as { clearCookie: jest.Mock }).clearCookie).toHaveBeenCalledWith('accessToken', expect.anything())
    expect((res as unknown as { status: jest.Mock }).status).toHaveBeenCalledWith(200)
  })

  it('🔴 if the access log blows up, the session STILL closes', async () => {
    // Learned the hard way: this controller's catch-all turns any exception into "Error al
    // cerrar sesión". A stumble while writing the access log left the person unable to log
    // out. The access log is best-effort; logging out is not.
    mockedVerify.mockImplementation(() => {
      throw new Error('the access log blew up')
    })
    const res = fakeRes()

    await dashboardLogoutController(fakeReq({ cookies: { accessToken: 'token' } }), res)

    expect((res as unknown as { status: jest.Mock }).status).toHaveBeenCalledWith(200)
  })

  it('a request with no headers breaks nothing', async () => {
    const res = fakeRes()

    await dashboardLogoutController(fakeReq({ headers: undefined }), res)

    expect((res as unknown as { status: jest.Mock }).status).toHaveBeenCalledWith(200)
  })

  it('with no token it writes nothing, and still logs out cleanly', async () => {
    const res = fakeRes()

    await dashboardLogoutController(fakeReq(), res)

    expect(mockedVerify).not.toHaveBeenCalled()
    expect(mockedLog).not.toHaveBeenCalled()
    expect((res as unknown as { status: jest.Mock }).status).toHaveBeenCalledWith(200)
  })

  it('accepts the token from the Bearer header, not only from the cookie', async () => {
    // Mobile apps cannot read httpOnly cookies: they send the token in the header. Without
    // this branch, their logout would never show up in the access log.
    mockedVerify.mockReturnValue({ sub: 'staff-2', venueId: 'venue-2' })

    await dashboardLogoutController(fakeReq({ headers: { authorization: 'Bearer good-token' } }), fakeRes())

    expect(mockedVerify).toHaveBeenCalledWith('good-token')
    expect(mockedLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'STAFF_LOGOUT', staffId: 'staff-2' }))
  })

  it('never decodes without verifying', () => {
    // Static guard: a `jwt.decode` on this route would reopen the impersonation hole.
    const source = read('controllers/dashboard/auth.dashboard.controller.ts')
    const block = source
      .slice(source.indexOf('dashboardLogoutController'), source.indexOf('switchVenueController'))
      .split('\n')
      .filter(line => !line.trim().startsWith('//')) // the comment up there mentions jwt.decode on purpose
      .join('\n')
    expect(block).not.toMatch(/jwt\.decode/)
    expect(block).toContain('verifyAccessToken')
  })
})

describe('all four login paths write to the access log', () => {
  const paths: Array<[string, string, string]> = [
    ['dashboard, password', 'services/dashboard/auth.service.ts', "method: 'password'"],
    ['dashboard, Google', 'services/dashboard/googleOAuth.service.ts', "method: 'google'"],
    ['TPV, PIN', 'services/tpv/auth.tpv.service.ts', "method: 'pin'"],
    ['mobile (iOS/Android)', 'services/mobile/auth.mobile.service.ts', "source: 'mobile'"],
  ]

  it.each(paths)('%s', (_name, file, marker) => {
    const source = read(file)
    expect(source).toContain("action: 'STAFF_LOGIN'")
    expect(source).toContain(marker)
  })

  it('mobile tells passkey apart from password', () => {
    // They are two different entry points in the same file; in a security review it matters
    // which one was used.
    const source = read('services/mobile/auth.mobile.service.ts')
    expect(source).toContain("method: 'passkey'")
    expect(source).toContain("method: 'password'")
  })

  it('PIN login records the terminal serial number', () => {
    // The device is shared across staff: without the serial, "where did they log in from?"
    // has no answer on a terminal.
    expect(read('services/tpv/auth.tpv.service.ts')).toMatch(/action: 'STAFF_LOGIN'[\s\S]{0,300}terminalSerialNumber/)
  })

  it('DECISION: failed attempts are NOT recorded one by one', () => {
    // That is high-frequency noise and it is already covered by ACCOUNT_LOCKED, which is
    // the anomaly an owner actually audits. If someone adds LOGIN_FAILED, let it be on
    // purpose and not by accident.
    const source = read('services/dashboard/auth.service.ts')
    expect(source).not.toContain("action: 'LOGIN_FAILED'")
    expect(source).toContain("action: 'ACCOUNT_LOCKED'")
  })
})
