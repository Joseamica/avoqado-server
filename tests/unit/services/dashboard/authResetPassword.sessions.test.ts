/**
 * Same lever as `staffPasswordReset.sessions.test.ts`, other rail: the
 * self-service "forgot my password" reset (`resetPassword` in
 * `dashboard/auth.service.ts`, token-based) has to close the new `Session`
 * rows too — see `cerrarSesionesNuevasPorCambioDeContrasena` in
 * `passwordChangeGuard.ts` for the mechanism itself and its own tests.
 */
import prisma from '@/utils/prismaClient'
import { resetPassword } from '../../../../src/services/dashboard/auth.service'
import * as guard from '@/utils/passwordChangeGuard'

jest.mock('@/utils/passwordChangeGuard')

const prismaMock = prisma as any

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.staff.findFirst.mockResolvedValue({
    id: 'staff_1',
    email: 'gerente@venue.com',
    resetTokenExpiry: new Date(Date.now() + 60 * 60_000),
    resetTokenUsedAt: null,
  })
  prismaMock.staff.updateMany.mockResolvedValue({ count: 1 })
})

describe('dashboard resetPassword (forgot-password token flow)', () => {
  it('🔴 also closes the new Session rows — same reset, both mechanisms in sync', async () => {
    await resetPassword({ token: 'a-valid-token', newPassword: 'a-brand-new-password' })

    expect(guard.cerrarSesionesNuevasPorCambioDeContrasena).toHaveBeenCalledWith('staff_1')
  })

  // REGRESSION — a token nobody could redeem must not close anything.
  it('does not close sessions when the token was already used (race lost)', async () => {
    prismaMock.staff.updateMany.mockResolvedValue({ count: 0 })

    await expect(resetPassword({ token: 'a-valid-token', newPassword: 'a-brand-new-password' })).rejects.toThrow()

    expect(guard.cerrarSesionesNuevasPorCambioDeContrasena).not.toHaveBeenCalled()
  })

  // El link del correo PRUEBA el correo: quien lo abre y fija su contraseña ya no puede quedar
  // «sin verificar» (alta de landing con código: entra por el código O por el link, y las dos
  // puertas deben dejar la cuenta usable). Misma escritura atómica que la contraseña.
  it('🔴 marca el correo como verificado en la MISMA escritura que fija la contraseña', async () => {
    await resetPassword({ token: 'a-valid-token', newPassword: 'a-brand-new-password' })

    expect(prismaMock.staff.updateMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.staff.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'staff_1', resetTokenUsedAt: null }),
        data: expect.objectContaining({ password: expect.any(String), emailVerified: true }),
      }),
    )
  })

  it('un link ya usado (carrera perdida) no verifica nada', async () => {
    prismaMock.staff.updateMany.mockResolvedValue({ count: 0 })

    await expect(resetPassword({ token: 'a-valid-token', newPassword: 'a-brand-new-password' })).rejects.toThrow()

    // La verificación viaja DENTRO de la misma escritura condicionada al token: sin ella no hay otra.
    expect(prismaMock.staff.updateMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.staff.update).not.toHaveBeenCalled()
  })
})
