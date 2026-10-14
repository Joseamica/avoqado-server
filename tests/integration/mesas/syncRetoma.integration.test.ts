/**
 * Retoma con huella transaccional — PostgreSQL real (plan docs/superpowers/plans/2026-10-13-sync-retoma-por-llave.md).
 *
 * Se simulan las tres formas en que una caída deja una reserva PROCESSING, con los servicios REALES:
 *  (a) murió ANTES del commit: no hay efecto ni huella → la retoma ejecuta UNA vez.
 *  (b) murió DESPUÉS del commit: efecto + huella, sin ACK → la retoma contesta con ESA cuenta y no repite.
 *  (c) el ejecutor iba lento y otro retomó: su huella falla dentro de su transacción → su efecto se revierte entero.
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { processIntents, dejarHuellaCon, ReservaPerdida, type MarcaDeReserva } from '@/services/mobile/sync.mobile.service'
import * as orderMobileService from '@/services/mobile/order.mobile.service'
import { assignTable } from '@/services/tpv/table.tpv.service'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))
jest.setTimeout(60_000)

const MARCA: MarcaDeReserva = { protocolo: 'huella-v1', retomable: true }
const fixture = `retoma-${randomUUID().slice(0, 8)}`
let venueId: string
let staffId: string
let productId: string
const device = 'device-retoma'
let seq = 0

const params = (intents: any[]) => ({ venueId, staffId, deviceId: device, intents, authorizeIntent: () => true })
async function mesa(): Promise<string> {
  const t = await prisma.table.create({ data: { venueId, number: randomUUID().slice(0, 6), capacity: 4, qrCode: randomUUID() } })
  return t.id
}
/** Envejece la reserva como si su proceso hubiera muerto hace 2 min, conservando (o quitando) su ACK. */
async function dejarComoCaida(intentId: string, resultJson: unknown) {
  await prisma.posSyncIntent.update({
    where: { venueId_idempotencyKey: { venueId, idempotencyKey: intentId } },
    data: { status: 'PROCESSING', errorCode: null, resultJson: resultJson as any, createdAt: new Date(Date.now() - 120_000) },
  })
}

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: fixture, email: `${fixture}@example.test`, phone: '' } })
  const venue = await prisma.venue.create({ data: { organizationId: org.id, name: fixture, slug: fixture, type: 'RESTAURANT', status: 'TRIAL' } })
  venueId = venue.id
  await prisma.venueSettings.create({ data: { venueId, enableShifts: false, requirePinLogin: false } })
  const staff = await prisma.staff.create({ data: { email: `${fixture}@staff.test`, firstName: 'Retoma', lastName: 'QA', active: true } })
  staffId = staff.id
  await prisma.staffVenue.create({ data: { venueId, staffId, role: 'OWNER' } })
  const cat = await prisma.menuCategory.create({ data: { venueId, name: 'Cocina', slug: 'cocina' } })
  productId = (await prisma.product.create({ data: { venueId, categoryId: cat.id, name: 'Ensalada', sku: 'RET-1', price: 120 } })).id
})
afterAll(async () => {
  await prisma.$disconnect()
}) // Se conservan las filas únicas de esta corrida como evidencia.

const open = (tableId: string, localOrderId = randomUUID()) => ({ id: randomUUID(), seq: ++seq, type: 'OPEN_TABLE' as const, payload: { tableId, covers: 2, localOrderId } })
const add = (localOrderId: string, quantity = 1) => ({ id: randomUUID(), seq: ++seq, type: 'ADD_ITEMS' as const, payload: { localOrderId, items: [{ productId, quantity }] } })
const pay = (localOrderId: string, amountCents: number) => ({ id: randomUUID(), seq: ++seq, type: 'PAY_CASH' as const, payload: { localOrderId, amountCents, tipCents: 0, method: 'CASH' } })
const cancel = (localOrderId: string) => ({ id: randomUUID(), seq: ++seq, type: 'CANCEL_ORDER' as const, payload: { localOrderId, reason: 'prueba' } })

describe('PAY_CASH', () => {
  it('(b) murió DESPUÉS del commit: la retoma devuelve ESE pago, no cobra dos veces y libera la mesa', async () => {
    const t = await mesa()
    const o = open(t)
    const [a1, a2] = await processIntents(params([o, add(o.payload.localOrderId, 2)]))
    expect([a1.status, a2.status]).toEqual(['ACKED', 'ACKED'])
    const p = pay(o.payload.localOrderId, 24000)
    const [ack] = await processIntents(params([p]))
    expect(ack.status).toBe('ACKED')
    const huella = { orderId: a1.result!.orderId, paymentId: ack.result!.paymentId }
    // La caída se llevó el ACK y el paso posterior de liberar la mesa.
    await dejarComoCaida(p.id, { ...MARCA, huella })
    await prisma.table.update({ where: { id: t }, data: { status: 'OCCUPIED', currentOrderId: String(huella.orderId) } })

    const [retomado] = await processIntents(params([p]))

    expect(retomado).toMatchObject({ status: 'ACKED', result: expect.objectContaining({ paymentId: huella.paymentId }) })
    expect(await prisma.payment.count({ where: { venueId, orderId: String(huella.orderId) } })).toBe(1)
    expect(await prisma.table.findUniqueOrThrow({ where: { id: t } })).toMatchObject({ status: 'AVAILABLE', currentOrderId: null })
    expect(await prisma.posSyncIntent.findUniqueOrThrow({ where: { venueId_idempotencyKey: { venueId, idempotencyKey: p.id } } })).toMatchObject({ status: 'ACKED' })
  })

  it('(a) murió ANTES del commit: sin huella la retoma cobra UNA vez', async () => {
    const t = await mesa()
    const o = open(t)
    await processIntents(params([o, add(o.payload.localOrderId)]))
    const p = pay(o.payload.localOrderId, 12000)
    await prisma.posSyncIntent.create({
      data: { venueId, deviceId: device, staffId, seq: p.seq, type: 'PAY_CASH', idempotencyKey: p.id, status: 'PROCESSING', resultJson: MARCA as any, createdAt: new Date(Date.now() - 120_000) },
    })

    const [ack] = await processIntents(params([p]))

    expect(ack.status).toBe('ACKED')
    expect(await prisma.payment.count({ where: { venueId, idempotencyKey: p.id } })).toBe(1)
  })

  it('(c) ejecutor lento: si otro retomó, su transacción se revierte entera — ningún pago', async () => {
    const t = await mesa()
    const o = open(t)
    const [a1] = await processIntents(params([o, add(o.payload.localOrderId)]))
    const intentId = randomUUID()
    const turnoViejo = new Date(Date.now() - 120_000)
    await prisma.posSyncIntent.create({
      data: { venueId, deviceId: device, staffId, seq: ++seq, type: 'PAY_CASH', idempotencyKey: intentId, status: 'PROCESSING', resultJson: MARCA as any, createdAt: turnoViejo },
    })
    // Otro request la retomó (su turno es más nuevo).
    await prisma.posSyncIntent.update({ where: { venueId_idempotencyKey: { venueId, idempotencyKey: intentId } }, data: { createdAt: new Date() } })

    await expect(
      orderMobileService.payCashOrder(venueId, String(a1.result!.orderId), {
        amount: 12000,
        staffId,
        idempotencyKey: intentId,
        isOfflineReplay: true,
        dentroDeLaTx: dejarHuellaCon(venueId, intentId, turnoViejo, MARCA),
      } as any),
    ).rejects.toBeInstanceOf(ReservaPerdida)
    expect(await prisma.payment.count({ where: { venueId, idempotencyKey: intentId } })).toBe(0)
  })
})

describe('OPEN_TABLE', () => {
  it('(b) con huella devuelve ESA cuenta aunque la mesa hoy tenga otra', async () => {
    const t = await mesa()
    const o = open(t)
    const [ack] = await processIntents(params([o]))
    const cuentaA = String(ack.result!.orderId)
    await dejarComoCaida(o.id, { ...MARCA, huella: { orderId: cuentaA, isNewOrder: true } })
    // Mientras tanto otro aparato cerró A y abrió B en la misma mesa.
    await prisma.order.update({ where: { id: cuentaA }, data: { status: 'CANCELLED' } })
    await prisma.table.update({ where: { id: t }, data: { status: 'AVAILABLE', currentOrderId: null } })
    const cuentaB = (await assignTable(venueId, t, staffId, 3)).order.id

    const [retomado] = await processIntents(params([o]))

    expect(retomado).toMatchObject({ status: 'ACKED', result: expect.objectContaining({ orderId: cuentaA }) })
    expect(cuentaB).not.toBe(cuentaA)
  })

  it('(c) ejecutor lento: su admisión se revierte (no queda cuenta nueva)', async () => {
    const t = await mesa()
    const intentId = randomUUID()
    const turnoViejo = new Date(Date.now() - 120_000)
    await prisma.posSyncIntent.create({
      data: { venueId, deviceId: device, staffId, seq: ++seq, type: 'OPEN_TABLE', idempotencyKey: intentId, status: 'PROCESSING', resultJson: MARCA as any, createdAt: turnoViejo },
    })
    await prisma.posSyncIntent.update({ where: { venueId_idempotencyKey: { venueId, idempotencyKey: intentId } }, data: { createdAt: new Date() } })

    await expect(assignTable(venueId, t, staffId, 2, undefined, (tx, r) => dejarHuellaCon(venueId, intentId, turnoViejo, MARCA)(tx, r))).rejects.toBeInstanceOf(
      ReservaPerdida,
    )
    expect(await prisma.order.count({ where: { venueId, tableId: t } })).toBe(0)
  })
})

describe('ADD_ITEMS', () => {
  it('(b) con huella y renglones movidos por una división: no se duplican', async () => {
    const t = await mesa()
    const o = open(t)
    const r = add(o.payload.localOrderId, 3)
    const [a1, a2] = await processIntents(params([o, r]))
    expect(a2.status).toBe('ACKED')
    const cuenta = String(a1.result!.orderId)
    await dejarComoCaida(r.id, { ...MARCA, huella: { orderId: cuenta } })
    // Otro aparato dividió la cuenta: los renglones de la ronda viven ahora en otra orden.
    const otra = await prisma.order.create({ data: { venueId, orderNumber: `ORD-${randomUUID().slice(0, 8)}`, status: 'PENDING', total: 0, subtotal: 0, taxAmount: 0 } })
    await prisma.orderItem.updateMany({ where: { orderId: cuenta }, data: { orderId: otra.id } })

    const [retomado] = await processIntents(params([r]))

    expect(retomado).toMatchObject({ status: 'ACKED', result: expect.objectContaining({ orderId: cuenta }) })
    const renglones = await prisma.orderItem.count({ where: { externalId: { startsWith: `sync:${r.id}:` } } })
    expect(renglones).toBe(1)
  })
})

describe('CANCEL_ORDER', () => {
  it('(a) sin huella la retoma cancela; (b) con huella queda en revisión sin volver a cancelar', async () => {
    const t = await mesa()
    const o = open(t)
    const [a1] = await processIntents(params([o]))
    const c = cancel(o.payload.localOrderId)
    await prisma.posSyncIntent.create({
      data: { venueId, deviceId: device, staffId, seq: c.seq, type: 'CANCEL_ORDER', idempotencyKey: c.id, status: 'PROCESSING', resultJson: MARCA as any, createdAt: new Date(Date.now() - 120_000) },
    })
    const [ack] = await processIntents(params([c]))
    expect(ack.status).toBe('ACKED')
    expect(await prisma.order.findUniqueOrThrow({ where: { id: String(a1.result!.orderId) } })).toMatchObject({ status: 'CANCELLED' })

    await dejarComoCaida(c.id, { ...MARCA, huella: { orderId: String(a1.result!.orderId) } })
    const [revision] = await processIntents(params([c]))
    expect(revision).toMatchObject({ status: 'REJECTED', errorCode: 'OUTCOME_UNKNOWN' })
  })

  it('(c) ejecutor lento: su cancelación se revierte y la cuenta sigue abierta', async () => {
    const t = await mesa()
    const o = open(t)
    const [a1] = await processIntents(params([o]))
    const intentId = randomUUID()
    const turnoViejo = new Date(Date.now() - 120_000)
    await prisma.posSyncIntent.create({
      data: { venueId, deviceId: device, staffId, seq: ++seq, type: 'CANCEL_ORDER', idempotencyKey: intentId, status: 'PROCESSING', resultJson: MARCA as any, createdAt: turnoViejo },
    })
    await prisma.posSyncIntent.update({ where: { venueId_idempotencyKey: { venueId, idempotencyKey: intentId } }, data: { createdAt: new Date() } })

    await expect(
      orderMobileService.cancelOrder(venueId, String(a1.result!.orderId), 'lento', staffId, (tx, x) => dejarHuellaCon(venueId, intentId, turnoViejo, MARCA)(tx, x)),
    ).rejects.toBeInstanceOf(ReservaPerdida)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: String(a1.result!.orderId) } })).toMatchObject({ status: 'PENDING' })
  })
})
