import type { StaffDocumentType } from '@prisma/client'

import { BadRequestError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
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
  fileName: string
  fileUrl: string
  mimeType: string
  sizeBytes: number
  expiresAt?: string | null
  notes?: string | null
}

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
      fileUrl: true,
      mimeType: true,
      sizeBytes: true,
      expiresAt: true,
      notes: true,
      createdAt: true,
      uploadedBy: { select: { firstName: true, lastName: true } },
    },
  })
}

export async function addStaffDocument(venueId: string, staffId: string, input: StaffDocumentInput, uploadedById: string) {
  await requireStaffOfVenue(venueId, staffId)

  // "Otro" sin nombre no le dice nada a quien abra la carpeta dentro de un año.
  if (input.type === 'OTHER' && !input.label?.trim()) {
    throw new BadRequestError('Ponle un nombre al documento para saber qué es.')
  }

  const document = await prisma.staffDocument.create({
    data: {
      staffId,
      venueId,
      type: input.type,
      label: input.label?.trim() || null,
      fileName: input.fileName,
      fileUrl: input.fileUrl,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
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
