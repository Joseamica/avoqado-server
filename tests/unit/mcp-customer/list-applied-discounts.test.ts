// Tool `list_applied_discounts` (encargo f998c8): lee el mismo reporte que el DASHBOARD, en pesos, con «Sin motivo» legible.
import { registerDiscountTools } from '../../../src/mcp/tools/discounts'
import type { McpScope } from '../../../src/mcp/scope'

const mockListar = jest.fn()
jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn().mockResolvedValue(null) }))
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
jest.mock('@/services/dashboard/descuentosAplicados.service', () => ({
  listarDescuentosAplicados: (...a: unknown[]) => mockListar(...(a as [])),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: {} }))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('list_applied_discounts')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerDiscountTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

describe('list_applied_discounts (read)', () => {
  it('rechaza un negocio fuera de alcance o sin reports:read, sin leer nada', async () => {
    await expect(call({ venueId: 'foreign' })).rejects.toThrow('out of scope')
    await expect(call({ venueId: 'no-perm' })).rejects.toThrow('reports:read')
    expect(mockListar).not.toHaveBeenCalled()
  })

  it('pasa los filtros tal cual y devuelve pesos con «Sin motivo» legible', async () => {
    mockListar.mockResolvedValueOnce({
      from: new Date('2026-11-15T06:00:00Z'),
      to: new Date('2026-11-16T05:59:59.999Z'),
      totales: { count: 2, amount: 35.5 },
      porMotivo: [
        { reason: 'Queja del cliente', count: 1, amount: 20 },
        { reason: null, count: 1, amount: 15.5 },
      ],
      motivosRecortados: false,
      rows: [
        {
          id: 'od-1',
          createdAt: new Date('2026-11-15T18:00:00Z'),
          orderId: 'o1',
          orderNumber: 'A-1',
          name: 'Ajuste de precio',
          type: 'FIXED_AMOUNT',
          amount: 15.5,
          reason: null,
          reasonComment: null,
          appliedBy: 'Ana',
          authorizedBy: null,
        },
      ],
      pagination: { page: 1, pageSize: 50, total: 2, totalPages: 1 },
    })
    const out = parse(await call({ venueId: 'v1', from: '2026-11-15', to: '2026-11-15', reason: 'X' }))
    expect(mockListar).toHaveBeenCalledWith('v1', {
      from: '2026-11-15',
      to: '2026-11-15',
      reason: 'X',
      page: undefined,
      pageSize: undefined,
    })
    expect(out.ok).toBe(true)
    expect(out.porMotivo[1]).toEqual({ reason: 'Sin motivo', count: 1, amount: 15.5 })
    expect(out.descuentos[0]).toMatchObject({ folio: 'A-1', monto: 15.5, motivo: 'Sin motivo', aplico: 'Ana' })
    expect(out.pagination.total).toBe(2)
  })

  it('un error del servicio (fecha inválida) sale como ok:false con su mensaje', async () => {
    mockListar.mockRejectedValueOnce(new Error("La fecha inicial '2026-13-40' no es una fecha válida."))
    const out = parse(await call({ venueId: 'v1', from: '2026-13-40' }))
    expect(out).toEqual({ ok: false, error: "La fecha inicial '2026-13-40' no es una fecha válida." })
  })
})
