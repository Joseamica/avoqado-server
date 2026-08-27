import { PlatformAnnouncementStatus, NotificationType } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { ForbiddenError } from '../../errors/AppError'

const ENTITY = 'PlatformAnnouncement'

/**
 * ¿Esta persona puede leer este anuncio?
 *
 * 🔴 UN solo candado, y es el correcto: **existe su acuse de recibo**
 * (`PlatformAnnouncementDelivery`), que sólo escribe el publisher.
 *
 * Por qué no las dos cosas que se probaron antes:
 *  - La `Notification` sola NO servía: `POST /dashboard/notifications` (permiso
 *    `notifications:send`) acepta `entityType` y `entityId` libres, así que el propio
 *    usuario podía fabricarse la credencial.
 *  - Revalidar la audiencia ACTUAL tampoco: le quitaba el anuncio a quien cambiaba de
 *    plan — incluido el caso que más importa, un negocio GRATIS que ve el anuncio de una
 *    función PRO, la compra, y al subir de plan perdería justo el aviso que lo convenció.
 *
 * El acuse resuelve las dos: no es fabricable y es histórico.
 */
async function puedeLeer(announcementId: string, staffId: string): Promise<boolean> {
  const acuse = await prisma.platformAnnouncementDelivery.findFirst({
    where: { announcementId, staffId },
    select: { id: true },
  })
  return Boolean(acuse)
}

/** El anuncio completo, con sus bloques, para la vista de detalle. */
export async function getAnnouncementForStaff(announcementId: string, staffId: string) {
  if (!(await puedeLeer(announcementId, staffId))) {
    throw new ForbiddenError('Este anuncio no está disponible para ti')
  }
  return prisma.platformAnnouncement.findUnique({ where: { id: announcementId } })
}

/** Registra que abrió el detalle. Idempotente por (anuncio, persona). */
export async function recordOpen(announcementId: string, staffId: string, venueId?: string) {
  if (!(await puedeLeer(announcementId, staffId))) {
    throw new ForbiddenError('Este anuncio no está disponible para ti')
  }
  return prisma.platformAnnouncementClick.upsert({
    where: { announcementId_staffId: { announcementId, staffId } },
    create: { announcementId, staffId, venueId },
    update: {},
  })
}

/** Registra que tocó el botón principal. */
export async function recordCta(announcementId: string, staffId: string, venueId?: string) {
  if (!(await puedeLeer(announcementId, staffId))) {
    throw new ForbiddenError('Este anuncio no está disponible para ti')
  }
  return prisma.platformAnnouncementClick.upsert({
    where: { announcementId_staffId: { announcementId, staffId } },
    create: { announcementId, staffId, venueId, ctaAt: new Date() },
    update: { ctaAt: new Date() },
  })
}

/**
 * El banner del Home.
 *
 * 🔴 Devuelve UNO solo: gana la prioridad más alta y, a igualdad, el publicado más
 * reciente. Apilar banners convierte el Home en un tablero de avisos y deja de leerse
 * ninguno. Los demás siguen visibles en la campana.
 */
/**
 * El banner del Home.
 *
 * 🔴 Se consulta AL REVÉS de como estaba: primero los banners activos (son pocos por
 * naturaleza y hay índice `[status, showAsBanner]`), y después si a esta persona le
 * tocaron. La versión anterior tomaba los 50 avisos más recientes de la persona y LUEGO
 * filtraba por banner: cincuenta avisos normales nuevos escondían indefinidamente un
 * banner vigente (hallazgo P1 de la segunda auditoría).
 *
 * Devuelve UNO solo: gana la prioridad más alta y, a igualdad, el publicado más reciente.
 * Apilar banners convierte el Home en un tablero de avisos y deja de leerse ninguno.
 */
export async function getActiveBanner(staffId: string) {
  const ahora = new Date()
  const banners = await prisma.platformAnnouncement.findMany({
    where: {
      status: PlatformAnnouncementStatus.PUBLISHED,
      showAsBanner: true,
      OR: [{ expiresAt: null }, { expiresAt: { gt: ahora } }],
    },
    orderBy: [{ priority: 'desc' }, { publishedAt: 'desc' }],
    take: 20,
  })
  if (banners.length === 0) return null

  const acuses = await prisma.platformAnnouncementDelivery.findMany({
    where: { staffId, announcementId: { in: banners.map(b => b.id) } },
    select: { announcementId: true },
  })
  const recibidos = new Set(acuses.map(a => a.announcementId))

  return banners.find(b => recibidos.has(b.id)) ?? null
}

/**
 * Los anuncios que esta persona puede ver, ya autorizados.
 *
 * 🔴 Existe para que HTTP y el MCP compartan UNA sola ruta de autorización. La tool del
 * MCP consultaba `Notification` por su cuenta y devolvía título y cuerpo sin revalidar
 * nada — el mismo hueco que ya estaba cerrado en el detalle, abierto por la puerta de al
 * lado (hallazgo P1 de la segunda auditoría).
 */
export async function listAnnouncementsForStaff(staffId: string, opts: { limit: number; unreadOnly: boolean }) {
  const acuses = await prisma.platformAnnouncementDelivery.findMany({
    where: { staffId },
    select: { announcementId: true },
  })
  if (acuses.length === 0) return []

  const notifs = await prisma.notification.findMany({
    where: {
      recipientId: staffId,
      entityType: ENTITY,
      type: NotificationType.ANNOUNCEMENT,
      entityId: { in: acuses.map(a => a.announcementId) },
      ...(opts.unreadOnly ? { isRead: false } : {}),
    },
    select: { entityId: true, isRead: true, readAt: true, createdAt: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: opts.limit,
  })
  if (notifs.length === 0) return []

  const ids = notifs.map(n => n.entityId).filter((id): id is string => Boolean(id))
  const anuncios = await prisma.platformAnnouncement.findMany({ where: { id: { in: ids } } })
  const porId = new Map(anuncios.map(a => [a.id, a]))

  return notifs
    .map(n => {
      const a = n.entityId ? porId.get(n.entityId) : undefined
      if (!a) return null
      return {
        id: a.id,
        title: a.title,
        body: a.body,
        priority: a.priority,
        actionLabel: a.actionLabel,
        publishedAt: a.publishedAt,
        expiresAt: a.expiresAt,
        isRead: n.isRead,
        readAt: n.readAt,
        receivedAt: n.createdAt,
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
}

/**
 * Métricas del anuncio.
 *
 * ⚠️ `read` y `opened` son cosas DISTINTAS y nunca se suman: marcar leído en la campana
 * no significa que alguien haya abierto el anuncio.
 */
export async function getAnnouncementMetrics(announcementId: string) {
  const [reached, read, opened, cta] = await Promise.all([
    // El alcance sale de los ACUSES, que sólo escribe el publisher: una Notification
    // fabricada por un usuario ya no puede inflar el número que ve el superadmin.
    prisma.platformAnnouncementDelivery.count({ where: { announcementId } }),
    prisma.notification.count({
      where: { entityType: ENTITY, entityId: announcementId, type: NotificationType.ANNOUNCEMENT, isRead: true },
    }),
    prisma.platformAnnouncementClick.count({ where: { announcementId } }),
    prisma.platformAnnouncementClick.count({ where: { announcementId, ctaAt: { not: null } } }),
  ])
  return { reached, read, opened, cta }
}
