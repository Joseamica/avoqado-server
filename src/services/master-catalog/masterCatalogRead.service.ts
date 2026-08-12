import { NotFoundError, ValidationError } from '../../errors/AppError'
import type { CatalogActor, CatalogReadContext, CatalogVenueContext } from '../../types/master-catalog'
import prisma from '../../utils/prismaClient'
import { listCatalogImportPreviewPage } from './catalogImportRead.service'
import { assertCatalogVenueAccess } from './catalogOverrideRead.service'

const PUBLICATION_SELECT = {
  id: true,
  operation: true,
  state: true,
  previewExpiresAt: true,
  appliedAt: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  failureCode: true,
  failureMessage: true,
  _count: { select: { lines: true } },
} as const

function publicationView(row: any) {
  return {
    publicationBatchId: row.id,
    operation: row.operation,
    state: row.state,
    previewExpiresAt: row.previewExpiresAt.toISOString(),
    appliedAt: row.appliedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    failureCode: row.failureCode,
    failureMessage: row.failureMessage,
    lineCount: row._count.lines,
  }
}

function parseCursor(value: string): { createdAt: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>
    const createdAt = new Date(String(parsed.createdAt))
    if (parsed.v !== 1 || typeof parsed.id !== 'string' || !parsed.id || !Number.isFinite(createdAt.getTime())) throw new Error('invalid')
    return { createdAt, id: parsed.id }
  } catch {
    throw new ValidationError('cursor de publicación no válido')
  }
}

function cursorFor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ v: 1, createdAt: row.createdAt.toISOString(), id: row.id })).toString('base64url')
}

export async function getCatalogPublication(context: CatalogReadContext, publicationBatchId: string) {
  if (!publicationBatchId.trim()) throw new ValidationError('publicationBatchId es requerido')
  const row = await prisma.catalogPublicationBatch.findFirst({
    where: { id: publicationBatchId, organizationId: context.organizationId },
    select: PUBLICATION_SELECT,
  })
  if (!row) throw new NotFoundError('Publicación de catálogo no encontrada')
  return publicationView(row)
}

export async function listCatalogPublications(
  context: CatalogReadContext,
  input: { cursor?: string; pageSize?: number; operation?: string; state?: string } = {},
) {
  const pageSize = input.pageSize ?? 25
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new ValidationError('pageSize no válido')
  const cursor = input.cursor ? parseCursor(input.cursor) : null
  const rows = await prisma.catalogPublicationBatch.findMany({
    where: {
      organizationId: context.organizationId,
      ...(input.operation ? { operation: input.operation } : {}),
      ...(input.state ? { state: input.state as never } : {}),
      ...(cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {}),
    },
    select: PUBLICATION_SELECT,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: pageSize + 1,
  })
  const page = rows.slice(0, pageSize)
  return {
    items: page.map(publicationView),
    nextCursor: rows.length > pageSize && page.length ? cursorFor(page[page.length - 1]) : null,
  }
}

export function getCatalogImport(context: CatalogReadContext, importBatchId: string) {
  // The Task 7 reader revalidates the original actor and returns its bounded
  // durable summary; requesting one item avoids inventing a second parser.
  return listCatalogImportPreviewPage(context as never, { importBatchId, section: 'ITEMS', pageSize: 1 })
}

export async function listCatalogValidationProfiles(context: CatalogReadContext) {
  const rows = await prisma.catalogValidationProfile.findMany({
    where: { organizationId: context.organizationId },
    select: {
      id: true,
      name: true,
      businessType: true,
      operationalRole: true,
      profileVersion: true,
      rulesSchemaVersion: true,
      requiredFields: true,
      active: true,
      createdAt: true,
    },
    orderBy: [{ name: 'asc' }, { profileVersion: 'desc' }, { id: 'desc' }],
    take: 500,
  })
  return rows.map(row => ({ ...row, createdAt: row.createdAt.toISOString() }))
}

export async function resolveCatalogVenueContext(venueId: string, actor: CatalogActor, organizationId?: string) {
  if (!venueId.trim()) throw new ValidationError('venueId es requerido')
  const scopedVenue = organizationId
    ? await prisma.venue.findFirst({
        where: { id: venueId, organizationId },
        select: { id: true, organizationId: true },
      })
    : null
  const assignment =
    !organizationId && actor.type === 'HUMAN'
      ? await prisma.staffVenue.findFirst({
          where: { staffId: actor.staffId, venueId, active: true, staff: { active: true } },
          select: { venue: { select: { id: true, organizationId: true } } },
        })
      : null
  const venue = scopedVenue ?? assignment?.venue ?? null
  if (!venue) throw new NotFoundError('Venue no encontrado')
  return { venueId: venue.id, organizationId: venue.organizationId, actor }
}

export async function getCatalogVenueAccess(context: CatalogVenueContext) {
  await assertCatalogVenueAccess(prisma, context, 'catalog-venue:read', false)
  return { allowed: true, venueId: context.venueId }
}
