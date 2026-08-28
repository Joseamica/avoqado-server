/**
 * "Cerrar sesión en todos mis dispositivos", hung off the sign-out itself.
 *
 * Square does it here and not as a separate setting: signing out offers "this
 * session" or "all sessions", and "all" reaches the Dashboard, the POS and the
 * KDS alike. Same shape here — one flag on the logout the client already calls.
 *
 * 🔴 The identity MUST come from the token's SIGNATURE, never `jwt.decode`.
 * This route deliberately carries no auth middleware (you have to be able to
 * sign out with an expired token), so a decoded-not-verified `sub` would let
 * anyone post a forged cookie and kill every session of any staff id they can
 * guess — a one-request lockout of the owner.
 */
import { StaffRole } from '@prisma/client'

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/utils/passwordChangeGuard', () => ({ revokeAllSessions: jest.fn().mockResolvedValue(new Date()) }))

import jwt from 'jsonwebtoken'
import { generateAccessToken } from '@/jwt.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { revokeAllSessions } from '@/utils/passwordChangeGuard'
import { dashboardLogoutController } from '@/controllers/dashboard/auth.dashboard.controller'

const mockedRevoke = revokeAllSessions as jest.Mock
const mockedLogAction = logAction as jest.Mock

function fakeResponse() {
  const response: Record<string, unknown> = {}
  response.clearCookie = jest.fn().mockReturnValue(response)
  response.status = jest.fn().mockReturnValue(response)
  response.json = jest.fn().mockReturnValue(response)
  return response as never
}

function request(body: Record<string, unknown>, token?: string) {
  return {
    body,
    cookies: token ? { accessToken: token } : {},
    headers: {},
    ip: '127.0.0.1',
    get: () => 'Jest',
  } as never
}

const validToken = () => generateAccessToken('staff-1', 'org-1', 'venue-1', StaffRole.OWNER)

beforeEach(() => jest.clearAllMocks())

describe('logout with allDevices', () => {
  it('🔴 revokes every session of the signed-in staff', async () => {
    const res = fakeResponse()

    await dashboardLogoutController(request({ allDevices: true }, validToken()), res)

    expect(mockedRevoke).toHaveBeenCalledWith('staff-1')
    expect((res as any).json).toHaveBeenCalledWith(expect.objectContaining({ allDevices: true }))
  })

  it('audits it — revoking access is exactly what an owner audits later', async () => {
    await dashboardLogoutController(request({ allDevices: true }, validToken()), fakeResponse())

    expect(mockedLogAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'STAFF_SESSIONS_REVOKED', staffId: 'staff-1', entityId: 'staff-1' }),
    )
  })

  it('🔴 ignores a token that does not verify — otherwise a forged cookie locks anyone out', async () => {
    const forged = jwt.sign({ sub: 'the-owner', orgId: 'o', venueId: 'v', role: StaffRole.OWNER }, 'not-the-real-secret', {
      algorithm: 'HS256',
      expiresIn: '1h',
    })
    const res = fakeResponse()

    await dashboardLogoutController(request({ allDevices: true }, forged), res)

    expect(mockedRevoke).not.toHaveBeenCalled()
    expect((res as any).json).toHaveBeenCalledWith(expect.objectContaining({ allDevices: false }))
  })

  it('🔴 never claims it closed everything when the write failed', async () => {
    mockedRevoke.mockRejectedValueOnce(new Error('db down'))
    const res = fakeResponse()

    await dashboardLogoutController(request({ allDevices: true }, validToken()), res)

    // The local sign-out still succeeds — a failure here can never trap someone
    // inside the app — but the answer must not lie about the other devices.
    expect((res as any).status).toHaveBeenCalledWith(200)
    expect((res as any).json).toHaveBeenCalledWith(expect.objectContaining({ allDevices: false }))
  })

  // REGRESSION — the ordinary sign-out is untouched.
  it('does not revoke anything on a plain logout', async () => {
    await dashboardLogoutController(request({}, validToken()), fakeResponse())

    expect(mockedRevoke).not.toHaveBeenCalled()
    expect(mockedLogAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'STAFF_LOGOUT' }))
  })

  it('still signs out when there is no token at all', async () => {
    const res = fakeResponse()

    await dashboardLogoutController(request({ allDevices: true }), res)

    expect(mockedRevoke).not.toHaveBeenCalled()
    expect((res as any).status).toHaveBeenCalledWith(200)
  })
})
