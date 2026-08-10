import { ActivityActorType, Prisma } from '@prisma/client'
import cuid from 'cuid'
import { createHash, randomBytes } from 'node:crypto'
import { ConflictError, ForbiddenError } from '../../errors/AppError'
import type { CatalogCommandContext, CatalogPublicationOperation } from '../../types/master-catalog'
import prisma from '../../utils/prismaClient'
import { canonicalJsonV1, hashCanonicalJsonV1 } from './catalogHash.service'

const PREVIEW_TTL_MS = 30 * 60 * 1_000
const WRITE_CHUNK_SIZE = 500

export interface CatalogPublicationStageTarget {
  catalogItemId: string
  venueId: string
  productId: string
  bindingId: string
  sourceCatalogRevision: number
  sourceCatalogInvariantVersion: string
  bindingRevision: number
  dependencies: unknown
  line: {
    status: Prisma.CatalogPublicationLineCreateManyInput['status']
    fieldMask: string[]
    changeKind: Prisma.CatalogPublicationLineCreateManyInput['changeKind']
    canonicalTargetHash: string
    before: Prisma.InputJsonValue
    after: Prisma.InputJsonValue
    supersedesLineId?: string | null
    reversesLineId?: string | null
  }
}

interface StagingDependencies {
  prisma: typeof prisma
  now: () => Date
  randomToken: () => string
  randomId: () => string
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeInputJsonObject(value: unknown): Prisma.InputJsonObject {
  const normalized: unknown = JSON.parse(canonicalJsonV1(value))
  if (!isPlainObject(normalized)) throw new Error('CATALOG_PUBLICATION_DEPENDENCIES_INVALID')
  // WHY: canonical serialization rejects non-JSON values before Prisma sees
  // them; the root shape check then proves the durable object input contract.
  return normalized as Prisma.InputJsonObject
}

function isOperationKeyConflict(error: unknown): boolean {
  if (!isPlainObject(error) || error.code !== 'P2002' || !isPlainObject(error.meta)) return false
  const target = error.meta.target
  if (target === 'CatalogIdempotencyRecord_organizationId_operation_idemp_key') return true
  return Array.isArray(target) && target.join('\u0000') === ['organizationId', 'operation', 'idempotencyKey'].join('\u0000')
}

function chunks<T>(values: readonly T[]): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += WRITE_CHUNK_SIZE) result.push(values.slice(index, index + WRITE_CHUNK_SIZE))
  return result
}

const defaults: StagingDependencies = {
  prisma,
  now: () => new Date(),
  randomToken: () => randomBytes(32).toString('base64url'),
  randomId: () => cuid(),
}

export function createCatalogPublicationStagingService(overrides: Partial<StagingDependencies> = {}) {
  const dependencies = { ...defaults, ...overrides }
  return {
    async stage<T>(
      context: CatalogCommandContext,
      input: {
        operation: CatalogPublicationOperation
        idempotencyKey: string
        request: unknown
        prepare: (tx: Prisma.TransactionClient) => Promise<{ targets: CatalogPublicationStageTarget[]; output: T }>
      },
    ): Promise<{
      publicationBatchId: string
      previewToken: string
      targetHash: string
      expiresAt: string
      lineIds: string[]
      output: T
    }> {
      if (context.actor.type !== 'HUMAN' || context.actor.impersonating) {
        throw new ForbiddenError('El staging requiere OWNER/ADMIN humano no suplantado')
      }
      const staffId = context.actor.staffId
      const attemptedHolder: {
        current: { requestHash: string; targetHash: string; durableDependencies: Prisma.InputJsonObject } | null
      } = { current: null }
      try {
        return await dependencies.prisma.$transaction(
          async tx => {
            const prepared = await input.prepare(tx)
            const publicationBatchId = dependencies.randomId()
            const idempotencyRecordId = dependencies.randomId()
            const lineIds = prepared.targets.map(() => dependencies.randomId())
            const previewToken = dependencies.randomToken()
            const now = dependencies.now()
            const expiresAt = new Date(now.getTime() + PREVIEW_TTL_MS)
            const requestHash = hashCanonicalJsonV1('catalog-publication-request', {
              operation: input.operation,
              request: input.request,
            })
            const targetHash = hashCanonicalJsonV1('catalog-publication-targets', {
              operation: input.operation,
              targets: prepared.targets.map(target => target.line.canonicalTargetHash),
            })
            const durableDependencies = normalizeInputJsonObject({
              schemaVersion: 1,
              targets: prepared.targets.map(({ line: _line, ...target }) => target),
            })
            attemptedHolder.current = { requestHash, targetHash, durableDependencies }
            const shared = {
              organizationId: context.organizationId,
              operation: input.operation,
              state: 'PREVIEWED' as const,
              requestHash,
              requestHashVersion: 1,
              targetHash,
              previewTokenHash: sha256(previewToken),
              previewExpiresAt: expiresAt,
              dependencies: durableDependencies,
              actorType: ActivityActorType.HUMAN,
              staffId,
              createdAt: now,
            }
            // WHY: Dual authority and every nonterminal line share one transaction;
            // no preview can expose a bearer for partially staged targets.
            await tx.catalogPublicationBatch.create({
              data: { id: publicationBatchId, schemaVersion: 1, ...shared },
            })
            await tx.catalogIdempotencyRecord.create({
              data: {
                id: idempotencyRecordId,
                ...shared,
                idempotencyKey: input.idempotencyKey,
                resourceType: 'CatalogPublicationBatch',
                resourceId: publicationBatchId,
              },
            })
            const lineRows = prepared.targets.map((target, index) => ({
              id: lineIds[index],
              organizationId: context.organizationId,
              batchId: publicationBatchId,
              bindingId: target.bindingId,
              catalogItemId: target.catalogItemId,
              venueId: target.venueId,
              productId: target.productId,
              status: target.line.status,
              fieldMask: target.line.fieldMask,
              decisionSchemaVersion: 1,
              changeKind: target.line.changeKind,
              hashVersion: 1,
              canonicalTargetHash: target.line.canonicalTargetHash,
              before: target.line.before,
              after: target.line.after,
              sourceCatalogRevision: target.sourceCatalogRevision,
              bindingRevision: target.bindingRevision,
              supersedesLineId: target.line.supersedesLineId ?? null,
              reversesLineId: target.line.reversesLineId ?? null,
            }))
            for (const chunk of chunks(lineRows)) {
              const created = await tx.catalogPublicationLine.createMany({ data: chunk })
              if (created.count !== chunk.length) throw new Error('CATALOG_PUBLICATION_STAGING_LINE_COUNT_INVALID')
            }
            return {
              publicationBatchId,
              previewToken,
              targetHash,
              expiresAt: expiresAt.toISOString(),
              lineIds,
              output: prepared.output,
            }
          },
          { timeout: 90_000 },
        )
      } catch (error) {
        const attempted = attemptedHolder.current
        if (!isOperationKeyConflict(error) || !attempted) throw error
        const record = await dependencies.prisma.catalogIdempotencyRecord.findUnique({
          where: {
            organizationId_operation_idempotencyKey: {
              organizationId: context.organizationId,
              operation: input.operation,
              idempotencyKey: input.idempotencyKey,
            },
          },
        })
        const batch = record?.resourceId
          ? await dependencies.prisma.catalogPublicationBatch.findFirst({
              where: { id: record.resourceId, organizationId: context.organizationId, operation: input.operation },
            })
          : null
        let matches = false
        try {
          matches = Boolean(
            record &&
              batch &&
              record.resourceType === 'CatalogPublicationBatch' &&
              record.resourceId === batch.id &&
              record.requestHash === attempted.requestHash &&
              batch.requestHash === attempted.requestHash &&
              record.targetHash === attempted.targetHash &&
              batch.targetHash === attempted.targetHash &&
              record.actorType === 'HUMAN' &&
              batch.actorType === 'HUMAN' &&
              record.staffId === staffId &&
              batch.staffId === staffId &&
              record.state === batch.state &&
              record.previewTokenHash === batch.previewTokenHash &&
              record.previewExpiresAt?.getTime() === batch.previewExpiresAt.getTime() &&
              canonicalJsonV1(record.dependencies) === canonicalJsonV1(attempted.durableDependencies) &&
              canonicalJsonV1(batch.dependencies) === canonicalJsonV1(attempted.durableDependencies),
          )
        } catch {
          matches = false
        }
        if (!matches) throw new ConflictError('La idempotencyKey ya pertenece a otra solicitud.', 'IDEMPOTENCY_KEY_REUSED')
        if (record?.state === 'PREVIEWED') {
          throw new ConflictError(
            'El token del preview existente no puede recuperarse; usa una key nueva.',
            'CATALOG_PUBLICATION_PREVIEW_TOKEN_NOT_RECOVERABLE',
          )
        }
        if (record?.state === 'APPLYING' || record?.state === 'APPLIED') {
          throw new ConflictError('Recupera o confirma la publicación existente.', 'CATALOG_PUBLICATION_RECOVERY_REQUIRED')
        }
        throw new ConflictError('La publicación requiere un preview y una key nuevos.', 'CATALOG_PUBLICATION_NEW_PREVIEW_REQUIRED')
      }
    },
  }
}
