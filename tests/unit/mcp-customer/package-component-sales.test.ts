/**
 * MCP `package_component_sales` (founder «B», 20-nov-2026, Flautas): las unidades de cada platillo vendidas como EXTRA ligado a él
 * (la columna «Dentro de paquete» de Ventas por artículo). Herramienta NUEVA a propósito: `product_sales` está en la tanda
 * certificada del directorio y no se toca; ésta vive sólo en el modo libre (no está en ninguna tanda).
 *
 * Lo que se protege: es la MISMA consulta del reporte (mismos filtros, tope y zona horaria), sólo unidades, acotada y paginada.
 */
import { registerPackageComponentSalesTools } from '../../../src/mcp/tools/packageComponentSales'
import type { McpScope } from '../../../src/mcp/scope'

const mockVenueFind = jest.fn()
const mockUnidades = jest.fn()
const mockGate = jest.fn()

jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...a: unknown[]) => mockGate(...a) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (perm: string, v: string) => {
      if (v === 'no-perm') throw new Error(`Forbidden: missing ${perm}`)
    },
  }),
}))
jest.mock('@/services/dashboard/sales-by-item.dashboard.service', () => ({
  getUnitsInsidePackages: (...a: unknown[]) => mockUnidades(...a),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { venue: { findUnique: (...a: unknown[]) => mockVenueFind(...a) } },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('package_component_sales')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

const fila = (units: number, productName: string, extra: Record<string, unknown> = {}) => ({
  units,
  productName,
  productSku: null,
  categoryName: 'Flautas',
  productGroupId: null,
  productGroupName: null,
  ...extra,
})

beforeAll(() => {
  registerPackageComponentSalesTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  mockGate.mockResolvedValue(null)
  mockVenueFind.mockResolvedValue({ timezone: 'America/Mexico_City' })
  mockUnidades.mockResolvedValue(
    new Map([
      ['p-papa', fila(15, 'Flauta de papa', { productSku: 'FL-PAPA' })],
      ['p-pollo', fila(6, 'Flauta de pollo')],
    ]),
  )
})

describe('package_component_sales', () => {
  it('fuera de alcance o sin reports:read no lee nada', async () => {
    await expect(call({ venueId: 'foreign' })).rejects.toThrow('out of scope')
    await expect(call({ venueId: 'no-perm' })).rejects.toThrow('reports:read')
    expect(mockUnidades).not.toHaveBeenCalled()
  })

  it('sin el plan de reportes (Pro) explica el plan y no lee', async () => {
    mockGate.mockResolvedValue('Los reportes avanzados no están incluidos…')
    const out = parse(await call({ venueId: 'v1' }))
    expect(out).toMatchObject({ ok: false, planRequired: true })
    expect(mockGate).toHaveBeenCalledWith('v1', 'ADVANCED_REPORTS', expect.any(String))
    expect(mockUnidades).not.toHaveBeenCalled()
  })

  it('usa la consulta del reporte con el día completo en la zona del negocio, sin filtro de horas', async () => {
    mockVenueFind.mockResolvedValue({ timezone: 'America/Mexico_City' })
    await call({ venueId: 'v1', fromDate: '2026-11-01', toDate: '2026-11-20' })
    const [venueId, start, end, horas] = mockUnidades.mock.calls[0]
    expect(venueId).toBe('v1')
    // 00:00 del 1-nov y 23:59:59.999 del 20-nov en Ciudad de México (UTC−6).
    expect((start as Date).toISOString()).toBe('2026-11-01T06:00:00.000Z')
    expect((end as Date).toISOString()).toBe('2026-11-21T05:59:59.999Z')
    expect(horas).toBe('')
  })

  it('devuelve unidades por platillo (nunca dinero), de más a menos, con el total', async () => {
    const out = parse(await call({ venueId: 'v1' }))
    expect(out).toMatchObject({
      found: true,
      venueId: 'v1',
      timezone: 'America/Mexico_City',
      total: 2,
      totalUnitsInsidePackages: 21,
      hasMore: false,
    })
    expect(out.items).toEqual([
      { menuItem: 'Flauta de papa', sku: 'FL-PAPA', category: 'Flautas', unitsInsidePackages: 15 },
      { menuItem: 'Flauta de pollo', sku: null, category: 'Flautas', unitsInsidePackages: 6 },
    ])
    expect(JSON.stringify(out)).not.toMatch(/revenue|price|sales"/i)
  })

  it('filtra por nombre sin importar acentos ni mayúsculas', async () => {
    mockUnidades.mockResolvedValue(
      new Map([
        ['p-1', fila(4, 'Flauta de PAPÁ')],
        ['p-2', fila(2, 'Taco')],
      ]),
    )
    const out = parse(await call({ venueId: 'v1', name: 'papa' }))
    expect(out.items.map((i: { menuItem: string }) => i.menuItem)).toEqual(['Flauta de PAPÁ'])
    expect(out.total).toBe(1)
    expect(out.totalUnitsInsidePackages).toBe(4)
  })

  it('pagina con tope impuesto por el servidor (100) y dice si hay más', async () => {
    const out = parse(await call({ venueId: 'v1', limit: 1, offset: 0 }))
    expect(out.items).toHaveLength(1)
    expect(out.hasMore).toBe(true)
    const segunda = parse(await call({ venueId: 'v1', limit: 1, offset: 1 }))
    expect(segunda.items[0].menuItem).toBe('Flauta de pollo')
    expect(segunda.hasMore).toBe(false)
  })

  it('Codex r1 #10: una fecha que no existe o ilegible se rechaza, sin leer nada', async () => {
    for (const fromDate of ['2026-02-30', 'mañana', '2026-13-01', '20261101']) {
      const out = parse(await call({ venueId: 'v1', fromDate }))
      expect(out).toMatchObject({ ok: false, error: expect.stringContaining(fromDate) })
    }
    const out = parse(await call({ venueId: 'v1', toDate: '2026-04-31' }))
    expect(out.ok).toBe(false)
    expect(mockUnidades).not.toHaveBeenCalled()
  })

  it('Codex r2 #6: un negocio en Auckland (UTC+13) recibe SU día pedido, no el siguiente', async () => {
    mockVenueFind.mockResolvedValue({ timezone: 'Pacific/Auckland' })
    await call({ venueId: 'v1', fromDate: '2026-11-20', toDate: '2026-11-20' })
    const [, start, end] = mockUnidades.mock.calls[0]
    // 00:00 y 23:59:59.999 del 20-nov en Auckland (horario de verano, UTC+13).
    expect([(start as Date).toISOString(), (end as Date).toISOString()]).toEqual(['2026-11-19T11:00:00.000Z', '2026-11-20T10:59:59.999Z'])
  })

  it('Codex r1 #10: el día no depende de la zona del proceso', async () => {
    const tzAntes = process.env.TZ
    try {
      for (const tz of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles', 'Pacific/Auckland']) {
        process.env.TZ = tz
        mockUnidades.mockClear()
        await call({ venueId: 'v1', fromDate: '2026-11-01', toDate: '2026-11-01' })
        const [, start, end] = mockUnidades.mock.calls[0]
        expect([(start as Date).toISOString(), (end as Date).toISOString()]).toEqual([
          '2026-11-01T06:00:00.000Z',
          '2026-11-02T05:59:59.999Z',
        ])
      }
    } finally {
      process.env.TZ = tzAntes
    }
  })

  it('sin extras ligados vendidos: lista vacía con 0, no un error', async () => {
    mockUnidades.mockResolvedValue(new Map())
    const out = parse(await call({ venueId: 'v1' }))
    expect(out).toMatchObject({ found: true, total: 0, totalUnitsInsidePackages: 0, items: [] })
  })
})
