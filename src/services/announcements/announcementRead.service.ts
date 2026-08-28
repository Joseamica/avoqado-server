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
 * Lo que el inicio del dashboard necesita de una sola llamada: el banner y la ventana.
 *
 * Son dos cosas distintas del MISMO anuncio o de anuncios distintos:
 *  - `banner`: la tira en el Home. Discreto, convive con el trabajo.
 *  - `modal`: la ventana que interrumpe. 🔴 Sólo mientras su aviso siga SIN LEER — al
 *    cerrarla se marca leído, así que interrumpe una vez y después vive en la campana.
 *    Es exactamente lo que pidió el founder, y lo que evita que la gente aprenda a
 *    cerrar ventanas sin leerlas.
 *
 * Los dos pasan por el acuse de recibo: sin él no se enseña nada.
 */
export async function getActiveForHome(staffId: string) {
  const ahora = new Date()
  const activos = await prisma.platformAnnouncement.findMany({
    where: {
      status: PlatformAnnouncementStatus.PUBLISHED,
      OR: [{ expiresAt: null }, { expiresAt: { gt: ahora } }],
      AND: [{ OR: [{ showAsBanner: true }, { showAsModal: true }] }],
    },
    orderBy: [{ priority: 'desc' }, { publishedAt: 'desc' }],
    take: 20,
  })
  if (activos.length === 0) return { banner: null, modal: null }

  const acuses = await prisma.platformAnnouncementDelivery.findMany({
    where: { staffId, announcementId: { in: activos.map(a => a.id) } },
    select: { announcementId: true },
  })
  if (acuses.length === 0) return { banner: null, modal: null }
  const recibidos = new Set(acuses.map(a => a.announcementId))

  const mios = activos.filter(a => recibidos.has(a.id))
  if (mios.length === 0) return { banner: null, modal: null }

  // El estado de lectura decide si la ventana sigue interrumpiendo.
  const avisos = await prisma.notification.findMany({
    where: {
      recipientId: staffId,
      entityType: ENTITY,
      type: NotificationType.ANNOUNCEMENT,
      entityId: { in: mios.map(a => a.id) },
    },
    select: { entityId: true, isRead: true },
  })
  const sinLeer = new Set(avisos.filter(n => !n.isRead).map(n => n.entityId))

  return {
    banner: mios.find(a => a.showAsBanner) ?? null,
    modal: mios.find(a => a.showAsModal && sinLeer.has(a.id)) ?? null,
  }
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
  const [reached, delivered, read, opened, cta] = await Promise.all([
    prisma.platformAnnouncementDelivery.count({ where: { announcementId } }),
    prisma.platformAnnouncementDelivery.count({ where: { announcementId, status: 'SENT' } }),
    // 🔴 Los leídos se cuentan por los ACUSES entregados, uniendo con su Notification.
    // Contar `Notification` sueltas dejaba el número inflable: cualquiera con
    // `notifications:send` puede crear una con esos campos y marcarla leída.
    prisma.notification.count({
      where: {
        entityType: ENTITY,
        entityId: announcementId,
        type: NotificationType.ANNOUNCEMENT,
        isRead: true,
        id: {
          in: (
            await prisma.platformAnnouncementDelivery.findMany({
              where: { announcementId, notificationId: { not: null } },
              select: { notificationId: true },
            })
          ).map(d => d.notificationId as string),
        },
      },
    }),
    prisma.platformAnnouncementClick.count({ where: { announcementId } }),
    prisma.platformAnnouncementClick.count({ where: { announcementId, ctaAt: { not: null } } }),
  ])
  return { reached, delivered, read, opened, cta }
}
