// tests/integration/shopify/conexion-gobierno.integration.test.ts
/**
 * Review del spec §3: una organización con el catálogo maestro ENFORCED no se conecta. Iniciar falla ANTES de mandar al
 * dueño a Shopify, y confirmar falla dentro de la transacción (#29) sin dejar nada. Arreglo ENFORCED real, igual que
 * tests/integration/master-catalog/restaurarEnforced.integration.test.ts.
 */
import prisma from '@/utils/prismaClient'
import { createCatalogGovernanceService } from '@/services/master-catalog/catalogGovernance.service'
import { SHOPIFY_SCOPES } from '@/services/commerce-channels/shopify/shopify.constants'
import { encryptShopifyToken, signIntentId } from '@/services/commerce-channels/shopify/shopify.crypto'
import { confirmShopifyConnect, startShopifyConnect } from '@/services/commerce-channels/shopify/shopify.connect.service'
import {
  assertDisposableCatalogPublicationDatabase,
  cleanupCatalogPublicationFixture,
  createCatalogPublicationFixture,
  createCatalogPublicationIntegrationHarness,
  type CatalogPublicationFixture,
  type CatalogPublicationIntegrationHarness,
} from '../master-catalog/catalogPublicationIntegrationHarness'
import { graphqlFalso, TOKEN_DE_PRUEBA } from './fixtures'

jest.setTimeout(120_000)
let harness: CatalogPublicationIntegrationHarness | null = null
let f: CatalogPublicationFixture | null = null
const h = () => {
  if (!harness) throw new Error('El arnés del catálogo no se inició')
  return harness
}

beforeAll(async () => {
  assertDisposableCatalogPublicationDatabase()
  harness = await createCatalogPublicationIntegrationHarness('shopify-gobierno')
  Object.assign(process.env, {
    SHOPIFY_PILOTO_CLIENT_ID: 'cliente',
    SHOPIFY_PILOTO_CLIENT_SECRET: 'secreto',
    OAUTH_STATE_SECRET: 'estado',
    SHOPIFY_PILOTO_SHOPS: 'gobierno.myshopify.com',
  })
})
afterAll(async () => {
  try {
    if (f) await prisma.shopifyConnectIntent.deleteMany({ where: { venueId: f.venueId } })
    await cleanupCatalogPublicationFixture(h().primary, f)
  } finally {
    await harness?.disconnect()
  }
})

it('catálogo maestro ENFORCED: iniciar ⇒ 422 antes de ir a Shopify; confirmar ⇒ 422 y no crea tienda ni sucursal', async () => {
  f = await createCatalogPublicationFixture(h().primary, 'shopify-gobierno', { productTaxRate: '0.1600' })
  const actor = { type: 'HUMAN' as const, staffId: f.staffId, impersonating: false }
  await h().primary.organizationModule.updateMany({
    where: { organizationId: f.organizationId },
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
  const gobierno = createCatalogGovernanceService({ assertControlPlaneAccess: async () => undefined } as never)
  await h().primary.$transaction(tx =>
    gobierno.transitionToEnforced(tx, { organizationId: f!.organizationId, venueId: f!.venueId, actor, enforcedAt: new Date() }),
  )

  await expect(
    startShopifyConnect({ venueId: f.venueId, authUserId: f.staffId, shopDomain: 'gobierno.myshopify.com', purpose: 'CONNECT' }),
  ).rejects.toMatchObject({ statusCode: 422, code: 'CATALOG_GOVERNANCE_REQUIRED' })
  expect(await prisma.shopifyConnectIntent.count({ where: { venueId: f.venueId } })).toBe(0)

  const intent = await prisma.shopifyConnectIntent.create({
    data: {
      venueId: f.venueId,
      authUserId: f.staffId,
      shopDomain: 'gobierno.myshopify.com',
      appKey: 'PILOTO',
      status: 'EXCHANGED',
      tokenCiphertext: encryptShopifyToken(TOKEN_DE_PRUEBA),
      scopes: SHOPIFY_SCOPES,
      expiresAt: new Date(Date.now() + 600_000),
    },
  })
  const graphql = graphqlFalso(() => ({ ok: true, data: { location: { id: 'gid://shopify/Location/9', name: 'MX', isActive: true } } }))
  await expect(
    confirmShopifyConnect(
      { venueId: f.venueId, authUserId: f.staffId, intent: signIntentId(intent.id), locationId: 'gid://shopify/Location/9' },
      { graphql },
    ),
  ).rejects.toMatchObject({ statusCode: 422, code: 'CATALOG_GOVERNANCE_REQUIRED' })
  expect(await prisma.shopifyLocationLink.count({ where: { venueId: f.venueId } })).toBe(0)
  expect(await prisma.shopifyStore.count({ where: { organizationId: f.organizationId } })).toBe(0)
  expect((await prisma.shopifyConnectIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('EXCHANGED')
})
