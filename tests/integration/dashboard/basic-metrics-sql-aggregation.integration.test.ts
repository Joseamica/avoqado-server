/**
 * Integration test: basic-metrics (el home del dashboard) agrega en SQL (REAL PostgreSQL).
 *
 * 2026-09-01: el query-guard cazó a `GET /venues/:id/basic-metrics` materializando
 * 24,631 pagos de Testarudo con el rango «este año» — la PRIMERA llamada del home —
 * para que el navegador los sumara. Ahora Postgres suma (`summary`, `paymentMethodsData`,
 * `reviewStats`, `performanceByWeekday`) y las listas `payments`/`reviews` quedan
 * acotadas y declaradas.
 *
 * Qué fija este archivo:
 *  · Los números al centavo con las reglas de siempre: COMPLETED, sin REFUND, sin
 *    órdenes CANCELLED, un FAILED fuera.
 *  · La PARIDAD con la aritmética que hacía el navegador (useDashboardData): el summary
 *    en SQL da EXACTAMENTE lo que daba sumar las filas — incluido el promedio de
 *    porcentaje de propina, que es promedio de porcentajes por pago, no Σtips/Σamount.
 *  · Que acotar las listas NO acota los totales: con tope 2, `payments` trae 2 y
 *    `summary` sigue sumando los 3, con `meta.paymentsTruncated = true`.
 *
 * Run with:
 *   TEST_DATABASE_URL='postgresql://…/av-db-25-test' \
 *     npx jest --selectProjects integration --testPathPattern basic-metrics-sql-aggregation
 */

import { Prisma } from '@prisma/client'

import { getBasicMetricsData } from '@/services/dashboard/generalStats.dashboard.service'
import prisma from '@/utils/prismaClient'

/** Semilla de un pago: sólo lo que `orden()` NO pone por ti (amount y method son obligatorios). */
type PagoSemilla = Omit<
  Prisma.PaymentUncheckedCreateWithoutOrderInput,
  'venueId' | 'createdAt' | 'feePercentage' | 'feeAmount' | 'netAmount'
>

const DAY = new Date('2025-03-11T18:00:00.000Z')
const FILTERS = { fromDate: '2025-03-09T00:00:00.000Z', toDate: '2025-03-12T23:59:59.999Z' }
const suffix = `bm-sql-${Date.now()}`
const round2 = (n: number): number => Math.round(n * 100) / 100

let orgId: string
let venueId: string

/** La aritmética del navegador (useDashboardData.ts), reproducida tal cual. */
function resumenComoElNavegador(payments: Array<{ amount: number; tips: Array<{ amount: number }> }>) {
  const totalAmount = payments.reduce((s, p) => s + Number(p.amount), 0)
  const conPropina = payments.filter(p => p.tips && p.tips.length > 0)
  const totalTips = conPropina.reduce((s, p) => s + p.tips.reduce((t, tip) => t + Number(tip.amount), 0), 0)
  const pcts = conPropina.map(p => {
    const monto = Number(p.amount)
    const tips = p.tips.reduce((t, tip) => t + Number(tip.amount), 0)
    return monto > 0 ? (tips / monto) * 100 : 0
  })
  const avgTipPercentage = pcts.length ? pcts.reduce((s, x) => s + x, 0) / pcts.length : 0
  return { totalAmount, totalTransactions: payments.length, totalTips, avgTipPercentage }
}

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `BasicMetrics SQL Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
    select: { id: true },
  })
  orgId = org.id
  const venue = await prisma.venue.create({
    data: { organizationId: orgId, name: `bm-${suffix}`, slug: `bm-${suffix}`, timezone: 'America/Mexico_City' },
    select: { id: true },
  })
  venueId = venue.id

  const orden = (n: string, status: 'COMPLETED' | 'CANCELLED', pagos: PagoSemilla[]) =>
    prisma.order.create({
      data: {
        venueId,
        orderNumber: `${n}-${suffix}`,
        createdAt: DAY,
        type: 'DINE_IN',
        subtotal: 0,
        discountAmount: 0,
        taxAmount: 0,
        tipAmount: 0,
        total: 0,
        status,
        paymentStatus: 'PAID',
        payments: { create: pagos.map(p => ({ venueId, createdAt: DAY, feePercentage: 0, feeAmount: 0, netAmount: 0, ...p })) },
      },
    })

  // Cuentan: efectivo 100 + propina 10 · débito 200 sin propina · wallet 50 + propina 5.
  await orden('A', 'COMPLETED', [{ amount: 100, tipAmount: 10, method: 'CASH', status: 'COMPLETED' }])
  await orden('B', 'COMPLETED', [{ amount: 200, tipAmount: 0, method: 'DEBIT_CARD', status: 'COMPLETED' }])
  await orden('C', 'COMPLETED', [{ amount: 50, tipAmount: 5, method: 'DIGITAL_WALLET', status: 'COMPLETED' }])
  // NO cuentan: una devolución (type REFUND, aunque COMPLETED), un FAILED, y un pago de orden CANCELLED.
  await orden('D', 'COMPLETED', [{ amount: -30, tipAmount: 0, method: 'CASH', status: 'COMPLETED', type: 'REFUND' }])
  await orden('E', 'COMPLETED', [{ amount: 999, tipAmount: 0, method: 'CASH', status: 'FAILED' }])
  await orden('F', 'CANCELLED', [{ amount: 777, tipAmount: 70, method: 'CREDIT_CARD', status: 'COMPLETED' }])

  await prisma.review.createMany({
    data: [5, 5, 4].map((stars, i) => ({ venueId, overallRating: stars, createdAt: new Date(DAY.getTime() + i * 1000) })),
  })
})

afterAll(async () => {
  await prisma.payment.deleteMany({ where: { venueId } })
  await prisma.review.deleteMany({ where: { venueId } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.venue.delete({ where: { id: venueId } })
  await prisma.organization.delete({ where: { id: orgId } })
  await prisma.$disconnect()
})

describe('basic-metrics — Postgres suma lo que antes sumaba el navegador', () => {
  it('summary: 350 en 3 pagos, 15 de propina, y el promedio de porcentajes (10 + 0 + 10) / 3', async () => {
    const res = await getBasicMetricsData(venueId, FILTERS)

    expect(res.summary).toEqual({
      totalAmount: 350,
      totalTransactions: 3,
      totalTips: 15,
      avgTipPercentage: expect.closeTo((10 + 0 + 10) / 3, 6),
    })
  })

  it('paymentMethodsData: Efectivo 100 · Tarjeta 200 · Otro 50 — la devolución y la cancelada no entran', async () => {
    const res = await getBasicMetricsData(venueId, FILTERS)

    const porMetodo = Object.fromEntries(res.paymentMethodsData.map(m => [m.method, m.total]))
    expect(porMetodo).toEqual({ Efectivo: 100, Tarjeta: 200, Otro: 50 })
  })

  it('reviewStats: 3 reseñas, 2 de cinco estrellas', async () => {
    const res = await getBasicMetricsData(venueId, FILTERS)

    expect(res.reviewStats).toEqual({ total: 3, fiveStar: 2 })
  })

  it('aggregated-v1 no materializa filas y la gráfica conserva todo el martes', async () => {
    const res = await getBasicMetricsData(venueId, { ...FILTERS, responseMode: 'aggregated-v1' })

    expect(res.payments).toEqual([])
    expect(res.reviews).toEqual([])
    // JS Date 2025-03-11 es martes; el arreglo usa domingo=0, igual que Home.
    expect(res.performanceByWeekday).toEqual([0, 0, 350, 0, 0, 0, 0])
    expect(res.summary.totalTransactions).toBe(3)
  })

  it('PARIDAD: el summary en SQL es idéntico a la aritmética del navegador sobre las filas', async () => {
    const res = await getBasicMetricsData(venueId, FILTERS)

    const delNavegador = resumenComoElNavegador(res.payments)
    expect(res.summary.totalAmount).toBe(round2(delNavegador.totalAmount))
    expect(res.summary.totalTransactions).toBe(delNavegador.totalTransactions)
    expect(res.summary.totalTips).toBe(round2(delNavegador.totalTips))
    expect(res.summary.avgTipPercentage).toBeCloseTo(delNavegador.avgTipPercentage, 6)
    expect(res.meta.paymentsTruncated).toBe(false)
  })

  it('acotar las listas NO acota los totales: con tope 2, payments trae 2 y summary sigue en 350', async () => {
    const anterior = process.env.BASIC_METRICS_ROWS_CAP
    process.env.BASIC_METRICS_ROWS_CAP = '2'
    try {
      const res = await getBasicMetricsData(venueId, FILTERS)

      expect(res.payments).toHaveLength(2)
      expect(res.summary.totalAmount).toBe(350)
      expect(res.summary.totalTransactions).toBe(3)
      expect(res.meta).toEqual({ paymentsTruncated: true, paymentsTotal: 3, reviewsTruncated: true, reviewsTotal: 3 })
    } finally {
      if (anterior === undefined) delete process.env.BASIC_METRICS_ROWS_CAP
      else process.env.BASIC_METRICS_ROWS_CAP = anterior
    }
  })

  it('un rango sin pagos devuelve ceros, no null', async () => {
    const res = await getBasicMetricsData(venueId, { fromDate: '2020-01-01T00:00:00.000Z', toDate: '2020-01-02T00:00:00.000Z' })

    expect(res.summary).toEqual({ totalAmount: 0, totalTransactions: 0, totalTips: 0, avgTipPercentage: 0 })
    expect(res.paymentMethodsData).toEqual([])
    expect(res.reviewStats).toEqual({ total: 0, fiveStar: 0 })
  })
})
