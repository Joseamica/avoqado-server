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
})
