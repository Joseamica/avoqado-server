/**
 * «Entrar con Google en el POS» (hz:6bfcd3a1:D1) — una sola forma de armar la sesión del POS.
 * `emitirSesionDelPos` es lo que hacen los pasos 5–9 del login por contraseña; el método
 * ('password' | 'google') decide el AuthMethod, qué se limpia y qué se anota en la bitácora.
 */
import * as sessionService from '@/services/auth/session.service'
import * as jwtService from '../../../../src/jwt.service'
import logger from '@/config/logger'
import prisma from '../../../../src/utils/prismaClient'
import { logAction } from '../../../../src/services/dashboard/activity-log.service'
import { emitirSesionDelPos } from '../../../../src/services/mobile/auth.mobile.service'

jest.mock('@/services/auth/session.service')
jest.mock('@/services/auth/refreshGrant.service', () => ({ issueGrant: jest.fn(), rotateGrant: jest.fn() }))
jest.mock('../../../../src/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

const prismaMock = prisma as any
const createSessionMock = sessionService.createSession as jest.Mock

const VENUE = {
  id: 'venue_1',
  name: 'Negocio',
  slug: 'negocio',
  logo: null,
  type: 'SALON',
  status: 'ACTIVE',
  kycStatus: 'APPROVED',
  organizationId: 'org_1',
  timezone: 'America/Mexico_City',
}

const staff: any = {
  id: 'staff_1',
  email: 'a@b.com',
  emailVerified: true,
  firstName: 'A',
  lastName: 'B',
  password: 'hash',
  googleId: 'g-1',
  active: true,
  photoUrl: null,
  phone: null,
  lockedUntil: null,
  failedLoginAttempts: 3,
  createdAt: new Date(),
  lastLoginAt: null,
  venues: [{ venueId: 'venue_1', role: 'WAITER', permissionSetId: null, permissionSet: null, venue: VENUE }],
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(jwtService, 'generateAccessToken').mockReturnValue('access-token')
  jest.spyOn(jwtService, 'generateRefreshToken').mockReturnValue('refresh-token')
  prismaMock.staff.update.mockResolvedValue({})
  prismaMock.venueRolePermission.findMany.mockResolvedValue([])
  prismaMock.venueRoleConfig.findMany.mockResolvedValue([])
  createSessionMock.mockResolvedValue({ id: 'sess-1' })
})

describe('emitirSesionDelPos', () => {
  it('google: sesión GOOGLE y STAFF_LOGIN method google', async () => {
    const r = await emitirSesionDelPos(staff, 'google', undefined, undefined)

    expect(createSessionMock).toHaveBeenCalledWith(expect.objectContaining({ staffId: 'staff_1', authMethod: 'GOOGLE' }))
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'STAFF_LOGIN', data: expect.objectContaining({ method: 'google' }) }),
    )
    expect(r.selectedVenueId).toBe('venue_1')
  })

  it('google no toca failedLoginAttempts ni lockedUntil', async () => {
    await emitirSesionDelPos(staff, 'google', undefined, undefined)
    const data = prismaMock.staff.update.mock.calls[0][0].data
    expect(data).toHaveProperty('lastLoginAt')
    expect(data).not.toHaveProperty('failedLoginAttempts')
    expect(data).not.toHaveProperty('lockedUntil')
  })

  it('password sí los limpia y marca PASSWORD', async () => {
    await emitirSesionDelPos(staff, 'password', undefined, undefined)
    expect(prismaMock.staff.update.mock.calls[0][0].data).toMatchObject({ failedLoginAttempts: 0, lockedUntil: null })
    expect(createSessionMock).toHaveBeenCalledWith(expect.objectContaining({ authMethod: 'PASSWORD' }))
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ method: 'password' }) }))
  })

  it.each(['password', 'google'] as const)('%s: rememberMe y deviceId llegan a createSession y a los tokens', async metodo => {
    await emitirSesionDelPos(staff, metodo, true, 'dev-1')
    expect(createSessionMock).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'dev-1' }))
    expect(jwtService.generateAccessToken).toHaveBeenCalledWith('staff_1', 'org_1', 'venue_1', 'WAITER', true, { sid: 'sess-1', pos: true })
    expect(jwtService.generateRefreshToken).toHaveBeenCalledWith('staff_1', 'org_1', true, 'venue_1', { sid: 'sess-1' })
  })

  it.each(['password', 'google'] as const)('%s: el log de éxito lleva el id, nunca el correo', async metodo => {
    ;(logger.info as jest.Mock).mockClear()
    await emitirSesionDelPos(staff, metodo, undefined, undefined)
    const logged = JSON.stringify((logger.info as jest.Mock).mock.calls)
    expect(logged).toContain('staff_1')
    expect(logged).not.toContain('a@b.com')
  })
})
