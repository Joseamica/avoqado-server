/**
 * Alta con código, Tarea 4: verificar el código de 6 dígitos + crear la contraseña (una sola escritura
 * condicionada) y reenviar el código.
 */
const mockUpdateMany = jest.fn()
const mockFindUnique = jest.fn()
const mockFindFirst = jest.fn()
const mockUpdate = jest.fn()
const mockLogAction = jest.fn().mockResolvedValue(undefined)

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { staff: { findUnique: mockFindUnique, findFirst: mockFindFirst, update: mockUpdate, updateMany: mockUpdateMany } },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: (...a: unknown[]) => mockLogAction(...a) }))
jest.mock('@/services/staffOrganization.service', () => ({ getPrimaryOrganizationId: jest.fn().mockResolvedValue('org-1') }))
jest.mock('@/services/launchCampaigns/launchCampaignClaim.service', () => ({ claimLaunchCampaign: jest.fn() }))
jest.mock('@/services/launchCampaigns/launchCampaign.service', () => ({ findClaimableByCodeOrSlug: jest.fn() }))
jest.mock('@/services/onboarding/nuevoNegocio', () => ({ crearNegocioNuevo: jest.fn(), resolverAtribucionDelAlta: jest.fn() }))
jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendEmailVerification: jest.fn().mockResolvedValue(true) } }))
jest.mock('bcryptjs', () => ({ hash: jest.fn().mockResolvedValue('hash-bcrypt') }))

import emailService from '@/services/email.service'
import { BadRequestError } from '@/errors/AppError'
import { leerBoletoDeAlta } from '@/services/onboarding/boletoDeAlta'
import { reenviarCodigoDeLanding, verificarCodigoDeLanding } from '@/services/onboarding/signup.service'

const VIGENTE = () => new Date(Date.now() + 5 * 60 * 1000)
const cuenta = (extra: Record<string, unknown> = {}) => ({
  id: 'staff-1',
  email: 'ana@example.com',
  firstName: 'Ana',
  active: true,
  password: null,
  googleId: null,
  emailVerificationCode: '123456',
  emailVerificationExpires: VIGENTE(),
  ...extra,
})
const entrada = { email: ' Ana@Example.com ', codigo: '123456', password: 'una contraseña larga' }

async function codigoDelError(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestError)
    return (e as BadRequestError).code
  }
  throw new Error('no lanzó')
}

beforeAll(() => {
  process.env.ACCESS_TOKEN_SECRET = 'secreto-de-prueba-del-boleto'
})
beforeEach(() => {
  jest.clearAllMocks()
  mockFindUnique.mockResolvedValue(cuenta())
  mockFindFirst.mockResolvedValue({ id: 'staff-1' }) // esProspectoDeLanding
  mockUpdateMany.mockResolvedValue({ count: 1 })
})

describe('verificarCodigoDeLanding', () => {
  it('código correcto: UNA escritura condicionada (con el correo adentro), boleto válido y bitácora', async () => {
    const { entrarUrl } = await verificarCodigoDeLanding(entrada)

    expect(mockUpdateMany).toHaveBeenCalledTimes(1)
    const arg = mockUpdateMany.mock.calls[0][0]
    expect(arg.where).toMatchObject({
      id: 'staff-1',
      email: 'ana@example.com',
      password: null,
      googleId: null,
      active: true,
      emailVerificationCode: '123456',
    })
    expect(arg.where.emailVerificationExpires.gt).toBeInstanceOf(Date)
    expect(arg.data).toMatchObject({
      password: 'hash-bcrypt',
      emailVerified: true,
      emailVerificationCode: null,
      emailVerificationExpires: null,
      resetToken: null,
      resetTokenExpiry: null,
    })

    const [base, boleto] = entrarUrl.split('/auth/entrar#boleto=')
    expect(base).toBeTruthy()
    expect(leerBoletoDeAlta(boleto)).toMatchObject({ staffId: 'staff-1', email: 'ana@example.com' })
    expect(mockLogAction).toHaveBeenCalledWith(expect.objectContaining({ staffId: 'staff-1', action: 'LANDING_EMAIL_VERIFIED_BY_CODE' }))
  })

  it('el prospecto de hoy (ya verificado, sin contraseña) entra con su código', async () => {
    mockFindUnique.mockResolvedValue(cuenta({ emailVerified: true }))
    await expect(verificarCodigoDeLanding(entrada)).resolves.toHaveProperty('entrarUrl')
  })

  it('código equivocado: CODIGO_INVALIDO y no escribe', async () => {
    expect(await codigoDelError(verificarCodigoDeLanding({ ...entrada, codigo: '654321' }))).toBe('CODIGO_INVALIDO')
    expect(mockUpdateMany).not.toHaveBeenCalled()
  })

  it('correo que no existe: CODIGO_INVALIDO (no revela nada)', async () => {
    mockFindUnique.mockResolvedValue(null)
    expect(await codigoDelError(verificarCodigoDeLanding(entrada))).toBe('CODIGO_INVALIDO')
  })

  it('cuenta sin código guardado: CODIGO_INVALIDO', async () => {
    mockFindUnique.mockResolvedValue(cuenta({ emailVerificationCode: null, emailVerificationExpires: null }))
    expect(await codigoDelError(verificarCodigoDeLanding(entrada))).toBe('CODIGO_INVALIDO')
  })

  it('código vencido: CODIGO_VENCIDO', async () => {
    mockFindUnique.mockResolvedValue(cuenta({ emailVerificationExpires: new Date(Date.now() - 1000) }))
    expect(await codigoDelError(verificarCodigoDeLanding(entrada))).toBe('CODIGO_VENCIDO')
    expect(mockUpdateMany).not.toHaveBeenCalled()
  })

  it('la escritura afecta 0 filas (doble clic): CODIGO_INVALIDO, sin 500', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 })
    expect(await codigoDelError(verificarCodigoDeLanding(entrada))).toBe('CODIGO_INVALIDO')
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it.each([
    ['con contraseña', { password: 'ya-tiene' }],
    ['con googleId', { googleId: 'g-1' }],
    ['inactiva', { active: false }],
  ])('cuenta %s: CUENTA_YA_ACTIVA, sin escribir', async (_n, extra) => {
    mockFindUnique.mockResolvedValue(cuenta(extra))
    expect(await codigoDelError(verificarCodigoDeLanding(entrada))).toBe('CUENTA_YA_ACTIVA')
    expect(mockUpdateMany).not.toHaveBeenCalled()
  })

  it('no es OWNER o el alta ya terminó (esProspectoDeLanding falso): CUENTA_YA_ACTIVA, sin escribir', async () => {
    mockFindFirst.mockResolvedValue(null)
    try {
      await verificarCodigoDeLanding(entrada)
      throw new Error('no lanzó')
    } catch (e) {
      expect((e as BadRequestError).code).toBe('CUENTA_YA_ACTIVA')
      expect((e as BadRequestError).message).toBe('Ya tienes cuenta con ese correo: entra en dashboard.avoqado.io')
    }
    expect(mockUpdateMany).not.toHaveBeenCalled()
  })

  it('código emitido para el correo A y cambio de correo a B: ya no hay cuenta con A (o su código se limpió)', async () => {
    mockFindUnique.mockResolvedValue(null)
    expect(await codigoDelError(verificarCodigoDeLanding(entrada))).toBe('CODIGO_INVALIDO')
    // Y si el cambio ocurre mientras corre bcrypt, el `email` dentro del where deja la escritura en 0 filas.
    mockFindUnique.mockResolvedValue(cuenta())
    mockUpdateMany.mockResolvedValue({ count: 0 })
    expect(await codigoDelError(verificarCodigoDeLanding(entrada))).toBe('CODIGO_INVALIDO')
  })

  it('contraseña «12345678»: CONTRASENA_INVALIDA sin consumir el código', async () => {
    expect(await codigoDelError(verificarCodigoDeLanding({ ...entrada, password: '12345678' }))).toBe('CONTRASENA_INVALIDA')
    expect(mockUpdateMany).not.toHaveBeenCalled()
  })
})

describe('reenviarCodigoDeLanding', () => {
  it('a un prospecto activo sin contraseña ni googleId le genera un código NUEVO y se lo manda', async () => {
    mockFindUnique.mockResolvedValue({ id: 'staff-1', email: 'ana@example.com', firstName: 'Ana', active: true, password: null, googleId: null })
    await reenviarCodigoDeLanding(' Ana@Example.com ')
    const data = mockUpdate.mock.calls[0][0].data
    expect(data.emailVerificationCode).toMatch(/^\d{6}$/)
    expect(data.emailVerificationExpires.getTime()).toBeGreaterThan(Date.now() + 9 * 60 * 1000)
    expect(emailService.sendEmailVerification).toHaveBeenCalledWith('ana@example.com', {
      firstName: 'Ana',
      verificationCode: data.emailVerificationCode,
    })
  })

  it.each([
    ['no existe', null],
    ['tiene contraseña', { id: 's', email: 'a@b.c', firstName: 'A', active: true, password: 'x', googleId: null }],
    ['es de Google', { id: 's', email: 'a@b.c', firstName: 'A', active: true, password: null, googleId: 'g' }],
    ['está inactiva', { id: 's', email: 'a@b.c', firstName: 'A', active: false, password: null, googleId: null }],
  ])('si %s: no manda nada y no lanza', async (_n, staff) => {
    mockFindUnique.mockResolvedValue(staff)
    await expect(reenviarCodigoDeLanding('a@b.c')).resolves.toBeUndefined()
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(emailService.sendEmailVerification).not.toHaveBeenCalled()
  })

  it('si el correo falla, tampoco lanza (no revela nada)', async () => {
    mockFindUnique.mockResolvedValue({ id: 's', email: 'a@b.c', firstName: 'A', active: true, password: null, googleId: null })
    ;(emailService.sendEmailVerification as jest.Mock).mockRejectedValueOnce(new Error('smtp'))
    await expect(reenviarCodigoDeLanding('a@b.c')).resolves.toBeUndefined()
  })
})
