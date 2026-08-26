import type { StaffDocumentType } from '@prisma/client'

import { BadRequestError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { savePrivateFile, signPrivateFileUrl } from '../privateStorage.service'
import { logAction } from './activity-log.service'

/**
 * Expediente del personal.
 *
 * 🔴 DATOS PERSONALES SENSIBLES: identificación, CURP, número de seguro social, contratos.
 * Las rutas lo guardan con su propio permiso (`staff-documents:*`, sólo OWNER/ADMIN por
 * defecto), y aquí se defiende lo que el permiso no puede: que un id de OTRO negocio no
 * devuelva ni acepte nada. El permiso dice "este usuario puede ver expedientes"; el
 * acotamiento por venue dice "estos expedientes y no otros".
 *
 * El borrado es SUAVE. En México hay obligación de conservar ciertos documentos laborales
 * después de que la persona se va; un borrado duro deja al negocio sin con qué responder.
 */

export interface StaffDocumentInput {
  type: StaffDocumentType
  /** Nombre libre. Obligatorio cuando `type` es OTHER, donde el tipo no dice nada. */
  label?: string | null
  expiresAt?: string | null
  notes?: string | null
}

/** El archivo llega por multer: el navegador NUNCA habla con Storage directamente. */
export interface UploadedFile {
  originalname: string
  mimetype: string
  size: number
  buffer: Buffer
}

/** Minutos de vida de una URL firmada. Suficiente para abrir el PDF; inútil si se filtra. */
export const SIGNED_URL_MINUTES = 10

/** Comprueba que la persona trabaje en ESTE negocio antes de tocar su expediente. */
async function requireStaffOfVenue(venueId: string, staffId: string): Promise<void> {
  const membership = await prisma.staffVenue.findFirst({
    where: { staffId, venueId },
    select: { id: true },
  })
  if (!membership) throw new NotFoundError('Ese empleado no pertenece a este negocio')
}

export async function listStaffDocuments(venueId: string, staffId: string) {
  await requireStaffOfVenue(venueId, staffId)

  return prisma.staffDocument.findMany({
    where: { staffId, venueId, deletedAt: null },
    orderBy: [{ type: 'asc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      type: true,
      label: true,
      fileName: true,
      mimeType: true,
      sizeBytes: true,
      expiresAt: true,
      notes: true,
      createdAt: true,
      uploadedBy: { select: { firstName: true, lastName: true } },
    },
  })
}

export async function addStaffDocument(
  venueId: string,
  staffId: string,
  input: StaffDocumentInput,
  file: UploadedFile,
  uploadedById: string,
) {
  await requireStaffOfVenue(venueId, staffId)

  // "Otro" sin nombre no le dice nada a quien abra la carpeta dentro de un año.
  if (input.type === 'OTHER' && !input.label?.trim()) {
    throw new BadRequestError('Ponle un nombre al documento para saber qué es.')
  }

  // 🔴 El archivo va a la caja fuerte (`private/...`), no al Storage público donde viven
  // los logos y las fotos de la PAX. Se guarda la RUTA; la URL se firma al leer.
  const { path } = await savePrivateFile({
    scope: `staff/${venueId}/${staffId}`,
    fileName: file.originalname,
    buffer: file.buffer,
    contentType: file.mimetype,
  })

  const document = await prisma.staffDocument.create({
    data: {
      staffId,
      venueId,
      type: input.type,
      label: input.label?.trim() || null,
      fileName: file.originalname,
      storagePath: path,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      // 'YYYY-MM-DD' es una FECHA, no un instante: se ancla al mediodía UTC para que en
      // cualquier zona de América siga siendo ese mismo día (auditoría Codex, P1: en México
      // `new Date('2026-08-20')` se mostraba como 19 de agosto).
      expiresAt: input.expiresAt ? new Date(`${input.expiresAt}T12:00:00.000Z`) : null,
      notes: input.notes?.trim() || null,
      uploadedById,
    },
    select: { id: true, type: true, label: true, fileName: true, createdAt: true },
  })

  // Quién abrió el expediente de quién queda registrado: con datos sensibles, el rastro
  // importa tanto como el candado.
  logAction({
    staffId: uploadedById,
    venueId,
    action: 'STAFF_DOCUMENT_ADDED',
    entity: 'StaffDocument',
    entityId: document.id,
    data: { staffId, type: input.type },
  })

  return document
}

/** Da de baja un documento. NUNCA borra la fila. */
export async function removeStaffDocument(venueId: string, documentId: string, actorId: string) {
  const document = await prisma.staffDocument.findFirst({
    where: { id: documentId, venueId, deletedAt: null },
    select: { id: true, staffId: true },
  })
  if (!document) throw new NotFoundError('Documento no encontrado en este negocio')

  const updated = await prisma.staffDocument.update({
    where: { id: documentId },
    data: { deletedAt: new Date(), deletedById: actorId },
  })

  logAction({
    staffId: actorId,
    venueId,
    action: 'STAFF_DOCUMENT_REMOVED',
    entity: 'StaffDocument',
    entityId: documentId,
    data: { staffId: document.staffId },
  })

  return updated
}

/** URL de lectura que caduca. Se firma en cada petición; no se guarda nunca. */
export async function getStaffDocumentUrl(venueId: string, documentId: string, actorId: string) {
  const document = await prisma.staffDocument.findFirst({
    where: { id: documentId, venueId, deletedAt: null },
    select: { id: true, staffId: true, storagePath: true, fileName: true, mimeType: true },
  })
  if (!document) throw new NotFoundError('Documento no encontrado en este negocio')

  const url = await signPrivateFileUrl(document.storagePath, SIGNED_URL_MINUTES)

  // Abrir un documento sensible deja rastro: quién vio el expediente de quién.
  logAction({
    staffId: actorId,
    venueId,
    action: 'STAFF_DOCUMENT_VIEWED',
    entity: 'StaffDocument',
    entityId: documentId,
    data: { staffId: document.staffId },
  })

  return { url, expiresInMinutes: SIGNED_URL_MINUTES, fileName: document.fileName, mimeType: document.mimeType }
}
