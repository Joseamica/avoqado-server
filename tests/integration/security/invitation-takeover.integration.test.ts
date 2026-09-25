/**
 * Aceptar una invitación NO puede quedarse con una cuenta ajena — contra Postgres real.
 *
 * 🔴 El ataque (Codex gpt-6-astra, 24-sep; verificado en el código): quien invita recibe el enlace
 * en la respuesta (`team.dashboard.controller.ts`) y la ruta para aceptar es pública. Si la cuenta
 * invitada YA existe y no tiene contraseña —toda cuenta creada con Google—, el servidor aceptaba la
 * contraseña que escribiera quien abriera el enlace y le entregaba la sesión. Cualquier dueño podía
 * invitar el correo de otra persona, abrir él mismo el enlace y quedarse con su cuenta y su negocio.
 *
 * La regla: una cuenta existente SIN contraseña sólo acepta desde una sesión de ESA misma cuenta
 * (quien entra con Google ya trae la suya). Con contraseña, como siempre: hay que saberla.
 */
import bcrypt from 'bcrypt'
import { StaffRole } from '@prisma/client'
import prisma from '../../../src/utils/prismaClient'
import { acceptInvitation } from '../../../src/services/invitation.service'

jest.mock('../../../src/services/email.service', () => ({ __esModule: true, default: { sendInvitationEmail: jest.fn() } }))

const sufijo = `it${Date.now()}`
const ids: { orgs: string[]; venues: string[]; staff: string[] } = { orgs: [], venues: [], staff: [] }
let orgId: string
let venueId: string
let invitador: string

async function persona(nombre: string, extra: Record<string, unknown> = {}) {
  const s = await prisma.staff.create({
    data: { email: `${nombre}-${sufijo}@test.mx`, firstName: nombre, lastName: 'Prueba', emailVerified: true, ...extra },
  })
  ids.staff.push(s.id)
  return s
}
async function invitar(email: string) {
  const inv = await prisma.invitation.create({
    data: {
      email,
      role: StaffRole.WAITER,
      organizationId: orgId,
      venueId,
      invitedById: invitador,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  })
  return inv.token
}

beforeAll(async () => {
  const o = await prisma.organization.create({
    data: { name: `Org atacante ${sufijo}`, email: `org-${sufijo}@test.mx`, phone: '5555555555', seatCapExempt: true },
  })
  orgId = o.id
  ids.orgs.push(o.id)
  const v = await prisma.venue.create({
    data: {
      name: `Sucursal ${sufijo}`,
      slug: `suc-${sufijo}`,
      organizationId: orgId,
      address: 'x',
      city: 'CDMX',
      country: 'Mexico',
      timezone: 'America/Mexico_City',
      currency: 'MXN',
      status: 'ACTIVE',
    },
  })
  venueId = v.id
  ids.venues.push(v.id)
  invitador = (await persona('invitador')).id
})

afterAll(async () => {
  await prisma.session.deleteMany({ where: { staffId: { in: ids.staff } } }).catch(() => undefined)
  await prisma.invitation.deleteMany({ where: { organizationId: { in: ids.orgs } } })
  await prisma.staffVenue.deleteMany({ where: { staffId: { in: ids.staff } } })
  await prisma.staffOrganization.deleteMany({ where: { staffId: { in: ids.staff } } })
  await prisma.staff.deleteMany({ where: { id: { in: ids.staff } } })
  await prisma.venue.deleteMany({ where: { id: { in: ids.venues } } })
  await prisma.organization.deleteMany({ where: { id: { in: ids.orgs } } })
  await prisma.$disconnect()
})

describe('cuenta EXISTENTE sin contraseña (Google)', () => {
  it('🔴 sin sesión, abrir el enlace y escribir una contraseña NO entra a la cuenta', async () => {
    const victima = await persona('victima-google', { googleId: `g-${sufijo}-1`, password: null })
    const token = await invitar(victima.email)

    await expect(acceptInvitation(token, { password: 'Atacante123' })).rejects.toMatchObject({ statusCode: 401 })

    const despues = await prisma.staff.findUniqueOrThrow({ where: { id: victima.id } })
    expect(despues.password).toBeNull()
    const inv = await prisma.invitation.findUniqueOrThrow({ where: { token } })
    expect(inv.status).toBe('PENDING')
  })

  it('🔴 con la sesión de OTRA persona tampoco', async () => {
    const victima = await persona('victima-google-2', { googleId: `g-${sufijo}-2`, password: null })
    const token = await invitar(victima.email)
    await expect(acceptInvitation(token, {}, { sesionStaffId: invitador })).rejects.toMatchObject({ statusCode: 401 })
  })

  it('con la sesión de ESA cuenta (entró con Google) sí acepta — el camino legítimo sigue igual', async () => {
    const duena = await persona('duena-google', { googleId: `g-${sufijo}-3`, password: null })
    const token = await invitar(duena.email)
    const r = await acceptInvitation(token, {}, { sesionStaffId: duena.id })
    expect(r.user.id).toBe(duena.id)
    const sv = await prisma.staffVenue.findFirst({ where: { staffId: duena.id, venueId } })
    expect(sv?.role).toBe(StaffRole.WAITER)
  })
})

describe('regresiones', () => {
  it('cuenta con contraseña: aceptar con SU contraseña funciona sin sesión', async () => {
    const hash = await bcrypt.hash('MiContrasena1', 4)
    const con = await persona('con-contrasena', { password: hash })
    const token = await invitar(con.email)
    const r = await acceptInvitation(token, { password: 'MiContrasena1' })
    expect(r.user.id).toBe(con.id)
  })

  it('cuenta con contraseña: una contraseña equivocada sigue rechazada', async () => {
    const hash = await bcrypt.hash('LaBuena123', 4)
    const con = await persona('con-contrasena-2', { password: hash })
    const token = await invitar(con.email)
    await expect(acceptInvitation(token, { password: 'LaMala1234' })).rejects.toMatchObject({ statusCode: 401 })
  })

  it('persona NUEVA: se crea su cuenta con la contraseña que elige', async () => {
    const email = `nueva-${sufijo}@test.mx`
    const token = await invitar(email)
    const r = await acceptInvitation(token, { firstName: 'Nueva', lastName: 'Persona', password: 'Nueva12345' })
    ids.staff.push(r.user.id)
    const creada = await prisma.staff.findUniqueOrThrow({ where: { id: r.user.id } })
    expect(creada.password).not.toBeNull()
  })
})
