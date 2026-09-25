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
import { authorizeRole } from '../../../src/middlewares/authorizeRole.middleware'

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

/** Corre el middleware REAL con un authContext dado y dice si dejó pasar. */
async function pasa(allowed: StaffRole[], authContext: Record<string, unknown>): Promise<boolean> {
  let paso = false
  const res = { status: () => res, json: () => res } as any
  await (authorizeRole(allowed) as any)({ authContext } as any, res, (err?: unknown) => {
    paso = !err
  })
  return paso
}

describe('authorizeRole — el rol se relee de la base, no se le cree al token', () => {
  // 🔴 (Codex gpt-6-astra, 24-sep) `authorizeRole` sólo miraba `authContext.role`, o sea lo escrito
  // en el token. Un token de DUEÑO emitido por el defecto del cambio de sucursal (vive 24 h) seguía
  // pasando, y la compra de tokens de IA cobra con la tarjeta guardada del negocio.
  it('🔴 un token que DICE dueño en B, de alguien que en B es mesera, no pasa', async () => {
    expect(await pasa([StaffRole.OWNER, StaffRole.ADMIN], { userId: mixta, orgId: orgB, venueId: b1, role: StaffRole.OWNER })).toBe(false)
  })

  it('la dueña real de A pasa en A, también en una sucursal donde no tiene fila (regresión)', async () => {
    expect(await pasa([StaffRole.OWNER], { userId: mixta, orgId: orgA, venueId: a1, role: StaffRole.OWNER })).toBe(true)
    expect(await pasa([StaffRole.OWNER], { userId: mixta, orgId: orgA, venueId: a2, role: StaffRole.OWNER })).toBe(true)
  })

  it('🔴 un token que DICE superadmin, de alguien que no lo es, no pasa', async () => {
    expect(await pasa([StaffRole.SUPERADMIN], { userId: mixta, orgId: orgA, venueId: a1, role: StaffRole.SUPERADMIN })).toBe(false)
  })

  it('🔴 una cuenta DESACTIVADA no pasa aunque su token diga dueño', async () => {
    const baja = await persona('baja')
    await prisma.staffOrganization.create({ data: { staffId: baja, organizationId: orgA, role: 'OWNER', isActive: true, isPrimary: true } })
    await prisma.staffVenue.create({ data: { staffId: baja, venueId: a1, role: StaffRole.OWNER, active: true } })
    expect(await pasa([StaffRole.OWNER], { userId: baja, orgId: orgA, venueId: a1, role: StaffRole.OWNER })).toBe(true)
    await prisma.staff.update({ where: { id: baja }, data: { active: false } })
    expect(await pasa([StaffRole.OWNER], { userId: baja, orgId: orgA, venueId: a1, role: StaffRole.OWNER })).toBe(false)
  })

  it('un superadmin real pasa (regresión)', async () => {
    const sa = await persona('superadmin')
    await prisma.staffVenue.create({ data: { staffId: sa, venueId: a1, role: StaffRole.SUPERADMIN, active: true } })
    expect(await pasa([StaffRole.SUPERADMIN], { userId: sa, orgId: orgA, venueId: b2, role: StaffRole.SUPERADMIN })).toBe(true)
  })

  it('dueña en alta (sucursal «pending»): pasa como dueña de su organización (regresión)', async () => {
    expect(await pasa([StaffRole.OWNER], { userId: mixta, orgId: orgA, venueId: 'pending', role: StaffRole.OWNER })).toBe(true)
  })

  it('impersonación: vale si quien actúa es un superadmin real (regresión)', async () => {
    const sa2 = await persona('superadmin2')
    await prisma.staffVenue.create({ data: { staffId: sa2, venueId: a1, role: StaffRole.SUPERADMIN, active: true } })
    const ctx = { userId: sa2, realUserId: sa2, orgId: orgB, venueId: b1, role: StaffRole.OWNER, isImpersonating: true }
    expect(await pasa([StaffRole.OWNER], ctx)).toBe(true)
    // y un «impersonador» que no es superadmin, no
    expect(await pasa([StaffRole.OWNER], { ...ctx, userId: mixta, realUserId: mixta })).toBe(false)
  })
})
