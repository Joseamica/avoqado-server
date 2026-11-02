/**
 * hz:f26b3afc:D4 — La contraseña de los negocios demo es pública (va en el PDF para prospectos). Si un dueño real invitaba
 * al correo de un usuario demo, cualquiera con esa contraseña aceptaba la invitación y entraba a ese negocio real (Codex r3,
 * docs/audit/2026-11-01-alertas-de-los-demos/codex-r3.md). Aceptar es el único camino de toda invitación: ahí se cierra.
 */
import { InvitationStatus, StaffRole } from '@prisma/client'

jest.mock('../../../src/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn(),
}))

const INVITATION = {
  id: 'inv-1',
  token: 'test-token',
  email: 'bloom@demo.avoqado.io',
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

beforeEach(() => {
  jest.clearAllMocks()
  mockExistingStaff = null
  mockStaffCreate.mockResolvedValue({ id: 'new-staff-1', email: 'bloom@demo.avoqado.io', firstName: 'Demo', lastName: 'Bloom' })
})

it('🔴 una invitación a un correo demo no se acepta: 403, sin cuenta nueva', async () => {
  await expect(acceptInvitation('test-token', { firstName: 'Demo', lastName: 'Bloom', password: 'abcdefgh' })).rejects.toMatchObject({
    statusCode: 403,
  })
  expect(mockStaffCreate).not.toHaveBeenCalled()
})

it('🔴 tampoco si el usuario demo ya existe y da la contraseña correcta (la pública del PDF)', async () => {
  mockExistingStaff = {
    id: 'staff-bloom',
    email: 'bloom@demo.avoqado.io',
    password: 'hash-de-la-publica',
    firstName: 'Demo',
    lastName: 'Studio Bloom',
    venues: [],
    organizations: [{ organizationId: 'org-demo-bloom' }],
  }
  mockBcryptCompare.mockResolvedValue(true)
  await expect(acceptInvitation('test-token', { password: 'abcdefgh' })).rejects.toMatchObject({ statusCode: 403 })
})
