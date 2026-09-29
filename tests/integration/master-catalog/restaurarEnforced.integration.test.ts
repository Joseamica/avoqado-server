/**
 * IVA por producto, plan 5 · Ruling P5-R16 (Codex ronda 1, P1-2) — con el gobierno del catálogo ENFORCED, restaurar por
 * importación cuenta como ACTIVAR también cuando el SKU se archiva DESPUÉS de la precuenta. Un bloqueador retiene la categoría
 * que la importación va a encender, que es su primera escritura después de la precuenta y antes de leer el SKU. La espera se
 * prueba en pg_stat_activity; en esa ventana otra petición archiva el producto. Al soltar, la importación responde 422 y el
 * producto sigue archivado. Postgres REAL (H1, base desechable del arnés).
 */
import { Prisma } from '@prisma/client'

import { importMenu } from '@/services/dashboard/menu.dashboard.service'
import { deleteProduct } from '@/services/dashboard/product.dashboard.service'
import { createCatalogGovernanceService } from '@/services/master-catalog/catalogGovernance.service'
import { desenlace, hastaQue, retener } from '../fiscal/exclusionContable.fixtures'
import {
  assertDisposableCatalogPublicationDatabase,
  cleanupCatalogPublicationFixture,
  createCatalogPublicationFixture,
  createCatalogPublicationIntegrationHarness,
  type CatalogPublicationFixture,
  type CatalogPublicationIntegrationHarness,
} from './catalogPublicationIntegrationHarness'

jest.setTimeout(120_000)

let harness: CatalogPublicationIntegrationHarness | null = null
const fixtures: CatalogPublicationFixture[] = []
const h = () => {
  if (!harness) throw new Error('El arnés del catálogo no se inició')
  return harness
}

beforeAll(async () => {
  assertDisposableCatalogPublicationDatabase()
  harness = await createCatalogPublicationIntegrationHarness('plan5-restaurar')
})
afterAll(async () => {
  try {
    for (const f of fixtures) await cleanupCatalogPublicationFixture(h().primary, f)
  } finally {
    await harness?.disconnect()
  }
})

it('ENFORCED · un SKU archivado ENTRE la precuenta y la lectura por SKU no se restaura: 422 y sigue archivado', async () => {
  const f = await createCatalogPublicationFixture(h().primary, 'plan5-restaurar', { productTaxRate: '0.1600' })
  fixtures.push(f)
  const actor = { type: 'HUMAN' as const, staffId: f.staffId, impersonating: false }
  const sku = `P5-${f.key}`.toUpperCase()
  const productId = (
    await h().primary.product.create({ data: { venueId: f.venueId, categoryId: f.categoryId, sku, name: 'Vigente', price: 20 } })
  ).id
  // Apagada: la importación la encenderá, y ahí se pausa (después de la precuenta, antes de leer el SKU).
  const { name: categoria } = await h().primary.menuCategory.update({ where: { id: f.categoryId }, data: { active: false } })
  // ENFORCED por el camino real: política de la organización y transición del venue.
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
    gobierno.transitionToEnforced(tx, { organizationId: f.organizationId, venueId: f.venueId, actor, enforcedAt: new Date() }),
  )

  const bloqueo = await retener(h().blocker, tx => tx.$queryRaw`SELECT id FROM "MenuCategory" WHERE id = ${f.categoryId} FOR UPDATE`)
  let importacion: Promise<unknown> = Promise.resolve()
  try {
    importacion = desenlace(
      importMenu(
        f.venueId,
        {
          mode: 'merge',
          categories: [{ name: categoria, slug: `otra-${f.key}`.toLowerCase(), products: [{ name: 'Vigente', sku, price: 25 }] }],
        },
        actor,
      ),
    )
    // La precuenta ya pasó (el SKU estaba vigente) y la importación espera para encender la categoría.
    await hastaQue(
      h().observer,
      'la importación espera la categoría que retiene el bloqueador',
      10_000,
      Prisma.sql`SELECT a.pid FROM pg_stat_activity a
        WHERE a.datname = current_database() AND a.wait_event_type = 'Lock'
          AND ${bloqueo.pid}::int = ANY(pg_blocking_pids(a.pid)) AND a.query LIKE '%MenuCategory%'
        LIMIT 1`,
    )
    await deleteProduct(f.venueId, productId, f.staffId) // otra petición lo archiva en la ventana
  } finally {
    await bloqueo.soltar()
  }

  expect(await importacion).toMatchObject({ statusCode: 422, code: 'CATALOG_GOVERNANCE_REQUIRED' })
  expect(await h().primary.product.findUniqueOrThrow({ where: { id: productId }, select: { deletedAt: true, active: true } })).toEqual({
    deletedAt: expect.any(Date),
    active: false,
  })
})
