/**
 * upsell_status (MCP) — `suggestedModifiers` resuelto (Tarea 7, sync del MCP con el
 * spec B3 de opciones obligatorias: commits 7a9f6e14 / 1bd63e9f / 957bf102).
 *
 * Antes de este cambio, el tool no seleccionaba `suggestedModifiers` ni traía el
 * `modifierGroups` del producto sugerido, así que un agente no tenía forma de saber
 * si una regla pide una opción obligatoria (tamaño, sabor…) ni si esa opción está
 * resuelta. Este archivo fija el contrato nuevo.
 *
 * `resolveForDto` y `PRODUCT_VALIDATION_SELECT` quedan REALES (sólo se mockea
 * `getUpsellSurfaces`, que no importa para este campo) — la prueba corre la MISMA
 * resolución fail-open que ve el POS, no una copia simulada de ella.
 */
import { registerUpsellTools } from '../../../src/mcp/tools/upsell'
import type { McpScope } from '../../../src/mcp/scope'

const mockVenueFindUnique = jest.fn()
const mockRuleFindMany = jest.fn()
const mockGetPerformance = jest.fn()

jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn().mockResolvedValue(null) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (_perm: string, v: string) => {
      if (v === 'no-perm') throw new Error('Forbidden: missing upsells:read')
    },
  }),
}))
jest.mock('@/services/upsell/upsellImpression.service', () => ({
  getPerformance: (...a: unknown[]) => mockGetPerformance(...(a as [])),
}))
jest.mock('@/services/upsell/upsell.service', () => ({
  ...jest.requireActual('@/services/upsell/upsell.service'),
  getUpsellSurfaces: jest.fn().mockResolvedValue({ counter: true, tableOrdering: true, tablePaying: true }),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: (...a: unknown[]) => mockVenueFindUnique(...(a as [])) },
    upsellRule: { findMany: (...a: unknown[]) => mockRuleFindMany(...(a as [])) },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (args: Record<string, unknown>) => handlers.get('upsell_status')!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

const emptyPerformance = {
  attributedSales: 0,
  measuredLift: null,
  shownCount: 0,
  acceptedCount: 0,
  acceptanceRate: 0,
  holdoutCount: 0,
  avgTicketShown: 0,
  avgTicketHoldout: 0,
  hasData: false,
}

// Grupo "Tamaño" obligatorio con una sola opción — el mismo Agua Mineral 1L /
// «¿Le agregamos un agua bien fría?» del test manual en hardware (task-7-brief).
const AGUA_MODIFIER_GROUPS = [
  { group: { id: 'g_tam', name: 'Tamaño', required: true, modifiers: [{ id: 'm_gr', name: 'Grande', price: 15, active: true }] } },
]

beforeAll(() => {
  registerUpsellTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  mockGetPerformance.mockResolvedValue(emptyPerformance)
  mockVenueFindUnique.mockResolvedValue({ timezone: 'America/Mexico_City', upsellSurfaces: null })
})

describe('upsell_status', () => {
  it('rechaza un venue fuera de alcance — no lee reglas', async () => {
    await expect(call({ venueId: 'foreign' })).rejects.toThrow('out of scope')
    expect(mockRuleFindMany).not.toHaveBeenCalled()
  })

  it('rechaza sin el permiso upsells:read', async () => {
    await expect(call({ venueId: 'no-perm' })).rejects.toThrow('Forbidden')
    expect(mockRuleFindMany).not.toHaveBeenCalled()
  })

  it('una regla con selección resuelta trae nombre y precio — el mismo shape que ve el POS', async () => {
    mockRuleFindMany.mockResolvedValueOnce([
      {
        id: 'r1',
        status: 'ACTIVE',
        origin: 'OWNER',
        headline: '¿Le agregamos un agua bien fría?',
        rationale: null,
        supportCount: null,
        lift: null,
        suggestedProductId: 'prod_agua',
        suggestedModifiers: [{ groupId: 'g_tam', modifierId: 'm_gr' }],
        suggestedProduct: {
          id: 'prod_agua',
          name: 'Agua Mineral 1L',
          upsellEnabled: true,
          soldByWeight: false,
          modifierGroups: AGUA_MODIFIER_GROUPS,
        },
        linkedDiscount: null,
      },
    ])

    const out = parse(await call({ venueId: 'v1' }))

    expect(out.activas).toHaveLength(1)
    expect(out.activas[0].product).toBe('Agua Mineral 1L')
    expect(out.activas[0].suggestedModifiers).toEqual([{ groupId: 'g_tam', modifierId: 'm_gr', name: 'Grande', price: 15 }])
    expect(out.activas[0].vetadoPorElDueno).toBe(false)
  })

  it('un producto sin opciones obligatorias devuelve [] — nunca null', async () => {
    mockRuleFindMany.mockResolvedValueOnce([
      {
        id: 'r2',
        status: 'ACTIVE',
        origin: 'OWNER',
        headline: null,
        rationale: null,
        supportCount: null,
        lift: null,
        suggestedProductId: 'prod_coca',
        suggestedModifiers: null,
        suggestedProduct: { id: 'prod_coca', name: 'Coca-Cola', upsellEnabled: true, soldByWeight: false, modifierGroups: [] },
        linkedDiscount: null,
      },
    ])

    const out = parse(await call({ venueId: 'v1' }))
    expect(out.activas[0].suggestedModifiers).toEqual([])
  })

  it('una propuesta que pide talla y no la tiene resuelta también devuelve [] (fail-open, igual que el POS)', async () => {
    mockRuleFindMany.mockResolvedValueOnce([
      {
        id: 'r3',
        status: 'PROPOSED',
        origin: 'BASKET_DATA',
        headline: null,
        rationale: 'se compran juntos seguido',
        supportCount: 12,
        lift: 2.4,
        suggestedProductId: 'prod_agua',
        suggestedModifiers: [], // nunca se eligió el tamaño
        suggestedProduct: {
          id: 'prod_agua',
          name: 'Agua Mineral 1L',
          upsellEnabled: true,
          soldByWeight: false,
          modifierGroups: AGUA_MODIFIER_GROUPS,
        },
        linkedDiscount: null,
      },
    ])

    const out = parse(await call({ venueId: 'v1' }))
    expect(out.esperandoDecision).toHaveLength(1)
    expect(out.esperandoDecision[0].suggestedModifiers).toEqual([])
    expect(out.esperandoDecision[0].lift).toBe(2.4)
  })

  it('🔴 un producto vetado con talla obligatoria no tumba la respuesta — sólo esa regla vuelve con []', async () => {
    mockRuleFindMany.mockResolvedValueOnce([
      {
        id: 'r_vetado',
        status: 'ACTIVE',
        origin: 'OWNER',
        headline: null,
        rationale: null,
        supportCount: null,
        lift: null,
        suggestedProductId: 'prod_agua',
        suggestedModifiers: [{ groupId: 'g_tam', modifierId: 'm_gr' }],
        suggestedProduct: {
          id: 'prod_agua',
          name: 'Agua Mineral 1L',
          upsellEnabled: false, // vetado en su ficha después de crear la regla
          soldByWeight: false,
          modifierGroups: AGUA_MODIFIER_GROUPS,
        },
        linkedDiscount: null,
      },
      {
        id: 'r_ok',
        status: 'ACTIVE',
        origin: 'OWNER',
        headline: null,
        rationale: null,
        supportCount: null,
        lift: null,
        suggestedProductId: 'prod_coca',
        suggestedModifiers: null,
        suggestedProduct: { id: 'prod_coca', name: 'Coca-Cola', upsellEnabled: true, soldByWeight: false, modifierGroups: [] },
        linkedDiscount: null,
      },
    ])

    const out = parse(await call({ venueId: 'v1' }))

    expect(out.activas).toHaveLength(2)
    const vetada = out.activas.find((r: { product: string }) => r.product === 'Agua Mineral 1L')
    expect(vetada.vetadoPorElDueno).toBe(true)
    expect(vetada.suggestedModifiers).toEqual([])
    // La otra regla, sana, se sigue sirviendo normal.
    expect(out.activas.find((r: { product: string }) => r.product === 'Coca-Cola').suggestedModifiers).toEqual([])
  })
})
