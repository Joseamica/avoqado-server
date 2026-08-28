import { PlatformAnnouncementStatus, NotificationPriority, StaffRole, PlanTier, Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { NotFoundError, BadRequestError } from '../../errors/AppError'
import logger from '../../config/logger'
import { resolveAudience } from './audience.service'
import { logAction } from '../dashboard/activity-log.service'

/**
 * Rastro de lo que el superadmin le manda a los negocios.
 *
 * 🔴 La regla del repo es dura: una mutación sin `ActivityLog` está incompleta. Publicar
 * un anuncio llega a cientos de buzones y es justo lo que alguien audita después
 * ("¿quién mandó esto?"), pero hasta hoy no dejaba rastro.
 *
 * Va SIEMPRE después de que el cambio ya ocurrió, y sin `await` encadenado: si la
 * bitácora truena, la operación NO puede fallar por eso. `venueId` va nulo a propósito —
 * un anuncio de plataforma no pertenece a un negocio. Sin actor humano (el job que
 * publica lo programado) el `staffId` nulo YA dice que no lo hizo una persona.
 */
function rastro(action: string, id: string, performedBy?: string, data?: Record<string, unknown>): void {
  // `Promise.resolve` envuelve por si logAction cambia de forma: la bitácora jamás
  // puede reventar la operación que acaba de ocurrir.
  void Promise.resolve(
    logAction({
      action,
      entity: 'PlatformAnnouncement',
      entityId: id,
      staffId: performedBy ?? null,
      venueId: null,
      data: (data ?? {}) as never,
    }),
  ).catch(() => {
    /* logAction ya registra su propio fallo; aquí sólo se evita un rechazo sin atender */
  })
}

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
export async function publishAnnouncement(id: string, performedBy?: string): Promise<{ delivered: number; alreadyPublished: boolean }> {
  const anuncio = await prisma.platformAnnouncement.findUnique({ where: { id } })
  if (!anuncio) throw new NotFoundError('Anuncio no encontrado')

  if (anuncio.status === PlatformAnnouncementStatus.ARCHIVED) {
    throw new BadRequestError('Un anuncio archivado no se puede publicar')
  }

  if (anuncio.deliveredAt) {
    logger.info('Anuncio ya encolado, no se repite', { announcementId: id })
    return { delivered: anuncio.deliveredCount, alreadyPublished: true }
  }

  // CAS por estado: un `archive` concurrente no puede quedar sobrescrito a PUBLISHED —
  // ARCHIVED no encaja en ninguno de los dos brazos.
  //
  // 🔴 El segundo brazo permite REINTENTAR un reparto que quedó a medias (`PUBLISHED` con
  // `deliveredAt` nulo). Ese estado lo produce cualquier fallo entre el claim y el final:
  // un `createMany` que truena, la cuenta, un redeploy. Sin él, la guarda de arriba —que
  // mira `deliveredAt`— deja pasar y el claim rechaza, así que publicar de nuevo contesta
  // `alreadyPublished` sin encolar a nadie; y no hay otra vía de recuperación, porque el
  // job programado sólo toma SCHEDULED y el outbox sólo drena lo ya insertado. Reintentar
  // es seguro: el @@unique de las entregas vuelve idempotente el reencolado.
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
  // Sin `performedBy` es el job de lo programado: el staffId nulo ya dice que no fue una persona.
  rastro('PLATFORM_ANNOUNCEMENT_PUBLISHED', id, performedBy, { encoladas, title: anuncio.title })
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
  showAsModal: boolean
  expiresAt?: Date
}

/**
 * La lista del compositor, con el alcance REAL de cada anuncio.
 *
 * 🔴 `deliveredCount` cuenta ENTREGAS (persona × sucursal), y eso engaña: alguien dueño
 * de 12 negocios generaba 12 de esas entregas él solo, así que un anuncio parecía haber
 * llegado a mucha más gente de la que llegó. Se devuelven los dos números que importan,
 * los mismos que el compositor enseña antes de publicar: negocios y personas.
 */
export async function listAnnouncements() {
  const anuncios = await prisma.platformAnnouncement.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  if (anuncios.length === 0) return []

  const ids = anuncios.map(a => a.id)
  const [porVenue, porPersona] = await Promise.all([
    prisma.platformAnnouncementDelivery.groupBy({
      by: ['announcementId', 'venueId'],
      where: { announcementId: { in: ids } },
    }),
    prisma.platformAnnouncementDelivery.groupBy({
      by: ['announcementId', 'staffId'],
      where: { announcementId: { in: ids } },
    }),
  ])

  const negocios = new Map<string, number>()
  porVenue.forEach(g => negocios.set(g.announcementId, (negocios.get(g.announcementId) ?? 0) + 1))
  const personas = new Map<string, number>()
  porPersona.forEach(g => personas.set(g.announcementId, (personas.get(g.announcementId) ?? 0) + 1))

  return anuncios.map(a => ({
    ...a,
    reachedVenues: negocios.get(a.id) ?? 0,
    reachedPeople: personas.get(a.id) ?? 0,
  }))
}

export async function createAnnouncement(input: AnnouncementInput, createdBy: string, createdByName: string) {
  const creado = await prisma.platformAnnouncement.create({
    data: {
      ...input,
      contentBlocks: (input.contentBlocks ?? undefined) as Prisma.InputJsonValue | undefined,
      createdBy,
      createdByName,
    },
  })
  rastro('PLATFORM_ANNOUNCEMENT_CREATED', creado.id, createdBy, {
    title: input.title,
    audienceRoles: input.audienceRoles,
    targetPlanTiers: input.targetPlanTiers,
    targetCategories: input.targetCategories,
    venuesElegidosAMano: input.targetVenueIds.length,
  })
  return creado
}

/**
 * Editar sólo antes de repartir. Un anuncio ya publicado vive en miles de buzones:
 * cambiarle el texto aquí NO cambia lo que la gente ya recibió, así que dejarlo
 * editable daría una falsa sensación de corrección.
 */
export async function updateAnnouncement(id: string, input: Partial<AnnouncementInput>, performedBy?: string) {
  const actual = await prisma.platformAnnouncement.findUnique({ where: { id } })
  if (!actual) throw new NotFoundError('Anuncio no encontrado')
  if (actual.status !== PlatformAnnouncementStatus.DRAFT && actual.status !== PlatformAnnouncementStatus.SCHEDULED) {
    throw new BadRequestError('Sólo se puede editar un anuncio en borrador o programado')
  }
  const guardado = await prisma.platformAnnouncement.update({
    where: { id },
    data: {
      ...input,
      contentBlocks: (input.contentBlocks ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  })
  rastro('PLATFORM_ANNOUNCEMENT_UPDATED', id, performedBy, { campos: Object.keys(input) })
  return guardado
}

/** Programa el reparto para más tarde. El job lo publica cuando llegue la hora. */
export async function scheduleAnnouncement(id: string, scheduledFor: Date, performedBy?: string) {
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
  const programado = await prisma.platformAnnouncement.update({
    where: { id },
    data: { status: PlatformAnnouncementStatus.SCHEDULED, scheduledFor },
  })
  rastro('PLATFORM_ANNOUNCEMENT_SCHEDULED', id, performedBy, { scheduledFor: scheduledFor.toISOString() })
  return programado
}

/** Lo retira sin borrarlo: deja de salir como banner y deja de contarse como activo. */
export async function archiveAnnouncement(id: string, performedBy?: string) {
  const actual = await prisma.platformAnnouncement.findUnique({ where: { id } })
  if (!actual) throw new NotFoundError('Anuncio no encontrado')
  const archivado = await prisma.platformAnnouncement.update({
    where: { id },
    data: { status: PlatformAnnouncementStatus.ARCHIVED },
  })
  rastro('PLATFORM_ANNOUNCEMENT_ARCHIVED', id, performedBy, { estadoAnterior: actual.status })
  return archivado
}
