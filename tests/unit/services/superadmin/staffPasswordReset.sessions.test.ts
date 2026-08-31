/**
 * A password reset that doesn't stamp `lastPasswordReset` closes NO session.
 *
 * `passwordChangeGuard` compares the token's `iat` against
 * `Staff.lastPasswordReset` — that makes the stamp, not the new hash, the
 * part that actually expels anyone from a JWT that carries no `sid`. The two
 * owner-facing reset paths stamp it; Avoqado support's own reset did not, so
 * the one lever used when an account is reported COMPROMISED was the one
 * that left every stolen session alive, on every rail.
 *
 * Task 7 (2026-08-28) added a second, defense-in-depth lever: for a JWT that
 * DOES carry a `sid` (Session table, T1-T6), the reset also has to close that
 * `Session` row and tumb its cache — see `cerrarSesionesNuevasPorCambioDeContrasena`
 * in `passwordChangeGuard.ts`, and its own dedicated tests.
 */
import prisma from '@/utils/prismaClient'
import { resetPassword } from '../../../../src/services/superadmin/staff.superadmin.service'
import * as guard from '@/utils/passwordChangeGuard'

jest.mock('@/utils/passwordChangeGuard')

const prismaMock = prisma as any

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff_1', email: 'compromised@venue.com' })
  prismaMock.staff.update.mockResolvedValue({ id: 'staff_1' })
})

describe('superadmin resetPassword', () => {
  it('🔴 stamps lastPasswordReset, so the open sessions actually die', async () => {
    const before = Date.now()

    await resetPassword('staff_1', 'a-brand-new-password', 'superadmin_1')

    const data = prismaMock.staff.update.mock.calls.at(-1)![0].data
    expect(data.lastPasswordReset).toBeInstanceOf(Date)
    expect(data.lastPasswordReset.getTime()).toBeGreaterThanOrEqual(before)
  })

  // REGRESSION — it must still, you know, change the password.
  it('still writes a new hash and never the plaintext', async () => {
    await resetPassword('staff_1', 'a-brand-new-password', 'superadmin_1')

    const data = prismaMock.staff.update.mock.calls.at(-1)![0].data
    expect(typeof data.password).toBe('string')
    expect(data.password).not.toBe('a-brand-new-password')
  })

  it('🔴 also closes the new Session rows — same reset, both mechanisms in sync', async () => {
    await resetPassword('staff_1', 'a-brand-new-password', 'superadmin_1')

    expect(guard.cerrarSesionesNuevasPorCambioDeContrasena).toHaveBeenCalledWith('staff_1')
  })
})
