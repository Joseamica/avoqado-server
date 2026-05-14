import { getProfitability } from '../../../../src/services/dashboard/pricing.service'
import { prismaMock } from '../../../__helpers__/setup'
import { Decimal } from '@prisma/client/runtime/library'

const VENUE = 'venue-test'

// Helper — build a Product result matching the select clause used by the service.
const recipeProduct = (overrides: Record<string, any> = {}) => ({
  id: 'rx-001',
  name: 'Cappuccino chico',
  price: new Decimal(55),
  cost: null,
  categoryId: 'cat-shake',
  updatedAt: new Date('2026-04-20T10:00:00Z'),
  recipe: { totalCost: new Decimal(8.02), updatedAt: new Date('2026-04-20T10:00:00Z') },
  pricingPolicy: { pricingStrategy: 'MANUAL' as const },
  category: { name: 'Shake bar' },
  ...overrides,
})

const quantityProduct = (overrides: Record<string, any> = {}) => ({
  id: 'q-001',
  name: 'Clockwork Orange',
  price: new Decimal(95),
  cost: new Decimal(68),
  categoryId: 'cat-hh',
  updatedAt: new Date('2026-05-13T18:00:00Z'),
  recipe: null,
  pricingPolicy: null,
  category: { name: 'Half & Half' },
  ...overrides,
})

describe('getProfitability', () => {
  beforeEach(() => jest.clearAllMocks())

  it('returns recipes with cost from recipe.totalCost', async () => {
    prismaMock.product.findMany.mockResolvedValue([recipeProduct()] as any)
    const result = await getProfitability(VENUE)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      productId: 'rx-001',
      type: 'RECIPE',
      price: 55,
      cost: 8.02,
      category: 'Shake bar',
      hasPolicy: true,
      strategy: 'MANUAL',
    })
    // Margin 46.98/55 = 0.8542 → EXCELLENT
    expect(result[0].marginPct).toBeCloseTo(0.8542, 3)
    expect(result[0].status).toBe('EXCELLENT')
  })

  it('returns quantity products with cost from Product.cost (wholesale)', async () => {
    prismaMock.product.findMany.mockResolvedValue([quantityProduct()] as any)
    const result = await getProfitability(VENUE)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      productId: 'q-001',
      type: 'QUANTITY',
      price: 95,
      cost: 68,
      hasPolicy: false,
      strategy: 'NONE',
    })
    // Margin 27/95 = 0.2842 → POOR
    expect(result[0].marginPct).toBeCloseTo(0.2842, 3)
    expect(result[0].status).toBe('POOR')
  })

  it('mixes recipe and quantity rows in a single response', async () => {
    prismaMock.product.findMany.mockResolvedValue([recipeProduct(), quantityProduct()] as any)
    const result = await getProfitability(VENUE)

    expect(result.map(r => r.type).sort()).toEqual(['QUANTITY', 'RECIPE'])
  })

  it('classifies margin status by thresholds (EXCELLENT/HEALTHY/ACCEPTABLE/POOR)', async () => {
    prismaMock.product.findMany.mockResolvedValue([
      quantityProduct({ id: 'a', price: new Decimal(100), cost: new Decimal(30) }), // 70% → EXCELLENT
      quantityProduct({ id: 'b', price: new Decimal(100), cost: new Decimal(45) }), // 55% → HEALTHY
      quantityProduct({ id: 'c', price: new Decimal(100), cost: new Decimal(60) }), // 40% → ACCEPTABLE
      quantityProduct({ id: 'd', price: new Decimal(100), cost: new Decimal(80) }), // 20% → POOR
    ] as any)

    const result = await getProfitability(VENUE)
    expect(result.map(r => r.status)).toEqual(['EXCELLENT', 'HEALTHY', 'ACCEPTABLE', 'POOR'])
  })

  it('returns UNDEFINED status when quantity product has no cost set', async () => {
    prismaMock.product.findMany.mockResolvedValue([quantityProduct({ cost: null })] as any)
    const result = await getProfitability(VENUE)
    expect(result[0].cost).toBeNull()
    expect(result[0].marginPct).toBeNull()
    expect(result[0].status).toBe('UNDEFINED')
  })

  it('handles null category gracefully', async () => {
    prismaMock.product.findMany.mockResolvedValue([quantityProduct({ category: null })] as any)
    const result = await getProfitability(VENUE)
    expect(result[0].category).toBeNull()
  })

  it('passes venueId filter to the query (tenant isolation)', async () => {
    prismaMock.product.findMany.mockResolvedValue([] as any)
    await getProfitability(VENUE)
    expect(prismaMock.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ venueId: VENUE, deletedAt: null }),
      }),
    )
  })

  it('honors categoryId filter when provided', async () => {
    prismaMock.product.findMany.mockResolvedValue([] as any)
    await getProfitability(VENUE, { categoryId: 'cat-hh' })
    expect(prismaMock.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ categoryId: 'cat-hh' }),
      }),
    )
  })

  it('excludes inactive products by default', async () => {
    prismaMock.product.findMany.mockResolvedValue([] as any)
    await getProfitability(VENUE)
    expect(prismaMock.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ active: true }),
      }),
    )
  })

  it('includes inactive when includeInactive=true', async () => {
    prismaMock.product.findMany.mockResolvedValue([] as any)
    await getProfitability(VENUE, { includeInactive: true })
    const arg = (prismaMock.product.findMany.mock.calls[0] as any)[0]
    expect(arg.where).not.toHaveProperty('active')
  })

  // ─── Regression tests: existing pricing analysis behavior is untouched ──
  it('regression: does not call findMany twice (no leftover N+1)', async () => {
    prismaMock.product.findMany.mockResolvedValue([recipeProduct(), quantityProduct()] as any)
    await getProfitability(VENUE)
    expect(prismaMock.product.findMany).toHaveBeenCalledTimes(1)
  })

  it('regression: prefers recipe.totalCost over Product.cost when both exist', async () => {
    // If a product has both a recipe AND a wholesale cost, recipe wins
    prismaMock.product.findMany.mockResolvedValue([
      recipeProduct({ cost: new Decimal(999) }), // cost shouldn't be used
    ] as any)
    const result = await getProfitability(VENUE)
    expect(result[0].cost).toBe(8.02)
    expect(result[0].type).toBe('RECIPE')
  })
})
