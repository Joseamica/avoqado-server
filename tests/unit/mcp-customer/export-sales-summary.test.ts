/**
 * export_sales_summary MCP tool: summary gates on ADVANCED_REPORTS, detailed additionally on
 * TRANSACTION_EXPORT (Premium). Mirrors serialized-gating.test.ts handler-capture style.
 */
import { registerSalesTools } from '../../../src/mcp/tools/sales'
import type { McpScope } from '../../../src/mcp/scope'

const mockPlanGate = jest.fn()
const mockGetSalesSummary = jest.fn()
const mockFlatten = jest.fn()
const mockCount = jest.fn()
const mockFetch = jest.fn()

jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...a: unknown[]) => mockPlanGate(...(a as [])) }))
jest.mock('@/services/dashboard/sales-summary.dashboard.service', () => ({
  computeSettlementProjection: jest.fn(),
  getSalesSummary: (...a: unknown[]) => mockGetSalesSummary(...(a as [])),
  flattenSalesSummaryForExport: (...a: unknown[]) => mockFlatten(...(a as [])),
  countSalesSummaryDetailRows: (...a: unknown[]) => mockCount(...(a as [])),
  fetchSalesSummaryDetailRows: (...a: unknown[]) => mockFetch(...(a as [])),
}))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v?: string) => (v ? { venueId: { in: [v] } } : { venueId: { in: ['v1'] } }),
    requirePermission: jest.fn(),
    // Faithful to the real guard.redact: strips the top-level SENSITIVE_PAYMENT_FIELDS.
    redact: <T>(rows: T[]) =>
      rows.map(r => {
        const c = { ...(r as Record<string, unknown>) }
        delete c.maskedPan
        delete c.referenceNumber
        delete c.authorizationNumber
        return c as T
      }),
  }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { venue: { findUnique: jest.fn().mockResolvedValue({ timezone: 'America/Mexico_City' }) } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const schemas = new Map<string, Record<string, { description?: string }>>()
const descripciones = new Map<string, string>()
const scope = { staffId: 'staff-1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (n: string, args: Record<string, unknown>) => handlers.get(n)!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerSalesTools(
    {
      tool: (...a: unknown[]) => {
        handlers.set(a[0] as string, a[a.length - 1] as never)
        schemas.set(a[0] as string, a[2] as never)
        descripciones.set(a[0] as string, a[1] as string)
      },
    } as never,
    scope,
  )
})
beforeEach(() => jest.clearAllMocks())

describe('export_sales_summary — plan gating', () => {
  it('detailed mode is DENIED for a non-Premium (no TRANSACTION_EXPORT) venue', async () => {
    // ADVANCED_REPORTS allowed (null) but TRANSACTION_EXPORT denied (returns a message).
    mockPlanGate.mockImplementation(async (_v: string, code: string) =>
      code === 'TRANSACTION_EXPORT' ? 'La exportación detallada de transacciones requiere el plan Premium.' : null,
    )
    const out = parse(await call('export_sales_summary', { venueId: 'v1', mode: 'detailed' }))
    expect(out.planRequired).toBe(true)
    expect(out.ok).toBe(false)
    expect(mockCount).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('detailed mode + QR_LEGACY is rejected cleanly (no throw, no count/fetch)', async () => {
    // Entitled venue (gate allows everything) — the QR_LEGACY guard must fire before counting,
    // mirroring the HTTP controller. Otherwise buildPaymentWhereFilter('QR_LEGACY') would throw.
    mockPlanGate.mockResolvedValue(null)
    const out = parse(await call('export_sales_summary', { venueId: 'v1', mode: 'detailed', paymentMethod: 'QR_LEGACY' }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/QR_LEGACY/)
    expect(mockCount).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('🔒 H2: detailed rows NEVER expose maskedPan or processorData to the LLM', async () => {
    mockPlanGate.mockResolvedValue(null) // entitled (ADVANCED_REPORTS + TRANSACTION_EXPORT)
    mockCount.mockResolvedValue(1)
    mockFetch.mockResolvedValue([
      {
        id: 'p1',
        amount: 100,
        method: 'CREDIT_CARD',
        cardBrand: 'VISA',
        maskedPan: '************2026',
        processorData: { authorizationNumber: 'AUTH123', referenceNumber: 'REF9', raw: 'blob' },
        createdAt: new Date('2026-06-01T10:00:00Z'),
      },
    ])
    const out = parse(await call('export_sales_summary', { venueId: 'v1', mode: 'detailed' }))
    expect(out.mode).toBe('detailed')
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0]).not.toHaveProperty('maskedPan') // redacted
    expect(out.rows[0]).not.toHaveProperty('processorData') // dropped (nested card/processor blob)
    expect(out.rows[0]).toMatchObject({ id: 'p1', amount: 100, cardBrand: 'VISA' }) // safe fields survive
  })

  // D13.2: la MCP forzaba reportType 'summary' y «byPeriod» salía vacío.
  it('🔴 D13.2 · byPeriod pide el desglose: el reportType dado, o por día si no se da', async () => {
    mockPlanGate.mockResolvedValue(null)
    mockGetSalesSummary.mockResolvedValue({ summary: {}, byPaymentMethod: [] })
    mockFlatten.mockReturnValue({ rows: [] })
    await call('export_sales_summary', { venueId: 'v1', sections: 'byPeriod', reportType: 'weeks' })
    expect(mockGetSalesSummary.mock.calls[0][1].reportType).toBe('weeks')
    await call('export_sales_summary', { venueId: 'v1', sections: 'totals,byPeriod' })
    expect(mockGetSalesSummary.mock.calls[1][1].reportType).toBe('days')
    await call('export_sales_summary', { venueId: 'v1', sections: 'totals', reportType: 'hours' })
    expect(mockGetSalesSummary.mock.calls[2][1].reportType).toBe('summary')
  })

  // Codex D13 r1 #10: el MCP certificado comparte el esquema de entrada; lo nuevo se describe en la descripción de la tool, que el
  // directorio sustituye por la suya, así su `sections` no cambia de texto.
  it('🔴 D13.6 · la tool anuncia «statement» y reportType en su descripción; `sections` conserva su texto certificado', () => {
    expect(descripciones.get('export_sales_summary')).toMatch(/statement/)
    expect(descripciones.get('export_sales_summary')).toMatch(/reportType/)
    expect(schemas.get('export_sales_summary')!.sections.description).toBe(
      'Summary sections, comma-separated: totals,paymentMethods,cardTypes,merchantAccounts,byPeriod',
    )
  })

  it('«Por periodo» con demasiadas filas no se manda entero ni a medias: lo dice', async () => {
    mockPlanGate.mockResolvedValue(null)
    mockGetSalesSummary.mockResolvedValue({ summary: {}, byPaymentMethod: [] })
    mockFlatten.mockReturnValue({ rows: Array.from({ length: 1001 }, (_, i) => ({ section: 'byPeriod', label: `h${i}` })) })
    const out = parse(await call('export_sales_summary', { venueId: 'v1', sections: 'byPeriod', reportType: 'hours' }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/1,001/)
    expect(out.rows).toBeUndefined()
  })

  it('🔴 D13.3 · las filas del detallado dicen su hora real en la zona del negocio y no traen la zona anidada', async () => {
    mockPlanGate.mockResolvedValue(null)
    mockCount.mockResolvedValue(1)
    mockFetch.mockResolvedValue([
      {
        id: 'p1',
        amount: 50,
        createdAt: new Date('2026-11-12T06:10:00.000Z'),
        clientCreatedAt: new Date('2026-11-12T05:50:00.000Z'),
        zona: 'America/Mexico_City',
      },
    ])
    const out = parse(await call('export_sales_summary', { venueId: 'v1', mode: 'detailed' }))
    expect(out.rows[0].fecha).toBe('2026-11-11 23:50:00')
    expect(out.rows[0]).not.toHaveProperty('zona')
  })

  it('Codex D13 r3 #6 · con más periodos que el tope, avisa sin etiquetarlos uno por uno', async () => {
    mockPlanGate.mockResolvedValue(null)
    mockGetSalesSummary.mockResolvedValue({ summary: {}, byPeriod: Array.from({ length: 1001 }, (_, i) => ({ period: `p${i}` })) })
    const out = parse(await call('export_sales_summary', { venueId: 'v1', sections: 'byPeriod', reportType: 'hours' }))
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/1,001/)
    expect(mockFlatten).not.toHaveBeenCalled()
  })

  it('summary mode returns flattened rows for an entitled venue', async () => {
    mockPlanGate.mockResolvedValue(null) // ADVANCED_REPORTS granted
    mockGetSalesSummary.mockResolvedValue({ summary: { grossSales: 100, transactionCount: 3 }, byPaymentMethod: [] })
    mockFlatten.mockReturnValue({ rows: [{ section: 'totals', label: 'Ventas brutas', amount: 100, count: 3, percentage: null }] })
    const out = parse(await call('export_sales_summary', { venueId: 'v1', mode: 'summary' }))
    expect(out.mode).toBe('summary')
    expect(out.rows).toHaveLength(1)
    expect(mockGetSalesSummary).toHaveBeenCalled()
  })
})
