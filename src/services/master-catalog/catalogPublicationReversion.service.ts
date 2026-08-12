import type { Prisma } from '@prisma/client'
import cuid from 'cuid'
import { randomBytes } from 'node:crypto'
import AppError, { ConflictError, ForbiddenError, ServiceUnavailableError } from '../../errors/AppError'
import type {
  CatalogActor,
  CatalogCommandContext,
  CatalogManagedFieldV1,
  CatalogPublicationPreview,
  CatalogPublicationPreviewInput,
  CatalogPublicationPreviewTargetInput,
  CatalogPublicationResultLine,
} from '../../types/master-catalog'
import prisma from '../../utils/prismaClient'
import { writeCatalogAudit } from './catalogAudit.service'
import { canonicalJsonV1, hashCanonicalJsonV1 } from './catalogHash.service'
import { enqueueCatalogPublicationOutboxTx } from './catalogPublicationOutbox.service'
import { persistCatalogPublicationTx } from './catalogPublicationPersistence.service'
import { createCatalogPublicationStagingService } from './catalogPublicationStaging.service'
import type { CatalogPublicationJson } from './catalogPublication.types'
import {
  type CatalogPublicationReversionAuthority,
  loadCatalogPublicationReversionAuthoritiesTx,
} from './catalogPublicationReversionAuthority.service'
import { resolveMasterCatalogAccess } from './masterCatalogAccess.service'

interface SourceDecision {
  field: CatalogManagedFieldV1
  before: CatalogPublicationJson
  proposed: CatalogPublicationJson
  after: CatalogPublicationJson
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
  decisions: SourceDecision[]
}

export interface CatalogPublicationReversionProjection {
  organizationId: string
  bindingId: string
  catalogItemId: string
  venueId: string
  productId: string
  fieldMask: CatalogManagedFieldV1[]
  before: Partial<Record<CatalogManagedFieldV1, CatalogPublicationJson>>
  after: Partial<Record<CatalogManagedFieldV1, CatalogPublicationJson>>
  decisions: SourceDecision[]
  supersedesLineId: string
  reversesLineId: string
  changeKind: 'REVERSION'
  canonicalTargetHash: string
}

function conflict(): never {
  throw new ConflictError('El Product cambió después de la publicación original.', 'CATALOG_REVERSION_CONFLICT')
}

export function projectCatalogPublicationReversion(input: {
  operation: 'CATALOG_FIELDS_REVERSION'
  source: SourceLine
  currentLineId: string
  currentValues: Partial<Record<CatalogManagedFieldV1, CatalogPublicationJson>>
}): CatalogPublicationReversionProjection {
  const source = input.source
  if (
    !input.currentLineId?.trim() ||
    source.status !== 'APPLIED' ||
    source.fieldMask.length === 0 ||
    source.decisions.length !== source.fieldMask.length ||
    new Set(source.decisions.map(decision => decision.field)).size !== source.fieldMask.length
  ) {
    conflict()
  }
  const current = Object.fromEntries(source.fieldMask.map(field => [field, input.currentValues[field]])) as Partial<
    Record<CatalogManagedFieldV1, CatalogPublicationJson>
  >
  const sourceAfter = Object.fromEntries(source.decisions.map(decision => [decision.field, decision.after]))
  if (canonicalJsonV1(current) !== canonicalJsonV1(sourceAfter)) conflict()
  const after = Object.fromEntries(source.decisions.map(decision => [decision.field, decision.before])) as Partial<
    Record<CatalogManagedFieldV1, CatalogPublicationJson>
  >
  // WHY: Reversion is a new command over immutable history. Both tenant-safe
  // lineage FKs point to the source; disabling rollout is never data rollback.
  return {
    organizationId: source.organizationId,
    bindingId: source.bindingId,
    catalogItemId: source.catalogItemId,
    venueId: source.venueId,
    productId: source.productId,
    fieldMask: [...source.fieldMask],
    before: current,
    after,
    decisions: source.decisions,
    supersedesLineId: input.currentLineId,
    reversesLineId: source.id,
    changeKind: 'REVERSION',
    canonicalTargetHash: hashCanonicalJsonV1('catalog-publication-reversion-target', {
      operation: input.operation,
      organizationId: source.organizationId,
      bindingId: source.bindingId,
      sourceLineId: source.id,
      currentLineId: input.currentLineId,
      fieldMask: source.fieldMask,
      current,
    }),
  }
}

interface ReversionPreviewDependencies {
  prisma: typeof prisma
  assertAccessTx: (tx: Prisma.TransactionClient, context: CatalogCommandContext) => Promise<void>
  loadAuthoritiesTx: (
    tx: Prisma.TransactionClient,
    context: CatalogCommandContext,
    targets: CatalogPublicationPreviewTargetInput[],
  ) => Promise<CatalogPublicationReversionAuthority[]>
  now: () => Date
  randomToken: () => string
  randomId: () => string
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

function invalidReversionInput(): never {
  throw new AppError('La forma de la reversión es inválida.', 422, true, 'CATALOG_PUBLICATION_INPUT_INVALID')
}

function validateReversionInput(input: CatalogPublicationPreviewInput): void {
  const runtime = input as unknown
  if (!isPlainObject(runtime)) invalidReversionInput()
  const expectedKeys =
    input.sourcePublicationBatchId === undefined
      ? ['operation', 'idempotencyKey', 'targets']
      : ['operation', 'sourcePublicationBatchId', 'idempotencyKey', 'targets']
  if (!exactKeys(runtime, expectedKeys)) invalidReversionInput()
  if (input.operation !== 'CATALOG_FIELDS_REVERSION' || !semanticId(input.idempotencyKey)) invalidReversionInput()
  if (input.sourcePublicationBatchId !== undefined && !semanticId(input.sourcePublicationBatchId)) invalidReversionInput()
  if (!Array.isArray(input.targets) || input.targets.length === 0) invalidReversionInput()
  if (input.targets.length > 10_000) {
    throw new AppError('La reversión excede el límite de 10000 Products.', 413, true, 'CATALOG_PUBLICATION_TARGET_CAP_EXCEEDED')
  }
  const keys = input.targets.map((target, index) => {
    if (
      !(index in input.targets) ||
      !isPlainObject(target) ||
      !exactKeys(target, ['catalogItemId', 'venueId', 'productId', 'sourceLineId'])
    ) {
      invalidReversionInput()
    }
    if (![target.catalogItemId, target.venueId, target.productId, target.sourceLineId].every(semanticId)) invalidReversionInput()
    return `${target.catalogItemId}\u0000${target.venueId}\u0000${target.productId}`
  })
  if (new Set(keys).size !== keys.length || new Set(input.targets.map(target => target.sourceLineId)).size !== input.targets.length) {
    invalidReversionInput()
  }
}

async function defaultAssertReversionAccessTx(tx: Prisma.TransactionClient, context: CatalogCommandContext): Promise<void> {
  if (context.actor.type !== 'HUMAN' || context.actor.impersonating)
    throw new ForbiddenError('La reversión requiere OWNER/ADMIN humano no suplantado')
  const access = await resolveMasterCatalogAccess({
    organizationId: context.organizationId,
    principal: context.actor,
    capability: 'MUTATE_CONTENT',
    requiredGate: 'CORE',
    prisma: tx,
  })
  if (access.reasonCode === 'DEPENDENCY_UNAVAILABLE') {
    throw new ServiceUnavailableError('No fue posible revalidar Catalog Core', 'DEPENDENCY_UNAVAILABLE')
  }
  if (!access.canMutateContent) throw new ForbiddenError('No puedes revertir esta publicación')
}

const previewDefaults: ReversionPreviewDependencies = {
  prisma,
  assertAccessTx: defaultAssertReversionAccessTx,
  loadAuthoritiesTx: (tx, context, targets) =>
    loadCatalogPublicationReversionAuthoritiesTx(tx, context, targets, projectCatalogPublicationReversion),
  now: () => new Date(),
  randomToken: () => randomBytes(32).toString('base64url'),
  randomId: () => cuid(),
}

export function createCatalogPublicationReversionPreviewService(overrides: Partial<ReversionPreviewDependencies> = {}) {
  const dependencies = { ...previewDefaults, ...overrides }
  return {
    async preview(context: CatalogCommandContext, input: CatalogPublicationPreviewInput): Promise<CatalogPublicationPreview> {
      validateReversionInput(input)
      const staging = createCatalogPublicationStagingService({
        prisma: dependencies.prisma,
        now: dependencies.now,
        randomToken: dependencies.randomToken,
        randomId: dependencies.randomId,
      })
      const staged = await staging.stage(context, {
        operation: 'CATALOG_FIELDS_REVERSION',
        idempotencyKey: input.idempotencyKey,
        request: input.targets,
        prepare: async tx => {
          await dependencies.assertAccessTx(tx, context)
          if (input.sourcePublicationBatchId) {
            const sourceCount = await tx.catalogPublicationLine.count({
              where: {
                organizationId: context.organizationId,
                batchId: input.sourcePublicationBatchId,
                id: { in: input.targets.map(target => target.sourceLineId as string) },
                status: 'APPLIED',
                batch: {
                  organizationId: context.organizationId,
                  operation: { in: ['CATALOG_FIELDS_PUBLISH', 'CATALOG_FIELDS_REVERSION'] },
                },
              },
            })
            if (sourceCount !== input.targets.length) {
              throw new ConflictError(
                'Las líneas no pertenecen al batch de publicación solicitado.',
                'CATALOG_REVERSION_SOURCE_BATCH_MISMATCH',
              )
            }
          }
          const authorities = await dependencies.loadAuthoritiesTx(tx, context, input.targets)
          if (authorities.length !== input.targets.length) conflict()
          const lines = authorities.map(authority => ({
            catalogItemId: authority.projection.catalogItemId,
            venueId: authority.projection.venueId,
            productId: authority.projection.productId,
            bindingId: authority.projection.bindingId,
            status: 'READY',
            fieldMask: authority.projection.fieldMask,
            canonicalTargetHash: authority.projection.canonicalTargetHash,
            diagnosticCode: null,
            diagnostic: null,
            fields: authority.projection.decisions.map(decision => ({
              field: decision.field,
              before: decision.after,
              proposed: decision.before,
              after: decision.before,
              decision: 'PUBLISH_CORPORATE' as const,
              overrideId: null,
            })),
          }))
          return {
            targets: authorities.map(authority => ({
              catalogItemId: authority.projection.catalogItemId,
              venueId: authority.projection.venueId,
              productId: authority.projection.productId,
              bindingId: authority.projection.bindingId,
              sourceCatalogRevision: authority.sourceCatalogRevision,
              sourceCatalogInvariantVersion: authority.sourceCatalogInvariantVersion,
              bindingRevision: authority.bindingRevision,
              // WHY: Historical and current lineage are independent authority;
              // confirmation must reproduce both before applying inverse values.
              dependencies: {
                reversion: {
                  sourceLineId: authority.projection.reversesLineId,
                  currentLineId: authority.projection.supersedesLineId,
                },
              },
              line: {
                status: 'READY' as const,
                fieldMask: authority.projection.fieldMask,
                changeKind: 'REVERSION' as const,
                canonicalTargetHash: authority.projection.canonicalTargetHash,
                before: authority.projection.before as Prisma.InputJsonObject,
                after: authority.projection.after as Prisma.InputJsonObject,
                supersedesLineId: authority.projection.supersedesLineId,
                reversesLineId: authority.projection.reversesLineId,
              },
            })),
            output: { canConfirm: true, lines },
          }
        },
      })
      return {
        publicationBatchId: staged.publicationBatchId,
        operation: 'CATALOG_FIELDS_REVERSION',
        previewToken: staged.previewToken,
        targetHash: staged.targetHash,
        expiresAt: staged.expiresAt,
        canConfirm: staged.output.canConfirm,
        lines: staged.output.lines,
      }
    },
  }
}

interface ReversionDependencies {
  persist: typeof persistCatalogPublicationTx
  writeAudit: typeof writeCatalogAudit
  enqueueOutbox: typeof enqueueCatalogPublicationOutboxTx
}

function isExactReversalSlotConflict(error: unknown): boolean {
  if (!isPlainObject(error) || error.code !== 'P2002' || !isPlainObject(error.meta)) return false
  const target = error.meta.target
  return (
    target === 'CatalogPublicationLine_one_applied_reversal_key' ||
    (Array.isArray(target) && target.length === 2 && target[0] === 'organizationId' && target[1] === 'reversesLineId')
  )
}

const defaults: ReversionDependencies = {
  persist: persistCatalogPublicationTx,
  writeAudit: writeCatalogAudit,
  enqueueOutbox: enqueueCatalogPublicationOutboxTx,
}

export async function applyCatalogPublicationReversionTx(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string
    publicationBatchId: string
    lineId: string
    bindingRevision: number
    sourceCatalogRevision: number
    actor: CatalogActor
    projection: CatalogPublicationReversionProjection
  },
  overrides: Partial<ReversionDependencies> = {},
): Promise<CatalogPublicationResultLine> {
  const result = await applyCatalogPublicationReversionsTx(
    tx,
    {
      organizationId: input.organizationId,
      publicationBatchId: input.publicationBatchId,
      actor: input.actor,
      authorities: [
        {
          lineId: input.lineId,
          bindingRevision: input.bindingRevision,
          sourceCatalogRevision: input.sourceCatalogRevision,
          projection: input.projection,
        },
      ],
    },
    overrides,
  )
  return result[0] as CatalogPublicationResultLine
}

export async function applyCatalogPublicationReversionsTx(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string
    publicationBatchId: string
    actor: CatalogActor
    authorities: Array<{
      lineId: string
      bindingRevision: number
      sourceCatalogRevision: number
      projection: CatalogPublicationReversionProjection
    }>
  },
  overrides: Partial<ReversionDependencies> = {},
): Promise<CatalogPublicationResultLine[]> {
  if (input.actor.type !== 'HUMAN' || input.actor.impersonating) {
    throw new ForbiddenError('La reversión requiere OWNER/ADMIN humano no suplantado')
  }
  if (
    input.authorities.length === 0 ||
    input.authorities.length > 10_000 ||
    input.authorities.some(authority => input.organizationId !== authority.projection.organizationId)
  )
    conflict()
  const dependencies = { ...defaults, ...overrides }
  let result: CatalogPublicationResultLine[]
  try {
    result = await dependencies.persist(tx, {
      organizationId: input.organizationId,
      staffId: input.actor.staffId,
      // WHY: All inverse Product/binding/decision writes use the shared bulk
      // persistence once, preserving chunks<=500 and one atomic batch.
      lines: input.authorities.map(authority => ({
        lineId: authority.lineId,
        organizationId: input.organizationId,
        catalogItemId: authority.projection.catalogItemId,
        venueId: authority.projection.venueId,
        productId: authority.projection.productId,
        bindingId: authority.projection.bindingId,
        sourceCatalogRevision: authority.sourceCatalogRevision,
        bindingRevision: authority.bindingRevision,
        supersedesLineId: authority.projection.supersedesLineId,
        reversesLineId: authority.projection.reversesLineId,
        fieldMask: authority.projection.fieldMask,
        decisions: authority.projection.decisions.map(decision => ({
          field: decision.field,
          decision: 'PUBLISH_CORPORATE' as const,
          before: decision.after,
          proposed: decision.before,
          after: decision.before,
          overrideId: null,
          reason: null,
        })),
      })),
    })
  } catch (error) {
    // WHY: The partial unique index is the final race-proof guard for one
    // durable reversal per source; only its exact conflict is domain-mapped.
    if (isExactReversalSlotConflict(error)) conflict()
    throw error
  }
  await dependencies.writeAudit(tx, {
    organizationId: input.organizationId,
    actor: input.actor,
    action: 'CATALOG_PUBLICATION_REVERTED',
    entity: 'CatalogPublicationBatch',
    entityId: input.publicationBatchId,
    batchId: input.publicationBatchId,
    metadata: {
      targetCount: input.authorities.length,
      lineage: input.authorities.map(authority => ({
        supersedesLineId: authority.projection.supersedesLineId,
        reversesLineId: authority.projection.reversesLineId,
      })),
    },
  })
  await dependencies.enqueueOutbox(tx, {
    organizationId: input.organizationId,
    publicationBatchId: input.publicationBatchId,
    operation: 'CATALOG_FIELDS_REVERSION',
    targets: input.authorities.map(authority => ({
      venueId: authority.projection.venueId,
      productId: authority.projection.productId,
    })),
  })
  return result
}
