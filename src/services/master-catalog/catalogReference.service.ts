import { CatalogReferenceStatus, Prisma } from '@prisma/client'
import AppError, { ConflictError, NotFoundError } from '../../errors/AppError'
import type { CatalogAuditInput, CatalogCommandContext, CatalogReadContext } from '../../types/master-catalog'
import prisma from '../../utils/prismaClient'
import { writeCatalogAudit } from './catalogAudit.service'
import { isCatalogIndexedTextV1, isCatalogWorkbookTextV1 } from './identifierNormalization.service'
import { acquireCatalogMutationLock } from './catalogMutationLock.service'
import { validateCatalogExpectedRevision } from './catalogItemValidation.service'
import type {
  CatalogAuditOwnership,
  CatalogMutationAuditEnvelope,
  CatalogReferenceListItem,
  CatalogReferenceMutationResult,
  CatalogReferenceProposal,
  CatalogReferenceType,
} from './catalogItem.types'

interface ReferenceRow {
  id: string
  organizationId: string
  name: string
  normalizedName: string
  status: CatalogReferenceStatus
  revision: number
  createdById: string
  updatedById: string
  parentId?: string | null
}

// WHY: Prisma delegate overloads are model-specific even though the three H1
// reference tables share one lifecycle. This narrow adapter keeps the shared
// algorithm typed without leaking `any` or accepting arbitrary operations.
interface ReferenceDelegate {
  findFirst(args: unknown): Promise<ReferenceRow | null>
  create(args: unknown): Promise<ReferenceRow>
  updateMany(args: unknown): Promise<{ count: number }>
}

function requireHuman(context: CatalogCommandContext): string {
  // WHY: Actor identity is taken only from trusted command context; service
  // principals and impersonation must never create human catalog provenance.
  if (context.actor.type !== 'HUMAN' || context.actor.impersonating || !context.actor.staffId.trim()) {
    throw new AppError('La mutación del catálogo requiere un actor humano activo.', 403, true, 'CATALOG_HUMAN_ACTOR_REQUIRED')
  }
  return context.actor.staffId
}

function failValidation(code: string, message: string): never {
  throw new AppError(message, 422, true, code)
}

export function normalizeCatalogReferenceNameV1(name: unknown): { name: string; normalizedName: string } {
  // WHY: Direct commands and XLSX imports share this versioned comparison key;
  // the exact submitted display value remains reportable and is never rewritten.
  if (typeof name !== 'string' || !isCatalogWorkbookTextV1(name))
    failValidation('CATALOG_REFERENCE_NAME_INVALID', 'El nombre de referencia excede el envelope V1.')
  const comparisonName = name.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  if (!comparisonName) failValidation('CATALOG_REFERENCE_NAME_INVALID', 'El nombre de referencia es requerido.')
  const normalizedName = comparisonName.toUpperCase()
  if (!isCatalogIndexedTextV1(normalizedName))
    failValidation('CATALOG_REFERENCE_NAME_INVALID', 'El nombre normalizado excede el límite V1.')
  return { name, normalizedName }
}

function referenceDelegate(tx: Prisma.TransactionClient, type: CatalogReferenceType): ReferenceDelegate {
  // WHY: The discriminator is closed, so an import proposal can never select
  // a table name or delegate dynamically from untrusted workbook text.
  if (type === 'BRAND') return tx.catalogBrand as unknown as ReferenceDelegate
  if (type === 'MANUFACTURER') return tx.catalogManufacturer as unknown as ReferenceDelegate
  return tx.catalogFamily as unknown as ReferenceDelegate
}

async function validateFamilyParent(
  tx: Prisma.TransactionClient,
  organizationId: string,
  parentId: string | null,
  selfId?: string,
): Promise<string | null> {
  // WHY: Explicit null creates/moves a root; undefined is handled by callers
  // as "preserve" so an UPDATE can never relink a family by omission.
  if (parentId === null) return null
  if (parentId === selfId) failValidation('CATALOG_FAMILY_HIERARCHY_INVALID', 'Una familia no puede ser su propio padre.')
  const parent = await tx.catalogFamily.findFirst({
    where: { id: parentId, organizationId, status: CatalogReferenceStatus.ACTIVE },
    select: { id: true, parentId: true },
  })
  if (!parent) throw new NotFoundError('Familia padre no encontrada.')
  if (parent.parentId) failValidation('CATALOG_FAMILY_HIERARCHY_INVALID', 'La jerarquía admite sólo padre y subfamilia.')
  return parent.id
}

async function ensureFamilyCanBecomeChild(tx: Prisma.TransactionClient, organizationId: string, referenceId: string): Promise<void> {
  // WHY: Giving a parent family its own parent would make every existing child
  // a forbidden third level, even if the new parent itself is a valid root.
  const family = await tx.catalogFamily.findFirst({
    where: { id: referenceId, organizationId },
    select: { children: { select: { id: true }, take: 1 } },
  })
  if (family?.children.length)
    failValidation('CATALOG_FAMILY_HIERARCHY_INVALID', 'Una familia con subfamilias no puede convertirse en hija.')
}

async function ensureFamilyDetachmentIsReportable(
  tx: Prisma.TransactionClient,
  organizationId: string,
  referenceId: string,
  currentParentId: string | null | undefined,
  nextParentId: string | null,
): Promise<void> {
  // WHY: CatalogItem detail requires a leaf with a parent. Detaching an in-use
  // leaf would corrupt existing ACTIVE/RETIRED reporting without any FK change.
  if (!currentParentId || nextParentId !== null) return
  const item = await tx.catalogItem.findFirst({
    where: { organizationId, familyId: referenceId },
    select: { id: true },
  })
  if (item) throw new ConflictError('La subfamilia está asignada a artículos y no puede separarse.', 'CATALOG_FAMILY_IN_USE')
}

async function assertReferenceCanRetire(
  tx: Prisma.TransactionClient,
  organizationId: string,
  referenceType: CatalogReferenceType,
  referenceId: string,
): Promise<void> {
  // WHY: Status is not part of the FK, so retirement must explicitly protect
  // every complete CatalogItem from retaining an inactive required reference.
  const itemWhere =
    referenceType === 'BRAND'
      ? { organizationId, brandId: referenceId }
      : referenceType === 'MANUFACTURER'
        ? { organizationId, manufacturerId: referenceId }
        : { organizationId, familyId: referenceId }
  const item = await tx.catalogItem.findFirst({ where: itemWhere, select: { id: true } })
  if (item) throw new ConflictError('La referencia está asignada a artículos y no puede retirarse.', 'CATALOG_REFERENCE_IN_USE')

  // WHY: A family root remains a required ACTIVE dependency of every durable
  // child, even when no CatalogItem points at the root directly.
  if (referenceType === 'FAMILY') {
    const childCount = await tx.catalogFamily.count({ where: { organizationId, parentId: referenceId } })
    if (childCount) throw new ConflictError('La familia conserva subfamilias y no puede retirarse.', 'CATALOG_FAMILY_HAS_CHILDREN')
  }
}

function envelope(type: CatalogReferenceType, verb: string, entityId: string, before?: ReferenceRow, after?: ReferenceRow) {
  // WHY: Envelopes contain bounded revision/status deltas, never whole rows or
  // raw import payloads, so Task 7 can safely summarize a batch audit.
  const auditEnvelope: CatalogMutationAuditEnvelope = {
    action: `CATALOG_${type}_${verb}`,
    entity: `Catalog${type[0]}${type.slice(1).toLowerCase()}`,
    entityId,
    batchId: null,
  }
  if (before) auditEnvelope.before = { revision: before.revision, status: before.status, normalizedName: before.normalizedName }
  if (after) auditEnvelope.after = { revision: after.revision, status: after.status, normalizedName: after.normalizedName }
  return auditEnvelope
}

async function finishAudit(
  tx: Prisma.TransactionClient,
  context: CatalogCommandContext,
  ownership: CatalogAuditOwnership,
  auditEnvelope: CatalogMutationAuditEnvelope,
): Promise<CatalogMutationAuditEnvelope> {
  // WHY: DIRECT audit is part of the same caller transaction. BATCH returns a
  // delta only, leaving the outer import transaction responsible for one log.
  const resolved = { ...auditEnvelope, batchId: ownership.kind === 'BATCH' ? ownership.batchId : null }
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

function toResult(row: ReferenceRow, reused: boolean): CatalogReferenceMutationResult {
  // WHY: Return only the stable contract needed by item/import callers; ORM
  // relation fields and implementation-specific timestamps stay encapsulated.
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    normalizedName: row.normalizedName,
    status: row.status,
    revision: row.revision,
    createdById: row.createdById,
    updatedById: row.updatedById,
    ...(row.parentId !== undefined ? { parentId: row.parentId } : {}),
    reused,
  }
}

async function createReference(
  tx: Prisma.TransactionClient,
  context: CatalogCommandContext,
  actorId: string,
  proposal: Extract<CatalogReferenceProposal, { operation: 'CREATE' }>,
): Promise<{ row: ReferenceRow; reused: boolean; auditEnvelope: CatalogMutationAuditEnvelope }> {
  const delegate = referenceDelegate(tx, proposal.referenceType)
  const normalized = normalizeCatalogReferenceNameV1(proposal.name)
  const existing = await delegate.findFirst({
    where: { organizationId: context.organizationId, normalizedName: normalized.normalizedName },
  })
  if (existing?.status === CatalogReferenceStatus.RETIRED) {
    throw new ConflictError('La referencia retirada conserva su nombre reservado.', 'CATALOG_REFERENCE_RETIRED')
  }

  // WHY: Family reuse requires the same explicit hierarchy. A proposal never
  // mutates an existing normalized family as a side effect of CREATE.
  const parentId =
    proposal.referenceType === 'FAMILY'
      ? await validateFamilyParent(tx, context.organizationId, proposal.parentId === undefined ? null : proposal.parentId)
      : undefined
  if (existing && proposal.referenceType === 'FAMILY' && (existing.parentId ?? null) !== parentId) {
    throw new ConflictError('La familia normalizada ya existe con otro padre.', 'CATALOG_REFERENCE_PARENT_CONFLICT')
  }

  const row =
    existing ??
    (await delegate.create({
      data: {
        organizationId: context.organizationId,
        ...normalized,
        status: CatalogReferenceStatus.ACTIVE,
        revision: 1,
        createdById: actorId,
        updatedById: actorId,
        ...(proposal.referenceType === 'FAMILY' ? { parentId } : {}),
      },
    }))
  return {
    row,
    reused: Boolean(existing),
    auditEnvelope: envelope(proposal.referenceType, existing ? 'REUSED' : 'CREATED', row.id, undefined, row),
  }
}

async function mutateReference(
  tx: Prisma.TransactionClient,
  context: CatalogCommandContext,
  actorId: string,
  proposal: Exclude<CatalogReferenceProposal, { operation: 'CREATE' }>,
): Promise<{ row: ReferenceRow; auditEnvelope: CatalogMutationAuditEnvelope }> {
  const delegate = referenceDelegate(tx, proposal.referenceType)
  const current = await delegate.findFirst({ where: { id: proposal.referenceId, organizationId: context.organizationId } })
  if (!current) throw new NotFoundError('Referencia de catálogo no encontrada.')
  if (current.status !== CatalogReferenceStatus.ACTIVE) {
    throw new ConflictError('La referencia retirada no puede reactivarse.', 'CATALOG_REFERENCE_RETIRED')
  }

  let data: Record<string, unknown>
  if (proposal.operation === 'RETIRE') {
    await assertReferenceCanRetire(tx, context.organizationId, proposal.referenceType, proposal.referenceId)
    data = { status: CatalogReferenceStatus.RETIRED, revision: { increment: 1 }, updatedById: actorId }
  } else {
    const normalized = normalizeCatalogReferenceNameV1(proposal.name)
    const collision = await delegate.findFirst({
      where: { organizationId: context.organizationId, normalizedName: normalized.normalizedName, id: { not: proposal.referenceId } },
      select: { id: true },
    })
    if (collision) throw new ConflictError('El nombre normalizado ya está reservado.', 'CATALOG_VALUE_ALREADY_EXISTS')
    data = { ...normalized, revision: { increment: 1 }, updatedById: actorId }
    if (proposal.referenceType === 'FAMILY' && proposal.parentId !== undefined) {
      const parentId = await validateFamilyParent(tx, context.organizationId, proposal.parentId, proposal.referenceId)
      await ensureFamilyDetachmentIsReportable(tx, context.organizationId, proposal.referenceId, current.parentId, parentId)
      if (parentId) await ensureFamilyCanBecomeChild(tx, context.organizationId, proposal.referenceId)
      data.parentId = parentId
    }
  }

  // WHY: Tenant, status, and expected revision participate in the write itself;
  // the earlier read is validation context, not the concurrency guard.
  const changed = await delegate.updateMany({
    where: {
      id: proposal.referenceId,
      organizationId: context.organizationId,
      revision: proposal.expectedRevision,
      status: CatalogReferenceStatus.ACTIVE,
    },
    data,
  })
  if (changed.count !== 1) throw new ConflictError('La revisión de la referencia cambió.', 'CATALOG_REVISION_CONFLICT')
  const row = await delegate.findFirst({ where: { id: proposal.referenceId, organizationId: context.organizationId } })
  if (!row) throw new NotFoundError('Referencia de catálogo no encontrada.')
  return {
    row,
    auditEnvelope: envelope(
      proposal.referenceType,
      proposal.operation === 'RETIRE' ? 'RETIRED' : 'UPDATED',
      proposal.referenceId,
      current,
      row,
    ),
  }
}

export async function applyCatalogReferenceProposalsTx(
  tx: Prisma.TransactionClient,
  context: CatalogCommandContext,
  proposals: CatalogReferenceProposal[],
  options: { auditOwnership: CatalogAuditOwnership },
): Promise<{ references: CatalogReferenceMutationResult[]; auditEnvelopes: CatalogMutationAuditEnvelope[] }> {
  const actorId = requireHuman(context)
  // WHY: Reject invalid/exhausted PostgreSQL INTEGER CAS tokens before the
  // shared lock or any model read turns malformed input into an ORM failure.
  for (const proposal of proposals) {
    if (proposal.operation !== 'CREATE') validateCatalogExpectedRevision(proposal.expectedRevision, 'expectedRevision')
  }
  // WHY: Every reference lifecycle shares the exact item-mutation lock before
  // preflight; ACTIVE checks and hierarchy decisions therefore remain valid.
  await acquireCatalogMutationLock(tx, context.organizationId)
  const references: CatalogReferenceMutationResult[] = []
  const auditEnvelopes: CatalogMutationAuditEnvelope[] = []
  try {
    // WHY: Sequential order is observable for proposals in one workbook; later
    // proposals may intentionally reuse a reference created earlier in the tx.
    for (const proposal of proposals) {
      if (proposal.operation === 'CREATE') {
        const result = await createReference(tx, context, actorId, proposal)
        references.push(toResult(result.row, result.reused))
        auditEnvelopes.push(await finishAudit(tx, context, options.auditOwnership, result.auditEnvelope))
      } else {
        const result = await mutateReference(tx, context, actorId, proposal)
        references.push(toResult(result.row, false))
        auditEnvelopes.push(await finishAudit(tx, context, options.auditOwnership, result.auditEnvelope))
      }
    }
    return { references, auditEnvelopes }
  } catch (error) {
    // WHY: Normalized uniqueness can race after the preflight read; Prisma's
    // unique violation is translated into the same stable domain conflict.
    if ((error as { code?: string }).code === 'P2002') {
      throw new ConflictError('El nombre normalizado ya está reservado.', 'CATALOG_VALUE_ALREADY_EXISTS')
    }
    throw error
  }
}

async function applyDirectReference(context: CatalogCommandContext, proposal: CatalogReferenceProposal) {
  // WHY: Public commands own exactly one transaction; tx-bound imports call
  // applyCatalogReferenceProposalsTx directly and therefore never nest one.
  return prisma.$transaction(tx => applyCatalogReferenceProposalsTx(tx, context, [proposal], { auditOwnership: { kind: 'DIRECT' } }))
}

// WHY: Every wrapper copies only its allowed fields and sets lifecycle/model
// discriminants after the trust boundary; forged runtime extras cannot switch
// a BRAND endpoint into a FAMILY RETIRE command (or vice versa).
export const createCatalogBrand = (context: CatalogCommandContext, input: { name: string }) =>
  applyDirectReference(context, { operation: 'CREATE', referenceType: 'BRAND', name: input.name })
export const updateCatalogBrand = (
  context: CatalogCommandContext,
  input: { referenceId: string; expectedRevision: number; name: string },
) =>
  applyDirectReference(context, {
    operation: 'UPDATE',
    referenceType: 'BRAND',
    referenceId: input.referenceId,
    expectedRevision: input.expectedRevision,
    name: input.name,
  })
export const retireCatalogBrand = (context: CatalogCommandContext, input: { referenceId: string; expectedRevision: number }) =>
  applyDirectReference(context, {
    operation: 'RETIRE',
    referenceType: 'BRAND',
    referenceId: input.referenceId,
    expectedRevision: input.expectedRevision,
  })

export const createCatalogManufacturer = (context: CatalogCommandContext, input: { name: string }) =>
  applyDirectReference(context, { operation: 'CREATE', referenceType: 'MANUFACTURER', name: input.name })
export const updateCatalogManufacturer = (
  context: CatalogCommandContext,
  input: { referenceId: string; expectedRevision: number; name: string },
) =>
  applyDirectReference(context, {
    operation: 'UPDATE',
    referenceType: 'MANUFACTURER',
    referenceId: input.referenceId,
    expectedRevision: input.expectedRevision,
    name: input.name,
  })
export const retireCatalogManufacturer = (context: CatalogCommandContext, input: { referenceId: string; expectedRevision: number }) =>
  applyDirectReference(context, {
    operation: 'RETIRE',
    referenceType: 'MANUFACTURER',
    referenceId: input.referenceId,
    expectedRevision: input.expectedRevision,
  })

export const createCatalogFamily = (context: CatalogCommandContext, input: { name: string; parentId?: string | null }) =>
  applyDirectReference(context, { operation: 'CREATE', referenceType: 'FAMILY', name: input.name, parentId: input.parentId })
export const updateCatalogFamily = (
  context: CatalogCommandContext,
  input: { referenceId: string; expectedRevision: number; name: string; parentId?: string | null },
) =>
  applyDirectReference(context, {
    operation: 'UPDATE',
    referenceType: 'FAMILY',
    referenceId: input.referenceId,
    expectedRevision: input.expectedRevision,
    name: input.name,
    parentId: input.parentId,
  })
export const retireCatalogFamily = (context: CatalogCommandContext, input: { referenceId: string; expectedRevision: number }) =>
  applyDirectReference(context, {
    operation: 'RETIRE',
    referenceType: 'FAMILY',
    referenceId: input.referenceId,
    expectedRevision: input.expectedRevision,
  })

const REFERENCE_LIST_SELECT = { id: true, name: true, status: true, revision: true } satisfies Prisma.CatalogBrandSelect
const FAMILY_LIST_SELECT = {
  id: true,
  name: true,
  status: true,
  revision: true,
  parentId: true,
  parent: { select: { id: true, name: true, status: true } },
} satisfies Prisma.CatalogFamilySelect

export async function listCatalogReferences(
  context: CatalogReadContext,
  input: {
    referenceType: CatalogReferenceType
    status?: CatalogReferenceStatus
    cursor?: string | null
    pageSize?: number
  },
): Promise<{ items: CatalogReferenceListItem[]; nextCursor: string | null }> {
  // WHY: Validate the runtime discriminator even though TypeScript closes the
  // union; HTTP/controller inputs are untyped at the actual trust boundary.
  if (!['BRAND', 'MANUFACTURER', 'FAMILY'].includes(input.referenceType)) {
    failValidation('CATALOG_REFERENCE_TYPE_INVALID', 'El tipo de referencia no es válido.')
  }
  if (input.status !== undefined && !Object.values(CatalogReferenceStatus).includes(input.status)) {
    failValidation('CATALOG_REFERENCE_STATUS_INVALID', 'El estado de referencia no es válido.')
  }
  const pageSize = input.pageSize ?? 50
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    failValidation('CATALOG_PAGE_SIZE_INVALID', 'pageSize debe estar entre 1 y 100.')
  }
  const where = {
    organizationId: context.organizationId,
    ...(input.status ? { status: input.status } : {}),
    ...(input.cursor ? { id: { gt: input.cursor } } : {}),
  }

  // WHY: Each closed branch uses a bounded select and tenant predicate; no
  // model-specific Prisma row or normalized comparison key escapes the service.
  let rows: CatalogReferenceListItem[]
  if (input.referenceType === 'BRAND') {
    const result = await prisma.catalogBrand.findMany({
      where,
      select: REFERENCE_LIST_SELECT,
      orderBy: [{ id: 'asc' }],
      take: pageSize + 1,
    })
    rows = result.map(value => ({ id: value.id, name: value.name, status: value.status, revision: value.revision }))
  } else if (input.referenceType === 'MANUFACTURER') {
    const result = await prisma.catalogManufacturer.findMany({
      where,
      select: REFERENCE_LIST_SELECT,
      orderBy: [{ id: 'asc' }],
      take: pageSize + 1,
    })
    rows = result.map(value => ({ id: value.id, name: value.name, status: value.status, revision: value.revision }))
  } else {
    const result = await prisma.catalogFamily.findMany({
      where,
      select: FAMILY_LIST_SELECT,
      orderBy: [{ id: 'asc' }],
      take: pageSize + 1,
    })
    rows = result.map(value => ({
      id: value.id,
      name: value.name,
      status: value.status,
      revision: value.revision,
      parent: value.parent ? { id: value.parent.id, name: value.parent.name, status: value.parent.status } : null,
    }))
  }

  // WHY: Fetching one sentinel row produces deterministic keyset pagination
  // without count scans; the sentinel itself is never returned.
  const hasNext = rows.length > pageSize
  const page = rows.slice(0, pageSize)
  return { items: page, nextCursor: hasNext ? (page.at(-1)?.id ?? null) : null }
}
