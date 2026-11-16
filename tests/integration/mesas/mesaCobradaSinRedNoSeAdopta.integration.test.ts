/**
 * D8 (hz:033d44ca:D8, 16-nov-2026) — la mesa cobrada sin red queda libre en el aparato que la cobró y se le abre otra cuenta. Postgres REAL.
 *
 * El caso: la cuenta A se abrió CON red (cuenta del SERVIDOR). Se cae el internet; el aparato la cobra en efectivo por la cola de mesas
 * (`PAY_CASH` + `CLEAR_TABLE`) y, ya libre en su plano, abre otra cuenta B en la MISMA mesa por su cola (`OPEN_TABLE` con la hora sin
 * red). Si al volver la red A quedó debiendo (precio cambiado, otro aparato le agregó algo, cobro rechazado), el `CLEAR_TABLE` se
 * rechaza y D51 adoptaba A —o una cuenta separada de A, o la A provisional que nació dentro del margen de 30 s (Codex r1 #1, #2)—: lo
 * pedido y cobrado de B caía en otra visita. Con `visitaNueva: true` B nunca adopta: nace en su propia cuenta junto a las vivas.
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { processIntents } from '@/services/mobile/sync.mobile.service'
import { assignTable } from '@/services/tpv/table.tpv.service'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))
jest.setTimeout(60_000)

const fixture = `d8-${randomUUID().slice(0, 8)}`
let venueId: string
let staffA: string
let productId: string
const device1 = `aparato-1-${fixture}`
let seq = 0

const replay = (intents: any[]) => processIntents({ venueId, staffId: staffA, deviceId: device1, intents, authorizeIntent: () => true })
const intent = (type: string, payload: Record<string, unknown>, createdAtLocal?: number) => ({
  id: randomUUID(),
  seq: ++seq,
  type,
  payload,
  ...(createdAtLocal !== undefined ? { createdAtLocal } : {}),
})
const open = (tableId: string, createdAtLocal: number | undefined, extra: Record<string, unknown> = {}) =>
  intent('OPEN_TABLE', { tableId, covers: 2, localOrderId: randomUUID(), ...extra }, createdAtLocal)
const nueva = { visitaNueva: true }

async function mesa(): Promise<string> {
  return (await prisma.table.create({ data: { venueId, number: randomUUID().slice(0, 6), capacity: 4, qrCode: randomUUID() } })).id
}
/** La cuenta A del SERVIDOR (abierta con red hace 10 min) con 2 renglones de $120 = $240; la mesa no ha cambiado desde entonces. */
async function cuentaDelServidorConDeuda(t: string): Promise<string> {
  const a = (await assignTable(venueId, t, staffA, 2)).order.id
  const [ack] = await replay([intent('ADD_ITEMS', { orderId: a, items: [{ productId, quantity: 2 }] })])
  expect(ack.status).toBe('ACKED')
  await prisma.order.update({ where: { id: a }, data: { createdAt: new Date(Date.now() - 10 * 60_000) } })
  await prisma.$executeRaw`UPDATE "Table" SET "updatedAt" = ${new Date(Date.now() - 10 * 60_000)} WHERE id = ${t}`
  return a
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
  await prisma.staffVenue.create({ data: { venueId, staffId: staffA, role: 'OWNER' } })
  const cat = await prisma.menuCategory.create({ data: { venueId, name: 'Cocina', slug: `cocina-${fixture}` } })
  productId = (await prisma.product.create({ data: { venueId, categoryId: cat.id, name: 'Ensalada', sku: `D8-${fixture}`, price: 120 } }))
    .id
})
afterAll(async () => {
  await prisma.$disconnect()
}) // Se conservan las filas únicas de esta corrida como evidencia.

describe('D8 · la visita nueva de una mesa soltada sin red no cae en otra cuenta', () => {
  it('A quedó debiendo (se cobró de menos sin red): con visitaNueva, B nace aparte y cada pago queda en su cuenta', async () => {
    const t = await mesa()
    const cuentaA = await cuentaDelServidorConDeuda(t)
    const abiertaB = Date.now() - 60_000
    const b = open(t, abiertaB, nueva)
    const localB = String(b.payload.localOrderId)

    const acks = await replay([
      intent('PAY_CASH', { orderId: cuentaA, amountCents: 12000, tipCents: 0, method: 'CASH' }), // la tablet creía que debía $120
      intent('CLEAR_TABLE', { tableId: t, orderId: cuentaA }),
      b,
      intent('ADD_ITEMS', { localOrderId: localB, items: [{ productId, quantity: 1 }] }),
      intent('PAY_CASH', { localOrderId: localB, amountCents: 12000, tipCents: 0, method: 'CASH' }),
    ])

    expect(acks[0].status).toBe('ACKED')
    expect(acks[1].status).toBe('REJECTED') // A sigue debiendo: no se libera
    expect(acks.slice(2).map(a => a.status)).toEqual(['ACKED', 'ACKED', 'ACKED'])
    const cuentaB = String(acks[2].result!.orderId)
    expect(cuentaB).not.toBe(cuentaA)
    expect(acks[2].result).toMatchObject({ isNewOrder: true, localOrderId: localB })
    // Cada visita con lo suyo: A conserva sus 2 renglones y su pago; B, su renglón y su pago, PAGADA.
    expect(await huellaDe(cuentaA)).toEqual({ renglones: 1, pagos: 1 })
    expect(await prisma.orderItem.aggregate({ where: { orderId: cuentaA }, _sum: { quantity: true } })).toMatchObject({
      _sum: { quantity: 2 },
    })
    expect(await huellaDe(cuentaB)).toEqual({ renglones: 1, pagos: 1 })
    expect(await prisma.order.findUniqueOrThrow({ where: { id: cuentaB } })).toMatchObject({ tableId: t, paymentStatus: 'PAID' })
    expect(await prisma.order.findUniqueOrThrow({ where: { id: cuentaA } })).toMatchObject({ tableId: t, paymentStatus: 'PARTIAL' })
    // La nota de cuenta aparte (D51) nombra a A y dice que el aparato ya la había soltado.
    const nota = await prisma.activityLog.findFirst({ where: { venueId, action: 'MESA_SIN_RED_EN_CUENTA_APARTE', entityId: cuentaB } })
    expect(nota!.data).toMatchObject({ tableId: t, otrasCuentas: [cuentaA], visitaNueva: true })
  })

  it('control: el mismo caso SIN visitaNueva (app vieja) se une a A, como hoy', async () => {
    const t = await mesa()
    const cuentaA = await cuentaDelServidorConDeuda(t)

    const acks = await replay([
      intent('PAY_CASH', { orderId: cuentaA, amountCents: 12000, tipCents: 0, method: 'CASH' }),
      intent('CLEAR_TABLE', { tableId: t, orderId: cuentaA }),
      open(t, Date.now() - 60_000),
    ])

    expect(acks[2]).toMatchObject({ status: 'ACKED', result: expect.objectContaining({ orderId: cuentaA, isNewOrder: false }) })
  })

  it('A se saldó y la mesa se soltó: B nace sola en la mesa libre, sin nota', async () => {
    const t = await mesa()
    const cuentaA = await cuentaDelServidorConDeuda(t)
    const b = open(t, Date.now() - 60_000, nueva)

    const acks = await replay([
      intent('PAY_CASH', { orderId: cuentaA, amountCents: 24000, tipCents: 0, method: 'CASH' }),
      intent('CLEAR_TABLE', { tableId: t, orderId: cuentaA }),
      b,
    ])

    expect(acks.map(a => a.status)).toEqual(['ACKED', 'ACKED', 'ACKED'])
    const cuentaB = String(acks[2].result!.orderId)
    expect(cuentaB).not.toBe(cuentaA)
    expect(await prisma.table.findUniqueOrThrow({ where: { id: t } })).toMatchObject({ status: 'OCCUPIED', currentOrderId: cuentaB })
    expect(await prisma.activityLog.count({ where: { venueId, action: 'MESA_SIN_RED_EN_CUENTA_APARTE', entityId: cuentaB } })).toBe(0)
  })

  it('Codex r1 #2: otra caja SEPARÓ una cuenta C de A; A se cobró y se soltó: B no adopta C (nace junto a ella)', async () => {
    const t = await mesa()
    const cuentaA = await cuentaDelServidorConDeuda(t)
    // C: otra cuenta viva de la misma mesa y del mismo mesero, anterior a B (como la que deja «Separar en otra cuenta»).
    const cuentaC = (
      await prisma.order.create({
        data: {
          venueId,
          tableId: t,
          orderNumber: `ORD-${randomUUID().slice(0, 8)}`,
          servedById: staffA,
          status: 'PENDING',
          total: 0,
          subtotal: 0,
          taxAmount: 0,
          createdAt: new Date(Date.now() - 5 * 60_000),
        },
      })
    ).id
    await prisma.$executeRaw`UPDATE "Table" SET "updatedAt" = ${new Date(Date.now() - 5 * 60_000)} WHERE id = ${t}`

    const acks = await replay([
      intent('PAY_CASH', { orderId: cuentaA, amountCents: 24000, tipCents: 0, method: 'CASH' }),
      intent('CLEAR_TABLE', { tableId: t, orderId: cuentaA }),
      open(t, Date.now() - 60_000, nueva),
    ])

    expect(acks[2].status).toBe('ACKED')
    const cuentaB = String(acks[2].result!.orderId)
    expect([cuentaA, cuentaC]).not.toContain(cuentaB)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: cuentaC } })).toMatchObject({ tableId: t, status: 'PENDING' })
    expect(await prisma.order.findUniqueOrThrow({ where: { id: cuentaB } })).toMatchObject({ tableId: t })
  })

  it('Codex r1 #1: A provisional nació en el replay DENTRO del margen de 30 s y quedó debiendo: B (visitaNueva) no la adopta', async () => {
    const t = await mesa()
    const a = open(t, Date.now() - 20_000)
    const localA = String(a.payload.localOrderId)
    const b = open(t, Date.now() - 10_000, nueva) // B se abrió 10 s después de A; A nace en el replay, dentro del margen de B
    const localB = String(b.payload.localOrderId)

    const acks = await replay([
      a,
      intent('ADD_ITEMS', { localOrderId: localA, items: [{ productId, quantity: 2 }] }),
      intent('PAY_CASH', { localOrderId: localA, amountCents: 12000, tipCents: 0, method: 'CASH' }), // de menos: A queda debiendo
      intent('CLEAR_TABLE', { tableId: t, localOrderId: localA }),
      b,
      intent('ADD_ITEMS', { localOrderId: localB, items: [{ productId, quantity: 1 }] }),
    ])

    const cuentaA = String(acks[0].result!.orderId)
    expect(acks[4].status).toBe('ACKED')
    const cuentaB = String(acks[4].result!.orderId)
    expect(cuentaB).not.toBe(cuentaA)
    expect(await prisma.orderItem.aggregate({ where: { orderId: cuentaA }, _sum: { quantity: true } })).toMatchObject({
      _sum: { quantity: 2 },
    })
    expect(await prisma.orderItem.aggregate({ where: { orderId: cuentaB }, _sum: { quantity: true } })).toMatchObject({
      _sum: { quantity: 1 },
    })
  })

  it('control del #1: sin visitaNueva, esa B sí cae en A (por eso hace falta el aviso)', async () => {
    const t = await mesa()
    const a = open(t, Date.now() - 20_000)
    const localA = String(a.payload.localOrderId)
    const acks = await replay([
      a,
      intent('ADD_ITEMS', { localOrderId: localA, items: [{ productId, quantity: 2 }] }),
      intent('PAY_CASH', { localOrderId: localA, amountCents: 12000, tipCents: 0, method: 'CASH' }),
      intent('CLEAR_TABLE', { tableId: t, localOrderId: localA }),
      open(t, Date.now() - 10_000),
    ])
    expect(acks[4].result!.orderId).toBe(acks[0].result!.orderId)
  })

  it('sin la hora de la apertura sin red, visitaNueva se ignora (la regla es de D51): como hoy', async () => {
    const t = await mesa()
    const cuentaA = await cuentaDelServidorConDeuda(t)

    const [ack] = await replay([open(t, undefined, nueva)])

    expect(ack).toMatchObject({ status: 'ACKED', result: expect.objectContaining({ orderId: cuentaA, isNewOrder: false }) })
  })

  it('un visitaNueva que no es true no rechaza la apertura (se ignora)', async () => {
    const t = await mesa()
    const [ack] = await replay([open(t, Date.now() - 60_000, { visitaNueva: 'si' })])
    expect(ack).toMatchObject({ status: 'ACKED', result: expect.objectContaining({ isNewOrder: true }) })
  })
})
