/** `staffHasPermissionInVenue`: la decisión de los servicios (p. ej. `sale-verifications:approve`) contra la tienda de la venta. */
import { OrgRole, StaffRole } from '@prisma/client'
import { staffHasPermissionInVenue } from '@/middlewares/checkPermission.middleware'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staff: { findUnique: jest.fn() },
    staffVenue: { findUnique: jest.fn(), findFirst: jest.fn() },
    venue: { findUnique: jest.fn() },
    staffOrganization: { findUnique: jest.fn(), findFirst: jest.fn() },
    venueRolePermission: { findUnique: jest.fn() },
  },
}))

const m = prisma as unknown as Record<string, Record<string, jest.Mock>>
const APPROVE = 'sale-verifications:approve'
const ask = () => staffHasPermissionInVenue({ staffId: 's1', venueId: 'v1', permission: APPROVE })

function fila(role: StaffRole, permissionSet: { permissions: string[] } | null = null) {
  m.staffVenue.findUnique.mockResolvedValue({ role, active: true, permissionSetId: permissionSet ? 'ps1' : null, permissionSet })
}

beforeEach(() => {
  jest.resetAllMocks()
  m.staff.findUnique.mockResolvedValue({ active: true })
  m.staffVenue.findFirst.mockResolvedValue(null)
  m.staffOrganization.findFirst.mockResolvedValue(null)
  m.venueRolePermission.findUnique.mockResolvedValue(null)
})

describe('staffHasPermissionInVenue', () => {
  it('SUPERADMIN activo: true sin evaluar roles', async () => {
    m.staffVenue.findFirst.mockResolvedValue({ id: 'sv' })
    await expect(ask()).resolves.toBe(true)
    expect(m.staffVenue.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { staffId: 's1', role: StaffRole.SUPERADMIN, active: true, staff: { active: true } } }),
    )
    expect(m.staffVenue.findUnique).not.toHaveBeenCalled()
    expect(m.venueRolePermission.findUnique).not.toHaveBeenCalled()
  })

  it('dueño de la organización sin fila en esa tienda: true', async () => {
    m.staffVenue.findUnique.mockResolvedValue(null)
    m.venue.findUnique.mockResolvedValue({ organizationId: 'o1' })
    m.staffOrganization.findUnique.mockResolvedValue({ role: OrgRole.OWNER, isActive: true })
    await expect(ask()).resolves.toBe(true)
  })

  it('MANAGER con los permisos de fábrica: true', async () => {
    fila(StaffRole.MANAGER)
    await expect(ask()).resolves.toBe(true)
  })

  it('MANAGER con approve negado en esa tienda: false', async () => {
    fila(StaffRole.MANAGER)
    m.venueRolePermission.findUnique.mockResolvedValue({ permissions: [], deniedPermissions: [APPROVE] })
    await expect(ask()).resolves.toBe(false)
  })

  it('Conjunto de Permisos sin approve: false (aunque el rol lo traiga)', async () => {
    fila(StaffRole.MANAGER, { permissions: ['sale-verifications:review'] })
    await expect(ask()).resolves.toBe(false)
  })

  it('sin rol en esa tienda: false', async () => {
    m.staffVenue.findUnique.mockResolvedValue(null)
    m.venue.findUnique.mockResolvedValue({ organizationId: 'o1' })
    m.staffOrganization.findUnique.mockResolvedValue(null)
    await expect(ask()).resolves.toBe(false)
  })
})
