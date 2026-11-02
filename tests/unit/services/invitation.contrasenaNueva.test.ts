/**
 * Regla de contraseña al ACEPTAR una invitación:
 * - cuenta NUEVA: 8+ caracteres, sin mayúsculas/números obligatorios, y no una común (motivoContrasenaInvalida);
 * - cuenta EXISTENTE: sólo se compara con bcrypt, sin reglas de formato (su contraseña vieja puede no cumplirlas).
 */
import { InvitationStatus, StaffRole } from '@prisma/client'

jest.mock('../../../src/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn(),
}))

const INVITATION = {
  id: 'inv-1',
  token: 'test-token',
  email: 'newuser@test.com',
  role: StaffRole.WAITER,
  status: InvitationStatus.PENDING,
  expiresAt: new Date(Date.now() + 86400000),
  organizationId: 'org-1',
  venueId: 'venue-1',
  invitedById: 'inviter-1',
  permissions: null,
  requirePin: false,
  organization: { id: 'org-1', name: 'Test Org' },
  venue: { id: 'venue-1', name: 'Test Venue' },
}

// null = cuenta nueva; un objeto = alguien que ya existe en la misma organización.
let mockExistingStaff: unknown = null
const mockStaffCreate = jest.fn()
const mockBcryptCompare = jest.fn()

jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        invitation: { findFirst: jest.fn().mockResolvedValue(INVITATION), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        staff: {
          findUnique: jest.fn().mockImplementation(async () => mockExistingStaff),
          create: (...a: unknown[]) => mockStaffCreate(...a),
          update: jest.fn().mockResolvedValue({ id: 'staff-ana', email: 'newuser@test.com', firstName: 'Ana', lastName: 'Ruiz' }),
        },
        staffVenue: {
          findFirst: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([]),
          create: jest.fn().mockResolvedValue({}),
        },
        staffOrganization: { create: jest.fn().mockResolvedValue({}), update: jest.fn().mockResolvedValue({}) },
      }
      return cb(tx)
    }),
  },
}))

jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('hashed-password'),
  compare: (...a: unknown[]) => mockBcryptCompare(...a),
}))
jest.mock('../../../src/jwt.service', () => ({
  generateAccessToken: jest.fn().mockReturnValue('mock-access-token'),
  generateRefreshToken: jest.fn().mockReturnValue('mock-refresh-token'),
}))
jest.mock('../../../src/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))
jest.mock('../../../src/services/dashboard/venueRoleConfig.dashboard.service', () => ({
  getRoleDisplayName: jest.fn().mockResolvedValue(null),
}))
jest.mock('../../../src/services/staffOrganization.service', () => ({
  createStaffOrganizationMembership: jest.fn().mockResolvedValue(undefined),
  getPrimaryOrganizationId: jest.fn().mockResolvedValue('org-1'),
  getOrganizationIdFromVenue: jest.fn().mockResolvedValue('org-1'),
}))
jest.mock('../../../src/services/access/seatCap.service', () => ({
  assertCanAddSeatsBulk: jest.fn().mockResolvedValue(undefined),
}))

import { acceptInvitation } from '../../../src/services/invitation.service'

describe('acceptInvitation — regla de contraseña', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockExistingStaff = null
    mockStaffCreate.mockResolvedValue({ id: 'new-staff-1', email: 'newuser@test.com', firstName: 'New', lastName: 'User' })
  })

  describe('cuenta nueva', () => {
    it('acepta «abcdefgh» (sin mayúsculas ni números)', async () => {
      const r = await acceptInvitation('test-token', { firstName: 'New', lastName: 'User', password: 'abcdefgh' })
      expect(r.user.id).toBe('new-staff-1')
      expect(mockStaffCreate).toHaveBeenCalledTimes(1)
    })

    it('rechaza «12345678» por común, con 400 y sin crear la cuenta', async () => {
      await expect(acceptInvitation('test-token', { firstName: 'New', lastName: 'User', password: '12345678' })).rejects.toMatchObject({
        message: 'Esa contraseña es muy común. Elige otra.',
        statusCode: 400,
      })
      expect(mockStaffCreate).not.toHaveBeenCalled()
    })

    it('rechaza menos de 8 caracteres', async () => {
      await expect(acceptInvitation('test-token', { firstName: 'New', lastName: 'User', password: 'corta' })).rejects.toMatchObject({
        message: 'La contraseña debe tener al menos 8 caracteres.',
        statusCode: 400,
      })
      expect(mockStaffCreate).not.toHaveBeenCalled()
    })
  })

  describe('cuenta existente', () => {
    const existente = {
      id: 'staff-ana',
      email: 'newuser@test.com',
      password: 'hash-guardado',
      firstName: 'Ana',
      lastName: 'Ruiz',
      venues: [],
      organizations: [{ organizationId: 'org-1' }],
    }

    it('sigue comparando con bcrypt, sin reglas de formato: una contraseña vieja «12345678» entra', async () => {
      mockExistingStaff = existente
      mockBcryptCompare.mockResolvedValue(true)
      const r = await acceptInvitation('test-token', { password: '12345678' })
      expect(mockBcryptCompare).toHaveBeenCalledWith('12345678', 'hash-guardado')
      expect(r.user.id).toBe('staff-ana')
      expect(mockStaffCreate).not.toHaveBeenCalled()
    })

    it('si bcrypt dice que no coincide, 401 «Contraseña incorrecta» (no un mensaje de formato)', async () => {
      mockExistingStaff = existente
      mockBcryptCompare.mockResolvedValue(false)
      await expect(acceptInvitation('test-token', { password: '12345678' })).rejects.toMatchObject({
        message: 'Contraseña incorrecta',
        statusCode: 401,
      })
    })
  })
})
