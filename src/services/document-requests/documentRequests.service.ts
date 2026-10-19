import { createHash, randomBytes } from 'crypto'
import cuid from 'cuid'
import { Prisma, DocumentRequest, DocumentRequestFile, StaffRole } from '@prisma/client'
import { z } from 'zod'
import { SocketEventType } from '../../communication/sockets/types'
import prisma from '../../utils/prismaClient'
import { FRONTEND_URL } from '../../config/env'
import { BadRequestError, ConflictError, NotFoundError, TooManyRequestsError } from '../../errors/AppError'
import {
  buildPrivateFilePath,
  savePrivateFileAtPath,
  signPrivateAttachmentUrl,
  signPrivatePreviewUrl,
  deletePrivateFile,
} from '../privateStorage.service'
import { retry, shouldRetryDbConnectionError } from '../../utils/retry'
import { assertAccess, assertComplete, getRequirements, hashToken, LIMITS, validateFile } from './policy'

import { captureSubmissionTx } from './venueLinks.service'

type Tx = Prisma.TransactionClient
export type UploadAdmission = { lease: string; tokenVersion: number }
const textInput = () => z.string({ required_error: 'Este campo es obligatorio', invalid_type_error: 'Escribe un texto válido' })
const nameInput = () => textInput().trim().min(1, 'Este campo es obligatorio').max(160, 'Usa un máximo de 160 caracteres')
const choiceError = { errorMap: () => ({ message: 'Selecciona una opción válida' }) }
const createInput = z
  .object({
    provider: z.enum(['ANGELPAY', 'BLUMON'], choiceError),
    entityType: z.enum(['PERSONA_FISICA', 'PERSONA_MORAL'], choiceError),
    businessName: nameInput(),
  })
  .strict('Se enviaron campos no admitidos')
const contactInput = z
  .object({
    businessName: nameInput(),
    contactName: nameInput(),
    email: textInput().trim().email('Escribe un correo válido').max(254, 'El correo es demasiado largo'),
    phone: textInput().regex(/^\d{10}$/, 'Escribe un teléfono de 10 dígitos'),
    identificationType: z.enum(['INE', 'PASSPORT'], choiceError),
    privacyAccepted: z.literal(true, { errorMap: () => ({ message: 'Debes aceptar el aviso de privacidad' }) }),
  })
  .strict('Se enviaron campos no admitidos')
const idInput = textInput()
  .cuid('Identificador inválido')
  .regex(/^c[a-z0-9]{24}$/, 'Identificador inválido')
function parseInput<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value)
  if (!result.success)
    throw new BadRequestError(
      'Revisa los datos enviados. ' +
        result.error.issues
          .map(issue => issue.message)
          .filter(message => !/^(Expected|Required|Invalid)/.test(message))
          .join('. '),
    )
  return result.data
}
const fileView = (f: DocumentRequestFile) => ({ id: f.id, key: f.key, fileName: f.fileName, mimeType: f.mimeType, sizeBytes: f.sizeBytes })
export const requestView = (r: DocumentRequest) => ({
  id: r.id,
  provider: r.provider,
  entityType: r.entityType,
  businessName: r.businessName,
  contactName: r.contactName,
  email: r.email,
  phone: r.phone,
  status: r.status === 'OPEN' ? 'DRAFT' : r.status,
  expiresAt: r.expiresAt,
  submittedAt: r.submittedAt,
  createdAt: r.createdAt,
  submissionVersion: r.submissionVersion,
  notification: {
    onboarding: r.onboardingNotification,
    daniel: r.danielNotification,
    attempts: r.notificationAttempts,
    nextAttemptAt: r.notificationNextAt,
  },
})
async function locked<T>(id: string, work: (tx: Tx, r: DocumentRequest) => Promise<T>): Promise<T> {
  if (!idInput.safeParse(id).success) throw new NotFoundError('Enlace no disponible')
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('document-request'), hashtext(${id}))`
    const row = await tx.documentRequest.findUnique({ where: { id } })
    if (!row) throw new NotFoundError('Enlace no disponible')
    return work(tx, row)
  })
}
async function audit(tx: Tx, id: string, action: string, actorId?: string, documentId?: string) {
  await tx.activityLog.create({
    data: { staffId: actorId || null, action, entity: 'DocumentRequest', entityId: id, data: documentId ? { documentId } : {} },
  })
}
export async function notifyDocumentRequest(id: string, type: string) {
  try {
    const { socketManager } = await import('../../communication/sockets/managers/socketManager')
    socketManager.broadcastToRole(StaffRole.SUPERADMIN, SocketEventType.DOCUMENT_REQUEST_UPDATED, { id, type })
  } catch {
    /* Refreshing the list remains available if sockets are offline. */
  }
}
const uploadUrl = (id: string, token: string) => `${FRONTEND_URL.replace(/\/$/, '')}/documentos/${id}#token=${token}`
export async function createRequest(input: z.input<typeof createInput>, actorId?: string) {
  const data = parseInput(createInput, input),
    token = randomBytes(32).toString('hex')
  const request = await prisma.$transaction(async tx => {
    const row = await tx.documentRequest.create({
      data: { ...data, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 14 * 86400000) },
    })
    await audit(tx, row.id, 'DOCUMENT_REQUEST_CREATED', actorId)
    return row
  })
  await notifyDocumentRequest(request.id, 'created')
  return { request: requestView(request), uploadUrl: uploadUrl(request.id, token) }
}
export async function listRequests(input: { page?: number; pageSize?: number; search?: string; status?: string }) {
  const page = parseInput(
    z.coerce
      .number()
      .int('La página debe ser un número entero')
      .min(1, 'La página mínima es 1')
      .max(100000, 'La página está fuera de rango')
      .default(1),
    input.page,
  )
  const pageSize = Math.min(
    100,
    parseInput(z.coerce.number().int('El tamaño debe ser un número entero').min(1, 'El tamaño mínimo es 1').default(25), input.pageSize),
  )
  const search = parseInput(textInput().trim().max(160, 'La búsqueda admite máximo 160 caracteres').default(''), input.search)
  const status = parseInput(z.enum(['DRAFT', 'SUBMITTED', 'REVOKED', 'PURGED'], choiceError).optional(), input.status || undefined)
  const where: Prisma.DocumentRequestWhereInput = {
    ...(status ? { status: status === 'DRAFT' ? 'OPEN' : status } : {}),
    ...(search
      ? {
          OR: [
            { businessName: { contains: search, mode: 'insensitive' } },
            { contactName: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  }
  const [rows, total] = await prisma.$transaction([
    prisma.documentRequest.findMany({
      where,
      take: pageSize,
      skip: (page - 1) * pageSize,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }),
    prisma.documentRequest.count({ where }),
  ])
  return { items: rows.map(requestView), total, page, pageSize }
}
export async function getAdminRequest(id: string) {
  return locked(id, async (tx, r) => ({
    request: requestView(r),
    documents: (
      await tx.documentRequestFile.findMany({
        where: { requestId: id, status: 'READY' },
        take: 24,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
    ).map(fileView),
  }))
}
export async function revokeRequest(id: string, actorId?: string) {
  return locked(id, async tx => {
    const r = await tx.documentRequest.update({ where: { id }, data: { status: 'REVOKED', tokenVersion: { increment: 1 } } })
    await audit(tx, id, 'DOCUMENT_REQUEST_REVOKED', actorId)
    return { request: requestView(r) }
  }).then(async result => {
    await notifyDocumentRequest(id, 'revoked')
    return result
  })
}
export async function renewRequest(id: string, actorId?: string) {
  const token = randomBytes(32).toString('hex')
  return locked(id, async (tx, r) => {
    if (r.status === 'PURGED') throw new ConflictError('Crea un expediente nuevo')
    // Retire old reservations under the same lock; late Storage completions stay fenced.
    await tx.documentRequestFile.updateMany({ where: { requestId: id, status: 'PENDING' }, data: { status: 'DELETING' } })
    const row = await tx.documentRequest.update({
      where: { id },
      data: {
        status: 'OPEN',
        tokenVersion: { increment: 1 },
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 14 * 86400000),
        uploadLease: null,
        uploadLeaseUntil: null,
      },
    })
    await audit(tx, id, 'DOCUMENT_REQUEST_RENEWED', actorId)
    return { request: requestView(row), uploadUrl: uploadUrl(id, token) }
  }).then(async result => {
    await notifyDocumentRequest(id, 'renewed')
    return result
  })
}
async function getReadableDocument(id: string, documentId: string) {
  if (!idInput.safeParse(id).success) throw new NotFoundError('Enlace no disponible')
  parseInput(idInput, documentId)
  const file = await prisma.documentRequestFile.findFirst({ where: { id: documentId, requestId: id, status: 'READY' } })
  if (!file) throw new NotFoundError()
  return file
}
export async function getDownloadUrl(id: string, documentId: string) {
  const file = await getReadableDocument(id, documentId)
  return { url: await signPrivateAttachmentUrl(file.storagePath) }
}
export async function getPreviewUrl(id: string, documentId: string) {
  const file = await getReadableDocument(id, documentId)
  return { url: await signPrivatePreviewUrl(file.storagePath, file.mimeType), mimeType: file.mimeType, fileName: file.fileName }
}
export async function getPublicRequest(id: string, token: string) {
  if (!idInput.safeParse(id).success) throw new NotFoundError('Enlace no disponible')
  const r = await prisma.documentRequest.findUnique({ where: { id } })
  assertAccess(r, token, false)
  const row = r!
  const files =
    row.status === 'SUBMITTED'
      ? []
      : await prisma.documentRequestFile.findMany({
          where: { requestId: id, OR: [{ status: 'READY' }, { status: 'PENDING', tokenVersion: row.tokenVersion }] },
          take: 24,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
  const documents = files.filter(file => file.status === 'READY').map(fileView)
  const pendingUploads = files.filter(file => file.status === 'PENDING').map(({ uploadId, key, fileName }) => ({ uploadId, key, fileName }))
  return {
    id,
    provider: row.provider,
    entityType: row.entityType,
    status: row.status === 'OPEN' ? 'DRAFT' : row.status,
    expiresAt: row.expiresAt,
    requirements: row.status === 'SUBMITTED' ? [] : getRequirements(row.provider, row.entityType),
    documents,
    pendingUploads,
    limits: LIMITS,
  }
}
/** Runs before multipart parsing. A durable lease also bars submit while bytes arrive. */
export async function admitUpload(id: string, token: string): Promise<UploadAdmission> {
  return locked(id, async (tx, r) => {
    assertAccess(r, token, true)
    if (r.uploadLeaseUntil && r.uploadLeaseUntil > new Date()) throw new ConflictError('Hay una carga en curso; espera y reintenta')
    if (r.uploadAttempts >= LIMITS.maxUploadAttempts)
      throw new TooManyRequestsError('Se alcanzó el límite de intentos; solicita un expediente nuevo')
    const lease = cuid()
    await tx.documentRequest.update({
      where: { id },
      data: { uploadAttempts: { increment: 1 }, uploadLease: lease, uploadLeaseUntil: new Date(Date.now() + 5 * 60000) },
    })
    return { lease, tokenVersion: r.tokenVersion }
  })
}
export async function releaseUpload(id: string, admission: UploadAdmission) {
  await prisma.documentRequest.updateMany({
    where: { id, uploadLease: admission.lease },
    data: { uploadLease: null, uploadLeaseUntil: null },
  })
}
export async function uploadDocument(
  id: string,
  token: string,
  key: string,
  uploadId: string,
  file: Express.Multer.File,
  admission: UploadAdmission,
) {
  parseInput(idInput, uploadId)
  const metadata = validateFile(file),
    contentHash = createHash('sha256').update(file.buffer).digest('hex')
  const reservation = await locked(id, async (tx, r) => {
    assertAccess(r, token, true)
    if (r.uploadLease !== admission.lease || r.tokenVersion !== admission.tokenVersion)
      throw new ConflictError('El enlace cambió; abre el enlace nuevo')
    const requirement = getRequirements(r.provider, r.entityType).find(v => v.key === key)
    if (!requirement) throw new BadRequestError('Requisito inválido')
    const existing = await tx.documentRequestFile.findUnique({ where: { requestId_uploadId: { requestId: id, uploadId } } })
    if (existing) {
      if (
        existing.key !== key ||
        existing.contentHash !== contentHash ||
        !['READY', 'PENDING'].includes(existing.status) ||
        (existing.status === 'PENDING' && existing.tokenVersion !== r.tokenVersion)
      )
        throw new ConflictError('Esa carga ya existe con otro contenido o sigue pendiente; usa el mismo archivo o selecciona uno nuevo')
      return { file: existing, replay: existing.status === 'READY' }
    }
    const active = await tx.documentRequestFile.findMany({
      where: { requestId: id, status: { in: ['READY', 'PENDING'] } },
      take: 25,
      select: { key: true },
    })
    if (
      active.length >= 24 ||
      active.filter(v => v.key === key).length >= requirement.maxFiles ||
      r.totalBytes + file.size > LIMITS.maxTotalBytes
    )
      throw new BadRequestError('Se alcanzó el límite de archivos o tamaño del expediente')
    const row = await tx.documentRequestFile.create({
      data: {
        requestId: id,
        uploadId,
        key,
        ...metadata,
        sizeBytes: file.size,
        contentHash,
        tokenVersion: r.tokenVersion,
        storagePath: buildPrivateFilePath(
          `document-requests/${id}`,
          `${uploadId}.${metadata.mimeType === 'application/pdf' ? 'pdf' : metadata.mimeType === 'image/png' ? 'png' : 'jpg'}`,
        ),
      },
    })
    await tx.documentRequest.update({ where: { id }, data: { totalBytes: { increment: file.size } } })
    return { file: row, replay: false }
  })
  if (reservation.replay) return { document: fileView(reservation.file) }
  // PENDING stays durable if Storage outcome is unknown. The sweeper deletes it after grace.
  try {
    await savePrivateFileAtPath(reservation.file.storagePath, file.buffer, metadata.mimeType)
  } catch (error) {
    // A create-only 412 means the immutable bytes of this same upload already arrived.
    if ((error as { code?: number }).code !== 412) throw error
  }
  return locked(id, async (tx, r) => {
    assertAccess(r, token, true)
    if (
      r.tokenVersion !== admission.tokenVersion ||
      r.uploadLease !== admission.lease ||
      !r.uploadLeaseUntil ||
      r.uploadLeaseUntil <= new Date()
    )
      throw new ConflictError('El enlace cambió durante la carga; abre el enlace nuevo')
    const ready = await tx.documentRequestFile.updateMany({
      where: { id: reservation.file.id, requestId: id, status: 'PENDING', tokenVersion: admission.tokenVersion },
      data: { status: 'READY' },
    })
    if (!ready.count) throw new ConflictError('La carga ya no está disponible; selecciona el archivo otra vez')
    const row = { ...reservation.file, status: 'READY' }
    await audit(tx, id, 'DOCUMENT_REQUEST_FILE_ADDED', undefined, row.id)
    return { document: fileView(row) }
  })
}
export async function deleteDocument(id: string, token: string, documentId: string) {
  parseInput(idInput, documentId)
  await locked(id, async (tx, r) => {
    assertAccess(r, token, true)
    const referenced = await tx.documentRequestSubmissionFile.count({ where: { documentId } })
    const changed = await tx.documentRequestFile.updateMany({
      where: { requestId: id, id: documentId, status: 'READY' },
      data: { status: referenced ? 'ARCHIVED' : 'DELETING' },
    })
    if (!changed.count) throw new NotFoundError()
    await audit(tx, id, 'DOCUMENT_REQUEST_FILE_DELETED', undefined, documentId)
  })
  return { success: true as const }
}
/** Explicitly discard an uncertain upload without waiting for delayed Storage cleanup. */
export async function discardUpload(id: string, token: string, uploadId: string) {
  parseInput(idInput, uploadId)
  await locked(id, async (tx, r) => {
    assertAccess(r, token, true)
    const row = await tx.documentRequestFile.findUnique({ where: { requestId_uploadId: { requestId: id, uploadId } } })
    if (!row || ['DELETING', 'DELETED', 'ARCHIVED'].includes(row.status)) return
    const referenced = await tx.documentRequestSubmissionFile.count({ where: { documentId: row.id } })
    await tx.documentRequestFile.update({ where: { id: row.id }, data: { status: referenced ? 'ARCHIVED' : 'DELETING' } })
    await audit(tx, id, 'DOCUMENT_REQUEST_FILE_DISCARDED', undefined, row.id)
  })
  return { success: true as const }
}
export async function submitRequest(id: string, token: string, input: unknown) {
  const contact = parseInput(contactInput, input)
  return locked(id, async (tx, r) => {
    assertAccess(r, token, false)
    if (r.status === 'SUBMITTED') return { id, status: 'SUBMITTED' as const }
    assertAccess(r, token, true)
    if (r.uploadLeaseUntil && r.uploadLeaseUntil > new Date()) throw new ConflictError('Espera a que termine la carga')
    const documents = await tx.documentRequestFile.findMany({ where: { requestId: id, status: { in: ['READY', 'PENDING'] } }, take: 25 })
    if (documents.some(f => f.status === 'PENDING')) throw new ConflictError('Hay un archivo pendiente')
    assertComplete(r.provider, r.entityType, contact.identificationType, documents)
    const { privacyAccepted, ...data } = contact
    const version = r.submissionVersion + 1
    const submitted = await tx.documentRequest.update({
      where: { id },
      data: {
        ...data,
        status: 'SUBMITTED',
        privacyAcceptedAt: new Date(),
        submittedAt: new Date(),
        submissionVersion: version,
        onboardingNotification: 'PENDING',
        danielNotification: 'PENDING',
        notificationAttempts: 0,
        notificationNextAt: new Date(),
        notificationLease: null,
        notificationLeaseUntil: null,
        notificationSnapshot: { id, version, provider: r.provider, entityType: r.entityType },
      },
    })
    await captureSubmissionTx(tx, submitted, documents)
    await tx.documentRequestDelivery.createMany({
      data: ['onboarding@avoqado.io', 'daniel@avoqado.io'].map(recipient => ({
        requestId: id,
        submissionVersion: version,
        recipient,
        snapshot: { id, version, provider: r.provider, entityType: r.entityType },
      })),
    })
    await audit(tx, id, 'DOCUMENT_REQUEST_SUBMITTED')
    return { id, status: 'SUBMITTED' as const }
  }).then(async result => {
    await notifyDocumentRequest(id, 'submitted')
    return result
  })
}
// Retired paths wait 30 minutes, beyond the bounded Storage write timeout.
export async function cleanupFiles(now = new Date()) {
  const rows = await retry(
    () =>
      prisma.documentRequestFile.findMany({
        where: {
          submissionFiles: { none: {} },
          OR: [
            { status: 'DELETING', updatedAt: { lt: new Date(now.getTime() - 30 * 60000) } },
            { status: 'PENDING', updatedAt: { lt: new Date(now.getTime() - 30 * 60000) } },
            {
              status: 'READY',
              request: {
                status: { in: ['OPEN', 'REVOKED'] },
                submittedAt: null,
                expiresAt: { lt: new Date(now.getTime() - 30 * 86400000) },
              },
            },
          ],
        },
        take: 24,
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      }),
    { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'document-requests.cleanup' },
  )
  for (const file of rows) {
    const remove = await locked(file.requestId, async (tx, r) => {
      const row = await tx.documentRequestFile.findFirst({
        where: { id: file.id, requestId: file.requestId, status: file.status, updatedAt: file.updatedAt },
      })
      if (!row || (r.uploadLeaseUntil && r.uploadLeaseUntil > now)) return false
      if (await tx.documentRequestSubmissionFile.count({ where: { documentId: file.id } })) {
        await tx.documentRequestFile.update({ where: { id: file.id }, data: { status: 'ARCHIVED' } })
        return false
      }
      if (file.status === 'READY' && (r.submittedAt !== null || r.expiresAt.getTime() >= now.getTime() - 30 * 86400000)) return false
      await tx.documentRequestFile.update({ where: { id: file.id }, data: { status: 'DELETING' } })
      return true
    })
    if (!remove) continue
    await deletePrivateFile(file.storagePath)
    await prisma.documentRequestFile.updateMany({
      where: { id: file.id, requestId: file.requestId, status: 'DELETING' },
      data: { status: 'DELETED' },
    })
  }
}
