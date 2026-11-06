import { registerFeatureTools } from '../../../src/mcp/tools/features'
import type { McpScope } from '../../../src/mcp/scope'

const mockModuleFind = jest.fn()
const mockFeatureFind = jest.fn()

jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: jest.fn(),
  }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venueModule: { findMany: (...a: unknown[]) => mockModuleFind(...(a as [])) },
    venueFeature: { findMany: (...a: unknown[]) => mockFeatureFind(...(a as [])) },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('venue_features')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

beforeAll(() => {
  registerFeatureTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => jest.clearAllMocks())

const enUnMes = new Date(Date.now() + 30 * 86_400_000)

describe('venue_features', () => {
  it('rejects a venue outside the caller scope — no DB read (cross-tenant guard)', async () => {
    await expect(call({ venueId: 'foreign' })).rejects.toThrow('out of scope')
    expect(mockModuleFind).not.toHaveBeenCalled()
  })

  it('lists active modules + features, derives state, and bills only paid add-ons monthly', async () => {
    mockModuleFind.mockResolvedValueOnce([
      { enabledAt: new Date('2026-01-01T00:00:00Z'), module: { code: 'SERIALIZED_INVENTORY', name: 'Inventario Serializado' } },
    ])
    mockFeatureFind.mockResolvedValueOnce([
      {
        monthlyPrice: 500,
        startDate: new Date('2026-02-01T00:00:00Z'),
        endDate: null,
        suspendedAt: null,
        active: true,
        gracePeriodEndsAt: null,
        feature: { code: 'CHATBOT', name: 'Chatbot', category: 'AI' },
      },
      {
        monthlyPrice: 300,
        startDate: new Date('2026-05-20T00:00:00Z'),
        endDate: enUnMes, // trial
        suspendedAt: null,
        active: true,
        gracePeriodEndsAt: null,
        feature: { code: 'CFDI', name: 'Facturación', category: 'FISCAL' },
      },
      {
        monthlyPrice: 200,
        startDate: new Date('2026-03-01T00:00:00Z'),
        endDate: null,
        suspendedAt: new Date('2026-06-01T00:00:00Z'), // suspended
        active: true,
        gracePeriodEndsAt: null,
        feature: { code: 'AVOQADO_REPORTS', name: 'Reportes', category: 'ANALYTICS' },
      },
    ])

    const out = parse(await call({ venueId: 'v1' }))

    expect(out.moduleCount).toBe(1)
    expect(out.featureCount).toBe(3)
    expect(out.modules[0]).toMatchObject({ code: 'SERIALIZED_INVENTORY', name: 'Inventario Serializado' })
    expect(out.features.map((f: { code: string; state: string }) => [f.code, f.state])).toEqual([
      ['CHATBOT', 'active'],
      ['CFDI', 'trial'],
      ['AVOQADO_REPORTS', 'suspended'],
    ])
    // only the paid (active) feature counts — trial is free, suspended isn't being billed
    expect(out.monthlyFeatureCost).toBe(500)
    expect(out.features[1].trialEndsAt).toBe(enUnMes.toISOString())
  })

  // D4 + D6 (5-nov-2026): el estado sale de la regla única del portero (ventanaDeAcceso.ts).
  it('🔴 dice lo mismo que el portero: gracia vigente, gracia vencida y prueba vencida', async () => {
    const ayer = new Date(Date.now() - 86_400_000)
    const manana = new Date(Date.now() + 86_400_000)
    const fila = (code: string, v: Record<string, unknown>) => ({
      monthlyPrice: 100,
      startDate: new Date('2026-01-01T00:00:00Z'),
      endDate: null,
      suspendedAt: null,
      active: true,
      gracePeriodEndsAt: null,
      feature: { code, name: code, category: 'X' },
      ...v,
    })
    mockModuleFind.mockResolvedValueOnce([])
    mockFeatureFind.mockResolvedValueOnce([
      fila('EN_GRACIA', { endDate: ayer, gracePeriodEndsAt: manana }),
      fila('GRACIA_VENCIDA', { gracePeriodEndsAt: ayer }),
      fila('CUATRO_DIAS_VENCIDOS', { endDate: ayer, gracePeriodEndsAt: ayer }),
      fila('PRUEBA_VENCIDA', { endDate: ayer }),
    ])
    const out = parse(await call({ venueId: 'v1' }))
    expect(out.features.map((f: { code: string; state: string }) => [f.code, f.state])).toEqual([
      ['EN_GRACIA', 'past_due'],
      // v4: la gracia vencida de quien ya pagaba no quita acceso (lo corta el 4.º intento): sigue «pago pendiente».
      ['GRACIA_VENCIDA', 'past_due'],
      ['CUATRO_DIAS_VENCIDOS', 'suspended'],
      ['PRUEBA_VENCIDA', 'expired'],
    ])
    // Lo que se reintenta cobrar sigue siendo un costo mensual; lo suspendido y lo vencido, no.
    expect(out.monthlyFeatureCost).toBe(200)
  })
})
