/**
 * Hallazgo del /full-testing (25-sep): restablecer los permisos de un rol y cambiar la meta de la
 * organización quedaban en la bitácora SIN autor. El dueño veía «alguien lo cambió».
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { StaffRole } from '@prisma/client'

const mockLogAction = jest.fn()
jest.mock('@/services/dashboard/activity-log.service', () => ({
  ...jest.requireActual('@/services/dashboard/activity-log.service'),
  logAction: (...a: unknown[]) => mockLogAction(...a),
}))

import { deleteRolePermissions } from '@/services/dashboard/rolePermission.service'
import { organizationDashboardService } from '@/services/organization-dashboard/organizationDashboard.service'
import * as salesGoalService from '@/services/dashboard/commission/sales-goal.service'

beforeEach(() => mockLogAction.mockReset())

it('🔴 ROLE_PERMISSIONS_RESET lleva a quien restableció el rol', async () => {
  prismaMock.venueRolePermission.deleteMany.mockResolvedValue({ count: 1 } as any)
  await deleteRolePermissions('venue-1', StaffRole.MANAGER, StaffRole.OWNER, 'staff-dueno')
  expect(mockLogAction).toHaveBeenCalledWith(
    expect.objectContaining({ action: 'ROLE_PERMISSIONS_RESET', staffId: 'staff-dueno', venueId: 'venue-1' }),
  )
})

it('🔴 ORG_GOAL_UPDATED lleva a quien cambió la meta', async () => {
  // El mock compartido de Prisma no trae este modelo.
  ;(prismaMock as any).organizationGoal = {
    upsert: jest.fn().mockResolvedValue({
      id: 'g1',
      organizationId: 'org-1',
      period: 'monthly',
      periodDate: new Date('2026-09-01'),
      salesTarget: 1000,
      volumeTarget: 10,
    }),
  }
  await organizationDashboardService.updateOrganizationGoal('org-1', 'monthly', new Date('2026-09-01'), 1000, 10, 'staff-dueno')
  expect(mockLogAction).toHaveBeenCalledWith(
    expect.objectContaining({ action: 'ORG_GOAL_UPDATED', staffId: 'staff-dueno', organizationId: 'org-1' }),
  )
})

// Ronda 6 (15-oct): las zonas y las metas por tienda tampoco llevaban autor ni org en la bitácora.
describe('zonas: ZONE_* lleva a quien lo hizo y la organización', () => {
  beforeEach(() => {
    ;(prismaMock as any).zone = {
      create: jest.fn().mockResolvedValue({ id: 'zona-1', organizationId: 'org-1' }),
      update: jest.fn().mockResolvedValue({ id: 'zona-1' }),
      delete: jest.fn().mockResolvedValue({ id: 'zona-1' }),
      findFirst: jest.fn().mockResolvedValue({ id: 'zona-1' }),
    }
    prismaMock.venue.updateMany.mockResolvedValue({ count: 0 } as any)
    prismaMock.$transaction.mockImplementation((arg: any) => (Array.isArray(arg) ? Promise.all(arg) : arg(prismaMock)))
  })

  it.each([
    ['ZONE_CREATED', () => organizationDashboardService.createZone('org-1', 'Norte', 'norte', 'staff-gerente')],
    ['ZONE_UPDATED', () => organizationDashboardService.updateZone('org-1', 'zona-1', { name: 'Norte 2' }, 'staff-gerente')],
    ['ZONE_DELETED', () => organizationDashboardService.deleteZone('org-1', 'zona-1', 'staff-gerente')],
  ])('🔴 %s', async (action, hacer) => {
    await hacer()
    expect(mockLogAction).toHaveBeenCalledWith(expect.objectContaining({ action, staffId: 'staff-gerente', organizationId: 'org-1' }))
  })
})

describe('metas por tienda: SALES_GOAL_* lleva a quien lo hizo y la organización', () => {
  const META = { id: 'g1', staffId: null, goal: 1000, goalType: 'AMOUNT', period: 'MONTHLY', active: true, createdAt: 'x', updatedAt: 'x' }

  beforeEach(() => {
    prismaMock.$transaction.mockImplementation((arg: any) => (Array.isArray(arg) ? Promise.all(arg) : arg(prismaMock)))
    prismaMock.module.upsert.mockResolvedValue({ id: 'module-commissions' } as any)
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'module-commissions', code: 'COMMISSIONS', scope: 'BOTH' }])
    prismaMock.venueModule.upsert.mockResolvedValue({ id: 'vm-1', config: { salesGoals: [META] } } as any)
    prismaMock.venueModule.update.mockResolvedValue({} as any)
    prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' } as any)
    prismaMock.payment.aggregate.mockResolvedValue({ _sum: { amount: null } } as any)
  })

  const AUDITORIA = { staffId: 'staff-gerente', organizationId: 'org-1' }

  it.each([
    [
      'SALES_GOAL_CREATED',
      () => salesGoalService.createSalesGoal('venue-b', { goal: 500, goalType: 'AMOUNT', period: 'WEEKLY' } as any, AUDITORIA),
    ],
    ['SALES_GOAL_UPDATED', () => salesGoalService.updateSalesGoal('venue-b', 'g1', { goal: 2000 }, AUDITORIA)],
    ['SALES_GOAL_DELETED', () => salesGoalService.deleteSalesGoal('venue-b', 'g1', AUDITORIA)],
  ])('🔴 %s', async (action, hacer) => {
    await hacer()
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({ action, staffId: 'staff-gerente', venueId: 'venue-b', organizationId: 'org-1' }),
    )
  })
})
