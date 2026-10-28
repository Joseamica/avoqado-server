import prisma from '@/utils/prismaClient'
import { createExchange } from '@/services/exchanges/exchange.service'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { convertDemoVenue, deleteVenue } from '@/services/dashboard/venue.dashboard.service'
import { lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'
import * as paymentShiftClaims from '@/services/shared/paymentShiftClaim'
import { bloquearOrdenesParaFacturar } from '@/services/fiscal/admisionIva'
import { lockTableOrderScope } from '@/services/shared/tableOrderLock'
import { seedClothingSale } from './seedExchange'
import { barreraDeFila, planear, procesarEfectos, netoVivo, type MundoComisiones } from '../commission/_mundoComisiones'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn(async () => undefined) }))
jest.mock('@/services/superadmin/kycReview.service', () => ({ notifySuperadminsNewKycSubmission: jest.fn() }))
jest.mock('@/services/storage.service', () => ({
  ...jest.requireActual('@/services/storage.service'),
  deleteVenueFolder: jest.fn(async () => true),
  deleteFileFromStorage: jest.fn(async () => true),
}))
jest.setTimeout(60000)
type Seed = Awaited<ReturnType<typeof seedClothingSale>>
let s: Seed
beforeAll(() => {
  const u = new URL(process.env.TEST_DATABASE_URL!)
  expect(['localhost', '127.0.0.1']).toContain(u.hostname)
  expect(u.pathname).toMatch(/^\/avoqado_(?:cambio_(?:fix_|r5_)?test_\d{8}|h1a_test_\d{8}(?:_\d+)?)$/)
})
beforeEach(async () => {
  s = await seedClothingSale()
})
afterEach(async () => {
  if (s?.venueId) await s.cleanup()
})
afterAll(() => prisma.$disconnect())

describe('R5 exchange lock family and RESTRICT cleanup', () => {
  it.each(['fiscal', 'table topology'] as const)(
    'serializes %s multi-order capture against a descendant exchange in the same canonical order',
    async kind => {
      const { exchange: v1 } = await createExchange(s.input())
      const barrier = await barreraDeFila('Order', s.order.id)
      const fiscal = Promise.allSettled([
        prisma.$transaction(
          async tx => {
            if (kind === 'fiscal') await bloquearOrdenesParaFacturar(tx, [s.order.id, v1.newOrderId].sort(), s.venueId)
            else await lockTableOrderScope(tx, { venueId: s.venueId, orderIds: [s.order.id, v1.newOrderId] })
          },
          {
            timeout: 15000,
            maxWait: 5000,
          },
        ),
      ])
      let exchange: ReturnType<typeof Promise.allSettled> | undefined
      try {
        await barrier.esperarA(1)
        exchange = Promise.allSettled([
          createExchange(
            s.input(
              s.body({
                originalPaymentId: v1.paymentIds[0],
                returned: [{ orderItemId: v1.lines.taken[0].newOrderItemIds[0], quantity: 1, restock: true, reason: 'SIZE' }],
                taken: [{ productId: s.products[2].id, quantity: 1 }],
              }),
            ),
          ),
        ])
        await barrier.esperarA(2)
        await barrier.soltar()
        const results = [...(await fiscal), ...(await exchange)]
        expect(results.map(r => (r.status === 'rejected' ? String(r.reason) : r.status))).toEqual(['fulfilled', 'fulfilled'])
        expect(Number((await prisma.shift.findUniqueOrThrow({ where: { id: s.shift.id } })).totalSales)).toBe(500)
      } finally {
        await barrier.soltar()
        await fiscal
        if (exchange) await exchange
      }
    },
  )

  it('serializes demo deletion against an exchange already holding its source Order', async () => {
    await prisma.cashDrawerSession.deleteMany({ where: { venueId: s.venueId } })
    await prisma.shift.deleteMany({ where: { venueId: s.venueId } })
    await prisma.venue.update({ where: { id: s.venueId }, data: { status: 'TRIAL' } })
    await prisma.product.updateMany({ where: { venueId: s.venueId }, data: { trackInventory: false } })
    let entered!: (pid: number) => void
    let release!: () => void
    const enteredLock = new Promise<number>(resolve => (entered = resolve))
    const resume = new Promise<void>(resolve => (release = resolve))
    const realLock = paymentShiftClaims.lockExistingOrderForPayment
    const spy = jest.spyOn(paymentShiftClaims, 'lockExistingOrderForPayment').mockImplementationOnce(async (tx, input) => {
      const locked = await realLock(tx, input)
      const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
      entered(pid)
      await resume
      return locked
    })
    const exchange = Promise.allSettled([createExchange(s.input())])
    let deletion: ReturnType<typeof Promise.allSettled> | undefined
    try {
      const pid = await Promise.race([
        enteredLock,
        exchange.then(() => {
          throw new Error('Exchange did not reach its Order lock')
        }),
      ])
      deletion = Promise.allSettled([deleteVenue(s.organizationId, s.venueId)])
      const deadline = Date.now() + 5000
      for (;;) {
        const waiters = await prisma.$queryRaw<Array<{ pid: number }>>`
          SELECT pid FROM pg_stat_activity WHERE pg_blocking_pids(pid) @> ARRAY[${pid}::int]`
        if (waiters.length) break
        if (Date.now() > deadline) throw new Error('Demo deletion never waited on the exchange')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      release()
      const results = [...(await exchange), ...(await deletion)]
      expect(results.map(r => (r.status === 'rejected' ? String(r.reason) : r.status))).toEqual(['fulfilled', 'fulfilled'])
      expect(await prisma.venue.count({ where: { id: s.venueId } })).toBe(0)
    } finally {
      release()
      await exchange
      if (deletion) await deletion
      spy.mockRestore()
    }
  })

  it('takes transitive ancestors before a later payment lock can discover them', async () => {
    for (const [index, price] of [
      [3, 100],
      [4, 500],
      [1, 100],
    ])
      await prisma.product.update({ where: { id: s.products[index].id }, data: { price } })
    const { exchange: v1 } = await createExchange(
      s.input(
        s.body({
          taken: [
            { productId: s.products[3].id, quantity: 1 },
            { productId: s.products[4].id, quantity: 1 },
          ],
          settlement: { kind: 'COLLECT', method: 'CASH', expectedDifferenceCents: 10000 },
        }),
      ),
    )
    const cash = await prisma.payment.findFirstOrThrow({ where: { orderId: v1.newOrderId, method: 'CASH', type: 'REGULAR' } })
    const { exchange: v2 } = await createExchange(
      s.input(
        s.body({
          originalPaymentId: cash.id,
          returned: [{ orderItemId: v1.lines.taken[0].newOrderItemIds[0], quantity: 1, restock: true, reason: 'SIZE' }],
          taken: [{ productId: s.products[1].id, quantity: 1 }],
        }),
      ),
    )
    const link = await prisma.exchangeCreditLink.findUniqueOrThrow({ where: { creditPaymentId: v2.paymentIds[0] } })
    expect(link.originPaymentId).toBe(cash.id)
    const barrier = await barreraDeFila('Order', s.order.id)
    const work = prisma.$transaction(tx => lockExistingOrderForPayment(tx, { venueId: s.venueId, orderId: v2.newOrderId }))
    try {
      await Promise.race([
        barrier.esperarA(1),
        work.then(() => {
          throw new Error('Ancestor V0 was left for a later Payment lock')
        }),
      ])
      await barrier.soltar()
      expect(await work).toBe(true)
    } finally {
      await barrier.soltar()
      await work
    }
  })

  it('serializes a two-root third exchange and a CHAIN item refund with real Postgres barriers', async () => {
    const config = await prisma.commissionConfig.findFirstOrThrow({ where: { venueId: s.venueId } })
    await prisma.commissionConfig.update({ where: { id: config.id }, data: { includeTax: true } })
    const m: MundoComisiones = {
      key: s.venueId,
      orgId: s.organizationId,
      venueId: s.venueId,
      ana: s.seller.id,
      bea: s.staffId,
      owner: s.staffId,
      configId: config.id,
    }
    await planear(s.payments[0].id)
    await procesarEfectos(m)
    for (const p of s.products.slice(1)) await prisma.product.update({ where: { id: p.id }, data: { price: 300 } })
    const { exchange: v1 } = await createExchange(
      s.input(
        s.body({
          taken: [
            { productId: s.products[3].id, quantity: 1 },
            { productId: s.products[4].id, quantity: 1 },
          ],
          settlement: { kind: 'COLLECT', method: 'CASH', expectedDifferenceCents: 10000, cashDrawerSessionId: s.drawer.id },
        }),
      ),
    )
    const v1cash = await prisma.payment.findFirstOrThrow({ where: { orderId: v1.newOrderId, method: 'CASH', type: 'REGULAR' } })
    const v1credit = v1.paymentIds.find(id => id !== v1cash.id)!
    const { exchange: v2 } = await createExchange(
      s.input(
        s.body({
          originalPaymentId: v1cash.id,
          returned: [{ orderItemId: v1.lines.taken[0].newOrderItemIds[0], quantity: 1, restock: true, reason: 'SIZE' }],
          taken: [{ productId: s.products[1].id, quantity: 1 }],
        }),
      ),
    )
    const roots = await prisma.exchangeCreditLink.findMany({
      where: { venueId: s.venueId, creditPaymentId: { in: v2.paymentIds } },
      orderBy: { amount: 'asc' },
    })
    expect(roots.map(r => [r.originPaymentId, Number(r.amount)])).toEqual([
      [v1cash.id, 100],
      [s.payments[0].id, 200],
    ])
    // The old payment-id ordering must really choose V0 before V1 in the RED run.
    expect(s.payments[0].id < v1cash.id).toBe(true)
    const barrier = await barreraDeFila('Order', s.order.id)
    const exchange = Promise.allSettled([
      createExchange(
        s.input(
          s.body({
            originalPaymentId: v2.paymentIds[0],
            returned: [{ orderItemId: v2.lines.taken[0].newOrderItemIds[0], quantity: 1, restock: true, reason: 'SIZE' }],
            taken: [{ productId: s.products[2].id, quantity: 1 }],
          }),
        ),
      ),
    ])
    let refund: ReturnType<typeof Promise.allSettled> | undefined
    try {
      await barrier.esperarA(1)
      refund = Promise.allSettled([
        issueRefund({
          venueId: s.venueId,
          paymentId: v1credit,
          staffId: s.staffId,
          reason: 'RETURNED_GOODS',
          items: [{ orderItemId: v1.lines.taken[1].newOrderItemIds[0], quantity: 1 }],
          restockItemIds: [v1.lines.taken[1].newOrderItemIds[0]],
        }),
      ])
      await barrier.esperarA(2)
      await barrier.soltar()
      const results = [...(await exchange), ...(await refund)]
      expect(results.map(r => (r.status === 'rejected' ? String(r.reason) : r.status))).toEqual(['fulfilled', 'fulfilled'])
      expect(Number((await prisma.shift.findUniqueOrThrow({ where: { id: s.shift.id } })).totalSales)).toBe(300)
      const net = await prisma.payment.aggregate({ where: { venueId: s.venueId, status: 'COMPLETED' }, _sum: { amount: true } })
      expect(Number(net._sum.amount)).toBe(300)
      const stock = await Promise.all(
        s.products.map(async p => Number((await prisma.inventory.findUniqueOrThrow({ where: { productId: p.id } })).currentStock)),
      )
      expect(stock).toEqual([11, 10, 9, 10, 10])
      await procesarEfectos(m)
      expect(await netoVivo({ venueId: s.venueId })).toBe('15.00')
      expect(await prisma.paymentEffect.count({ where: { venueId: s.venueId, kind: 'COMMISSION', status: { not: 'DONE' } } })).toBe(0)
    } finally {
      await barrier.soltar()
      await exchange
      if (refund) await refund
    }
  })

  it.each(['conversion', 'deletion'] as const)('removes a real exchange before its payments during demo %s', async mode => {
    // This fixture has no shift: manual demo deletion already cannot delete a venue with Shift history.
    await prisma.cashDrawerSession.deleteMany({ where: { venueId: s.venueId } })
    await prisma.shift.deleteMany({ where: { venueId: s.venueId } })
    await createExchange(s.input())
    await prisma.venue.update({ where: { id: s.venueId }, data: { status: 'TRIAL' } })
    if (mode === 'conversion') {
      const converted = await convertDemoVenue(s.organizationId, s.venueId, s.staffId, {
        entityType: 'PERSONA_FISICA',
        idDocumentUrl: 'https://example.test/id.pdf',
        rfcDocumentUrl: 'https://example.test/rfc.pdf',
        comprobanteDomicilioUrl: 'https://example.test/home.pdf',
        caratulaBancariaUrl: 'https://example.test/bank.pdf',
      })
      expect(converted.status).toBe('PENDING_ACTIVATION')
      expect(await prisma.venue.count({ where: { id: s.venueId } })).toBe(1)
    } else {
      await deleteVenue(s.organizationId, s.venueId)
      expect(await prisma.venue.count({ where: { id: s.venueId } })).toBe(0)
    }
    expect(await prisma.exchangeCreditLink.count({ where: { venueId: s.venueId } })).toBe(0)
    expect(await prisma.exchange.count({ where: { venueId: s.venueId } })).toBe(0)
    expect(await prisma.payment.count({ where: { venueId: s.venueId } })).toBe(0)
    expect(await prisma.order.count({ where: { venueId: s.venueId } })).toBe(0)
  })
})
