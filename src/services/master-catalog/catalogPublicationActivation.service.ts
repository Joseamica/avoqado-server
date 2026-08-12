import type { Prisma } from '@prisma/client'
import cuid from 'cuid'
import { randomBytes } from 'node:crypto'
import AppError, { ConflictError, ForbiddenError, ServiceUnavailableError } from '../../errors/AppError'
import type {
  CatalogActor,
  CatalogCommandContext,
  CatalogPublicationPreview,
  CatalogPublicationPreviewInput,
  CatalogPublicationResultLine,
} from '../../types/master-catalog'
import prisma from '../../utils/prismaClient'
import { writeCatalogAudit } from './catalogAudit.service'
import { acquireCatalogGovernanceVenueFence } from './catalogGovernanceFence.service'
import { canonicalJsonV1, hashCanonicalJsonV1, hashCatalogManagedFieldsV1 } from './catalogHash.service'
import { enqueueCatalogPublicationOutboxTx } from './catalogPublicationOutbox.service'
import { createCatalogPublicationStagingService } from './catalogPublicationStaging.service'
import { loadCatalogPublicationTargetsTx } from './catalogPublicationTargetLoader.service'
import { resolveMasterCatalogAccess } from './masterCatalogAccess.service'
import type { CatalogPublicationProjection } from './catalogPublication.types'

export interface CatalogProductActivationTarget {
  organizationId: string
  venueId: string
  catalogItemId: string
  productId: string
  bindingId: string
  itemStatus: string
  itemRevision: number
  itemInvariantVersion: string
  bindingRevision: number
  productActive: boolean
  productDeletedAt: Date | null
  bindingStatus: string
  lastPublishedCatalogRevision: number | null
  managedHashVersion: number | null
  lastPublishedManagedHash: string | null
  publicationAuthorityValid: boolean
  profileEvaluationValid: boolean
  readiness: { state: string; dependencies: unknown }
}

export interface CatalogProductActivationProjection {
  fieldMask: ['active']
  changeKind: 'PUBLICATION'
  before: { active: false }
  proposed: { active: true }
  after: { active: true }
  canonicalTargetHash: string
}

export function evaluateCatalogProductActivationAuthority(input: {
  managedHashVersion: number | null
  managedFieldMask: string[]
  lastPublishedManagedSnapshot: unknown
  lastPublishedManagedHash: string | null
  projection: Pick<CatalogPublicationProjection, 'fieldMask' | 'fields'>
  approvedOverrides: Array<{ field: string; localValue: unknown; status: string }>
}): boolean {
  if (
    input.managedHashVersion !== 1 ||
    !input.lastPublishedManagedHash ||
    typeof input.lastPublishedManagedSnapshot !== 'object' ||
    input.lastPublishedManagedSnapshot === null ||
    Array.isArray(input.lastPublishedManagedSnapshot) ||
    canonicalJsonV1(input.managedFieldMask) !== canonicalJsonV1(input.projection.fieldMask)
  )
    return false
  try {
    const published = input.lastPublishedManagedSnapshot as Record<string, unknown>
    const actualHash = hashCatalogManagedFieldsV1({ hashVersion: 1, fieldMask: input.managedFieldMask, values: published }).hash
    if (actualHash !== input.lastPublishedManagedHash) return false
    return input.projection.fields.every(field => {
      const currentMatchesPublished = canonicalJsonV1(field.before) === canonicalJsonV1(published[field.field])
      const currentMatchesCorporate = canonicalJsonV1(field.before) === canonicalJsonV1(field.proposed)
      const matchingOverrides = input.approvedOverrides.filter(
        override =>
          override.status === 'APPROVED' &&
          override.field === field.field &&
          canonicalJsonV1(override.localValue) === canonicalJsonV1(field.before),
      )
      // WHY: Valid provenance proves the live Product is still the published
      // snapshot; any intentionally local value also needs one current approval.
      return currentMatchesPublished && (currentMatchesCorporate || matchingOverrides.length === 1)
    })
  } catch {
    return false
  }
}

function prerequisiteFailure(): never {
  throw new ConflictError('El Product no cumple los prerequisitos de activación.', 'CATALOG_ACTIVATION_PREREQUISITE_FAILED')
}

export function projectCatalogProductActivation(target: CatalogProductActivationTarget): CatalogProductActivationProjection {
  // WHY: Activation owns only lifecycle state. It proves current managed
  // publication/readiness but never smuggles a managed field into its mask.
  if (
    target.itemStatus !== 'ACTIVE' ||
    target.productActive ||
    target.productDeletedAt !== null ||
    target.bindingStatus !== 'LINKED' ||
    target.lastPublishedCatalogRevision !== target.itemRevision ||
    target.managedHashVersion !== 1 ||
    !target.lastPublishedManagedHash ||
    !/^[0-9a-f]{64}$/.test(target.lastPublishedManagedHash) ||
    !target.publicationAuthorityValid ||
    !target.profileEvaluationValid ||
    target.readiness.state !== 'READY'
  ) {
    prerequisiteFailure()
  }
  return {
    fieldMask: ['active'],
    changeKind: 'PUBLICATION',
    before: { active: false },
    proposed: { active: true },
    after: { active: true },
    canonicalTargetHash: hashCanonicalJsonV1('catalog-product-activation-target', {
      operation: 'CATALOG_PRODUCT_ACTIVATION',
      organizationId: target.organizationId,
      venueId: target.venueId,
      catalogItemId: target.catalogItemId,
      productId: target.productId,
      bindingId: target.bindingId,
      active: false,
      itemRevision: target.itemRevision,
      itemInvariantVersion: target.itemInvariantVersion,
      bindingRevision: target.bindingRevision,
      managedHash: target.lastPublishedManagedHash,
      readiness: target.readiness.dependencies,
    }),
  }
}

interface ActivationDependencies {
  acquireFence: typeof acquireCatalogGovernanceVenueFence
  revalidate: (
    tx: Prisma.TransactionClient,
    input: { organizationId: string; venueId: string; catalogItemId: string; productId: string; bindingId?: string; actor: CatalogActor },
  ) => Promise<CatalogProductActivationTarget>
  writeAudit: typeof writeCatalogAudit
  enqueueOutbox: typeof enqueueCatalogPublicationOutboxTx
}

async function defaultRevalidate(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; venueId: string; catalogItemId: string; productId: string; bindingId?: string; actor: CatalogActor },
): Promise<CatalogProductActivationTarget> {
  const binding = await tx.catalogVenueBinding.findFirst({
    where: {
      ...(input.bindingId ? { id: input.bindingId } : {}),
      organizationId: input.organizationId,
      venueId: input.venueId,
      catalogItemId: input.catalogItemId,
      productId: input.productId,
    },
    select: {
      id: true,
      revision: true,
      status: true,
      lastPublishedCatalogRevision: true,
      managedHashVersion: true,
      lastPublishedManagedHash: true,
      managedFieldMask: true,
      lastPublishedManagedSnapshot: true,
      catalogItem: { select: { status: true, revision: true, invariantVersion: true } },
      product: { select: { active: true, deletedAt: true } },
    },
  })
  if (!binding?.product) prerequisiteFailure()
  const projected = await loadCatalogPublicationTargetsTx(tx, { organizationId: input.organizationId, actor: input.actor }, [
    { catalogItemId: input.catalogItemId, venueId: input.venueId, productId: input.productId },
  ])
  const current = projected[0]
  if (!current) prerequisiteFailure()
  const approvedOverrides = await tx.catalogVenueOverride.findMany({
    where: {
      organizationId: input.organizationId,
      venueId: input.venueId,
      bindingId: binding.id,
      field: { in: current.projection.fieldMask },
      status: 'APPROVED',
    },
    select: { field: true, localValue: true, status: true },
    orderBy: { id: 'asc' },
  })
  return {
    organizationId: input.organizationId,
    venueId: input.venueId,
    catalogItemId: input.catalogItemId,
    productId: input.productId,
    bindingId: binding.id,
    itemStatus: binding.catalogItem.status,
    itemRevision: binding.catalogItem.revision,
    itemInvariantVersion: binding.catalogItem.invariantVersion.toString(),
    bindingRevision: binding.revision,
    productActive: binding.product.active,
    productDeletedAt: binding.product.deletedAt,
    bindingStatus: binding.status,
    lastPublishedCatalogRevision: binding.lastPublishedCatalogRevision,
    managedHashVersion: binding.managedHashVersion,
    lastPublishedManagedHash: binding.lastPublishedManagedHash,
    profileEvaluationValid: current.projection.status !== 'INVALID' && current.projection.status !== 'RECIPE_COST_STALE',
    publicationAuthorityValid: evaluateCatalogProductActivationAuthority({
      managedHashVersion: binding.managedHashVersion,
      managedFieldMask: binding.managedFieldMask,
      lastPublishedManagedSnapshot: binding.lastPublishedManagedSnapshot,
      lastPublishedManagedHash: binding.lastPublishedManagedHash,
      projection: current.projection,
      approvedOverrides,
    }),
    readiness: {
      state: current.projection.status === 'RECIPE_COST_STALE' ? 'STALE' : 'READY',
      dependencies: current.dependencies,
    },
  }
}

interface ActivationPreviewDependencies {
  prisma: typeof prisma
  assertAccessTx: (tx: Prisma.TransactionClient, context: CatalogCommandContext) => Promise<void>
  revalidate: typeof defaultRevalidate
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

function invalidActivationInput(): never {
  throw new AppError('La forma de la activación es inválida.', 422, true, 'CATALOG_PUBLICATION_INPUT_INVALID')
}

function validateActivationInput(input: CatalogPublicationPreviewInput): void {
  const runtime = input as unknown
  if (!isPlainObject(runtime) || !exactKeys(runtime, ['operation', 'idempotencyKey', 'targets'])) invalidActivationInput()
  if (input.operation !== 'CATALOG_PRODUCT_ACTIVATION' || !semanticId(input.idempotencyKey)) invalidActivationInput()
  if (!Array.isArray(input.targets) || input.targets.length !== 1 || !(0 in input.targets)) invalidActivationInput()
  const target = input.targets[0] as unknown
  if (!isPlainObject(target) || !exactKeys(target, ['catalogItemId', 'venueId', 'productId'])) invalidActivationInput()
  if (![target.catalogItemId, target.venueId, target.productId].every(semanticId)) invalidActivationInput()
}

async function defaultAssertActivationAccessTx(tx: Prisma.TransactionClient, context: CatalogCommandContext): Promise<void> {
  if (context.actor.type !== 'HUMAN' || context.actor.impersonating) {
    throw new ForbiddenError('La activación requiere OWNER/ADMIN humano no suplantado')
  }
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
  if (!access.canMutateContent) throw new ForbiddenError('No puedes activar Products del Catálogo maestro')
}

const previewDefaults: ActivationPreviewDependencies = {
  prisma,
  assertAccessTx: defaultAssertActivationAccessTx,
  revalidate: defaultRevalidate,
  now: () => new Date(),
  randomToken: () => randomBytes(32).toString('base64url'),
  randomId: () => cuid(),
}

export function createCatalogProductActivationPreviewService(overrides: Partial<ActivationPreviewDependencies> = {}) {
  const dependencies = { ...previewDefaults, ...overrides }
  return {
    async preview(context: CatalogCommandContext, input: CatalogPublicationPreviewInput): Promise<CatalogPublicationPreview> {
      validateActivationInput(input)
      const request = input.targets[0]
      const staging = createCatalogPublicationStagingService({
        prisma: dependencies.prisma,
        now: dependencies.now,
        randomToken: dependencies.randomToken,
        randomId: dependencies.randomId,
      })
      const staged = await staging.stage(context, {
        operation: 'CATALOG_PRODUCT_ACTIVATION',
        idempotencyKey: input.idempotencyKey,
        request: input.targets,
        prepare: async tx => {
          await dependencies.assertAccessTx(tx, context)
          const target = await dependencies.revalidate(tx, { ...request, organizationId: context.organizationId, actor: context.actor })
          const projection = projectCatalogProductActivation(target)
          const line = {
            catalogItemId: target.catalogItemId,
            venueId: target.venueId,
            productId: target.productId,
            bindingId: target.bindingId,
            status: 'READY',
            fieldMask: ['active'] as ['active'],
            canonicalTargetHash: projection.canonicalTargetHash,
            diagnosticCode: null,
            diagnostic: null,
            fields: [
              {
                field: 'active' as const,
                before: false,
                proposed: true,
                after: true,
                decision: 'PUBLISH_CORPORATE' as const,
                overrideId: null,
              },
            ],
          }
          return {
            targets: [
              {
                catalogItemId: target.catalogItemId,
                venueId: target.venueId,
                productId: target.productId,
                bindingId: target.bindingId,
                sourceCatalogRevision: target.itemRevision,
                sourceCatalogInvariantVersion: target.itemInvariantVersion,
                bindingRevision: target.bindingRevision,
                // WHY: Confirmation must reproduce activation provenance and
                // readiness; the staged line itself remains operation-only.
                dependencies: {
                  activation: {
                    itemRevision: target.itemRevision,
                    itemInvariantVersion: target.itemInvariantVersion,
                    bindingRevision: target.bindingRevision,
                    publicationAuthorityValid: target.publicationAuthorityValid,
                    profileEvaluationValid: target.profileEvaluationValid,
                    readiness: target.readiness,
                  },
                },
                line: {
                  status: 'READY' as const,
                  fieldMask: ['active'],
                  changeKind: 'PUBLICATION' as const,
                  canonicalTargetHash: projection.canonicalTargetHash,
                  before: projection.before,
                  after: projection.after,
                },
              },
            ],
            output: { canConfirm: true, lines: [line] },
          }
        },
      })
      return {
        publicationBatchId: staged.publicationBatchId,
        operation: 'CATALOG_PRODUCT_ACTIVATION',
        previewToken: staged.previewToken,
        targetHash: staged.targetHash,
        expiresAt: staged.expiresAt,
        canConfirm: staged.output.canConfirm,
        lines: staged.output.lines,
      }
    },
  }
}

const defaults: ActivationDependencies = {
  acquireFence: acquireCatalogGovernanceVenueFence,
  revalidate: defaultRevalidate,
  writeAudit: writeCatalogAudit,
  enqueueOutbox: enqueueCatalogPublicationOutboxTx,
}

export async function applyCatalogProductActivationTx(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string
    venueId: string
    productId: string
    catalogItemId: string
    bindingId: string
    publicationBatchId: string
    lineId: string
    expectedSourceCatalogRevision: number
    expectedSourceCatalogInvariantVersion: string
    expectedBindingRevision: number
    expectedCanonicalTargetHash: string
    expectedReadiness: unknown
    actor: CatalogActor
  },
  overrides: Partial<ActivationDependencies> = {},
): Promise<CatalogPublicationResultLine> {
  if (input.actor.type !== 'HUMAN' || input.actor.impersonating) {
    throw new ForbiddenError('La activación requiere OWNER/ADMIN humano no suplantado')
  }
  const dependencies = { ...defaults, ...overrides }
  await dependencies.acquireFence(tx, { organizationId: input.organizationId, venueId: input.venueId })
  const target = await dependencies.revalidate(tx, input)
  const projection = projectCatalogProductActivation(target)
  if (
    target.itemRevision !== input.expectedSourceCatalogRevision ||
    target.itemInvariantVersion !== input.expectedSourceCatalogInvariantVersion ||
    target.bindingRevision !== input.expectedBindingRevision ||
    canonicalJsonV1(target.readiness) !== canonicalJsonV1(input.expectedReadiness) ||
    projection.canonicalTargetHash !== input.expectedCanonicalTargetHash
  ) {
    throw new ConflictError('La autoridad de activación cambió después del preview.', 'STALE_PREVIEW')
  }
  const activated = await tx.product.updateMany({
    where: { id: input.productId, venueId: input.venueId, active: false, deletedAt: null },
    data: { active: true },
  })
  if (activated.count !== 1) prerequisiteFailure()
  const decisions = await tx.catalogPublicationFieldDecision.createMany({
    // WHY: The applied-line DB invariant requires the operation-only decision
    // to exist and bump decisionInvariantVersion before the line becomes APPLIED.
    data: [
      {
        id: cuid(),
        organizationId: input.organizationId,
        lineId: input.lineId,
        bindingId: input.bindingId,
        field: 'active',
        decision: 'PUBLISH_CORPORATE',
        before: false,
        proposed: true,
        after: true,
        overrideId: null,
        reason: null,
      },
    ],
  })
  if (decisions.count !== 1) throw new ConflictError('La decisión de activación cambió.', 'CATALOG_PUBLICATION_STATE_CONFLICT')
  const line = await tx.catalogPublicationLine.updateMany({
    where: {
      id: input.lineId,
      organizationId: input.organizationId,
      batchId: input.publicationBatchId,
      status: 'READY',
      fieldMask: { equals: ['active'] },
      canonicalTargetHash: projection.canonicalTargetHash,
    },
    data: { status: 'APPLIED', before: projection.before, after: projection.after },
  })
  if (line.count !== 1) throw new ConflictError('La línea de activación cambió.', 'CATALOG_PUBLICATION_STATE_CONFLICT')
  await dependencies.writeAudit(tx, {
    organizationId: input.organizationId,
    venueId: input.venueId,
    actor: input.actor,
    action: 'CATALOG_PRODUCT_ACTIVATED',
    entity: 'Product',
    entityId: input.productId,
    batchId: input.publicationBatchId,
    before: projection.before,
    after: projection.after,
  })
  await dependencies.enqueueOutbox(tx, {
    organizationId: input.organizationId,
    publicationBatchId: input.publicationBatchId,
    operation: 'CATALOG_PRODUCT_ACTIVATION',
    targets: [{ venueId: input.venueId, productId: input.productId }],
  })
  return {
    lineId: input.lineId,
    catalogItemId: input.catalogItemId,
    venueId: input.venueId,
    productId: input.productId,
    status: 'APPLIED',
  }
}
