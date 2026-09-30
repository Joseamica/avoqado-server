// Guards the trial→real conversion against destroying user-captured data.
//
// Real prod bug (audit 2026-08-12, verified): cleanDemoData zeroed NON-demo
// Inventory and RawMaterial stock (`updateMany({ where: { isDemo: false },
// data: { currentStock: 0 } })`) and deleted ALL RawMaterialMovements and
// StockBatches of the venue — wiping the real inventory the user captured
// during the trial. The cleanup must only ever touch isDemo:true data.

import { prismaMock } from '@tests/__helpers__/setup'
import { cleanDemoData } from '@/services/onboarding/demoCleanup.service'

const VENUE_ID = 'venue-1'

// Every model cleanDemoData mutates or reads. jest.clearAllMocks() in the
// global beforeEach wipes return values, so re-prime before each test.
const TOUCHED_MODELS = [
  'payment',
  'order',
  'orderItem',
  'review',
  'rawMaterialMovement',
  'stockBatch',
  'venuePaymentConfig',
  'venuePricingStructure',
  'providerCostStructure',
  'merchantAccount',
  'customer',
  'recipeLine',
  'recipe',
  'inventory',
  'product',
  'productModifierGroup',
  'modifier',
  'modifierGroup',
  'menuCategory',
  'menuCategoryAssignment',
  'menu',
  'table',
  'area',
  'customerGroup',
  'loyaltyConfig',
  'rawMaterial',
] as const

describe('cleanDemoData (trial→real conversion)', () => {
  beforeEach(() => {
    for (const model of TOUCHED_MODELS) {
      const mock = (prismaMock as any)[model]
      mock.deleteMany?.mockResolvedValue({ count: 0 })
      mock.updateMany?.mockResolvedValue({ count: 0 })
      mock.findMany?.mockResolvedValue([])
      mock.findUnique?.mockResolvedValue(null)
    }
  })

  // ==========================================
  // THE BUG: user-captured (non-demo) inventory must survive conversion
  // ==========================================

  it('never zeroes non-demo Inventory stock', async () => {
    await cleanDemoData(VENUE_ID)

    expect(prismaMock.inventory.updateMany).not.toHaveBeenCalled()
  })

  it('never zeroes non-demo RawMaterial stock or cost', async () => {
    await cleanDemoData(VENUE_ID)

    expect(prismaMock.rawMaterial.updateMany).not.toHaveBeenCalled()
  })

  it('only deletes RawMaterialMovements belonging to demo raw materials', async () => {
    await cleanDemoData(VENUE_ID)

    expect(prismaMock.rawMaterialMovement.deleteMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.rawMaterialMovement.deleteMany).toHaveBeenCalledWith({
      where: { venueId: VENUE_ID, rawMaterial: { isDemo: true } },
    })
  })

  it('only deletes StockBatches belonging to demo raw materials (preserves the FIFO chain of real stock)', async () => {
    await cleanDemoData(VENUE_ID)

    expect(prismaMock.stockBatch.deleteMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.stockBatch.deleteMany).toHaveBeenCalledWith({
      where: { venueId: VENUE_ID, rawMaterial: { isDemo: true } },
    })
  })

  // ==========================================
  // REGRESSION: demo data is still cleaned as before
  // ==========================================

  it('still deletes only isDemo Inventory records', async () => {
    await cleanDemoData(VENUE_ID)

    expect(prismaMock.inventory.deleteMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.inventory.deleteMany).toHaveBeenCalledWith({
      where: { venueId: VENUE_ID, isDemo: true },
    })
  })

  it('still deletes only isDemo RawMaterials', async () => {
    await cleanDemoData(VENUE_ID)

    expect(prismaMock.rawMaterial.deleteMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.rawMaterial.deleteMany).toHaveBeenCalledWith({
      where: { venueId: VENUE_ID, isDemo: true },
    })
  })

  it('still deletes all orders and payments of the venue (transactional demo data)', async () => {
    await cleanDemoData(VENUE_ID)

    expect(prismaMock.payment.deleteMany).toHaveBeenCalledWith({ where: { venueId: VENUE_ID } })
    expect(prismaMock.order.deleteMany).toHaveBeenCalledWith({ where: { venueId: VENUE_ID } })
  })

  it('still deletes only isDemo Products', async () => {
    await cleanDemoData(VENUE_ID)

    expect(prismaMock.product.deleteMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.product.deleteMany).toHaveBeenCalledWith({
      where: { venueId: VENUE_ID, isDemo: true },
    })
  })

  it('reports the demo-scoped movement/batch deletions in the result', async () => {
    prismaMock.rawMaterialMovement.deleteMany.mockResolvedValue({ count: 3 })
    prismaMock.stockBatch.deleteMany.mockResolvedValue({ count: 2 })

    const result = await cleanDemoData(VENUE_ID)

    expect(result.deletedMovements).toBe(3)
    expect(result.deletedBatches).toBe(2)
  })

  // ==========================================
  // Cross-tenant bug (found 2026-09-29, reproduced with data): demo RecipeLines,
  // Recipes and Modifiers were deleted with `{ isDemo: true }` alone, so converting
  // ONE demo venue wiped the demo recipes and extras of EVERY other demo venue.
  // ==========================================

  it('only deletes demo RecipeLines of this venue', async () => {
    await cleanDemoData(VENUE_ID)

    expect(prismaMock.recipeLine.deleteMany).toHaveBeenCalledWith({
      where: { isDemo: true, recipe: { product: { venueId: VENUE_ID } } },
    })
  })

  it('only deletes demo Recipes of this venue', async () => {
    await cleanDemoData(VENUE_ID)

    expect(prismaMock.recipe.deleteMany).toHaveBeenCalledWith({
      where: { isDemo: true, product: { venueId: VENUE_ID } },
    })
  })

  it('only deletes demo Modifiers of this venue', async () => {
    await cleanDemoData(VENUE_ID)

    expect(prismaMock.modifier.deleteMany).toHaveBeenCalledWith({
      where: { isDemo: true, group: { venueId: VENUE_ID } },
    })
  })

  it('scopes EVERY delete to this venue (no cleanup can reach another tenant)', async () => {
    await cleanDemoData(VENUE_ID)

    const sinAcotar = TOUCHED_MODELS.flatMap(model =>
      ((prismaMock as any)[model].deleteMany?.mock.calls ?? [])
        .filter(([args]: [unknown]) => !JSON.stringify(args).includes(VENUE_ID))
        .map(([args]: [unknown]) => `${model}: ${JSON.stringify(args)}`),
    )
    expect(sinAcotar).toEqual([])
  })
})
