/**
 * Parte A (sesiones revocables) — el carril WEB.
 *
 * La Parte A dejó el POS móvil con sesiones revocables, pero el dashboard siguió emitiendo
 * tokens SIN `sid`: el acceso de dueños y gerentes no se puede cancelar. "Cerrar sesión en
 * todos mis dispositivos" no tiene nada que revocar del lado web, y el corte de tokens
 * legacy no puede cerrarse mientras exista un cliente que no sabe emitir `sid`.
 *
 * Este archivo cubre los TRES caminos por los que una persona real entra a un negocio real
 * desde la web: contraseña, Google, y cambiar de sucursal ya estando dentro.
 *
 * 🔴 Dos trampas que ningún tipo cacha, porque todos los parámetros son opcionales:
 *
 * 1. `opts` es el **6º** argumento de `generateAccessToken` (el 5º es `rememberMe`) y el
 *    **5º** de `generateRefreshToken` (el 4º es `venueId`). Ponerlo en el lugar equivocado
 *    rompe "recordarme" en silencio, o manda el `sid` como si fuera un venue.
 * 2. `pos: true` **NO** va aquí. Ese flag baja el access token a 10 minutos porque un POS
 *    tiene su carril de refresco; el dashboard NO refresca (ante un 401 manda al login),
 *    así que marcarlo echaría a los dueños de su panel cada 10 minutos.
 */
import { StaffRole, OrgRole, AuthMethod } from '@prisma/client'
import bcrypt from 'bcryptjs'

jest.mock('../../../../src/utils/prismaClient')
jest.mock('../../../../src/jwt.service')
jest.mock('@/services/auth/session.service')
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() },
}))
jest.mock('../../../../src/services/staffOrganization.service', () => ({
  getPrimaryOrganizationId: jest.fn().mockResolvedValue('org-1'),
  hasOrganizationAccess: jest.fn().mockResolvedValue(true),
}))
jest.mock('../../../../src/services/email.service', () => ({
  default: { sendPasswordResetEmail: jest.fn().mockResolvedValue(true), sendEmailVerification: jest.fn().mockResolvedValue(true) },
}))
const GOOGLE_PAYLOAD = {
  sub: 'google-uid-1',
  email: 'duena@negocio.com',
  name: 'Ana Ruiz',
  given_name: 'Ana',
  family_name: 'Ruiz',
  picture: null,
  email_verified: true,
}
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({
    generateAuthUrl: jest.fn(),
    getToken: jest.fn().mockResolvedValue({ tokens: { id_token: 'id-token' } }),
    verifyIdToken: jest.fn().mockResolvedValue({ getPayload: () => GOOGLE_PAYLOAD }),
  })),
}))
jest.mock('@/services/access/seatCap.service', () => ({ assertCanAddSeatsBulk: jest.fn().mockResolvedValue(undefined) }))
jest.mock('otplib', () => ({
  TOTP: jest.fn().mockImplementation(() => ({ verify: jest.fn().mockResolvedValue({ valid: false }) })),
  NobleCryptoPlugin: jest.fn(),
  ScureBase32Plugin: jest.fn(),
}))

import prisma from '../../../../src/utils/prismaClient'
import * as jwtService from '../../../../src/jwt.service'
import * as sessionService from '@/services/auth/session.service'
import { loginStaff, switchVenueForStaff } from '../../../../src/services/dashboard/auth.service'
import { loginWithGoogle } from '../../../../src/services/dashboard/googleOAuth.service'

const mockPrisma = prisma as any
const mockJwt = jwtService as jest.Mocked<typeof jwtService>
const createSessionMock = sessionService.createSession as jest.Mock

const SESSION_ID = 'sess_web_1'
const VENUE_ID = 'venue-1'
const ORG_ID = 'org-1'

describe('Parte A — el dashboard web emite sesiones revocables', () => {
  const validPassword = 'password123'
  let hashedPassword: string

  beforeAll(async () => {
    hashedPassword = await bcrypt.hash(validPassword, 10)
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockJwt.generateAccessToken = jest.fn().mockReturnValue('access')
    mockJwt.generateRefreshToken = jest.fn().mockReturnValue('refresh')
    createSessionMock.mockResolvedValue({ id: SESSION_ID })
    mockPrisma.staff.update = jest.fn().mockResolvedValue({})
    mockPrisma.invitation = { findMany: jest.fn().mockResolvedValue([]) }
    mockPrisma.venueRoleConfig = { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn().mockResolvedValue(null) }
    mockPrisma.venueRolePermission = { findMany: jest.fn().mockResolvedValue([]) }
  })

  const staffConVenue = () => ({
    id: 'staff-1',
    email: 'duena@negocio.com',
    password: hashedPassword,
    firstName: 'Ana',
    lastName: 'Ruiz',
    active: true,
    emailVerified: true,
    failedLoginAttempts: 0,
    lockedUntil: null,
    photoUrl: null,
    phone: null,
    createdAt: new Date(),
    lastLoginAt: null,
    venues: [
      {
        venueId: VENUE_ID,
        role: StaffRole.ADMIN,
        venue: {
          id: VENUE_ID,
          name: 'Amaena',
          slug: 'amaena',
          logo: null,
          status: 'ACTIVE',
          kycStatus: 'APPROVED',
          organizationId: ORG_ID,
        },
      },
    ],
    organizations: [
      {
        organizationId: ORG_ID,
        role: OrgRole.MEMBER,
        organization: { id: ORG_ID, name: 'Org', email: 'o@o.com', onboardingCompletedAt: new Date() },
      },
    ],
  })

  describe('login con contraseña', () => {
    beforeEach(() => {
      mockPrisma.staff.findUnique = jest.fn().mockResolvedValue(staffConVenue())
    })

    it('crea una Session del venue elegido, con authMethod PASSWORD', async () => {
      await loginStaff({ email: 'duena@negocio.com', password: validPassword } as any)

      expect(createSessionMock).toHaveBeenCalledTimes(1)
      expect(createSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({ staffId: 'staff-1', venueId: VENUE_ID, authMethod: AuthMethod.PASSWORD }),
      )
    })

    it('🔴 mete el sid como 6º argumento del access token — el 5º sigue siendo rememberMe', async () => {
      await loginStaff({ email: 'duena@negocio.com', password: validPassword, rememberMe: true } as any)

      const args = mockJwt.generateAccessToken.mock.calls[0]
      expect(args[4]).toBe(true) // rememberMe intacto en su posición
      expect(args[5]).toEqual(expect.objectContaining({ sid: SESSION_ID }))
    })

    it('🔴 NO marca pos:true — el dashboard no refresca, y un access de 10 min echaría al dueño de su panel', async () => {
      await loginStaff({ email: 'duena@negocio.com', password: validPassword } as any)

      expect(mockJwt.generateAccessToken.mock.calls[0][5]).not.toHaveProperty('pos', true)
    })

    it('🔴 mete el sid como 5º argumento del refresh token, con el venueId en el 4º', async () => {
      await loginStaff({ email: 'duena@negocio.com', password: validPassword, rememberMe: true } as any)

      const args = mockJwt.generateRefreshToken.mock.calls[0]
      expect(args[2]).toBe(true) // rememberMe
      expect(args[3]).toBe(VENUE_ID) // venueId, que antes iba vacío
      expect(args[4]).toEqual(expect.objectContaining({ sid: SESSION_ID }))
    })

    it('regresión: sigue devolviendo los dos tokens', async () => {
      const res: any = await loginStaff({ email: 'duena@negocio.com', password: validPassword } as any)

      expect(res.accessToken).toBe('access')
      expect(res.refreshToken).toBe('refresh')
    })
  })

  describe('cambiar de sucursal', () => {
    beforeEach(() => {
      mockPrisma.staff.findUnique = jest.fn().mockResolvedValue({
        id: 'staff-1',
        venues: [{ role: StaffRole.ADMIN, venue: { id: 'venue-2' } }],
      })
      mockPrisma.venue = {
        findUnique: jest.fn().mockResolvedValue({ id: 'venue-2', organizationId: ORG_ID, name: 'Sucursal 2', status: 'ACTIVE' }),
      }
      mockPrisma.staffVenue = { findFirst: jest.fn().mockResolvedValue({ role: StaffRole.ADMIN }) }
    })

    it('crea una Session NUEVA, atada al venue DESTINO', async () => {
      await switchVenueForStaff('staff-1', ORG_ID, 'venue-2')

      expect(createSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({ staffId: 'staff-1', venueId: 'venue-2', authMethod: AuthMethod.PASSWORD }),
      )
    })

    it('🔴 rellena rememberMe (5º) antes de opts (6º) — aquí sólo se pasaban 4 argumentos', async () => {
      await switchVenueForStaff('staff-1', ORG_ID, 'venue-2')

      const args = mockJwt.generateAccessToken.mock.calls[0]
      expect(args[3]).toBe(StaffRole.ADMIN) // el rol sigue en su sitio
      expect(args[5]).toEqual(expect.objectContaining({ sid: SESSION_ID }))
    })

    it('el refresh del cambio de sucursal también lleva sid y el venue destino', async () => {
      await switchVenueForStaff('staff-1', ORG_ID, 'venue-2')

      const args = mockJwt.generateRefreshToken.mock.calls[0]
      expect(args[3]).toBe('venue-2')
      expect(args[4]).toEqual(expect.objectContaining({ sid: SESSION_ID }))
    })
  })

  describe('login con Google', () => {
    // Es el login que muchos duenos usan de verdad, y el relevo de la Parte A ni lo
    // mencionaba: se listaban solo los dos sitios de auth.service.ts. Sin esto, entrar
    // con Google seguiria siendo una puerta con llave que no se puede cancelar.
    beforeEach(() => {
      mockPrisma.staff.findUnique = jest.fn().mockResolvedValue(staffConVenue())
      mockPrisma.staff.findUniqueOrThrow = jest.fn().mockResolvedValue(staffConVenue())
      mockPrisma.invitation = { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) }
      mockPrisma.venue = { findMany: jest.fn().mockResolvedValue([]) }
    })

    it('crea una Session del venue elegido y mete su sid en los dos tokens', async () => {
      await loginWithGoogle('codigo-de-google')

      expect(createSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({ staffId: 'staff-1', venueId: VENUE_ID, authMethod: AuthMethod.PASSWORD }),
      )
      expect(mockJwt.generateAccessToken.mock.calls[0][5]).toEqual(expect.objectContaining({ sid: SESSION_ID }))
      expect(mockJwt.generateRefreshToken.mock.calls[0][4]).toEqual(expect.objectContaining({ sid: SESSION_ID }))
    })

    it('🔴 tampoco marca pos:true, y conserva el rol en su posicion', async () => {
      await loginWithGoogle('codigo-de-google')

      const args = mockJwt.generateAccessToken.mock.calls[0]
      expect(args[3]).toBe(StaffRole.ADMIN)
      expect(args[5]).not.toHaveProperty('pos', true)
    })
  })
})
