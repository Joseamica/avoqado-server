import { createHash, timingSafeEqual } from 'node:crypto'
import { Prisma } from '@prisma/client'
import AppError, { ConflictError, NotFoundError } from '../../errors/AppError'
import type { CatalogAuditInput, CatalogCommandContext } from '../../types/master-catalog'
import type { CatalogMutationAuditEnvelope, CatalogReferenceProposal } from './catalogItem.types'
import {
  parseCatalogImportConfirmCapacityV1,
  requireCatalogImportConfirmCapacityCooperativelyV1,
  type CatalogImportConfirmCapacityV1,
} from './catalogImportCapacity.service'
import { canonicalJsonV1 } from './catalogHash.service'
import { summarizeCatalogImportAuditEnvelopes, validateCatalogImportAuditEnvelope } from './catalogImportAuditSummary.service'
import { projectCatalogImportCanonicalLineV1 } from './catalogImportMapping.service'
import { isCatalogImportIdempotencyUniqueConflict, recoverCatalogImportAppliedTx } from './catalogImportRecovery.service'
import { assertCatalogImportReviewLinesMatchItemsV1, parseCatalogImportReviewLinesV1 } from './catalogImportReviewLines.service'
import {
  CATALOG_IMPORT_CONFIRM_TRANSACTION_OPTIONS,
  CATALOG_IMPORT_ITEM_LINE_MAX_V1,
  CATALOG_IMPORT_STAGED_LINE_MAX_V1,
} from './catalogImport.types'
import type {
  CatalogImportAppliedResult,
  CatalogImportConfirmationDependencies,
  CatalogImportConfirmInput,
  CatalogImportTransaction,
} from './catalogImport.types'
import {
  catalogImportProposalMarkerV1,
  collectCatalogImportReferenceProposalsV1,
  parseCatalogImportBatchV1,
  parseCatalogImportStagedPayloadsV1,
  resolveCatalogImportCommandMarkersV1,
  resolveCatalogImportReferenceMarkerV1,
  type CatalogImportBatchRowV1,
  type CatalogImportLineRowV1,
  type CatalogImportStagedPayloadV1,
} from './catalogImportStagedPayload.service'

const CONFIRM_LEASE_MS = CATALOG_IMPORT_CONFIRM_TRANSACTION_OPTIONS.timeout + 60_000

function fail(code: string, message: string, statusCode = 400): never {
  throw new AppError(message, statusCode, true, code)
}

function isCatalogImportPreviewSnapshotConstraint(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { code?: unknown; meta?: unknown }
  if (candidate.code !== 'P2004' || typeof candidate.meta !== 'object' || candidate.meta === null) return false
  return (candidate.meta as { constraint?: unknown }).constraint === 'CatalogIdempotencyRecord_preview_snapshot_check'
}

function validateConfirmInput(input: CatalogImportConfirmInput): void {
  // WHY: Literal acknowledgement, bearer, and bounded key are independent
  // proof factors; none can be inferred from route/body defaults.
  if (input.confirm !== true) fail('CATALOG_CONFIRM_REQUIRED', 'La confirmación explícita es requerida.')
  if (typeof input.previewToken !== 'string' || input.previewToken.length < 1 || input.previewToken.length > 512) {
    fail('CATALOG_IMPORT_PREVIEW_TOKEN_INVALID', 'El token de preview no es válido.')
  }
  if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim() || input.idempotencyKey.length > 200) {
    fail('CATALOG_IDEMPOTENCY_KEY_INVALID', 'La llave de idempotencia no es válida.')
  }
}

function tokenMatches(rawToken: string, storedHash: string): boolean {
  // WHY: Comparing two fixed-length digests keeps bearer verification constant
  // time and never requires persisting or re-exposing the raw preview token.
  if (!/^[a-f0-9]{64}$/u.test(storedHash)) return false
  const actual = createHash('sha256').update(rawToken).digest()
  return timingSafeEqual(actual, Buffer.from(storedHash, 'hex'))
}

function readBatchCapacity(
  batch: CatalogImportBatchRowV1,
  allowedMeasurements: readonly ('EXACT' | 'LOWER_BOUND')[],
): CatalogImportConfirmCapacityV1 {
  if (typeof batch.dependencies !== 'object' || batch.dependencies === null || Array.isArray(batch.dependencies)) {
    fail('CATALOG_IMPORT_STAGING_INVALID', 'El batch no conserva capacidad durable.', 409)
  }
  try {
    return parseCatalogImportConfirmCapacityV1((batch.dependencies as Record<string, unknown>).capacity, allowedMeasurements)
  } catch {
    return fail('CATALOG_IMPORT_STAGING_INVALID', 'La capacidad durable no es válida.', 409)
  }
}

function rejectCapacity(capacity: CatalogImportConfirmCapacityV1): never {
  throw new AppError(
    `La importación requiere al menos ${capacity.workUnits} unidades de trabajo; el límite V1 es ${capacity.limit}.`,
    413,
    true,
    'CATALOG_IMPORT_CONFIRM_LIMIT_EXCEEDED',
    { capacity },
  )
}

function capacityMatches(left: CatalogImportConfirmCapacityV1, right: CatalogImportConfirmCapacityV1): boolean {
  return canonicalJsonV1(left) === canonicalJsonV1(right)
}

function assertPriceDependencyAuthority(batch: CatalogImportBatchRowV1, payloads: readonly CatalogImportStagedPayloadV1[]): void {
  const rawDependencies = batch.dependencies as Record<string, unknown>
  const capturedIds = rawDependencies.priceDependentItemIds
  const expectedIds = new Set(
    payloads.flatMap(payload => (payload.command.operation === 'UPDATE' ? [payload.command.input.catalogItemId] : [])),
  )
  // WHY: UPDATE with an empty captured price set still needs a durable absence
  // authority, while RETIRE must ignore price evolution. Bind that explicit set
  // to the hash-verified commands before a forged snapshot can acquire locks.
  if (
    !Array.isArray(capturedIds) ||
    capturedIds.length !== expectedIds.size ||
    capturedIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 256 || !expectedIds.has(id)) ||
    new Set(capturedIds).size !== capturedIds.length
  ) {
    fail('CATALOG_IMPORT_STAGING_INVALID', 'La autoridad de precios no coincide con los comandos staged.', 409)
  }
}

async function readVerifiedCatalogImportLines(
  tx: CatalogImportTransaction,
  batch: CatalogImportBatchRowV1,
  dependencies: CatalogImportConfirmationDependencies,
): Promise<CatalogImportLineRowV1[]> {
  const lines = (await tx.catalogImportLine.findMany({
    where: { batchId: batch.id, organizationId: batch.organizationId },
    orderBy: [{ sourceSheet: 'asc' }, { sourceRow: 'asc' }],
    // WHY: The sentinel row proves overflow without hydrating an unbounded
    // corrupt JSONB line set into the main process.
    take: CATALOG_IMPORT_STAGED_LINE_MAX_V1 + 1,
  })) as unknown as CatalogImportLineRowV1[]
  if (lines.length > CATALOG_IMPORT_STAGED_LINE_MAX_V1) {
    fail('CATALOG_IMPORT_STAGING_INVALID', 'El staging excede el límite total de filas V1.', 409)
  }
  // WHY: The worker caps every sheet independently. Reasserting the same
  // closed envelope before hashing makes durable corruption fail cheaply and
  // prevents a large ancillary section from bypassing upload-time limits.
  const allowedSheets = new Set(['Items', 'OrganizationValues', 'BusinessTypes', 'VenueBindingRequests'])
  const rowsBySheet = new Map<string, number>()
  for (const line of lines) {
    if (!allowedSheets.has(line.sourceSheet)) {
      fail('CATALOG_IMPORT_STAGING_INVALID', 'El staging contiene una sección no compatible.', 409)
    }
    const rowCount = (rowsBySheet.get(line.sourceSheet) ?? 0) + 1
    if (rowCount > CATALOG_IMPORT_ITEM_LINE_MAX_V1) {
      fail('CATALOG_IMPORT_STAGING_INVALID', 'Una sección staged excede el límite de filas V1.', 409)
    }
    rowsBySheet.set(line.sourceSheet, rowCount)
  }
  if (!lines.length || lines.some(line => line.status !== 'READY')) {
    fail('CATALOG_IMPORT_NOT_CONFIRMABLE', 'El preview contiene filas inválidas.', 409)
  }
  try {
    const canonical = await dependencies.canonicalizeRows(lines, {
      projectRow: projectCatalogImportCanonicalLineV1,
    })
    if (canonical.hash !== batch.targetHash) {
      fail('CATALOG_IMPORT_STAGING_HASH_MISMATCH', 'Las filas staged cambiaron después del preview.', 409)
    }
  } catch (error) {
    if (error instanceof AppError) throw error
    fail('CATALOG_IMPORT_STAGING_INVALID', 'Las filas staged no son canónicas.', 409)
  }
  return lines
}

async function applyReferenceProposals(
  tx: CatalogImportTransaction,
  context: CatalogCommandContext,
  batchId: string,
  payloads: readonly CatalogImportStagedPayloadV1[],
  dependencies: CatalogImportConfirmationDependencies,
): Promise<{ resolved: Map<string, string>; auditEnvelopes: CatalogMutationAuditEnvelope[] }> {
  const resolved = new Map<string, string>()
  const auditEnvelopes: CatalogMutationAuditEnvelope[] = []
  for (const proposal of await collectCatalogImportReferenceProposalsV1(payloads)) {
    const marker = catalogImportProposalMarkerV1(proposal)
    const parentId = proposal.referenceType === 'FAMILY' ? proposal.parentId : undefined
    const resolvedProposal: CatalogReferenceProposal = {
      ...proposal,
      ...(proposal.referenceType === 'FAMILY'
        ? { parentId: parentId ? resolveCatalogImportReferenceMarkerV1(parentId, resolved) : null }
        : {}),
    }
    const result = await dependencies.applyCatalogReferenceProposalsTx(tx, context, [resolvedProposal], {
      auditOwnership: { kind: 'BATCH', batchId },
    })
    const reference = result.references[0]
    if (!reference || result.references.length !== 1 || result.auditEnvelopes.length !== 1) {
      fail('CATALOG_IMPORT_AUDIT_ENVELOPE_INVALID', 'La propuesta no produjo evidencia batch exacta.', 409)
    }
    // WHY: The human approved creation of an absent reference. Reusing one
    // created after preview changes that reviewed decision, so the org-locked
    // transaction must roll back as stale before any item or batch audit.
    if (reference.reused) {
      fail('STALE_PREVIEW', 'Una referencia propuesta cambió después del preview.', 409)
    }
    auditEnvelopes.push(validateCatalogImportAuditEnvelope(result.auditEnvelopes[0], batchId, reference.id))
    resolved.set(marker, reference.id)
  }
  return { resolved, auditEnvelopes }
}

export function createCatalogImportConfirmationService(dependencies: CatalogImportConfirmationDependencies) {
  return {
    async confirm(context: CatalogCommandContext, input: CatalogImportConfirmInput): Promise<CatalogImportAppliedResult> {
      validateConfirmInput(input)
      let requestHash: string | null = null
      try {
        return await dependencies.prisma.$transaction(async tx => {
          await dependencies.assertLiveAccessTx(tx, context)
          if (context.actor.type !== 'HUMAN' || context.actor.impersonating) {
            fail('CATALOG_HUMAN_ACTOR_REQUIRED', 'La confirmación requiere un actor humano activo.', 403)
          }
          const rawBatch = await tx.catalogImportBatch.findFirst({
            where: { id: input.importBatchId, organizationId: context.organizationId },
          })
          if (!rawBatch) throw new NotFoundError('Preview de importación no encontrado.')
          const batch = parseCatalogImportBatchV1(rawBatch)
          requestHash = batch.requestHash
          if (batch.staffId !== context.actor.staffId) fail('CATALOG_IMPORT_ACTOR_MISMATCH', 'El preview pertenece a otro actor.', 403)
          const capturedCapacity = readBatchCapacity(batch, batch.state === 'FAILED' ? ['EXACT', 'LOWER_BOUND'] : ['EXACT'])
          if (batch.state === 'FAILED') {
            // WHY: No bearer exists for FAILED previews. A live, same-actor
            // caller receives the stable resource result before token checks.
            if (!capturedCapacity.withinLimit || batch.failureCode === 'CATALOG_IMPORT_CONFIRM_LIMIT_EXCEEDED') {
              return rejectCapacity(capturedCapacity)
            }
            fail('CATALOG_IMPORT_NOT_CONFIRMABLE', 'El preview contiene errores de validación.', 409)
          }
          if (!tokenMatches(input.previewToken, batch.previewTokenHash)) {
            fail('CATALOG_IMPORT_PREVIEW_TOKEN_INVALID', 'El token de preview no es válido.', 403)
          }
          if (batch.state === 'APPLIED') {
            return recoverCatalogImportAppliedTx(tx, context, input, batch.requestHash)
          }
          if (batch.state !== 'PREVIEWED') fail('CATALOG_IMPORT_NOT_CONFIRMABLE', 'El preview no está confirmable.', 409)
          const previewCheckedAt = dependencies.now()
          if (batch.previewExpiresAt.getTime() <= previewCheckedAt.getTime()) {
            fail('CATALOG_IMPORT_PREVIEW_EXPIRED', 'El preview expiró.', 409)
          }
          const lines = await readVerifiedCatalogImportLines(tx, batch, dependencies)
          // WHY: Every source row participates in the target hash, while only
          // Items carry Task 5 commands. Parse and cross-check all durable
          // review authority before acquiring locks or creating state rows.
          const itemLines = lines.filter(line => line.sourceSheet === 'Items')
          const reviewLines = lines.filter(line => line.sourceSheet !== 'Items')
          if (
            !itemLines.length ||
            reviewLines.some(line => !['OrganizationValues', 'BusinessTypes', 'VenueBindingRequests'].includes(line.sourceSheet))
          ) {
            fail('CATALOG_IMPORT_STAGING_INVALID', 'El staging contiene una sección no compatible.', 409)
          }
          const payloads = await parseCatalogImportStagedPayloadsV1(itemLines)
          const reviewPayloads = await parseCatalogImportReviewLinesV1(reviewLines)
          await assertCatalogImportReviewLinesMatchItemsV1(payloads, reviewPayloads)
          assertPriceDependencyAuthority(batch, payloads)
          const confirmedCapacity = await requireCatalogImportConfirmCapacityCooperativelyV1(payloads)
          if (!capacityMatches(confirmedCapacity, capturedCapacity)) {
            fail('CATALOG_IMPORT_STAGING_INVALID', 'La capacidad no coincide con los comandos staged.', 409)
          }
          // WHY: All cooperating item/reference/profile writers acquire this
          // organization lock first. Revalidation under it closes the READ
          // COMMITTED gap until the atomic import commits or rolls back.
          await dependencies.acquireMutationLockTx(tx, context.organizationId)
          await dependencies.assertLiveAccessTx(tx, context)
          const lockedRawBatch = await tx.catalogImportBatch.findFirst({
            where: { id: input.importBatchId, organizationId: context.organizationId },
          })
          if (!lockedRawBatch) throw new NotFoundError('Preview de importación no encontrado.')
          const authoritativeBatch = parseCatalogImportBatchV1(lockedRawBatch)
          const authoritativeCapacity = readBatchCapacity(authoritativeBatch, ['EXACT'])
          // WHY: A same-key waiter may have observed PREVIEWED before blocking
          // on the org lock. Once the winner commits, recover its exact durable
          // result before stale-dependency checks can misclassify the replay.
          if (authoritativeBatch.state === 'APPLIED') {
            return recoverCatalogImportAppliedTx(tx, context, input, batch.requestHash)
          }
          if (authoritativeBatch.state !== 'PREVIEWED') {
            throw new ConflictError('Otro confirm cambió el preview.', 'CATALOG_IMPORT_IN_PROGRESS')
          }
          if (
            authoritativeBatch.requestHash !== batch.requestHash ||
            authoritativeBatch.targetHash !== batch.targetHash ||
            authoritativeBatch.previewTokenHash !== batch.previewTokenHash ||
            authoritativeBatch.staffId !== batch.staffId ||
            authoritativeBatch.createdAt.getTime() !== batch.createdAt.getTime() ||
            authoritativeBatch.updatedAt.getTime() !== batch.updatedAt.getTime()
          ) {
            fail('CATALOG_IMPORT_STAGING_INVALID', 'La autoridad del preview cambió durante la espera.', 409)
          }
          if (!capacityMatches(authoritativeCapacity, confirmedCapacity)) {
            fail('CATALOG_IMPORT_STAGING_INVALID', 'La capacidad cambió durante la espera.', 409)
          }
          const attemptStartedAt = dependencies.now()
          if (authoritativeBatch.previewExpiresAt.getTime() <= attemptStartedAt.getTime()) {
            fail('CATALOG_IMPORT_PREVIEW_EXPIRED', 'El preview expiró durante la espera.', 409)
          }
          const authoritativeLines = await readVerifiedCatalogImportLines(tx, authoritativeBatch, dependencies)
          const authoritativeItemLines = authoritativeLines.filter(line => line.sourceSheet === 'Items')
          if (authoritativeItemLines.length !== itemLines.length) {
            fail('CATALOG_IMPORT_STAGING_INVALID', 'La autoridad Items cambió durante la espera.', 409)
          }
          await dependencies.revalidateDependenciesTx(tx, context, authoritativeBatch.dependencies)
          const attemptId = dependencies.randomAttemptId()
          const leaseExpiresAt = new Date(attemptStartedAt.getTime() + CONFIRM_LEASE_MS)
          await tx.catalogIdempotencyRecord.create({
            data: {
              organizationId: context.organizationId,
              operation: 'CATALOG_IMPORT',
              idempotencyKey: input.idempotencyKey,
              requestHash: authoritativeBatch.requestHash,
              requestHashVersion: 1,
              state: 'APPLYING',
              resourceType: 'CatalogImportBatch',
              resourceId: authoritativeBatch.id,
              targetHash: authoritativeBatch.targetHash,
              previewTokenHash: authoritativeBatch.previewTokenHash,
              previewExpiresAt: authoritativeBatch.previewExpiresAt,
              dependencies: authoritativeBatch.dependencies as Prisma.InputJsonValue,
              attemptId,
              leaseExpiresAt,
              // WHY: Bind the durable snapshot check to the same instant that
              // passed expiry validation. A database default evaluated after
              // revalidation could cross the boundary and surface as P2004.
              createdAt: attemptStartedAt,
              heartbeatAt: attemptStartedAt,
              actorType: 'HUMAN',
              staffId: context.actor.staffId,
            },
          })
          const acquired = await tx.catalogImportBatch.updateMany({
            where: { id: authoritativeBatch.id, organizationId: context.organizationId, state: 'PREVIEWED' },
            data: { state: 'APPLYING', attemptId, leaseExpiresAt, heartbeatAt: attemptStartedAt },
          })
          if (acquired.count !== 1) throw new ConflictError('Otro confirm ya adquirió el preview.', 'CATALOG_IMPORT_IN_PROGRESS')

          const references = await applyReferenceProposals(tx, context, authoritativeBatch.id, payloads, dependencies)
          const auditEnvelopes = [...references.auditEnvelopes]
          const appliedItemIds: string[] = []
          for (let index = 0; index < authoritativeItemLines.length; index += 1) {
            const line = authoritativeItemLines[index] as CatalogImportLineRowV1
            const payload = payloads[index] as CatalogImportStagedPayloadV1
            const result = await dependencies.applyCatalogItemAggregateTx(
              tx,
              context,
              resolveCatalogImportCommandMarkersV1(payload.command, references.resolved),
              { auditOwnership: { kind: 'BATCH', batchId: authoritativeBatch.id } },
            )
            appliedItemIds.push(result.detail.id)
            auditEnvelopes.push(validateCatalogImportAuditEnvelope(result.auditEnvelope, authoritativeBatch.id, result.detail.id))
            const lineApplied = await tx.catalogImportLine.updateMany({
              where: { id: line.id, organizationId: context.organizationId, status: 'READY' },
              data: { status: 'APPLIED', catalogItemId: result.detail.id },
            })
            if (lineApplied.count !== 1) {
              throw new ConflictError('La fila staged cambió durante la confirmación.', 'CATALOG_IMPORT_STATE_CONFLICT')
            }
          }
          const result: CatalogImportAppliedResult = { importBatchId: authoritativeBatch.id, state: 'APPLIED', appliedItemIds }
          const idempotencyKeyHash = createHash('sha256').update(input.idempotencyKey).digest('hex')
          // WHY: Task 5 returns BATCH envelopes without writing per-row logs;
          // this one summary is co-committed with every item/reference/state CAS.
          await dependencies.writeCatalogAudit(tx, {
            organizationId: context.organizationId,
            actor: context.actor,
            action: 'CATALOG_IMPORT_APPLIED',
            entity: 'CatalogImportBatch',
            entityId: authoritativeBatch.id,
            batchId: authoritativeBatch.id,
            idempotencyKeyHash,
            metadata: {
              appliedItemCount: appliedItemIds.length,
              ...(await summarizeCatalogImportAuditEnvelopes(auditEnvelopes)),
            },
          } satisfies CatalogAuditInput)
          const completedAt = dependencies.now()
          const batchApplied = await tx.catalogImportBatch.updateMany({
            where: { id: authoritativeBatch.id, organizationId: context.organizationId, state: 'APPLYING', attemptId },
            data: {
              state: 'APPLIED',
              result: result as unknown as Prisma.InputJsonValue,
              attemptId: null,
              leaseExpiresAt: null,
              heartbeatAt: null,
              appliedAt: completedAt,
              completedAt,
            },
          })
          if (batchApplied.count !== 1) {
            throw new ConflictError('El batch cambió durante la confirmación.', 'CATALOG_IMPORT_STATE_CONFLICT')
          }
          const idempotencyApplied = await tx.catalogIdempotencyRecord.updateMany({
            where: {
              organizationId: context.organizationId,
              operation: 'CATALOG_IMPORT',
              idempotencyKey: input.idempotencyKey,
              state: 'APPLYING',
              attemptId,
            },
            data: {
              state: 'APPLIED',
              result: result as unknown as Prisma.InputJsonValue,
              attemptId: null,
              leaseExpiresAt: null,
              heartbeatAt: null,
              completedAt,
            },
          })
          if (idempotencyApplied.count !== 1) {
            throw new ConflictError('La reserva idempotente cambió durante la confirmación.', 'CATALOG_IMPORT_STATE_CONFLICT')
          }
          return result
        }, CATALOG_IMPORT_CONFIRM_TRANSACTION_OPTIONS)
      } catch (error) {
        if (isCatalogImportPreviewSnapshotConstraint(error)) {
          fail('CATALOG_IMPORT_PREVIEW_EXPIRED', 'El preview expiró antes de reservar la confirmación.', 409)
        }
        if (isCatalogImportIdempotencyUniqueConflict(error)) {
          if (requestHash === null) {
            throw new ConflictError('La llave de idempotencia ya está reservada.', 'IDEMPOTENCY_KEY_REUSED')
          }
          return dependencies.prisma.$transaction(async tx => {
            // WHY: Recovery after an aborted unique race rechecks live access
            // and all three durable authorities in one fresh transaction.
            await dependencies.assertLiveAccessTx(tx, context)
            return recoverCatalogImportAppliedTx(tx, context, input, requestHash as string)
          }, CATALOG_IMPORT_CONFIRM_TRANSACTION_OPTIONS)
        }
        throw error
      }
    },
  }
}
