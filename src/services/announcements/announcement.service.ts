import { NotificationType, PlatformAnnouncementStatus, NotificationPriority, StaffRole, PlanTier, Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { NotFoundError, BadRequestError } from '../../errors/AppError'
import logger from '../../config/logger'
import { resolveAudience } from './audience.service'

/** Tamaño del lote de reparto. Miles de filas en un solo createMany bloquean la tabla. */
const LOTE = 500

/**
 * Publica un anuncio de plataforma repartiéndolo como `Notification` normales.
 *
 * 🔴 Por qué se reparte en vez de unir al leer: el buzón de dashboard, Android e iOS
 * pagina, cuenta no-leídos, marca-leído y borra sobre filas REALES de `Notification`
 * con id propio. Unir al leer rompía esas cuatro cosas en las tres apps.
 *
 * 🔴 Idempotente y REINTENTABLE: un claim atómico condicionado por estado elige un solo
 * ganador, y el acuse de recibo (`PlatformAnnouncementDelivery`, con su @@unique) permite
 * retomar un reparto que quedó a medias sin que nadie reciba el aviso dos veces.
 *
 * 🔴 El reparto va FUERA de transacción y en lotes: encerrar miles de inserts en una
 * transacción larga bloquea la tabla que usa todo el producto.
 */
export async function publishAnnouncement(id: string): Promise<{ delivered: number; alreadyPublished: boolean }> {
  const anuncio = await prisma.platformAnnouncement.findUnique({ where: { id } })
  if (!anuncio) throw new NotFoundError('Anuncio no encontrado')

  if (anuncio.deliveredAt) {
    logger.info('Anuncio ya repartido, no se repite', { announcementId: id })
    return { delivered: anuncio.deliveredCount, alreadyPublished: true }
  }

  if (anuncio.status === PlatformAnnouncementStatus.ARCHIVED) {
    throw new BadRequestError('Un anuncio archivado no se puede publicar')
  }

  // 🔴 CLAIM ATÓMICO, condicionado por ESTADO (no sólo por `deliveredAt`).
  //
  // Lo que resuelve, y por qué el chequeo de arriba no basta:
  //  - Dos publicaciones a la vez (dos clics, o el endpoint y el job) leen ambas el mismo
  //    estado y las dos repartirían. Sólo este `updateMany` condicional elige un ganador:
  //    bajo READ COMMITTED, Postgres bloquea la fila y reevalúa el WHERE.
  //  - Un `archive` concurrente ya no se pierde: si alguien archivó en medio, el WHERE
  //    deja de casar y esta publicación no arranca.
  //
  // El segundo brazo del OR permite REINTENTAR un reparto que quedó a medias
  // (`PUBLISHED` con `deliveredAt` nulo). Eso es seguro porque abajo se salta a quien ya
  // tiene su acuse de recibo.
  const claim = await prisma.platformAnnouncement.updateMany({
    where: {
      id,
      OR: [
        { status: { in: [PlatformAnnouncementStatus.DRAFT, PlatformAnnouncementStatus.SCHEDULED] } },
        { status: PlatformAnnouncementStatus.PUBLISHED, deliveredAt: null },
      ],
    },
    data: {
      status: PlatformAnnouncementStatus.PUBLISHED,
      publishedAt: anuncio.publishedAt ?? new Date(),
    },
  })
  if (claim.count === 0) {
    logger.info('Otra publicacion gano la carrera o el anuncio ya no es publicable', { announcementId: id })
    const actual = await prisma.platformAnnouncement.findUnique({ where: { id }, select: { deliveredCount: true } })
    return { delivered: actual?.deliveredCount ?? 0, alreadyPublished: true }
  }

  const audiencia = await resolveAudience({
    audienceRoles: anuncio.audienceRoles,
    targetPlanTiers: anuncio.targetPlanTiers,
    targetCategories: anuncio.targetCategories,
    targetVenueIds: anuncio.targetVenueIds,
  })

  // Quién ya tiene su acuse: al reintentar, éstos NO se vuelven a tocar. Es lo que hace
  // el reparto reintentable sin que nadie reciba el aviso dos veces.
  const yaEntregados = await prisma.platformAnnouncementDelivery.findMany({
    where: { announcementId: id },
    select: { staffId: true, venueId: true },
  })
  const entregado = new Set(yaEntregados.map(d => `${d.staffId}|${d.venueId}`))
  const pendientes = audiencia.filter(m => !entregado.has(`${m.staffId}|${m.venueId}`))

  let entregadas = yaEntregados.length
  for (let i = 0; i < pendientes.length; i += LOTE) {
    const lote = pendientes.slice(i, i + LOTE)

    // El acuse PRIMERO: si el proceso muere entre las dos escrituras, la persona queda
    // con acuse y sin aviso — molesto pero inofensivo. Al revés recibiría el aviso dos
    // veces en el reintento, que es lo que no se puede permitir.
    await prisma.platformAnnouncementDelivery.createMany({
      data: lote.map(m => ({ announcementId: id, staffId: m.staffId, venueId: m.venueId })),
      skipDuplicates: true, // aquí SÍ sirve: hay @@unique(announcementId, staffId, venueId)
    })

    await prisma.notification.createMany({
      data: lote.map(m => ({
        recipientId: m.staffId,
        venueId: m.venueId,
        type: NotificationType.ANNOUNCEMENT,
        title: anuncio.title,
        message: anuncio.body,
        actionLabel: anuncio.actionLabel ?? undefined,
        actionUrl: `/announcements/${anuncio.id}`,
        entityType: 'PlatformAnnouncement',
        entityId: anuncio.id,
        priority: anuncio.priority,
      })),
    })
    entregadas += lote.length
  }

  // `deliveredAt` sólo AL COMPLETAR: mientras esté nulo, el reparto se puede reintentar.
  await prisma.platformAnnouncement.update({
    where: { id },
    data: { deliveredCount: entregadas, deliveredAt: new Date() },
  })

  logger.info('Anuncio publicado', { announcementId: id, delivered: entregadas })
  return { delivered: entregadas, alreadyPublished: false }
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
