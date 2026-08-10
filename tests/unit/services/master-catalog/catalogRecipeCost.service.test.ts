import { ProductType, Unit } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { calculateRecipeCostV1, RecipeCostCalculationError } from '@/services/dashboard/recipe-cost-calculator'
import { evaluatePreparedDishBinding, hashCatalogRecipeLinesV1 } from '@/services/master-catalog/catalogRecipeCost.service'

// WHY: These fixtures mirror the Prisma projections used by the read-only H1
// evaluator while keeping every money/quantity value in Decimal form.
function recipeLine(overrides: Record<string, unknown> = {}) {
  return {
    id: 'line-1',
    displayOrder: 0,
    rawMaterialId: 'raw-1',
    quantity: new Decimal('1'),
    unit: Unit.KILOGRAM,
    costPerServing: new Decimal('62.5000'),
    rawMaterial: {
      id: 'raw-1',
      venueId: 'venue-1',
      unit: Unit.GRAM,
      costPerUnit: new Decimal('0.5000'),
      active: true,
      deletedAt: null,
    },
    ...overrides,
  }
}

// WHY: Tenant and catalog identity are resolved from the binding before recipe
// data is read; this shape lets each test vary only the readiness condition.
function preparedBinding(kind: 'RETAIL_PRODUCT' | 'PREPARED_DISH' = 'PREPARED_DISH') {
  return {
    id: 'binding-1',
    revision: 3,
    status: 'LINKED',
    product: { id: 'product-1', venueId: 'venue-1' },
    catalogItem: {
      id: 'item-1',
      revision: 7,
      status: 'ACTIVE',
      kind,
      productType: kind === 'PREPARED_DISH' ? ProductType.FOOD_AND_BEV : ProductType.REGULAR,
    },
  }
}

function recipe(overrides: Record<string, unknown> = {}) {
  return {
    id: 'recipe-1',
    portionYield: 8,
    prepTime: 10,
    totalCost: new Decimal('62.5000'),
    updatedAt: new Date('2026-08-08T12:00:00.000Z'),
    lines: [recipeLine()],
    ...overrides,
  }
}

function readClient(binding = preparedBinding(), recipeRow: ReturnType<typeof recipe> | null = recipe()) {
  return {
    catalogVenueBinding: { findFirst: jest.fn().mockResolvedValue(binding) },
    recipe: { findFirst: jest.fn().mockResolvedValue(recipeRow) },
  } as any
}

describe('calculateRecipeCostV1', () => {
  it('uses Decimal conversion and stores the batch result as a per-portion cost', () => {
    const result = calculateRecipeCostV1({ portionYield: 8, lines: [recipeLine()] })

    // WHY: This is the frozen H1 example: 1kg × $0.50/g / 8 portions.
    expect(result.batchCost.toFixed(4)).toBe('500.0000')
    expect(result.costPerPortion.toFixed(4)).toBe('62.5000')
    expect(result.lines[0].costPerServing.toFixed(4)).toBe('62.5000')
  })

  it('rounds per-portion and line values to four decimals with HALF_UP', () => {
    const result = calculateRecipeCostV1({
      portionYield: 6,
      lines: [
        recipeLine({
          quantity: new Decimal('1'),
          unit: Unit.PIECE,
          rawMaterial: {
            id: 'raw-1',
            venueId: 'venue-1',
            unit: Unit.PIECE,
            costPerUnit: new Decimal('1'),
            active: true,
            deletedAt: null,
          },
        }),
      ],
    })

    expect(result.costPerPortion.toFixed(4)).toBe('0.1667')
    expect(result.lines[0].costPerServing.toFixed(4)).toBe('0.1667')
  })

  it('rounds an exact four-decimal tie upward rather than HALF_EVEN', () => {
    const result = calculateRecipeCostV1({
      portionYield: 10,
      lines: [
        recipeLine({
          quantity: new Decimal('0.001'),
          unit: Unit.PIECE,
          rawMaterial: {
            id: 'raw-1',
            venueId: 'venue-1',
            unit: Unit.PIECE,
            costPerUnit: new Decimal('0.5000'),
            active: true,
            deletedAt: null,
          },
        }),
      ],
    })

    // WHY: 0.00005 is the discriminating tie: HALF_EVEN would persist zero,
    // while the frozen money contract requires HALF_UP for aggregate and line.
    expect(result.batchCost.toFixed(4)).toBe('0.0005')
    expect(result.costPerPortion.toFixed(4)).toBe('0.0001')
    expect(result.lines[0].costPerServing.toFixed(4)).toBe('0.0001')
  })

  it('treats an empty legacy recipe as a valid zero-cost calculation', () => {
    const result = calculateRecipeCostV1({ portionYield: 8, lines: [] })

    // WHY: Mutating legacy empty recipes must remain compatible; readiness owns
    // the separate EMPTY_LINES finding before it invokes this neutral helper.
    expect(result.batchCost.toFixed(4)).toBe('0.0000')
    expect(result.costPerPortion.toFixed(4)).toBe('0.0000')
    expect(result.lines).toEqual([])
  })

  it.each([
    ['non-positive yield', { portionYield: 0, lines: [recipeLine()] }],
    ['non-positive quantity', { portionYield: 1, lines: [recipeLine({ quantity: new Decimal('0') })] }],
    [
      'incompatible units',
      {
        portionYield: 1,
        lines: [
          recipeLine({
            unit: Unit.LITER,
            rawMaterial: {
              id: 'raw-1',
              venueId: 'venue-1',
              unit: Unit.GRAM,
              costPerUnit: new Decimal('1'),
              active: true,
              deletedAt: null,
            },
          }),
        ],
      },
    ],
  ])('rejects %s instead of producing a misleading Decimal', (_label, input) => {
    expect(() => calculateRecipeCostV1(input as any)).toThrow(RecipeCostCalculationError)
  })
})

describe('hashCatalogRecipeLinesV1', () => {
  it('is canonical by displayOrder/id and excludes the derived costPerServing column', () => {
    const first = recipeLine({ id: 'line-b', displayOrder: 2, costPerServing: new Decimal('999') })
    const second = recipeLine({ id: 'line-a', displayOrder: 1, costPerServing: null })

    const hashA = hashCatalogRecipeLinesV1([first, second])
    const hashB = hashCatalogRecipeLinesV1([second, first])

    expect(hashA).toMatch(/^[a-f0-9]{64}$/)
    expect(hashA).toBe(hashB)
    expect(hashA).toBe(
      hashCatalogRecipeLinesV1([
        { ...second, costPerServing: new Decimal('12.3456') },
        { ...first, costPerServing: null },
      ]),
    )
    expect(hashA).not.toBe(hashCatalogRecipeLinesV1([second, { ...first, quantity: new Decimal('2') }]))
  })
})

describe('evaluatePreparedDishBinding', () => {
  const target = { organizationId: 'org-1', venueId: 'venue-1', productId: 'product-1' }

  it('treats a valid RETAIL binding as baseline-ready without reading Recipe', async () => {
    const db = readClient(preparedBinding('RETAIL_PRODUCT'), null)

    const result = await evaluatePreparedDishBinding(db, target)

    expect(result.state).toBe('READY')
    expect(result.findings).toEqual([])
    expect(db.recipe.findFirst).not.toHaveBeenCalled()
  })

  it('reports the frozen PREPARED_DISH invalid states without mutating legacy rows', async () => {
    const cases = [
      [null, 'MISSING_RECIPE'],
      [recipe({ portionYield: 0 }), 'INVALID_PORTION_YIELD'],
      [recipe({ prepTime: null }), 'MISSING_PREP_TIME'],
      [recipe({ prepTime: 0 }), 'MISSING_PREP_TIME'],
      [recipe({ prepTime: -1 }), 'MISSING_PREP_TIME'],
      [recipe({ prepTime: 1.5 }), 'MISSING_PREP_TIME'],
      [recipe({ lines: [] }), 'EMPTY_LINES'],
      [recipe({ lines: [recipeLine({ quantity: new Decimal('0') })] }), 'INVALID_RECIPE_LINE'],
    ] as const

    for (const [recipeRow, findingCode] of cases) {
      const db = readClient(preparedBinding(), recipeRow as any)
      const result = await evaluatePreparedDishBinding(db, target)

      expect(result.state).toBe('INVALID')
      expect(result.findings.map(finding => finding.code)).toContain(findingCode)
    }
  })

  it('returns STALE when Recipe.totalCost is not the calculated cost per portion', async () => {
    const db = readClient(preparedBinding(), recipe({ totalCost: new Decimal('500.0000') }))

    const result = await evaluatePreparedDishBinding(db, target)

    expect(result.state).toBe('STALE')
    expect(result.findings.map(finding => finding.code)).toEqual(['RECIPE_COST_STALE'])
    expect(result.costs).toEqual({
      batchCost: '500.0000',
      costPerPortion: '62.5000',
      storedCostPerPortion: '500.0000',
    })
  })

  it('keeps an explicitly reviewed zero-cost recipe READY', async () => {
    const zeroLine = recipeLine({
      costPerServing: new Decimal('0'),
      rawMaterial: { ...recipeLine().rawMaterial, costPerUnit: new Decimal('0') },
    })
    const result = await evaluatePreparedDishBinding(
      readClient(preparedBinding(), recipe({ totalCost: new Decimal('0'), lines: [zeroLine] })),
      target,
    )

    expect(result.state).toBe('READY')
    expect(result.costs).toEqual({ batchCost: '0.0000', costPerPortion: '0.0000', storedCostPerPortion: '0.0000' })
  })

  it.each([
    ['negative cost', recipeLine({ rawMaterial: { ...recipeLine().rawMaterial, costPerUnit: new Decimal('-0.1') } }), 'INVALID_LINE_COST'],
    ['inactive RM', recipeLine({ rawMaterial: { ...recipeLine().rawMaterial, active: false } }), 'RAW_MATERIAL_INACTIVE'],
    ['deleted RM', recipeLine({ rawMaterial: { ...recipeLine().rawMaterial, deletedAt: new Date() } }), 'RAW_MATERIAL_INACTIVE'],
    ['incompatible unit', recipeLine({ unit: Unit.LITER }), 'INCOMPATIBLE_LINE_UNIT'],
  ])('reports %s as a stable invalid line before exposing costs', async (_label, line, reason) => {
    const result = await evaluatePreparedDishBinding(readClient(preparedBinding(), recipe({ lines: [line] })), target)

    expect(result.state).toBe('INVALID')
    expect(result.findings).toEqual([expect.objectContaining({ code: 'INVALID_RECIPE_LINE', reason })])
    expect(result.costs).toBeUndefined()
  })

  it('rejects an invalid kind/ProductType matrix before any Recipe read', async () => {
    const invalidBinding = {
      ...preparedBinding(),
      catalogItem: { ...preparedBinding().catalogItem, productType: ProductType.REGULAR },
    }
    const db = readClient(invalidBinding as any, recipe())

    const result = await evaluatePreparedDishBinding(db, target)

    expect(result.state).toBe('INVALID')
    expect(result.findings).toEqual([{ code: 'PRODUCT_TYPE_INVALID' }])
    expect(db.recipe.findFirst).not.toHaveBeenCalled()
  })

  it('invalidates a corrupt cross-venue raw-material reference without exposing the foreign row', async () => {
    const db = readClient(
      preparedBinding(),
      recipe({ lines: [recipeLine({ rawMaterial: { ...recipeLine().rawMaterial, venueId: 'venue-2' } })] }),
    )

    const result = await evaluatePreparedDishBinding(db, target)

    // WHY: A legacy/corrupt FK must not let one Venue price a dish from another
    // Venue's ingredient even after the binding itself passed tenant scoping.
    expect(result.state).toBe('INVALID')
    expect(result.findings).toEqual([
      expect.objectContaining({ code: 'INVALID_RECIPE_LINE', lineId: 'line-1', reason: 'RAW_MATERIAL_VENUE_MISMATCH' }),
    ])
    expect(result.dependencies).toEqual(expect.objectContaining({ recipeId: null, recipeUpdatedAt: null, recipeLineHash: null }))
    expect(result.costs).toBeUndefined()
  })

  it('scopes the second Recipe read by Product venue and fails closed if the binding disappears', async () => {
    const db = readClient(preparedBinding(), null)
    db.catalogVenueBinding.findFirst.mockResolvedValueOnce(preparedBinding()).mockResolvedValueOnce(null)

    await expect(evaluatePreparedDishBinding(db, target)).rejects.toMatchObject({ statusCode: 404 })
    expect(db.recipe.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { productId: 'product-1', product: { venueId: 'venue-1' } } }),
    )
    // WHY: A null scoped Recipe is ambiguous with a Product moved/deleted after
    // the first statement, so provenance is revalidated before MISSING_RECIPE.
    expect(db.catalogVenueBinding.findFirst).toHaveBeenCalledTimes(2)
  })

  it('returns a complete result with immutable recipe timestamp and canonical line hash dependencies', async () => {
    const row = recipe()
    const db = readClient(preparedBinding(), row)

    const result = await evaluatePreparedDishBinding(db, target)

    expect(result.state).toBe('READY')
    expect(result.findings).toEqual([])
    expect(result.dependencies).toEqual(
      expect.objectContaining({
        bindingId: 'binding-1',
        bindingRevision: 3,
        catalogItemId: 'item-1',
        catalogItemRevision: 7,
        recipeId: 'recipe-1',
        recipeUpdatedAt: '2026-08-08T12:00:00.000Z',
        recipeLineHash: hashCatalogRecipeLinesV1(row.lines),
      }),
    )
  })

  it('fails closed across tenant boundaries', async () => {
    const db = readClient(undefined as any, null)
    db.catalogVenueBinding.findFirst.mockResolvedValue(null)

    await expect(evaluatePreparedDishBinding(db, target)).rejects.toMatchObject({ statusCode: 404 })
    expect(db.catalogVenueBinding.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-1', venueId: 'venue-1', productId: 'product-1' } }),
    )
  })

  it.each([
    ['PENDING binding', { ...preparedBinding(), status: 'PENDING' }],
    ['UNLINKED binding', { ...preparedBinding(), status: 'UNLINKED' }],
    ['retired CatalogItem', { ...preparedBinding(), catalogItem: { ...preparedBinding().catalogItem, status: 'RETIRED' } }],
  ])('does not expose readiness for a %s', async (_label, binding) => {
    const db = readClient(binding as any, recipe())

    await expect(evaluatePreparedDishBinding(db, target)).rejects.toMatchObject({ statusCode: 404 })
    expect(db.recipe.findFirst).not.toHaveBeenCalled()
  })
})
