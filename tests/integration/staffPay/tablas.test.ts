import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import * as activityAudit from '@/services/activityAudit.service'
import { crearTabla, publicarVersion, listarTablas, archivarTabla, historialDeTabla } from '@/services/dashboard/staffPay/tablas.service'

jest.mock('@/services/dashboard/staffPay/acceso', () => ({ sedesConServicePay: jest.fn(async () => (global as any).__sedes) }))

const key = `tablas-${process.pid}-${Date.now()}`
let org: string, venue: string, product: string, hc: string, staff: string
const celdas = (max: number, monto: (n: number) => number) =>
  Array.from({ length: max + 1 }, (_, count) => ({ payLevelId: hc, count, amount: monto(count) }))

beforeAll(async () => {
  org = (await prisma.organization.create({ data: { name: key, slug: key, email: `${key}@example.test`, phone: '5500000000' } })).id
  venue = (await prisma.venue.create({ data: { organizationId: org, name: key, slug: key, timezone: 'America/Mexico_City' } })).id
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
  hc = (await prisma.staffPayLevel.create({ data: { organizationId: org, name: 'Head Coach' } })).id
  staff = (await prisma.staff.create({ data: { email: `${key}@example.test`, firstName: 'A', lastName: 'B', active: true } })).id
})
afterAll(async () => {
  if (!org) return
  await prisma.venue.deleteMany({ where: { organizationId: org } })
  await prisma.staffPayLevel.deleteMany({ where: { organizationId: org } })
  await prisma.staff.deleteMany({ where: { email: { startsWith: key } } })
  await prisma.organization.delete({ where: { id: org } })
})

describe('tablas — feature nueva', () => {
  it('publicar dos veces el mismo día crea revisiones 1 y 2; la vigente es la 2', async () => {
    const t = await crearTabla({ venueId: venue, organizationId: org, name: 'Todas', productIds: [], actorId: staff })
    await publicarVersion({
      venueId: venue,
      organizationId: org,
      tableId: t.id,
      effectiveFrom: '2026-09-01',
      countMode: 'BOOKED',
      maxCount: 2,
      cells: celdas(2, () => 400),
      actorId: staff,
      soloSimular: false,
    })
    const r2 = await publicarVersion({
      venueId: venue,
      organizationId: org,
      tableId: t.id,
      effectiveFrom: '2026-09-01',
      countMode: 'BOOKED',
      maxCount: 2,
      cells: celdas(2, () => 450),
      actorId: staff,
      soloSimular: false,
    })
    expect(r2.revision).toBe(2)
    const [vig] = await listarTablas(venue, '2026-09-10')
    expect(vig.vigente?.revision).toBe(2)
    expect(vig.vigente?.cells.every(c => c.amount === 450)).toBe(true)
    expect((await historialDeTabla(venue, t.id)).map(v => v.revision)).toEqual([2, 1])
  })
  it('simular no guarda la versión', async () => {
    const [t] = await listarTablas(venue, '2026-09-10')
    const antes = await prisma.servicePayTableVersion.count({ where: { tableId: t.id } })
    await publicarVersion({
      venueId: venue,
      organizationId: org,
      tableId: t.id,
      effectiveFrom: '2026-09-02',
      countMode: 'BOOKED',
      maxCount: 2,
      cells: celdas(2, () => 1),
      actorId: staff,
      soloSimular: true,
    })
    expect(await prisma.servicePayTableVersion.count({ where: { tableId: t.id } })).toBe(antes)
  })
})

describe('tablas — regresión', () => {
  it('rechaza ATTENDED en la fase 1 (spec §5.5)', async () => {
    const [t] = await listarTablas(venue, '2026-09-10')
    await expect(
      publicarVersion({
        venueId: venue,
        organizationId: org,
        tableId: t.id,
        effectiveFrom: '2026-09-03',
        countMode: 'ATTENDED',
        maxCount: 2,
        cells: celdas(2, () => 1),
        actorId: staff,
        soloSimular: false,
      }),
    ).rejects.toThrow('todavía no está disponible')
  })
  it('rechaza celdas fuera de 0..maxCount, repetidas, o de un nivel de otra organización', async () => {
    const [t] = await listarTablas(venue, '2026-09-10')
    const base = {
      venueId: venue,
      organizationId: org,
      tableId: t.id,
      effectiveFrom: '2026-09-04',
      countMode: 'BOOKED' as const,
      maxCount: 2,
      actorId: staff,
      soloSimular: false,
    }
    const antes = await prisma.servicePayTableVersion.count({ where: { tableId: t.id } })
    await expect(publicarVersion({ ...base, cells: [{ payLevelId: hc, count: 3, amount: 1 }] })).rejects.toThrow('fuera de la tabla')
    await expect(
      publicarVersion({
        ...base,
        cells: [
          { payLevelId: hc, count: 1, amount: 1 },
          { payLevelId: hc, count: 1, amount: 2 },
        ],
      }),
    ).rejects.toThrow('repetida')
    await expect(publicarVersion({ ...base, cells: [{ payLevelId: 'cxxxxxxxxxxxxxxxxxxxxxxxx', count: 1, amount: 1 }] })).rejects.toThrow(
      'Nivel no encontrado',
    )
    // Review Focus 5 también en el service (el MCP no pasa por el Zod de la ruta): techo absurdo y monto negativo.
    await expect(publicarVersion({ ...base, maxCount: 10_000, cells: [] })).rejects.toThrow('Máximo 500 lugares')
    await expect(publicarVersion({ ...base, cells: [{ payLevelId: hc, count: 1, amount: -5 }] })).rejects.toThrow('no puede ser negativo')
    expect(await prisma.servicePayTableVersion.count({ where: { tableId: t.id } })).toBe(antes)
  })
  it('rechaza un segundo «todas las clases» o el mismo producto en dos tablas específicas vigentes', async () => {
    await expect(crearTabla({ venueId: venue, organizationId: org, name: 'Otra', productIds: [], actorId: staff })).rejects.toThrow(
      'Ya existe una tabla para todas las clases',
    )
    await crearTabla({ venueId: venue, organizationId: org, name: 'Reformer', productIds: [product], actorId: staff })
    await expect(
      crearTabla({ venueId: venue, organizationId: org, name: 'Reformer 2', productIds: [product], actorId: staff }),
    ).rejects.toThrow('ya tiene una tabla')
  })
  it('archivar con fecha deja vigentes las clases anteriores', async () => {
    const t = await prisma.servicePayTable.findFirstOrThrow({ where: { venueId: venue, name: 'Reformer' } })
    await archivarTabla({ venueId: venue, tableId: t.id, archivedFrom: '2026-12-01', actorId: staff })
    expect((await listarTablas(venue, '2026-11-30')).some(x => x.id === t.id)).toBe(true)
    expect((await listarTablas(venue, '2026-12-01')).some(x => x.id === t.id)).toBe(false)
  })
  it('el empate se rechaza también al publicar y al mover el archivo: la tabla de reemplazo no se traslapa con la archivada', async () => {
    const vieja = await prisma.servicePayTable.findFirstOrThrow({ where: { venueId: venue, name: 'Reformer' } })
    const base = { venueId: venue, organizationId: org, countMode: 'BOOKED' as const, maxCount: 2, actorId: staff, soloSimular: false }
    // Específica + «todas» NO es empate: la específica gana por precedencia.
    await publicarVersion({ ...base, tableId: vieja.id, effectiveFrom: '2026-09-01', cells: celdas(2, () => 500) })
    // La vieja está archivada desde el 1-dic: se puede crear su reemplazo desde ya.
    const nueva = await crearTabla({ venueId: venue, organizationId: org, name: 'Reformer nueva', productIds: [product], actorId: staff })
    await expect(publicarVersion({ ...base, tableId: nueva.id, effectiveFrom: '2026-11-01', cells: celdas(2, () => 600) })).rejects.toThrow(
      'chocaría con «Reformer»',
    )
    // También en la simulación (el aviso de efecto no puede «pasar» lo que guardar rechazaría).
    await expect(
      publicarVersion({ ...base, tableId: nueva.id, effectiveFrom: '2026-11-01', cells: celdas(2, () => 600), soloSimular: true }),
    ).rejects.toThrow('chocaría')
    const ok = await publicarVersion({ ...base, tableId: nueva.id, effectiveFrom: '2026-12-01', cells: celdas(2, () => 600) })
    expect(ok.revision).toBe(1)
    // Alargar el archivo de la vieja la volvería a traslapar con la nueva.
    await expect(archivarTabla({ venueId: venue, tableId: vieja.id, archivedFrom: '2027-01-01', actorId: staff })).rejects.toThrow(
      'chocaría con «Reformer nueva»',
    )
    // Una versión de la nueva anterior a su primera fecha tampoco cabe.
    await expect(publicarVersion({ ...base, tableId: nueva.id, effectiveFrom: '2026-10-15', cells: celdas(2, () => 600) })).rejects.toThrow(
      'chocaría',
    )
    const especificas = (await listarTablas(venue, '2026-12-15')).filter(x => x.productIds.includes(product) && x.vigente)
    expect(especificas.map(x => x.name)).toEqual(['Reformer nueva'])
  })
  it('dos publicaciones simultáneas con la misma revisión dan un conflicto claro, no un 500 anónimo', async () => {
    const [t] = await listarTablas(venue, '2026-09-10')
    // La carrera real (doble clic) no es determinista: se reproduce su firma, un P2002 dentro de la transacción.
    const spy = jest
      .spyOn(activityAudit, 'writeLegacyActivityAuditTx')
      .mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' }))
    try {
      await expect(
        publicarVersion({
          venueId: venue,
          organizationId: org,
          tableId: t.id,
          effectiveFrom: '2026-09-05',
          countMode: 'BOOKED',
          maxCount: 2,
          cells: celdas(2, () => 1),
          actorId: staff,
          soloSimular: false,
        }),
      ).rejects.toThrow('al mismo tiempo')
    } finally {
      spy.mockRestore()
    }
  })
})
