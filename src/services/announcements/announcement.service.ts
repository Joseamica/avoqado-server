import { PlatformAnnouncementStatus, NotificationPriority, StaffRole, PlanTier, Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { NotFoundError, BadRequestError } from '../../errors/AppError'
import logger from '../../config/logger'
import { resolveAudience } from './audience.service'

/** Tamaño del lote de reparto. Miles de filas en un solo createMany bloquean la tabla. */
const LOTE = 500

/**
 * Publica un anuncio: lo marca publicado y ENCOLA una entrega por persona alcanzada.
 *
 * 🔴 Publicar ya NO reparte. Sólo escribe las filas de entrega en `PENDING`; el job del
 * outbox (`announcementOutbox.service.ts`) las convierte en avisos del buzón, con lease,
 * reintentos y `FOR UPDATE SKIP LOCKED`.
 *
 * Por qué cambió: repartir aquí mismo no cerraba la carrera —dos procesos podían pasar el
 * claim y crear los mismos avisos— y si moría a media entrega no había forma de retomarlo
 * sin arriesgar duplicados. Encolar sí es idempotente: el `@@unique(announcementId,
 * staffId, venueId)` hace que `skipDuplicates` funcione de verdad, así que dos
 * publicaciones simultáneas producen exactamente el mismo conjunto de filas.
 *
 * Es el mismo patrón que `customerApprovalOutbox`, que ya está probado en este repo.
 */
export async function publishAnnouncement(id: string): Promise<{ delivered: number; alreadyPublished: boolean }> {
  const anuncio = await prisma.platformAnnouncement.findUnique({ where: { id } })
  if (!anuncio) throw new NotFoundError('Anuncio no encontrado')

  if (anuncio.status === PlatformAnnouncementStatus.ARCHIVED) {
    throw new BadRequestError('Un anuncio archivado no se puede publicar')
  }

  if (anuncio.deliveredAt) {
    logger.info('Anuncio ya encolado, no se repite', { announcementId: id })
    return { delivered: anuncio.deliveredCount, alreadyPublished: true }
  }

  // CAS por estado: un `archive` concurrente ya no puede quedar sobrescrito a PUBLISHED.
  const claim = await prisma.platformAnnouncement.updateMany({
    where: {
      id,
      status: { in: [PlatformAnnouncementStatus.DRAFT, PlatformAnnouncementStatus.SCHEDULED] },
    },
    data: {
      status: PlatformAnnouncementStatus.PUBLISHED,
      publishedAt: anuncio.publishedAt ?? new Date(),
    },
  })
  if (claim.count === 0) {
    logger.info('El anuncio ya no era publicable', { announcementId: id, status: anuncio.status })
    const actual = await prisma.platformAnnouncement.findUnique({ where: { id }, select: { deliveredCount: true } })
    return { delivered: actual?.deliveredCount ?? 0, alreadyPublished: true }
  }

  const audiencia = await resolveAudience({
    audienceRoles: anuncio.audienceRoles,
    targetPlanTiers: anuncio.targetPlanTiers,
    targetCategories: anuncio.targetCategories,
    targetVenueIds: anuncio.targetVenueIds,
  })

  // Encolar en lotes. Idempotente por el @@unique: repetirlo no crea filas de más.
  for (let i = 0; i < audiencia.length; i += LOTE) {
    const lote = audiencia.slice(i, i + LOTE)
    await prisma.platformAnnouncementDelivery.createMany({
      data: lote.map(m => ({ announcementId: id, staffId: m.staffId, venueId: m.venueId })),
      skipDuplicates: true,
    })
  }

  const encoladas = await prisma.platformAnnouncementDelivery.count({ where: { announcementId: id } })

  await prisma.platformAnnouncement.update({
    where: { id },
    data: { deliveredCount: encoladas, deliveredAt: new Date() },
  })

  logger.info('Anuncio publicado y encolado', { announcementId: id, encoladas })
  return { delivered: encoladas, alreadyPublished: false }
}

// ===========================
// CRUD del compositor
// ===========================

export interface AnnouncementInput {
  title: string
  body: string
  imageUrl?: string
  priority: NotificationPriority
  actionLabel?: string
  actionUrl?: string
  contentBlocks?: unknown[]
  audienceRoles: StaffRole[]
  targetPlanTiers: PlanTier[]
  targetCategories: string[]
  targetVenueIds: string[]
  showAsBanner: boolean
  expiresAt?: Date
}

export async function listAnnouncements() {
  return prisma.platformAnnouncement.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
}

export async function createAnnouncement(input: AnnouncementInput, createdBy: string, createdByName: string) {
  return prisma.platformAnnouncement.create({
    data: {
      ...input,
      contentBlocks: (input.contentBlocks ?? undefined) as Prisma.InputJsonValue | undefined,
      createdBy,
      createdByName,
    },
  })
}

/**
 * Editar sólo antes de repartir. Un anuncio ya publicado vive en miles de buzones:
 * cambiarle el texto aquí NO cambia lo que la gente ya recibió, así que dejarlo
 * editable daría una falsa sensación de corrección.
 */
export async function updateAnnouncement(id: string, input: Partial<AnnouncementInput>) {
  const actual = await prisma.platformAnnouncement.findUnique({ where: { id } })
  if (!actual) throw new NotFoundError('Anuncio no encontrado')
  if (actual.status !== PlatformAnnouncementStatus.DRAFT && actual.status !== PlatformAnnouncementStatus.SCHEDULED) {
    throw new BadRequestError('Sólo se puede editar un anuncio en borrador o programado')
  }
  return prisma.platformAnnouncement.update({
    where: { id },
    data: {
      ...input,
      contentBlocks: (input.contentBlocks ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  })
}

/** Programa el reparto para más tarde. El job lo publica cuando llegue la hora. */
export async function scheduleAnnouncement(id: string, scheduledFor: Date) {
  const actual = await prisma.platformAnnouncement.findUnique({ where: { id } })
  if (!actual) throw new NotFoundError('Anuncio no encontrado')
  if (actual.deliveredAt) throw new BadRequestError('Este anuncio ya se repartió')
  if (actual.status === PlatformAnnouncementStatus.ARCHIVED) {
    throw new BadRequestError('Un anuncio archivado no se puede programar')
  }
  // Sin esto el job repartiría un anuncio que nace caducado: nadie lo vería y el
  // superadmin creería que salió.
  if (actual.expiresAt && scheduledFor >= actual.expiresAt) {
    throw new BadRequestError('La fecha de publicación debe ser anterior a la de caducidad')
  }
  return prisma.platformAnnouncement.update({
    where: { id },
    data: { status: PlatformAnnouncementStatus.SCHEDULED, scheduledFor },
  })
}

/** Lo retira sin borrarlo: deja de salir como banner y deja de contarse como activo. */
export async function archiveAnnouncement(id: string) {
  const actual = await prisma.platformAnnouncement.findUnique({ where: { id } })
  if (!actual) throw new NotFoundError('Anuncio no encontrado')
  return prisma.platformAnnouncement.update({
    where: { id },
    data: { status: PlatformAnnouncementStatus.ARCHIVED },
  })
}
