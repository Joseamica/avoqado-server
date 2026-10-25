import prisma from '@/utils/prismaClient'
import { createExchange } from '@/services/exchanges/exchange.service'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { recordRefund } from '@/services/tpv/refund.tpv.service'
import { recordOrderPayment } from '@/services/tpv/payment.tpv.service'
import { payCashOrder } from '@/services/mobile/order.mobile.service'
import { recorrerLibros } from '@/services/fiscal/librosDeOrdenes'
import type { ParteDelLibro } from '@/services/fiscal/libroDeLaOrden'
import { seedClothingSale } from './seedExchange'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn(async () => undefined) }))
jest.setTimeout(90000)
type Seed = Awaited<ReturnType<typeof seedClothingSale>>
let s: Seed | undefined

beforeAll(() => {
  const u = new URL(process.env.TEST_DATABASE_URL!)
  expect(['localhost', '127.0.0.1']).toContain(u.hostname)
  expect(u.pathname).toMatch(/^\/avoqado_h1a_test_\d{8}(?:_\d+)?$/)
})
afterEach(async () => {
  jest.useRealTimers()
  if (s?.venueId) await s.cleanup()
  s = undefined
})
afterAll(() => prisma.$disconnect())

async function seed() {
  s = await seedClothingSale({ list: 200 })
  await prisma.venue.update({ where: { id: s.venueId }, data: { seatCapExempt: true } })
  return s
}
const refund = (sale: Seed, paymentId = sale.payments[0].id) =>
  issueRefund({ venueId: sale.venueId, staffId: sale.staffId, paymentId, amount: 10000, reason: 'RETURNED_GOODS' })

describe('R11: todos los escritores respetan el orden contable confirmado', () => {
  it('cambio futuro de $200 a gravado y exento → CHAIN del gravado devuelve IVA $13.79 exacto', async () => {
    const sale = await seed()
    const future = new Date(Date.now() + 60000)
    await prisma.payment.update({ where: { id: sale.payments[0].id }, data: { createdAt: future } })
    await prisma.venueIvaPorProducto.create({ data: { venueId: sale.venueId } })
    await prisma.product.update({ where: { id: sale.products[3].id }, data: { price: 100, ivaTratamiento: 'IVA_16' } })
    await prisma.product.update({ where: { id: sale.products[4].id }, data: { price: 100, ivaTratamiento: 'EXENTO' } })
    const { exchange: e } = await createExchange(
      sale.input(
        sale.body({
          taken: [
            { productId: sale.products[3].id, quantity: 1 },
            { productId: sale.products[4].id, quantity: 1 },
          ],
        }),
      ),
    )
    const credit = await prisma.payment.findUniqueOrThrow({ where: { id: e.paymentIds[0] } })
    const r = await issueRefund({
      venueId: sale.venueId,
      staffId: sale.staffId,
      paymentId: credit.id,
      reason: 'RETURNED_GOODS',
      items: [{ orderItemId: e.lines.taken[0].newOrderItemIds[0], quantity: 1 }],
    })
    const parts: Array<{ id: string; at: Date; part: ParteDelLibro }> = []
    await prisma.$transaction(tx =>
      recorrerLibros(
        tx,
        {
          venueId: sale.venueId,
          orderIds: [e.newOrderId],
          hasta: new Date(future.getTime() + 60000),
        },
        (m, part) => {
          parts.push({ id: m.id, at: m.createdAt, part })
        },
      ),
    )
    console.log('R11 CHAIN libro real', JSON.stringify(parts))
    expect(parts.find(p => p.id === r.refundId)?.part).toMatchObject({
      porTratamiento: { IVA_16: { baseCents: -8621, ivaCents: -1379 } },
      aproximada: false,
    })
    expect(parts.find(p => p.id === r.refundId)?.part.porTratamiento).not.toHaveProperty('EXENTO')
    expect(parts.map(p => p.id)).toEqual([credit.id, r.refundId])
    expect(parts[1].at.getTime()).toBe(credit.createdAt.getTime() + 1)
  })

  it('una devolución ordinaria queda después del cobro futuro, sin necesitar un cambio', async () => {
    const sale = await seed()
    const future = new Date(Date.now() + 60000)
    await prisma.payment.update({ where: { id: sale.payments[0].id }, data: { createdAt: future } })
    const r = await refund(sale)
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: r.refundId } })
    expect(row.createdAt.getTime()).toBe(future.getTime() + 1)
    expect(Number(row.amount)).toBe(-100)
  })

  it('sin desfase una devolución ordinaria conserva exactamente el reloj del servidor', async () => {
    const sale = await seed()
    const now = new Date()
    await prisma.payment.update({ where: { id: sale.payments[0].id }, data: { createdAt: new Date(now.getTime() - 60000) } })
    jest.useFakeTimers({
      now,
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'setImmediate',
        'clearImmediate',
      ],
    })
    const r = await refund(sale)
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: r.refundId } })).createdAt).toEqual(now)
  })

  it('la devolución TPV del cobro raíz también queda después del último movimiento futuro', async () => {
    const sale = await seed()
    const future = new Date(Date.now() + 60000)
    await prisma.payment.update({ where: { id: sale.payments[0].id }, data: { createdAt: future } })
    const r = await recordRefund(
      sale.venueId,
      {
        venueId: sale.venueId,
        originalPaymentId: sale.payments[0].id,
        amount: 10000,
        reason: 'RETURNED_GOODS',
        authorizationNumber: 'r11-auth',
        referenceNumber: 'r11-ref',
        isPartialRefund: true,
        currency: 'MXN',
        idempotencyKey: `r11-tpv-${sale.order.id}`,
      },
      sale.staffId,
    )
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: r.id } })
    expect(row.createdAt.getTime()).toBe(future.getTime() + 1)
    expect(Number(row.amount)).toBe(-100)
  })

  it('el efectivo ya capturado que llega a una venta de cambio cerrada no se fecha antes de su crédito', async () => {
    const sale = await seed()
    await prisma.payment.update({ where: { id: sale.payments[0].id }, data: { createdAt: new Date(Date.now() + 60000) } })
    const { exchange: e } = await createExchange(sale.input())
    const credit = await prisma.payment.findUniqueOrThrow({ where: { id: e.paymentIds[0] } })
    const input = { amount: 100, tip: 0, staffId: sale.staffId, idempotencyKey: `r11-late-${e.id}`, isOfflineReplay: true }
    const r = await payCashOrder(sale.venueId, e.newOrderId, input)
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: r.paymentId } })
    expect(row.createdAt.getTime()).toBe(credit.createdAt.getTime() + 1)
    expect(Number(row.amount)).toBe(1)
    expect((await payCashOrder(sale.venueId, e.newOrderId, input)).paymentId).toBe(row.id)
  })

  it('el registro de la terminal sobre una venta cerrada usa la misma fecha contable', async () => {
    const sale = await seed()
    await prisma.payment.update({ where: { id: sale.payments[0].id }, data: { createdAt: new Date(Date.now() + 60000) } })
    const { exchange: e } = await createExchange(sale.input())
    const credit = await prisma.payment.findUniqueOrThrow({ where: { id: e.paymentIds[0] } })
    const input = {
      venueId: sale.venueId,
      amount: 100,
      tip: 0,
      status: 'COMPLETED' as const,
      method: 'CASH' as const,
      source: 'TPV',
      splitType: 'FULLPAYMENT' as const,
      tpvId: sale.venueId,
      staffId: sale.staffId,
      paidProductsId: [],
      idempotencyKey: `r11-terminal-${e.id}`,
      currency: 'MXN',
      isInternational: false,
    }
    const r = await recordOrderPayment(sale.venueId, e.newOrderId, input, sale.staffId)
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: r.id } })
    expect(row.createdAt.getTime()).toBe(credit.createdAt.getTime() + 1)
    expect(Number(row.amount)).toBe(1)
    expect((await recordOrderPayment(sale.venueId, e.newOrderId, input, sale.staffId)).id).toBe(row.id)
  })
})
