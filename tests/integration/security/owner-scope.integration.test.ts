/**
 * Ser DUEÑO en un negocio no te hace dueño de OTRO — contra Postgres real.
 *
 * 🔴 El defecto (Codex gpt-6-astra, 24-sep, verificado en el código): `switchVenueForStaff` y
 * `userHasVenueAccess` calculaban «es dueño» sobre TODAS las sucursales de la persona y luego sólo
 * exigían una membresía ACTIVA en la organización destino, con cualquier rol. Quien era dueño en A
 * y mesero en B recibía un token de DUEÑO en B — y hay compras del dashboard que confían en ese
 * rol y cobran con la tarjeta guardada del negocio.
 *
 * La regla correcta, la misma que ya usa la lista de negocios del dashboard: dueño de ESA
 * organización = `StaffOrganization.role = OWNER` activa en ella, o (cuentas viejas) una sucursal
 * propia con rol OWNER dentro de ESA organización.
 */
import { StaffRole } from '@prisma/client'
import jwt from 'jsonwebtoken'
import prisma from '../../../src/utils/prismaClient'
import { switchVenueForStaff } from '../../../src/services/dashboard/auth.service'
import { userHasVenueAccess } from '../../../src/services/staffOrganization.service'

/** El rol viaja DENTRO del token: es lo que después leen `authorizeRole` y el dashboard. */
const rolDelToken = (r: { accessToken: string }) => (jwt.decode(r.accessToken) as { role: StaffRole }).role

const sufijo = `os${Date.now()}`
const ids: { orgs: string[]; venues: string[]; staff: string[] } = { orgs: [], venues: [], staff: [] }

async function org(nombre: string) {
  const o = await prisma.organization.create({
    data: { name: `${nombre} ${sufijo}`, email: `${nombre}-${sufijo}@test.mx`, phone: '5555555555' },
  })
  ids.orgs.push(o.id)
  return o.id
}
async function venue(organizationId: string, nombre: string) {
  const v = await prisma.venue.create({
    data: {
      name: `${nombre} ${sufijo}`,
      slug: `${nombre}-${sufijo}`.toLowerCase(),
      organizationId,
      address: 'Calle 1',
      city: 'CDMX',
      country: 'Mexico',
      timezone: 'America/Mexico_City',
      currency: 'MXN',
      status: 'ACTIVE',
    },
  })
  ids.venues.push(v.id)
  return v.id
}
async function persona(nombre: string) {
  const s = await prisma.staff.create({
    data: { email: `${nombre}-${sufijo}@test.mx`, firstName: nombre, lastName: 'Prueba', emailVerified: true },
  })
  ids.staff.push(s.id)
  return s.id
}

let orgA: string, orgB: string
let a1: string, a2: string, b1: string, b2: string
let mixta: string // dueña en A, mesera en B
let legacy: string // dueño por sucursal, con membresía MEMBER (cuentas viejas)

beforeAll(async () => {
  orgA = await org('OrgA')
  orgB = await org('OrgB')
  a1 = await venue(orgA, 'A1')
  a2 = await venue(orgA, 'A2')
  b1 = await venue(orgB, 'B1')
  b2 = await venue(orgB, 'B2')

  mixta = await persona('mixta')
  await prisma.staffOrganization.createMany({
    data: [
      { staffId: mixta, organizationId: orgA, role: 'OWNER', isActive: true, isPrimary: true },
      { staffId: mixta, organizationId: orgB, role: 'MEMBER', isActive: true, isPrimary: false },
    ],
  })
  await prisma.staffVenue.createMany({
    data: [
      { staffId: mixta, venueId: a1, role: StaffRole.OWNER, active: true },
      { staffId: mixta, venueId: b1, role: StaffRole.WAITER, active: true },
    ],
  })

  legacy = await persona('legacy')
  await prisma.staffOrganization.create({
    data: { staffId: legacy, organizationId: orgA, role: 'MEMBER', isActive: true, isPrimary: true },
  })
  await prisma.staffVenue.create({ data: { staffId: legacy, venueId: a1, role: StaffRole.OWNER, active: true } })
})

afterAll(async () => {
  await prisma.session.deleteMany({ where: { staffId: { in: ids.staff } } }).catch(() => undefined)
  await prisma.staffVenue.deleteMany({ where: { staffId: { in: ids.staff } } })
  await prisma.staffOrganization.deleteMany({ where: { staffId: { in: ids.staff } } })
  await prisma.staff.deleteMany({ where: { id: { in: ids.staff } } })
  await prisma.venue.deleteMany({ where: { id: { in: ids.venues } } })
  await prisma.organization.deleteMany({ where: { id: { in: ids.orgs } } })
  await prisma.$disconnect()
})

describe('cambiar de sucursal — el rol es el de ESA organización', () => {
  it('🔴 dueña en A y mesera en B: al entrar a B es MESERA, no dueña', async () => {
    expect(rolDelToken(await switchVenueForStaff(mixta, orgA, b1))).toBe(StaffRole.WAITER)
  })

  it('🔴 dueña en A: a una sucursal de B donde NO trabaja, no entra', async () => {
    await expect(switchVenueForStaff(mixta, orgA, b2)).rejects.toThrow()
  })

  it('dueña en A: entra como DUEÑA a otra sucursal de A aunque no tenga fila ahí (regresión)', async () => {
    expect(rolDelToken(await switchVenueForStaff(mixta, orgA, a2))).toBe(StaffRole.OWNER)
  })

  it('cuenta vieja (dueño por sucursal, membresía MEMBER): sigue entrando como dueño a su organización', async () => {
    expect(rolDelToken(await switchVenueForStaff(legacy, orgA, a2))).toBe(StaffRole.OWNER)
  })
})

describe('userHasVenueAccess — la misma regla', () => {
  it('🔴 dueña en A: NO tiene acceso a una sucursal de B donde no trabaja', async () => {
    expect(await userHasVenueAccess(mixta, b2)).toBe(false)
  })

  it('sí tiene acceso a donde trabaja (B1) y a toda su organización (A2)', async () => {
    expect(await userHasVenueAccess(mixta, b1)).toBe(true)
    expect(await userHasVenueAccess(mixta, a2)).toBe(true)
  })

  it('cuenta vieja: acceso a toda su organización (regresión)', async () => {
    expect(await userHasVenueAccess(legacy, a2)).toBe(true)
  })
})
