/**
 * Integration tests: availableBalance aggregations in SQL (REAL PostgreSQL).
 *
 * 2026-09-01: getBalanceByCardType, getSettlementCalendar, projectHistoricalBalance
 * y las sumas de efectivo se agregaron en Postgres (incidente del event loop); sus
 * números se verificaron además con golden snapshots al centavo contra la base de
 * desarrollo. getAvailableBalance y getSettlementTimeline conservan su findMany
 * (cada pago pendiente pasa por el motor de liquidación vivo) con select
 * quirúrgico — aquí se ejercitan igual, para fijar que el select recortado no
 * rompió ni el filtro de tender ni la proyección.
 *
 * Semántica FIJADA a propósito (era así antes de la reescritura):
 *  · Un dateRange explícito REEMPLAZA el corte de caja en las sumas de efectivo
 *    (el spread del where original pisaba el `gt: lastCloseout`).
 *  · El calendario SÍ compone closeout + rango (sus tres condiciones convivían).
 *  · `COALESCE(netSettlementAmount, neto calculado)`: un 0 almacenado se respeta.
 *
 * Run with:
 *   TEST_DATABASE_URL='postgresql://…/av-db-25-test' \
 *     npx jest --selectProjects integration --testPathPattern availableBalance-sql-aggregation
 */

import {
  getAvailableBalance,
  getBalanceByCardType,
  getSettlementCalendar,
  getSettlementTimeline,
  projectHistoricalBalance,
} from '@/services/dashboard/availableBalance.dashboard.service'
import prisma from '@/utils/prismaClient'

const DAY = new Date('2025-03-11T18:00:00.000Z') // martes 12:00 local (America/Mexico_City)
const RANGO = { from: new Date('2025-03-09T00:00:00.000Z'), to: new Date('2025-03-15T23:59:59.999Z') }

const suffix = `ab-sql-${Date.now()}`
const round2 = (n: number): number => Math.round(n * 100) / 100

let orgId: string
let venueId: string
let providerId: string
let merchantId: string
let cashHoy: Date
let pagoReciente: Date

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `AB SQL Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
    select: { id: true },
  })
  orgId = org.id
  const venue = await prisma.venue.create({
    data: { organizationId: orgId, name: `ab-${suffix}`, slug: `ab-${suffix}`, timezone: 'America/Mexico_City' },
    select: { id: true },
  })
  venueId = venue.id

  const provider = await prisma.paymentProvider.create({
    data: { code: `PROV-${suffix}`, name: 'Proveedor Test', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
    select: { id: true },
  })
  providerId = provider.id
  const merchant = await prisma.merchantAccount.create({
    data: { providerId, externalMerchantId: `ext-${suffix}`, credentialsEncrypted: {} },
    select: { id: true },
  })
  merchantId = merchant.id

  await prisma.settlementConfiguration.create({
    data: {
      merchantAccountId: merchantId,
      cardType: 'CREDIT',
      settlementDays: 1,
      settlementDayType: 'BUSINESS_DAYS',
      cutoffTime: '23:00',
      cutoffTimezone: 'America/Mexico_City',
      effectiveFrom: new Date('2024-01-01T00:00:00.000Z'),
      effectiveTo: null,
    },
  })

  const order = await prisma.order.create({
    data: {
      venueId,
      orderNumber: `AB-${suffix}`,
      createdAt: DAY,
      subtotal: 500,
      taxAmount: 0,
      total: 500,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
    },
    select: { id: true },
  })

  const basePayment = {
    venueId,
    orderId: order.id,
    status: 'COMPLETED' as const,
    createdAt: DAY,
    feePercentage: 0,
    feeAmount: 0,
    netAmount: 0,
    // Payment.merchantAccountId (columna del PAGO, además de la del costo): es de
    // donde getAvailableBalance/getSettlementTimeline juntan los merchants cuyas
    // SettlementConfiguration cargan para proyectar en vivo.
    merchantAccountId: merchantId,
  }
  const cost = (paymentId: string, transactionType: 'CREDIT' | 'DEBIT', venueChargeAmount: number, venueFixedFee: number, amount: number) =>
    prisma.transactionCost.create({
      data: {
        paymentId,
        merchantAccountId: merchantId,
        transactionType,
        amount,
        providerRate: 0,
        providerCostAmount: 0,
        venueRate: 0,
        venueChargeAmount,
        venueFixedFee,
        grossProfit: 0,
        profitMargin: 0,
      },
    })

  // 1. CREDIT que ya aterrizó: PENDING con fecha pasada, net almacenado 105.
  const p1 = await prisma.payment.create({
    data: { ...basePayment, amount: 100, tipAmount: 10, method: 'CREDIT_CARD' },
    select: { id: true },
  })
  await cost(p1.id, 'CREDIT', 3, 2, 110)
  await prisma.venueTransaction.create({
    data: {
      venueId,
      paymentId: p1.id,
      type: 'PAYMENT',
      grossAmount: 110,
      feeAmount: 5,
      netAmount: 105,
      status: 'PENDING',
      estimatedSettlementDate: new Date('2025-03-12T18:00:00.000Z'),
      netSettlementAmount: 105,
    },
  })

  // 2. CREDIT pendiente a futuro, SIN net almacenado (cae al neto calculado 192).
  const p2 = await prisma.payment.create({
    data: { ...basePayment, amount: 200, tipAmount: 0, method: 'CREDIT_CARD' },
    select: { id: true },
  })
  await cost(p2.id, 'CREDIT', 8, 0, 200)
  await prisma.venueTransaction.create({
    data: {
      venueId,
      paymentId: p2.id,
      type: 'PAYMENT',
      grossAmount: 200,
      feeAmount: 8,
      netAmount: 192,
      status: 'PENDING',
      estimatedSettlementDate: new Date('2099-01-03T23:00:00.000Z'),
      netSettlementAmount: null,
    },
  })

  // 3. DEBIT liquidado EXPLÍCITO, sin fecha estimada (cuenta por status).
  const p3 = await prisma.payment.create({
    data: { ...basePayment, amount: 50, tipAmount: 0, method: 'DEBIT_CARD' },
    select: { id: true },
  })
  await cost(p3.id, 'DEBIT', 1, 0, 50)
  await prisma.venueTransaction.create({
    data: {
      venueId,
      paymentId: p3.id,
      type: 'PAYMENT',
      grossAmount: 50,
      feeAmount: 1,
      netAmount: 49,
      status: 'SETTLED',
      estimatedSettlementDate: null,
      netSettlementAmount: 49,
    },
  })

  // 4. CREDIT con costo pero SIN VenueTransaction → siempre pendiente al neto calculado (58).
  const p4 = await prisma.payment.create({
    data: { ...basePayment, amount: 60, tipAmount: 0, method: 'CREDIT_CARD' },
    select: { id: true },
  })
  await cost(p4.id, 'CREDIT', 2, 0, 60)

  // 5. Efectivo del rango histórico (entra con dateRange explícito, que anula el closeout).
  await prisma.payment.create({
    data: { ...basePayment, amount: 80, tipAmount: 5, method: 'CASH' },
  })

  // 6. Efectivo de HOY, un minuto en el futuro: sin closeouts, el corte implícito es
  //    venue.createdAt (creado hace un instante), y el `gt` es estricto — es el que
  //    ve el calendario.
  cashHoy = new Date(Date.now() + 60_000)
  await prisma.payment.create({
    data: { ...basePayment, amount: 30, tipAmount: 0, method: 'CASH', createdAt: cashHoy },
  })

  // 7. Pago con tarjeta de hace 2 días (para la proyección de 30 días).
  pagoReciente = new Date(cashHoy.getTime() - 2 * 24 * 60 * 60 * 1000)
  await prisma.payment.create({
    data: { ...basePayment, amount: 300, tipAmount: 0, method: 'CREDIT_CARD', createdAt: pagoReciente },
  })
})

afterAll(async () => {
  await prisma.transactionCost.deleteMany({ where: { payment: { venueId } } })
  await prisma.venueTransaction.deleteMany({ where: { venueId } })
  await prisma.settlementSimulation.deleteMany({ where: { venueId } })
  await prisma.payment.deleteMany({ where: { venueId } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.settlementConfiguration.deleteMany({ where: { merchantAccountId: merchantId } })
  await prisma.merchantAccount.deleteMany({ where: { id: merchantId } })
  await prisma.paymentProvider.deleteMany({ where: { id: providerId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

describe('getBalanceByCardType — agregado por tipo en Postgres', () => {
  it('suma base/propina/fees y separa settled de pending replicando hasSettlementLanded', async () => {
    const breakdown = await getBalanceByCardType(venueId, RANGO)

    const credit = breakdown.find(b => b.cardType === 'CREDIT')!
    expect(round2(credit.baseSales)).toBe(360) // 100 + 200 + 60
    expect(round2(credit.tips)).toBe(10)
    expect(round2(credit.totalSales)).toBe(370)
    expect(round2(credit.fees)).toBe(15) // (3+2) + 8 + 2
    expect(round2(credit.netAmount)).toBe(355)
    expect(credit.transactionCount).toBe(3)
    // Aterrizado por fecha pasada: usa el net ALMACENADO (105).
    expect(round2(credit.settledAmount)).toBe(105)
    // Futuro sin net almacenado (COALESCE → 192) + sin transaction (58).
    expect(round2(credit.pendingAmount)).toBe(250)
    // De la SettlementConfiguration activa, no de un promedio histórico.
    expect(credit.settlementDays).toBe(1)

    const debit = breakdown.find(b => b.cardType === 'DEBIT')!
    expect(round2(debit.settledAmount)).toBe(49) // SETTLED explícito sin fecha
    expect(round2(debit.pendingAmount)).toBe(0)
    expect(debit.settlementDays).toBeNull() // no hay config DEBIT

    const cash = breakdown.find(b => b.cardType === 'CASH')!
    expect(round2(cash.baseSales)).toBe(80) // el cash de HOY queda fuera del rango
    expect(round2(cash.tips)).toBe(5)
    expect(round2(cash.settledAmount)).toBe(85)
    expect(cash.transactionCount).toBe(1)
    expect(cash.settlementDays).toBe(0)
  })
})

describe('getSettlementCalendar — agrupado por fecha de liquidación en Postgres', () => {
  it('agrupa por día local de liquidación, respeta el closeout para el efectivo y separa por tipo', async () => {
    const to = new Date(cashHoy.getTime() + 24 * 60 * 60 * 1000)
    const calendar = await getSettlementCalendar(venueId, { from: new Date('2025-03-10T00:00:00.000Z'), to })

    // El CREDIT aterrizado (2025-03-12T18:00Z = 12-mar local); el DEBIT SETTLED sin
    // fecha estimada no entra al filtro (igual que siempre); el pendiente de 2099
    // queda fuera del rango.
    const dia12 = calendar.find(c => c.settlementDate.toISOString().startsWith('2025-03-12'))!
    expect(dia12).toBeDefined()
    expect(round2(dia12.totalNetAmount)).toBe(105)
    expect(dia12.transactionCount).toBe(1)
    expect(dia12.byCardType).toEqual([{ cardType: 'CREDIT', netAmount: 105, transactionCount: 1 }])
    expect(dia12.status).toBe('PENDING') // aterrizó por fecha, pero nadie lo confirmó

    // El efectivo del 2025 es ANTERIOR al closeout (venue.createdAt) → fuera; el de
    // HOY sí entra, como su propio día liquidado al instante.
    const cashDays = calendar.filter(c => c.byCardType.some(b => b.cardType === 'CASH'))
    expect(cashDays).toHaveLength(1)
    expect(round2(cashDays[0].totalNetAmount)).toBe(30)
    expect(cashDays[0].status).toBe('SETTLED')
  })
})

describe('getAvailableBalance / getSettlementTimeline — el select quirúrgico no cambió el motor', () => {
  it('getAvailableBalance proyecta lo pendiente con el motor vivo y suma el efectivo agregado', async () => {
    const summary = await getAvailableBalance(venueId, RANGO)

    // totalSales = tarjetas (110 + 200 + 50 + 60) + efectivo del rango (85)
    expect(round2(summary.totalSales)).toBe(505)
    expect(round2(summary.totalFees)).toBe(16) // 5 + 8 + 1 + 2
    // La config CREDIT (1 día hábil) hace aterrizar la proyección de #1 (105) y
    // también la de #2 (192 — su fecha almacenada decía 2099, el motor la recomputa
    // al 12-mar-2025); el DEBIT SETTLED aporta 49 y el efectivo 85.
    expect(round2(summary.availableNow)).toBe(431)
    // Solo #4 (sin VenueTransaction) queda pendiente, al neto calculado.
    expect(round2(summary.pendingSettlement)).toBe(58)
    expect(summary.uncostedCount).toBe(0)
  })

  it('getSettlementTimeline agrupa por día local × tipo con el recompute de siempre', async () => {
    const timeline = await getSettlementTimeline(venueId, RANGO)

    expect(timeline).toHaveLength(3) // 11-mar × {CREDIT, DEBIT, CASH}
    const credit = timeline.find(t => t.cardType === 'CREDIT')!
    expect(round2(credit.grossAmount)).toBe(370)
    expect(round2(credit.fees)).toBe(15)
    expect(round2(credit.netAmount)).toBe(355)
    expect(credit.transactionCount).toBe(3)

    const debit = timeline.find(t => t.cardType === 'DEBIT')!
    expect(debit.status).toBe('SETTLED')

    const cash = timeline.find(t => t.cardType === 'CASH')!
    expect(round2(cash.grossAmount)).toBe(85)
    expect(cash.estimatedSettlementDate).toBeNull()
  })
})

describe('projectHistoricalBalance — suma por día UTC en Postgres', () => {
  it('promedia sobre 30 días y proyecta los días con venta histórica', async () => {
    const projection = await projectHistoricalBalance(venueId, 7)

    // Últimos 30 días: el cash de hoy (30) + la tarjeta de hace 2 días (300).
    expect(round2(projection.projectedDailyRevenue)).toBe(11) // 330 / 30
    const totalProyectado = projection.projectedDailySettlements.reduce((s, d) => s + d.amount, 0)
    expect(round2(totalProyectado)).toBe(round2(300 * 0.965 + 30 * 0.965))
  })
})

// ===========================================================================
// Two merchants + a stored zero net. Fixture of its own (a second venue in the
// same org) so the numbers pinned above do not move.
// ===========================================================================
describe('getBalanceByCardType with two merchants and a stored netSettlementAmount of 0', () => {
  const DAY_PLUS_1H = new Date(DAY.getTime() + 60 * 60 * 1000)
  let venueBId: string
  let slowMerchantId: string
  let fastMerchantId: string

  beforeAll(async () => {
    const venue = await prisma.venue.create({
      data: { organizationId: orgId, name: `ab-2m-${suffix}`, slug: `ab-2m-${suffix}`, timezone: 'America/Mexico_City' },
      select: { id: true },
    })
    venueBId = venue.id

    const mkMerchant = (tag: string) =>
      prisma.merchantAccount.create({
        data: { providerId, externalMerchantId: `ext-${tag}-${suffix}`, credentialsEncrypted: {} },
        select: { id: true },
      })
    slowMerchantId = (await mkMerchant('slow')).id
    fastMerchantId = (await mkMerchant('fast')).id
    const creditConfig = (merchantAccountId: string, settlementDays: number) =>
      prisma.settlementConfiguration.create({
        data: {
          merchantAccountId,
          cardType: 'CREDIT',
          settlementDays,
          settlementDayType: 'BUSINESS_DAYS',
          cutoffTime: '23:00',
          cutoffTimezone: 'America/Mexico_City',
          effectiveFrom: new Date('2024-01-01T00:00:00.000Z'),
          effectiveTo: null,
        },
      })
    await creditConfig(slowMerchantId, 3)
    await creditConfig(fastMerchantId, 1)

    const order = await prisma.order.create({
      data: {
        venueId: venueBId,
        orderNumber: `AB2M-${suffix}`,
        createdAt: DAY,
        subtotal: 350,
        taxAmount: 0,
        total: 350,
        status: 'COMPLETED',
        paymentStatus: 'PAID',
      },
      select: { id: true },
    })
    const payment = (data: { amount: number; method: 'CREDIT_CARD' | 'DEBIT_CARD'; createdAt: Date; merchantAccountId: string }) =>
      prisma.payment.create({
        data: {
          venueId: venueBId,
          orderId: order.id,
          status: 'COMPLETED',
          tipAmount: 0,
          feePercentage: 0,
          feeAmount: 0,
          netAmount: 0,
          ...data,
        },
        select: { id: true },
      })
    const cost = (
      paymentId: string,
      merchantAccountId: string,
      transactionType: 'CREDIT' | 'DEBIT',
      venueChargeAmount: number,
      amount: number,
    ) =>
      prisma.transactionCost.create({
        data: {
          paymentId,
          merchantAccountId,
          transactionType,
          amount,
          providerRate: 0,
          providerCostAmount: 0,
          venueRate: 0,
          venueChargeAmount,
          venueFixedFee: 0,
          grossProfit: 0,
          profitMargin: 0,
        },
      })

    // 1. The NEWER credit payment — and its VenueTransaction — are inserted FIRST, so
    //    the physical row order favours the wrong merchant if the SQL ever loses its
    //    `ORDER BY p."createdAt"` (verified: without it, this fixture publishes 1).
    //    Fast merchant (1 business day), computed net 192, still pending by its stored
    //    date (2099) with no stored net.
    const newer = await payment({ amount: 200, method: 'CREDIT_CARD', createdAt: DAY_PLUS_1H, merchantAccountId: fastMerchantId })
    await cost(newer.id, fastMerchantId, 'CREDIT', 8, 200)
    await prisma.venueTransaction.create({
      data: {
        venueId: venueBId,
        paymentId: newer.id,
        type: 'PAYMENT',
        grossAmount: 200,
        feeAmount: 8,
        netAmount: 192,
        status: 'PENDING',
        estimatedSettlementDate: new Date('2099-01-03T23:00:00.000Z'),
        netSettlementAmount: null,
      },
    })

    // 2. The OLDER credit payment: slow merchant (3 business days), computed net 97,
    //    landed by date, and a STORED netSettlementAmount of 0 — the value COALESCE
    //    must keep instead of falling back to the computed 97.
    const older = await payment({ amount: 100, method: 'CREDIT_CARD', createdAt: DAY, merchantAccountId: slowMerchantId })
    await cost(older.id, slowMerchantId, 'CREDIT', 3, 100)
    await prisma.venueTransaction.create({
      data: {
        venueId: venueBId,
        paymentId: older.id,
        type: 'PAYMENT',
        grossAmount: 100,
        feeAmount: 3,
        netAmount: 97,
        status: 'PENDING',
        estimatedSettlementDate: new Date('2025-03-14T18:00:00.000Z'),
        netSettlementAmount: 0,
      },
    })

    // 3. A DEBIT payment SETTLED explicitly with a stored 0: exercises the Node branch
    //    `netSettlementAmount || netAmount` of getAvailableBalance, where a Decimal 0
    //    is truthy and therefore wins over the computed 49.
    const debit = await payment({ amount: 50, method: 'DEBIT_CARD', createdAt: DAY, merchantAccountId: fastMerchantId })
    await cost(debit.id, fastMerchantId, 'DEBIT', 1, 50)
    await prisma.venueTransaction.create({
      data: {
        venueId: venueBId,
        paymentId: debit.id,
        type: 'PAYMENT',
        grossAmount: 50,
        feeAmount: 1,
        netAmount: 49,
        status: 'SETTLED',
        estimatedSettlementDate: null,
        netSettlementAmount: 0,
      },
    })
  })

  afterAll(async () => {
    await prisma.transactionCost.deleteMany({ where: { payment: { venueId: venueBId } } })
    await prisma.venueTransaction.deleteMany({ where: { venueId: venueBId } })
    await prisma.payment.deleteMany({ where: { venueId: venueBId } })
    await prisma.order.deleteMany({ where: { venueId: venueBId } })
    await prisma.settlementConfiguration.deleteMany({ where: { merchantAccountId: { in: [slowMerchantId, fastMerchantId] } } })
    await prisma.merchantAccount.deleteMany({ where: { id: { in: [slowMerchantId, fastMerchantId] } } })
    await prisma.venue.deleteMany({ where: { id: venueBId } })
  })

  it('publishes the settlementDays of the merchant on the OLDEST payment, not of the first row inserted', async () => {
    const breakdown = await getBalanceByCardType(venueBId, RANGO)
    const credit = breakdown.find(b => b.cardType === 'CREDIT')!

    expect(credit.transactionCount).toBe(2)
    // Slow merchant = 3 business days. The fast merchant (1 day) owns the newer
    // payment, which was inserted first: reading "whichever row comes first" would
    // publish 1.
    expect(credit.settlementDays).toBe(3)
  })

  it('keeps a stored netSettlementAmount of 0 instead of falling back to the computed net (SQL COALESCE)', async () => {
    const breakdown = await getBalanceByCardType(venueBId, RANGO)
    const credit = breakdown.find(b => b.cardType === 'CREDIT')!

    expect(round2(credit.baseSales)).toBe(300)
    expect(round2(credit.fees)).toBe(11) // 8 + 3
    expect(round2(credit.netAmount)).toBe(289)
    // The older payment landed (2025-03-14 is in the past) with a stored 0: a NULL
    // would fall back to 97, a 0 must stay 0.
    expect(round2(credit.settledAmount)).toBe(0)
    // The newer payment is still pending (2099) with a NULL stored net: COALESCE falls
    // back to its computed 192. NULL falls back, 0 does not — that is the contract.
    expect(round2(credit.pendingAmount)).toBe(192)

    const debit = breakdown.find(b => b.cardType === 'DEBIT')!
    expect(round2(debit.settledAmount)).toBe(0) // SETTLED with a stored 0, not the computed 49
    expect(round2(debit.pendingAmount)).toBe(0)
    expect(debit.settlementDays).toBeNull() // the fast merchant has no DEBIT rule
  })

  it('getAvailableBalance keeps the stored 0 on a SETTLED transaction (a Decimal 0 is truthy in the `||` fallback)', async () => {
    const summary = await getAvailableBalance(venueBId, RANGO)

    expect(round2(summary.totalSales)).toBe(350) // 200 + 100 + 50
    expect(round2(summary.totalFees)).toBe(12) // 8 + 3 + 1
    expect(summary.uncostedCount).toBe(0)
    // availableNow = older credit (PENDING → recomputed by the live engine: 3 business
    // days from Tue 11-mar-2025 = Fri 14-mar, landed, net 97) + newer credit (PENDING
    // → the engine ignores the stored 2099 date: 1 business day = Wed 12-mar-2025,
    // landed, net 192) + DEBIT SETTLED with a stored 0 (0, not 49). A falsy-zero
    // fallback would publish 338.
    expect(round2(summary.availableNow)).toBe(289)
    expect(round2(summary.pendingSettlement)).toBe(0)
  })
})
