/**
 * `/auth/status` has to honour the session cutoff too.
 *
 * Found in the live `/full-testing` pass, not by any unit test: after "cerrar
 * sesión en todos mis dispositivos", every endpoint behind the auth middleware
 * answered 401 — but `/auth/status`, the one the dashboard asks "am I still
 * signed in?", kept answering `authenticated: true`. Its route has the
 * middleware commented out on purpose ("controller handles token presence
 * internally for flexibility"), so it verified the token itself and never
 * called the guard.
 *
 * Nothing could be DONE with that session — the data endpoints reject it — but
 * another browser or tablet keeps painting itself signed-in until it asks for
 * data. The same hole was already there for a password change; it just had no
 * way to be noticed before there was a button that produces it on demand.
 */
const staffMock = { findUnique: jest.fn() }
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: { staff: staffMock } }))
jest.mock('@/utils/passwordChangeGuard', () => ({
  motivoDeSesionInvalidada: jest.fn(),
  mensajeDeCorte: jest.requireActual('@/utils/passwordChangeGuard').mensajeDeCorte,
}))

import { StaffRole } from '@prisma/client'
import { generateAccessToken } from '@/jwt.service'
import { motivoDeSesionInvalidada } from '@/utils/passwordChangeGuard'
import { getAuthStatus } from '@/controllers/dashboard/auth.dashboard.controller'

const mockedMotivo = motivoDeSesionInvalidada as jest.Mock

function fakeResponse() {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  res.clearCookie = jest.fn().mockReturnValue(res)
  return res
}

const request = (token?: string) => ({ cookies: token ? { accessToken: token } : {} }) as never

beforeEach(() => {
  jest.clearAllMocks()
  mockedMotivo.mockResolvedValue(null)
  staffMock.findUnique.mockResolvedValue({
    id: 'staff-1',
    firstName: 'Ana',
    lastName: 'Ruiz',
    email: 'ana@local.com',
    emailVerified: true,
    organizations: [],
    venues: [],
  })
})

describe('getAuthStatus', () => {
  it('🔴 answers NOT authenticated once the session was revoked', async () => {
    mockedMotivo.mockResolvedValue('SESSIONS_REVOKED')
    const res = fakeResponse()

    await getAuthStatus(request(generateAccessToken('staff-1', 'org-1', 'venue-1', StaffRole.OWNER)), res)

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ authenticated: false, user: null }))
    // It must not go to the database for a session that is already dead.
    expect(staffMock.findUnique).not.toHaveBeenCalled()
  })

  it('says WHY, so the dashboard can show the real reason', async () => {
    mockedMotivo.mockResolvedValue('PASSWORD_CHANGED')
    const res = fakeResponse()

    await getAuthStatus(request(generateAccessToken('staff-1', 'org-1', 'venue-1', StaffRole.OWNER)), res)

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/contraseña cambió/i) }))
  })

  // REGRESSION — the ordinary case must keep working, or every dashboard session
  // in the field starts reporting itself as signed out. The assertion is that the
  // guard does not SHORT-CIRCUIT: the flow reaches the staff lookup. Asserting
  // `authenticated: true` here would need the whole controller's data layer
  // mocked (venues, org config, features), which tests the mock, not the guard.
  it('does not get in the way of a live session — the flow reaches the staff lookup', async () => {
    const res = fakeResponse()

    await getAuthStatus(request(generateAccessToken('staff-1', 'org-1', 'venue-1', StaffRole.OWNER)), res)

    expect(mockedMotivo).toHaveBeenCalledWith('staff-1', expect.any(Number))
    expect(staffMock.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'staff-1' } }))
  })

  it('still answers unauthenticated with no token at all', async () => {
    const res = fakeResponse()

    await getAuthStatus(request(), res)

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ authenticated: false }))
    expect(mockedMotivo).not.toHaveBeenCalled()
  })
})
