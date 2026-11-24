/**
 * Carril F2 · comparar con otro periodo (hz:fefa11b6:D7, REAL PostgreSQL). Plan v5:
 * `docs/audit/2026-11-21-resumen-de-ventas/comparar/promesa.md` (workspace).
 *
 * - El periodo comparado se mide con la MISMA regla que el reporte: su cabecera es la de pedir ese rango directo, también con todos los
 *   desgloses encendidos (la cabecera no depende de ellos).
 * - «Hasta la misma hora»: con hoy a la mitad (2:00 p. m.), ayer se corta a las 2:00 p. m. y el actual también.
 * - Declarado (borde a): una cuenta abierta antes de la hora y cobrada después cuenta como venta del comparado (regla de venta de hoy:
 *   fecha de apertura + ya cobrada), aunque su cobro, de después de la hora, no cuente en cobros ni propinas.
 *
 *   npx jest --selectProjects integration --testPathPattern sales-summary-comparar   (por avq-verify: corre en la nube)
 */
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasFeatureAccess: jest.fn().mockResolvedValue(true),
}))

import prisma from '@/utils/prismaClient'
import { getSalesSummary } from '@/services/dashboard/sales-summary.dashboard.service'
import { leerConComparacion } from '@/services/dashboard/salesSummaryComparar'

jest.setTimeout(60000)

const TZ = 'America/Mexico_City'
// mar 10-jun-2025 (hoy) a las 2:00 p. m. de la Ciudad de México (UTC−6).
const T = new Date('2025-06-10T20:00:00.000Z')
const HOY = { startDate: '2025-06-10T06:00:00.000Z', endDate: '2025-06-11T05:59:59.999Z' }
const AYER = { startDate: '2025-06-09T06:00:00.000Z', endDate: '2025-06-10T05:59:59.999Z' }
const local = (dia: string, hora: string) => new Date(`${dia}T${hora}:00.000-06:00`)
const suffix = `comparar-${Date.now()}`
const cents = (n: number | null | undefined) => (n == null ? n : Math.round(n * 100))

let orgId: string
let venueId: string
let seq = 0

/** Una cuenta abierta a `abierta`, con su cobro a `cobrada` (sin cobro = sigue abierta). */
async function cuenta(total: number, abierta: Date, cobrada: Date | null, metodo: 'CASH' | 'CREDIT_CARD' = 'CASH') {
  seq += 1
  const order = await prisma.order.create({
    data: {
      venueId,
      orderNumber: `CMP-${seq}-${suffix}`,
      createdAt: abierta,
      contratoDePrecio: 'IVA_INCLUIDO',
      subtotal: total,
      taxAmount: 0,
      discountAmount: 0,
      tipAmount: 0,
      total,
      remainingBalance: cobrada ? 0 : total,
      status: cobrada ? 'COMPLETED' : 'CONFIRMED',
      paymentStatus: cobrada ? 'PAID' : 'PENDING',
    },
    select: { id: true },
  })
  if (cobrada)
    await prisma.payment.create({
      data: {
        venueId,
        orderId: order.id,
        amount: total,
        tipAmount: 10,
        method: metodo,
        status: 'COMPLETED',
        type: 'REGULAR',
        feePercentage: 0,
        feeAmount: 0,
        netAmount: total,
        createdAt: cobrada,
      },
    })
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Comparar Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  venueId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `cmp-${suffix}`, slug: `cmp-${suffix}`, timezone: TZ },
      select: { id: true },
    })
  ).id
  // Ayer (el comparado): $100 a las 10:00 (entra), $200 a las 3:00 p. m. (después de la hora: no entra) y una mesa de $300 abierta
  // a la 1:00 p. m. y cobrada a las 4:00 p. m. (borde declarado: cuenta como venta del comparado).
  await cuenta(100, local('2025-06-09', '10:00'), local('2025-06-09', '10:05'))
  await cuenta(200, local('2025-06-09', '15:00'), local('2025-06-09', '15:05'))
  await cuenta(300, local('2025-06-09', '13:00'), local('2025-06-09', '16:00'))
  // Hoy: $150 a las 9:00 (con tarjeta), una mesa de $80 abierta a la 1:00 p. m. sin cobrar y $70 en efectivo a las 3:00 p. m.
  // (después de la hora: el lado actual tampoco la trae).
  await cuenta(150, local('2025-06-10', '09:00'), local('2025-06-10', '09:05'), 'CREDIT_CARD')
  await cuenta(80, local('2025-06-10', '13:00'), null)
  await cuenta(70, local('2025-06-10', '15:00'), local('2025-06-10', '15:05'))
  // Antier: $500 (para el periodo cerrado).
  await cuenta(500, local('2025-06-08', '12:00'), local('2025-06-08', '12:05'))
})

afterAll(async () => {
  if (venueId) {
    await prisma.payment.deleteMany({ where: { venueId } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
  }
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

const filtros = (extra: Record<string, unknown> = {}) => ({
  ...HOY,
  timezone: TZ,
  groupBy: 'paymentMethod' as const,
  reportType: 'summary' as const,
  includePrepaid: true,
  ...extra,
})

describe('F2 · hoy a la mitad contra ayer hasta la misma hora', () => {
  it('🔴 los dos lados se cortan a las 2:00 p. m.; el de ayer sin la venta de las 3:00 p. m.', async () => {
    const r = await leerConComparacion(venueId, filtros(), 'previous_period', T)
    expect(r.comparison).toMatchObject({
      status: 'ok',
      untilSameTime: true,
      baseRange: { startDate: HOY.startDate, endDate: T.toISOString() },
      dateRange: { startDate: AYER.startDate, endDate: '2025-06-09T20:00:00.000Z' },
    })
    // Hoy hasta las 2:00 p. m.: $150 de venta y la mesa de $80 en «Sin cobrar»; los $70 de las 3:00 p. m. no entran…
    expect(cents(r.summary.grossSales)).toBe(15000)
    // …aunque el día completo sí los trae.
    const diaCompleto = await getSalesSummary(venueId, filtros())
    expect(cents(diaCompleto.summary.grossSales)).toBe(22000)
    expect(cents(r.summary.unpaidSales)).toBe(8000)
    // Ayer hasta las 2:00 p. m.: $100 y la mesa de $300 (abierta antes, cobrada después: borde declarado).
    expect(cents(r.comparison.summary!.grossSales)).toBe(40000)
    // …pero su cobro de las 4:00 p. m. no cuenta en cobros ni propinas del comparado (también declarado).
    expect(r.comparison.summary!.transactionCount).toBe(1)
    expect(cents(r.comparison.summary!.tips)).toBe(1000)
    expect(r.comparison.changes!.grossSales).toEqual({ difference: -250, percent: -62.5, isNew: false })
    expect(r.comparison.changes!.unpaidSales).toEqual({ difference: 80, percent: null, isNew: true })
  })

  it('🔴 la cabecera del comparado es la de pedir ese rango directo, con o sin desgloses', async () => {
    const r = await leerConComparacion(venueId, filtros(), 'previous_period', T)
    const rango = r.comparison.dateRange!
    const directo = await getSalesSummary(venueId, { ...rango, timezone: TZ, includePrepaid: true })
    const conTodo = await getSalesSummary(venueId, {
      ...rango,
      timezone: TZ,
      includePrepaid: true,
      groupBy: 'paymentMethod',
      reportType: 'days',
      includeMerchantBreakdown: true,
      includeSettlementProjection: true,
      includeChannelBreakdown: true,
    })
    expect(r.comparison.summary).toEqual(directo.summary)
    expect(r.comparison.summary).toEqual(conTodo.summary)
  })

  it('con un filtro de método, los dos lados son vista de movimientos', async () => {
    const r = await leerConComparacion(venueId, filtros({ paymentMethod: 'CASH' }), 'previous_period', T)
    expect(r.filtered).toBe(true)
    expect(r.comparison.summary!.grossSales).toBeNull()
    expect(r.comparison.changes!.grossSales).toBeNull()
    // Hoy no hubo efectivo cobrado antes de las 2:00 p. m. (el de las 3:00 p. m. no entra); ayer hasta las 2:00 p. m., $100 + $10 de propina.
    expect(cents(r.summary.chargedAmount)).toBe(0)
    expect(cents(r.comparison.summary!.chargedAmount)).toBe(11000)
    expect(r.comparison.changes!.chargedAmount).toEqual({ difference: -110, percent: -100, isNew: false })
  })
})

describe('F2 · un periodo cerrado no se corta', () => {
  it('ayer completo contra antier completo', async () => {
    const r = await leerConComparacion(venueId, filtros(AYER), 'previous_period', T)
    expect(r.comparison).toMatchObject({
      untilSameTime: false,
      dateRange: { startDate: '2025-06-08T06:00:00.000Z', endDate: '2025-06-09T05:59:59.999Z' },
    })
    expect(cents(r.summary.grossSales)).toBe(60000) // $100 + $200 + $300
    expect(cents(r.comparison.summary!.grossSales)).toBe(50000)
    expect(r.comparison.changes!.grossSales).toEqual({ difference: 100, percent: 20, isNew: false })
  })
})
