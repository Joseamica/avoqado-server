/**
 * Plano de mesas — publicación contra Postgres real (spec 2026-10-08 §5.2).
 *   TEST_DATABASE_URL='postgresql://…/avoqado_planomesas_test_20261008' \
 *     npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/floor-plan/publishFloorPlan.integration.test.ts
 */
// La bitácora FLOOR_PLAN_PUBLISHED se prueba de verdad: el setup de integración simula `logAction`.
jest.unmock('@/services/dashboard/activity-log.service')
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
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

// 🔴 Vacíos hasta que existan: un `where: { venueId: undefined }` en la limpieza borraría la tabla ENTERA.
let venueId = ''
let staffId = ''

beforeEach(async () => {
  venueId = ''
  staffId = ''
  venueId = `plano-${randomUUID()}`
  await prisma.organization.create({ data: { id: venueId, name: 'Plano org', email: `${venueId}@example.test`, phone: '5500000000' } })
  await prisma.venue.create({ data: { id: venueId, organizationId: venueId, name: 'Plano restaurante', slug: venueId } })
  staffId = (await prisma.staff.create({ data: { email: `${venueId}@staff.test`, firstName: 'Plano', lastName: 'Dueña' } })).id
})

afterEach(async () => {
  if (!venueId) return
  await prisma.table.updateMany({ where: { venueId }, data: { currentOrderId: null } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.floorPlanPublication.deleteMany({ where: { venueId } })
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.floorElement.deleteMany({ where: { venueId } })
  await prisma.table.deleteMany({ where: { venueId } })
  await prisma.area.deleteMany({ where: { venueId } })
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
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
const abrirCuenta = async (tableId: string, paymentStatus: 'PENDING' | 'PAID' = 'PENDING') => {
  const order = await prisma.order.create({
    data: { venueId, orderNumber: `PLANO-${randomUUID()}`, subtotal: 100, taxAmount: 0, total: 100, tableId, paymentStatus },
  })
  await prisma.table.update({ where: { id: tableId }, data: { currentOrderId: order.id, status: 'OCCUPIED' } })
  return order
}
/** Cuántas consultas que tocan `tabla` esperan un candado; reintenta ~5 s (o hasta que `hasta()` diga que ya no tiene caso). */
async function esperandoCandado(tabla: string, hasta: () => boolean = () => false): Promise<number> {
  for (let i = 0; i < 200 && !hasta(); i++) {
    const [row] = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE ${`%"${tabla}"%`}`
    if (row.n) return row.n
    await new Promise(r => setTimeout(r, 25))
  }
  return 0
}
/** Una transacción ajena que toma la fila y la suelta cuando la prueba diga. */
async function tomarFila(tabla: 'Table' | 'Area', id: string, antesDeSoltar?: (tx: Prisma.TransactionClient) => Promise<unknown>) {
  let soltar!: () => void
  const suelta = new Promise<void>(r => (soltar = r))
  let tomada!: () => void
  const filaTomada = new Promise<void>(r => (tomada = r))
  const termina = prisma.$transaction(
    async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM ${Prisma.raw(`"${tabla}"`)} WHERE id = ${id} FOR UPDATE`)
      tomada()
      await suelta
      if (antesDeSoltar) await antesDeSoltar(tx)
    },
    { timeout: 30_000 },
  )
  await filaTomada
  return { soltar, termina }
}

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
    await abrirCuenta(tableId)
    const now = await getFloorPlan(venueId)
    expect(now.fingerprint).toBe(created.fingerprint) // abrir una cuenta no cambia el plano
    expect(now.tables[0].hasOpenOrder).toBe(true)
    await expect(publish({ baseFingerprint: now.fingerprint, areas: [salon(created.areas[0].id)], tables: [] })).rejects.toMatchObject({
      statusCode: 422,
      code: 'TABLES_WITH_OPEN_ORDERS',
      details: { numbers: ['7'] },
      message: 'No se puede quitar la mesa 7: tiene una cuenta abierta. Ciérrala primero.',
    })
    expect(await prisma.table.findUniqueOrThrow({ where: { id: tableId } })).toMatchObject({ active: true })
  })

  it('422 en plural cuando son varias mesas con cuenta abierta («Ciérralas»)', async () => {
    const created = await conMesas(mesa('t8', '8', { positionX: 0.2 }), mesa('t7', '7'))
    for (const t of created.tables) await abrirCuenta(t.id)
    await expect(publish({ baseFingerprint: created.fingerprint, areas: [salon(created.areas[0].id)], tables: [] })).rejects.toMatchObject({
      statusCode: 422,
      code: 'TABLES_WITH_OPEN_ORDERS',
      details: { numbers: ['7', '8'] },
      message: 'No se pueden quitar las mesas 7, 8: tienen una cuenta abierta. Ciérralas primero.',
    })
    expect(await prisma.table.count({ where: { venueId, active: true } })).toBe(2)
  })

  it('una cuenta que se abre MIENTRAS se publica también frena quitar la mesa (candado de fila)', async () => {
    const created = await conMesas(mesa('t1', '9'))
    const tableId = created.tables[0].id
    const order = await prisma.order.create({
      data: { venueId, orderNumber: `PLANO-${randomUUID()}`, subtotal: 100, taxAmount: 0, total: 100, tableId },
    })
    // Otra transacción (como `assignTable`) ya tiene la mesa y está a punto de colgarle la cuenta.
    const cuenta = await tomarFila('Table', tableId, tx =>
      tx.table.update({ where: { id: tableId }, data: { currentOrderId: order.id, status: 'OCCUPIED' } }),
    )
    // La publicación queda esperando el candado de la mesa: todavía no lee el plano.
    const publicando = publish({ baseFingerprint: created.fingerprint, areas: [salon(created.areas[0].id)], tables: [] })
    publicando.catch(() => undefined)
    expect(await esperandoCandado('Table')).toBe(1)
    cuenta.soltar()
    await cuenta.termina
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

  it('revivir una mesa archivada que quedó con una cuenta sin pagar NO le quita la cuenta', async () => {
    const created = await conMesas(mesa('t1', '5'))
    const area = salon(created.areas[0].id)
    const tableId = created.tables[0].id
    const removed = await publish({ baseFingerprint: created.fingerprint, areas: [area], tables: [] })
    // Un POS le abrió una cuenta justo antes de que se archivara: la mesa archivada todavía la apunta.
    const order = await abrirCuenta(tableId)
    const back = await publish({ baseFingerprint: removed.fingerprint, areas: [area], tables: [mesa('x', '5', { areaRef: area.id })] })
    expect(back.tables).toEqual([expect.objectContaining({ id: tableId, number: '5', hasOpenOrder: true })])
    expect(await prisma.table.findUniqueOrThrow({ where: { id: tableId } })).toMatchObject({
      active: true,
      currentOrderId: order.id,
      status: 'OCCUPIED',
    })
    expect(await prisma.order.findUnique({ where: { id: order.id } })).toMatchObject({ id: order.id, tableId })
  })

  it('revivir una mesa archivada cuya cuenta ya se pagó la deja libre', async () => {
    const created = await conMesas(mesa('t1', '6'))
    const area = salon(created.areas[0].id)
    const tableId = created.tables[0].id
    const removed = await publish({ baseFingerprint: created.fingerprint, areas: [area], tables: [] })
    await abrirCuenta(tableId, 'PAID')
    await publish({ baseFingerprint: removed.fingerprint, areas: [area], tables: [mesa('x', '6', { areaRef: area.id })] })
    expect(await prisma.table.findUniqueOrThrow({ where: { id: tableId } })).toMatchObject({
      active: true,
      currentOrderId: null,
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

  it('liberar el número de una archivada nunca usa un número que trae el mismo guardado', async () => {
    const created = await conMesas(mesa('t5', '5'), mesa('t7', '7', { positionX: 0.2 }))
    const areaId = created.areas[0].id
    const t5 = created.tables.find(t => t.number === '5')!
    const t7 = created.tables.find(t => t.number === '7')!
    const siete = (number: string): DesiredTable => ({
      id: t7.id,
      number,
      capacity: 4,
      shape: 'SQUARE',
      rotation: 0,
      positionX: 0.2,
      positionY: 0.5,
      areaRef: areaId,
    })
    const sin5 = await publish({ baseFingerprint: created.fingerprint, areas: [salon(areaId)], tables: [siete('7')] })
    const out = await publish({
      baseFingerprint: sin5.fingerprint,
      areas: [salon(areaId)],
      tables: [siete('5'), mesa('n', '5 (archivada)', { areaRef: areaId })],
    })
    expect(out.tables.map(t => [t.number, t.id === t7.id])).toEqual([
      ['5', true],
      ['5 (archivada)', false],
    ])
    expect(await prisma.table.findUniqueOrThrow({ where: { id: t5.id } })).toMatchObject({ active: false, number: '5 (archivada 2)' })
  })

  it('la PAX que mueve una mesa mientras se publica espera, y su cambio queda encima (no se pierde)', async () => {
    const created = await conMesas(mesa('t1', '1'))
    const areaId = created.areas[0].id
    const t1 = created.tables[0]
    // Un bloqueador detiene la publicación DESPUÉS de sus candados y de leer el plano: tiene el área que va a renombrar.
    const area = await tomarFila('Area', areaId)
    const publicando = publish({
      baseFingerprint: created.fingerprint,
      areas: [{ id: areaId, name: 'Comedor', floorShape: 'WIDE', sortOrder: 0 }],
      tables: [{ id: t1.id, number: '1', capacity: 4, shape: 'SQUARE', rotation: 0, positionX: 0.25, positionY: 0.5, areaRef: areaId }],
    })
    publicando.catch(() => undefined)
    expect(await esperandoCandado('Area')).toBe(1)
    // La PAX (pantalla vieja) mueve esa misma mesa ahora: sin el candado escribiría ya, y la publicación la pisaría.
    let paxTermino = false
    const pax = updateTablePosition(venueId, t1.id, 0.9, 0.9).finally(() => (paxTermino = true))
    pax.catch(() => undefined)
    const paxEsperaba = (await esperandoCandado('Table', () => paxTermino)) === 1 && !paxTermino
    area.soltar()
    await area.termina
    await publicando
    await pax
    expect(await prisma.area.findUniqueOrThrow({ where: { id: areaId } })).toMatchObject({ name: 'Comedor' }) // se publicó
    expect(await prisma.table.findUniqueOrThrow({ where: { id: t1.id } })).toMatchObject({ positionX: 0.9, positionY: 0.9 }) // la PAX encima
    expect(paxEsperaba).toBe(true)
    // El plano cambió DESPUÉS de publicar: el siguiente guardado del editor recibirá 409 en vez de pisarlo.
    const publicacion = await prisma.floorPlanPublication.findFirstOrThrow({
      where: { venueId, baseFingerprint: created.fingerprint },
    })
    expect((await getFloorPlan(venueId)).fingerprint).not.toBe(publicacion.resultFingerprint)
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
