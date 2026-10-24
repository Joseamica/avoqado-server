/**
 * Alta con código (Tarea 4) contra Postgres REAL.
 *
 * Base desechable: `avoqado_alta_codigo_test_20261023` (TEST_DATABASE_URL explícita; nunca `av-db-25`).
 *   - dos `verificarCodigoDeLanding` simultáneos con el mismo código => exactamente uno entra;
 *   - `esProspectoDeLanding` con filas reales (el prospecto sí; contraseña, sin OWNER o alta terminada no);
 *   - el link del correo de bienvenida abierto DESPUÉS de entrar con código ya no sirve (`validateResetToken`);
 *   - confirmar un cambio de correo limpia el código y el resetToken del buzón anterior;
 *   - reenviar genera un código nuevo.
 */
import crypto from 'crypto'
import { OrgRole } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'

const enviarCorreo = jest.fn().mockResolvedValue(true)
jest.mock('@/services/email.service', () => ({
  __esModule: true,
  default: {
    sendEmailVerification: (...a: unknown[]) => enviarCorreo('verificacion', ...a),
    sendEmail: (...a: unknown[]) => enviarCorreo('correo', ...a),
  },
}))

import { esProspectoDeLanding, reenviarCodigoDeLanding, verificarCodigoDeLanding } from '@/services/onboarding/signup.service'
import { leerBoletoDeAlta } from '@/services/onboarding/boletoDeAlta'
import { validateResetToken } from '@/services/dashboard/auth.service'
import { confirmarCambioDeCorreo, solicitarCambioDeCorreo } from '@/services/dashboard/cambioDeCorreo.service'

const sufijo = `ac${Date.now()}`
const staffIds: string[] = []
const orgIds: string[] = []
const CLAVE = 'una contraseña larga y rara'

beforeAll(() => {
  const url = new URL(process.env.TEST_DATABASE_URL ?? '')
  expect(['localhost', '127.0.0.1']).toContain(url.hostname)
  expect(url.pathname).toMatch(/^\/avoqado_[a-z0-9_]+_test_/)
})

afterAll(async () => {
  // Sólo lo creado aquí; con listas vacías `in: []` no borra nada.
  await prisma.activityLog.deleteMany({ where: { staffId: { in: staffIds } } })
  await prisma.staffOrganization.deleteMany({ where: { staffId: { in: staffIds } } })
  await prisma.staff.deleteMany({ where: { id: { in: staffIds } } })
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } })
  await prisma.$disconnect()
})

beforeEach(() => {
  enviarCorreo.mockClear()
  // `logAction` está simulado globalmente en integración: se revisa la llamada.
  ;(logAction as jest.Mock).mockClear()
})

let n = 0
/** Un prospecto de landing como lo deja `signupFromLanding` con el interruptor prendido. */
async function prospecto(
  opts: { password?: string | null; conOwner?: boolean; altaTerminada?: boolean; codigo?: string | null } = {},
) {
  const { password = null, conOwner = true, altaTerminada = false, codigo = '123456' } = opts
  n++
  const id = `${sufijo}-${n}`
  const resetToken = crypto.randomBytes(32).toString('hex')
  const org = await prisma.organization.create({
    data: { name: id, email: `${id}@test.mx`, phone: '5500000000', ...(altaTerminada ? { onboardingCompletedAt: new Date() } : {}) },
  })
  orgIds.push(org.id)
  const staff = await prisma.staff.create({
    data: {
      email: `${id}@test.mx`,
      firstName: 'Ana',
      lastName: 'Prueba',
      password,
      active: true,
      emailVerified: false,
      emailVerificationCode: codigo,
      emailVerificationExpires: codigo ? new Date(Date.now() + 10 * 60 * 1000) : null,
      resetToken: crypto.createHash('sha256').update(resetToken).digest('hex'),
      resetTokenExpiry: new Date(Date.now() + 24 * 3600 * 1000),
    },
  })
  staffIds.push(staff.id)
  if (conOwner) {
    await prisma.staffOrganization.create({
      data: { staffId: staff.id, organizationId: org.id, role: OrgRole.OWNER, isPrimary: true, isActive: true },
    })
  }
  return { staff, org, resetToken }
}

describe('esProspectoDeLanding con filas reales', () => {
  it('verdadero para el prospecto', async () => {
    const { staff } = await prospecto()
    expect(await esProspectoDeLanding(staff.id)).toBe(true)
  })
  it('falso con contraseña (salvo exigirSinContrasena:false), sin membresía OWNER primaria o con el alta terminada', async () => {
    const conClave = await prospecto({ password: 'hash-propio' })
    expect(await esProspectoDeLanding(conClave.staff.id)).toBe(false)
    expect(await esProspectoDeLanding(conClave.staff.id, { exigirSinContrasena: false })).toBe(true)
    expect(await esProspectoDeLanding((await prospecto({ conOwner: false })).staff.id)).toBe(false)
    expect(await esProspectoDeLanding((await prospecto({ altaTerminada: true })).staff.id)).toBe(false)
  })
})

describe('verificarCodigoDeLanding', () => {
  it('🔴 dos verificaciones simultáneas con el mismo código: exactamente una entra', async () => {
    const { staff } = await prospecto()
    const intentos = await Promise.allSettled([
      verificarCodigoDeLanding({ email: staff.email, codigo: '123456', password: CLAVE }),
      verificarCodigoDeLanding({ email: staff.email, codigo: '123456', password: CLAVE }),
    ])
    const entraron = intentos.filter(i => i.status === 'fulfilled')
    expect(entraron).toHaveLength(1)
    const rechazo = intentos.find(i => i.status === 'rejected') as PromiseRejectedResult
    expect(rechazo.reason.code).toBe('CODIGO_INVALIDO')

    const { entrarUrl } = (entraron[0] as PromiseFulfilledResult<{ entrarUrl: string }>).value
    expect(leerBoletoDeAlta(entrarUrl.split('#boleto=')[1]).staffId).toBe(staff.id)
    const despues = await prisma.staff.findUniqueOrThrow({ where: { id: staff.id } })
    expect(despues.emailVerified).toBe(true)
    expect(despues.password).toBeTruthy()
    expect(despues.emailVerificationCode).toBeNull()
    const bitacora = (logAction as jest.Mock).mock.calls.filter(([a]) => a.action === 'LANDING_EMAIL_VERIFIED_BY_CODE')
    expect(bitacora).toHaveLength(1)
    expect(bitacora[0][0]).toMatchObject({ staffId: staff.id })
  })

  it('🔴 el link del correo abierto DESPUÉS de entrar con código ya no sirve', async () => {
    const { staff, resetToken } = await prospecto()
    await expect(validateResetToken(resetToken)).resolves.toBeDefined() // antes: vigente
    await verificarCodigoDeLanding({ email: staff.email, codigo: '123456', password: CLAVE })
    await expect(validateResetToken(resetToken)).rejects.toThrow()
  })

  it('cuenta con contraseña: CUENTA_YA_ACTIVA y no se toca nada', async () => {
    const { staff } = await prospecto({ password: 'hash-propio' })
    await expect(verificarCodigoDeLanding({ email: staff.email, codigo: '123456', password: CLAVE })).rejects.toMatchObject({
      code: 'CUENTA_YA_ACTIVA',
    })
    expect((await prisma.staff.findUniqueOrThrow({ where: { id: staff.id } })).password).toBe('hash-propio')
  })
})

describe('reenviarCodigoDeLanding', () => {
  it('al prospecto le deja un código nuevo y se lo manda; a una cuenta con contraseña, nada', async () => {
    const { staff } = await prospecto({ codigo: null })
    await reenviarCodigoDeLanding(staff.email.toUpperCase())
    const despues = await prisma.staff.findUniqueOrThrow({ where: { id: staff.id } })
    expect(despues.emailVerificationCode).toMatch(/^\d{6}$/)
    expect(enviarCorreo).toHaveBeenCalledWith('verificacion', staff.email, { firstName: 'Ana', verificationCode: despues.emailVerificationCode })

    enviarCorreo.mockClear()
    const cliente = await prospecto({ password: 'hash-propio', codigo: null })
    await reenviarCodigoDeLanding(cliente.staff.email)
    expect(enviarCorreo).not.toHaveBeenCalled()
    expect((await prisma.staff.findUniqueOrThrow({ where: { id: cliente.staff.id } })).emailVerificationCode).toBeNull()
  })
})

describe('cambio de correo', () => {
  it('confirmar limpia el código y el resetToken del buzón anterior', async () => {
    const { staff } = await prospecto()
    const nuevo = `nuevo-${sufijo}@test.mx`
    await solicitarCambioDeCorreo(staff.id, nuevo)
    const html: string = enviarCorreo.mock.calls.find(c => c[0] === 'correo')![1].html
    const token = decodeURIComponent(html.match(/confirm-email-change\?token=([^"&\s<]+)/)![1])
    await confirmarCambioDeCorreo(token)

    const despues = await prisma.staff.findUniqueOrThrow({ where: { id: staff.id } })
    expect(despues.email).toBe(nuevo)
    expect(despues.emailVerificationCode).toBeNull()
    expect(despues.emailVerificationExpires).toBeNull()
    expect(despues.resetToken).toBeNull()
    expect(despues.resetTokenExpiry).toBeNull()
  })
})
