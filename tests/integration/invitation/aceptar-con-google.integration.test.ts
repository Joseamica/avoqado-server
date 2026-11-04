/**
 * Aceptar con Google una invitación por correo — el recorrido entero contra Postgres real (hz:e0c38c0d:D2, 4-nov-2026).
 *
 * Rafa fue invitado (la invitación le creó una cuenta PROVISIONAL), apretó «Continuar con Google» y el servidor le
 * contestó 4 veces «Account is inactive». Ahora el login con Google acepta su ÚNICA invitación viva con el mismo
 * `acceptInvitation` del formulario. Lo que Google no puede completar (PIN, varias invitaciones) se rechaza sin prender
 * la cuenta: la invitación ya le dejó una membresía activa en la organización y prenderla le abriría la organización.
 */
import { OrgRole, StaffRole } from '@prisma/client'
import prisma from '../../../src/utils/prismaClient'
import { cancelInvitation, inviteTeamMember } from '../../../src/services/dashboard/team.dashboard.service'
import { loginWithGoogle } from '../../../src/services/dashboard/googleOAuth.service'

jest.mock('../../../src/services/email.service', () => ({
  __esModule: true,
  default: {
    sendInvitationEmail: jest.fn().mockResolvedValue(true),
    sendTeamInvitation: jest.fn().mockResolvedValue(true),
    sendEmail: jest.fn().mockResolvedValue(true),
  },
}))

/** El correo con el que «Google» contesta en cada prueba. */
let mockCorreoDeGoogle = ''
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({
    generateAuthUrl: jest.fn().mockReturnValue('https://accounts.google.test/auth'),
    getToken: jest.fn().mockResolvedValue({ tokens: { id_token: 'id-token' } }),
    verifyIdToken: jest.fn().mockImplementation(async () => ({
      getPayload: () => ({
        sub: `g-${mockCorreoDeGoogle}`,
        email: mockCorreoDeGoogle,
        name: 'Persona Invitada',
        given_name: 'Persona',
        family_name: 'Invitada',
        email_verified: true,
      }),
    })),
  })),
}))

const sufijo = `gi${Date.now()}`
const ids: { orgs: string[]; venues: string[]; staff: string[] } = { orgs: [], venues: [], staff: [] }
let orgId: string
let venueId: string
let invitador: string

beforeAll(async () => {
  const o = await prisma.organization.create({
    data: { name: `Org Google ${sufijo}`, email: `org-${sufijo}@test.mx`, phone: '5555555555', seatCapExempt: true },
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
  const inv = await prisma.staff.create({
    data: { email: `invitador-${sufijo}@test.mx`, firstName: 'In', lastName: 'Vitador', emailVerified: true },
  })
  invitador = inv.id
  ids.staff.push(inv.id)
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

async function invitarPorCorreo(nombre: string, extra: { requirePin?: boolean } = {}) {
  const email = `${nombre}-${sufijo}@test.mx`
  await inviteTeamMember(venueId, invitador, { email, firstName: 'Rafa', lastName: 'Prueba', role: StaffRole.VIEWER, ...extra })
  const staff = await prisma.staff.findUniqueOrThrow({ where: { email } })
  ids.staff.push(staff.id)
  const invitacion = await prisma.invitation.findFirstOrThrow({ where: { email, organizationId: orgId }, orderBy: { createdAt: 'desc' } })
  return { email, staff, invitacion }
}

describe('aceptar una invitación por correo con Google', () => {
  it('🔴 la cuenta provisional entra con Google y su invitación queda aceptada (el caso de Rafa)', async () => {
    const { email, staff, invitacion } = await invitarPorCorreo('rafa')
    expect(staff.active).toBe(false) // así la deja la invitación

    mockCorreoDeGoogle = email
    const login = await loginWithGoogle('id-token', false)

    expect(login.accessToken).toBeTruthy()
    expect(login.isNewUser).toBe(true)
    const despues = await prisma.staff.findUniqueOrThrow({ where: { id: staff.id } })
    expect(despues).toMatchObject({ active: true, emailVerified: true, googleId: `g-${email}` })
    const sv = await prisma.staffVenue.findFirstOrThrow({ where: { staffId: staff.id, venueId } })
    expect(sv).toMatchObject({ role: StaffRole.VIEWER, active: true })
    expect((await prisma.invitation.findUniqueOrThrow({ where: { id: invitacion.id } })).status).toBe('ACCEPTED')
  })

  it('🔴 si la invitación pide PIN, no prende la cuenta ni acepta: pide el formulario', async () => {
    const { email, staff, invitacion } = await invitarPorCorreo('conpin', { requirePin: true })

    mockCorreoDeGoogle = email
    await expect(loginWithGoogle('id-token', false)).rejects.toMatchObject({ code: 'INVITACION_PIDE_PIN' })

    expect((await prisma.staff.findUniqueOrThrow({ where: { id: staff.id } })).active).toBe(false)
    expect((await prisma.invitation.findUniqueOrThrow({ where: { id: invitacion.id } })).status).toBe('PENDING')
  })

  it('🔴 invitado como dueño, cancelado y reinvitado como mesero: al aceptar queda MIEMBRO, no dueño de la organización', async () => {
    const email = `exdueno-${sufijo}@test.mx`
    await inviteTeamMember(venueId, invitador, { email, firstName: 'Ex', lastName: 'Dueno', role: StaffRole.OWNER })
    const staff = await prisma.staff.findUniqueOrThrow({ where: { email } })
    ids.staff.push(staff.id)
    const deDueno = await prisma.invitation.findFirstOrThrow({ where: { email, organizationId: orgId } })
    await cancelInvitation(venueId, deDueno.id)
    await inviteTeamMember(venueId, invitador, { email, firstName: 'Ex', lastName: 'Dueno', role: StaffRole.WAITER })

    mockCorreoDeGoogle = email
    await loginWithGoogle('id-token', false)

    const membresia = await prisma.staffOrganization.findUniqueOrThrow({
      where: { staffId_organizationId: { staffId: staff.id, organizationId: orgId } },
    })
    expect(membresia.role).toBe(OrgRole.MEMBER)
    expect((await prisma.staffVenue.findFirstOrThrow({ where: { staffId: staff.id, venueId } })).role).toBe(StaffRole.WAITER)
  })

  it('🔴 alguien dado de baja (su cuenta ya se usó) no se reactiva con Google aunque lo vuelvan a invitar', async () => {
    const email = `baja-${sufijo}@test.mx`
    const baja = await prisma.staff.create({
      data: { email, firstName: 'Ba', lastName: 'Ja', active: false, emailVerified: true, lastLoginAt: new Date('2026-10-01T12:00:00Z') },
    })
    ids.staff.push(baja.id)
    await inviteTeamMember(venueId, invitador, { email, firstName: 'Ba', lastName: 'Ja', role: StaffRole.VIEWER })

    mockCorreoDeGoogle = email
    await expect(loginWithGoogle('id-token', false)).rejects.toThrow('Account is inactive')

    expect((await prisma.staff.findUniqueOrThrow({ where: { id: baja.id } })).active).toBe(false)
  })
})
