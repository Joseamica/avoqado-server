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
