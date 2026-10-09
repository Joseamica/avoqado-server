// tests/integration/shopify/catalogo-gobierno.integration.test.ts
/**
 * N08: el catálogo maestro ENFORCED se enciende MIENTRAS una página viaja. Emparejar un producto que ya existía también
 * escribe catálogo: la importación se detiene con CATALOGO_MAESTRO y nada se liga. Arreglo ENFORCED real, igual que
 * tests/integration/master-catalog/restaurarEnforced.integration.test.ts.
 */
import prisma from '@/utils/prismaClient'
import { createCatalogGovernanceService } from '@/services/master-catalog/catalogGovernance.service'
import { SHOPIFY_SCOPES } from '@/services/commerce-channels/shopify/shopify.constants'
import { encryptShopifyToken } from '@/services/commerce-channels/shopify/shopify.crypto'
import { importCatalogPage } from '@/services/commerce-channels/shopify/shopify.catalog.service'
import {
  assertDisposableCatalogPublicationDatabase,
  cleanupCatalogPublicationFixture,
  createCatalogPublicationFixture,
  createCatalogPublicationIntegrationHarness,
  type CatalogPublicationFixture,
  type CatalogPublicationIntegrationHarness,
} from '../master-catalog/catalogPublicationIntegrationHarness'
import { TOKEN_DE_PRUEBA } from './fixtures'
import { graphqlConEfecto, paginaDeVariantes, variante } from './fixturesB'

jest.setTimeout(120_000)
let harness: CatalogPublicationIntegrationHarness | null = null
let f: CatalogPublicationFixture | null = null
const h = () => {
  if (!harness) throw new Error('El arnés del catálogo no se inició')
  return harness
}

beforeAll(async () => {
  assertDisposableCatalogPublicationDatabase()
  harness = await createCatalogPublicationIntegrationHarness('shopify-catalogo-gobierno')
})
afterAll(async () => {
  try {
    if (f) {
      await prisma.shopifyImportIssue.deleteMany({ where: { venueId: f.venueId } })
      await prisma.shopifyVariantLink.deleteMany({ where: { venueId: f.venueId } })
      await prisma.shopifyLocationLink.deleteMany({ where: { venueId: f.venueId } })
      await prisma.shopifyStore.deleteMany({ where: { organizationId: f.organizationId } })
      await prisma.inventory.deleteMany({ where: { venueId: f.venueId, product: { sku: 'GOB-1' } } })
      await prisma.product.deleteMany({ where: { venueId: f.venueId, sku: 'GOB-1' } })
    }
    await cleanupCatalogPublicationFixture(h().primary, f)
  } finally {
    await harness?.disconnect()
  }
})

it('N08: ENFORCED se enciende durante el HTTP ⇒ CATALOGO_MAESTRO, terminal, y el existente no se liga', async () => {
  f = await createCatalogPublicationFixture(h().primary, 'shopify-catalogo-gobierno', { productTaxRate: '0.1600' })
  const fixture = f
  const actor = { type: 'HUMAN' as const, staffId: fixture.staffId, impersonating: false }
  const existente = await prisma.product.create({
    data: {
      venueId: fixture.venueId,
      categoryId: fixture.categoryId,
      name: 'Gorra',
      sku: 'GOB-1',
      price: 100,
      unit: 'UNIT',
      type: 'REGULAR',
      trackInventory: true,
      inventoryMethod: 'QUANTITY',
    },
  })
  await prisma.inventory.create({ data: { productId: existente.id, venueId: fixture.venueId, currentStock: 3 } })
  const store = await prisma.shopifyStore.create({
    data: {
      organizationId: fixture.organizationId,
      shopDomain: `gob-${fixture.venueId}.myshopify.com`,
      appKey: 'PILOTO',
      accessTokenCiphertext: encryptShopifyToken(TOKEN_DE_PRUEBA),
      scopes: SHOPIFY_SCOPES,
    },
  })
  const link = await prisma.shopifyLocationLink.create({
    data: {
      storeId: store.id,
      venueId: fixture.venueId,
      shopifyLocationId: 'gid://shopify/Location/1',
      locationName: 'MX',
      status: 'CONNECTING',
      webhooksAt: new Date(),
    },
  })
  const gobierno = createCatalogGovernanceService({ assertControlPlaneAccess: async () => undefined } as never)
  const graphql = graphqlConEfecto(
    async () => {
      await h().primary.organizationModule.updateMany({
        where: { organizationId: fixture.organizationId },
        data: {
          config: {
            schemaVersion: 1,
            catalogCoreEnabled: true,
            identifiersEnabled: false,
            regionalPricingEnabled: false,
            governanceMode: 'ENFORCED',
          },
        },
      })
      await h().primary.$transaction(tx =>
        gobierno.transitionToEnforced(tx, {
          organizationId: fixture.organizationId,
          venueId: fixture.venueId,
          actor,
          enforcedAt: new Date(),
        }),
      )
    },
    () => paginaDeVariantes([variante(1, { sku: 'GOB-1', barcode: null })], 'c1', 1),
  )
  expect(await importCatalogPage(link.id, { graphql })).toEqual({ error: 'CATALOGO_MAESTRO', retry: false })
  expect(await prisma.shopifyLocationLink.findUniqueOrThrow({ where: { id: link.id } })).toMatchObject({
    importError: 'CATALOGO_MAESTRO',
    importCursor: null,
  })
  expect(await prisma.shopifyVariantLink.count({ where: { productId: existente.id } })).toBe(0)
  expect(await importCatalogPage(link.id, { graphql })).toEqual({ error: 'CATALOGO_MAESTRO', retry: false })
  expect(graphql).toHaveBeenCalledTimes(1)
})
