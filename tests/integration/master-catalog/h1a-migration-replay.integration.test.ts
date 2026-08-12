import path from 'node:path'
import { spawnSync } from 'node:child_process'

const repoRoot = path.resolve(__dirname, '../../..')
const harness = path.join(__dirname, 'h1a-migration-harness.cjs')
const h1aEmptyTables = [
  'OrganizationEntitlement',
  'CatalogBrand',
  'CatalogManufacturer',
  'CatalogFamily',
  'CatalogItem',
  'CatalogItemBusinessType',
  'CatalogProductTypeMapping',
  'CatalogIdentifier',
  'CatalogValidationProfile',
  'CatalogItemPrice',
  'CatalogVenueRollout',
  'CatalogVenueClientRequirement',
  'CatalogClientObservation',
  'CatalogClientReadinessOverride',
  'CatalogVenueBinding',
  'CatalogVenueOverride',
  'CatalogIdempotencyRecord',
  'CatalogImportBatch',
  'CatalogImportLine',
  'CatalogBindingBatch',
  'CatalogBindingLine',
  'CatalogPublicationBatch',
  'CatalogPublicationLine',
  'CatalogPublicationFieldDecision',
  'CatalogVenueEventSequence',
  'CatalogPublicationOutbox',
] as const

describe('H1A real pre-H1 to H1 migration replay', () => {
  it('preserves the frozen legacy graph while the exact H1 chain stays default-off', () => {
    // The harness owns the reset, closes every client between phases, and runs
    // alone so no Jest Prisma pool can span the pre/post schema boundary.
    const replay = spawnSync(process.execPath, [harness], {
      cwd: repoRoot,
      env: process.env,
      encoding: 'utf8',
      timeout: 180_000,
    })

    expect({ status: replay.status, stderr: replay.stderr }).toEqual({ status: 0, stderr: '' })
    const evidence = JSON.parse(replay.stdout)

    expect(evidence.database).toEqual({
      host: expect.stringMatching(/^(localhost|127\.0\.0\.1)$/),
      pathname: '/avoqado_h1a_test_20260808',
    })
    expect(evidence.cutoff).toBe('20260808010000_add_cash_reconciliation_opt_in')
    expect(evidence.after).toEqual(evidence.before)
    expect(evidence.before).toEqual({
      counts: {
        Product: 251,
        ActivityLog: 2001,
        Inventory: 1,
        Recipe: 1,
        ProductModifierGroup: 1,
        PricingPolicy: 1,
        OrderItem: 1,
        VenueModule: 1,
        OrderItemModifier: 1,
      },
      graph: {
        productId: 'h1a-legacy-product',
        venueId: 'h1a-legacy-venue',
        categoryId: 'h1a-legacy-category',
        inventoryId: 'h1a-legacy-inventory',
        recipeId: 'h1a-legacy-recipe',
        productModifierId: 'h1a-legacy-product-modifier',
        pricingPolicyId: 'h1a-legacy-pricing-policy',
        orderItemId: 'h1a-legacy-order-item',
        orderItemModifierId: 'h1a-legacy-order-item-modifier',
      },
    })
    expect(evidence.defaultOffCounts).toEqual(Object.fromEntries(h1aEmptyTables.map(table => [table, 0])))
    expect(evidence.legacyDefaults).toEqual({
      products_with_creator: 0,
      governed_venues: 0,
      classified_logs: 0,
      non_default_modules: 0,
    })
    expect(evidence.indexes).toHaveLength(7)
    expect(evidence.indexes.every((index: { valid: boolean; ready: boolean }) => index.valid && index.ready)).toBe(true)
    expect(evidence.appliedH1).toHaveLength(48)
    expect(evidence.migrationCounts).toEqual({ legacy: 375, h1a: 48, total: 423 })
    expect(evidence.versions.postgres).toMatch(/^14\./)
    expect(evidence.versions.prisma).toContain('6.19.3')
    expect(evidence.timingsMs).toEqual({
      legacyDeploy: expect.any(Number),
      h1aDeploy: expect.any(Number),
    })
  }, 190_000)
})
