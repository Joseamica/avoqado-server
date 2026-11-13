/**
 * D51 (hz:8024bc1c:D51, 13-nov-2026) — una mesa abierta SIN red no cae en otra cuenta de la misma mesa. Postgres REAL.
 *
 * El caso: el aparato 1 abre la mesa en línea y el SERVIDOR crea la cuenta A, pero la respuesta se pierde; el aparato la abre sin red
 * (cuenta provisional L, `OPEN_TABLE` con `createdAtLocal`). Mientras sigue sin red, otra caja cancela A y abre B en esa mesa. Al
 * volver la red, `assignTable` adoptaba la cuenta VIVA de ahora (B): lo pedido y cobrado sin red en L caía en B.
 *
 * Regla: se adopta sólo si la MESA no cambió después de que el aparato la abrió sin red (`Table.updatedAt`) y la cuenta ya había nacido,
 * con 30 s de margen (su propia apertura en línea, aunque el servidor la creara tarde). Si no, la mesa recibe una cuenta propia junto
 * a la otra, con nota en la bitácora.
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { processIntents } from '@/services/mobile/sync.mobile.service'
import { cancelOrder } from '@/services/mobile/order.mobile.service'
import { assignTable, moveOrderToTable } from '@/services/tpv/table.tpv.service'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))
jest.setTimeout(60_000)

const fixture = `d51-${randomUUID().slice(0, 8)}`
let venueId: string
let staffA: string
let staffB: string
let productId: string
const device1 = `aparato-1-${fixture}`
let seq = 0

const replay = (intents: any[], staffId = staffA) =>
  processIntents({ venueId, staffId, deviceId: device1, intents, authorizeIntent: () => true })
const open = (tableId: string, createdAtLocal: number, localOrderId = randomUUID()) => ({
  id: randomUUID(),
  seq: ++seq,
  type: 'OPEN_TABLE' as const,
  payload: { tableId, covers: 2, localOrderId },
  createdAtLocal,
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
/** La cuenta nació hace `ms` (las pruebas no esperan minutos reales). */
async function nacidaHace(orderId: string, ms: number) {
  await prisma.order.update({ where: { id: orderId }, data: { createdAt: new Date(Date.now() - ms) } })
}
/** La mesa no cambió desde hace `ms` (en la vida real, su fila se escribió al abrirse la cuenta que ya estaba). */
async function mesaQuietaDesde(tableId: string, ms: number) {
  await prisma.$executeRaw`UPDATE "Table" SET "updatedAt" = ${new Date(Date.now() - ms)} WHERE id = ${tableId}`
}
async function conRenglon(orderId: string) {
  await prisma.orderItem.create({
    data: { orderId, productName: 'De la otra visita', quantity: 1, unitPrice: 80, total: 80, taxAmount: 0 },
  })
}
const huellaDe = async (orderId: string) => ({
  renglones: await prisma.orderItem.count({ where: { orderId } }),
  pagos: await prisma.payment.count({ where: { orderId } }),
})

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: fixture, email: `${fixture}@example.test`, phone: '' } })
  venueId = (
    await prisma.venue.create({ data: { organizationId: org.id, name: fixture, slug: fixture, type: 'RESTAURANT', status: 'TRIAL' } })
  ).id
  await prisma.venueSettings.create({ data: { venueId, enableShifts: false, requirePinLogin: false } })
  staffA = (await prisma.staff.create({ data: { email: `a-${fixture}@staff.test`, firstName: 'Mesero', lastName: 'Uno', active: true } }))
    .id
  staffB = (await prisma.staff.create({ data: { email: `b-${fixture}@staff.test`, firstName: 'Mesero', lastName: 'Dos', active: true } }))
    .id
  await prisma.staffVenue.createMany({
    data: [
      { venueId, staffId: staffA, role: 'OWNER' },
      { venueId, staffId: staffB, role: 'OWNER' },
    ],
  })
  const cat = await prisma.menuCategory.create({ data: { venueId, name: 'Cocina', slug: `cocina-${fixture}` } })
  productId = (await prisma.product.create({ data: { venueId, categoryId: cat.id, name: 'Ensalada', sku: `D51-${fixture}`, price: 120 } }))
    .id
})
afterAll(async () => {
  await prisma.$disconnect()
}) // Se conservan las filas únicas de esta corrida como evidencia.

describe('D51 · OPEN_TABLE sin red frente a una cuenta que nació después', () => {
  it('A llegó y su respuesta se perdió, otra caja canceló A y abrió B: lo de L queda en SU cuenta, B intacta', async () => {
    const t = await mesa()
    const cuentaA = (await assignTable(venueId, t, staffA, 2)).order.id // en línea; la respuesta se perdió
    await nacidaHace(cuentaA, 70_000)
    const abiertaSinRed = Date.now() - 60_000 // el aparato se rindió y la abrió sin red
    await cancelOrder(venueId, cuentaA, 'mesa vacía', staffB) // otra caja, mientras el aparato 1 sigue sin red
    const cuentaB = (await assignTable(venueId, t, staffB, 4)).order.id
    await conRenglon(cuentaB)
    const antesB = await huellaDe(cuentaB)

    const o = open(t, abiertaSinRed)
    const acks = await replay([o, add(o.payload.localOrderId), pay(o.payload.localOrderId, 24000)])

    expect(acks.map(a => a.status)).toEqual(['ACKED', 'ACKED', 'ACKED'])
    const propia = String(acks[0].result!.orderId)
    expect(propia).not.toBe(cuentaB)
    expect(propia).not.toBe(cuentaA)
    expect(acks[0].result).toMatchObject({ isNewOrder: true, localOrderId: o.payload.localOrderId })
    expect(await huellaDe(cuentaB)).toEqual(antesB)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: cuentaB } })).toMatchObject({ tableId: t, status: 'PENDING' })
    expect(await prisma.order.findUniqueOrThrow({ where: { id: propia } })).toMatchObject({
      tableId: t,
      servedById: staffA,
      paymentStatus: 'PAID',
    })
    expect(await huellaDe(propia)).toEqual({ renglones: 1, pagos: 1 })
    // La mesa sigue siendo de B (con la cuenta propia junto); nadie soltó ni re-apuntó la cuenta ajena.
    expect(await prisma.table.findUniqueOrThrow({ where: { id: t } })).toMatchObject({ status: 'OCCUPIED', currentOrderId: cuentaB })
    // La nota se escribió en la MISMA transacción (Codex r1 #3): está en la base, no en un escritor de mejor esfuerzo.
    const nota = await prisma.activityLog.findFirst({ where: { venueId, action: 'MESA_SIN_RED_EN_CUENTA_APARTE', entityId: propia } })
    expect(nota).toMatchObject({ staffId: staffA, entity: 'Order' })
    expect(nota!.data).toMatchObject({ tableId: t, otrasCuentas: [cuentaB], localOrderId: o.payload.localOrderId, intentId: o.id })
  })

  it('Codex r1 #1: el MISMO mesero canceló A y abrió B (vacía) desde otra caja: B no es su apertura perdida → cuenta propia', async () => {
    const t = await mesa()
    const cuentaA = (await assignTable(venueId, t, staffA, 2)).order.id
    await nacidaHace(cuentaA, 70_000)
    const abiertaSinRed = Date.now() - 60_000
    await cancelOrder(venueId, cuentaA, 'mesa vacía', staffA)
    const cuentaB = (await assignTable(venueId, t, staffA, 4)).order.id // vacía, mismo mesero, < 5 min

    const [ack] = await replay([open(t, abiertaSinRed)])

    expect(ack.status).toBe('ACKED')
    expect(ack.result!.orderId).not.toBe(cuentaB)
    expect(await huellaDe(cuentaB)).toEqual({ renglones: 0, pagos: 0 })
  })

  it('Codex r2 #1: el mismo mesero MOVIÓ A a otra mesa y abrió B (vacía): B sigue siendo posterior → cuenta propia', async () => {
    const t = await mesa()
    const otraMesa = await mesa()
    const cuentaA = (await assignTable(venueId, t, staffA, 2)).order.id
    await nacidaHace(cuentaA, 70_000)
    const abiertaSinRed = Date.now() - 60_000
    await moveOrderToTable(venueId, cuentaA, otraMesa)
    const cuentaB = (await assignTable(venueId, t, staffA, 4)).order.id

    const [ack] = await replay([open(t, abiertaSinRed)])

    expect(ack.status).toBe('ACKED')
    expect(ack.result!.orderId).not.toBe(cuentaB)
    expect(ack.result!.orderId).not.toBe(cuentaA)
    expect(await huellaDe(cuentaB)).toEqual({ renglones: 0, pagos: 0 })
  })

  it('Codex r1 #2: un día sin red (L hace 26 h, B hace 25 h): B sigue siendo posterior → cuenta propia', async () => {
    const t = await mesa()
    const cuentaA = (await assignTable(venueId, t, staffA, 2)).order.id
    await nacidaHace(cuentaA, 26 * 3_600_000 + 10_000)
    const abiertaSinRed = Date.now() - 26 * 3_600_000
    await cancelOrder(venueId, cuentaA, 'mesa vacía', staffB)
    const cuentaB = (await assignTable(venueId, t, staffB, 4)).order.id
    await conRenglon(cuentaB)
    await nacidaHace(cuentaB, 25 * 3_600_000)

    const [ack] = await replay([open(t, abiertaSinRed)])

    expect(ack.status).toBe('ACKED')
    expect(ack.result!.orderId).not.toBe(cuentaB)
  })

  it('B posterior del MISMO mesero pero ya con renglones: también cuenta propia', async () => {
    const t = await mesa()
    const abiertaSinRed = Date.now() - 60_000
    const cuentaB = (await assignTable(venueId, t, staffA, 4)).order.id
    await conRenglon(cuentaB)

    const o = open(t, abiertaSinRed)
    const [ack] = await replay([o])

    expect(ack.status).toBe('ACKED')
    expect(ack.result!.orderId).not.toBe(cuentaB)
    expect(await prisma.table.findUniqueOrThrow({ where: { id: t } })).toMatchObject({ currentOrderId: cuentaB })
  })

  it('una cuenta ANTERIOR viva y luego llegó B (la mesa cambió): cuenta propia, sin tocar ninguna ni el puntero', async () => {
    const t = await mesa()
    const anterior = (await assignTable(venueId, t, staffB, 2)).order.id
    await conRenglon(anterior)
    await nacidaHace(anterior, 10 * 60_000)
    const abiertaSinRed = Date.now() - 60_000
    // B nace después como otra cuenta de la mesa (multi-cuenta) y queda como puntero.
    const cuentaB = (
      await prisma.order.create({
        data: {
          venueId,
          tableId: t,
          orderNumber: `ORD-${randomUUID().slice(0, 8)}`,
          servedById: staffB,
          status: 'PENDING',
          total: 0,
          subtotal: 0,
          taxAmount: 0,
        },
      })
    ).id
    await prisma.table.update({ where: { id: t }, data: { currentOrderId: cuentaB } })

    const o = open(t, abiertaSinRed)
    const [ack] = await replay([o])

    expect(ack).toMatchObject({ status: 'ACKED', result: expect.objectContaining({ isNewOrder: true }) })
    expect([anterior, cuentaB]).not.toContain(ack.result!.orderId)
    expect(await prisma.table.findUniqueOrThrow({ where: { id: t } })).toMatchObject({ status: 'OCCUPIED', currentOrderId: cuentaB })
    expect(await prisma.order.findUniqueOrThrow({ where: { id: anterior } })).toMatchObject({ tableId: t })
  })

  it('Codex r3 #1: alguien reescribió hacia atrás la fecha de B en el panel: la mesa cambió igual → cuenta propia', async () => {
    const t = await mesa()
    const cuentaA = (await assignTable(venueId, t, staffA, 2)).order.id
    await nacidaHace(cuentaA, 70_000)
    const abiertaSinRed = Date.now() - 60_000
    await cancelOrder(venueId, cuentaA, 'mesa vacía', staffB)
    const cuentaB = (await assignTable(venueId, t, staffB, 4)).order.id
    await nacidaHace(cuentaB, 10 * 60_000) // como el PUT del panel con `createdAt`

    const [ack] = await replay([open(t, abiertaSinRed)])

    expect(ack.status).toBe('ACKED')
    expect(ack.result!.orderId).not.toBe(cuentaB)
  })

  it('Codex r4 #1: otra caja canceló A y MOVIÓ a la mesa una cuenta vieja de otra mesa: cuenta propia', async () => {
    const t = await mesa()
    const otraMesa = await mesa()
    const vieja = (await assignTable(venueId, otraMesa, staffB, 3)).order.id
    await conRenglon(vieja)
    await nacidaHace(vieja, 10 * 60_000)
    await mesaQuietaDesde(otraMesa, 10 * 60_000)
    const cuentaA = (await assignTable(venueId, t, staffA, 2)).order.id
    await nacidaHace(cuentaA, 70_000)
    const abiertaSinRed = Date.now() - 60_000
    await cancelOrder(venueId, cuentaA, 'mesa vacía', staffB)
    await moveOrderToTable(venueId, vieja, t)

    const [ack] = await replay([open(t, abiertaSinRed)])

    expect(ack.status).toBe('ACKED')
    expect(ack.result!.orderId).not.toBe(vieja)
    expect(await huellaDe(vieja)).toEqual({ renglones: 1, pagos: 0 })
  })
})

describe('D51 · lo que se sigue uniendo como hoy', () => {
  it('la respuesta se perdió y nadie tocó la mesa: L se une a A', async () => {
    const t = await mesa()
    const cuentaA = (await assignTable(venueId, t, staffA, 2)).order.id
    await nacidaHace(cuentaA, 70_000)
    await mesaQuietaDesde(t, 70_000)

    const o = open(t, Date.now() - 60_000)
    const [a1, a2] = await replay([o, add(o.payload.localOrderId)])

    expect(a1).toMatchObject({ status: 'ACKED', result: expect.objectContaining({ orderId: cuentaA, isNewOrder: false }) })
    expect(a2.status).toBe('ACKED')
    expect(await prisma.order.count({ where: { venueId, tableId: t } })).toBe(1)
    expect(await prisma.activityLog.count({ where: { venueId, action: 'MESA_SIN_RED_EN_CUENTA_APARTE', entityId: cuentaA } })).toBe(0)
  })

  it('servidor lento: A nació DESPUÉS de que el aparato se rindió, del mismo mesero y vacía → se une a A', async () => {
    const t = await mesa()
    const abiertaSinRed = Date.now() - 12_000 // el aparato se rindió 12 s antes de que el servidor creara A (puente lento)
    const cuentaA = (await assignTable(venueId, t, staffA, 2)).order.id

    const [ack] = await replay([open(t, abiertaSinRed)])

    expect(ack).toMatchObject({ status: 'ACKED', result: expect.objectContaining({ orderId: cuentaA, isNewOrder: false }) })
    expect(await prisma.order.count({ where: { venueId, tableId: t } })).toBe(1)
  })

  it('la cuenta de otro mesero YA estaba cuando el aparato abrió sin red (plano viejo): se une, como hoy', async () => {
    const t = await mesa()
    const existente = (await assignTable(venueId, t, staffB, 2)).order.id
    await conRenglon(existente)
    await nacidaHace(existente, 10 * 60_000)
    await mesaQuietaDesde(t, 10 * 60_000)

    const [ack] = await replay([open(t, Date.now() - 60_000)])

    expect(ack).toMatchObject({ status: 'ACKED', result: expect.objectContaining({ orderId: existente, isNewOrder: false }) })
  })

  it('el margen es de 30 s: una cuenta del mismo mesero que nació 45 s después ya es otra visita → cuenta propia', async () => {
    const t = await mesa()
    const abiertaSinRed = Date.now() - 45_000
    const posterior = (await assignTable(venueId, t, staffA, 2)).order.id

    const [ack] = await replay([open(t, abiertaSinRed)])

    expect(ack.result!.orderId).not.toBe(posterior)
    expect(await prisma.table.findUniqueOrThrow({ where: { id: t } })).toMatchObject({ currentOrderId: posterior })
  })

  it('la mesa se tocó después por algo ajeno (otra caja agregó una ronda a A: no escribe la mesa) → sigue uniéndose a A', async () => {
    const t = await mesa()
    const cuentaA = (await assignTable(venueId, t, staffA, 2)).order.id
    await nacidaHace(cuentaA, 70_000)
    await mesaQuietaDesde(t, 70_000)
    await conRenglon(cuentaA) // la otra caja atiende a la misma visita

    const [ack] = await replay([open(t, Date.now() - 60_000)])

    expect(ack).toMatchObject({ status: 'ACKED', result: expect.objectContaining({ orderId: cuentaA, isNewOrder: false }) })
  })

  it('mesa libre: abre su cuenta como siempre, sin nota en la bitácora', async () => {
    const t = await mesa()
    const [ack] = await replay([open(t, Date.now() - 60_000)])

    expect(ack).toMatchObject({ status: 'ACKED', result: expect.objectContaining({ isNewOrder: true }) })
    expect(await prisma.table.findUniqueOrThrow({ where: { id: t } })).toMatchObject({
      status: 'OCCUPIED',
      currentOrderId: ack.result!.orderId,
    })
    expect(
      await prisma.activityLog.count({
        where: { venueId, action: 'MESA_SIN_RED_EN_CUENTA_APARTE', entityId: String(ack.result!.orderId) },
      }),
    ).toBe(0)
  })
})
