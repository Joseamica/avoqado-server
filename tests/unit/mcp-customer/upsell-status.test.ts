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
 *
 * 🔴 Ronda 2 (2026-08-17): dos huecos más. (1) `descuentoLigado` tenía su PROPIA
 * cadena de condiciones copiada de `linkedDiscountParaPos` y se desincronizó de
 * verdad (`maxTotalUses`) — ahora reusa `evaluateLinkedDiscountForPos`, que
 * también queda REAL aquí (no mockeada) por la misma razón que `resolveForDto`.
 * (2) El tool sólo reportaba 1 de los 4 motivos por los que una regla no llega al
 * POS que el server sí puede saber — se agregan `desactivadoEnCatalogo` y
 * `pideOpcionesSinResolver`. `SIN_EXISTENCIAS` sigue sin reportarse a propósito:
 * el server no lo sabe, lo calcula el POS.
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

// Un descuento ligado que pasa TODAS las condiciones de `evaluateLinkedDiscountForPos`
// — se clona y se rompe UN campo por test para aislar cada motivo.
const DESCUENTO_ELEGIBLE = {
  name: 'Promo verano',
  type: 'PERCENTAGE',
  value: 20,
  active: true,
  scope: 'ITEM',
  targetItemIds: [] as string[],
  minPurchaseAmount: null as number | null,
  maxDiscountAmount: null as number | null,
  maxTotalUses: null as number | null,
  buyQuantity: null as number | null,
  validFrom: null as Date | null,
  validUntil: null as Date | null,
}

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
          active: true,
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
    // Selección COMPLETA: no hay nada que reportar como "sin resolver".
    expect(out.activas[0].pideOpcionesSinResolver).toBe(false)
    expect(out.activas[0].desactivadoEnCatalogo).toBe(false)
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
        suggestedProduct: {
          id: 'prod_coca',
          name: 'Coca-Cola',
          upsellEnabled: true,
          soldByWeight: false,
          active: true,
          modifierGroups: [],
        },
        linkedDiscount: null,
      },
    ])

    const out = parse(await call({ venueId: 'v1' }))
    expect(out.activas[0].suggestedModifiers).toEqual([])
    // Sin grupos obligatorios: no hay nada "sin resolver" que reportar.
    expect(out.activas[0].pideOpcionesSinResolver).toBe(false)
  })

  it('una propuesta que pide talla y no la tiene resuelta también devuelve [] (fail-open, igual que el POS) — y SÍ marca pideOpcionesSinResolver', async () => {
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
          active: true,
          modifierGroups: AGUA_MODIFIER_GROUPS,
        },
        linkedDiscount: null,
      },
    ])

    const out = parse(await call({ venueId: 'v1' }))
    expect(out.esperandoDecision).toHaveLength(1)
    expect(out.esperandoDecision[0].suggestedModifiers).toEqual([])
    expect(out.esperandoDecision[0].lift).toBe(2.4)
    // 🔴 Antes de este campo, "no pide nada" (test anterior) y "pide y no está
    // resuelto" (este caso) se veían IDÉNTICOS: los dos daban `suggestedModifiers: []`.
    expect(out.esperandoDecision[0].pideOpcionesSinResolver).toBe(true)
  })

  it('🔴 un producto vetado con talla obligatoria no tumba la respuesta — sólo esa regla vuelve con [], y el veto gana sobre "pide opciones"', async () => {
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
          active: true,
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
        suggestedProduct: {
          id: 'prod_coca',
          name: 'Coca-Cola',
          upsellEnabled: true,
          soldByWeight: false,
          active: true,
          modifierGroups: [],
        },
        linkedDiscount: null,
      },
    ])

    const out = parse(await call({ venueId: 'v1' }))

    expect(out.activas).toHaveLength(2)
    const vetada = out.activas.find((r: { product: string }) => r.product === 'Agua Mineral 1L')
    expect(vetada.vetadoPorElDueno).toBe(true)
    expect(vetada.suggestedModifiers).toEqual([])
    expect(vetada.desactivadoEnCatalogo).toBe(false)
    // 🔴 El producto SÍ trae una talla sin resolver en la selección de la regla,
    // pero `validateAndResolveModifiers` lanza por el veto ANTES de llegar a
    // revisar modificadores — el veto gana, y el motivo reportado es UNO solo.
    expect(vetada.pideOpcionesSinResolver).toBe(false)
    // La otra regla, sana, se sigue sirviendo normal.
    const sana = out.activas.find((r: { product: string }) => r.product === 'Coca-Cola')
    expect(sana.suggestedModifiers).toEqual([])
    expect(sana.pideOpcionesSinResolver).toBe(false)
    expect(sana.desactivadoEnCatalogo).toBe(false)
  })

  it('🔴 un producto desactivado en el catálogo reporta desactivadoEnCatalogo — la regla se sigue sirviendo aunque el server también la filtre al armar la tabla del POS', async () => {
    mockRuleFindMany.mockResolvedValueOnce([
      {
        id: 'r_desactivado',
        status: 'ACTIVE',
        origin: 'OWNER',
        headline: null,
        rationale: null,
        supportCount: null,
        lift: null,
        suggestedProductId: 'prod_coca',
        suggestedModifiers: null,
        suggestedProduct: {
          id: 'prod_coca',
          name: 'Coca-Cola',
          upsellEnabled: true, // NO vetado — el motivo es otro
          soldByWeight: false,
          active: false, // apagado en el catálogo
          modifierGroups: [],
        },
        linkedDiscount: null,
      },
    ])

    const out = parse(await call({ venueId: 'v1' }))

    expect(out.activas).toHaveLength(1)
    expect(out.activas[0].vetadoPorElDueno).toBe(false)
    expect(out.activas[0].desactivadoEnCatalogo).toBe(true)
  })

  it('un descuento elegible SÍ llega al POS', async () => {
    mockRuleFindMany.mockResolvedValueOnce([
      {
        id: 'r_promo_ok',
        status: 'ACTIVE',
        origin: 'PROMOTION',
        headline: null,
        rationale: null,
        supportCount: null,
        lift: null,
        suggestedProductId: 'prod_coca',
        suggestedModifiers: null,
        suggestedProduct: {
          id: 'prod_coca',
          name: 'Coca-Cola',
          upsellEnabled: true,
          soldByWeight: false,
          active: true,
          modifierGroups: [],
        },
        linkedDiscount: { ...DESCUENTO_ELEGIBLE },
      },
    ])

    const out = parse(await call({ venueId: 'v1' }))

    expect(out.activas[0].descuentoLigado).toEqual({
      nombre: 'Promo verano',
      tipo: 'PERCENTAGE',
      valor: 20,
      llegaAlPos: true,
      porQueNoLlega: null,
    })
  })

  it('🔴 un descuento con tope de usos NO llega al POS aunque cumpla todo lo demás — antes esta copia no lo sabía (divergencia real del commit 8501d866)', async () => {
    mockRuleFindMany.mockResolvedValueOnce([
      {
        id: 'r_tope_usos',
        status: 'ACTIVE',
        origin: 'PROMOTION',
        headline: null,
        rationale: null,
        supportCount: null,
        lift: null,
        suggestedProductId: 'prod_coca',
        suggestedModifiers: null,
        suggestedProduct: {
          id: 'prod_coca',
          name: 'Coca-Cola',
          upsellEnabled: true,
          soldByWeight: false,
          active: true,
          modifierGroups: [],
        },
        // Sólo rompe `maxTotalUses` — todo lo demás es idéntico al caso elegible.
        linkedDiscount: { ...DESCUENTO_ELEGIBLE, maxTotalUses: 100 },
      },
    ])

    const out = parse(await call({ venueId: 'v1' }))

    expect(out.activas[0].descuentoLigado.llegaAlPos).toBe(false)
    expect(out.activas[0].descuentoLigado.porQueNoLlega).toMatch(/tope de usos/i)
  })
})
