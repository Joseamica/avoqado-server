import { Prisma } from '@prisma/client'
import cuid from 'cuid'
import { randomBytes } from 'node:crypto'
import AppError, { ForbiddenError, ServiceUnavailableError, ValidationError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { CATALOG_PREPARED_DISH_MANAGED_FIELD_MASK_V1, CATALOG_RETAIL_MANAGED_FIELD_MASK_V1 } from '../../types/master-catalog'
import type {
  CatalogCommandContext,
  CatalogManagedFieldV1,
  CatalogPublicationFieldDecisionInput,
  CatalogPublicationPreview,
  CatalogPublicationPreviewField,
  CatalogPublicationPreviewInput,
  CatalogPublicationPreviewTargetInput,
} from '../../types/master-catalog'
import type { CatalogPublicationProjection, ProjectedCatalogPublicationTarget } from './catalogPublication.types'
import { loadCatalogPublicationTargetsTx } from './catalogPublicationTargetLoader.service'
import { createCatalogPublicationStagingService } from './catalogPublicationStaging.service'
import { resolveMasterCatalogAccess } from './masterCatalogAccess.service'

export const CATALOG_PUBLICATION_TARGET_CAP = 10_000
export const CATALOG_PUBLICATION_IDEMPOTENCY_KEY_MAX_BYTES = 256
const MANAGED_FIELDS = new Set<CatalogManagedFieldV1>([
  ...CATALOG_RETAIL_MANAGED_FIELD_MASK_V1,
  ...CATALOG_PREPARED_DISH_MANAGED_FIELD_MASK_V1,
])

interface CatalogPublicationPreviewDependencies {
  prisma: typeof prisma
  assertAccessTx: (tx: Prisma.TransactionClient, context: CatalogCommandContext) => Promise<void>
  loadTargetsTx: (
    tx: Prisma.TransactionClient,
    context: CatalogCommandContext,
    targets: CatalogPublicationPreviewTargetInput[],
  ) => Promise<ProjectedCatalogPublicationTarget[]>
  now: () => Date
  randomToken: () => string
  randomId: () => string
  targetCap: number
}

function targetKey(target: Pick<CatalogPublicationPreviewTargetInput, 'catalogItemId' | 'venueId' | 'productId'>): string {
  return `${target.catalogItemId}\u0000${target.venueId}\u0000${target.productId}`
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

export function isCatalogPublicationIdempotencyKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, 'utf8') <= CATALOG_PUBLICATION_IDEMPOTENCY_KEY_MAX_BYTES
  )
}

function validDecisions(value: unknown): value is CatalogPublicationFieldDecisionInput[] {
  if (!Array.isArray(value) || value.length > MANAGED_FIELDS.size) return false
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) return false
    const decision = value[index]
    if (!isPlainObject(decision) || !semanticId(decision.field) || !MANAGED_FIELDS.has(decision.field as CatalogManagedFieldV1)) {
      return false
    }
    if (decision.decision === 'APPROVE_LOCAL_OVERRIDE') {
      if (!exactKeys(decision, ['field', 'decision', 'overrideId']) || !semanticId(decision.overrideId)) return false
    } else if (decision.decision === 'PUBLISH_CORPORATE' || decision.decision === 'UNDECIDED') {
      if (!exactKeys(decision, ['field', 'decision'])) return false
    } else {
      return false
    }
  }
  return new Set(value.map(decision => decision.field)).size === value.length
}

function invalidInput(): never {
  throw new AppError('La forma de la publicación es inválida.', 422, true, 'CATALOG_PUBLICATION_INPUT_INVALID')
}

function validateInput(input: CatalogPublicationPreviewInput, targetCap: number): void {
  const runtimeInput = input as unknown
  if (!isPlainObject(runtimeInput) || !exactKeys(runtimeInput, ['operation', 'idempotencyKey', 'targets'])) {
    invalidInput()
  }
  // WHY: Static operation dispatch happens before generic resource lookup so an
  // unknown string cannot probe another operation's idempotency namespace.
  if (input.operation !== 'CATALOG_FIELDS_PUBLISH') {
    throw new AppError('Operación de publicación no soportada.', 422, true, 'CATALOG_PUBLICATION_OPERATION_UNSUPPORTED')
  }
  if (!isCatalogPublicationIdempotencyKey(input.idempotencyKey)) {
    invalidInput()
  }
  if (!Array.isArray(input.targets) || input.targets.length === 0) {
    throw new ValidationError('La publicación requiere al menos un target')
  }
  if (input.targets.length > targetCap) {
    throw new AppError(`La publicación excede el límite de ${targetCap} Products.`, 413, true, 'CATALOG_PUBLICATION_TARGET_CAP_EXCEEDED')
  }
  for (let index = 0; index < input.targets.length; index += 1) {
    if (!(index in input.targets)) invalidInput()
    const target = input.targets[index] as unknown
    if (!isPlainObject(target)) invalidInput()
    const hasDecisions = Object.prototype.hasOwnProperty.call(target, 'decisions')
    if (
      !exactKeys(target, hasDecisions ? ['catalogItemId', 'venueId', 'productId', 'decisions'] : ['catalogItemId', 'venueId', 'productId'])
    ) {
      invalidInput()
    }
    if (![target.catalogItemId, target.venueId, target.productId].every(semanticId)) invalidInput()
    if (hasDecisions && !validDecisions(target.decisions)) invalidInput()
  }
  const keys = input.targets.map(targetKey)
  if (new Set(keys).size !== keys.length) {
    throw new AppError('La publicación contiene targets duplicados.', 422, true, 'CATALOG_PUBLICATION_TARGET_DUPLICATE')
  }
  if (input.targets.some(target => !target.catalogItemId.trim() || !target.venueId.trim() || !target.productId.trim())) {
    throw new ValidationError('La identidad del target de publicación es inválida')
  }
}

function normalizedFieldDecisions(
  target: CatalogPublicationPreviewTargetInput,
  projection: CatalogPublicationProjection,
): CatalogPublicationPreviewField[] {
  const supplied = target.decisions ?? []
  const suppliedByField = new Map(supplied.map(decision => [decision.field, decision]))
  if (
    supplied.length > 0 &&
    (supplied.length !== projection.fieldMask.length ||
      suppliedByField.size !== supplied.length ||
      projection.fieldMask.some(field => !suppliedByField.has(field)) ||
      supplied.some(decision => !projection.fieldMask.includes(decision.field)))
  ) {
    throw new AppError('Cada campo de la publicación requiere una decisión exacta.', 422, true, 'CATALOG_PUBLICATION_DECISIONS_INCOMPLETE')
  }

  return projection.fields.map(field => {
    const suppliedDecision = suppliedByField.get(field.field)
    const decision: CatalogPublicationFieldDecisionInput =
      suppliedDecision ??
      (field.diverged ? { field: field.field, decision: 'UNDECIDED' } : { field: field.field, decision: 'PUBLISH_CORPORATE' })
    const overrideId = decision.decision === 'APPROVE_LOCAL_OVERRIDE' ? decision.overrideId : null
    const after = decision.decision === 'PUBLISH_CORPORATE' ? field.proposed : field.before
    return { field: field.field, before: field.before, proposed: field.proposed, after, decision: decision.decision, overrideId }
  })
}

async function defaultAssertAccessTx(tx: Prisma.TransactionClient, context: CatalogCommandContext): Promise<void> {
  if (context.actor.type !== 'HUMAN' || context.actor.impersonating) {
    throw new ForbiddenError('La publicación requiere OWNER/ADMIN humano no suplantado')
  }
  const access = await resolveMasterCatalogAccess({
    organizationId: context.organizationId,
    principal: context.actor,
    capability: 'MUTATE_CONTENT',
    requiredGate: 'CORE',
    prisma: tx,
  })
  if (access.reasonCode === 'DEPENDENCY_UNAVAILABLE') {
    // WHY: Infrastructure failure is retryable and must never masquerade as a
    // stable permission denial in any publication phase.
    throw new ServiceUnavailableError('No fue posible revalidar Catalog Core', 'DEPENDENCY_UNAVAILABLE')
  }
  if (!access.canMutateContent) throw new ForbiddenError('No puedes publicar el Catálogo maestro')
}

async function defaultLoadTargetsTx(
  tx: Prisma.TransactionClient,
  context: CatalogCommandContext,
  targets: CatalogPublicationPreviewTargetInput[],
): Promise<ProjectedCatalogPublicationTarget[]> {
  return loadCatalogPublicationTargetsTx(tx, context, targets)
}

const defaults: CatalogPublicationPreviewDependencies = {
  prisma,
  assertAccessTx: defaultAssertAccessTx,
  loadTargetsTx: defaultLoadTargetsTx,
  now: () => new Date(),
  randomToken: () => randomBytes(32).toString('base64url'),
  randomId: () => cuid(),
  targetCap: CATALOG_PUBLICATION_TARGET_CAP,
}

export function createCatalogPublicationPreviewService(overrides: Partial<CatalogPublicationPreviewDependencies> = {}) {
  const dependencies = { ...defaults, ...overrides }
  return {
    async preview(context: CatalogCommandContext, input: CatalogPublicationPreviewInput): Promise<CatalogPublicationPreview> {
      validateInput(input, dependencies.targetCap)
      if (context.actor.type !== 'HUMAN' || context.actor.impersonating) {
        throw new ForbiddenError('La publicación requiere OWNER/ADMIN humano no suplantado')
      }
      const staging = createCatalogPublicationStagingService({
        prisma: dependencies.prisma,
        now: dependencies.now,
        randomToken: dependencies.randomToken,
        randomId: dependencies.randomId,
      })
      const staged = await staging.stage(context, {
        operation: input.operation,
        idempotencyKey: input.idempotencyKey,
        request: input.targets,
        prepare: async tx => {
          await dependencies.assertAccessTx(tx, context)
          const targets = await dependencies.loadTargetsTx(tx, context, input.targets)
          const projectedByKey = new Map(targets.map(target => [targetKey(target), target]))
          if (targets.length !== input.targets.length || input.targets.some(target => !projectedByKey.has(targetKey(target)))) {
            throw new AppError('Uno o más bindings de publicación no existen.', 422, true, 'CATALOG_PUBLICATION_BINDING_MISSING')
          }
          const lines = input.targets.map(requested => {
            const target = projectedByKey.get(targetKey(requested)) as ProjectedCatalogPublicationTarget
            const fields = normalizedFieldDecisions(requested, target.projection)
            return {
              catalogItemId: target.catalogItemId,
              venueId: target.venueId,
              productId: target.productId,
              bindingId: target.bindingId,
              status: target.projection.status,
              fieldMask: target.projection.fieldMask,
              canonicalTargetHash: target.projection.canonicalTargetHash,
              diagnosticCode: target.projection.diagnosticCode,
              diagnostic: target.projection.diagnostic,
              fields,
            }
          })
          const stagedTargets = targets.map(target => {
            const line = lines.find(candidate => targetKey(candidate) === targetKey(target)) as (typeof lines)[number]
            return {
              catalogItemId: target.catalogItemId,
              venueId: target.venueId,
              productId: target.productId,
              bindingId: target.bindingId,
              sourceCatalogRevision: target.sourceCatalogRevision,
              sourceCatalogInvariantVersion: target.sourceCatalogInvariantVersion,
              bindingRevision: target.bindingRevision,
              // WHY: Reviewed decisions are immutable staging authority in the
              // dual batch JSON; relational decision/override effects belong
              // exclusively to the later Product transaction.
              dependencies: { projection: target.dependencies, decisions: line.fields },
              line: {
                status: target.projection.status,
                fieldMask: target.projection.fieldMask,
                changeKind: 'PUBLICATION' as const,
                canonicalTargetHash: target.projection.canonicalTargetHash,
                before: target.projection.before as Prisma.InputJsonObject,
                after: Object.fromEntries(line.fields.map(field => [field.field, field.after])) as Prisma.InputJsonObject,
                supersedesLineId: (target.dependencies.currentPublicationLineId as string | null) ?? null,
              },
            }
          })
          const canConfirm = lines.every(
            line =>
              ['READY', 'NO_CHANGE', 'LOCAL_DIVERGENCE'].includes(line.status) &&
              line.fields.every(field => field.decision !== 'UNDECIDED'),
          )
          return {
            targets: stagedTargets,
            output: { canConfirm, lines },
          }
        },
      })
      return {
        publicationBatchId: staged.publicationBatchId,
        operation: input.operation,
        previewToken: staged.previewToken,
        targetHash: staged.targetHash,
        expiresAt: staged.expiresAt,
        canConfirm: staged.output.canConfirm,
        lines: staged.output.lines,
      }
    },
  }
}

const service = createCatalogPublicationPreviewService()

export async function previewCatalogFieldsPublication(
  context: CatalogCommandContext,
  input: CatalogPublicationPreviewInput,
): Promise<CatalogPublicationPreview> {
  return service.preview(context, input)
}
