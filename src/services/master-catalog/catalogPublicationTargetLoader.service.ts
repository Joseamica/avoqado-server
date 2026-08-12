import { CatalogItemKind, Prisma, type VenueOperationalRole } from '@prisma/client'
import { ConflictError } from '../../errors/AppError'
import type { CatalogCommandContext, CatalogPublicationPreviewTargetInput } from '../../types/master-catalog'
import { evaluatePreparedDishBinding } from './catalogRecipeCost.service'
import type {
  CatalogPublicationBindingRecord,
  CatalogPublicationItemRecord,
  CatalogPublicationProductRecord,
  CatalogPublicationProfileRecord,
  ProjectedCatalogPublicationTarget,
} from './catalogPublication.types'
import { hashApplicableCatalogProfilesV1, projectCatalogPublicationTarget } from './catalogPublicationProjection.service'

const READ_TARGET_CHUNK_SIZE = 100

function targetKey(target: { catalogItemId: string; venueId: string; productId: string }): string {
  return `${target.catalogItemId}\u0000${target.venueId}\u0000${target.productId}`
}

type LoadedBinding = CatalogPublicationBindingRecord & {
  organizationId: string
  venueId: string
  productId: string | null
  venue: { id: string; organizationId: string; currency: string; operationalRole: VenueOperationalRole }
  product: (CatalogPublicationProductRecord & { deletedAt: Date | null }) | null
  catalogItem: CatalogPublicationItemRecord
}

async function readBindings(
  tx: Prisma.TransactionClient,
  organizationId: string,
  targets: CatalogPublicationPreviewTargetInput[],
): Promise<LoadedBinding[]> {
  const rows: LoadedBinding[] = []
  for (let index = 0; index < targets.length; index += READ_TARGET_CHUNK_SIZE) {
    const targetChunk = targets.slice(index, index + READ_TARGET_CHUNK_SIZE)
    const chunkRows = await tx.catalogVenueBinding.findMany({
      // WHY: Every target is addressed by immutable catalog/venue/Product
      // identity; raw fuzzy SKU matching has no place in publication.
      where: {
        organizationId,
        status: 'LINKED',
        catalogItem: { status: 'ACTIVE' },
        OR: targetChunk.map(target => ({
          catalogItemId: target.catalogItemId,
          venueId: target.venueId,
          productId: target.productId,
        })),
      },
      select: {
        id: true,
        organizationId: true,
        venueId: true,
        productId: true,
        revision: true,
        managedFieldMask: true,
        lastPublishedCatalogRevision: true,
        lastPublishedManagedSnapshot: true,
        lastPublishedManagedHash: true,
        venue: { select: { id: true, organizationId: true, currency: true, operationalRole: true } },
        product: {
          select: {
            id: true,
            venueId: true,
            name: true,
            description: true,
            imageUrl: true,
            type: true,
            cost: true,
            taxRate: true,
            satProductKey: true,
            satUnitKey: true,
            objetoImp: true,
            unit: true,
            categoryId: true,
            price: true,
            active: true,
            deletedAt: true,
            updatedAt: true,
          },
        },
        catalogItem: {
          select: {
            id: true,
            organizationId: true,
            sku: true,
            kind: true,
            status: true,
            revision: true,
            invariantVersion: true,
            name: true,
            description: true,
            imageUrl: true,
            brandId: true,
            manufacturerId: true,
            familyId: true,
            presentationLabel: true,
            unit: true,
            taxRate: true,
            satProductKey: true,
            satUnitKey: true,
            objetoImp: true,
            productType: true,
            iepsMode: true,
            iepsRate: true,
            iepsQuota: true,
            iepsQuotaUnit: true,
            createdById: true,
            createdAt: true,
            updatedById: true,
            updatedAt: true,
            family: { select: { parentId: true } },
            businessTypes: { select: { businessType: true } },
            prices: {
              where: { active: true, scope: 'ORGANIZATION' },
              select: { kind: true, scope: true, amount: true, currency: true, active: true, revision: true },
            },
          },
        },
      },
    })
    rows.push(...(chunkRows as unknown as LoadedBinding[]))
  }
  return rows
}

export async function loadCatalogPublicationTargetsTx(
  tx: Prisma.TransactionClient,
  context: CatalogCommandContext,
  targets: CatalogPublicationPreviewTargetInput[],
): Promise<ProjectedCatalogPublicationTarget[]> {
  const profiles = (await tx.catalogValidationProfile.findMany({
    where: { organizationId: context.organizationId, active: true },
    select: {
      id: true,
      profileVersion: true,
      updatedAt: true,
      active: true,
      businessType: true,
      operationalRole: true,
      rulesSchemaVersion: true,
      requiredFields: true,
      additionalRules: true,
    },
    orderBy: { id: 'asc' },
  })) as unknown as CatalogPublicationProfileRecord[]
  const rows = await readBindings(tx, context.organizationId, targets)
  const byKey = new Map(
    rows.map(row => [targetKey({ catalogItemId: row.catalogItem.id, venueId: row.venueId, productId: row.productId ?? '' }), row]),
  )
  const projected: ProjectedCatalogPublicationTarget[] = []
  for (const target of targets) {
    const row = byKey.get(targetKey(target))
    // WHY: A LINKED binding is not publication authority after its corporate
    // item retires; RETAIL has no Recipe evaluator that could catch this later.
    if (!row?.product || row.product.deletedAt !== null || row.catalogItem.status !== 'ACTIVE') continue
    const readiness =
      row.catalogItem.kind === CatalogItemKind.PREPARED_DISH
        ? await evaluatePreparedDishBinding(tx, {
            organizationId: context.organizationId,
            venueId: target.venueId,
            productId: target.productId,
          })
        : {
            state: 'READY' as const,
            findings: [],
            dependencies: {
              bindingId: row.id,
              bindingRevision: row.revision,
              catalogItemId: row.catalogItem.id,
              catalogItemRevision: row.catalogItem.revision,
              productId: row.product.id,
              recipeId: null,
              recipeUpdatedAt: null,
              recipeLineHash: null,
            },
          }
    const projection = projectCatalogPublicationTarget({
      operation: 'CATALOG_FIELDS_PUBLISH',
      organizationId: context.organizationId,
      venue: row.venue,
      item: row.catalogItem,
      product: row.product,
      binding: row,
      profiles,
      readiness,
    })
    projected.push({
      organizationId: context.organizationId,
      venueId: target.venueId,
      catalogItemId: target.catalogItemId,
      productId: target.productId,
      bindingId: row.id,
      sourceCatalogRevision: row.catalogItem.revision,
      sourceCatalogInvariantVersion: row.catalogItem.invariantVersion.toString(),
      bindingRevision: row.revision,
      dependencies: {
        readiness: readiness as unknown as Prisma.InputJsonObject,
        // WHY: A policy edit can keep the same READY outcome while changing
        // confirmation authority; its semantic profile hash must still stale.
        applicableProfilesHash: hashApplicableCatalogProfilesV1({ item: row.catalogItem, venue: row.venue, profiles }),
      },
      projection,
    })
  }
  const currentByBinding = new Map<string, string | null>(projected.map(target => [target.bindingId, null]))
  const bindingIds = [...currentByBinding.keys()].sort()
  for (let index = 0; index < bindingIds.length; index += 500) {
    const rows = await tx.catalogPublicationLine.findMany({
      where: {
        organizationId: context.organizationId,
        bindingId: { in: bindingIds.slice(index, index + 500) },
        status: 'APPLIED',
        batch: { operation: { in: ['CATALOG_FIELDS_PUBLISH', 'CATALOG_FIELDS_REVERSION'] } },
        supersededByLines: {
          none: { status: 'APPLIED', batch: { operation: { in: ['CATALOG_FIELDS_PUBLISH', 'CATALOG_FIELDS_REVERSION'] } } },
        },
      },
      select: { id: true, bindingId: true },
      orderBy: [{ bindingId: 'asc' }, { id: 'asc' }],
    })
    for (const row of rows) {
      if (currentByBinding.get(row.bindingId)) {
        throw new ConflictError('La historia de publicación tiene más de una línea vigente.', 'CATALOG_PUBLICATION_HISTORY_CONFLICT')
      }
      currentByBinding.set(row.bindingId, row.id)
    }
  }
  for (const target of projected) {
    target.dependencies = {
      ...target.dependencies,
      // WHY: Every managed publication forms one serialized successor chain;
      // activation lines are a separate operation-only history.
      currentPublicationLineId: currentByBinding.get(target.bindingId) ?? null,
    }
  }
  return projected
}
