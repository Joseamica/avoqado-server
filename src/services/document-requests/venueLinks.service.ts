import { createHash } from 'crypto'
import { DocumentRequest, DocumentRequestFile, Prisma } from '@prisma/client'
import { z } from 'zod'
import prisma from '../../utils/prismaClient'
import { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
import { signPrivateAttachmentUrl, signPrivatePreviewUrl } from '../privateStorage.service'

type Tx = Prisma.TransactionClient
const id = z.string().regex(/^c[a-z0-9]{24}$/, 'Identificador inválido')
export const selectionSchema = z
  .object({
    id,
    submissionVersion: z.number().int('Versión inválida').min(1, 'Versión inválida'),
    confirmed: z.literal(true, { errorMap: () => ({ message: 'Confirma que el expediente corresponde al negocio' }) }),
  })
  .strict('Se enviaron campos no admitidos')
export type Selection = z.infer<typeof selectionSchema>
const linkInput = selectionSchema.omit({ id: true }).extend({ venueId: id })
export function validationMessage(issue: z.ZodIssue): string {
  return /^(Required|Expected|Invalid)/.test(issue.message) ? `Revisa el campo ${issue.path.join('.') || 'solicitud'}` : issue.message
}
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value)
  if (!result.success) throw new BadRequestError(result.error.issues.map(validationMessage).join('. '))
  return result.data
}
export function parseSelection(value: unknown): Selection {
  return parse(selectionSchema, value)
}
export type PageInput = { page?: unknown; pageSize?: unknown; search?: unknown }
export function parsePage(input: PageInput = {}) {
  return {
    page: parse(
      z.coerce.number().int('Página inválida').min(1, 'La página mínima es 1').max(100000, 'Página fuera de rango').default(1),
      input.page,
    ),
    pageSize: Math.min(100, parse(z.coerce.number().int('Tamaño inválido').min(1, 'El tamaño mínimo es 1').default(10), input.pageSize)),
    search: parse(z.string().trim().max(160, 'La búsqueda admite máximo 160 caracteres').default(''), input.search),
  }
}
export interface SubmissionSnapshot {
  id: string
  provider: string
  entityType: string
  businessName: string
  contactName: string | null
  email: string | null
  phone: string | null
  identificationType: string | null
  submissionVersion: number
  submittedAt: string
}
function snapshotOf(r: DocumentRequest): SubmissionSnapshot {
  return {
    id: r.id,
    provider: r.provider,
    entityType: r.entityType,
    businessName: r.businessName,
    contactName: r.contactName,
    email: r.email,
    phone: r.phone,
    identificationType: r.identificationType,
    submissionVersion: r.submissionVersion,
    submittedAt: r.submittedAt!.toISOString(),
  }
}
/** Caller holds the existing document-request advisory lock. Files are immutable after READY. */
export async function captureSubmissionTx(tx: Tx, request: DocumentRequest, files?: DocumentRequestFile[]) {
  const existing = await tx.documentRequestSubmission.findUnique({
    where: { requestId_submissionVersion: { requestId: request.id, submissionVersion: request.submissionVersion } },
  })
  if (existing) return existing
  if (request.status !== 'SUBMITTED' || !request.submittedAt || request.submissionVersion < 1)
    throw new ConflictError('El expediente aún no está enviado')
  const documents =
    files ??
    (await tx.documentRequestFile.findMany({
      where: { requestId: request.id, status: 'READY' },
      take: 25,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }))
  if (documents.length > 24) throw new ConflictError('El expediente excede el límite de archivos; requiere revisión')
  return tx.documentRequestSubmission.create({
    data: {
      requestId: request.id,
      submissionVersion: request.submissionVersion,
      submittedAt: request.submittedAt,
      snapshot: snapshotOf(request) as unknown as Prisma.InputJsonValue,
      files: { create: documents.map(file => ({ documentId: file.id })) },
    },
  })
}
export async function lockRequestTx(tx: Tx, requestId: string) {
  parse(id, requestId)
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('document-request'), hashtext(${requestId}))`
}
export async function lockOrganizationTx(tx: Tx, organizationId: string) {
  await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId} FOR NO KEY UPDATE`
}
const venueSelect = {
  id: true,
  name: true,
  slug: true,
  organizationId: true,
  entityType: true,
  organization: { select: { name: true } },
} satisfies Prisma.VenueSelect
const linkInclude = {
  venue: { select: venueSelect },
  submission: true,
  request: { select: { organizationId: true } },
} satisfies Prisma.DocumentRequestVenueLinkInclude
type LinkRow = Prisma.DocumentRequestVenueLinkGetPayload<{ include: typeof linkInclude }>
export function linkSummary(link: LinkRow) {
  const snapshot = link.submission.snapshot as unknown as SubmissionSnapshot
  return {
    id: link.id,
    requestId: link.requestId,
    submissionVersion: link.submission.submissionVersion,
    linkedAt: link.linkedAt,
    provider: snapshot.provider,
    entityType: snapshot.entityType,
    businessName: snapshot.businessName,
    venue: {
      id: link.venue.id,
      name: link.venue.name,
      slug: link.venue.slug,
      organizationId: link.venue.organizationId,
      organizationName: link.venue.organization.name,
    },
  }
}
function assertScope(link: LinkRow | null): asserts link is LinkRow {
  if (
    !link ||
    link.organizationId !== link.venue.organizationId ||
    link.organizationId !== link.request.organizationId ||
    link.requestId !== link.submission.requestId
  )
    throw new NotFoundError('Documento no disponible')
}
/** Organization and venue row locks must already be held, or venue is newly created in this transaction. */
export async function linkRequestToVenueTx(
  tx: Tx,
  requestId: string,
  input: z.infer<typeof linkInput>,
  actorId: string,
  onboardingHash?: string,
) {
  const data = parse(linkInput, input)
  parse(id, actorId)
  await lockRequestTx(tx, requestId)
  const [request, venue] = await Promise.all([
    tx.documentRequest.findUnique({ where: { id: requestId } }),
    tx.venue.findUnique({ where: { id: data.venueId }, select: venueSelect }),
  ])
  if (!request || !venue) throw new NotFoundError('Expediente o negocio no disponible')
  if (request.organizationId && request.organizationId !== venue.organizationId)
    throw new ConflictError('El expediente ya pertenece a otra organización')
  if (request.entityType && venue.entityType && request.entityType !== venue.entityType)
    throw new ConflictError('El tipo de persona del expediente no coincide con el negocio')
  if (request.status !== 'SUBMITTED' || request.submissionVersion !== data.submissionVersion)
    throw new ConflictError('El expediente cambió o aún no está enviado; vuelve a seleccionarlo')
  const submission = await captureSubmissionTx(tx, request)
  const existing = await tx.documentRequestVenueLink.findUnique({
    where: { venueId_submissionId: { venueId: venue.id, submissionId: submission.id } },
    include: linkInclude,
  })
  if (existing) return { link: linkSummary(existing), created: false }
  if (!request.organizationId) await tx.documentRequest.update({ where: { id: requestId }, data: { organizationId: venue.organizationId } })
  const link = await tx.documentRequestVenueLink.create({
    data: { requestId, organizationId: venue.organizationId, submissionId: submission.id, venueId: venue.id, actorId, onboardingHash },
    include: linkInclude,
  })
  await tx.activityLog.create({
    data: {
      staffId: actorId,
      venueId: venue.id,
      action: 'DOCUMENT_REQUEST_LINKED',
      entity: 'DocumentRequestVenueLink',
      entityId: link.id,
      data: { requestId, submissionVersion: data.submissionVersion, organizationId: venue.organizationId },
    },
  })
  return { link: linkSummary(link), created: true }
}
export async function linkRequestToVenue(requestId: string, input: unknown, actorId: string) {
  const data = parse(linkInput, input)
  const original = await prisma.venue.findUnique({ where: { id: data.venueId }, select: { organizationId: true } })
  if (!original) throw new NotFoundError('Negocio no disponible')
  const result = await prisma.$transaction(
    async tx => {
      await lockOrganizationTx(tx, original.organizationId)
      await tx.$queryRaw`SELECT id FROM "Venue" WHERE id = ${data.venueId} FOR KEY SHARE`
      const current = await tx.venue.findUnique({ where: { id: data.venueId }, select: { organizationId: true } })
      if (!current || current.organizationId !== original.organizationId)
        throw new ConflictError('El negocio cambió de organización; vuelve a seleccionarlo')
      return linkRequestToVenueTx(tx, requestId, data, actorId)
    },
    { timeout: 10000 },
  )
  if (result.created) {
    const { notifyDocumentRequest } = await import('./documentRequests.service')
    await notifyDocumentRequest(requestId, 'linked')
  }
  return result
}
export async function assertVenueHasNoDocumentLinksTx(tx: Tx, venueId: string) {
  if (await tx.documentRequestVenueLink.findFirst({ where: { venueId }, select: { id: true } }))
    throw new ConflictError(
      'El negocio tiene expedientes anexados; no se puede trasladar a otra organización',
      'VENUE_HAS_DOCUMENT_REQUESTS',
    )
}
export async function listVenueOptions(input: PageInput = {}) {
  const { page, pageSize, search } = parsePage(input)
  const where: Prisma.VenueWhereInput = search
    ? {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { slug: { contains: search, mode: 'insensitive' } },
          { organization: { name: { contains: search, mode: 'insensitive' } } },
        ],
      }
    : {}
  const [rows, total] = await prisma.$transaction([
    prisma.venue.findMany({
      where,
      select: venueSelect,
      take: pageSize,
      skip: (page - 1) * pageSize,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    }),
    prisma.venue.count({ where }),
  ])
  return {
    items: rows.map(v => ({
      id: v.id,
      name: v.name,
      slug: v.slug,
      organizationId: v.organizationId,
      organizationName: v.organization.name,
      entityType: v.entityType,
    })),
    total,
    page,
    pageSize,
  }
}
async function listLinks(where: Prisma.DocumentRequestVenueLinkWhereInput, input: PageInput) {
  const { page, pageSize } = parsePage(input)
  const [rows, total] = await prisma.$transaction([
    prisma.documentRequestVenueLink.findMany({
      where,
      include: linkInclude,
      take: pageSize,
      skip: (page - 1) * pageSize,
      orderBy: [{ linkedAt: 'desc' }, { id: 'desc' }],
    }),
    prisma.documentRequestVenueLink.count({ where }),
  ])
  rows.forEach(assertScope)
  return { items: rows.map(linkSummary), total, page, pageSize }
}
export async function listRequestVenueLinks(requestId: string, input: PageInput = {}) {
  parse(id, requestId)
  const request = await prisma.documentRequest.findUnique({ where: { id: requestId }, select: { organizationId: true } })
  if (!request) throw new NotFoundError('Expediente no disponible')
  const organizationId = request.organizationId
  // An unbound request cannot have links (the composite foreign key enforces this).
  if (!organizationId) {
    const { page, pageSize } = parsePage(input)
    return { items: [], total: 0, page, pageSize }
  }
  return listLinks({ requestId, organizationId, venue: { organizationId }, request: { organizationId } }, input)
}
export async function listVenueDocumentRequests(venueId: string, input: PageInput = {}) {
  parse(id, venueId)
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { organizationId: true } })
  if (!venue) throw new NotFoundError('Negocio no disponible')
  return listLinks(
    {
      venueId,
      organizationId: venue.organizationId,
      request: { organizationId: venue.organizationId },
      venue: { organizationId: venue.organizationId },
    },
    input,
  )
}
async function loadDetail(venueId: string, linkId: string, documentId?: string) {
  for (const value of [venueId, linkId, ...(documentId ? [documentId] : [])])
    if (!id.safeParse(value).success) throw new NotFoundError('Documento no disponible')
  const link = await prisma.documentRequestVenueLink.findFirst({
    where: { id: linkId, venueId },
    include: {
      ...linkInclude,
      submission: {
        include: {
          files: { where: documentId ? { documentId } : {}, take: 25, orderBy: { documentId: 'asc' }, include: { document: true } },
        },
      },
    },
  })
  assertScope(link)
  if (link.submission.files.length > 24) throw new ConflictError('El expediente requiere revisión')
  if (link.submission.files.some(f => f.document.requestId !== link.requestId || !['READY', 'ARCHIVED'].includes(f.document.status)))
    throw new NotFoundError('Documento no disponible')
  return link
}
export async function getVenueDocumentRequest(venueId: string, linkId: string) {
  const link = await loadDetail(venueId, linkId)
  return {
    link: linkSummary(link),
    request: link.submission.snapshot as unknown as SubmissionSnapshot,
    documents: link.submission.files.map(({ document: f }) => ({
      id: f.id,
      key: f.key,
      fileName: f.fileName,
      mimeType: f.mimeType,
      sizeBytes: f.sizeBytes,
    })),
  }
}
async function getReadableVenueDocument(venueId: string, linkId: string, documentId: string) {
  const link = await loadDetail(venueId, linkId, documentId)
  const file = link.submission.files.find(f => f.document.id === documentId)?.document
  if (!file) throw new NotFoundError('Documento no disponible')
  return file
}
export async function getVenueDocumentDownload(venueId: string, linkId: string, documentId: string) {
  const file = await getReadableVenueDocument(venueId, linkId, documentId)
  return { url: await signPrivateAttachmentUrl(file.storagePath) }
}
export async function getVenueDocumentPreview(venueId: string, linkId: string, documentId: string) {
  const file = await getReadableVenueDocument(venueId, linkId, documentId)
  return { url: await signPrivatePreviewUrl(file.storagePath, file.mimeType), mimeType: file.mimeType, fileName: file.fileName }
}
/** Recursive key ordering preserves array order and makes equivalent object encodings replay identically. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    )
  return value
}
export function wizardHash(payload: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(canonical(payload)))
    .digest('hex')
}
export async function lockWizardTx(tx: Tx, hash: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('document-request-wizard'), hashtext(${hash}))`
}
export async function findWizardReplayTx(tx: Tx, hash: string) {
  const link = await tx.documentRequestVenueLink.findUnique({ where: { onboardingHash: hash }, include: linkInclude })
  if (!link) return null
  assertScope(link)
  if (link.onboardingResult) return { ...(link.onboardingResult as Prisma.JsonObject), replayed: true }
  return {
    success: true,
    replayed: true,
    configurationPending: true,
    venueId: link.venueId,
    venueSlug: link.venue.slug,
    organizationId: link.organizationId,
    steps: [
      { step: 'venue', status: 'success', data: { venueId: link.venueId, venueSlug: link.venue.slug } },
      { step: 'configuration', status: 'error', message: 'Venue creado; configuración pendiente de revisar' },
    ],
  }
}
export async function storeWizardResult(hash: string, result: Prisma.InputJsonValue) {
  await prisma.documentRequestVenueLink.update({ where: { onboardingHash: hash }, data: { onboardingResult: result } })
}

export async function previewRequestVenueLink(requestId: string, input: unknown) {
  parse(id, requestId)
  const data = parse(linkInput, input)
  const [request, venue] = await Promise.all([
    prisma.documentRequest.findUnique({ where: { id: requestId } }),
    prisma.venue.findUnique({ where: { id: data.venueId }, select: venueSelect }),
  ])
  if (!request || !venue) throw new NotFoundError('Expediente o negocio no disponible')
  if (request.status !== 'SUBMITTED' || request.submissionVersion !== data.submissionVersion)
    throw new ConflictError('El expediente cambió o aún no está enviado; vuelve a seleccionarlo')
  if (request.organizationId && request.organizationId !== venue.organizationId)
    throw new ConflictError('El expediente ya pertenece a otra organización')
  if (request.entityType && venue.entityType && request.entityType !== venue.entityType)
    throw new ConflictError('El tipo de persona del expediente no coincide con el negocio')
  return {
    requestId,
    submissionVersion: data.submissionVersion,
    businessName: request.businessName,
    provider: request.provider,
    entityType: request.entityType,
    venue: {
      id: venue.id,
      name: venue.name,
      slug: venue.slug,
      organizationId: venue.organizationId,
      organizationName: venue.organization.name,
    },
  }
}
