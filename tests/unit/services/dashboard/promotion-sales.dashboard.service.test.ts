/**
 * Reporte de promociones — el combo como renglón.
 *
 * Cubre las tres cosas que, si se rompen, dan un número EQUIVOCADO sin avisar:
 *
 *  1. **Dinero.** Los importes vienen de Postgres como Decimal/BigInt según la
 *     expresión; sumarlos como strings da concatenación y "1020" donde había
 *     $30. Los totales tienen que cuadrar al centavo con los renglones.
 *
 *  2. **Fan-out del JOIN.** Una promoción tiene N líneas, así que el LEFT JOIN a
 *     `OrderItem` multiplica filas: contar con `COUNT(*)` reportaría un combo de
 *     3 productos como 3 ventas. Tiene que ser `COUNT(DISTINCT op.id)`.
 *
 *  3. **Zona horaria.** Una fecha `YYYY-MM-DD` pelada se resuelve a medianoche
 *     del reloj del HOST (prod corre en UTC), no del negocio: el rango se recorre
 *     un día entero y el reporte del lunes trae ventas del domingo. Bug real y
 *     vivo en producción en junio-2026.
 *
 * Y dos invariantes de identidad: el nombre sale del SNAPSHOT (renombrar la
 * promoción no puede reescribir el pasado) y los filtros de orden son
 * literalmente los de `sales-by-item`, o los dos reportes dejan de reconciliar.
 */

import * as fs from 'fs'
import * as path from 'path'

import { getPromotionSales } from '@/services/dashboard/promotion-sales.dashboard.service'
import { prismaMock } from '@tests/__helpers__/setup'

const SERVICE_FILE = path.join(__dirname, '../../../../src/services/dashboard/promotion-sales.dashboard.service.ts')
const source = fs.readFileSync(SERVICE_FILE, 'utf8')

/** Sin comentarios: los docstrings NOMBRAN a propósito lo que el código no debe hacer. */
const stripComments = (code: string) =>
  code
    .split('\n')
    .filter(l => {
      const t = l.trim()
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
    })
    .join('\n')

const codeOnly = stripComments(source)

/** Un Decimal de Prisma: objeto con toNumber(), NO un number. */
const decimal = (n: number) => ({ toNumber: () => n, toString: () => String(n) })

const VENUE = 'venue-1'
const TZ = 'America/Mexico_City'

beforeEach(() => {
  prismaMock.$queryRawUnsafe = jest.fn().mockResolvedValue([])
})

// ============================================================
// 1. NUEVO: el dinero
// ============================================================

describe('getPromotionSales — dinero', () => {
  it('convierte los Decimal de Postgres y los totales cuadran al centavo con los renglones', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([
      {
        promotion_id: 'promo-1',
        promotion_name: 'Combo Café + 2 Medialunas',
        promotion_type: 'BUNDLE',
        pricing_mode: 'FIXED_TOTAL',
        times_sold: 4,
        needs_review: 0,
        gross_sales: decimal(420.5),
        discounts: decimal(70.25),
        net_sales: decimal(350.25),
      },
      {
        promotion_id: 'promo-2',
        promotion_name: '2x1 Refrescos',
        promotion_type: 'COMBO',
        pricing_mode: 'PER_UNIT',
        times_sold: 3,
        needs_review: 1,
        gross_sales: decimal(180),
        discounts: decimal(90),
        net_sales: decimal(90),
      },
    ])

    const report = await getPromotionSales(VENUE, {
      startDate: '2026-08-01T06:00:00.000Z',
      endDate: '2026-08-18T05:59:59.999Z',
      timezone: TZ,
    })

    expect(report.promotions[0]).toMatchObject({
      promotionId: 'promo-1',
      name: 'Combo Café + 2 Medialunas',
      type: 'BUNDLE',
      pricingMode: 'FIXED_TOTAL',
      timesSold: 4,
      grossSales: 420.5,
      discounts: 70.25,
      netSales: 350.25,
      needsReview: 0,
    })

    expect(report.totals).toEqual({
      promotionsCount: 2,
      timesSold: 7,
      grossSales: 600.5,
      discounts: 160.25,
      netSales: 440.25,
      needsReview: 1,
    })
    // Sumar strings daría "420.5180"; sumar números da 600.5. El tipo importa.
    expect(typeof report.totals.grossSales).toBe('number')
    // La identidad que el reporte promete: neto = bruto − descuento.
    expect(report.totals.netSales).toBeCloseTo(report.totals.grossSales - report.totals.discounts, 2)
  })

  it('un renglón sin líneas (COALESCE 0) no ensucia los totales con NaN', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([
      {
        promotion_id: 'promo-x',
        promotion_name: 'Promo sin líneas',
        promotion_type: null,
        pricing_mode: null,
        times_sold: 1,
        needs_review: 0,
        gross_sales: null,
        discounts: null,
        net_sales: null,
      },
    ])

    const report = await getPromotionSales(VENUE, { startDate: '2026-08-01', endDate: '2026-08-18', timezone: TZ })

    expect(report.promotions[0].grossSales).toBe(0)
    expect(report.totals.netSales).toBe(0)
    expect(Number.isNaN(report.totals.grossSales)).toBe(false)
  })
})

// ============================================================
// 2. NUEVO: la zona horaria del negocio
// ============================================================

describe('getPromotionSales — rango en la hora del NEGOCIO', () => {
  it('una fecha YYYY-MM-DD pelada se ancla al día del venue, no al reloj del host', async () => {
    await getPromotionSales(VENUE, { startDate: '2026-08-18', endDate: '2026-08-18', timezone: TZ })

    const [, , start, end] = prismaMock.$queryRawUnsafe.mock.calls[0]
    // Medianoche del 18 de agosto en Ciudad de México = 06:00 UTC (verano, UTC-6).
    // Con `new Date('2026-08-18')` esto sería 00:00Z y el reporte traería el día 17.
    expect((start as Date).toISOString()).toBe('2026-08-18T06:00:00.000Z')
    expect((end as Date).toISOString()).toBe('2026-08-19T05:59:59.999Z')
  })

  it('el venueId viaja como PARÁMETRO, nunca interpolado en el SQL', async () => {
    await getPromotionSales(VENUE, { startDate: '2026-08-18', endDate: '2026-08-18', timezone: TZ })

    const [sql, venueId] = prismaMock.$queryRawUnsafe.mock.calls[0]
    expect(venueId).toBe(VENUE)
    expect(sql as string).toContain('o."venueId" = $1')
    expect(sql as string).not.toContain(VENUE)
  })

  it('una zona horaria hostil se rechaza antes de tocar el SQL (va interpolada, no parametrizada)', async () => {
    await expect(
      getPromotionSales(VENUE, {
        startDate: '2026-08-18',
        endDate: '2026-08-18',
        reportType: 'days',
        timezone: 'America/Mexico_City\'; DROP TABLE "Order"; --',
      }),
    ).rejects.toThrow(/Zona horaria inválida/)

    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled()
  })
})

// ============================================================
// 3. NUEVO: desglose por período
// ============================================================

describe('getPromotionSales — por período', () => {
  it('summary NO dispara la segunda consulta', async () => {
    const report = await getPromotionSales(VENUE, { startDate: '2026-08-01', endDate: '2026-08-18', timezone: TZ })

    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(1)
    expect(report.byPeriod).toBeUndefined()
  })

  it('days devuelve la serie con etiqueta legible y montos numéricos', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        period: new Date('2026-08-18T00:00:00.000Z'),
        times_sold: 2,
        gross_sales: decimal(200),
        discounts: decimal(40),
        net_sales: decimal(160),
      },
    ])

    const report = await getPromotionSales(VENUE, {
      startDate: '2026-08-18',
      endDate: '2026-08-18',
      reportType: 'days',
      timezone: TZ,
    })

    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(2)
    expect(report.byPeriod).toHaveLength(1)
    expect(report.byPeriod![0]).toMatchObject({ timesSold: 2, grossSales: 200, discounts: 40, netSales: 160 })
    // DATE_TRUNC(... AT TIME ZONE tz) ya viene en hora del negocio: la etiqueta
    // debe decir 18, no 17 (convertirla otra vez restaría el offset dos veces).
    expect(report.byPeriod![0].periodLabel).toContain('18')
  })
})

// ============================================================
// 4. REGRESIÓN: invariantes del SQL que sólo se ven leyéndolo
// ============================================================

describe('SQL del reporte de promociones', () => {
  it('cuenta ventas con COUNT(DISTINCT op.id) — el JOIN a las líneas multiplica filas', () => {
    expect(codeOnly).toContain('COUNT(DISTINCT op.id)')
    // Un combo de 3 productos se reportaría como 3 ventas.
    expect(codeOnly).not.toMatch(/COUNT\(op\.id\)/)
    expect(codeOnly).not.toMatch(/COUNT\(\*\)/)
  })

  it('lee el NOMBRE del snapshot antes que el de la promoción viva', () => {
    const nameExpr = source.match(/const SNAPSHOT_NAME_SQL = `([^`]+)`/)?.[1] ?? ''
    expect(nameExpr).toContain(`op."snapshotJson"->>'name'`)
    // El orden importa: si `pr.name` fuera primero, renombrar la promo reescribiría
    // el reporte de un período ya cerrado (la trampa que Square documenta).
    expect(nameExpr.indexOf('snapshotJson')).toBeLessThan(nameExpr.indexOf('pr.name'))
  })

  it('usa los MISMOS filtros de orden que sales-by-item, o los dos reportes no reconcilian', () => {
    const salesByItem = fs.readFileSync(
      path.join(__dirname, '../../../../src/services/dashboard/sales-by-item.dashboard.service.ts'),
      'utf8',
    )
    for (const clause of [`o.status NOT IN ('CANCELLED')`, `o."paymentStatus" NOT IN ('REFUNDED')`]) {
      expect(source).toContain(clause)
      expect(salesByItem).toContain(clause)
    }
  })

  it('el dinero sale de las líneas compartidas (lineGrossSql/lineRevenueSql), no de los cents congelados', () => {
    expect(source).toContain('lineGrossSql()')
    expect(source).toContain('lineRevenueSql()')
    expect(source).not.toMatch(/SUM\(op\."(gross|net|discount)Cents"\)/)
  })

  it('nunca parsea una fecha pelada con new Date()/parseISO', () => {
    expect(codeOnly).not.toMatch(/new Date\(\s*startDate/)
    expect(codeOnly).not.toMatch(/parseISO\(/)
    expect(codeOnly).toContain('parseDbDateRange')
  })
})
