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
import { inviteTeamMember } from '../../../src/services/dashboard/team.dashboard.service'
import { organizationDashboardService } from '../../../src/services/organization-dashboard/organizationDashboard.service'

jest.mock('../../../src/services/email.service', () => ({
  __esModule: true,
  default: {
    sendInvitationEmail: jest.fn().mockResolvedValue(true),
    sendTeamInvitation: jest.fn().mockResolvedValue(true),
    sendEmail: jest.fn().mockResolvedValue(true),
  },
}))

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
  it('🔴 persona NUEVA invitada desde el dashboard (cuenta PROVISIONAL creada por la invitación): acepta con su contraseña', async () => {
    // Así la deja `team.dashboard.service` al invitar un correo sin cuenta: inactiva, sin verificar,
    // sin contraseña, sin Google. El candado de S1 NO debe tratarla como una cuenta ajena.
    const provisional = await persona('provisional', { active: false, emailVerified: false, password: null })
    const token = await invitar(provisional.email)
    const r = await acceptInvitation(token, { firstName: 'Nueva', lastName: 'Invitada', password: 'Provisional1' })
    expect(r.user.id).toBe(provisional.id)
    const despues = await prisma.staff.findUniqueOrThrow({ where: { id: provisional.id } })
    expect(despues.password).not.toBeNull()
    expect(despues.active).toBe(true)
  })

  it('🔴 una cuenta que YA se usó (entró alguna vez) no cuenta como provisional aunque no tenga contraseña', async () => {
    const usada = await persona('usada-sin-pass', { active: true, emailVerified: true, password: null, lastLoginAt: new Date() })
    const token = await invitar(usada.email)
    await expect(acceptInvitation(token, { password: 'Atacante123' })).rejects.toMatchObject({ statusCode: 401 })
  })

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

describe('el rol en la organización sale de la INVITACIÓN, no de otros negocios', () => {
  // 🔴 (Codex gpt-6-astra, 24-sep) Aceptar una invitación de MESERO en otra organización guardaba
  // `StaffOrganization.role = ADMIN` si la persona era dueña o admin en CUALQUIER otro negocio, y
  // `requireOrgAdmin` la dejaba administrar la organización ajena (p. ej. borrar terminales).
  it('🔴 dueña de su negocio, invitada como mesera aquí: aquí es MIEMBRO, no admin', async () => {
    const otraOrg = await prisma.organization.create({
      data: { name: `Suya ${sufijo}`, email: `suya-${sufijo}@test.mx`, phone: '5555555555' },
    })
    ids.orgs.push(otraOrg.id)
    const suVenue = await prisma.venue.create({
      data: {
        name: `SuVenue ${sufijo}`,
        slug: `suvenue-${sufijo}`,
        organizationId: otraOrg.id,
        address: 'x',
        city: 'CDMX',
        country: 'Mexico',
        timezone: 'America/Mexico_City',
        currency: 'MXN',
        status: 'ACTIVE',
      },
    })
    ids.venues.push(suVenue.id)
    const hash = await bcrypt.hash('DuenaSuya1', 4)
    const duena = await persona('duena-de-otra', { password: hash })
    await prisma.staffOrganization.create({
      data: { staffId: duena.id, organizationId: otraOrg.id, role: 'OWNER', isActive: true, isPrimary: true },
    })
    await prisma.staffVenue.create({ data: { staffId: duena.id, venueId: suVenue.id, role: StaffRole.OWNER, active: true } })

    const token = await invitar(duena.email) // invitación de MESERA en la organización de prueba
    await acceptInvitation(token, { password: 'DuenaSuya1' })

    const aqui = await prisma.staffOrganization.findUniqueOrThrow({
      where: { staffId_organizationId: { staffId: duena.id, organizationId: orgId } },
    })
    expect(aqui.role).toBe('MEMBER')
    // y su negocio no cambia
    const suya = await prisma.staffOrganization.findUniqueOrThrow({
      where: { staffId_organizationId: { staffId: duena.id, organizationId: otraOrg.id } },
    })
    expect(suya.role).toBe('OWNER')
  })
})

describe('la membresía nace al ACEPTAR, no al invitar', () => {
  // 🔴 (Codex gpt-6-astra, 24-sep) Invitar a alguien que YA tiene cuenta le creaba/reactivaba al
  // instante una membresía activa en la organización de quien invita. Con eso, sin que la persona
  // aceptara nada, el dueño quedaba habilitado para el reset de contraseña de su organización — que
  // devuelve una contraseña temporal GLOBAL: podía quedarse con la cuenta de cualquiera por correo.
  it('🔴 invitar a alguien con cuenta NO le da membresía, y por eso NO se le puede resetear la contraseña', async () => {
    const hash = await bcrypt.hash('SuyaPropia1', 4)
    const ajena = await persona('ajena', { password: hash })

    await inviteTeamMember(venueId, invitador, { email: ajena.email, firstName: 'Aj', lastName: 'Ena', role: StaffRole.WAITER })

    const membresia = await prisma.staffOrganization.findUnique({
      where: { staffId_organizationId: { staffId: ajena.id, organizationId: orgId } },
    })
    expect(membresia?.isActive ?? false).toBe(false)
    await expect(organizationDashboardService.resetUserPassword(orgId, ajena.id, invitador)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('al ACEPTAR (con su contraseña) sí queda como miembro activo', async () => {
    const hash = await bcrypt.hash('AceptoYo123', 4)
    const acepta = await persona('acepta', { password: hash })
    await inviteTeamMember(venueId, invitador, { email: acepta.email, firstName: 'Ac', lastName: 'Epta', role: StaffRole.WAITER })
    const inv = await prisma.invitation.findFirstOrThrow({
      where: { email: acepta.email, organizationId: orgId },
      orderBy: { createdAt: 'desc' },
    })
    await acceptInvitation(inv.token, { password: 'AceptoYo123' })
    const membresia = await prisma.staffOrganization.findUniqueOrThrow({
      where: { staffId_organizationId: { staffId: acepta.id, organizationId: orgId } },
    })
    expect(membresia.isActive).toBe(true)
    expect(membresia.role).toBe('MEMBER')
  })

  it('ex-empleado (membresía INACTIVA) re-invitado: sigue inactiva hasta que acepta, y al aceptar se reactiva', async () => {
    const hash = await bcrypt.hash('Regreso1234', 4)
    const ex = await persona('ex', { password: hash })
    await prisma.staffOrganization.create({
      data: { staffId: ex.id, organizationId: orgId, role: 'MEMBER', isActive: false, isPrimary: false },
    })
    await inviteTeamMember(venueId, invitador, { email: ex.email, firstName: 'Ex', lastName: 'Emp', role: StaffRole.WAITER })
    const antes = await prisma.staffOrganization.findUniqueOrThrow({
      where: { staffId_organizationId: { staffId: ex.id, organizationId: orgId } },
    })
    expect(antes.isActive).toBe(false)
    const inv = await prisma.invitation.findFirstOrThrow({
      where: { email: ex.email, organizationId: orgId },
      orderBy: { createdAt: 'desc' },
    })
    await acceptInvitation(inv.token, { password: 'Regreso1234' })
    const despues = await prisma.staffOrganization.findUniqueOrThrow({
      where: { staffId_organizationId: { staffId: ex.id, organizationId: orgId } },
    })
    expect(despues.isActive).toBe(true)
  })

  it('el reset de contraseña no aplica a una cuenta INACTIVA (p. ej. la provisional de una invitación sin aceptar)', async () => {
    await inviteTeamMember(venueId, invitador, {
      email: `sin-cuenta-${sufijo}@test.mx`,
      firstName: 'Sin',
      lastName: 'Cuenta',
      role: StaffRole.WAITER,
    })
    const provisional = await prisma.staff.findUniqueOrThrow({ where: { email: `sin-cuenta-${sufijo}@test.mx` } })
    ids.staff.push(provisional.id)
    await expect(organizationDashboardService.resetUserPassword(orgId, provisional.id, invitador)).rejects.toMatchObject({
      statusCode: 404,
    })
  })
})
