import type { Prisma } from '@prisma/client'
import { ConflictError } from '../../errors/AppError'
import { CATALOG_PREPARED_DISH_MANAGED_FIELD_MASK_V1, CATALOG_RETAIL_MANAGED_FIELD_MASK_V1 } from '../../types/master-catalog'
import type { CatalogCommandContext, CatalogManagedFieldV1, CatalogPublicationPreviewTargetInput } from '../../types/master-catalog'
import { canonicalJsonV1, hashCanonicalJsonV1 } from './catalogHash.service'
import type { CatalogPublicationJson } from './catalogPublication.types'
import type { CatalogPublicationReversionProjection } from './catalogPublicationReversion.service'
import type { CatalogPublicationBatchAuthority } from './catalogPublicationAuthorityLock.service'

const CHUNK_SIZE = 500
const MANAGED_FIELDS = new Set<string>([...CATALOG_RETAIL_MANAGED_FIELD_MASK_V1, ...CATALOG_PREPARED_DISH_MANAGED_FIELD_MASK_V1])

interface SourceDecision {
  field: CatalogManagedFieldV1
  before: CatalogPublicationJson
  proposed: CatalogPublicationJson
  after: CatalogPublicationJson
  decision: string
}

interface SourceLine {
  id: string
  organizationId: string
  bindingId: string
  catalogItemId: string
  venueId: string
  productId: string
  status: string
  fieldMask: CatalogManagedFieldV1[]
  decisionSchemaVersion: number
  hashVersion: number
  changeKind: string
  before: unknown
  after: unknown
  sourceCatalogRevision: number
  bindingRevision: number | null
  decisions: SourceDecision[]
  binding: {
    revision: number
    catalogItem: { revision: number; invariantVersion: bigint }
    product: Record<string, unknown> | null
  }
}

export interface CatalogPublicationReversionAuthority {
  projection: CatalogPublicationReversionProjection
  sourceCatalogRevision: number
  sourceCatalogInvariantVersion: string
  bindingRevision: number
}

type ProjectReversion = (input: {
  operation: 'CATALOG_FIELDS_REVERSION'
  source: SourceLine
  currentLineId: string
  currentValues: Partial<Record<CatalogManagedFieldV1, CatalogPublicationJson>>
}) => CatalogPublicationReversionProjection

function conflict(message: string): never {
  throw new ConflictError(message, 'CATALOG_REVERSION_CONFLICT')
}

function chunks<T>(values: readonly T[]): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += CHUNK_SIZE) result.push(values.slice(index, index + CHUNK_SIZE))
  return result
}

function targetKey(target: { catalogItemId: string; venueId: string; productId: string }): string {
  return `${target.catalogItemId}\u0000${target.venueId}\u0000${target.productId}`
}

function productValue(product: Record<string, unknown>, field: CatalogManagedFieldV1): CatalogPublicationJson {
  const value = product[field]
  if ((field === 'cost' || field === 'taxRate') && value && typeof (value as { toFixed?: unknown }).toFixed === 'function') {
    return (value as { toFixed(scale: number): string }).toFixed(field === 'cost' ? 2 : 4)
  }
  return (value ?? null) as CatalogPublicationJson
}

function assertSourceClosed(source: SourceLine): void {
  const fields = source.fieldMask
  const decisionFields = source.decisions.map(decision => decision.field)
  if (
    source.status !== 'APPLIED' ||
    source.decisionSchemaVersion !== 1 ||
    source.hashVersion !== 1 ||
    !['PUBLICATION', 'REVERSION'].includes(source.changeKind) ||
    fields.length === 0 ||
    fields.some(field => !MANAGED_FIELDS.has(field)) ||
    new Set(fields).size !== fields.length ||
    source.decisions.length !== fields.length ||
    new Set(decisionFields).size !== fields.length ||
    fields.some(field => !decisionFields.includes(field)) ||
    source.decisions.some(decision => !['PUBLISH_CORPORATE', 'APPROVE_LOCAL_OVERRIDE'].includes(decision.decision))
  )
    conflict('La línea histórica no tiene decisiones cerradas.')
  const decisionBefore = Object.fromEntries(source.decisions.map(decision => [decision.field, decision.before]))
  const decisionAfter = Object.fromEntries(source.decisions.map(decision => [decision.field, decision.after]))
  if (
    canonicalJsonV1(source.before) !== canonicalJsonV1(decisionBefore) ||
    canonicalJsonV1(source.after) !== canonicalJsonV1(decisionAfter)
  ) {
    conflict('La línea histórica contradice sus decisiones.')
  }
}

export async function loadCatalogPublicationReversionAuthoritiesTx(
  tx: Prisma.TransactionClient,
  context: CatalogCommandContext,
  targets: CatalogPublicationPreviewTargetInput[],
  project: ProjectReversion,
): Promise<CatalogPublicationReversionAuthority[]> {
  const sourceIds = targets.map(target => target.sourceLineId as string)
  const sources: SourceLine[] = []
  for (const chunk of chunks(sourceIds)) {
    const rows = await tx.catalogPublicationLine.findMany({
      where: {
        organizationId: context.organizationId,
        id: { in: chunk },
        status: 'APPLIED',
        batch: { operation: { in: ['CATALOG_FIELDS_PUBLISH', 'CATALOG_FIELDS_REVERSION'] } },
        reversedByLines: {
          none: { status: 'APPLIED', batch: { operation: 'CATALOG_FIELDS_REVERSION' } },
        },
      },
      include: {
        decisions: { select: { field: true, before: true, proposed: true, after: true, decision: true }, orderBy: { field: 'asc' } },
        binding: {
          select: {
            revision: true,
            catalogItem: { select: { revision: true, invariantVersion: true } },
            product: {
              select: {
                cost: true,
                description: true,
                imageUrl: true,
                name: true,
                objetoImp: true,
                satProductKey: true,
                satUnitKey: true,
                taxRate: true,
                type: true,
                unit: true,
                deletedAt: true,
              },
            },
          },
        },
      },
      orderBy: { id: 'asc' },
    })
    sources.push(...(rows as unknown as SourceLine[]))
  }
  if (sources.length !== targets.length) conflict('Una línea histórica no existe en el tenant.')
  const sourceById = new Map(sources.map(source => [source.id, source]))
  const bindingIds = [...new Set(sources.map(source => source.bindingId))].sort()
  const currentLines: Array<{ id: string; bindingId: string }> = []
  for (const chunk of chunks(bindingIds)) {
    const rows = await tx.catalogPublicationLine.findMany({
      // WHY: supersedes follows the durable APPLIED chain. Its unique leaf is
      // the current successor even when the requested historical line is old.
      where: {
        organizationId: context.organizationId,
        bindingId: { in: chunk },
        status: 'APPLIED',
        batch: { operation: { in: ['CATALOG_FIELDS_PUBLISH', 'CATALOG_FIELDS_REVERSION'] } },
        supersededByLines: {
          none: {
            status: 'APPLIED',
            batch: { operation: { in: ['CATALOG_FIELDS_PUBLISH', 'CATALOG_FIELDS_REVERSION'] } },
          },
        },
      },
      select: { id: true, bindingId: true },
      orderBy: [{ bindingId: 'asc' }, { id: 'asc' }],
    })
    currentLines.push(...rows)
  }
  const currentByBinding = new Map<string, string>()
  for (const line of currentLines) {
    if (currentByBinding.has(line.bindingId)) conflict('La historia de publicación tiene más de una línea vigente.')
    currentByBinding.set(line.bindingId, line.id)
  }
  return targets.map(target => {
    const source = sourceById.get(target.sourceLineId as string)
    if (!source || targetKey(source) !== targetKey(target) || !source.binding.product || source.binding.product.deletedAt !== null) {
      conflict('La línea histórica no corresponde al Product solicitado.')
    }
    assertSourceClosed(source)
    const currentLineId = currentByBinding.get(source.bindingId)
    if (!currentLineId) conflict('No existe una línea vigente para revertir.')
    const currentValues = Object.fromEntries(
      source.fieldMask.map(field => [field, productValue(source.binding.product as Record<string, unknown>, field)]),
    )
    return {
      projection: project({ operation: 'CATALOG_FIELDS_REVERSION', source, currentLineId, currentValues }),
      sourceCatalogRevision: source.binding.catalogItem.revision,
      sourceCatalogInvariantVersion: source.binding.catalogItem.invariantVersion.toString(),
      bindingRevision: source.binding.revision,
    }
  })
}

export function reversionBatchTargetHash(projections: CatalogPublicationReversionProjection[]): string {
  return hashCanonicalJsonV1('catalog-publication-targets', {
    operation: 'CATALOG_FIELDS_REVERSION',
    targets: projections.map(projection => projection.canonicalTargetHash),
  })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
}

export async function revalidateLockedCatalogPublicationReversionsTx(
  tx: Prisma.TransactionClient,
  context: CatalogCommandContext,
  batch: CatalogPublicationBatchAuthority,
  project: ProjectReversion,
  loadAuthoritiesTx: typeof loadCatalogPublicationReversionAuthoritiesTx = loadCatalogPublicationReversionAuthoritiesTx,
): Promise<Array<CatalogPublicationReversionAuthority & { lineId: string }>> {
  if (
    batch.operation !== 'CATALOG_FIELDS_REVERSION' ||
    !isPlainObject(batch.dependencies) ||
    !exactKeys(batch.dependencies, ['schemaVersion', 'targets']) ||
    batch.dependencies.schemaVersion !== 1 ||
    !Array.isArray(batch.dependencies.targets) ||
    batch.dependencies.targets.length === 0 ||
    batch.dependencies.targets.length > 10_000
  )
    conflict('La autoridad durable de reversión es inválida.')
  const stagedTargets = batch.dependencies.targets as Array<Record<string, unknown>>
  const requests = stagedTargets.map(target => {
    const dependencies = isPlainObject(target.dependencies) ? target.dependencies : null
    const reversion = dependencies && isPlainObject(dependencies.reversion) ? dependencies.reversion : null
    if (
      !dependencies ||
      !exactKeys(dependencies, ['reversion']) ||
      !reversion ||
      !exactKeys(reversion, ['sourceLineId', 'currentLineId'])
    ) {
      conflict('La autoridad de linaje staged es inválida.')
    }
    return {
      catalogItemId: target.catalogItemId as string,
      venueId: target.venueId as string,
      productId: target.productId as string,
      sourceLineId: reversion.sourceLineId as string,
    }
  })
  const [live, storedLines] = await Promise.all([
    loadAuthoritiesTx(tx, context, requests, project),
    tx.catalogPublicationLine.findMany({
      where: { organizationId: context.organizationId, batchId: batch.id },
      orderBy: { id: 'asc' },
      take: 10_001,
    }),
  ])
  if (live.length !== stagedTargets.length || storedLines.length !== stagedTargets.length) conflict('La cardinalidad de reversión cambió.')
  const liveByKey = new Map(live.map(authority => [targetKey(authority.projection), authority]))
  const storedByKey = new Map(storedLines.map(line => [targetKey(line), line]))
  const result = stagedTargets.map(target => {
    const key = targetKey(target as never)
    const authority = liveByKey.get(key)
    const stored = storedByKey.get(key)
    const reversion = (target.dependencies as Record<string, Record<string, unknown>>).reversion
    if (
      !authority ||
      !stored ||
      target.bindingId !== authority.projection.bindingId ||
      target.sourceCatalogRevision !== authority.sourceCatalogRevision ||
      target.sourceCatalogInvariantVersion !== authority.sourceCatalogInvariantVersion ||
      target.bindingRevision !== authority.bindingRevision ||
      reversion.sourceLineId !== authority.projection.reversesLineId ||
      reversion.currentLineId !== authority.projection.supersedesLineId ||
      stored.organizationId !== context.organizationId ||
      stored.batchId !== batch.id ||
      stored.bindingId !== authority.projection.bindingId ||
      stored.status !== 'READY' ||
      stored.hashVersion !== 1 ||
      stored.decisionSchemaVersion !== 1 ||
      stored.changeKind !== 'REVERSION' ||
      stored.sourceCatalogRevision !== authority.sourceCatalogRevision ||
      stored.bindingRevision !== authority.bindingRevision ||
      stored.canonicalTargetHash !== authority.projection.canonicalTargetHash ||
      stored.supersedesLineId !== authority.projection.supersedesLineId ||
      stored.reversesLineId !== authority.projection.reversesLineId ||
      canonicalJsonV1(stored.fieldMask) !== canonicalJsonV1(authority.projection.fieldMask) ||
      canonicalJsonV1(stored.before) !== canonicalJsonV1(authority.projection.before) ||
      canonicalJsonV1(stored.after) !== canonicalJsonV1(authority.projection.after)
    )
      conflict('La reversión cambió después del preview.')
    return { ...authority, lineId: stored.id }
  })
  if (batch.targetHash !== reversionBatchTargetHash(result.map(entry => entry.projection))) {
    conflict('El targetHash durable de reversión es inválido.')
  }
  return result
}
