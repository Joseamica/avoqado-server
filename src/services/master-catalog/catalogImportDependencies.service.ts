import { CatalogReferenceStatus } from '@prisma/client'
import { ConflictError } from '../../errors/AppError'
import type { CatalogCommandContext } from '../../types/master-catalog'
import { createCatalogImportCooperativeCheckpoint, type CatalogImportCooperativeCheckpoint } from './catalogImportCanonical.service'
import {
  exactCatalogImportJsonEqualsV1,
  parseCatalogImportDependencySnapshotV1,
  parseCatalogImportProfileDependencyV1,
  type CatalogImportProfileDependencyV1,
} from './catalogImportDependencySnapshot.service'
import {
  findBoundedCatalogImportRowsByItemIdsV1,
  findCatalogImportRowsByPriceKeysInChunks,
  findCatalogImportRowsInChunks,
  mergeCatalogImportRowsByIdV1,
  type CatalogImportPriceKeyV1,
} from './catalogImportLookup.service'
import type { CatalogImportDependencySnapshotV1, CatalogImportTransaction } from './catalogImport.types'

function failStale(): never {
  throw new ConflictError('Las dependencias del preview cambiaron.', 'STALE_PREVIEW')
}

function exactStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const expected = new Set(right)
  return expected.size === right.length && left.every(value => expected.has(value))
}

async function exactSetEquals<T>(
  current: readonly T[],
  captured: readonly T[],
  key: (value: T) => string,
  equal: (left: T, right: T) => boolean | Promise<boolean>,
  checkpoint: CatalogImportCooperativeCheckpoint,
): Promise<boolean> {
  if (current.length !== captured.length) return false
  const capturedByKey = new Map<string, T>()
  for (const value of captured) {
    const valueKey = key(value)
    if (capturedByKey.has(valueKey)) return false
    capturedByKey.set(valueKey, value)
    const pause = checkpoint()
    if (pause) await pause
  }
  const seen = new Set<string>()
  for (const value of current) {
    const valueKey = key(value)
    const expected = capturedByKey.get(valueKey)
    if (!expected || seen.has(valueKey)) return false
    const comparison = equal(value, expected)
    // WHY: Most dependency comparators are primitive and synchronous; awaiting
    // only the profile JSON comparator avoids one Promise continuation per row.
    const matches = typeof comparison === 'boolean' ? comparison : await comparison
    if (!matches) return false
    seen.add(valueKey)
    const pause = checkpoint()
    if (pause) await pause
  }
  return true
}

export async function revalidateCatalogImportDependenciesTx(
  tx: CatalogImportTransaction,
  context: CatalogCommandContext,
  rawDependencies: unknown,
): Promise<void> {
  const checkpoint = createCatalogImportCooperativeCheckpoint(4)
  const snapshot = await parseCatalogImportDependencySnapshotV1(rawDependencies, checkpoint)
  const itemIds = new Set<string>()
  const brandIds = new Set<string>()
  const manufacturerIds = new Set<string>()
  const familyIds = new Set<string>()
  const mappingIds = new Set<string>()
  const priceDependentItemIds = new Set(snapshot.priceDependentItemIds)
  for (const item of snapshot.items) {
    itemIds.add(item.id)
    const pause = checkpoint()
    if (pause) await pause
  }
  for (const reference of snapshot.references) {
    const target = reference.type === 'BRAND' ? brandIds : reference.type === 'MANUFACTURER' ? manufacturerIds : familyIds
    target.add(reference.id)
    const pause = checkpoint()
    if (pause) await pause
  }
  for (const mapping of snapshot.mappings) {
    mappingIds.add(mapping.id)
    const pause = checkpoint()
    if (pause) await pause
  }

  const items = await findCatalogImportRowsInChunks(
    itemIds,
    chunk =>
      tx.catalogItem.findMany({
        where: { organizationId: context.organizationId, id: { in: chunk } },
        select: {
          id: true,
          revision: true,
          invariantVersion: true,
          status: true,
          businessTypes: { select: { businessType: true } },
        },
      }),
    checkpoint,
  )
  const priceSelect = {
    id: true,
    catalogItemId: true,
    kind: true,
    scope: true,
    currency: true,
    revision: true,
    active: true,
  } as const
  const activePriceResult = await findBoundedCatalogImportRowsByItemIdsV1(
    priceDependentItemIds,
    snapshot.organizationValues.length + 1,
    (chunk, take) =>
      tx.catalogItemPrice.findMany({
        where: {
          organizationId: context.organizationId,
          catalogItemId: { in: chunk },
          scope: 'ORGANIZATION',
          active: true,
        },
        select: priceSelect,
        orderBy: { id: 'asc' },
        take,
      }),
    checkpoint,
  )
  // WHY: One row beyond the captured complete set already proves staleness;
  // stop under the org lock instead of hydrating attacker-sized active history.
  if (activePriceResult.overflow) failStale()
  const activePrices = activePriceResult.rows
  const activePriceIds = new Set<string>()
  for (const price of activePrices) {
    activePriceIds.add(price.id)
    const pause = checkpoint()
    if (pause) await pause
  }
  const unresolvedByKey = new Map<string, CatalogImportDependencySnapshotV1['organizationValues'][number]>()
  const unresolvedKeys: CatalogImportPriceKeyV1[] = []
  for (const price of snapshot.organizationValues) {
    if (!activePriceIds.has(price.id)) {
      unresolvedByKey.set(`${price.catalogItemId}:${price.kind}:${price.currency}`, price)
      unresolvedKeys.push({
        catalogItemId: price.catalogItemId,
        kind: price.kind as CatalogImportPriceKeyV1['kind'],
        currency: price.currency,
      })
    }
    const pause = checkpoint()
    if (pause) await pause
  }
  const unresolvedPrices = await findCatalogImportRowsByPriceKeysInChunks(
    unresolvedKeys,
    chunk =>
      tx.catalogItemPrice.findMany({
        where: {
          organizationId: context.organizationId,
          scope: 'ORGANIZATION',
          OR: [
            {
              id: {
                in: chunk.map(value => unresolvedByKey.get(`${value.catalogItemId}:${value.kind}:${value.currency}`)!.id),
              },
            },
            ...chunk.map(value => ({
              catalogItemId: value.catalogItemId,
              kind: value.kind,
              currency: value.currency,
            })),
          ],
        },
        select: priceSelect,
      }),
    checkpoint,
  )
  // WHY: SQL returns only ACTIVE plus captured identity/key authorities; the
  // merge deduplicates overlaps without ever hydrating unrelated history.
  const prices = await mergeCatalogImportRowsByIdV1([activePrices, unresolvedPrices], checkpoint)
  const queryReferences = <T>(ids: ReadonlySet<string>, findMany: (chunk: string[]) => Promise<T[]>) =>
    findCatalogImportRowsInChunks(ids, findMany, checkpoint)
  const brands = await queryReferences(brandIds, chunk =>
    tx.catalogBrand.findMany({
      where: { organizationId: context.organizationId, id: { in: chunk } },
      select: { id: true, revision: true, status: true },
    }),
  )
  const manufacturers = await queryReferences(manufacturerIds, chunk =>
    tx.catalogManufacturer.findMany({
      where: { organizationId: context.organizationId, id: { in: chunk } },
      select: { id: true, revision: true, status: true },
    }),
  )
  const families = await queryReferences(familyIds, chunk =>
    tx.catalogFamily.findMany({
      where: { organizationId: context.organizationId, id: { in: chunk } },
      select: { id: true, revision: true, status: true },
    }),
  )
  const mappings = await findCatalogImportRowsInChunks(
    mappingIds,
    chunk =>
      tx.catalogProductTypeMapping.findMany({
        where: { organizationId: context.organizationId, id: { in: chunk }, active: true },
        select: { id: true, catalogProductType: true, productType: true, mappingVersion: true, active: true },
      }),
    checkpoint,
  )
  // WHY: The complete active profile set detects an absence-to-presence drift
  // for any scope that could become applicable after the reviewed preview.
  const profiles = await tx.catalogValidationProfile.findMany({
    where: { organizationId: context.organizationId, active: true },
    select: {
      id: true,
      profileVersion: true,
      rulesSchemaVersion: true,
      businessType: true,
      operationalRole: true,
      requiredFields: true,
      additionalRules: true,
    },
  })

  const currentItems: CatalogImportDependencySnapshotV1['items'] = []
  for (const item of items) {
    currentItems.push({
      id: item.id,
      revision: item.revision,
      invariantVersion: item.invariantVersion.toString(),
      status: item.status,
      businessTypes: item.businessTypes.map(value => value.businessType),
    })
    const pause = checkpoint()
    if (pause) await pause
  }
  const currentReferences: Array<{
    type: 'BRAND' | 'MANUFACTURER' | 'FAMILY'
    id: string
    revision: number
  }> = []
  let referencesActive = true
  for (const [type, rows] of [
    ['BRAND', brands],
    ['MANUFACTURER', manufacturers],
    ['FAMILY', families],
  ] as const) {
    for (const reference of rows) {
      if (reference.status !== CatalogReferenceStatus.ACTIVE) referencesActive = false
      currentReferences.push({ type, id: reference.id, revision: reference.revision })
      const pause = checkpoint()
      if (pause) await pause
    }
  }
  const currentProfiles: CatalogImportProfileDependencyV1[] = []
  for (const profile of profiles) {
    currentProfiles.push(
      await parseCatalogImportProfileDependencyV1(
        {
          id: profile.id,
          profileVersion: profile.profileVersion,
          rulesSchemaVersion: profile.rulesSchemaVersion,
          businessType: profile.businessType,
          operationalRole: profile.operationalRole,
          requiredFields: profile.requiredFields,
          additionalRules: profile.additionalRules ?? null,
        },
        checkpoint,
      ),
    )
  }

  // WHY: Field-wise comparators preserve exact set semantics without the old
  // two SHA-256 operations per dependency row or locale-sensitive sorting.
  const stale =
    !(await exactSetEquals(
      currentItems,
      snapshot.items,
      value => value.id,
      (left, right) =>
        left.revision === right.revision &&
        left.invariantVersion === right.invariantVersion &&
        left.status === right.status &&
        exactStringSet(left.businessTypes, right.businessTypes),
      checkpoint,
    )) ||
    !(await exactSetEquals(
      prices,
      snapshot.organizationValues,
      value => value.id,
      (left, right) =>
        left.catalogItemId === right.catalogItemId &&
        left.kind === right.kind &&
        left.scope === right.scope &&
        left.currency === right.currency &&
        left.revision === right.revision &&
        left.active === right.active,
      checkpoint,
    )) ||
    !referencesActive ||
    !(await exactSetEquals(
      currentReferences,
      snapshot.references,
      value => `${value.type}:${value.id}`,
      (left, right) => left.revision === right.revision,
      checkpoint,
    )) ||
    !(await exactSetEquals(
      mappings,
      snapshot.mappings,
      value => value.id,
      (left, right) =>
        left.catalogProductType === right.catalogProductType &&
        left.productType === right.productType &&
        left.mappingVersion === right.mappingVersion &&
        left.active === right.active,
      checkpoint,
    )) ||
    !(await exactSetEquals(
      currentProfiles,
      snapshot.profiles,
      value => value.id,
      async (left, right) =>
        left.profileVersion === right.profileVersion &&
        left.rulesSchemaVersion === right.rulesSchemaVersion &&
        left.businessType === right.businessType &&
        left.operationalRole === right.operationalRole &&
        exactStringSet(left.requiredFields, right.requiredFields) &&
        (await exactCatalogImportJsonEqualsV1(left.additionalRules, right.additionalRules, checkpoint)),
      checkpoint,
    ))
  if (stale) failStale()
}
