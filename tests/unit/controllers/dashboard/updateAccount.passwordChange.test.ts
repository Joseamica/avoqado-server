/**
 * Cambiar la contraseña desde el perfil corta TODAS las demás sesiones (Codex H7, 24-sep).
 *
 * Antes sólo cambiaba el hash: quien ya tenía un token (el intruso que motivó el cambio) seguía
 * dentro 24 h. Ahora se mueve el corte `lastPasswordReset` —el mismo que usa el restablecimiento
 * por correo— y se cierran las Session. La sesión desde la que se hizo el cambio recibe tokens
 * nuevos para no echar a la persona de la pantalla en la que está (como Google o GitHub).
 */
const cerrarSesiones = jest.fn()
const olvidarCorte = jest.fn()
jest.mock('../../../../src/utils/passwordChangeGuard', () => ({
  ...jest.requireActual('../../../../src/utils/passwordChangeGuard'),
  cerrarSesionesNuevasPorCambioDeContrasena: (...a: unknown[]) => cerrarSesiones(...a),
  olvidarCorteEnCache: (...a: unknown[]) => olvidarCorte(...a),
}))
const switchVenue = jest.fn()
jest.mock('../../../../src/services/dashboard/auth.service', () => ({
  ...jest.requireActual('../../../../src/services/dashboard/auth.service'),
  switchVenueForStaff: (...a: unknown[]) => switchVenue(...a),
}))

jest.mock('../../../../src/services/dashboard/activity-log.service', () => ({ logAction: jest.fn(async () => undefined) }))
import { logAction } from '../../../../src/services/dashboard/activity-log.service'
import bcrypt from 'bcryptjs'
import prisma from '../../../../src/utils/prismaClient'
import { updateAccountController } from '../../../../src/controllers/dashboard/auth.dashboard.controller'

const p = prisma as any

function llamar(
  body: Record<string, unknown>,
  authContext: Record<string, unknown> = { userId: 'staff-1', orgId: 'org-1', venueId: 'v-1' },
) {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), cookie: jest.fn() }
  const next = jest.fn()
  const req = { body, authContext } as never
  return updateAccountController(req, res as never, next).then(() => ({ res, next }))
}

let hashViejo: string
beforeAll(async () => {
  hashViejo = await bcrypt.hash('vieja-123', 4)
})

beforeEach(() => {
  jest.clearAllMocks()
  p.staff.findUnique.mockReset().mockResolvedValue({ password: hashViejo, email: 'yo@test.mx' })
  p.staff.update.mockReset().mockResolvedValue({ id: 'staff-1', email: 'yo@test.mx' })
  switchVenue.mockResolvedValue({ accessToken: 'acc-nuevo', refreshToken: 'ref-nuevo' })
})

it('🔴 cambiar la contraseña mueve el corte y cierra las demás sesiones', async () => {
  const { res } = await llamar({ old_password: 'vieja-123', password: 'nueva-456' })

  const data = p.staff.update.mock.calls[0][0].data
  expect(data.password).toEqual(expect.any(String))
  expect(data.lastPasswordReset).toBeInstanceOf(Date)
  expect(olvidarCorte).toHaveBeenCalledWith('staff-1')
  expect(cerrarSesiones).toHaveBeenCalledWith('staff-1')
  expect(res.status).toHaveBeenCalledWith(200)
})

it('la sesión que hizo el cambio recibe cookies nuevas, emitidas DESPUÉS del corte', async () => {
  const { res } = await llamar({ old_password: 'vieja-123', password: 'nueva-456' })

  expect(switchVenue).toHaveBeenCalledWith('staff-1', 'org-1', 'v-1')
  expect(cerrarSesiones.mock.invocationCallOrder[0]).toBeLessThan(switchVenue.mock.invocationCallOrder[0])
  expect(res.cookie).toHaveBeenCalledWith('accessToken', 'acc-nuevo', expect.any(Object))
  expect(res.cookie).toHaveBeenCalledWith('refreshToken', 'ref-nuevo', expect.any(Object))
})

it('contraseña actual incorrecta: no toca nada (regresión)', async () => {
  const { res } = await llamar({ old_password: 'otra', password: 'nueva-456' })
  expect(res.status).toHaveBeenCalledWith(400)
  expect(p.staff.update).not.toHaveBeenCalled()
  expect(cerrarSesiones).not.toHaveBeenCalled()
  expect(res.cookie).not.toHaveBeenCalled()
})

it('cambiar sólo el nombre NO corta sesiones ni emite cookies (regresión)', async () => {
  await llamar({ firstName: 'Ana' })
  expect(p.staff.update.mock.calls[0][0].data).not.toHaveProperty('lastPasswordReset')
  expect(cerrarSesiones).not.toHaveBeenCalled()
  expect(switchVenue).not.toHaveBeenCalled()
})

it('🔴 el cambio de contraseña queda en la bitácora (sin guardar nada de la contraseña)', async () => {
  await llamar({ old_password: 'vieja-123', password: 'nueva-456' })

  expect(logAction).toHaveBeenCalledWith(
    expect.objectContaining({
      staffId: 'staff-1',
      organizationId: 'org-1',
      venueId: 'v-1',
      action: 'STAFF_PASSWORD_CHANGED',
      entityId: 'staff-1',
    }),
  )
  const asiento = JSON.stringify((logAction as jest.Mock).mock.calls[0][0])
  expect(asiento).not.toMatch(/nueva-456|vieja-123/)
})

it('cambiar sólo el nombre no escribe STAFF_PASSWORD_CHANGED (regresión)', async () => {
  await llamar({ firstName: 'Ana' })
  expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'STAFF_PASSWORD_CHANGED' }))
})
