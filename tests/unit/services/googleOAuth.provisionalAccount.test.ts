/**
 * Aceptar con Google una invitación cuya cuenta PROVISIONAL ya existe (4-nov-2026, hz:e0c38c0d:D2).
 *
 * La invitación por correo crea antes una cuenta apagada, sin contraseña y sin Google (`team.dashboard.service`). El
 * formulario de /invite/:token la reconoce (`esCuentaProvisional`) y la activa al aceptar. `loginWithGoogle` no: sólo
 * sabía «no existe → la crea desde la invitación» o «existe → tiene que estar activa», así que rechazaba con «Account is
 * inactive» a todo invitado que elegía Google. Le pasó a Rafa en producción: 4 intentos, 4 rechazos.
 *
 * El arreglo sólo PRENDE la cuenta (Google ya demostró que el correo es suyo) y la devuelve con su invitación pendiente:
 * la página de /invite/:token acepta ESA invitación con la sesión, como ya hace con cualquier cuenta de Google. Una
 * cuenta inactiva que NO es provisional (una baja) sigue rechazada.
 */
import { InvitationStatus, StaffRole } from '@prisma/client'

const GOOGLE_PAYLOAD = {
  sub: 'google-uid-rafa',
  email: 'Rafael@PlayTelecom.com',
  name: 'Rafael Prueba',
  given_name: 'Rafael',
  family_name: 'Prueba',
  picture: 'https://example.test/rafa.png',
  email_verified: true,
}

jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({
    generateAuthUrl: jest.fn().mockReturnValue('https://accounts.google.test/auth'),
    getToken: jest.fn().mockResolvedValue({ tokens: { id_token: 'id-token' } }),
    verifyIdToken: jest.fn().mockResolvedValue({ getPayload: () => GOOGLE_PAYLOAD }),
  })),
}))

const staffFindUnique = jest.fn()
const staffUpdate = jest.fn().mockResolvedValue({})
const invitationFindFirst = jest.fn()
const invitationFindMany = jest.fn().mockResolvedValue([])

jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staff: { findUnique: (...a: any[]) => staffFindUnique(...a), update: (...a: any[]) => staffUpdate(...a) },
    invitation: { findFirst: (...a: any[]) => invitationFindFirst(...a), findMany: (...a: any[]) => invitationFindMany(...a) },
    $transaction: jest.fn(() => {
      throw new Error('el camino de la cuenta provisional no debe crear otra cuenta')
    }),
  },
}))

jest.mock('../../../src/services/access/seatCap.service', () => ({ assertCanAddSeatsBulk: jest.fn() }))
jest.mock('@/services/auth/session.service', () => ({ createSession: jest.fn().mockResolvedValue({ id: 'sess_1' }) }))
jest.mock('@/services/auth/refreshGrant.service', () => ({ issueGrant: jest.fn().mockResolvedValue(undefined) }))
const logAction = jest.fn()
jest.mock('../../../src/services/dashboard/activity-log.service', () => ({ logAction: (...a: any[]) => logAction(...a) }))
jest.mock('../../../src/jwt.service', () => ({
  generateAccessToken: jest.fn().mockReturnValue('access-token'),
  generateRefreshToken: jest.fn().mockReturnValue('refresh-token'),
}))
jest.mock('../../../src/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))
jest.mock('../../../src/services/staffOrganization.service', () => ({
  getPrimaryOrganizationId: jest.fn().mockResolvedValue('org-equipo'),
}))

import { loginWithGoogle } from '../../../src/services/dashboard/googleOAuth.service'

const ORG = { id: 'org-equipo', name: 'Avoqado · Equipo de ventas', email: 'otro@avoqado.io', onboardingCompletedAt: new Date() }
const VENUE = {
  id: 'venue-equipo',
  name: 'Avoqado · Equipo de ventas',
  slug: 'equipo',
  logo: null,
  status: 'ACTIVE',
  organizationId: ORG.id,
}

/** La cuenta que dejó la invitación: apagada, sin verificar, sin contraseña, sin Google y nunca usada. */
function provisional(overrides: Record<string, any> = {}) {
  return {
    id: 'staff-rafa',
    email: 'rafael@playtelecom.com',
    firstName: 'Rafael',
    lastName: 'Prueba',
    photoUrl: null,
    active: false,
    emailVerified: false,
    password: null,
    googleId: null,
    lastLoginAt: null,
    organizations: [{ organizationId: ORG.id, organization: ORG }],
    venues: [],
    ...overrides,
  }
}

/** La misma cuenta después de aceptar: activa y con su sucursal. */
function aceptada(overrides: Record<string, any> = {}) {
  return provisional({
    active: true,
    emailVerified: true,
    venues: [{ staffId: 'staff-rafa', venueId: VENUE.id, role: StaffRole.VIEWER, active: true, venue: VENUE }],
    ...overrides,
  })
}

const PENDIENTE = {
  id: 'inv-rafa',
  token: 'tok-rafa',
  role: StaffRole.VIEWER,
  venue: { id: VENUE.id, name: VENUE.name },
  organization: { id: ORG.id, name: ORG.name },
  expiresAt: new Date(Date.now() + 86_400_000),
}

beforeEach(() => {
  jest.clearAllMocks()
  staffFindUnique.mockReset()
  invitationFindFirst.mockReset()
  invitationFindMany.mockResolvedValue([])
})

describe('loginWithGoogle — cuenta provisional de una invitación', () => {
  it('🔴 la prende, entra y regresa la invitación para que la página la acepte (el caso de Rafa)', async () => {
    staffFindUnique.mockResolvedValueOnce(provisional()).mockResolvedValueOnce(provisional({ active: true, emailVerified: true }))
    invitationFindFirst.mockResolvedValueOnce({ id: 'inv-rafa' })
    invitationFindMany.mockResolvedValueOnce([PENDIENTE])

    const result = await loginWithGoogle('id-token', false)

    expect(invitationFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ email: 'rafael@playtelecom.com', status: InvitationStatus.PENDING }),
      }),
    )
    expect(staffUpdate).toHaveBeenCalledWith({ where: { id: 'staff-rafa' }, data: { active: true, emailVerified: true } })
    // Google queda ligado a la cuenta, como en cualquier entrada con Google.
    expect(staffUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'staff-rafa' }, data: expect.objectContaining({ googleId: 'google-uid-rafa' }) }),
    )
    expect(result.accessToken).toBe('access-token')
    expect(result.pendingInvitations?.[0].token).toBe('tok-rafa')
    // «false»: la página NO debe saltarse /invite/:token (resolvePostLoginRedirect del DASHBOARD).
    expect(result.isNewUser).toBe(false)
  })

  it('no acepta ninguna invitación aquí: la acepta la página, la que la persona apretó', async () => {
    staffFindUnique.mockResolvedValueOnce(provisional()).mockResolvedValueOnce(provisional({ active: true, emailVerified: true }))
    invitationFindFirst.mockResolvedValueOnce({ id: 'inv-rafa' })
    invitationFindMany.mockResolvedValueOnce([PENDIENTE])

    await loginWithGoogle('id-token', false)

    expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'INVITATION_ACCEPTED' }))
  })

  describe('lo que NO cambia', () => {
    it('una cuenta provisional sin invitación viva sigue rechazada y no se prende', async () => {
      staffFindUnique.mockResolvedValueOnce(provisional())
      invitationFindFirst.mockResolvedValueOnce(null)

      await expect(loginWithGoogle('id-token', false)).rejects.toThrow('Account is inactive')
      expect(staffUpdate).not.toHaveBeenCalled()
    })

    it('🔴 una cuenta dada de baja (ya se usó) no se reactiva con Google aunque tenga una invitación viva', async () => {
      staffFindUnique.mockResolvedValueOnce(provisional({ lastLoginAt: new Date('2026-10-01T12:00:00Z'), emailVerified: true }))
      invitationFindFirst.mockResolvedValue({ id: 'inv-rafa' })

      await expect(loginWithGoogle('id-token', false)).rejects.toThrow('Account is inactive')
      expect(invitationFindFirst).not.toHaveBeenCalled()
      expect(staffUpdate).not.toHaveBeenCalled()
    })

    it('una cuenta activa entra sin buscar invitaciones', async () => {
      staffFindUnique.mockResolvedValueOnce(aceptada({ googleId: 'google-uid-rafa', lastLoginAt: new Date() }))

      const result = await loginWithGoogle('id-token', false)

      expect(result.accessToken).toBe('access-token')
      expect(invitationFindFirst).not.toHaveBeenCalled()
    })
  })
})
