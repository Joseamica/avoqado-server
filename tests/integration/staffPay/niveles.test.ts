import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { crearNivel, editarNivel, asignarNivel, nivelesVigentes, historialDeNivel } from '@/services/dashboard/staffPay/niveles.service'
import { fromZonedTime } from 'date-fns-tz'
import { fechaComoDbDate, hoyLocal } from '@/services/dashboard/staffPay/periodos'

jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  assertPermisoEnTodasLasSedes: jest.fn().mockResolvedValue(undefined),
  sedesConServicePay: jest.fn(async () => (global as any).__sedes),
}))

const key = `niveles-${process.pid}-${Date.now()}`
let org: string, venue: string, product: string, ana: string

beforeAll(async () => {
  org = (await prisma.organization.create({ data: { name: key, slug: key, email: `${key}@example.test`, phone: '5500000000' } })).id
  const v = await prisma.venue.create({ data: { organizationId: org, name: key, slug: key, timezone: 'America/Mexico_City' } })
  venue = v.id
  ;(global as any).__sedes = [venue]
  const cat = await prisma.menuCategory.create({ data: { venueId: venue, name: 'C', slug: `${key}-c`, availableDays: [] } })
  product = (
    await prisma.product.create({
      data: {
        venueId: venue,
        categoryId: cat.id,
        sku: `${key}-p`,
        name: 'Reformer',
        type: 'CLASS',
        price: new Prisma.Decimal(300),
        duration: 50,
        maxParticipants: 10,
        tags: [],
        allergens: [],
      },
    })
  ).id
  ana = (await prisma.staff.create({ data: { email: `${key}-ana@example.test`, firstName: 'Ana', lastName: 'T', active: true } })).id
  await prisma.staffVenue.create({ data: { staffId: ana, venueId: venue, role: 'MANAGER', active: true } })
})
afterAll(async () => {
  // Guarda: si beforeAll falló, nunca correr deleteMany({ organizationId: undefined }) contra toda la base de pruebas.
  if (!org) return
  if (venue) await prisma.venue.deleteMany({ where: { organizationId: org } })
  await prisma.staffPayLevelAssignment.deleteMany({ where: { organizationId: org } })
  await prisma.staffPayLevel.deleteMany({ where: { organizationId: org } })
  if (venue) await prisma.activityLog.deleteMany({ where: { venueId: venue } })
  await prisma.staff.deleteMany({ where: { email: { startsWith: key } } })
  await prisma.organization.delete({ where: { id: org } })
})

describe('niveles — feature nueva', () => {
  it('crea un nivel y deja ActivityLog en la misma transacción', async () => {
    const n = await crearNivel({ organizationId: org, name: 'Head Coach', actorId: ana, venueId: venue })
    expect(await prisma.activityLog.count({ where: { entity: 'StaffPayLevel', entityId: n.id, action: 'STAFF_PAY_LEVEL_CREATED' } })).toBe(
      1,
    )
  })
  it('rechaza nombre repetido en la organización con mensaje claro', async () => {
    await expect(crearNivel({ organizationId: org, name: 'Head Coach', actorId: ana, venueId: venue })).rejects.toThrow(
      'Ya existe un nivel',
    )
  })
  it('asignar el mismo día dos veces crea revisiones 1 y 2; gana la 2', async () => {
    const hc = await prisma.staffPayLevel.findFirstOrThrow({ where: { organizationId: org, name: 'Head Coach' } })
    const c = await crearNivel({ organizationId: org, name: 'Coach', actorId: ana, venueId: venue })
    await asignarNivel({
      organizationId: org,
      staffId: ana,
      payLevelId: hc.id,
      effectiveFrom: '2026-09-01',
      actorId: ana,
      venueId: venue,
      soloSimular: false,
    })
    await asignarNivel({
      organizationId: org,
      staffId: ana,
      payLevelId: c.id,
      effectiveFrom: '2026-09-01',
      actorId: ana,
      venueId: venue,
      soloSimular: false,
    })
    const hist = await historialDeNivel(org, ana)
    expect(hist.map(h => h.revision)).toEqual([2, 1])
    expect((await nivelesVigentes(org, '2026-09-10')).find(v => v.staffId === ana)?.payLevelName).toBe('Coach')
  })
  it('simular no guarda nada y cuenta cuántas clases cambian de monto', async () => {
    const hc = await prisma.staffPayLevel.findFirstOrThrow({ where: { organizationId: org, name: 'Head Coach' } })
    const coach = await prisma.staffPayLevel.findFirstOrThrow({ where: { organizationId: org, name: 'Coach' } })
    const t = await prisma.servicePayTable.create({ data: { venueId: venue, name: 'Todas', productIds: [] } })
    const ver = await prisma.servicePayTableVersion.create({
      data: { tableId: t.id, effectiveFrom: fechaComoDbDate('2026-01-01'), revision: 1, maxCount: 2 },
    })
    await prisma.servicePayTableCell.createMany({
      data: [0, 1, 2].flatMap(count => [
        { versionId: ver.id, payLevelId: hc.id, count, amount: new Prisma.Decimal(500) },
        { versionId: ver.id, payLevelId: coach.id, count, amount: new Prisma.Decimal(400) },
      ]),
    })
    // Clase terminada DENTRO del periodo abierto aunque hoy sea día 1 a la medianoche (sin pruebas que fallen el 1º).
    const tz = 'America/Mexico_City'
    const primeroDelMes = hoyLocal(tz).slice(0, 8) + '01'
    const inicioMes = fromZonedTime(`${primeroDelMes}T00:01:00.000`, tz)
    const s = new Date(Math.max(Date.now() - 7_200_000, inicioMes.getTime()))
    const e = new Date(Math.min(s.getTime() + 60_000, Date.now() - 1_000))
    await prisma.classSession.create({
      data: { venueId: venue, productId: product, startsAt: s, endsAt: e, duration: 1, capacity: 2, assignedStaffId: ana },
    })
    const antes = await prisma.staffPayLevelAssignment.count({ where: { staffId: ana } })
    const hoy = primeroDelMes
    const r = await asignarNivel({
      organizationId: org,
      staffId: ana,
      payLevelId: hc.id,
      effectiveFrom: hoy,
      actorId: ana,
      venueId: venue,
      soloSimular: true,
    })
    expect(r.clasesQueCambian).toBe(1)
    expect(await prisma.staffPayLevelAssignment.count({ where: { staffId: ana } })).toBe(antes)
  })
})

describe('niveles — regresión', () => {
  it('archivar un nivel en uso no rompe asignaciones históricas', async () => {
    const coach = await prisma.staffPayLevel.findFirstOrThrow({ where: { organizationId: org, name: 'Coach' } })
    await editarNivel({ organizationId: org, levelId: coach.id, archived: true, actorId: ana, venueId: venue })
    expect((await nivelesVigentes(org, '2026-09-10')).find(v => v.staffId === ana)?.payLevelName).toBe('Coach')
  })
  it('no se asigna un nivel archivado ni de otra organización', async () => {
    const coach = await prisma.staffPayLevel.findFirstOrThrow({ where: { organizationId: org, name: 'Coach' } })
    await expect(
      asignarNivel({
        organizationId: org,
        staffId: ana,
        payLevelId: coach.id,
        effectiveFrom: '2026-10-01',
        actorId: ana,
        venueId: venue,
        soloSimular: false,
      }),
    ).rejects.toThrow('archivado')
    await expect(
      asignarNivel({
        organizationId: org,
        staffId: ana,
        payLevelId: 'cxxxxxxxxxxxxxxxxxxxxxxxx',
        effectiveFrom: '2026-10-01',
        actorId: ana,
        venueId: venue,
        soloSimular: false,
      }),
    ).rejects.toThrow('Nivel no encontrado')
  })
})
