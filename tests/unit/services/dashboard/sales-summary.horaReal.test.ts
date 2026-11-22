/**
 * D93 (encargo 18cc7f, founder 16-nov «B», como Square): el Resumen de ventas lee órdenes y cobros por su hora REAL (la del aparato si
 * se hicieron sin internet; si no, la llegada), en las cifras de arriba Y en las barras, para que sigan sumando lo mismo. Las comisiones
 * del personal siguen con su propia fecha. La prueba con Postgres de verdad es `tests/integration/dashboard/sales-summary-hora-real`.
 */
import { getSalesSummary } from '@/services/dashboard/sales-summary.dashboard.service'
import { prismaMock } from '@tests/__helpers__/setup'

const TZ = 'America/Mexico_City'
const FROM = '2026-11-11T06:00:00.000Z'
const TO = '2026-11-13T05:59:59.999Z'
const DIA_12 = new Date('2026-11-12T06:00:00.000Z') // medianoche del 12 en CDMX

/** El mock global no trae todos los modelos: crea el que falte. */
function m(modelo: string, metodo: string, valor: unknown) {
  const p = prismaMock as any
  p[modelo] = p[modelo] ?? {}
  p[modelo][metodo] = p[modelo][metodo] ?? jest.fn()
  p[modelo][metodo].mockResolvedValue(valor)
}

function sinMovimientos() {
  ;(prismaMock as any).$queryRawUnsafe = jest.fn().mockResolvedValue([])
  ;(prismaMock as any).$queryRaw = jest.fn().mockResolvedValue([])
  m('payment', 'aggregate', { _sum: { amount: null, tipAmount: null }, _count: 0 })
  m('order', 'aggregate', { _sum: { remainingBalance: null }, _count: 0 })
  m('orderPromotion', 'aggregate', { _sum: { discountCents: null } })
  m('orderItem', 'aggregate', { _sum: { discountAmount: null } })
  m('commissionCalculation', 'aggregate', { _sum: { netCommission: 10 } })
  m('payment', 'count', 0)
  m('payment', 'groupBy', [])
  m('giftCard', 'findFirst', null)
}

describe('getSalesSummary — la hora real de lo vendido sin internet (D93)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    sinMovimientos()
  })

  it('las cifras de arriba filtran órdenes y cobros por la hora real (el where envuelto en AND)', async () => {
    // Vista de movimientos (filtro de método): las propinas siguen en Prisma con el where envuelto en AND.
    await getSalesSummary('venue-1', { startDate: FROM, endDate: TO, timezone: TZ, paymentMethod: 'CASH' })
    const propinas = (prismaMock as any).payment.aggregate.mock.calls
      .map((c: unknown[]) => c[0] as any)
      .find((a: any) => a._sum?.tipAmount && !a._count)
    expect(propinas.where.AND[1].OR[0]).toEqual({ clientCreatedAt: { gte: new Date(FROM), lte: new Date(TO) } })
    expect(propinas.where.AND[1].OR[1]).toEqual({ clientCreatedAt: null, createdAt: { gte: new Date(FROM), lte: new Date(TO) } })
    // Vista de ventas (carril B, 21-nov): propinas y transacciones salen de SQL (sin los abonos de cuentas abiertas), por la hora real.
    jest.clearAllMocks()
    sinMovimientos()
    await getSalesSummary('venue-1', { startDate: FROM, endDate: TO, timezone: TZ })
    const cobros = (prismaMock as any).$queryRawUnsafe.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .find((sql: string) => sql.includes('AS tips'))
    expect(cobros).toContain('COALESCE(p."clientCreatedAt", p."createdAt")')
    // Las ventas brutas (SQL) también: COALESCE de la hora del aparato y la llegada.
    const brutas = (prismaMock as any).$queryRawUnsafe.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .find((sql: string) => sql.includes('AS subtotal'))
    expect(brutas).toContain('COALESCE("Order"."clientCreatedAt", "Order"."createdAt")')
  })

  it('regresión: las comisiones del personal siguen filtrando por su createdAt (no tienen hora del aparato)', async () => {
    await getSalesSummary('venue-1', { startDate: FROM, endDate: TO, timezone: TZ })
    const where = ((prismaMock as any).commissionCalculation.aggregate.mock.calls[0][0] as any).where
    expect(where.createdAt).toEqual({ gte: new Date(FROM), lte: new Date(TO) })
    expect(where).not.toHaveProperty('AND')
  })

  it('las barras agrupan órdenes y cobros por la hora real; las comisiones, por la suya', async () => {
    await getSalesSummary('venue-1', { startDate: FROM, endDate: TO, timezone: TZ, reportType: 'days' })
    const sqls = (prismaMock as any).$queryRawUnsafe.mock.calls.map((c: unknown[]) => String(c[0]))
    const cobros = sqls.find((sql: string) => sql.includes('payment_amount'))!
    expect(cobros).toContain(`DATE_TRUNC('day', ((COALESCE("clientCreatedAt", "createdAt") AT TIME ZONE 'UTC')`)
    expect(cobros).toContain(`COALESCE("clientCreatedAt", "createdAt") >= $2::timestamp`)
    const comisiones = sqls.find((sql: string) => sql.includes('staff_commissions'))!
    expect(comisiones).not.toContain('clientCreatedAt')
    const plataforma = sqls.find((sql: string) => sql.includes('platform_fees'))!
    expect(plataforma).toContain('COALESCE(p."clientCreatedAt", p."createdAt")')
    expect(plataforma).not.toMatch(/[^.]"clientCreatedAt"/)
  })

  it('Codex D93 r1 #1: un periodo con SÓLO comisión del personal sigue saliendo en las barras (suman la cabecera)', async () => {
    ;(prismaMock as any).$queryRawUnsafe.mockImplementation(async (sql: string) =>
      String(sql).includes('staff_commissions') ? [{ period: DIA_12, staff_commissions: 10 }] : [],
    )
    const r = await getSalesSummary('venue-1', { startDate: FROM, endDate: TO, timezone: TZ, reportType: 'days' })
    expect(r.byPeriod?.length).toBe(1)
    expect(r.byPeriod?.[0].metrics.staffCommissions).toBe(10)
  })
})
