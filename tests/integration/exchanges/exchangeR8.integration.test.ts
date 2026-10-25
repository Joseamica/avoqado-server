import { Prisma } from '@prisma/client'
import { fromZonedTime } from 'date-fns-tz'
import prisma from '@/utils/prismaClient'
import { createExchange, type CreateExchangeBody } from '@/services/exchanges/exchange.service'
import { postCashRefundToDrawer, postCashSaleToDrawer } from '@/services/shared/cashDrawerPosting'
import { CashDrawerReconcilerJob, defaults } from '@/jobs/cash-drawer-reconciler.job'
import { getSalesSummary } from '@/services/dashboard/sales-summary.dashboard.service'
import { getBasicMetricsData } from '@/services/dashboard/generalStats.dashboard.service'
import { getTransactions } from '@/services/mobile/transaction.mobile.service'
import { aggregatePaymentsByMethod } from '@/services/legacy/mergedPayments.service'
import { getBankAndCashSummary, getIncomeStatement } from '@/services/dashboard/accounting.dashboard.service'
import { readShiftPaymentsForClose, aggregateShiftPayments } from '@/services/tpv/shift.tpv.service'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { executeExchangeInTransaction, payCashOrder } from '@/services/mobile/order.mobile.service'
import { operationHash } from '@/utils/operationHash'
import { writeRefundInTx } from '@/services/shared/writeRefundInTx'
import { seedClothingSale } from './seedExchange'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({ generateAndStoreReceipt: jest.fn(async () => undefined) }))
jest.mock('@/services/shared/cashDrawerPosting', () => {
  const real = jest.requireActual('@/services/shared/cashDrawerPosting')
  return { ...real, postCashRefundToDrawer: jest.fn(real.postCashRefundToDrawer), postCashSaleToDrawer: jest.fn(real.postCashSaleToDrawer) }
})
jest.mock('@/services/shared/writeRefundInTx', () => {
  const real = jest.requireActual('@/services/shared/writeRefundInTx')
  return { ...real, writeRefundInTx: jest.fn(real.writeRefundInTx) }
})
jest.setTimeout(90000)
type Seed = Awaited<ReturnType<typeof seedClothingSale>>
const fixtures: Seed[] = []
async function seed(price = 400) {
  const s = await seedClothingSale()
  fixtures.push(s)
  await prisma.venue.update({ where: { id: s.venueId }, data: { seatCapExempt: true, timezone: 'America/Mexico_City' } })
  await prisma.product.update({ where: { id: s.products[3].id }, data: { price: new Prisma.Decimal(price) } })
  await prisma.payment.updateMany({ where: { venueId: s.venueId }, data: { createdAt: new Date(s.drawer.openedAt.getTime() - 60000) } })
  return s
}
function body(s: Seed, price = 400): CreateExchangeBody {
  return s.body({
    taken: [{ productId: s.products[3].id, quantity: 1 }],
    settlement: {
      kind: price > 500 ? 'COLLECT' : 'PAYOUT',
      method: 'CASH',
      expectedDifferenceCents: (price - 500) * 100,
      cashDrawerSessionId: s.drawer.id,
    },
  })
}
const events = (s: Seed) => prisma.cashDrawerEvent.findMany({ where: { venueId: s.venueId }, take: 20 })
const reconciler = (now: Date) => new CashDrawerReconcilerJob({ cron: { start: () => undefined, stop: () => undefined }, now: () => now })

/** Sólo Date en Node: PostgreSQL/Prisma mantienen sus propios relojes reales. */
function transactionClock(at: Date) {
  jest.useFakeTimers({
    now: at,
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
}

beforeAll(() => {
  const u = new URL(process.env.TEST_DATABASE_URL!)
  expect(['localhost', '127.0.0.1']).toContain(u.hostname)
  expect(u.pathname).toMatch(/^\/avoqado_(?:h1a_test_\d{8}(?:_\d+)?|cambio_test_20261020)$/)
})
afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})
afterAll(async () => {
  for (const s of fixtures) {
    await prisma.fiscalEmisor.deleteMany({ where: { venueId: s.venueId } })
    await s.cleanup()
  }
  await prisma.$disconnect()
})

describe('R8: el dato confirmado sobrevive a recuperación y reportes', () => {
  it('un efectivo ya capturado que llega después a la venta nueva conserva SU caja, no la del cambio', async () => {
    const s = await seed(600)
    const { exchange: e } = await createExchange(s.input(body(s, 600)))
    await prisma.cashDrawerSession.update({ where: { id: s.drawer.id }, data: { status: 'CLOSED', closedAt: new Date() } })
    await prisma.shift.update({ where: { id: s.shift.id }, data: { status: 'CLOSED', endTime: new Date() } })
    const shift = await prisma.shift.create({ data: { venueId: s.venueId, staffId: s.staffId, status: 'OPEN', startTime: new Date() } })
    const next = await prisma.cashDrawerSession.create({
      data: {
        venueId: s.venueId,
        openedByStaffId: s.staffId,
        openedByName: 'S2',
        startingAmount: 0,
        shiftId: shift.id,
      },
    })
    jest.mocked(postCashSaleToDrawer).mockResolvedValueOnce('FAILED')
    const late = await payCashOrder(s.venueId, e.newOrderId, {
      amount: 10000,
      tip: 0,
      staffId: s.staffId,
      idempotencyKey: `late-${e.id}`,
      isOfflineReplay: true,
    })
    const p = await prisma.payment.findUniqueOrThrow({ where: { id: late.paymentId } })
    await reconciler(new Date(p.createdAt.getTime() + 10 * 60000)).runNow()
    expect((await events(s)).filter(r => r.localId === `srv-cash-sale:${p.id}`).map(r => [r.sessionId, Number(r.amount)])).toEqual([
      [next.id, 100],
    ])
    expect((await events(s)).filter(r => r.localId === `srv-cash-sale:${e.paymentIds.at(-1)}`).map(r => r.sessionId)).toEqual([s.drawer.id])
  })

  it('el instante contable es UTC real incluso si la conexión Postgres tiene zona de México', async () => {
    const s = await seed()
    const real = prisma.$transaction.bind(prisma)
    jest.spyOn(prisma, '$transaction').mockImplementationOnce(((run: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) =>
      real(async tx => {
        await tx.$executeRaw`SET LOCAL TIME ZONE 'America/Mexico_City'`
        return run(tx)
      }, options)) as typeof prisma.$transaction)
    const before = Date.now()
    const { exchange: e } = await createExchange(s.input(body(s)))
    const after = Date.now()
    const rows = await prisma.payment.findMany({ where: { id: { in: [...e.refundPaymentIds, ...e.paymentIds] } }, take: 20 })
    const order = await prisma.order.findUniqueOrThrow({ where: { id: e.newOrderId } })
    const exchange = await prisma.exchange.findUniqueOrThrow({ where: { id: e.id } })
    for (const row of [...rows, order, exchange]) {
      expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before)
      expect(row.createdAt.getTime()).toBeLessThanOrEqual(after)
    }
    expect(rows.map(r => r.createdAt.toISOString())).toEqual(rows.map(() => order.createdAt.toISOString()))
  })

  it('la venta nueva guarda el turno que ganó sus cobros si S1 cierra antes del primer reclamo', async () => {
    const s = await seed()
    let shiftId = ''
    const real = jest.requireActual('@/services/shared/writeRefundInTx').writeRefundInTx
    jest.mocked(writeRefundInTx).mockImplementationOnce(async (tx, input) => {
      // Otra conexión cierra/reabre después de crear la venta, antes de reclamar su primer movimiento.
      await prisma.shift.update({ where: { id: s.shift.id }, data: { status: 'CLOSED', endTime: new Date() } })
      shiftId = (await prisma.shift.create({ data: { venueId: s.venueId, staffId: s.staffId, status: 'OPEN', startTime: new Date() } })).id
      return real(tx, input)
    })
    const { exchange: e } = await createExchange(s.input(body(s)))
    const newOrder = await prisma.order.findUniqueOrThrow({ where: { id: e.newOrderId } })
    const payments = await prisma.payment.findMany({ where: { id: { in: [...e.refundPaymentIds, ...e.paymentIds] } }, take: 20 })
    expect(payments.map(p => p.shiftId)).toEqual(payments.map(() => shiftId))
    expect(newOrder.shiftId).toBe(shiftId)
    expect(Number((await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })).totalSales)).toBe(-100)
  })

  it('la bitácora ya existe si el proceso muere antes de todos los efectos; el replay no la duplica', async () => {
    const s = await seed()
    const input = s.input(body(s))
    const requestHash = operationHash({ venueId: s.venueId, ...input.body, idempotencyKey: undefined, isOfflineReplay: undefined })
    const outcome = await executeExchangeInTransaction({ ...input, requestHash, originalOrderId: s.order.id })
    expect('replay' in outcome).toBe(false)
    if ('replay' in outcome) throw new Error('No era un replay')
    const log = await prisma.activityLog.findMany({ where: { venueId: s.venueId, action: 'EXCHANGE_CREATED' }, take: 10 })
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({
      entityId: outcome.exchangeId,
      staffId: s.staffId,
      data: {
        differenceAmount: -100,
        deviceId: input.body.deviceId,
        isOfflineReplay: false,
      },
    })
    await createExchange(input)
    expect(await prisma.activityLog.count({ where: { venueId: s.venueId, action: 'EXCHANGE_CREATED' } })).toBe(1)
  })

  it('COLLECT conserva la caja elegida también cuando la recuperación pierde su ventana temporal', async () => {
    const s = await seed(600)
    const input = s.input(body(s, 600))
    const requestHash = operationHash({ venueId: s.venueId, ...input.body, idempotencyKey: undefined, isOfflineReplay: undefined })
    const outcome = await executeExchangeInTransaction({ ...input, requestHash, originalOrderId: s.order.id })
    if ('replay' in outcome) throw new Error('No era un replay')
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: outcome.response.paymentIds.at(-1)! } })
    await prisma.cashDrawerSession.update({
      where: { id: s.drawer.id },
      data: {
        status: 'CLOSED',
        closedAt: new Date(payment.createdAt.getTime() - 1),
        actualAmount: 100,
        overShort: 0,
      },
    })
    const s2 = await prisma.cashDrawerSession.create({
      data: {
        venueId: s.venueId,
        openedByStaffId: s.staffId,
        openedByName: 'S2',
        startingAmount: 200,
        openedAt: payment.createdAt,
      },
    })
    await reconciler(new Date(payment.createdAt.getTime() + 10 * 60000)).runNow()
    expect((await events(s)).filter(r => r.type === 'CASH_SALE').map(r => [r.sessionId, Number(r.amount)])).toEqual([[s.drawer.id, 100]])
    expect(await prisma.cashDrawerEvent.count({ where: { sessionId: s2.id } })).toBe(0)
    expect((await prisma.exchange.findUniqueOrThrow({ where: { id: outcome.exchangeId } })).cashDrawerSessionId).toBe(s.drawer.id)
  })

  it('guarda S1 y repone el PAYOUT allí tras la caída, aunque sólo S2 cubra la fecha; repetir no duplica', async () => {
    const s = await seed()
    const input = s.input(body(s))
    // Simula la muerte antes del efecto, sin borrar un movimiento que sí ocurrió.
    jest.mocked(postCashRefundToDrawer).mockResolvedValueOnce('FAILED')
    const { exchange: e } = await createExchange(input)
    expect(await events(s)).toEqual([])
    const refund = await prisma.payment.findUniqueOrThrow({ where: { id: e.refundPaymentIds[0] } })
    await prisma.cashDrawerSession.update({
      where: { id: s.drawer.id },
      data: {
        status: 'CLOSED',
        closedAt: new Date(refund.createdAt.getTime() - 1),
        actualAmount: 100,
        overShort: 0,
      },
    })
    const s2 = await prisma.cashDrawerSession.create({
      data: {
        venueId: s.venueId,
        openedByStaffId: s.staffId,
        openedByName: 'S2',
        startingAmount: 200,
        openedAt: refund.createdAt,
      },
    })
    const job = reconciler(new Date(refund.createdAt.getTime() + 10 * 60000))
    await job.runNow()
    await job.runNow()
    expect((await events(s)).map(r => [r.type, r.sessionId, Number(r.amount)])).toEqual([['PAY_OUT', s.drawer.id, 100]])
    expect((await events(s))[0]).toMatchObject({ staffId: s.staffId, orderId: s.order.id, note: 'Reembolso: Cambio de producto' })
    expect(await prisma.cashDrawerEvent.count({ where: { sessionId: s2.id } })).toBe(0)
    expect((await prisma.exchange.findUniqueOrThrow({ where: { id: e.id } })).cashDrawerSessionId).toBe(s.drawer.id)
    expect(Number((await prisma.cashDrawerSession.findUniqueOrThrow({ where: { id: s.drawer.id } })).overShort)).toBe(100)
    expect((await createExchange(input)).replay).toBe(true)
    expect(await events(s)).toHaveLength(1)
  })

  it.each([400, 600])('un solo instante a medianoche local: venta, porciones y cobros (%s)', async price => {
    const s = await seed(price)
    const at = fromZonedTime('2026-10-31T23:59:59.999', 'America/Mexico_City')
    const previous = new Date(at.getTime() - 864e5)
    await prisma.order.update({ where: { id: s.order.id }, data: { createdAt: previous } })
    await prisma.payment.updateMany({ where: { venueId: s.venueId }, data: { createdAt: previous } })
    transactionClock(at)
    const { exchange: e } = await createExchange(s.input(body(s, price)))
    jest.useRealTimers()
    jest.restoreAllMocks()
    const rows = await prisma.payment.findMany({ where: { id: { in: [...e.refundPaymentIds, ...e.paymentIds] } }, take: 20 })
    expect(rows.map(r => r.createdAt.toISOString())).toEqual(rows.map(() => at.toISOString()))
    expect((await prisma.order.findUniqueOrThrow({ where: { id: e.newOrderId } })).createdAt).toEqual(at)
    // El libro conserva el orden de las porciones sin sumar milisegundos al reloj.
    expect(
      rows
        .filter(r => r.type === 'REFUND')
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(r => r.id),
    ).toEqual(e.refundPaymentIds)
  })

  it('a medianoche del negocio todos los reportes registran sólo -$100 el mismo día, sin -$400 al siguiente', async () => {
    const s = await seed()
    await prisma.fiscalEmisor.create({
      data: {
        venueId: s.venueId,
        rfc: 'AAA010101AAA',
        legalName: 'Fiscal de prueba',
        regimenFiscal: '601',
        lugarExpedicion: '01000',
        includeCashInAccounting: true,
        includeOffTerminalSalesInGlobal: true,
      },
    })
    const tz = 'America/Mexico_City'
    const at = fromZonedTime('2026-10-31T23:59:59.999', tz)
    const previous = new Date(at.getTime() - 864e5)
    await prisma.order.update({ where: { id: s.order.id }, data: { createdAt: previous } })
    await prisma.payment.updateMany({ where: { venueId: s.venueId }, data: { createdAt: previous } })
    transactionClock(at)
    await createExchange(s.input(body(s)))
    jest.useRealTimers()
    jest.restoreAllMocks()
    for (const [day, delta] of [
      ['2026-10-31', -100],
      ['2026-11-01', 0],
    ] as const) {
      const from = fromZonedTime(`${day}T00:00:00.000`, tz),
        to = fromZonedTime(`${day}T23:59:59.999`, tz)
      const summary = await getSalesSummary(s.venueId, {
        startDate: from.toISOString(),
        endDate: to.toISOString(),
        groupBy: 'paymentMethod',
      })
      expect(summary.summary.netSales).toBe(delta)
      expect(summary.byPaymentMethodDetailed?.reduce((n, p) => n + p.amount, 0) ?? 0).toBe(delta)
      const metrics = await getBasicMetricsData(s.venueId, {
        fromDate: from.toISOString(),
        toDate: to.toISOString(),
        responseMode: 'aggregated-v1',
      })
      // Esta tarjeta histórica muestra cobros brutos (no resta ningún reembolso, tampoco los ordinarios).
      expect(metrics.summary.totalAmount).toBe(0)
      const transactions = await getTransactions(s.venueId, 1, 100, { dateFrom: from.toISOString(), dateTo: to.toISOString() })
      expect(transactions.data.reduce((sum, row) => sum + row.amount, 0)).toBe(delta)
      const methods = await aggregatePaymentsByMethod(
        s.venueId,
        { fromDate: from, toDate: to, includeRefunds: true, excludeCancelledOrders: false },
        'dinero',
      )
      expect(methods.reduce((n, p) => n + p.amount, 0)).toBe(delta)
      const banks = await getBankAndCashSummary(s.venueId, { from: day, to: day })
      expect(banks.totals.cashInflowCents).toBe(delta * 100)
      const income = await getIncomeStatement(s.venueId, { from: day, to: day })
      expect(income.revenue.netRevenueCents).toBe(delta * 100)
      expect(income.fiscalRevenue.netRevenueCents).toBe(delta * 100)
    }
    expect(Number((await prisma.shift.findUniqueOrThrow({ where: { id: s.shift.id } })).totalSales)).toBe(400)
    const cut = aggregateShiftPayments(await readShiftPaymentsForClose(s.venueId, s.shift.id, previous, at))
    expect(Number(cut.totalSales)).toBe(400)
    expect((await events(s)).map(r => [r.type, Number(r.amount)])).toEqual([['PAY_OUT', 100]])
  })

  it('la recuperación ordinaria por ventana y el PAYOUT inmediato siguen funcionando', async () => {
    const s = await seed()
    const e = (await createExchange(s.input(body(s)))).exchange
    expect((await events(s)).map(r => [r.type, r.sessionId, Number(r.amount)])).toEqual([['PAY_OUT', s.drawer.id, 100]])
    expect(await defaults.findUnpostedCashRefunds(new Date(0), new Date(Date.now() + 1000), 200)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: e.refundPaymentIds[0] })]),
    )
    const ordinary = await seed()
    const r = await issueRefund({
      venueId: ordinary.venueId,
      staffId: ordinary.staffId,
      paymentId: ordinary.payments[0].id,
      amount: 10000,
      reason: 'RETURNED_GOODS',
    })
    await prisma.cashDrawerEvent.deleteMany({ where: { venueId: ordinary.venueId } })
    const refund = await prisma.payment.findUniqueOrThrow({ where: { id: r.refundId } })
    await reconciler(new Date(refund.createdAt.getTime() + 10 * 60000)).runNow()
    expect((await events(ordinary)).map(r => [r.type, r.sessionId, Number(r.amount)])).toEqual([['PAY_OUT', ordinary.drawer.id, 100]])
  })
})
