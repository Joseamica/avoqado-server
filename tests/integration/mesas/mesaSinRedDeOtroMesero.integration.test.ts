/**
 * D71 (hz:8024bc1c:D71, founder 13-nov-2026: «A, cuenta propia») — con «propiedad de mesa» ENCENDIDA, un mesero que abrió SIN red una
 * mesa que ya es de otro mesero (la abrió en línea antes o después) ya no se rechaza con TABLE_OWNED_BY_OTHER: lo suyo (productos y
 * efectivo ya cobrado) nace en una cuenta PROPIA de la misma mesa, a su nombre, junto a la del otro, con nota en la bitácora. Antes se
 * rechazaba y sus ADD_ITEMS/PAY_CASH quedaban en cuarentena sin cuenta. Postgres REAL.
 *
 * Se apoya en D51 (`mesaSinRedNoCaeEnOtraCuenta.integration.test.ts`): la misma cuenta propia, ahora también por dueño de la mesa.
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { processIntents } from '@/services/mobile/sync.mobile.service'
import { assignTable } from '@/services/tpv/table.tpv.service'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))
jest.setTimeout(60_000)

const fixture = `d71-${randomUUID().slice(0, 8)}`
let venueId: string
let meseroX: string // el que abrió sin red
let meseroY: string // el dueño de la mesa (en línea)
let gerente: string
let productId: string
let seq = 0

const replay = (intents: any[], staffId = meseroX) =>
  processIntents({ venueId, staffId, deviceId: `aparato-${staffId}`, intents, authorizeIntent: () => true })
const open = (tableId: string, createdAtLocal: number | undefined, localOrderId = randomUUID()) => ({
  id: randomUUID(),
  seq: ++seq,
  type: 'OPEN_TABLE' as const,
  payload: { tableId, covers: 2, localOrderId },
  ...(createdAtLocal === undefined ? {} : { createdAtLocal }),
})
const add = (localOrderId: string, quantity = 2) => ({
  id: randomUUID(),
  seq: ++seq,
  type: 'ADD_ITEMS' as const,
  payload: { localOrderId, items: [{ productId, quantity }] },
})
const pay = (localOrderId: string, amountCents: number) => ({
  id: randomUUID(),
  seq: ++seq,
  type: 'PAY_CASH' as const,
  payload: { localOrderId, amountCents, tipCents: 0, method: 'CASH' },
})

async function mesa(): Promise<string> {
  return (await prisma.table.create({ data: { venueId, number: randomUUID().slice(0, 6), capacity: 4, qrCode: randomUUID() } })).id
}
async function nacidaHace(orderId: string, ms: number) {
  await prisma.order.update({ where: { id: orderId }, data: { createdAt: new Date(Date.now() - ms) } })
}
async function mesaQuietaDesde(tableId: string, ms: number) {
  await prisma.$executeRaw`UPDATE "Table" SET "updatedAt" = ${new Date(Date.now() - ms)} WHERE id = ${tableId}`
}
async function conRenglon(orderId: string) {
  await prisma.orderItem.create({
    data: { orderId, productName: 'Del otro mesero', quantity: 1, unitPrice: 80, total: 80, taxAmount: 0 },
  })
}
const huellaDe = async (orderId: string) => ({
  renglones: await prisma.orderItem.count({ where: { orderId } }),
  pagos: await prisma.payment.count({ where: { orderId } }),
})
const notaDe = (orderId: string) =>
  prisma.activityLog.findFirst({ where: { venueId, action: 'MESA_SIN_RED_EN_CUENTA_APARTE', entityId: orderId } })

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: fixture, email: `${fixture}@example.test`, phone: '' } })
  venueId = (
    await prisma.venue.create({ data: { organizationId: org.id, name: fixture, slug: fixture, type: 'RESTAURANT', status: 'TRIAL' } })
  ).id
  await prisma.venueSettings.create({ data: { venueId, enableShifts: false, requirePinLogin: false, enforceTableOwnership: true } })
  const persona = async (nombre: string) =>
    (await prisma.staff.create({ data: { email: `${nombre}-${fixture}@staff.test`, firstName: 'Mesero', lastName: nombre, active: true } }))
      .id
  meseroX = await persona('equis')
  meseroY = await persona('ye')
  gerente = await persona('gerente')
  await prisma.staffVenue.createMany({
    data: [
      { venueId, staffId: meseroX, role: 'WAITER' },
      { venueId, staffId: meseroY, role: 'WAITER' },
      { venueId, staffId: gerente, role: 'MANAGER' },
    ],
  })
  const cat = await prisma.menuCategory.create({ data: { venueId, name: 'Cocina', slug: `cocina-${fixture}` } })
  productId = (await prisma.product.create({ data: { venueId, categoryId: cat.id, name: 'Ensalada', sku: `D71-${fixture}`, price: 120 } }))
    .id
})
afterAll(async () => {
  await prisma.$disconnect()
}) // Se conservan las filas únicas de esta corrida como evidencia.

describe('D71 · propiedad de mesa encendida: la mesa sin red de otro mesero nace en su cuenta propia', () => {
  it('Y la abrió en línea DESPUÉS: lo pedido y cobrado sin red por X queda en la cuenta de X, la de Y intacta', async () => {
    const t = await mesa()
    const abiertaSinRed = Date.now() - 60_000
    const cuentaY = (await assignTable(venueId, t, meseroY, 4)).order.id
    await conRenglon(cuentaY)
    const antesY = await huellaDe(cuentaY)

    const o = open(t, abiertaSinRed)
    const acks = await replay([o, add(o.payload.localOrderId), pay(o.payload.localOrderId, 24000)])

    expect(acks.map(a => a.status)).toEqual(['ACKED', 'ACKED', 'ACKED'])
    const propia = String(acks[0].result!.orderId)
    expect(propia).not.toBe(cuentaY)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: propia } })).toMatchObject({
      tableId: t,
      servedById: meseroX,
      paymentStatus: 'PAID',
    })
    expect(await huellaDe(propia)).toEqual({ renglones: 1, pagos: 1 })
    expect(await huellaDe(cuentaY)).toEqual(antesY)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: cuentaY } })).toMatchObject({
      tableId: t,
      servedById: meseroY,
      status: 'PENDING',
    })
    expect(await prisma.table.findUniqueOrThrow({ where: { id: t } })).toMatchObject({ status: 'OCCUPIED', currentOrderId: cuentaY })
    const nota = await notaDe(propia)
    expect(nota).toMatchObject({ staffId: meseroX, entity: 'Order' })
    expect(nota!.data).toMatchObject({ tableId: t, otrasCuentas: [cuentaY], cuentasDeOtroMesero: [cuentaY] })
  })

  it('Y ya la tenía ANTES y la mesa no cambió (antes se adoptaba o se rechazaba): cuenta propia, nunca la de Y', async () => {
    const t = await mesa()
    const cuentaY = (await assignTable(venueId, t, meseroY, 4)).order.id
    await conRenglon(cuentaY)
    await nacidaHace(cuentaY, 10 * 60_000)
    await mesaQuietaDesde(t, 10 * 60_000)

    const o = open(t, Date.now() - 60_000)
    const acks = await replay([o, add(o.payload.localOrderId), pay(o.payload.localOrderId, 24000)])

    expect(acks.map(a => a.status)).toEqual(['ACKED', 'ACKED', 'ACKED'])
    const propia = String(acks[0].result!.orderId)
    expect(propia).not.toBe(cuentaY)
    expect(await huellaDe(cuentaY)).toEqual({ renglones: 1, pagos: 0 })
    expect(await huellaDe(propia)).toEqual({ renglones: 1, pagos: 1 })
    expect(await prisma.table.findUniqueOrThrow({ where: { id: t } })).toMatchObject({ currentOrderId: cuentaY })
    expect((await notaDe(propia))!.data).toMatchObject({ cuentasDeOtroMesero: [cuentaY] })
  })

  it('la apertura en línea perdida de X (la mesa quieta) se sigue adoptando: la propiedad no la vuelve otra cuenta', async () => {
    const t = await mesa()
    const cuentaX = (await assignTable(venueId, t, meseroX, 2)).order.id
    await nacidaHace(cuentaX, 70_000)
    await mesaQuietaDesde(t, 70_000)

    const [ack] = await replay([open(t, Date.now() - 60_000)])

    expect(ack).toMatchObject({ status: 'ACKED', result: expect.objectContaining({ orderId: cuentaX, isNewOrder: false }) })
    expect(await prisma.order.count({ where: { venueId, tableId: t } })).toBe(1)
    expect(await notaDe(cuentaX)).toBeNull()
  })

  it('una cuenta de Y pegada a una mesa que no dice OCUPADA (dato viejo): no se la quita a la mesa', async () => {
    const t = await mesa()
    const cuentaY = (await assignTable(venueId, t, meseroY, 4)).order.id
    await conRenglon(cuentaY)
    await prisma.table.update({ where: { id: t }, data: { status: 'AVAILABLE', currentOrderId: null } })

    const [ack] = await replay([open(t, Date.now() - 60_000)])

    expect(ack.status).toBe('ACKED')
    expect(ack.result!.orderId).not.toBe(cuentaY)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: cuentaY } })).toMatchObject({ tableId: t, status: 'PENDING' })
    expect((await notaDe(String(ack.result!.orderId)))!.data).toMatchObject({ cuentasDeOtroMesero: [cuentaY] })
  })
})

describe('D71 · lo que sigue como hoy', () => {
  it('sin la hora de encolar (petición a mano): TABLE_OWNED_BY_OTHER, sin cuenta nueva', async () => {
    const t = await mesa()
    const cuentaY = (await assignTable(venueId, t, meseroY, 4)).order.id

    const [ack] = await replay([open(t, undefined)])

    expect(ack).toMatchObject({ status: 'REJECTED', errorCode: 'TABLE_OWNED_BY_OTHER' })
    expect(await prisma.order.count({ where: { venueId, tableId: t } })).toBe(1)
    expect(await prisma.table.findUniqueOrThrow({ where: { id: t } })).toMatchObject({ currentOrderId: cuentaY })
  })

  it('un gerente (tables:manage-all) sobre la mesa quieta de Y se une a ella, como hoy (regla de D51)', async () => {
    const t = await mesa()
    const cuentaY = (await assignTable(venueId, t, meseroY, 4)).order.id
    await nacidaHace(cuentaY, 10 * 60_000)
    await mesaQuietaDesde(t, 10 * 60_000)

    const [ack] = await replay([open(t, Date.now() - 60_000)], gerente)

    expect(ack).toMatchObject({ status: 'ACKED', result: expect.objectContaining({ orderId: cuentaY, isNewOrder: false }) })
  })
})
