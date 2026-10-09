/**
 * Plano de mesas — publicación contra Postgres real (spec 2026-10-08 §5.2).
 *   TEST_DATABASE_URL='postgresql://…/avoqado_planomesas_test_20261008' \
 *     npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/floor-plan/publishFloorPlan.integration.test.ts
 */
// La bitácora FLOOR_PLAN_PUBLISHED se prueba de verdad: el setup de integración simula `logAction`.
jest.unmock('@/services/dashboard/activity-log.service')
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { getFloorPlan, publishFloorPlan } from '@/services/dashboard/floorPlan/floorPlan.service'
import { getTablesWithStatus, updateTablePosition } from '@/services/tpv/table.tpv.service'
import { getFloorElements } from '@/services/tpv/floor-element.tpv.service'
import type { DesiredTable, PublishFloorPlanInput } from '@/services/dashboard/floorPlan/floorPlan.types'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))

const target = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(target.hostname) || !/^\/avoqado_[a-z0-9]+_test_/.test(target.pathname)) {
  throw new Error('Exige una base de prueba local y desechable (p. ej. avoqado_planomesas_test_20261008).')
}

let venueId: string
let staffId: string

beforeEach(async () => {
  venueId = `plano-${randomUUID()}`
  await prisma.organization.create({ data: { id: venueId, name: 'Plano org', email: `${venueId}@example.test`, phone: '5500000000' } })
  await prisma.venue.create({ data: { id: venueId, organizationId: venueId, name: 'Plano restaurante', slug: venueId } })
  staffId = (await prisma.staff.create({ data: { email: `${venueId}@staff.test`, firstName: 'Plano', lastName: 'Dueña' } })).id
})

afterEach(async () => {
  await prisma.table.updateMany({ where: { venueId }, data: { currentOrderId: null } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.floorPlanPublication.deleteMany({ where: { venueId } })
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.floorElement.deleteMany({ where: { venueId } })
  await prisma.table.deleteMany({ where: { venueId } })
  await prisma.area.deleteMany({ where: { venueId } })
  await prisma.staff.deleteMany({ where: { id: staffId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: venueId } })
})

afterAll(() => prisma.$disconnect())

const mesa = (clientId: string, number: string, extra: Partial<DesiredTable> = {}): DesiredTable => ({
  clientId,
  number,
  capacity: 4,
  shape: 'SQUARE',
  rotation: 0,
  positionX: 0.5,
  positionY: 0.5,
  areaRef: 'a1',
  ...extra,
})
const publish = (input: Partial<PublishFloorPlanInput> & { baseFingerprint: string }) =>
  publishFloorPlan(venueId, { saveId: randomUUID(), areas: [], tables: [], elements: [], ...input }, staffId)
const salonNuevo = { clientId: 'a1', name: 'Salón', floorShape: 'WIDE' as const, sortOrder: 0 }
const salon = (id: string) => ({ id, name: 'Salón', floorShape: 'WIDE' as const, sortOrder: 0 })
const conMesas = async (...tables: DesiredTable[]) =>
  publish({ baseFingerprint: (await getFloorPlan(venueId)).fingerprint, areas: [salonNuevo], tables })

describe('publishFloorPlan', () => {
  it('publica un salón nuevo, lo devuelve igual, avisa a los POS y la PAX lo lee', async () => {
    const broadcastToVenue = jest.fn()
    jest.requireMock('@/communication/sockets').default.getBroadcastingService.mockReturnValueOnce({ broadcastToVenue })
    const empty = await getFloorPlan(venueId)
    expect(empty).toMatchObject({ areas: [], tables: [], elements: [], overLimit: false })
    expect(empty.fingerprint).toMatch(/^[0-9a-f]{16}$/)

    const out = await publish({
      baseFingerprint: empty.fingerprint,
      areas: [salonNuevo],
      tables: [mesa('t1', '1', { positionX: 0.25 }), mesa('t2', '2', { capacity: 2, shape: 'ROUND', rotation: 45, positionX: 0.75 })],
      elements: [
        { type: 'WALL', areaRef: 'a1', positionX: 0, positionY: 0, endX: 1, endY: 0, rotation: 0 },
        { type: 'SERVICE_AREA', areaRef: 'a1', positionX: 0.7, positionY: 0.05, width: 0.25, height: 0.3, rotation: 0, label: 'Cocina' },
      ],
    })
    expect(out.replayed).toBe(false)
    const areaId = out.areas[0].id
    expect(out.tables.map(t => [t.number, t.positionX, t.areaId])).toEqual([
      ['1', 0.25, areaId],
      ['2', 0.75, areaId],
    ])
    expect((await getFloorPlan(venueId)).fingerprint).toBe(out.fingerprint)
    expect(broadcastToVenue).toHaveBeenCalledWith(venueId, 'floor_plan_updated', { fingerprint: out.fingerprint })

    const pax = await getTablesWithStatus(venueId)
    expect(pax.find(t => t.number === '2')).toMatchObject({ positionX: 0.75, positionY: 0.5, rotation: 45, areaId })
    expect((await getFloorElements(venueId)).map(e => e.type).sort()).toEqual(['SERVICE_AREA', 'WALL'])
  })

  it('el mismo folio no publica dos veces (reintento de red)', async () => {
    const empty = await getFloorPlan(venueId)
    const body: PublishFloorPlanInput = {
      saveId: randomUUID(),
      baseFingerprint: empty.fingerprint,
      areas: [salonNuevo],
      tables: [],
      elements: [],
    }
    const first = await publishFloorPlan(venueId, body, staffId)
    const second = await publishFloorPlan(venueId, body, staffId)
    expect(second.replayed).toBe(true)
    expect(second.publicationId).toBe(first.publicationId)
    expect(await prisma.area.count({ where: { venueId } })).toBe(1)
  })

  it('409 si la PAX movió una mesa mientras se editaba, y no cambia nada', async () => {
    const created = await conMesas(mesa('t1', '1'))
    await updateTablePosition(venueId, created.tables[0].id, 0.1, 0.1)
    await expect(publish({ baseFingerprint: created.fingerprint, areas: [salon(created.areas[0].id)], tables: [] })).rejects.toMatchObject({
      statusCode: 409,
      code: 'FLOOR_PLAN_CHANGED',
    })
    expect(await prisma.table.count({ where: { venueId, active: true } })).toBe(1)
  })

  it('422 y nada cambia si se quita una mesa con cuenta abierta', async () => {
    const created = await conMesas(mesa('t1', '7'))
    const tableId = created.tables[0].id
    const order = await prisma.order.create({
      data: { venueId, orderNumber: `PLANO-${randomUUID()}`, subtotal: 100, taxAmount: 0, total: 100, tableId },
    })
    await prisma.table.update({ where: { id: tableId }, data: { currentOrderId: order.id, status: 'OCCUPIED' } })
    const now = await getFloorPlan(venueId)
    expect(now.fingerprint).toBe(created.fingerprint) // abrir una cuenta no cambia el plano
    expect(now.tables[0].hasOpenOrder).toBe(true)
    await expect(publish({ baseFingerprint: now.fingerprint, areas: [salon(created.areas[0].id)], tables: [] })).rejects.toMatchObject({
      statusCode: 422,
      code: 'TABLES_WITH_OPEN_ORDERS',
      details: { numbers: ['7'] },
    })
    expect(await prisma.table.findUniqueOrThrow({ where: { id: tableId } })).toMatchObject({ active: true })
  })

  it('una cuenta que se abre MIENTRAS se publica también frena quitar la mesa (candado de fila)', async () => {
    const created = await conMesas(mesa('t1', '9'))
    const tableId = created.tables[0].id
    const order = await prisma.order.create({
      data: { venueId, orderNumber: `PLANO-${randomUUID()}`, subtotal: 100, taxAmount: 0, total: 100, tableId },
    })
    // Otra transacción (como `assignTable`) ya tiene la mesa y está a punto de colgarle la cuenta.
    let soltar!: () => void
    const suelta = new Promise<void>(r => (soltar = r))
    let tomada!: () => void
    const mesaTomada = new Promise<void>(r => (tomada = r))
    const abrirCuenta = prisma.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT id FROM "Table" WHERE id = ${tableId} FOR UPDATE`
        tomada()
        await suelta
        await tx.table.update({ where: { id: tableId }, data: { currentOrderId: order.id, status: 'OCCUPIED' } })
      },
      { timeout: 30_000 },
    )
    await mesaTomada
    // La publicación leyó el plano SIN cuenta (misma huella) y queda esperando el candado de la mesa.
    const publicando = publish({ baseFingerprint: created.fingerprint, areas: [salon(created.areas[0].id)], tables: [] })
    publicando.catch(() => undefined)
    let esperando = 0
    for (let i = 0; i < 200 && !esperando; i++) {
      const [row] = await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%"Table"%'`
      esperando = row.n
      if (!esperando) await new Promise(r => setTimeout(r, 25))
    }
    expect(esperando).toBe(1)
    soltar()
    await abrirCuenta
    await expect(publicando).rejects.toMatchObject({ statusCode: 422, code: 'TABLES_WITH_OPEN_ORDERS', details: { numbers: ['9'] } })
    expect(await prisma.table.findUniqueOrThrow({ where: { id: tableId } })).toMatchObject({ active: true, currentOrderId: order.id })
  })

  it('quitar y volver a crear el número revive la misma mesa (historial y QR)', async () => {
    const created = await conMesas(mesa('t1', '5'))
    const original = await prisma.table.findUniqueOrThrow({ where: { id: created.tables[0].id } })
    const area = salon(created.areas[0].id)
    const removed = await publish({ baseFingerprint: created.fingerprint, areas: [area], tables: [] })
    expect(await prisma.table.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({ active: false })
    const back = await publish({
      baseFingerprint: removed.fingerprint,
      areas: [area],
      tables: [mesa('x', '5', { capacity: 6, shape: 'RECTANGLE', areaRef: area.id })],
    })
    expect(back.tables.map(t => t.id)).toEqual([original.id])
    expect(await prisma.table.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({
      active: true,
      qrCode: original.qrCode,
      capacity: 6,
      status: 'AVAILABLE',
    })
  })

  it('intercambia números y nombres de área en un solo guardado', async () => {
    const empty = await getFloorPlan(venueId)
    const created = await publish({
      baseFingerprint: empty.fingerprint,
      areas: [salonNuevo, { clientId: 'a2', name: 'Terraza', floorShape: 'WIDE', sortOrder: 1 }],
      tables: [mesa('t1', '1'), mesa('t2', '2', { positionX: 0.2 })],
    })
    const [s, te] = created.areas
    const t1 = created.tables.find(t => t.number === '1')!
    const t2 = created.tables.find(t => t.number === '2')!
    const keep = (t: typeof t1, number: string): DesiredTable => ({
      id: t.id,
      number,
      capacity: t.capacity,
      shape: t.shape,
      rotation: t.rotation,
      positionX: t.positionX,
      positionY: t.positionY,
      areaRef: t.areaId,
    })
    const out = await publish({
      baseFingerprint: created.fingerprint,
      areas: [
        { id: s.id, name: 'Terraza', floorShape: 'WIDE', sortOrder: 0 },
        { id: te.id, name: 'Salón', floorShape: 'SQUARE', sortOrder: 1 },
      ],
      tables: [keep(t1, '2'), keep(t2, '1')],
    })
    expect(out.tables.find(t => t.id === t1.id)!.number).toBe('2')
    expect(out.tables.find(t => t.id === t2.id)!.number).toBe('1')
    expect(out.areas.find(a => a.id === s.id)).toMatchObject({ name: 'Terraza' })
    expect(out.areas.find(a => a.id === te.id)).toMatchObject({ name: 'Salón', floorShape: 'SQUARE' })
  })

  it('renombrar la 7 a 5 mientras se quita la 5 archiva la 5 con otro número', async () => {
    const created = await conMesas(mesa('t5', '5'), mesa('t7', '7', { positionX: 0.2 }))
    const t5 = created.tables.find(t => t.number === '5')!
    const t7 = created.tables.find(t => t.number === '7')!
    const out = await publish({
      baseFingerprint: created.fingerprint,
      areas: [salon(created.areas[0].id)],
      tables: [
        { id: t7.id, number: '5', capacity: 4, shape: 'SQUARE', rotation: 0, positionX: 0.2, positionY: 0.5, areaRef: created.areas[0].id },
      ],
    })
    expect(out.tables).toEqual([expect.objectContaining({ id: t7.id, number: '5' })])
    expect(await prisma.table.findUniqueOrThrow({ where: { id: t5.id } })).toMatchObject({ active: false, number: '5 (archivada)' })
  })

  it('borrar un área archiva sus elementos y las mesas movidas quedan en la otra', async () => {
    const empty = await getFloorPlan(venueId)
    const created = await publish({
      baseFingerprint: empty.fingerprint,
      areas: [salonNuevo, { clientId: 'a2', name: 'Terraza', floorShape: 'WIDE', sortOrder: 1 }],
      tables: [mesa('t1', '1', { areaRef: 'a2' })],
      elements: [{ type: 'LABEL', areaRef: 'a2', positionX: 0.1, positionY: 0.1, rotation: 0, label: 'Terraza' }],
    })
    const salonId = created.areas.find(a => a.name === 'Salón')!.id
    const t1 = created.tables[0]
    const out = await publish({
      baseFingerprint: created.fingerprint,
      areas: [salon(salonId)],
      tables: [{ id: t1.id, number: '1', capacity: 4, shape: 'SQUARE', rotation: 0, positionX: 0.5, positionY: 0.5, areaRef: salonId }],
    })
    expect(out.areas.map(a => a.name)).toEqual(['Salón'])
    expect(out.tables[0].areaId).toBe(salonId)
    expect(await prisma.floorElement.count({ where: { venueId, active: true } })).toBe(0)
  })

  it('un elemento que se muda de un área borrada a otra sigue activo en su nueva área', async () => {
    const empty = await getFloorPlan(venueId)
    const created = await publish({
      baseFingerprint: empty.fingerprint,
      areas: [salonNuevo, { clientId: 'a2', name: 'Terraza', floorShape: 'WIDE', sortOrder: 1 }],
      elements: [{ type: 'LABEL', areaRef: 'a2', positionX: 0.1, positionY: 0.1, rotation: 0, label: 'Barra fría' }],
    })
    const salonId = created.areas.find(a => a.name === 'Salón')!.id
    const label = created.elements[0]
    const out = await publish({
      baseFingerprint: created.fingerprint,
      areas: [salon(salonId)],
      elements: [{ id: label.id, type: 'LABEL', areaRef: salonId, positionX: 0.2, positionY: 0.2, rotation: 0, label: 'Barra fría' }],
    })
    expect(out.elements).toEqual([expect.objectContaining({ id: label.id, areaId: salonId, positionX: 0.2 })])
    expect(await prisma.floorElement.findUniqueOrThrow({ where: { id: label.id } })).toMatchObject({ active: true, areaId: salonId })
  })

  it('deja bitácora con quién publicó y qué mesas cambiaron', async () => {
    await conMesas(mesa('t1', '1'))
    let log = null
    for (let i = 0; i < 40 && !log; i++) {
      log = await prisma.activityLog.findFirst({ where: { venueId, action: 'FLOOR_PLAN_PUBLISHED' } })
      if (!log) await new Promise(r => setTimeout(r, 50)) // logAction es fire-and-forget
    }
    expect(log).toMatchObject({ staffId, entity: 'Venue', entityId: venueId })
    expect((log!.data as { tables: { createdNumbers: string[] } }).tables.createdNumbers).toEqual(['1'])
  })

  it('rechaza con 400 y su código una regla del plano (números repetidos)', async () => {
    const empty = await getFloorPlan(venueId)
    await expect(
      publish({ baseFingerprint: empty.fingerprint, areas: [salonNuevo], tables: [mesa('a', '3'), mesa('b', '3')] }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'TABLE_NUMBER_DUPLICATED',
    })
  })
})
