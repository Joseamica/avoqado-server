import { Prisma, type StaffRole } from '@prisma/client'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../errors/AppError'
import { evaluatePermissionList, hasPermission } from '../../lib/permissions'
import type {
  CatalogManagedFieldV1,
  CatalogVenueChangesInput,
  CatalogVenueChangesPage,
  CatalogVenueContext,
  CatalogVenueProvenanceInput,
  CatalogVenueProvenanceResult,
} from '../../types/master-catalog'
import { CATALOG_PREPARED_DISH_MANAGED_FIELD_MASK_V1, CATALOG_RETAIL_MANAGED_FIELD_MASK_V1 } from '../../types/master-catalog'
import prisma from '../../utils/prismaClient'

const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
  )
    throw new ValidationError(`${field} no es válido`)
  return value
}

export async function assertCatalogVenueAccess(
  tx: Prisma.TransactionClient,
  context: CatalogVenueContext,
  permission: 'catalog-venue:read' | 'catalog-venue:request-override',
  mutation: boolean,
): Promise<void> {
  if (context.actor.type !== 'HUMAN' || (mutation && context.actor.impersonating)) {
    throw new ForbiddenError('La operación requiere un actor humano no impersonado', 'CATALOG_VENUE_ACTOR_DENIED')
  }
  // WHY: Direct tenant/live-principal lookup is the sole venue authority; the
  // generic resolver contains superadmin and organization-owner shortcuts.
  const staffVenue = await tx.staffVenue.findFirst({
    where: {
      staffId: context.actor.staffId,
      venueId: context.venueId,
      active: true,
      staff: { active: true },
      venue: { organizationId: context.organizationId },
    },
    select: { role: true, permissionSetId: true, permissionSet: { select: { venueId: true, permissions: true } } },
  })
  if (!staffVenue) throw new NotFoundError('Sucursal o acceso no encontrado')
  let allowed: boolean
  if (staffVenue.permissionSetId) {
    if (!staffVenue.permissionSet || staffVenue.permissionSet.venueId !== context.venueId) {
      throw new NotFoundError('Sucursal o acceso no encontrado')
    }
    allowed = evaluatePermissionList(staffVenue.permissionSet.permissions, permission)
  } else {
    const roleOverride = await tx.venueRolePermission.findUnique({
      where: { venueId_role: { venueId: context.venueId, role: staffVenue.role } },
      select: { permissions: true },
    })
    // WHY: A stored override remains authoritative when empty, while this
    // venue surface never inherits SUPERADMIN's platform-wide wildcard.
    allowed = roleOverride
      ? evaluatePermissionList(roleOverride.permissions, permission)
      : staffVenue.role === 'SUPERADMIN'
        ? false
        : hasPermission(staffVenue.role as StaffRole, null, permission)
  }
  if (!allowed) throw new ForbiddenError('Permiso de catálogo de sucursal requerido', 'CATALOG_VENUE_PERMISSION_DENIED')
}

export const catalogVenueProvenanceSelect = {
  id: true,
  organizationId: true,
  venueId: true,
  catalogItemId: true,
  productId: true,
  revision: true,
  status: true,
  managedFieldMask: true,
  lastPublishedCatalogRevision: true,
  lastPublishedManagedSnapshot: true,
  lastPublishedManagedHash: true,
  productUpdatedAtObserved: true,
  createdAt: true,
  updatedAt: true,
  catalogItem: { select: { kind: true } },
} as const satisfies Prisma.CatalogVenueBindingSelect

type ProvenanceRow = Prisma.CatalogVenueBindingGetPayload<{ select: typeof catalogVenueProvenanceSelect }>

export function assertCatalogManagedFieldMask(kind: unknown, persistedMask: readonly string[]): CatalogManagedFieldV1[] {
  const expected = kind === 'RETAIL_PRODUCT' ? CATALOG_RETAIL_MANAGED_FIELD_MASK_V1 : CATALOG_PREPARED_DISH_MANAGED_FIELD_MASK_V1
  if (kind !== 'RETAIL_PRODUCT' && kind !== 'PREPARED_DISH') {
    throw new ConflictError('Máscara administrada de catálogo inválida', 'CATALOG_BINDING_MANAGED_MASK_INVALID')
  }
  if (persistedMask.length !== expected.length || persistedMask.some((field, index) => field !== expected[index])) {
    throw new ConflictError('Máscara administrada de catálogo inválida', 'CATALOG_BINDING_MANAGED_MASK_INVALID')
  }
  return [...expected]
}

function mapProvenance(row: ProvenanceRow): CatalogVenueProvenanceResult {
  const managedFieldMask = assertCatalogManagedFieldMask(row.catalogItem.kind, row.managedFieldMask)
  return {
    bindingId: row.id,
    catalogItemId: row.catalogItemId,
    productId: row.productId,
    status: row.status,
    revision: row.revision,
    managedFieldMask,
    lastPublishedCatalogRevision: row.lastPublishedCatalogRevision,
    lastPublishedManagedSnapshot: row.lastPublishedManagedSnapshot,
    lastPublishedManagedHash: row.lastPublishedManagedHash,
    productUpdatedAtObserved: row.productUpdatedAtObserved?.toISOString() ?? null,
  }
}

export async function getCatalogVenueProvenance(
  context: CatalogVenueContext,
  input: CatalogVenueProvenanceInput,
): Promise<CatalogVenueProvenanceResult> {
  requireOpaqueText(input.productId, 'productId', 256)
  await assertCatalogVenueAccess(prisma, context, 'catalog-venue:read', false)
  const row = await prisma.catalogVenueBinding.findFirst({
    where: { productId: input.productId, organizationId: context.organizationId, venueId: context.venueId },
    select: catalogVenueProvenanceSelect,
  })
  if (!row) throw new NotFoundError('Provenance no encontrada')
  return mapProvenance(row)
}

function decodeCursor(cursor: string): { updatedAt: Date; id: string } {
  try {
    requireOpaqueText(cursor, 'cursor', 512)
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
    if (!isRecord(value) || value.v !== 1 || typeof value.updatedAt !== 'string' || typeof value.id !== 'string') throw new Error('shape')
    const updatedAt = new Date(value.updatedAt)
    if (!Number.isFinite(updatedAt.getTime()) || updatedAt.toISOString() !== value.updatedAt) throw new Error('date')
    requireOpaqueText(value.id, 'cursor.id', 256)
    return { updatedAt, id: value.id }
  } catch {
    throw new ValidationError('cursor no es válido')
  }
}

function encodeCursor(row: Pick<ProvenanceRow, 'updatedAt' | 'id'>): string {
  return Buffer.from(JSON.stringify({ v: 1, updatedAt: row.updatedAt.toISOString(), id: row.id })).toString('base64url')
}

export async function listCatalogVenueChanges(
  context: CatalogVenueContext,
  input: CatalogVenueChangesInput = {},
): Promise<CatalogVenueChangesPage> {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input) ||
    Object.keys(input).some(key => !['cursor', 'pageSize'].includes(key))
  ) {
    throw new ValidationError('Paginación no válida')
  }
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) throw new ValidationError('pageSize no es válido')
  const cursor = input.cursor ? decodeCursor(input.cursor) : null
  await assertCatalogVenueAccess(prisma, context, 'catalog-venue:read', false)
  const rows = await prisma.catalogVenueBinding.findMany({
    where: {
      organizationId: context.organizationId,
      venueId: context.venueId,
      ...(cursor ? { OR: [{ updatedAt: { lt: cursor.updatedAt } }, { updatedAt: cursor.updatedAt, id: { lt: cursor.id } }] } : {}),
    },
    select: catalogVenueProvenanceSelect,
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: pageSize + 1,
  })
  const page = rows.slice(0, pageSize)
  return { items: page.map(mapProvenance), nextCursor: rows.length > pageSize ? encodeCursor(page[page.length - 1]) : null }
}
