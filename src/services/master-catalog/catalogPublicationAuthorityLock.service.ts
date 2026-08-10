import { Prisma } from '@prisma/client'
import { ConflictError, ForbiddenError } from '../../errors/AppError'
import type { CatalogCommandContext } from '../../types/master-catalog'
import { canonicalJsonV1, hashCanonicalJsonV1 } from './catalogHash.service'
import { acquireCatalogMutationLock } from './catalogMutationLock.service'
import { createCatalogPublicationOverrideDecisionService } from './catalogPublicationOverrideDecision.service'
import type { CatalogPublicationApplyLine, ProjectedCatalogPublicationTarget } from './catalogPublication.types'
import { loadCatalogPublicationTargetsTx } from './catalogPublicationTargetLoader.service'
import { acquireRecipeCostGraphVenueLockV1 } from '../dashboard/recipe-cost-graph-lock'

const MAX_TARGETS = 10_000

export interface CatalogPublicationBatchAuthority {
  id: string
  organizationId: string
  operation: string
  state: string
  schemaVersion: number
  requestHash: string
  requestHashVersion: number
  targetHash: string
  previewTokenHash: string
  previewExpiresAt: Date
  dependencies: unknown
  actorType: string
  staffId: string | null
  servicePrincipalId: string | null
  attemptId: string | null
  leaseExpiresAt: Date | null
  result: unknown
}

function stale(message: string): never {
  throw new ConflictError(message, 'STALE_PREVIEW')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
}

function semanticId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 256
}

function targetKey(target: { catalogItemId: string; venueId: string; productId: string }): string {
  return `${target.catalogItemId}\u0000${target.venueId}\u0000${target.productId}`
}

interface LockedTargetIds {
  catalogItemId: string
  venueId: string
  productId: string
  bindingId: string
}

function idsFromBatch(batch: CatalogPublicationBatchAuthority): LockedTargetIds[] {
  if (
    !isPlainObject(batch.dependencies) ||
    !exactKeys(batch.dependencies, ['schemaVersion', 'targets']) ||
    batch.dependencies.schemaVersion !== 1 ||
    !Array.isArray(batch.dependencies.targets)
  )
    stale('Dependencias staged inválidas.')
  const values = batch.dependencies.targets.map(value => {
    if (
      !isPlainObject(value) ||
      !exactKeys(value, [
        'catalogItemId',
        'venueId',
        'productId',
        'bindingId',
        'sourceCatalogRevision',
        'sourceCatalogInvariantVersion',
        'bindingRevision',
        'dependencies',
      ])
    )
      stale('Target staged inválido.')
    if (![value.catalogItemId, value.venueId, value.productId, value.bindingId, value.sourceCatalogInvariantVersion].every(semanticId)) {
      stale('Identidad staged inválida.')
    }
    if (!Number.isInteger(value.sourceCatalogRevision) || !Number.isInteger(value.bindingRevision) || !isPlainObject(value.dependencies)) {
      stale('Versiones staged inválidas.')
    }
    return {
      catalogItemId: value.catalogItemId as string,
      venueId: value.venueId as string,
      productId: value.productId as string,
      bindingId: value.bindingId as string,
    }
  })
  if (values.length === 0 || values.length > MAX_TARGETS) stale('Cardinalidad staged inválida.')
  if (new Set(values.map(targetKey)).size !== values.length) stale('Targets staged duplicados.')
  return [...values].sort((left, right) => {
    const leftKey = targetKey(left)
    const rightKey = targetKey(right)
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })
}

function chunks<T>(values: readonly T[]): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += 500) result.push(values.slice(index, index + 500))
  return result
}

export async function lockCatalogPublicationAuthoritiesTx(
  tx: Prisma.TransactionClient,
  context: CatalogCommandContext,
  batch: CatalogPublicationBatchAuthority,
): Promise<void> {
  if (context.actor.type !== 'HUMAN') throw new ForbiddenError('La publicación requiere actor humano')
  const targets = idsFromBatch(batch)
  const itemIds = [...new Set(targets.map(target => target.catalogItemId))].sort()
  const venueIds = [...new Set(targets.map(target => target.venueId))].sort()
  const productIds = [...new Set(targets.map(target => target.productId))].sort()
  const bindingIds = [...new Set(targets.map(target => target.bindingId))].sort()
  // WHY: Task 5/6 writers serialize on this shared organization advisory lock;
  // row locks alone would not wait for their policy/catalog mutations.
  await acquireCatalogMutationLock(tx, context.organizationId)
  // WHY: Recipe writers take one Venue graph lock before Product/Recipe rows;
  // matching their ordinal protocol closes graph phantoms and deadlock cycles.
  for (const venueId of venueIds) await acquireRecipeCostGraphVenueLockV1(tx, venueId)
  // WHY: After the shared lock, the fixed tenant→policy→catalog→binding→
  // Product→Recipe order blocks live writer rows before authority is reread.
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "Organization" WHERE id = ${context.organizationId} FOR NO KEY UPDATE`)
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "Staff" WHERE id = ${context.actor.staffId} FOR NO KEY UPDATE`)
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM "StaffOrganization" WHERE "organizationId" = ${context.organizationId} AND "staffId" = ${context.actor.staffId} FOR NO KEY UPDATE`,
  )
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM "OrganizationEntitlement" WHERE "organizationId" = ${context.organizationId} ORDER BY id FOR NO KEY UPDATE`,
  )
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "Module" WHERE code = 'MASTER_CATALOG' FOR NO KEY UPDATE`)
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM "OrganizationModule" WHERE "organizationId" = ${context.organizationId} ORDER BY id FOR NO KEY UPDATE`,
  )
  for (const chunk of chunks(venueIds))
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM "Venue" WHERE "organizationId" = ${context.organizationId} AND id IN (${Prisma.join(chunk)}) ORDER BY id FOR NO KEY UPDATE`,
    )
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM "CatalogValidationProfile" WHERE "organizationId" = ${context.organizationId} ORDER BY id FOR NO KEY UPDATE`,
  )
  for (const chunk of chunks(itemIds))
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM "CatalogItem" WHERE "organizationId" = ${context.organizationId} AND id IN (${Prisma.join(chunk)}) ORDER BY id FOR NO KEY UPDATE`,
    )
  for (const chunk of chunks(itemIds))
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM "CatalogItemBusinessType" WHERE "organizationId" = ${context.organizationId} AND "catalogItemId" IN (${Prisma.join(chunk)}) ORDER BY id FOR NO KEY UPDATE`,
    )
  for (const chunk of chunks(itemIds))
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM "CatalogItemPrice" WHERE "organizationId" = ${context.organizationId} AND "catalogItemId" IN (${Prisma.join(chunk)}) ORDER BY id FOR NO KEY UPDATE`,
    )
  // WHY: Binding ids are the exact tenant-scoped authority from staging; an
  // item×venue cross product would lock unrelated bindings and exceed chunks.
  for (const chunk of chunks(bindingIds))
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM "CatalogVenueBinding" WHERE "organizationId" = ${context.organizationId} AND id IN (${Prisma.join(chunk)}) ORDER BY id FOR NO KEY UPDATE`,
    )
  // WHY: Reversion reads immutable historical/current lineage under the same
  // binding lock order before Product; an APPLIED successor cannot race it.
  for (const chunk of chunks(bindingIds))
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM "CatalogPublicationLine" WHERE "organizationId" = ${context.organizationId} AND "bindingId" IN (${Prisma.join(chunk)}) ORDER BY id FOR NO KEY UPDATE`,
    )
  for (const chunk of chunks(productIds))
    await tx.$queryRaw(
      Prisma.sql`SELECT product.id FROM "Product" AS product JOIN "Venue" AS venue ON venue.id = product."venueId" WHERE venue."organizationId" = ${context.organizationId} AND product.id IN (${Prisma.join(chunk)}) ORDER BY product.id FOR NO KEY UPDATE OF product`,
    )
  for (const chunk of chunks(productIds))
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "Recipe" WHERE "productId" IN (${Prisma.join(chunk)}) ORDER BY id FOR NO KEY UPDATE`)
  for (const chunk of chunks(productIds))
    await tx.$queryRaw(
      Prisma.sql`SELECT line.id FROM "RecipeLine" AS line JOIN "Recipe" AS recipe ON recipe.id = line."recipeId" WHERE recipe."productId" IN (${Prisma.join(chunk)}) ORDER BY line.id FOR NO KEY UPDATE OF line`,
    )
  for (const chunk of chunks(productIds))
    await tx.$queryRaw(
      Prisma.sql`SELECT material.id FROM "RawMaterial" AS material JOIN "RecipeLine" AS line ON line."rawMaterialId" = material.id JOIN "Recipe" AS recipe ON recipe.id = line."recipeId" WHERE recipe."productId" IN (${Prisma.join(chunk)}) ORDER BY material.id FOR NO KEY UPDATE OF material`,
    )
}

interface RevalidationDependencies {
  loadTargetsTx: typeof loadCatalogPublicationTargetsTx
  createOverrideService: typeof createCatalogPublicationOverrideDecisionService
}

const revalidationDefaults: RevalidationDependencies = {
  loadTargetsTx: loadCatalogPublicationTargetsTx,
  createOverrideService: createCatalogPublicationOverrideDecisionService,
}

export async function revalidateLockedCatalogPublicationTx(
  tx: Prisma.TransactionClient,
  context: CatalogCommandContext,
  batch: CatalogPublicationBatchAuthority,
  overrides: Partial<RevalidationDependencies> = {},
): Promise<CatalogPublicationApplyLine[]> {
  const dependencies = { ...revalidationDefaults, ...overrides }
  idsFromBatch(batch)
  if (batch.operation !== 'CATALOG_FIELDS_PUBLISH') stale('La operación staged no corresponde a publicación de campos.')
  if (!isPlainObject(batch.dependencies) || !Array.isArray(batch.dependencies.targets)) stale('Dependencias staged inválidas.')
  const authorities = batch.dependencies.targets as Array<Record<string, unknown>>
  if (authorities.length === 0 || authorities.length > MAX_TARGETS) stale('La cardinalidad staged es inválida.')
  const requested = authorities.map(authority => ({
    catalogItemId: String(authority.catalogItemId ?? ''),
    venueId: String(authority.venueId ?? ''),
    productId: String(authority.productId ?? ''),
  }))
  const [storedLines, projected] = await Promise.all([
    tx.catalogPublicationLine.findMany({
      where: { batchId: batch.id, organizationId: context.organizationId },
      orderBy: { id: 'asc' },
      take: MAX_TARGETS + 1,
      select: {
        id: true,
        organizationId: true,
        batchId: true,
        bindingId: true,
        catalogItemId: true,
        venueId: true,
        productId: true,
        status: true,
        fieldMask: true,
        decisionSchemaVersion: true,
        changeKind: true,
        hashVersion: true,
        canonicalTargetHash: true,
        before: true,
        after: true,
        sourceCatalogRevision: true,
        bindingRevision: true,
        supersedesLineId: true,
        reversesLineId: true,
      },
    }),
    dependencies.loadTargetsTx(tx, context, requested),
  ])
  if (storedLines.length !== authorities.length || projected.length !== authorities.length) stale('Un target dejó de existir.')
  const storedByKey = new Map(storedLines.map(line => [targetKey(line), line]))
  const projectedByKey = new Map(projected.map(target => [targetKey(target), target]))
  const expectedTargetHash = hashCanonicalJsonV1('catalog-publication-targets', {
    operation: batch.operation,
    targets: authorities.map(authority =>
      authority.dependencies && isPlainObject(authority.dependencies)
        ? storedByKey.get(targetKey(authority as never))?.canonicalTargetHash
        : null,
    ),
  })
  if (batch.targetHash !== expectedTargetHash) stale('El targetHash staged es inválido.')
  const overrideService = dependencies.createOverrideService()
  const applyLines: CatalogPublicationApplyLine[] = []
  for (const authority of authorities) {
    const key = targetKey({
      catalogItemId: String(authority.catalogItemId),
      venueId: String(authority.venueId),
      productId: String(authority.productId),
    })
    const stored = storedByKey.get(key)
    const current = projectedByKey.get(key) as ProjectedCatalogPublicationTarget | undefined
    const stagedDependencies = isPlainObject(authority.dependencies) ? authority.dependencies : null
    const stagedDecisions = stagedDependencies?.decisions
    const currentPublicationLineId = isPlainObject(current?.dependencies) ? current.dependencies.currentPublicationLineId : undefined
    let dependencyMatch = false
    try {
      dependencyMatch =
        stagedDependencies !== null && canonicalJsonV1(stagedDependencies.projection) === canonicalJsonV1(current?.dependencies)
    } catch {
      dependencyMatch = false
    }
    if (
      !stored ||
      !current ||
      authority.bindingId !== stored.bindingId ||
      authority.bindingId !== current.bindingId ||
      authority.sourceCatalogRevision !== stored.sourceCatalogRevision ||
      authority.sourceCatalogRevision !== current.sourceCatalogRevision ||
      stored.bindingId !== current.bindingId ||
      stored.sourceCatalogRevision !== current.sourceCatalogRevision ||
      authority.sourceCatalogInvariantVersion !== current.sourceCatalogInvariantVersion ||
      authority.bindingRevision !== stored.bindingRevision ||
      authority.bindingRevision !== current.bindingRevision ||
      stored.bindingRevision !== current.bindingRevision ||
      stored.organizationId !== context.organizationId ||
      stored.batchId !== batch.id ||
      stored.status !== current.projection.status ||
      stored.hashVersion !== 1 ||
      stored.decisionSchemaVersion !== 1 ||
      stored.changeKind !== 'PUBLICATION' ||
      !(
        (currentPublicationLineId === null && stored.supersedesLineId === null) ||
        (semanticId(currentPublicationLineId) && stored.supersedesLineId === currentPublicationLineId)
      ) ||
      stored.reversesLineId !== null ||
      stored.canonicalTargetHash !== current.projection.canonicalTargetHash ||
      canonicalJsonV1(stored.fieldMask) !== canonicalJsonV1(current.projection.fieldMask) ||
      canonicalJsonV1(stored.before) !== canonicalJsonV1(current.projection.before) ||
      !dependencyMatch ||
      !['READY', 'NO_CHANGE', 'LOCAL_DIVERGENCE'].includes(current.projection.status) ||
      !Array.isArray(stagedDecisions) ||
      stagedDecisions.some(decision => !isPlainObject(decision) || decision.decision === 'UNDECIDED')
    ) {
      stale('El target cambió después del preview.')
    }
    const resolved = await overrideService.resolve(tx, {
      organizationId: context.organizationId,
      venueId: current.venueId,
      bindingId: current.bindingId,
      actor: context.actor,
      projection: current.projection,
      decisions: stagedDecisions.map(decision => ({
        field: decision.field,
        decision: decision.decision,
        ...(decision.decision === 'APPROVE_LOCAL_OVERRIDE' ? { overrideId: decision.overrideId } : {}),
      })) as never,
    })
    const normalized = resolved.map(({ field, before, proposed, after, decision, overrideId }) => ({
      field,
      before,
      proposed,
      after,
      decision,
      overrideId,
    }))
    const staged = stagedDecisions.map(decision => ({
      field: decision.field,
      before: decision.before,
      proposed: decision.proposed,
      after: decision.after,
      decision: decision.decision,
      overrideId: decision.overrideId ?? null,
    }))
    const expectedAfter = Object.fromEntries(normalized.map(decision => [decision.field, decision.after]))
    if (canonicalJsonV1(normalized) !== canonicalJsonV1(staged) || canonicalJsonV1(stored.after) !== canonicalJsonV1(expectedAfter))
      stale('Las decisiones dejaron de coincidir con el target.')
    applyLines.push({
      lineId: stored.id,
      organizationId: context.organizationId,
      catalogItemId: current.catalogItemId,
      venueId: current.venueId,
      productId: current.productId,
      bindingId: current.bindingId,
      sourceCatalogRevision: current.sourceCatalogRevision,
      bindingRevision: current.bindingRevision,
      fieldMask: current.projection.fieldMask,
      decisions: resolved,
      supersedesLineId: stored.supersedesLineId,
      reversesLineId: null,
    })
  }
  return applyLines
}
