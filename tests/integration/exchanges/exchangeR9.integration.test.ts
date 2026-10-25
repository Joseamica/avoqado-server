import prisma from '@/utils/prismaClient'
import { createExchange } from '@/services/exchanges/exchange.service'
import { lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'
import { writeRefundInTx } from '@/services/shared/writeRefundInTx'
import { recorrerLibros } from '@/services/fiscal/librosDeOrdenes'
import type { ParteDelLibro } from '@/services/fiscal/libroDeLaOrden'
import { seedClothingSale } from './seedExchange'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn(async () => undefined) }))
jest.setTimeout(90000)
let s: Awaited<ReturnType<typeof seedClothingSale>> | undefined

beforeAll(() => {
  const u = new URL(process.env.TEST_DATABASE_URL!)
  expect(['localhost', '127.0.0.1']).toContain(u.hostname)
  expect(u.pathname).toMatch(/^\/avoqado_(?:h1a_test_\d{8}(?:_\d+)?|cambio_test_20261020)$/)
})
afterEach(async () => {
  if (s?.venueId) await s.cleanup()
})
afterAll(() => prisma.$disconnect())

describe('R9: el libro conserva el orden de las devoluciones bajo contención', () => {
  it('el cambio que espera una devolución de $33.34 fecha sus $33.33 después, sin mandar un centavo a EXENTO', async () => {
    s = await seedClothingSale({ list: 100, quantity: 3 })
    const sale = s
    await prisma.venue.update({ where: { id: sale.venueId }, data: { seatCapExempt: true } })
    await prisma.orderItem.update({
      where: { id: sale.order.items[0].id },
      data: { unitPrice: 33.33, total: 100, ivaTratamiento: 'IVA_16' },
    })
    await prisma.orderItem.create({
      data: {
        orderId: sale.order.id,
        productId: sale.products[3].id,
        productName: 'Artículo exento',
        quantity: 1,
        unitPrice: 1000,
        total: 1000,
        taxAmount: 0,
        ivaTratamiento: 'EXENTO',
      },
    })
    await prisma.order.update({ where: { id: sale.order.id }, data: { subtotal: 1100, total: 1100, paidAmount: 1100 } })
    await prisma.payment.update({
      where: { id: sale.payments[0].id },
      data: { amount: 1100, netAmount: 1100, createdAt: new Date(Date.now() - 60000) },
    })
    const input = sale.input()
    let entered!: (pid: number) => void
    let release!: () => void
    const locked = new Promise<number>(resolve => (entered = resolve))
    const resume = new Promise<void>(resolve => (release = resolve))
    const ordinary = Promise.allSettled([
      prisma.$transaction(
        async tx => {
          await lockExistingOrderForPayment(tx, { venueId: sale.venueId, orderId: sale.order.id })
          const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
          entered(pid)
          await resume
          // Mismo núcleo y defaults de issueRefund: sin fecha impuesta ni marca de cambio.
          return writeRefundInTx(tx, {
            venueId: sale.venueId,
            originalPaymentId: sale.payments[0].id,
            salesRefundCents: 3334,
            tipRefundCents: 0,
            refundedItems: [{ orderItemId: sale.order.items[0].id, quantity: 1, amountCents: 3334 }],
            reason: 'RETURNED_GOODS',
            staffId: sale.staffId,
            tenderCommission: 'NONE',
            shift: 'CLAIM_LIVE',
          })
        },
        { timeout: 30000 },
      ),
    ])
    let exchange: Promise<PromiseSettledResult<Awaited<ReturnType<typeof createExchange>>>[]> | undefined
    try {
      const pid = await Promise.race([locked, ordinary.then(() => Promise.reject(new Error('La devolución no tomó el candado')))])
      exchange = Promise.allSettled([createExchange(input)])
      const deadline = Date.now() + 10000
      for (;;) {
        const waiters = await prisma.$queryRaw<Array<{ pid: number }>>`
          SELECT pid FROM pg_stat_activity WHERE pg_blocking_pids(pid) @> ARRAY[${pid}::int]`
        if (waiters.length) break
        if (Date.now() > deadline) throw new Error('El cambio no esperó a la conexión de la devolución')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      // Separa los relojes reales, sólo después de acreditar la espera en Postgres.
      await new Promise(resolve => setTimeout(resolve, 30))
      release()
      const [refund] = await ordinary
      const [changed] = await exchange
      if (refund.status === 'rejected') throw refund.reason
      if (changed.status === 'rejected') throw changed.reason
      const e = changed.value.exchange
      expect(e).toMatchObject({ returnedCents: 3333, takenCents: 3333, differenceCents: 0 })
      const parts: Array<{ id: string; at: Date; part: ParteDelLibro }> = []
      await prisma.$transaction(tx =>
        recorrerLibros(
          tx,
          {
            venueId: sale.venueId,
            orderIds: [sale.order.id],
            hasta: new Date(Date.now() + 60000),
          },
          (m, part) => {
            if (m.type === 'REFUND') parts.push({ id: m.id, at: m.createdAt, part })
          },
        ),
      )
      console.log('R9 libro real', JSON.stringify(parts))
      expect(parts.map(p => ({ byTreatment: p.part.porTratamiento, approximate: p.part.aproximada }))).toEqual([
        { byTreatment: { IVA_16: { baseCents: -2874, ivaCents: -460 } }, approximate: false },
        { byTreatment: { IVA_16: { baseCents: -2873, ivaCents: -460 } }, approximate: false },
      ])
      expect(parts.map(p => p.id)).toEqual([refund.value.refundPaymentId, ...e.refundPaymentIds])
      expect(parts[1].at.getTime()).toBeGreaterThanOrEqual(parts[0].at.getTime())
      const replay = await createExchange(input)
      expect(replay.exchange.id).toBe(e.id)
      expect(await prisma.payment.count({ where: { venueId: sale.venueId, type: 'REFUND' } })).toBe(2)
    } finally {
      release()
      await ordinary
      if (exchange) await exchange
    }
  })
})
