import {
  BusinessType,
  CatalogIdentifierStatus,
  CatalogIdentifierType,
  CatalogItemPriceScope,
  CatalogItemStatus,
  CatalogReferenceStatus,
  Prisma,
} from '@prisma/client'
import AppError, { ConflictError, NotFoundError } from '../../errors/AppError'
import type { CatalogAuditInput, CatalogCommandContext, CatalogReadContext } from '../../types/master-catalog'
import prisma from '../../utils/prismaClient'
import { writeCatalogAudit } from './catalogAudit.service'
import { acquireCatalogMutationLock } from './catalogMutationLock.service'
import {
  CATALOG_ITEM_DETAIL_SELECT,
  type CatalogAuditOwnership,
  type CatalogItemAggregateCommand,
  type CatalogItemDetail,
  type CatalogItemDetailRow,
  type CatalogMutationAuditEnvelope,
  type CatalogOrganizationValueInput,
  type CreateCatalogItemInput,
  type PersistedCatalogOrganizationValue,
  type RetireCatalogItemInput,
  type UpdateCatalogItemInput,
  type ValidatedCatalogItem,
} from './catalogItem.types'
import {
  assertCatalogOrganizationValueRevisions,
  validateCatalogExpectedRevision,
  validateCatalogItemInput,
} from './catalogItemValidation.service'

// WHY: Keep existing consumers source-compatible while DTO ownership and
// reusable Task 6/7 contracts live in the dedicated review-sized module.
export type * from './catalogItem.types'

function failValidation(code: string, message: string): never {
  throw new AppError(message, 422, true, code)
}

function requireHuman(context: CatalogCommandContext): string {
  // WHY: Provenance is derived from the trusted context, never from a mutable
  // DTO, and H1 forbids service/impersonated actors on content commands.
  if (context.actor.type !== 'HUMAN' || context.actor.impersonating || !context.actor.staffId.trim()) {
    throw new AppError('La mutación del catálogo requiere un actor humano activo.', 403, true, 'CATALOG_HUMAN_ACTOR_REQUIRED')
  }
  return context.actor.staffId
}

async function assertActiveReferences(tx: Prisma.TransactionClient, organizationId: string, input: ValidatedCatalogItem): Promise<void> {
  // WHY: Tenant/status predicates intentionally make missing and foreign IDs
  // indistinguishable while the family projection enforces active parent+leaf.
  const [brand, manufacturer, family] = await Promise.all([
    tx.catalogBrand.findFirst({
      where: { id: input.brandId, organizationId, status: CatalogReferenceStatus.ACTIVE },
      select: { id: true },
    }),
    tx.catalogManufacturer.findFirst({
      where: { id: input.manufacturerId, organizationId, status: CatalogReferenceStatus.ACTIVE },
      select: { id: true },
    }),
    tx.catalogFamily.findFirst({
      where: { id: input.familyId, organizationId, status: CatalogReferenceStatus.ACTIVE },
      select: {
        id: true,
        parentId: true,
        parent: { select: { id: true, status: true, parentId: true } },
        children: { where: { status: CatalogReferenceStatus.ACTIVE }, select: { id: true }, take: 1 },
      },
    }),
  ])
  if (!brand || !manufacturer || !family) throw new NotFoundError('Referencia de catálogo no encontrada.')
  if (
    !family.parent ||
    family.parent.status !== CatalogReferenceStatus.ACTIVE ||
    family.parent.parentId !== null ||
    family.children.length
  ) {
    throw new AppError('El artículo requiere una subfamilia hoja con familia padre activa.', 422, true, 'CATALOG_FAMILY_LEAF_REQUIRED')
  }
}

function mapItem(row: CatalogItemDetailRow): CatalogItemDetail {
  // WHY: Explicitly remove ORM-only child containers/counts before shaping the
  // stable API response and canonical fixed-scale decimal strings.
  if (!row.family.parent) throw new AppError('La jerarquía de familia persistida es inválida.', 500, true, 'CATALOG_FAMILY_INVARIANT')
  const { businessTypes, prices, _count, ...item } = row
  return {
    ...item,
    taxRate: row.taxRate.toFixed(4),
    iepsRate: row.iepsRate?.toFixed(6) ?? null,
    iepsQuota: row.iepsQuota?.toFixed(4) ?? null,
    family: { ...row.family, parent: row.family.parent },
    businessTypes: businessTypes.map(value => value.businessType),
    organizationValues: prices.map(value => ({ ...value, amount: value.amount.toFixed(2) })),
    validation: { state: 'NOT_EVALUATED', summary: null },
    bindingSummary: { total: _count.bindings },
  }
}

async function loadItem(tx: Prisma.TransactionClient, organizationId: string, catalogItemId: string): Promise<CatalogItemDetail> {
  const row = await tx.catalogItem.findFirst({
    where: { id: catalogItemId, organizationId },
    select: CATALOG_ITEM_DETAIL_SELECT,
  })
  if (!row) throw new NotFoundError('Artículo de catálogo no encontrado.')
  return mapItem(row)
}

async function finishAudit(
  tx: Prisma.TransactionClient,
  context: CatalogCommandContext,
  ownership: CatalogAuditOwnership,
  envelope: CatalogMutationAuditEnvelope,
): Promise<CatalogMutationAuditEnvelope> {
  // WHY: Audit shares DIRECT's transaction; BATCH only returns a bounded delta
  // so its outer transaction can write exactly one import summary log.
  const resolved = { ...envelope, batchId: ownership.kind === 'BATCH' ? ownership.batchId : null }
  if (ownership.kind === 'DIRECT') {
    await writeCatalogAudit(tx, {
      organizationId: context.organizationId,
      actor: context.actor,
      action: resolved.action,
      entity: resolved.entity,
      entityId: resolved.entityId,
      batchId: null,
      before: resolved.before,
      after: resolved.after,
      metadata: resolved.metadata,
    } satisfies CatalogAuditInput)
  }
  return resolved
}

function itemScalarData(input: ValidatedCatalogItem) {
  // WHY: DTOs are an untrusted runtime boundary. An explicit allowlist prevents
  // forged tenant/revision/status/actor or future workbook fields from reaching
  // Prisma through object spread.
  return {
    sku: input.sku,
    normalizedSku: input.normalizedSku,
    kind: input.kind,
    name: input.name,
    description: input.description,
    imageUrl: input.imageUrl,
    brandId: input.brandId,
    manufacturerId: input.manufacturerId,
    familyId: input.familyId,
    presentationLabel: input.presentationLabel,
    unit: input.unit,
    taxRate: input.taxRate,
    satProductKey: input.satProductKey,
    satUnitKey: input.satUnitKey,
    objetoImp: input.objetoImp,
    productType: input.productType,
    iepsMode: input.iepsMode,
    iepsRate: input.iepsRate,
    iepsQuota: input.iepsQuota,
    iepsQuotaUnit: input.iepsQuotaUnit,
  }
}

function createData(input: ValidatedCatalogItem, actorId: string) {
  // WHY: Tenant remains outside this helper and is supplied from context by the
  // caller; status and both actor columns are likewise command-owned constants.
  return { ...itemScalarData(input), status: CatalogItemStatus.ACTIVE, createdById: actorId, updatedById: actorId }
}

function updateData(input: ValidatedCatalogItem, actorId: string) {
  return { ...itemScalarData(input), updatedById: actorId, revision: { increment: 1 } }
}

async function createChildren(
  tx: Prisma.TransactionClient,
  organizationId: string,
  catalogItemId: string,
  input: ValidatedCatalogItem,
  actorId: string,
): Promise<void> {
  // WHY: CREATE builds the complete invariant in one caller transaction; no
  // partially valid CatalogItem is ever exposed as staging.
  await tx.catalogItemBusinessType.createMany({
    data: input.businessTypes.map(businessType => ({ organizationId, catalogItemId, businessType })),
  })
  await tx.catalogItemPrice.createMany({
    data: input.organizationValues.map(value => ({
      organizationId,
      catalogItemId,
      kind: value.kind,
      scope: CatalogItemPriceScope.ORGANIZATION,
      amount: value.amount,
      currency: value.currency,
      revision: 1,
      active: true,
      createdById: actorId,
      updatedById: actorId,
    })),
  })
}

function valueKey(value: Pick<CatalogOrganizationValueInput, 'kind' | 'currency'>): string {
  return `${value.kind}:${value.currency}`
}

async function replaceBusinessTypes(
  tx: Prisma.TransactionClient,
  organizationId: string,
  catalogItemId: string,
  businessTypes: BusinessType[],
): Promise<void> {
  // WHY: Business types have no independent identity/revision contract, so a
  // full delete/create replacement is simpler and still transactionally safe.
  await tx.catalogItemBusinessType.deleteMany({ where: { catalogItemId, organizationId } })
  await tx.catalogItemBusinessType.createMany({
    data: businessTypes.map(businessType => ({ organizationId, catalogItemId, businessType })),
  })
}

async function updateOrganizationValues(
  tx: Prisma.TransactionClient,
  organizationId: string,
  catalogItemId: string,
  input: ValidatedCatalogItem,
  actorId: string,
  existing: PersistedCatalogOrganizationValue[],
): Promise<void> {
  // WHY: Stable price IDs are never deleted. Deterministic key order also
  // reduces deadlock risk when concurrent commands touch multiple currencies.
  const byKey = new Map(existing.map(value => [valueKey(value), value]))
  const ordered = [...input.organizationValues].sort((left, right) => valueKey(left).localeCompare(valueKey(right)))
  for (const value of ordered) {
    const persisted = byKey.get(valueKey(value))
    if (!persisted) {
      await tx.catalogItemPrice.create({
        data: {
          organizationId,
          catalogItemId,
          kind: value.kind,
          scope: CatalogItemPriceScope.ORGANIZATION,
          amount: value.amount,
          currency: value.currency,
          revision: 1,
          active: true,
          createdById: actorId,
          updatedById: actorId,
        },
      })
      continue
    }
    const changed = await tx.catalogItemPrice.updateMany({
      where: {
        id: persisted.id,
        organizationId,
        catalogItemId,
        scope: CatalogItemPriceScope.ORGANIZATION,
        revision: value.expectedRuleRevision,
      },
      data: { amount: value.amount, active: true, revision: { increment: 1 }, updatedById: actorId },
    })
    if (changed.count !== 1) throw new ConflictError('La revisión del valor organizacional cambió.', 'CATALOG_VALUE_REVISION_CONFLICT')
  }
  for (const tombstone of [...input.organizationValueDeactivations].sort((left, right) => valueKey(left).localeCompare(valueKey(right)))) {
    const persisted = byKey.get(valueKey(tombstone))
    if (!persisted) throw new AppError('La desactivación de valor es inválida.', 500, true, 'CATALOG_VALUE_DEACTIVATION_INVARIANT')
    const changed = await tx.catalogItemPrice.updateMany({
      where: {
        id: persisted.id,
        organizationId,
        catalogItemId,
        scope: CatalogItemPriceScope.ORGANIZATION,
        active: true,
        revision: tombstone.expectedRuleRevision,
      },
      data: { active: false, revision: { increment: 1 }, updatedById: actorId },
    })
    if (changed.count !== 1) throw new ConflictError('La revisión del valor organizacional cambió.', 'CATALOG_VALUE_REVISION_CONFLICT')
  }
}

async function createAggregate(
  tx: Prisma.TransactionClient,
  context: CatalogCommandContext,
  validated: ValidatedCatalogItem,
  actorId: string,
) {
  await assertActiveReferences(tx, context.organizationId, validated)
  const created = await tx.catalogItem.create({ data: { organizationId: context.organizationId, ...createData(validated, actorId) } })
  // WHY: Corporate SKU and its non-editable projection use the exact same
  // normalization result and become visible atomically.
  await tx.catalogIdentifier.create({
    data: {
      organizationId: context.organizationId,
      catalogItemId: created.id,
      code: validated.sku,
      normalizedCode: validated.normalizedSku,
      type: CatalogIdentifierType.CORPORATE_SKU,
      status: CatalogIdentifierStatus.ACTIVE,
      createdById: actorId,
    },
  })
  await createChildren(tx, context.organizationId, created.id, validated, actorId)
  return {
    detail: await loadItem(tx, context.organizationId, created.id),
    envelope: {
      action: 'CATALOG_ITEM_CREATED',
      entity: 'CatalogItem',
      entityId: created.id,
      batchId: null,
      after: { revision: 1, status: 'ACTIVE' },
    } satisfies CatalogMutationAuditEnvelope,
  }
}

async function updateAggregate(
  tx: Prisma.TransactionClient,
  context: CatalogCommandContext,
  input: UpdateCatalogItemInput,
  validated: ValidatedCatalogItem,
  actorId: string,
) {
  const current = await tx.catalogItem.findFirst({
    where: { id: input.catalogItemId, organizationId: context.organizationId },
    select: { id: true, sku: true, status: true, revision: true },
  })
  if (!current) throw new NotFoundError('Artículo de catálogo no encontrado.')
  if (current.status !== CatalogItemStatus.ACTIVE)
    throw new ConflictError('Un artículo retirado no puede reactivarse.', 'CATALOG_ITEM_RETIRED')
  await assertActiveReferences(tx, context.organizationId, validated)
  const existing = await tx.catalogItemPrice.findMany({
    where: { organizationId: context.organizationId, catalogItemId: input.catalogItemId, scope: CatalogItemPriceScope.ORGANIZATION },
    select: { id: true, kind: true, currency: true, revision: true, active: true },
  })
  assertCatalogOrganizationValueRevisions(validated, existing)

  // WHY: Item CAS is acquired before relationship writes; all later child CAS
  // failures still roll the surrounding transaction back completely.
  const changed = await tx.catalogItem.updateMany({
    where: {
      id: input.catalogItemId,
      organizationId: context.organizationId,
      revision: input.expectedRevision,
      status: CatalogItemStatus.ACTIVE,
    },
    data: updateData(validated, actorId),
  })
  if (changed.count !== 1) throw new ConflictError('La revisión del artículo cambió.', 'CATALOG_REVISION_CONFLICT')
  const projected = await tx.catalogIdentifier.updateMany({
    where: { catalogItemId: input.catalogItemId, organizationId: context.organizationId, type: CatalogIdentifierType.CORPORATE_SKU },
    data: { code: validated.sku, normalizedCode: validated.normalizedSku, status: CatalogIdentifierStatus.ACTIVE },
  })
  if (projected.count !== 1) throw new AppError('La proyección de SKU es inválida.', 500, true, 'CATALOG_SKU_PROJECTION_INVALID')
  await replaceBusinessTypes(tx, context.organizationId, input.catalogItemId, validated.businessTypes)
  await updateOrganizationValues(tx, context.organizationId, input.catalogItemId, validated, actorId, existing)
  return {
    detail: await loadItem(tx, context.organizationId, input.catalogItemId),
    envelope: {
      action: 'CATALOG_ITEM_UPDATED',
      entity: 'CatalogItem',
      entityId: input.catalogItemId,
      batchId: null,
      before: { revision: current.revision, sku: current.sku },
      after: { revision: input.expectedRevision + 1, sku: validated.sku },
    } satisfies CatalogMutationAuditEnvelope,
  }
}

async function retireAggregate(
  tx: Prisma.TransactionClient,
  context: CatalogCommandContext,
  input: RetireCatalogItemInput,
  actorId: string,
) {
  const current = await tx.catalogItem.findFirst({
    where: { id: input.catalogItemId, organizationId: context.organizationId },
    select: { id: true, status: true, revision: true },
  })
  if (!current) throw new NotFoundError('Artículo de catálogo no encontrado.')
  if (current.status !== CatalogItemStatus.ACTIVE) throw new ConflictError('El artículo ya fue retirado.', 'CATALOG_ITEM_RETIRED')
  const changed = await tx.catalogItem.updateMany({
    where: {
      id: input.catalogItemId,
      organizationId: context.organizationId,
      revision: input.expectedRevision,
      status: CatalogItemStatus.ACTIVE,
    },
    data: { status: CatalogItemStatus.RETIRED, updatedById: actorId, revision: { increment: 1 } },
  })
  if (changed.count !== 1) throw new ConflictError('La revisión del artículo cambió.', 'CATALOG_REVISION_CONFLICT')
  // WHY: Retirement mirrors a tombstone and deliberately retains the unique
  // normalized code; a former corporate SKU can never be recycled.
  const projected = await tx.catalogIdentifier.updateMany({
    where: { catalogItemId: input.catalogItemId, organizationId: context.organizationId, type: CatalogIdentifierType.CORPORATE_SKU },
    data: { status: CatalogIdentifierStatus.RETIRED },
  })
  if (projected.count !== 1) throw new AppError('La proyección de SKU es inválida.', 500, true, 'CATALOG_SKU_PROJECTION_INVALID')
  return {
    detail: await loadItem(tx, context.organizationId, input.catalogItemId),
    envelope: {
      action: 'CATALOG_ITEM_RETIRED',
      entity: 'CatalogItem',
      entityId: input.catalogItemId,
      batchId: null,
      before: { revision: current.revision, status: 'ACTIVE' },
      after: { revision: input.expectedRevision + 1, status: 'RETIRED' },
    } satisfies CatalogMutationAuditEnvelope,
  }
}

export async function applyCatalogItemAggregateTx(
  tx: Prisma.TransactionClient,
  context: CatalogCommandContext,
  command: CatalogItemAggregateCommand,
  options: { auditOwnership: CatalogAuditOwnership },
): Promise<{ detail: CatalogItemDetail; auditEnvelope: CatalogMutationAuditEnvelope }> {
  const actorId = requireHuman(context)
  // WHY: Pure payload and INTEGER-CAS validation runs before the advisory lock
  // or any Prisma read, keeping hostile runtime input a stable domain error.
  const validated =
    command.operation === 'CREATE'
      ? validateCatalogItemInput(command.input, 'CREATE')
      : command.operation === 'UPDATE'
        ? (validateCatalogExpectedRevision(command.input.expectedRevision, 'expectedRevision'),
          validateCatalogItemInput(command.input, 'UPDATE'))
        : (validateCatalogExpectedRevision(command.input.expectedRevision, 'expectedRevision'), null)
  // WHY: The shared org lock is acquired before reference preflight so an
  // ACTIVE assignment cannot race with reference retirement or hierarchy edits.
  await acquireCatalogMutationLock(tx, context.organizationId)
  try {
    // WHY: This tx-bound seam never opens/global-writes a transaction, allowing
    // Task 7 to compose references, items, import state, and one batch audit.
    const result =
      command.operation === 'CREATE'
        ? await createAggregate(tx, context, validated as ValidatedCatalogItem, actorId)
        : command.operation === 'UPDATE'
          ? await updateAggregate(tx, context, command.input, validated as ValidatedCatalogItem, actorId)
          : await retireAggregate(tx, context, command.input, actorId)
    return { detail: result.detail, auditEnvelope: await finishAudit(tx, context, options.auditOwnership, result.envelope) }
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      throw new ConflictError('El SKU o valor normalizado ya está reservado.', 'CATALOG_VALUE_ALREADY_EXISTS')
    }
    throw error
  }
}

// WHY: Direct public wrappers own one transaction and one audit; batch callers
// bypass only these wrappers, never the aggregate command itself.
export const createCatalogItem = (context: CatalogCommandContext, input: CreateCatalogItemInput) =>
  prisma.$transaction(tx =>
    applyCatalogItemAggregateTx(tx, context, { operation: 'CREATE', input }, { auditOwnership: { kind: 'DIRECT' } }),
  )

export const updateCatalogItem = (context: CatalogCommandContext, input: UpdateCatalogItemInput) =>
  prisma.$transaction(tx =>
    applyCatalogItemAggregateTx(tx, context, { operation: 'UPDATE', input }, { auditOwnership: { kind: 'DIRECT' } }),
  )

export const retireCatalogItem = (context: CatalogCommandContext, input: RetireCatalogItemInput) =>
  prisma.$transaction(tx =>
    applyCatalogItemAggregateTx(tx, context, { operation: 'RETIRE', input }, { auditOwnership: { kind: 'DIRECT' } }),
  )

export async function getCatalogItem(context: CatalogReadContext, catalogItemId: string): Promise<CatalogItemDetail> {
  // WHY: Tenant is part of the lookup and missing/foreign IDs intentionally
  // share a 404 to prevent cross-organization existence disclosure.
  const row = await prisma.catalogItem.findFirst({
    where: { id: catalogItemId, organizationId: context.organizationId },
    select: CATALOG_ITEM_DETAIL_SELECT,
  })
  if (!row) throw new NotFoundError('Artículo de catálogo no encontrado.')
  return mapItem(row)
}

export async function listCatalogItems(
  context: CatalogReadContext,
  input: { cursor?: string | null; pageSize?: number; status?: CatalogItemStatus } = {},
): Promise<{ items: CatalogItemDetail[]; nextCursor: string | null }> {
  const pageSize = input.pageSize ?? 50
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    failValidation('CATALOG_PAGE_SIZE_INVALID', 'pageSize debe estar entre 1 y 100.')
  }
  // WHY: ID keyset pagination is stable and the bounded select intentionally
  // excludes venue-local Recipe/modifier graphs.
  const rows = await prisma.catalogItem.findMany({
    where: {
      organizationId: context.organizationId,
      ...(input.status ? { status: input.status } : {}),
      ...(input.cursor ? { id: { gt: input.cursor } } : {}),
    },
    select: CATALOG_ITEM_DETAIL_SELECT,
    orderBy: [{ id: 'asc' }],
    take: pageSize + 1,
  })
  const hasNext = rows.length > pageSize
  const page = rows.slice(0, pageSize)
  return { items: page.map(mapItem), nextCursor: hasNext ? (page.at(-1)?.id ?? null) : null }
}
