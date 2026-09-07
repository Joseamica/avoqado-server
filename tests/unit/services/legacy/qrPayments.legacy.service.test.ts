/**
 * Regression tests for the MindForm legacy QR payments filter bug.
 *
 * Bug: the legacy QR rows were merged into the /payments list response
 * regardless of the user's method/source filter, so filtering by "Método:
 * Efectivo" still leaked QR_LEGACY/Tarjeta rows into the cash-filtered view.
 *
 * These tests pin down the two pure helpers that fix the leak:
 *   - `shouldIncludeLegacyPayments` — pre-flight skip when the filter cannot
 *     match any legacy row at all.
 *   - `filterLegacyRowsByMethodSource` — post-fetch drop of legacy rows whose
 *     method/source doesn't satisfy the filter.
 */

const mockLegacyQuery = jest.fn()
jest.mock('@/services/legacy/legacyPool', () => ({ legacyPool: { query: mockLegacyQuery } }))

import {
  shouldIncludeLegacyPayments,
  filterLegacyRowsByMethodSource,
  getLegacyPaymentFacets,
  getLegacyPayments,
  getLegacyPeriodMetrics,
  LEGACY_METHOD_VALUES,
  LEGACY_SOURCE_VALUE,
} from '@/services/legacy/qrPayments.legacy.service'
import { normalizeNativePaymentMethods } from '@/services/dashboard/payment.dashboard.service'

describe('payment dashboard — alias CARD compatible con pagos nativos', () => {
  it('expande CARD a crédito y débito sin perder otros métodos', () => {
    expect(normalizeNativePaymentMethods(['CARD'])).toEqual(['CREDIT_CARD', 'DEBIT_CARD'])
    expect(normalizeNativePaymentMethods(['CASH', 'CARD', 'CREDIT_CARD'])).toEqual(['CASH', 'CREDIT_CARD', 'DEBIT_CARD'])
  })

  it('conserva undefined y los métodos nativos sin alterarlos', () => {
    expect(normalizeNativePaymentMethods(undefined)).toBeUndefined()
    expect(normalizeNativePaymentMethods(['CASH'])).toEqual(['CASH'])
  })
})

describe('qrPayments.legacy.service — facetas acotadas', () => {
  it('obtiene métodos y marcas con DISTINCT sin materializar el historial', async () => {
    mockLegacyQuery.mockResolvedValueOnce({ rows: [{ methods: ['CARD', 'CASH'], brands: ['VISA'] }] })

    await expect(getLegacyPaymentFacets()).resolves.toEqual({ methods: ['CARD', 'CASH'], sources: ['QR_LEGACY'], cardBrands: ['VISA'] })
    expect(mockLegacyQuery).toHaveBeenCalledTimes(1)
    expect(mockLegacyQuery.mock.calls[0][0]).toContain('array_agg(DISTINCT')
    expect(mockLegacyQuery.mock.calls[0][0]).not.toContain('ORDER BY p."createdAt"')
  })
})

describe('qrPayments.legacy.service — páginas estables', () => {
  it('aplica método, límite y fechas ISO dentro de SQL', async () => {
    mockLegacyQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ total: 12 }] })

    await expect(
      getLegacyPayments({
        startDate: '2026-08-01T00:00:00.000Z',
        endDate: '2026-08-31T23:59:59.999Z',
        methods: ['CASH'],
        limit: 25,
      }),
    ).resolves.toEqual({ rows: [], total: 12 })

    const [dataSql, dataParams] = mockLegacyQuery.mock.calls[0]
    expect(dataSql).toContain("UPPER(COALESCE(p.method::text, '')) = 'CASH'")
    expect(dataSql).toContain('ORDER BY p."createdAt" DESC, p.id DESC LIMIT')
    expect(dataParams.at(-1)).toBe(25)
    expect(dataParams.slice(1, 3)).toEqual(['2026-08-01T00:00:00.000Z', '2026-08-31T23:59:59.999Z'])
    expect(dataParams.some((value: unknown) => value instanceof Date)).toBe(false)
  })
})

describe('qrPayments.legacy.service — shouldIncludeLegacyPayments', () => {
  it('returns true when no filter is provided (no constraint)', () => {
    expect(shouldIncludeLegacyPayments(undefined)).toBe(true)
    expect(shouldIncludeLegacyPayments({})).toBe(true)
  })

  it('returns true when methods/sources arrays are empty', () => {
    expect(shouldIncludeLegacyPayments({ methods: [], sources: [] })).toBe(true)
  })

  it('returns true when methods filter includes a legacy method value', () => {
    expect(shouldIncludeLegacyPayments({ methods: ['CASH'] })).toBe(true)
    expect(shouldIncludeLegacyPayments({ methods: ['CARD'] })).toBe(true)
    expect(shouldIncludeLegacyPayments({ methods: ['CASH', 'CREDIT_CARD'] })).toBe(true)
  })

  it('returns false when methods filter excludes ALL legacy method values', () => {
    // This is the canonical bug case: user filters by "Efectivo" only.
    // Legacy CARD rows must not be considered → skip the legacy DB call entirely.
    // (The legacy mapper emits either 'CASH' or 'CARD'; nothing else.)
    expect(shouldIncludeLegacyPayments({ methods: ['CREDIT_CARD'] })).toBe(false)
    expect(shouldIncludeLegacyPayments({ methods: ['DEBIT_CARD'] })).toBe(false)
    expect(shouldIncludeLegacyPayments({ methods: ['CREDIT_CARD', 'DEBIT_CARD'] })).toBe(false)
  })

  it('returns true when sources filter includes QR_LEGACY', () => {
    expect(shouldIncludeLegacyPayments({ sources: ['QR_LEGACY'] })).toBe(true)
    expect(shouldIncludeLegacyPayments({ sources: ['TPV', 'QR_LEGACY'] })).toBe(true)
  })

  it('returns false when sources filter excludes QR_LEGACY', () => {
    expect(shouldIncludeLegacyPayments({ sources: ['TPV'] })).toBe(false)
    expect(shouldIncludeLegacyPayments({ sources: ['WEB'] })).toBe(false)
    expect(shouldIncludeLegacyPayments({ sources: ['TPV', 'WEB', 'OTHER'] })).toBe(false)
  })

  it('returns false when EITHER constraint excludes legacy (logical AND)', () => {
    // methods allows it but sources doesn't
    expect(shouldIncludeLegacyPayments({ methods: ['CASH'], sources: ['TPV'] })).toBe(false)
    // sources allows it but methods doesn't
    expect(shouldIncludeLegacyPayments({ methods: ['CREDIT_CARD'], sources: ['QR_LEGACY'] })).toBe(false)
  })

  it('returns true only when BOTH constraints allow legacy', () => {
    expect(shouldIncludeLegacyPayments({ methods: ['CASH'], sources: ['QR_LEGACY'] })).toBe(true)
    expect(shouldIncludeLegacyPayments({ methods: ['CARD', 'CASH'], sources: ['QR_LEGACY', 'TPV'] })).toBe(true)
  })

  it('pins the constants used to decide the filter — bumping them must update the helper', () => {
    // Sanity guard: if these change, both the helper and these tests must change.
    expect(LEGACY_METHOD_VALUES).toEqual(['CASH', 'CARD'])
    expect(LEGACY_SOURCE_VALUE).toBe('QR_LEGACY')
  })
})

describe('qrPayments.legacy.service — filterLegacyRowsByMethodSource', () => {
  const baseRows = [
    { id: 'l1', method: 'CARD', source: 'QR_LEGACY' },
    { id: 'l2', method: 'CASH', source: 'QR_LEGACY' },
    { id: 'l3', method: 'CARD', source: 'QR_LEGACY' },
  ]

  it('returns the input unchanged when no filter is provided', () => {
    expect(filterLegacyRowsByMethodSource(baseRows, undefined)).toBe(baseRows)
    expect(filterLegacyRowsByMethodSource(baseRows, {})).toBe(baseRows)
    expect(filterLegacyRowsByMethodSource(baseRows, { methods: [], sources: [] })).toBe(baseRows)
  })

  it('drops rows whose method does not match the methods filter', () => {
    // User filters by "Efectivo" → only the CASH legacy row should survive,
    // not the CARD ones. This was the leak the user reported.
    const result = filterLegacyRowsByMethodSource(baseRows, { methods: ['CASH'] })
    expect(result.map(r => r.id)).toEqual(['l2'])
  })

  it('keeps all rows when method filter includes every emitted legacy method', () => {
    const result = filterLegacyRowsByMethodSource(baseRows, { methods: ['CASH', 'CARD'] })
    expect(result).toHaveLength(3)
  })

  it('drops rows whose source does not match the sources filter', () => {
    // Simulate a hypothetical row with a non-legacy source (defensive — today
    // the mapper always emits QR_LEGACY, but the filter shouldn't trust that).
    const rows = [...baseRows, { id: 'l4', method: 'CASH', source: 'OTHER' as any }]
    const result = filterLegacyRowsByMethodSource(rows, { sources: ['QR_LEGACY'] })
    expect(result.map(r => r.id)).toEqual(['l1', 'l2', 'l3'])
  })

  it('drops rows that fail EITHER the method or the source filter', () => {
    const result = filterLegacyRowsByMethodSource(baseRows, {
      methods: ['CASH'],
      sources: ['QR_LEGACY'],
    })
    expect(result.map(r => r.id)).toEqual(['l2'])
  })

  it('returns an empty array when no rows pass the filter', () => {
    // methods=['CREDIT_CARD'] excludes every legacy row (legacy is CASH/CARD).
    const result = filterLegacyRowsByMethodSource(baseRows, { methods: ['CREDIT_CARD'] })
    expect(result).toEqual([])
  })
})

/**
 * 🔴 `Payment.method` es un ENUM (`PaymentMethod`) en la base legacy (7-sep-2026).
 *
 * `COALESCE(p.method, '')` obliga a Postgres a convertir `''` al enum y revienta SIEMPRE:
 * «invalid input value for enum "PaymentMethod": ""». No es intermitente ni depende de los
 * datos, y las tres funciones que lo tenían se tragaban el error y devolvían VACÍO:
 *   · las facetas del puente nunca aparecían;
 *   · la lista filtrada por Efectivo/Tarjeta daba `{rows: [], total: 0}` sin aviso;
 *   · el reporte de ventas filtrado por método dejaba fuera, en silencio, toda la
 *     recaudación QR legacy de Mindform — esconder datos sin decirlo, justo lo que prohíbe
 *     `bounded-queries-and-server-load.md`.
 * Verificado en el Postgres local, que tiene el MISMO enum: la versión con `::text` cuenta
 * 737 filas; la versión sin cast falla al parsear.
 */
describe('qrPayments.legacy.service — la columna method se compara como TEXTO (es un enum)', () => {
  const RANGO = ['2026-08-01T00:00:00.000Z', '2026-08-31T23:59:59.999Z'] as const
  const sinCoalesceSobreElEnum = (sql: string) => {
    expect(sql).not.toContain("COALESCE(p.method, '')")
    expect(sql).toContain("COALESCE(p.method::text, '')")
  }

  it('facetas', async () => {
    mockLegacyQuery.mockResolvedValueOnce({ rows: [{ methods: ['CASH'], brands: [] }] })
    await getLegacyPaymentFacets()
    sinCoalesceSobreElEnum(mockLegacyQuery.mock.calls.at(-1)![0])
  })

  it.each([['CASH'], ['CARD']])('lista filtrada por %s', async metodo => {
    mockLegacyQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ total: 0 }] })
    await getLegacyPayments({ methods: [metodo], limit: 10 })
    sinCoalesceSobreElEnum(mockLegacyQuery.mock.calls.at(-2)![0])
  })

  it.each(['CASH', 'CARD'] as const)('métricas por periodo filtradas por %s', async metodo => {
    mockLegacyQuery.mockResolvedValueOnce({ rows: [] })
    await getLegacyPeriodMetrics(RANGO[0], RANGO[1], 'days', 'America/Mexico_City', metodo)
    sinCoalesceSobreElEnum(mockLegacyQuery.mock.calls.at(-1)![0])
  })
})

/**
 * Cuando la base legacy FALLA, la respuesta lo DICE. Seguir devolviendo vacío es correcto
 * (una caída del puente no puede tumbar la pantalla de pagos de Mindform), pero «cero filas»
 * y «la consulta reventó» no pueden ser indistinguibles: es lo que volvió invisible durante
 * semanas la pérdida de arriba.
 */
describe('qrPayments.legacy.service — una caída del puente se DECLARA, no se disfraza de vacío', () => {
  it('la lista marca `unavailable` cuando la consulta revienta; y NO lo marca cuando simplemente no hay filas', async () => {
    mockLegacyQuery.mockRejectedValueOnce(new Error('invalid input value for enum "PaymentMethod": ""'))
    await expect(getLegacyPayments({ methods: ['CASH'], limit: 10 })).resolves.toEqual({ rows: [], total: 0, unavailable: true })

    mockLegacyQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ total: 0 }] })
    const vacia = await getLegacyPayments({ methods: ['CASH'], limit: 10 })
    expect(vacia).toEqual({ rows: [], total: 0 })
    expect(vacia).not.toHaveProperty('unavailable')
  })

  it('las métricas por periodo devuelven `{rows, unavailable}` — vacío-por-error ≠ vacío-por-datos', async () => {
    mockLegacyQuery.mockRejectedValueOnce(new Error('boom'))
    await expect(
      getLegacyPeriodMetrics('2026-08-01T00:00:00.000Z', '2026-08-31T23:59:59.999Z', 'days', 'America/Mexico_City'),
    ).resolves.toEqual({ rows: [], unavailable: true })

    mockLegacyQuery.mockResolvedValueOnce({ rows: [{ period: '1756684800000', amount_centavos: '12345', tip_centavos: '100', count: 2 }] })
    await expect(
      getLegacyPeriodMetrics('2026-08-01T00:00:00.000Z', '2026-08-31T23:59:59.999Z', 'days', 'America/Mexico_City'),
    ).resolves.toEqual({ rows: [{ periodKey: '1756684800000', amount: 123.45, tips: 1, count: 2 }], unavailable: false })
  })
})
