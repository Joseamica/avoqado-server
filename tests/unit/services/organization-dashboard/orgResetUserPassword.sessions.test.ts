/**
 * Decisión del founder (24-sep, opción B tras la 3ª auditoría de Codex): el «restablecer contraseña» del
 * DUEÑO ya no genera una contraseña temporal que el dueño ve en pantalla. Manda un ENLACE al correo del
 * empleado — el mismo del «olvidé mi contraseña». El dueño nunca conoce la contraseña, así que ya no
 * importa si logra fabricar una membresía (R1): lo único que consigue es que le llegue un correo a la víctima.
 *
 * Reemplaza la decisión C del 1-sep (contraseña temporal global). Echar a quien se fue es «dar de baja».
 */
import { prismaMock } from '@tests/__helpers__/setup'

const mockEnviar = jest.fn()
jest.mock('@/services/dashboard/enlaceDeRestablecimiento', () => ({
  ...jest.requireActual('@/services/dashboard/enlaceDeRestablecimiento'),
  enviarEnlaceDeRestablecimiento: (...a: unknown[]) => mockEnviar(...a),
}))
const mockLogAction = jest.fn()
jest.mock('@/services/dashboard/activity-log.service', () => ({
  ...jest.requireActual('@/services/dashboard/activity-log.service'),
  logAction: (...a: unknown[]) => mockLogAction(...a),
}))

import { organizationDashboardService } from '@/services/organization-dashboard/organizationDashboard.service'

const persona = { id: 'staff_1', email: 'juana.perez@correo.mx', firstName: 'Juana' }

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.staffOrganization.findFirst.mockResolvedValue({ id: 'so_1', staff: persona } as any)
  mockEnviar.mockResolvedValue(true)
})

describe('organizationDashboardService.resetUserPassword (enlace por correo)', () => {
  it('🔴 NO cambia la contraseña ni devuelve una temporal: manda el enlace al correo del empleado', async () => {
    const r = await organizationDashboardService.resetUserPassword('org_1', 'staff_1', 'owner_1')

    expect(mockEnviar).toHaveBeenCalledWith(expect.objectContaining({ id: 'staff_1', email: 'juana.perez@correo.mx' }))
    expect(prismaMock.staff.update).not.toHaveBeenCalled()
    expect(r).not.toHaveProperty('tempPassword')
    expect(JSON.stringify(r)).not.toContain('juana.perez@correo.mx')
    expect(r).toEqual(expect.objectContaining({ emailSent: true, email: 'j•••@correo.mx' }))
  })

  it('🔴 si el correo no sale, lo DICE (503) en vez de fingir que se envió', async () => {
    mockEnviar.mockResolvedValue(false)
    await expect(organizationDashboardService.resetUserPassword('org_1', 'staff_1', 'owner_1')).rejects.toMatchObject({ statusCode: 503 })
  })

  it('la bitácora dice quién pidió el enlace, para quién y en qué organización', async () => {
    await organizationDashboardService.resetUserPassword('org_1', 'staff_1', 'owner_1')
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'USER_PASSWORD_RESET_LINK_SENT',
        staffId: 'owner_1',
        entityId: 'staff_1',
        organizationId: 'org_1',
      }),
    )
  })

  // REGRESIÓN — alguien fuera de la organización no recibe nada.
  it('no manda nada si la persona no pertenece a esta organización', async () => {
    prismaMock.staffOrganization.findFirst.mockResolvedValue(null)
    await expect(organizationDashboardService.resetUserPassword('org_1', 'staff_1', 'owner_1')).rejects.toMatchObject({ statusCode: 404 })
    expect(mockEnviar).not.toHaveBeenCalled()
  })
})
