import { ActivityActorType, CatalogOperationState, Prisma } from '@prisma/client'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import AppError, { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../errors/AppError'
import type {
  CatalogManagedFieldV1,
  CatalogOverrideConfirmInput,
  CatalogOverrideRequestInput,
  CatalogOverrideRequestLineInput,
  CatalogOverrideRequestPreview,
  CatalogOverrideRequestResult,
  CatalogVenueContext,
} from '../../types/master-catalog'
import { CATALOG_RETAIL_MANAGED_FIELD_MASK_V1 } from '../../types/master-catalog'
import prisma from '../../utils/prismaClient'
import { writeCatalogAudit } from './catalogAudit.service'
import { canonicalJsonV1, hashCanonicalJsonV1 } from './catalogHash.service'
import { canonicalCatalogDecimal } from './catalogMoney.service'
import { assertCatalogManagedFieldMask, assertCatalogVenueAccess, catalogVenueProvenanceSelect } from './catalogOverrideRead.service'
import {
  isCatalogOverrideSerializationFailure,
  isCatalogOverrideUniqueConstraint,
  parseCatalogOverrideDependencies,
  recoverCatalogOverrideApplied,
  type CatalogOverrideCapturedRequestV1,
  type CatalogOverrideDependenciesV1,
} from './catalogOverrideRecovery.service'

export { getCatalogVenueProvenance, listCatalogVenueChanges } from './catalogOverrideRead.service'

const OPERATION = 'CATALOG_OVERRIDE_REQUEST'
const PREVIEW_TTL_MS = 15 * 60 * 1000
export const CATALOG_OVERRIDE_REQUEST_CAP = 25
const MAX_REASON_SCALARS = 500
const MAX_REASON_BYTES = 2_000
const SHA256_HEX = /^[0-9a-f]{64}$/u

type DbClient = Prisma.TransactionClient

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}

function requireOpaqueText(value: unknown, field: string, maxBytes: number): string {
  if (
    typeof value !== 'string' ||
    !/\S/u.test(value) ||
    value.includes('\0') ||
    hasLoneSurrogate(value) ||
    Buffer.byteLength(value, 'utf8') > maxBytes
  ) {
    throw new ValidationError(`${field} no es válido`)
  }
  return value
}

function normalizeReason(value: unknown): string {
  if (typeof value !== 'string') throw new ValidationError('reason no es válido')
  const reason = value.normalize('NFC').trim()
  if (
    !reason ||
    reason.includes('\0') ||
    hasLoneSurrogate(reason) ||
    Array.from(reason).length > MAX_REASON_SCALARS ||
    Buffer.byteLength(reason, 'utf8') > MAX_REASON_BYTES
  ) {
    throw new ValidationError('reason no es válido')
  }
  return reason
}

function normalizeRequests(input: CatalogOverrideRequestInput): CatalogOverrideRequestLineInput[] {
  if (!isRecord(input) || Object.keys(input).some(key => !['bindingId', 'idempotencyKey', 'requests'].includes(key))) {
    throw new ValidationError('Solicitud de override no válida')
  }
  requireOpaqueText(input.bindingId, 'bindingId', 256)
  requireOpaqueText(input.idempotencyKey, 'idempotencyKey', 200)
  if (!Array.isArray(input.requests) || input.requests.length < 1 || input.requests.length > CATALOG_OVERRIDE_REQUEST_CAP) {
    throw new ValidationError('requests no es válido')
  }
  const seen = new Set<string>()
  return input.requests.map(request => {
    if (!isRecord(request) || Object.keys(request).sort().join(',') !== 'field,reason') {
      throw new ValidationError('Cada override acepta únicamente field y reason')
    }
    if (typeof request.field !== 'string' || !CATALOG_RETAIL_MANAGED_FIELD_MASK_V1.includes(request.field as CatalogManagedFieldV1)) {
      throw new ValidationError('field no es administrado por catálogo')
    }
    if (seen.has(request.field)) throw new ValidationError('field debe ser único por solicitud')
    seen.add(request.field)
    return { field: request.field as CatalogManagedFieldV1, reason: normalizeReason(request.reason) }
  })
}

async function readBindingTarget(tx: DbClient, context: CatalogVenueContext, bindingId: string): Promise<any> {
  const row = await tx.catalogVenueBinding.findFirst({
    where: { id: bindingId, organizationId: context.organizationId, venueId: context.venueId },
    select: {
      ...catalogVenueProvenanceSelect,
      product: {
        select: {
          id: true,
          updatedAt: true,
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
        },
      },
      catalogItem: {
        select: {
          id: true,
          kind: true,
          revision: true,
          description: true,
          imageUrl: true,
          name: true,
          objetoImp: true,
          satProductKey: true,
          satUnitKey: true,
          taxRate: true,
          productType: true,
          unit: true,
        },
      },
      venue: { select: { currency: true } },
    },
  })
  if (!row || row.status !== 'LINKED' || !row.productId || !row.product) throw new NotFoundError('Binding vinculado no encontrado')
  return row
}

function decimalValue(value: unknown, scale: number): string | null {
  return value == null ? null : canonicalCatalogDecimal(value as Prisma.Decimal, scale)
}

function fieldValue(target: any, source: 'local' | 'corporate', field: CatalogManagedFieldV1): Prisma.JsonValue {
  const row = source === 'local' ? target.product : target.catalogItem
  if (field === 'cost') return decimalValue(row.cost, 2)
  if (field === 'taxRate') return decimalValue(row.taxRate, 4)
  if (field === 'type') return source === 'local' ? row.type : row.productType
  return (row[field] ?? null) as Prisma.JsonValue
}

async function captureRequests(
  tx: DbClient,
  context: CatalogVenueContext,
  target: any,
  requests: readonly CatalogOverrideRequestLineInput[],
  rejectNoChange: boolean,
): Promise<CatalogOverrideCapturedRequestV1[]> {
  const mask = assertCatalogManagedFieldMask(target.catalogItem.kind, target.managedFieldMask)
  const captured: CatalogOverrideCapturedRequestV1[] = []
  for (const request of [...requests].sort((left, right) => compareOrdinal(left.field, right.field))) {
    if (!mask.includes(request.field)) throw new ValidationError('field no aplica al tipo de artículo')
    const localValue = fieldValue(target, 'local', request.field)
    let corporateValue = fieldValue(target, 'corporate', request.field)
    if (request.field === 'cost') {
      // WHY: Cost authority is the exact active organization PURCHASE_COST in
      // Venue currency; local Product cost never comes from caller input.
      const price = await tx.catalogItemPrice.findFirst({
        where: {
          organizationId: context.organizationId,
          catalogItemId: target.catalogItemId,
          kind: 'PURCHASE_COST',
          scope: 'ORGANIZATION',
          active: true,
          currency: target.venue.currency,
        },
        select: { amount: true },
      })
      if (!price) throw new ValidationError('No existe PURCHASE_COST activo en la moneda de la sucursal')
      corporateValue = decimalValue(price.amount, 2)
    }
    if (rejectNoChange && canonicalJsonV1(localValue) === canonicalJsonV1(corporateValue)) {
      throw new AppError('El valor local ya coincide con catálogo', 422, true, 'CATALOG_OVERRIDE_NO_CHANGE')
    }
    captured.push({ field: request.field, reason: request.reason, localValue, corporateValue })
  }
  return captured
}

function tokenMatches(rawToken: string, storedHash: string | null): boolean {
  const actual = createHash('sha256').update(rawToken).digest()
  const expected = SHA256_HEX.test(storedHash ?? '') ? Buffer.from(storedHash as string, 'hex') : Buffer.alloc(32)
  return timingSafeEqual(actual, expected) && SHA256_HEX.test(storedHash ?? '')
}

function toInputJson(value: Prisma.JsonValue): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue)
}

export async function previewCatalogOverrideRequest(
  context: CatalogVenueContext,
  input: CatalogOverrideRequestInput,
): Promise<CatalogOverrideRequestPreview> {
  const requests = normalizeRequests(input)
  const previewToken = randomBytes(32).toString('base64url')
  const requestHash = hashCanonicalJsonV1('catalog-override-request', {
    organizationId: context.organizationId,
    venueId: context.venueId,
    bindingId: input.bindingId,
    requests,
  })
  try {
    return await prisma.$transaction(async tx => {
      await assertCatalogVenueAccess(tx, context, 'catalog-venue:request-override', true)
      const target = await readBindingTarget(tx, context, input.bindingId)
      const dependencies: CatalogOverrideDependenciesV1 = {
        schemaVersion: 1,
        bindingId: target.id,
        bindingRevision: target.revision,
        venueId: context.venueId,
        productId: target.productId,
        catalogItemId: target.catalogItemId,
        requests: await captureRequests(tx, context, target, requests, true),
      }
      const targetHash = hashCanonicalJsonV1('catalog-override-target', dependencies)
      const createdAt = new Date()
      const previewExpiresAt = new Date(createdAt.getTime() + PREVIEW_TTL_MS)
      const record = await tx.catalogIdempotencyRecord.create({
        data: {
          organizationId: context.organizationId,
          operation: OPERATION,
          idempotencyKey: input.idempotencyKey,
          requestHash,
          requestHashVersion: 1,
          state: CatalogOperationState.PREVIEWED,
          targetHash,
          previewTokenHash: createHash('sha256').update(previewToken).digest('hex'),
          previewExpiresAt,
          dependencies: dependencies as unknown as Prisma.InputJsonObject,
          actorType: ActivityActorType.HUMAN,
          staffId: context.actor.type === 'HUMAN' ? context.actor.staffId : null,
          createdAt,
        },
      })
      return {
        requestBatchId: record.id,
        previewToken,
        targetHash,
        expiresAt: previewExpiresAt.toISOString(),
        requests: dependencies.requests.map(line => ({
          bindingId: target.id,
          field: line.field,
          reason: line.reason,
          localValue: line.localValue,
        })),
      }
    })
  } catch (error) {
    if (!isCatalogOverrideUniqueConstraint(error, 'CatalogIdempotencyRecord_organizationId_operation_idemp_key')) throw error
    const existing = await prisma.catalogIdempotencyRecord.findFirst({
      where: { organizationId: context.organizationId, operation: OPERATION, idempotencyKey: input.idempotencyKey },
    })
    if (!existing || existing.requestHash !== requestHash)
      throw new ConflictError('La llave ya pertenece a otro target', 'IDEMPOTENCY_KEY_REUSED')
    throw new ConflictError('Conserva el preview token original o usa una key nueva', 'CATALOG_OVERRIDE_PREVIEW_TOKEN_NOT_RECOVERABLE')
  }
}

async function recoverConcurrentApplied(
  context: CatalogVenueContext,
  input: CatalogOverrideConfirmInput,
): Promise<CatalogOverrideRequestResult | null> {
  return prisma.$transaction(async tx => {
    await assertCatalogVenueAccess(tx, context, 'catalog-venue:request-override', true)
    const record = await tx.catalogIdempotencyRecord.findFirst({
      where: { id: input.requestBatchId, organizationId: context.organizationId, operation: OPERATION },
    })
    if (
      !record ||
      record.state !== CatalogOperationState.APPLIED ||
      context.actor.type !== 'HUMAN' ||
      record.staffId !== context.actor.staffId ||
      !Buffer.from(record.idempotencyKey).equals(Buffer.from(input.idempotencyKey)) ||
      !tokenMatches(input.previewToken, record.previewTokenHash)
    )
      return null
    const dependencies = parseCatalogOverrideDependencies(record.dependencies, record.targetHash)
    return dependencies.venueId === context.venueId ? recoverCatalogOverrideApplied(tx, context, record, dependencies) : null
  })
}

export async function confirmCatalogOverrideRequest(
  context: CatalogVenueContext,
  input: CatalogOverrideConfirmInput,
): Promise<CatalogOverrideRequestResult> {
  if (
    !isRecord(input) ||
    Object.keys(input).some(key => !['requestBatchId', 'previewToken', 'confirm', 'idempotencyKey'].includes(key)) ||
    input.confirm !== true
  )
    throw new ValidationError('Confirmación de override no válida')
  requireOpaqueText(input.requestBatchId, 'requestBatchId', 256)
  requireOpaqueText(input.previewToken, 'previewToken', 512)
  requireOpaqueText(input.idempotencyKey, 'idempotencyKey', 200)
  try {
    return await prisma.$transaction(
      async tx => {
        await assertCatalogVenueAccess(tx, context, 'catalog-venue:request-override', true)
        const record = await tx.catalogIdempotencyRecord.findFirst({
          where: { id: input.requestBatchId, organizationId: context.organizationId, operation: OPERATION },
        })
        if (!record) throw new NotFoundError('Preview de override no encontrado')
        if (context.actor.type !== 'HUMAN' || record.staffId !== context.actor.staffId)
          throw new ForbiddenError('El preview pertenece a otro actor', 'CATALOG_OVERRIDE_ACTOR_MISMATCH')
        if (!Buffer.from(record.idempotencyKey).equals(Buffer.from(input.idempotencyKey)))
          throw new ConflictError('La llave no coincide con el preview', 'IDEMPOTENCY_KEY_REUSED')
        if (!tokenMatches(input.previewToken, record.previewTokenHash))
          throw new ForbiddenError('Token de preview no válido', 'CATALOG_OVERRIDE_PREVIEW_TOKEN_INVALID')
        const dependencies = parseCatalogOverrideDependencies(record.dependencies, record.targetHash)
        if (dependencies.venueId !== context.venueId || dependencies.bindingId.length < 1)
          throw new NotFoundError('Preview de override no encontrado')
        if (record.state === CatalogOperationState.APPLIED) return recoverCatalogOverrideApplied(tx, context, record, dependencies)
        if (record.state !== CatalogOperationState.PREVIEWED)
          throw new ConflictError('Preview no confirmable', 'CATALOG_OVERRIDE_NOT_CONFIRMABLE')
        const confirmedAt = new Date()
        if (!record.previewExpiresAt || record.previewExpiresAt.getTime() <= confirmedAt.getTime())
          throw new ConflictError('El preview expiró', 'CATALOG_OVERRIDE_PREVIEW_EXPIRED')
        for (const field of dependencies.requests.map(line => line.field).sort(compareOrdinal)) {
          await tx.$executeRaw(
            Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`h1a:catalog-override:${context.organizationId}:${dependencies.bindingId}:${field}`}, 0))`,
          )
        }
        const target = await readBindingTarget(tx, context, dependencies.bindingId)
        const current: CatalogOverrideDependenciesV1 = {
          schemaVersion: 1,
          bindingId: target.id,
          bindingRevision: target.revision,
          venueId: context.venueId,
          productId: target.productId,
          catalogItemId: target.catalogItemId,
          requests: await captureRequests(tx, context, target, dependencies.requests, false),
        }
        if (
          hashCanonicalJsonV1('catalog-override-target', current) !== record.targetHash ||
          canonicalJsonV1(current) !== canonicalJsonV1(dependencies)
        )
          throw new ConflictError('El target cambió después del preview', 'STALE_PREVIEW')
        const overrideIds: string[] = []
        for (const line of dependencies.requests) {
          const created = await tx.catalogVenueOverride.create({
            data: {
              organizationId: context.organizationId,
              venueId: context.venueId,
              bindingId: dependencies.bindingId,
              field: line.field,
              localValue: toInputJson(line.localValue),
              reason: line.reason,
              status: 'REQUESTED',
              requestBatchId: record.id,
              requestedById: context.actor.staffId,
              requestedAt: confirmedAt,
            },
          })
          overrideIds.push(created.id)
        }
        // WHY: One transactional summary keeps request rows and durable HUMAN
        // audit all-or-nothing; this path never calls import or publication writers.
        await writeCatalogAudit(tx, {
          organizationId: context.organizationId,
          venueId: context.venueId,
          actor: context.actor,
          action: 'CATALOG_OVERRIDE_REQUESTED',
          entity: 'CatalogVenueOverride',
          entityId: record.id,
          batchId: record.id,
          idempotencyKeyHash: createHash('sha256').update(input.idempotencyKey).digest('hex'),
          reason: dependencies.requests.map(line => line.reason).join('; '),
          metadata: { bindingId: dependencies.bindingId, fields: dependencies.requests.map(line => line.field), overrideIds },
        })
        const result: CatalogOverrideRequestResult = { requestBatchId: record.id, state: 'APPLIED', overrideIds }
        const transitioned = await tx.catalogIdempotencyRecord.updateMany({
          where: { id: record.id, organizationId: context.organizationId, state: CatalogOperationState.PREVIEWED },
          data: { state: CatalogOperationState.APPLIED, result: result as unknown as Prisma.InputJsonObject, completedAt: confirmedAt },
        })
        if (transitioned.count !== 1) throw new ConflictError('El preview cambió durante confirmación', 'CATALOG_OVERRIDE_CONCURRENT_RETRY')
        return result
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    )
  } catch (error) {
    const requestedRace = isCatalogOverrideUniqueConstraint(error, 'CatalogVenueOverride_one_requested_field_key')
    const serializationRace = isCatalogOverrideSerializationFailure(error)
    if (requestedRace || serializationRace) {
      const recovered = await recoverConcurrentApplied(context, input)
      if (recovered) return recovered
    }
    if (requestedRace) throw new ConflictError('Ya existe una solicitud para ese campo', 'CATALOG_OVERRIDE_ALREADY_REQUESTED')
    if (serializationRace) throw new ConflictError('La solicitud compitió con otra; reintenta', 'CATALOG_OVERRIDE_CONCURRENT_RETRY')
    throw error
  }
}
