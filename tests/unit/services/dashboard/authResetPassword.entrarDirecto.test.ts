/**
 * D10 (28-oct-2026): el prospecto de la landing que vuelve por «Continúa tu alta» del correo crea su contraseña y ENTRA,
 * sin volver a escribir correo y contraseña. Medido en prod: el botón decía «Crear contraseña y entrar» y mandaba a
 * «Iniciar sesión».
 *
 * 🔴 Codex (codex-d10-r1.md #1–#3): NO se ponen cookies aquí. Se devuelve el MISMO boleto de 5 min que usa el alta con
 * código de la landing (`verificarCodigoDeLanding`), y sólo si ANTES del cambio la cuenta era prospecto de la landing.
 * El canje (`canjearBoletoDeAlta`) ya es de un solo uso y revisa los cortes después de firmar; cualquier otra cuenta
 * (empleado sin contraseña, alta terminada, Google) queda igual que hoy.
 */
import prisma from '@/utils/prismaClient'
import { resetPassword } from '../../../../src/services/dashboard/auth.service'
import * as guard from '@/utils/passwordChangeGuard'
import { esProspectoDeLanding } from '@/services/onboarding/signup.service'
import { firmarBoletoDeAlta, huellaDeContrasena } from '@/services/onboarding/boletoDeAlta'

jest.mock('@/utils/passwordChangeGuard')
jest.mock('@/services/onboarding/signup.service', () => ({ __esModule: true, esProspectoDeLanding: jest.fn() }))
jest.mock('@/services/onboarding/boletoDeAlta', () => ({
  __esModule: true,
  firmarBoletoDeAlta: jest.fn(() => 'BOLETO'),
  huellaDeContrasena: jest.requireActual('@/services/onboarding/boletoDeAlta').huellaDeContrasena,
}))

const prismaMock = prisma as any
const ORIGINAL_FRONTEND = process.env.FRONTEND_URL
const ORIGINAL_ALTA = process.env.ALTA_LANDING_CON_CODIGO
const TOKEN_VIGENTE = {
  id: 'staff_1',
  email: 'dueno@tacos.mx',
  resetTokenExpiry: new Date(Date.now() + 60 * 60_000),
  resetTokenUsedAt: null,
}

beforeEach(() => {
  jest.clearAllMocks()
  process.env.FRONTEND_URL = 'https://dashboard.avoqado.io'
  process.env.ALTA_LANDING_CON_CODIGO = 'true'
  // 1.ª lectura: el token; 2.ª: la comprobación de que el cambio sigue siendo ESTE (con el boleto ya firmado).
  prismaMock.staff.findFirst.mockReset().mockResolvedValueOnce(TOKEN_VIGENTE).mockResolvedValueOnce({ id: 'staff_1' })
  prismaMock.staff.updateMany.mockResolvedValue({ count: 1 })
})

afterAll(() => {
  if (ORIGINAL_FRONTEND === undefined) delete process.env.FRONTEND_URL
  else process.env.FRONTEND_URL = ORIGINAL_FRONTEND
  if (ORIGINAL_ALTA === undefined) delete process.env.ALTA_LANDING_CON_CODIGO
  else process.env.ALTA_LANDING_CON_CODIGO = ORIGINAL_ALTA
})

describe('D10: crear la contraseña desde el correo deja entrar al prospecto de la landing', () => {
  it('prospecto → devuelve la liga de entrada con el boleto del alta', async () => {
    ;(esProspectoDeLanding as jest.Mock).mockResolvedValue(true)

    const r = await resetPassword({ token: 'tok', newPassword: 'una-clave-nueva' })

    expect(r).toEqual(expect.objectContaining({ entrarUrl: 'https://dashboard.avoqado.io/auth/entrar#boleto=BOLETO' }))
    // 🔴 Codex r3: el boleto lleva la hora EXACTA de este cambio (la misma que se guardó en `lastPasswordReset`).
    const { lastPasswordReset, password } = prismaMock.staff.updateMany.mock.calls[0][0].data
    expect(firmarBoletoDeAlta).toHaveBeenCalledWith('staff_1', 'dueno@tacos.mx', {
      cambioMs: lastPasswordReset.getTime(),
      huella: huellaDeContrasena(password),
    })
  })

  it('🔴 se decide con la cuenta ANTES del cambio (sin contraseña), y el boleto se firma DESPUÉS del corte de sesiones', async () => {
    ;(esProspectoDeLanding as jest.Mock).mockResolvedValue(true)

    await resetPassword({ token: 'tok', newPassword: 'una-clave-nueva' })

    // exigirSinContrasena por defecto: la pregunta sólo tiene sentido antes de fijarla.
    expect(esProspectoDeLanding).toHaveBeenCalledWith('staff_1')
    const orden = (f: unknown) => (f as jest.Mock).mock.invocationCallOrder[0]
    expect(orden(esProspectoDeLanding)).toBeLessThan(orden(prismaMock.staff.updateMany))
    expect(orden(guard.cerrarSesionesNuevasPorCambioDeContrasena)).toBeLessThan(orden(firmarBoletoDeAlta))
  })

  it('🔴 cualquier otra cuenta (empleado, alta terminada, Google) → como hoy: sin liga ni boleto', async () => {
    ;(esProspectoDeLanding as jest.Mock).mockResolvedValue(false)

    const r = await resetPassword({ token: 'tok', newPassword: 'una-clave-nueva' })

    expect(r).not.toHaveProperty('entrarUrl')
    expect(r.message).toMatch(/iniciar sesión/i)
    expect(firmarBoletoDeAlta).not.toHaveBeenCalled()
  })

  it('🔴 un enlace ya usado (carrera perdida) no da boleto', async () => {
    ;(esProspectoDeLanding as jest.Mock).mockResolvedValue(true)
    prismaMock.staff.updateMany.mockResolvedValue({ count: 0 })

    await expect(resetPassword({ token: 'tok', newPassword: 'una-clave-nueva' })).rejects.toThrow()
    expect(firmarBoletoDeAlta).not.toHaveBeenCalled()
  })

  it('si no se puede saber si era prospecto, el cambio de contraseña sigue como hoy (sin boleto)', async () => {
    ;(esProspectoDeLanding as jest.Mock).mockRejectedValue(new Error('base lenta'))

    const r = await resetPassword({ token: 'tok', newPassword: 'una-clave-nueva' })

    expect(prismaMock.staff.updateMany).toHaveBeenCalledTimes(1)
    expect(r).not.toHaveProperty('entrarUrl')
  })

  it('🔴 Codex r2: si mientras tanto hubo OTRO cambio de contraseña, una revocación o una baja, no hay boleto', async () => {
    ;(esProspectoDeLanding as jest.Mock).mockResolvedValue(true)
    prismaMock.staff.findFirst.mockReset().mockResolvedValueOnce(TOKEN_VIGENTE).mockResolvedValueOnce(null)

    const r = await resetPassword({ token: 'tok', newPassword: 'una-clave-nueva' })

    expect(r).not.toHaveProperty('entrarUrl')
    // La comprobación ata el boleto a ESTE cambio: el mismo hash y la misma fecha que escribió la recuperación.
    const datos = prismaMock.staff.updateMany.mock.calls[0][0].data
    expect(prismaMock.staff.findFirst).toHaveBeenLastCalledWith({
      where: {
        id: 'staff_1',
        active: true,
        password: datos.password,
        lastPasswordReset: datos.lastPasswordReset,
        OR: [{ sessionsRevokedAt: null }, { sessionsRevokedAt: { lt: datos.lastPasswordReset } }],
      },
      select: { id: true },
    })
  })

  it('🔴 Codex r2: con el alta con código APAGADA (su canje da 404) no hay boleto, y ni se pregunta', async () => {
    process.env.ALTA_LANDING_CON_CODIGO = 'false'
    ;(esProspectoDeLanding as jest.Mock).mockResolvedValue(true)

    const r = await resetPassword({ token: 'tok', newPassword: 'una-clave-nueva' })

    expect(r).not.toHaveProperty('entrarUrl')
    expect(esProspectoDeLanding).not.toHaveBeenCalled()
    expect(firmarBoletoDeAlta).not.toHaveBeenCalled()
  })
})
