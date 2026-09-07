/**
 * Recipe tools for the customer MCP (Asana "MCP Claude - Permitir crear recetas desde Claude").
 *
 * The recipe engine already existed (recipe.service.createRecipe, with its advisory locks,
 * unit-compatibility guard and storable-quantity guard) and the dashboard chatbot already
 * drove it from natural language. The MCP had NO recipe tool at all — it could create the
 * ingredients (create_raw_material) but never the recipe that consumes them, and could not
 * read one back.
 *
 * Three tools ship here:
 *   - list_raw_materials — the pantry, so the model never invents an ingredient name
 *   - get_recipe         — read one back
 *   - create_recipe      — create it, previewing by default
 *
 * The rule that separates this from the chatbot: resolution is ALL OR NOTHING. The chatbot's
 * resolveRecipeLines does `continue // Skip unresolvable ingredients`, so a recipe is silently
 * born missing an ingredient — it then costs less than it should and under-deducts stock on
 * every sale, with nobody informed. Here an unresolved or ambiguous name aborts the whole
 * write and hands back the candidates.
 */
import { registerRecipeTools, pickMatchV1 } from '../../../src/mcp/tools/recipes'
import type { McpScope } from '../../../src/mcp/scope'

const mockCreateRecipe = jest.fn()
const mockGetRecipe = jest.fn()
const mockPlanGate = jest.fn()
const mockRawMaterialFindMany = jest.fn()
const mockProductFindMany = jest.fn()

jest.mock('@/mcp/planGate', () => ({ planGateMessage: (...a: unknown[]) => mockPlanGate(...(a as [])) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({
    venueFilter: (v: string) => {
      if (v === 'foreign') throw new Error('ScopeError: venue out of scope')
      return { venueId: { in: [v] } }
    },
    requirePermission: (perm: string, v: string) => {
      if (v === 'no-perm') throw new Error(`Forbidden: missing ${perm}`)
      if (v === 'read-only' && perm === 'inventory:create') throw new Error(`Forbidden: missing ${perm}`)
    },
  }),
}))
jest.mock('@/services/dashboard/recipe.service', () => ({
  createRecipe: (...a: unknown[]) => mockCreateRecipe(...(a as [])),
  getRecipe: (...a: unknown[]) => mockGetRecipe(...(a as [])),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    rawMaterial: { findMany: (...a: unknown[]) => mockRawMaterialFindMany(...(a as [])) },
    product: { findMany: (...a: unknown[]) => mockProductFindMany(...(a as [])) },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
const call = (name: string, args: Record<string, unknown>) => handlers.get(name)!(args, {})
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)

const AVOCADO = {
  id: 'rm-avocado',
  name: 'Aguacate',
  sku: 'AGUA-1',
  category: 'FRUITS',
  unit: 'KILOGRAM',
  currentStock: 12,
  costPerUnit: 90,
}
const BREAD = { id: 'rm-bread', name: 'Pan de caja', sku: 'PAN-1', category: 'BREAD', unit: 'PIECE', currentStock: 40, costPerUnit: 4 }
const TOAST = { id: 'prod-toast', name: 'Avo Toast', sku: 'AVO-1', price: 120 }

beforeAll(() => {
  registerRecipeTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})
beforeEach(() => {
  jest.clearAllMocks()
  mockPlanGate.mockResolvedValue(null) // entitled (PREMIUM) by default
  mockProductFindMany.mockResolvedValue([TOAST])
  mockRawMaterialFindMany.mockResolvedValue([AVOCADO, BREAD])
})

// ---------------------------------------------------------------------------
// pickMatchV1 — the pure resolver. Every "never guess" guarantee lives here.
// ---------------------------------------------------------------------------
describe('pickMatchV1 resolves a name to exactly one row, or refuses', () => {
  const rows = [
    { id: 'a', name: 'Aguacate' },
    { id: 'b', name: 'Aguacate Hass' },
    { id: 'c', name: 'Pan de caja' },
  ]

  it('matches by id when the query is an id', () => {
    expect(pickMatchV1('b', rows)).toEqual({ kind: 'match', item: rows[1] })
  })

  it('prefers an exact name over rows that merely contain it', () => {
    // "Aguacate" is contained in "Aguacate Hass"; without this rule the write is ambiguous
    // and the operator is blocked on a name that is, in fact, exactly one ingredient.
    expect(pickMatchV1('Aguacate', rows)).toEqual({ kind: 'match', item: rows[0] })
  })

  it('ignores case and surrounding spaces on the exact match', () => {
    expect(pickMatchV1('  aguacate  ', rows)).toEqual({ kind: 'match', item: rows[0] })
  })

  it('matches a single partial', () => {
    expect(pickMatchV1('Hass', rows)).toEqual({ kind: 'match', item: rows[1] })
  })

  it('refuses when two rows match partially, handing back the candidates', () => {
    const out = pickMatchV1('Agua', rows)
    expect(out.kind).toBe('ambiguous')
    expect(out.kind === 'ambiguous' && out.candidates.map(c => c.name)).toEqual(['Aguacate', 'Aguacate Hass'])
  })

  it('refuses when nothing matches — it never falls back to "the closest one"', () => {
    expect(pickMatchV1('Aguardiente', rows)).toEqual({ kind: 'none' })
  })

  it('refuses on two rows sharing an exact name rather than taking the first', () => {
    const dupes = [
      { id: 'a', name: 'Sal' },
      { id: 'b', name: 'sal' },
    ]
    expect(pickMatchV1('Sal', dupes).kind).toBe('ambiguous')
  })
})

// ---------------------------------------------------------------------------
// create_recipe
// ---------------------------------------------------------------------------
describe('create_recipe', () => {
  const args = (over: Record<string, unknown> = {}) => ({
    venueId: 'v1',
    product: 'Avo Toast',
    portionYield: 1,
    lines: [
      { ingredient: 'Aguacate', quantity: 0.1, unit: 'KILOGRAM' },
      { ingredient: 'Pan de caja', quantity: 2, unit: 'PIECE' },
    ],
    confirm: true,
    ...over,
  })

  it('rejects an out-of-scope venue', async () => {
    await expect(call('create_recipe', args({ venueId: 'foreign' }))).rejects.toThrow('out of scope')
  })

  it('requires inventory:create — inventory:read alone cannot write a recipe', async () => {
    await expect(call('create_recipe', args({ venueId: 'read-only' }))).rejects.toThrow('inventory:create')
    expect(mockCreateRecipe).not.toHaveBeenCalled()
  })

  it('fires the PREMIUM gate and writes nothing when the venue lacks INVENTORY_TRACKING', async () => {
    mockPlanGate.mockResolvedValueOnce('El control de inventario requiere PREMIUM')
    const out = parse(await call('create_recipe', args()))
    expect(out.planRequired).toBe(true)
    expect(mockCreateRecipe).not.toHaveBeenCalled()
  })

  it('PREVIEWS by default: no confirm means nothing is written', async () => {
    const out = parse(await call('create_recipe', args({ confirm: undefined })))
    expect(out.preview).toBe(true)
    expect(mockCreateRecipe).not.toHaveBeenCalled()
    // The preview must name the ingredient it resolved AND the unit it is stored in —
    // that pair is where "20 g" silently becomes "20 kg" of cost and stock.
    expect(out.receta.ingredientes[0]).toMatchObject({ insumo: 'Aguacate', cantidad: 0.1, unidad: 'KILOGRAM', seGuardaEn: 'KILOGRAM' })
    expect(out.receta.costoPorPorcion).toBe(17)
  })

  it('writes when confirmed, passing resolved ids to the existing service', async () => {
    mockCreateRecipe.mockResolvedValue({ id: 'rec-1', totalCost: 17, lines: [] })
    const out = parse(await call('create_recipe', args()))
    expect(out.ok).toBe(true)
    expect(mockCreateRecipe).toHaveBeenCalledWith(
      'v1',
      'prod-toast',
      expect.objectContaining({
        portionYield: 1,
        lines: [
          expect.objectContaining({ rawMaterialId: 'rm-avocado', quantity: 0.1, unit: 'KILOGRAM' }),
          expect.objectContaining({ rawMaterialId: 'rm-bread', quantity: 2, unit: 'PIECE' }),
        ],
      }),
      expect.objectContaining({ staffId: 's1', source: 'customer-mcp' }),
    )
  })

  it('ABORTS the whole write when one ingredient cannot be resolved — never skips it silently', async () => {
    const out = parse(
      await call(
        'create_recipe',
        args({
          lines: [
            { ingredient: 'Aguacate', quantity: 0.1, unit: 'KILOGRAM' },
            { ingredient: 'Trufa negra', quantity: 5, unit: 'GRAM' },
          ],
        }),
      ),
    )
    expect(out.ok).toBe(false)
    expect(mockCreateRecipe).not.toHaveBeenCalled()
    expect(out.error).toContain('Trufa negra')
  })

  it('ABORTS when an ingredient name is ambiguous, listing the candidates', async () => {
    mockRawMaterialFindMany.mockResolvedValue([AVOCADO, { ...AVOCADO, id: 'rm-hass', name: 'Aguacate Hass' }])
    const out = parse(await call('create_recipe', args({ lines: [{ ingredient: 'Agua', quantity: 0.1, unit: 'KILOGRAM' }] })))
    expect(out.ok).toBe(false)
    expect(mockCreateRecipe).not.toHaveBeenCalled()
    expect(out.candidatos).toEqual(expect.arrayContaining([expect.objectContaining({ nombre: 'Aguacate Hass' })]))
  })

  it('ABORTS when the product cannot be resolved', async () => {
    mockProductFindMany.mockResolvedValue([])
    const out = parse(await call('create_recipe', args({ product: 'Platillo fantasma' })))
    expect(out.ok).toBe(false)
    expect(mockCreateRecipe).not.toHaveBeenCalled()
  })

  it('rejects the same ingredient twice before touching the database', async () => {
    const out = parse(
      await call(
        'create_recipe',
        args({
          lines: [
            { ingredient: 'Aguacate', quantity: 0.1, unit: 'KILOGRAM' },
            { ingredient: 'aguacate', quantity: 0.2, unit: 'KILOGRAM' },
          ],
        }),
      ),
    )
    expect(out.ok).toBe(false)
    expect(mockCreateRecipe).not.toHaveBeenCalled()
  })

  it('rejects a unit that is incompatible with how the ingredient is stored', async () => {
    // Aguacate lives in KILOGRAM (mass); LITER is volume. The service would reject this too,
    // but catching it in the preview means the operator sees it BEFORE confirming.
    const out = parse(
      await call('create_recipe', args({ lines: [{ ingredient: 'Aguacate', quantity: 1, unit: 'LITER' }], confirm: undefined })),
    )
    expect(out.ok).toBe(false)
    expect(out.error).toContain('Aguacate')
  })

  it('rejects a quantity the database would round away to zero', async () => {
    const out = parse(
      await call('create_recipe', args({ lines: [{ ingredient: 'Aguacate', quantity: 0.0001, unit: 'KILOGRAM' }], confirm: undefined })),
    )
    expect(out.ok).toBe(false)
    expect(mockCreateRecipe).not.toHaveBeenCalled()
  })

  it('surfaces the service error verbatim instead of throwing', async () => {
    mockCreateRecipe.mockRejectedValue(new Error('Recipe already exists for product Avo Toast'))
    const out = parse(await call('create_recipe', args()))
    expect(out.ok).toBe(false)
    expect(out.error).toContain('Recipe already exists')
  })
})

// ---------------------------------------------------------------------------
// get_recipe / list_raw_materials
// ---------------------------------------------------------------------------
describe('get_recipe', () => {
  it('says the product has no recipe yet instead of returning an empty shell', async () => {
    mockGetRecipe.mockResolvedValue(null)
    const out = parse(await call('get_recipe', { venueId: 'v1', product: 'Avo Toast' }))
    expect(out.ok).toBe(true)
    expect(out.receta).toBeNull()
    expect(out.mensaje).toContain('no tiene receta')
  })

  it('returns the lines with cost and yield', async () => {
    mockGetRecipe.mockResolvedValue({
      id: 'rec-1',
      portionYield: 2,
      totalCost: 17,
      prepTime: 5,
      cookTime: null,
      notes: null,
      product: { id: 'prod-toast', name: 'Avo Toast' },
      lines: [{ id: 'l1', quantity: 0.1, unit: 'KILOGRAM', costPerServing: 9, isOptional: false, rawMaterial: AVOCADO }],
    })
    const out = parse(await call('get_recipe', { venueId: 'v1', product: 'Avo Toast' }))
    expect(out.receta.rindePorciones).toBe(2)
    expect(out.receta.ingredientes[0]).toMatchObject({ insumo: 'Aguacate', cantidad: 0.1, unidad: 'KILOGRAM' })
  })

  it('is gated by the PREMIUM plan like every other inventory read', async () => {
    mockPlanGate.mockResolvedValueOnce('El control de inventario requiere PREMIUM')
    const out = parse(await call('get_recipe', { venueId: 'v1', product: 'Avo Toast' }))
    expect(out.planRequired).toBe(true)
    expect(mockGetRecipe).not.toHaveBeenCalled()
  })
})

describe('list_raw_materials', () => {
  it('returns the pantry with the unit each ingredient is stored in', async () => {
    const out = parse(await call('list_raw_materials', { venueId: 'v1' }))
    expect(out.insumos[0]).toMatchObject({ nombre: 'Aguacate', unidad: 'KILOGRAM' })
  })

  it('caps the page size so a large pantry cannot blow up the response', async () => {
    await call('list_raw_materials', { venueId: 'v1', limit: 5000 })
    expect(mockRawMaterialFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: expect.any(Number) }))
    expect(mockRawMaterialFindMany.mock.calls[0][0].take).toBeLessThanOrEqual(200)
  })

  it('only ever reads active, non-deleted ingredients of the requested venue', async () => {
    await call('list_raw_materials', { venueId: 'v1' })
    expect(mockRawMaterialFindMany.mock.calls[0][0].where).toMatchObject({ venueId: 'v1', active: true, deletedAt: null })
  })

  it('is gated by the PREMIUM plan', async () => {
    mockPlanGate.mockResolvedValueOnce('El control de inventario requiere PREMIUM')
    const out = parse(await call('list_raw_materials', { venueId: 'v1' }))
    expect(out.planRequired).toBe(true)
    expect(mockRawMaterialFindMany).not.toHaveBeenCalled()
  })
})
