/**
 * Cambiar el correo del perfil exige demostrar que el correo NUEVO es tuyo — contra Postgres real.
 *
 * 🔴 El defecto (Codex gpt-6-astra, 24-sep): el perfil reemplazaba el correo al instante,
 * conservando `emailVerified` y la contraseña. Un intruso ponía en SU cuenta el correo (aún libre)
 * de otra persona; cuando esa persona entraba con Google, el login la encontraba por correo, la
 * veía verificada y conservaba la contraseña del intruso: los dos compartían la cuenta.
 *
 * Ahora el correo sólo cambia al abrir un enlace firmado que llega AL CORREO NUEVO.
 */
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret-email-change'

const enviar = jest.fn().mockResolvedValue(true)
jest.mock('../../../src/services/email.service', () => ({ __esModule: true, default: { sendEmail: (...a: unknown[]) => enviar(...a) } }))

import jwt from 'jsonwebtoken'
import prisma from '../../../src/utils/prismaClient'
import { logAction } from '../../../src/services/dashboard/activity-log.service'
import { confirmarCambioDeCorreo, solicitarCambioDeCorreo } from '../../../src/services/dashboard/cambioDeCorreo.service'

const sufijo = `ec${Date.now()}`
const ids: string[] = []

async function persona(nombre: string) {
  const s = await prisma.staff.create({
    data: { email: `${nombre}-${sufijo}@test.mx`, firstName: nombre, lastName: 'Prueba', emailVerified: true, password: 'hash-propio' },
  })
  ids.push(s.id)
  return s
}
/** El token viaja en el enlace del correo: se saca de ahí, como lo haría la persona. */
function tokenDelCorreo(): string {
  const html: string = enviar.mock.calls.at(-1)[0].html
  const m = html.match(/confirm-email-change\?token=([^"&\s<]+)/)
  if (!m) throw new Error('el correo no trae el enlace')
  return decodeURIComponent(m[1])
}

beforeEach(() => enviar.mockClear())

afterAll(async () => {
  await prisma.activityLog.deleteMany({ where: { staffId: { in: ids } } })
  await prisma.staff.deleteMany({ where: { id: { in: ids } } })
  await prisma.$disconnect()
})

it('🔴 pedir el cambio NO cambia el correo: manda el enlace al correo NUEVO', async () => {
  const yo = await persona('yo')
  const nuevo = `nuevo-${sufijo}@test.mx`
  await solicitarCambioDeCorreo(yo.id, nuevo)

  expect((await prisma.staff.findUniqueOrThrow({ where: { id: yo.id } })).email).toBe(yo.email)
  expect(enviar).toHaveBeenCalledTimes(1)
  expect(enviar.mock.calls[0][0].to).toBe(nuevo)
})

it('abrir el enlace cambia el correo, lo deja verificado y queda en la bitácora', async () => {
  const yo = await persona('yo2')
  const nuevo = `NUEVO2-${sufijo}@test.mx`
  await solicitarCambioDeCorreo(yo.id, nuevo)
  await confirmarCambioDeCorreo(tokenDelCorreo())

  const despues = await prisma.staff.findUniqueOrThrow({ where: { id: yo.id } })
  expect(despues.email).toBe(nuevo.toLowerCase())
  expect(despues.emailVerified).toBe(true)
  // `logAction` está simulado globalmente en integración: se revisa la llamada.
  expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'STAFF_EMAIL_CHANGED', staffId: yo.id, entityId: yo.id }))
})

it('🔴 un correo que ya usa otra persona no se puede pedir', async () => {
  const yo = await persona('yo3')
  const otra = await persona('otra3')
  await expect(solicitarCambioDeCorreo(yo.id, otra.email)).rejects.toMatchObject({ statusCode: 409 })
  expect(enviar).not.toHaveBeenCalled()
})

it('🔴 si el correo nuevo se ocupó entre pedir y confirmar, el enlace ya no sirve', async () => {
  const yo = await persona('yo4')
  const nuevo = `carrera-${sufijo}@test.mx`
  await solicitarCambioDeCorreo(yo.id, nuevo)
  const token = tokenDelCorreo()
  const ganadora = await prisma.staff.create({ data: { email: nuevo, firstName: 'G', lastName: 'G' } })
  ids.push(ganadora.id)
  await expect(confirmarCambioDeCorreo(token)).rejects.toMatchObject({ statusCode: 409 })
})

it('🔴 un enlace viejo (el correo ya cambió después) no se puede reusar', async () => {
  const yo = await persona('yo5')
  await solicitarCambioDeCorreo(yo.id, `primero-${sufijo}@test.mx`)
  const viejo = tokenDelCorreo()
  await solicitarCambioDeCorreo(yo.id, `segundo-${sufijo}@test.mx`)
  await confirmarCambioDeCorreo(tokenDelCorreo())
  await expect(confirmarCambioDeCorreo(viejo)).rejects.toMatchObject({ statusCode: 400 })
})

it('🔴 un enlace inventado o de sesión no sirve', async () => {
  const yo = await persona('yo6')
  const falso = jwt.sign(
    { sub: yo.id, correoNuevo: `robado-${sufijo}@test.mx`, correoAnterior: yo.email },
    process.env.ACCESS_TOKEN_SECRET!,
  )
  await expect(confirmarCambioDeCorreo(falso)).rejects.toMatchObject({ statusCode: 400 })
  await expect(confirmarCambioDeCorreo('basura')).rejects.toMatchObject({ statusCode: 400 })
})

it('🔴 el enlace NO sirve como sesión: no lo firma la llave de las sesiones', async () => {
  const yo = await persona('yo7')
  await solicitarCambioDeCorreo(yo.id, `sesion-${sufijo}@test.mx`)
  expect(() => jwt.verify(tokenDelCorreo(), process.env.ACCESS_TOKEN_SECRET!, { algorithms: ['HS256'] })).toThrow()
})

describe('segunda pasada de Codex', () => {
  it('🔴 N3: si el correo NO se pudo enviar, pedir el cambio falla (no se promete un enlace que no existe)', async () => {
    const yo = await persona('n3')
    enviar.mockResolvedValueOnce(false)
    await expect(solicitarCambioDeCorreo(yo.id, `n3-nuevo-${sufijo}@test.mx`)).rejects.toMatchObject({ statusCode: 503 })
  })

  it('🔴 N4: el cambio queda en la bitácora CON su organización (si no, el dueño no lo ve)', async () => {
    const yo = await persona('n4')
    const org = await prisma.organization.create({ data: { name: `N4 ${sufijo}`, email: `n4org-${sufijo}@test.mx`, phone: '5555555555' } })
    await prisma.staffOrganization.create({
      data: { staffId: yo.id, organizationId: org.id, role: 'OWNER', isActive: true, isPrimary: true },
    })
    await solicitarCambioDeCorreo(yo.id, `n4-nuevo-${sufijo}@test.mx`)
    await confirmarCambioDeCorreo(tokenDelCorreo())
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'STAFF_EMAIL_CHANGED', staffId: yo.id, organizationId: org.id }),
    )
    await prisma.staffOrganization.deleteMany({ where: { organizationId: org.id } })
    await prisma.organization.delete({ where: { id: org.id } })
  })

  it('🔴 N1: si la dueña cambió su contraseña DESPUÉS de pedirse el cambio, el enlace ya no sirve', async () => {
    // Quien robó una sesión pide cambiar el correo a SU buzón; la dueña recupera su cuenta.
    const yo = await persona('n1')
    await solicitarCambioDeCorreo(yo.id, `n1-ladron-${sufijo}@test.mx`)
    const token = tokenDelCorreo()
    await prisma.staff.update({ where: { id: yo.id }, data: { lastPasswordReset: new Date(Date.now() + 60_000) } })
    await expect(confirmarCambioDeCorreo(token)).rejects.toMatchObject({ statusCode: 400 })
    expect((await prisma.staff.findUniqueOrThrow({ where: { id: yo.id } })).email).toBe(yo.email)
  })
})
