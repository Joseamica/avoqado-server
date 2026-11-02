/**
 * Registro directo: al verificar el código se avisa al equipo UNA sola vez (27-oct, Codex r1).
 * Dos verificaciones simultáneas con el mismo código pasan las dos la lectura; sólo la que de verdad marcó la cuenta
 * (updateMany condicionado a `emailVerified: false`) avisa. La respuesta (tokens) es igual para las dos.
 */
import prisma from '../../../src/utils/prismaClient'
import { verifyEmailCode } from '../../../src/services/onboarding/signup.service'
import { avisarRegistroDirecto } from '../../../src/services/onboarding/avisoRegistroDirecto'

jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: { staff: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() } },
}))
jest.mock('../../../src/services/onboarding/avisoRegistroDirecto', () => ({ avisarRegistroDirecto: jest.fn() }))
jest.mock('../../../src/jwt.service', () => ({
  __esModule: true,
  generateAccessToken: jest.fn().mockReturnValue('access'),
  generateRefreshToken: jest.fn().mockReturnValue('refresh'),
}))
jest.mock('../../../src/services/staffOrganization.service', () => ({ getPrimaryOrganizationId: jest.fn().mockResolvedValue('org-1') }))

const sinVerificar = {
  id: 'staff-1',
  email: 'ana@example.com',
  emailVerified: false,
  emailVerificationCode: '123456',
  emailVerificationExpires: new Date(Date.now() + 5 * 60_000),
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(prisma.staff.findUnique as jest.Mock).mockResolvedValue(sinVerificar)
})

describe('verifyEmailCode — aviso del registro directo', () => {
  it('la verificación que marca la cuenta avisa al equipo una vez', async () => {
    ;(prisma.staff.updateMany as jest.Mock).mockResolvedValue({ count: 1 })

    const r = await verifyEmailCode('ana@example.com', '123456')

    expect(r.emailVerified).toBe(true)
    expect(prisma.staff.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'staff-1', emailVerified: false } }))
    expect(avisarRegistroDirecto).toHaveBeenCalledTimes(1)
    expect(avisarRegistroDirecto).toHaveBeenCalledWith('staff-1', 'correo')
  })

  it('la que llegó segunda (ya no marcó nada) entra igual pero NO vuelve a avisar', async () => {
    ;(prisma.staff.updateMany as jest.Mock).mockResolvedValue({ count: 0 })

    const r = await verifyEmailCode('ana@example.com', '123456')

    expect(r.accessToken).toBe('access')
    expect(avisarRegistroDirecto).not.toHaveBeenCalled()
  })
})
