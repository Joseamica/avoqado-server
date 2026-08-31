/**
 * Same lever as `staffPasswordReset.sessions.test.ts` (superadmin) and
 * `authResetPassword.sessions.test.ts` (dashboard forgot-password): the
 * ORG owner-facing reset (`resetUserPassword`) has to close the new `Session`
 * rows too — see `cerrarSesionesNuevasPorCambioDeContrasena` in
 * `passwordChangeGuard.ts` for the mechanism itself and its own tests.
 *
 * This is literally the docstring's own example scenario: "el dueño le
 * resetea la contraseña a un empleado que acaba de correr."
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { organizationDashboardService } from '@/services/organization-dashboard/organizationDashboard.service'
import * as guard from '@/utils/passwordChangeGuard'

jest.mock('@/utils/passwordChangeGuard')

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.staffOrganization.findFirst.mockResolvedValue({ id: 'so_1', staffId: 'staff_1', organizationId: 'org_1' })
  prismaMock.staff.update.mockResolvedValue({ id: 'staff_1' })
})

describe('organizationDashboardService.resetUserPassword', () => {
  it('🔴 also closes the new Session rows — same reset, both mechanisms in sync', async () => {
    await organizationDashboardService.resetUserPassword('org_1', 'staff_1', 'owner_1')

    expect(guard.cerrarSesionesNuevasPorCambioDeContrasena).toHaveBeenCalledWith('staff_1')
  })

  // REGRESSION — a user outside the org must not have anything reset or closed.
  it('does not touch sessions when the user is not in this org', async () => {
    prismaMock.staffOrganization.findFirst.mockResolvedValue(null)

    await expect(organizationDashboardService.resetUserPassword('org_1', 'staff_1', 'owner_1')).rejects.toThrow()

    expect(guard.cerrarSesionesNuevasPorCambioDeContrasena).not.toHaveBeenCalled()
  })
})
