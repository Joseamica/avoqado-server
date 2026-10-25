import prisma from '@/utils/prismaClient'
import { settleCustomerBalance } from '@/services/dashboard/customer.dashboard.service'
import { mergeOrdersInTransaction, payCashOrder } from '@/services/mobile/order.mobile.service'
import { createExchange } from '@/services/exchanges/exchange.service'
import { loadSaleForExchange } from '@/services/exchanges/exchangeSale'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'
import { resolveExchangeCreditTenderInTx, ensureExchangeCreditTender } from '@/services/exchanges/exchangeCreditTender'
import { barreraDeFila } from '../commission/_mundoComisiones'
import { seedClothingSale } from './seedExchange'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn(async () => undefined) }))
jest.setTimeout(90000)
let s: Awaited<ReturnType<typeof seedClothingSale>>
beforeAll(() => {
  const u = new URL(process.env.TEST_DATABASE_URL!)
  expect(['localhost', '127.0.0.1']).toContain(u.hostname)
  expect(u.pathname).toMatch(/^\/avoqado_h1a_test_\d{8}(?:_\d+)?$/)
})
afterEach(async () => {
  jest.restoreAllMocks()
  if (s?.venueId) await s.cleanup()
})
afterAll(() => prisma.$disconnect())

describe('R7: conjuntos de candados y venta resultante dentro de sus topes', () => {
  it('dos altas iniciales concurrentes recuperan P2002 sin abortar su transacción', async () => {
    s = await seedClothingSale()
    let entered!: (pid: number) => void
    let release!: () => void
    const enteredLock = new Promise<number>(resolve => (entered = resolve))
    const resume = new Promise<void>(resolve => (release = resolve))
    const first = Promise.allSettled([
      prisma.$transaction(
        async tx => {
          const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
          const tender = await ensureExchangeCreditTender(tx, s.venueId, true)
          entered(pid)
          await resume
          return tender
        },
        { timeout: 30000 },
      ),
    ])
    let second: typeof first | undefined
    try {
      const pid = await Promise.race([enteredLock, first.then(() => Promise.reject(new Error('No llegó al alta inicial')))])
      second = Promise.allSettled([prisma.$transaction(tx => ensureExchangeCreditTender(tx, s.venueId, true), { timeout: 30000 })])
      const deadline = Date.now() + 5000
      for (;;) {
        const waiters = await prisma.$queryRaw<Array<{ pid: number }>>`
          SELECT pid FROM pg_stat_activity WHERE pg_blocking_pids(pid) @> ARRAY[${pid}::int]`
        if (waiters.length) {
          expect(waiters.every(waiter => waiter.pid !== pid)).toBe(true)
          break
        }
        if (Date.now() > deadline) throw new Error('La segunda alta no esperó a la primera conexión')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      release()
      const results = [...(await first), ...(await second)]
      expect(results.map(r => (r.status === 'fulfilled' ? r.value : String(r.reason)))).toEqual([
        expect.objectContaining({ revision: 1 }),
        expect.objectContaining({ revision: 1 }),
      ])
      expect(results[0]).toEqual(results[1])
      expect(await prisma.venueTenderType.count({ where: { venueId: s.venueId, systemKind: 'EXCHANGE_CREDIT' } })).toBe(1)
      expect(await prisma.venueTenderTypeRevision.count({ where: { venueId: s.venueId } })).toBe(1)
    } finally {
      release()
      await first
      if (second) await second
    }
  })

  it('liquida O1+O2 contra su fusión con conexiones independientes, sin 40P01 y con $600 exactos', async () => {
    s = await seedClothingSale({ list: 300 })
    await prisma.payment.deleteMany({ where: { venueId: s.venueId } })
    await prisma.order.update({
      where: { id: s.order.id },
      data: {
        status: 'CONFIRMED',
        paymentStatus: 'PENDING',
        paidAmount: 0,
        remainingBalance: 300,
        createdAt: new Date(Date.now() - 60000),
      },
    })
    await prisma.shift.update({ where: { id: s.shift.id }, data: { totalSales: 0 } })
    const second = await prisma.order.create({
      data: {
        venueId: s.venueId,
        orderNumber: 'SECOND-' + s.venueId,
        status: 'CONFIRMED',
        paymentStatus: 'PENDING',
        subtotal: 300,
        total: 300,
        taxAmount: 0,
        remainingBalance: 300,
        contratoDePrecio: 'IVA_INCLUIDO',
        orderCustomers: { create: { customerId: s.customer.id, isPrimary: true } },
        items: { create: { productId: s.products[0].id, quantity: 1, unitPrice: 300, total: 300, taxAmount: 0 } },
      },
    })
    expect(s.order.id < second.id).toBe(true)
    const barrier = await barreraDeFila('Order', second.id)
    const merge = Promise.allSettled([
      prisma.$transaction(tx => mergeOrdersInTransaction(tx, s.venueId, s.order.id, second.id, s.staffId), {
        timeout: 30000,
        maxWait: 5000,
      }),
    ])
    let settlement: ReturnType<typeof Promise.allSettled> | undefined
    try {
      // La fusión es la PRIMERA que espera O2. El bucle viejo puede tomar O1 mientras espera detrás.
      await barrier.esperarA(1)
      settlement = Promise.allSettled([settleCustomerBalance(s.venueId, s.customer.id, 'R7', s.staffId)])
      await barrier.esperarA(2)
      await barrier.soltar()
      const results = [...(await merge), ...(await settlement)]
      expect(results.map(r => (r.status === 'rejected' ? String(r.reason) : r.status))).toEqual(['fulfilled', 'fulfilled'])
      const all = await prisma.payment.aggregate({ where: { venueId: s.venueId, status: 'COMPLETED' }, _sum: { amount: true } })
      expect(Number(all._sum.amount)).toBe(600)
      expect(Number((await prisma.shift.findUniqueOrThrow({ where: { id: s.shift.id } })).totalSales)).toBe(600)
      expect((await settlement)[0]).toMatchObject({ status: 'fulfilled', value: { settledAmount: 600 } })
    } finally {
      await barrier.soltar()
      await merge
      if (settlement) await settlement
    }
  })

  // Forma durable de una cadena que cobró $100 y después $1 por cambio: raíces distintas, créditos aplanados, último $1 propio.
  async function history(count: number, sameRoot = false) {
    const total = 99 + count
    s = await seedClothingSale({ list: total })
    await prisma.payment.deleteMany({ where: { venueId: s.venueId } })
    await ensureExchangeCreditTender(prisma, s.venueId)
    const payments: string[] = []
    await prisma.$transaction(
      async tx => {
        const tender = await resolveExchangeCreditTenderInTx(tx, s.venueId)
        let repeatedRoot: string | undefined
        let exchange: { id: string } | undefined
        for (let i = 0; i < count - 1; i++) {
          const amount = i === 0 ? 100 : 1
          const parent = await tx.order.create({
            data: {
              venueId: s.venueId,
              orderNumber: `ROOT-${i}-${s.venueId}`,
              subtotal: amount,
              total: amount,
              taxAmount: 0,
              paymentStatus: 'PAID',
            },
          })
          const root =
            repeatedRoot && sameRoot
              ? { id: repeatedRoot }
              : await tx.payment.create({
                  data: {
                    venueId: s.venueId,
                    orderId: parent.id,
                    amount: sameRoot ? total : amount,
                    netAmount: sameRoot ? total : amount,
                    feeAmount: 0,
                    feePercentage: 0,
                    method: 'CASH',
                    status: 'COMPLETED',
                    type: 'REGULAR',
                    fundsFlow: 'CASH_DRAWER',
                  },
                })
          repeatedRoot = root.id
          const credit = await tx.payment.create({
            data: {
              ...tender,
              venueId: s.venueId,
              orderId: s.order.id,
              amount,
              netAmount: amount,
              tipAmount: 0,
              feeAmount: 0,
              feePercentage: 0,
              status: 'COMPLETED',
              type: 'REGULAR',
              createdAt: new Date(Date.now() + i),
            },
          })
          const refund = await tx.payment.create({
            data: {
              venueId: s.venueId,
              orderId: parent.id,
              amount: -amount,
              netAmount: -amount,
              feeAmount: 0,
              feePercentage: 0,
              method: 'OTHER',
              type: 'REFUND',
              status: 'COMPLETED',
            },
          })
          exchange ??= await tx.exchange.create({
            data: {
              venueId: s.venueId,
              idempotencyKey: `history-${i}`,
              requestHash: 'history',
              originalOrderId: parent.id,
              originalPaymentId: root.id,
              newOrderId: s.order.id,
              returnedAmount: amount,
              takenAmount: amount,
              differenceAmount: 0,
              settlementKind: 'EVEN',
              status: 'COMPLETED',
              staffId: s.staffId,
              deviceId: 'history',
              createdAtLocal: new Date(),
              lines: {},
            },
          })
          await tx.exchangeCreditLink.create({
            data: {
              venueId: s.venueId,
              exchangeId: exchange.id,
              originPaymentId: root.id,
              creditPaymentId: credit.id,
              creditRefundPaymentId: refund.id,
              amount,
            },
          })
          payments.push(credit.id)
        }
        payments.push(
          (
            await tx.payment.create({
              data: {
                venueId: s.venueId,
                orderId: s.order.id,
                amount: 1,
                netAmount: 1,
                tipAmount: 0,
                feeAmount: 0,
                feePercentage: 0,
                method: 'CASH',
                fundsFlow: 'CASH_DRAWER',
                type: 'REGULAR',
                status: 'COMPLETED',
              },
            })
          ).id,
        )
      },
      { timeout: 30000 },
    )
    await prisma.product.update({ where: { id: s.products[3].id }, data: { price: total + 1 } })
    return s.input(
      s.body({
        originalPaymentId: payments[0],
        taken: [{ productId: s.products[3].id, quantity: 1 }],
        settlement: { kind: 'COLLECT', method: 'CASH', expectedDifferenceCents: 100 },
      }),
    )
  }

  async function snapshot() {
    const models = [
      'order',
      'payment',
      'exchange',
      'exchangeCreditLink',
      'inventoryPosting',
      'inventory',
      'shift',
      'cashDrawerSession',
      'cashDrawerEvent',
      'paymentEffect',
      'activityLog',
      'venueTenderType',
      'venueTenderTypeRevision',
    ] as const
    return Promise.all(models.map(model => (prisma[model] as any).findMany({ where: { venueId: s.venueId }, orderBy: { id: 'asc' } })))
  }

  it.each([false, true])('rechaza limpio el siguiente cambio desde 50 pagos (raíces repetidas=%s)', async sameRoot => {
    const input = await history(50, sameRoot)
    expect((await loadSaleForExchange(prisma, s.venueId, s.order.id)).payments).toHaveLength(50)
    expect(await prisma.$transaction(tx => lockExistingOrderForPayment(tx, { venueId: s.venueId, orderId: s.order.id }))).toBe(true)
    const before = await snapshot()
    await expect(createExchange(input)).rejects.toMatchObject({ statusCode: 409, code: 'EXCHANGE_RESULT_TOO_LARGE' })
    expect(await snapshot()).toEqual(before)
  })

  it('el primer cambio rechazado tampoco crea el tipo de pago de sistema ni su revisión', async () => {
    s = await seedClothingSale({ list: 50, payments: Array(50).fill(1) })
    await prisma.product.update({ where: { id: s.products[3].id }, data: { price: 51 } })
    expect(await prisma.venueTenderType.count({ where: { venueId: s.venueId, systemKind: 'EXCHANGE_CREDIT' } })).toBe(0)
    const before = await snapshot()
    await expect(
      createExchange(
        s.input(
          s.body({
            taken: [{ productId: s.products[3].id, quantity: 1 }],
            settlement: { kind: 'COLLECT', method: 'CASH', expectedDifferenceCents: 100 },
          }),
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'EXCHANGE_RESULT_TOO_LARGE' })
    expect(await snapshot()).toEqual(before)
  })

  it('rechaza también por alcance 51 aunque los pagos resultantes sean sólo 50', async () => {
    const input = await history(49)
    const link = await prisma.exchangeCreditLink.findUniqueOrThrow({ where: { creditPaymentId: input.body.originalPaymentId } })
    const root = await prisma.payment.findUniqueOrThrow({ where: { id: link.originPaymentId } })
    await prisma.$transaction(async tx => {
      const extra = await tx.order.create({
        data: { venueId: s.venueId, orderNumber: 'EXTRA-' + s.venueId, subtotal: 1, total: 1, taxAmount: 0 },
      })
      const payment = await tx.payment.create({
        data: { venueId: s.venueId, orderId: extra.id, amount: 1, netAmount: 1, feeAmount: 0, feePercentage: 0, method: 'CASH' },
      })
      const credit = await tx.payment.create({
        data: {
          ...(await resolveExchangeCreditTenderInTx(tx, s.venueId)),
          venueId: s.venueId,
          orderId: root.orderId,
          status: 'REFUNDED',
          type: 'REGULAR',
          amount: 1,
          netAmount: 1,
          feeAmount: 0,
          feePercentage: 0,
        },
      })
      const exchange = await tx.exchange.create({
        data: {
          venueId: s.venueId,
          idempotencyKey: 'extra-scope',
          requestHash: 'extra',
          originalOrderId: extra.id,
          originalPaymentId: payment.id,
          newOrderId: root.orderId!,
          returnedAmount: 1,
          takenAmount: 1,
          differenceAmount: 0,
          settlementKind: 'EVEN',
          status: 'COMPLETED',
          staffId: s.staffId,
          lines: {},
        },
      })
      await tx.exchangeCreditLink.create({
        data: {
          venueId: s.venueId,
          exchangeId: exchange.id,
          originPaymentId: payment.id,
          creditPaymentId: credit.id,
          creditRefundPaymentId: credit.id,
          amount: 1,
        },
      })
    })
    expect((await loadSaleForExchange(prisma, s.venueId, s.order.id)).payments).toHaveLength(49)
    expect(await prisma.$transaction(tx => lockExistingOrderForPayment(tx, { venueId: s.venueId, orderId: s.order.id }))).toBe(true)
    const before = await snapshot()
    await expect(createExchange(input)).rejects.toMatchObject({ statusCode: 409, code: 'EXCHANGE_RESULT_TOO_LARGE' })
    expect(await snapshot()).toEqual(before)
  })

  it('desde 49 acepta la diferencia, deja 50 pagos y permite después una devolución CHAIN', async () => {
    const input = await history(49)
    const { exchange } = await createExchange(input)
    expect((await loadSaleForExchange(prisma, s.venueId, exchange.newOrderId)).payments).toHaveLength(50)
    expect(await prisma.$transaction(tx => lockExistingOrderForPayment(tx, { venueId: s.venueId, orderId: exchange.newOrderId }))).toBe(
      true,
    )
    const before = await snapshot()
    await expect(payCashOrder(s.venueId, exchange.newOrderId, { staffId: s.staffId, amount: 100 })).rejects.toThrow('already paid')
    expect(await snapshot()).toEqual(before)
    await issueRefund({ venueId: s.venueId, paymentId: exchange.paymentIds[0], amount: 100, reason: 'RETURNED_GOODS', staffId: s.staffId })
    expect((await loadSaleForExchange(prisma, s.venueId, exchange.newOrderId)).payments.length).toBeLessThanOrEqual(50)
    expect(await prisma.$transaction(tx => lockExistingOrderForPayment(tx, { venueId: s.venueId, orderId: exchange.newOrderId }))).toBe(
      true,
    )
    const returned = await prisma.payment.aggregate({
      where: { venueId: s.venueId, orderId: exchange.newOrderId, type: 'REFUND', method: 'CASH' },
      _sum: { amount: true },
    })
    expect(Number(returned._sum.amount)).toBe(-1)
  })
})
