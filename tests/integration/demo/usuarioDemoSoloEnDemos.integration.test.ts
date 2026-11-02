/**
 * hz:f26b3afc:D5 — los usuarios demo (`@demo.avoqado.io`) tienen contraseña pública (va en el PDF de prospectos). D4 cerró
 * las invitaciones, pero el SUPERADMIN podía darles un negocio real directo (Codex r4 de la marca demo). La barrera vive en
 * la BASE, como la del traslado de IVA: cubre los ~26 caminos que escriben membresías, los que vengan y el SQL directo.
 * Contra Postgres real. Sin limpieza a propósito: ids únicos en una base desechable.
 *   TEST_DATABASE_URL='postgresql://…/avoqado_demod5_test_20261102' \
 *     npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/demo/usuarioDemoSoloEnDemos.integration.test.ts
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { esUsuarioDemoEnNegocioReal } from '@/services/demo/candadoDemo'
import { assignToOrganization, upsertVenueAssignment } from '@/services/superadmin/staff.superadmin.service'

const target = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(target.hostname) || !/^\/avoqado_(?:[a-z0-9]+|cambio_r5)_test_/.test(target.pathname)) {
  throw new Error('Exige una base de prueba local y desechable (p. ej. avoqado_demod5_test_20261102).')
}

afterAll(() => prisma.$disconnect())

const id = (p: string) => `${p}-${randomUUID()}`
async function organizacion() {
  const o = id('org')
  await prisma.organization.create({ data: { id: o, name: 'Org', email: `${o}@example.test`, phone: '5500000000' } })
  return o
}
async function negocio(organizationId: string, status: 'LIVE_DEMO' | 'ACTIVE') {
  const v = id('venue')
  await prisma.venue.create({ data: { id: v, organizationId, name: 'Negocio', slug: v, status } })
  return v
}
async function persona(dominio: 'demo.avoqado.io' | 'example.test') {
  const s = id('staff')
  await prisma.staff.create({ data: { id: s, email: `${s}@${dominio}`, firstName: 'P', lastName: 'Q' } })
  return s
}
const rechazo = (p: Promise<unknown>) =>
  p.then(
    () => 'pasó',
    e => (esUsuarioDemoEnNegocioReal(e) ? 'rechazado' : `otro error: ${e}`),
  )

describe('🔴 un usuario demo NO entra a un negocio real, por ningún camino', () => {
  it('sucursal real (StaffVenue)', async () => {
    const [demo, real] = [await persona('demo.avoqado.io'), await negocio(await organizacion(), 'ACTIVE')]
    expect(await rechazo(prisma.staffVenue.create({ data: { staffId: demo, venueId: real, role: 'OWNER' } }))).toBe('rechazado')
  })

  it('organización con un negocio real (StaffOrganization)', async () => {
    const org = await organizacion()
    await negocio(org, 'ACTIVE')
    const demo = await persona('demo.avoqado.io')
    expect(await rechazo(prisma.staffOrganization.create({ data: { staffId: demo, organizationId: org } }))).toBe('rechazado')
  })

  it('mover su membresía de un demo a un negocio real (UPDATE)', async () => {
    const org = await organizacion()
    const [enDemo, real, demo] = [
      await negocio(org, 'LIVE_DEMO'),
      await negocio(await organizacion(), 'ACTIVE'),
      await persona('demo.avoqado.io'),
    ]
    const sv = await prisma.staffVenue.create({ data: { staffId: demo, venueId: enDemo, role: 'OWNER' } })
    expect(await rechazo(prisma.staffVenue.update({ where: { id: sv.id }, data: { venueId: real } }))).toBe('rechazado')
  })

  it('volver real un negocio demo con un usuario demo adentro', async () => {
    const org = await organizacion()
    const [v, demo] = [await negocio(org, 'LIVE_DEMO'), await persona('demo.avoqado.io')]
    await prisma.staffVenue.create({ data: { staffId: demo, venueId: v, role: 'OWNER' } })
    expect(await rechazo(prisma.venue.update({ where: { id: v }, data: { status: 'ACTIVE' } }))).toBe('rechazado')
  })

  it('mover un negocio real a la organización de un demo', async () => {
    const orgDemo = await organizacion()
    const demo = await persona('demo.avoqado.io')
    await prisma.staffOrganization.create({ data: { staffId: demo, organizationId: orgDemo } })
    const real = await negocio(await organizacion(), 'ACTIVE')
    expect(await rechazo(prisma.venue.update({ where: { id: real }, data: { organizationId: orgDemo } }))).toBe('rechazado')
  })

  it('crear un negocio real dentro de la organización de un demo', async () => {
    const orgDemo = await organizacion()
    await prisma.staffOrganization.create({ data: { staffId: await persona('demo.avoqado.io'), organizationId: orgDemo } })
    expect(await rechazo(negocio(orgDemo, 'ACTIVE'))).toBe('rechazado')
  })

  it('SQL directo (P2010)', async () => {
    const [demo, real] = [await persona('demo.avoqado.io'), await negocio(await organizacion(), 'ACTIVE')]
    const sql = Prisma.sql`INSERT INTO "StaffVenue" (id, "staffId", "venueId", role) VALUES (${id('sv')}, ${demo}, ${real}, 'OWNER')`
    expect(await rechazo(prisma.$executeRaw(sql))).toBe('rechazado')
  })

  it('🔴 Codex D5 r1-1 · ser SUPERADMIN en su propio demo (da permisos globales)', async () => {
    const v = await negocio(await organizacion(), 'LIVE_DEMO')
    const demo = await persona('demo.avoqado.io')
    expect(await rechazo(prisma.staffVenue.create({ data: { staffId: demo, venueId: v, role: 'SUPERADMIN' } }))).toBe('rechazado')
    const sv = await prisma.staffVenue.create({ data: { staffId: demo, venueId: v, role: 'OWNER' } })
    expect(await rechazo(prisma.staffVenue.update({ where: { id: sv.id }, data: { role: 'SUPERADMIN' } }))).toBe('rechazado')
  })

  it('🔴 Codex D5 r1-2 · un negocio demo dentro de una organización real (el dueño de una sucursal ve la organización)', async () => {
    const org = await organizacion()
    await negocio(org, 'ACTIVE')
    const [enDemo, demo] = [await negocio(org, 'LIVE_DEMO'), await persona('demo.avoqado.io')]
    expect(await rechazo(prisma.staffVenue.create({ data: { staffId: demo, venueId: enDemo, role: 'OWNER' } }))).toBe('rechazado')
  })

  it('🔴 Codex D5 r1-2 · un negocio real nuevo en la organización donde un demo sólo tiene su sucursal', async () => {
    const org = await organizacion()
    const [enDemo, demo] = [await negocio(org, 'LIVE_DEMO'), await persona('demo.avoqado.io')]
    await prisma.staffVenue.create({ data: { staffId: demo, venueId: enDemo, role: 'OWNER' } })
    expect(await rechazo(negocio(org, 'ACTIVE'))).toBe('rechazado')
  })

  it('🔴 Codex D5 r1-4 · cambiarle el correo a un usuario demo (su contraseña pública seguiría abriendo la cuenta)', async () => {
    const demo = await persona('demo.avoqado.io')
    expect(await rechazo(prisma.staff.update({ where: { id: demo }, data: { email: `${demo}@example.test` } }))).toBe('rechazado')
    await prisma.staff.update({ where: { id: demo }, data: { firstName: 'Demo', email: `otro-${demo}@demo.avoqado.io` } })
  })

  it('🔴 Codex D5 r1-3 · dos transacciones a la vez no arman la combinación prohibida', async () => {
    const org = await organizacion()
    const demo = await persona('demo.avoqado.io')
    let soltar!: () => void
    const suelta = new Promise<void>(r => (soltar = r))
    let insertada!: () => void
    const yaInsertada = new Promise<void>(r => (insertada = r))
    const t1 = prisma.$transaction(
      async tx => {
        await tx.staffOrganization.create({ data: { staffId: demo, organizationId: org } })
        insertada()
        await suelta
      },
      { timeout: 30_000 },
    )
    await yaInsertada
    const t2 = rechazo(negocio(org, 'ACTIVE')) // sin el candado de la organización, no ve la membresía sin confirmar
    await new Promise(r => setTimeout(r, 500))
    soltar()
    await t1
    expect(await t2).toBe('rechazado')
  })

  it('🔴 Codex D5 r2-1 · trasladar el negocio demo, con su usuario demo adentro, a una organización real', async () => {
    const real = await organizacion()
    await negocio(real, 'ACTIVE')
    const [enDemo, demo] = [await negocio(await organizacion(), 'LIVE_DEMO'), await persona('demo.avoqado.io')]
    await prisma.staffVenue.create({ data: { staffId: demo, venueId: enDemo, role: 'OWNER' } })
    expect(await rechazo(prisma.venue.update({ where: { id: enDemo }, data: { organizationId: real } }))).toBe('rechazado')
  })

  it('🔴 Codex r4 · las dos funciones del SUPERADMIN', async () => {
    const org = await organizacion()
    const real = await negocio(org, 'ACTIVE')
    const demo = await persona('demo.avoqado.io')
    expect(await rechazo(assignToOrganization(demo, org, 'MEMBER'))).toBe('rechazado')
    // Sin la organización, la sucursal ya la niega su propia validación («Asígnelo primero a la organización»).
    await expect(upsertVenueAssignment(prisma, demo, real, 'OWNER')).rejects.toThrow()
    expect(await prisma.staffOrganization.count({ where: { staffId: demo } })).toBe(0)
    expect(await prisma.staffVenue.count({ where: { staffId: demo } })).toBe(0)
  })
})

describe('lo que sigue pasando', () => {
  it('la semilla demo, en su orden: organización vacía → usuario → negocio LIVE_DEMO → su sucursal', async () => {
    const org = await organizacion()
    const demo = await persona('demo.avoqado.io')
    await prisma.staffOrganization.create({ data: { staffId: demo, organizationId: org, role: 'MEMBER', isPrimary: true } })
    const v = await negocio(org, 'LIVE_DEMO')
    await prisma.staffVenue.create({ data: { staffId: demo, venueId: v, role: 'OWNER', pin: '1234' } })
    await prisma.venue.update({ where: { id: v }, data: { name: 'Café Tostado' } })
    await prisma.staffVenue.deleteMany({ where: { venueId: v } })
    await prisma.venue.delete({ where: { id: v } }) // el reinicio de las 3:00 borra y recrea
    expect(await prisma.staffOrganization.count({ where: { staffId: demo } })).toBe(1)
  })

  it('una persona real entra a negocios reales y demo, y sus negocios cambian de estado y de organización', async () => {
    const [org, otra] = [await organizacion(), await organizacion()]
    const [real, enDemo, s] = [await negocio(org, 'ACTIVE'), await negocio(org, 'LIVE_DEMO'), await persona('example.test')]
    await prisma.staffOrganization.create({ data: { staffId: s, organizationId: org } })
    await prisma.staffVenue.create({ data: { staffId: s, venueId: real, role: 'OWNER' } })
    await prisma.staffVenue.create({ data: { staffId: s, venueId: enDemo, role: 'OWNER' } })
    await prisma.venue.update({ where: { id: enDemo }, data: { status: 'ACTIVE' } })
    await prisma.venue.update({ where: { id: enDemo }, data: { status: 'SUSPENDED' } })
    await prisma.venue.update({ where: { id: real }, data: { organizationId: otra } })
    await prisma.staffOrganization.create({ data: { staffId: s, organizationId: otra } })
    expect(await upsertVenueAssignment(prisma, s, real, 'MANAGER')).toBeTruthy()
  })
})
