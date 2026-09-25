/**
 * H2 (Codex gpt-6-astra, 2ª pasada): desactivar una cuenta desde superadmin no cortaba sus sesiones
 * abiertas. Los resolutores de rol ya la niegan, pero las rutas que sólo piden estar autenticado
 * seguían respondiendo a sus tokens. Ahora desactivar corta tokens y sesiones.
 */
const revocar = jest.fn()
const cerrar = jest.fn()
jest.mock('@/utils/passwordChangeGuard', () => ({
  revokeAllSessions: (...a: unknown[]) => revocar(...a),
  cerrarSesionesDeStaff: (...a: unknown[]) => cerrar(...a),
}))

import { prismaMock } from '@tests/__helpers__/setup'
import { updateStaff } from '@/services/superadmin/staff.superadmin.service'

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.staff.update.mockResolvedValue({ id: 's1', email: 'x@test.mx' } as any)
  prismaMock.staff.findUnique.mockResolvedValue({ id: 's1', active: true, email: 'x@test.mx' } as any)
})

it('🔴 desactivar corta sus tokens y cierra sus sesiones', async () => {
  await updateStaff('s1', { active: false } as any, 'admin').catch(() => undefined)
  expect(revocar).toHaveBeenCalledWith('s1')
  expect(cerrar).toHaveBeenCalledWith('s1', expect.any(String))
})

it('cambiar sólo el nombre no toca sus sesiones (regresión)', async () => {
  await updateStaff('s1', { firstName: 'Nuevo' } as any, 'admin').catch(() => undefined)
  expect(revocar).not.toHaveBeenCalled()
  expect(cerrar).not.toHaveBeenCalled()
})
