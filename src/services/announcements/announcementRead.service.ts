import { PlatformAnnouncementStatus, NotificationType, PosAppNoticeKind, type PlatformAnnouncement } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { ForbiddenError } from '../../errors/AppError'
import { isBelow } from '../posAppVersion/decide'
import type { HomeAppIdentity } from '../posAppVersion/appIdentity'

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
 *
 * 🔴 La única excepción es el aviso de actualizar del POS (spec §4.7.4): un anuncio con `posAppPlatform` no tiene acuses
 * (nace ya «repartido» y el inicio lo elige por la versión de la app), así que lo lee cualquier empleado autenticado
 * mientras esté `PUBLISHED`. Su contenido no es sensible, y así una app vieja puede abrirlo, tocar [Actualizar] y cerrarlo.
 * Archivado da 403, como un anuncio sin acuse, aunque por algún motivo tuviera uno.
 *
 * Las dos lecturas van EN PARALELO: un anuncio normal no espera una consulta de más. La del anuncio es por su id y sólo
 * trae esas dos columnas, no el contenido.
 */
async function puedeLeer(announcementId: string, staffId: string): Promise<boolean> {
  const [anuncio, acuse] = await Promise.all([
    prisma.platformAnnouncement.findFirst({
      where: { id: announcementId },
      select: { posAppPlatform: true, status: true },
    }),
    prisma.platformAnnouncementDelivery.findFirst({
      where: { announcementId, staffId },
      select: { id: true },
    }),
  ])
  if (anuncio?.posAppPlatform) return anuncio.status === PlatformAnnouncementStatus.PUBLISHED
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
    // Una actualización no vacía permite el UPSERT atómico de Postgres sin cambiar la primera interacción.
    update: { announcementId },
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
 * Cierra la ventana que interrumpe. A partir de aquí el anuncio vive sólo en la campana.
 *
 * Es una marca PROPIA a propósito: `Notification.isRead` no sirve para esto porque la
 * campana lo enciende sola al abrirse.
 */
export async function recordDismiss(announcementId: string, staffId: string, venueId?: string) {
  if (!(await puedeLeer(announcementId, staffId))) {
    throw new ForbiddenError('Este anuncio no está disponible')
  }
  const ahora = new Date()
  await prisma.platformAnnouncementClick.upsert({
    where: { announcementId_staffId: { announcementId, staffId } },
    create: { announcementId, staffId, venueId, dismissedAt: ahora },
    update: { dismissedAt: ahora },
  })
}

type InicioDelHome = { banner: PlatformAnnouncement | null; modal: PlatformAnnouncement | null }

/**
 * El aviso de actualizar que le toca a esta app en el inicio, o `null` para seguir con el camino de hoy (spec §4.7.3).
 *
 * - «Bloquear» (`REQUIRED`) cuya versión deja a la app debajo: el banner es el aviso aunque lo haya cerrado (es lo más
 *   fuerte que una app vieja puede mostrar); la ventana respeta el cierre e interrumpe una vez.
 * - Si no, «Avisar» (`RECOMMENDED`) sin cerrar: banner y ventana según su forma, como un anuncio normal.
 * - «Avisar» cerrado, o la app al día: `null`.
 *
 * Sin acuses: estos anuncios nacen ya «repartidos» y no son de nadie en particular. Lo que decide es la versión.
 */
async function avisoDeActualizar(staffId: string, app: HomeAppIdentity, ahora: Date): Promise<InicioDelHome | null> {
  // A lo más hay dos vivos por plataforma (uno por nivel). El tope tolera un duplicado pasajero; gana el más reciente.
  const avisos = await prisma.platformAnnouncement.findMany({
    where: {
      posAppPlatform: app.platform,
      status: PlatformAnnouncementStatus.PUBLISHED,
      OR: [{ expiresAt: null }, { expiresAt: { gt: ahora } }],
    },
    orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
    take: 4,
  })
  if (avisos.length === 0) return null

  const instalada = { versionCode: app.versionCode, versionName: app.versionName }
  const debajo = (a: PlatformAnnouncement) =>
    isBelow(app.platform, instalada, { versionCode: a.posAppBelowVersionCode, versionName: a.posAppBelowVersionName })
  const bloquear = avisos.find(a => a.posAppNoticeKind === PosAppNoticeKind.REQUIRED && debajo(a)) ?? null
  const avisar = avisos.find(a => a.posAppNoticeKind === PosAppNoticeKind.RECOMMENDED && debajo(a)) ?? null
  if (!bloquear && !avisar) return null

  const ids = [bloquear, avisar].filter((a): a is PlatformAnnouncement => a !== null).map(a => a.id)
  // Lo que apaga la ventana es haberla CERRADO (`dismissedAt`), igual que en los anuncios normales. El unique
  // (anuncio, persona) deja a lo más una fila por id.
  const cerrados = await prisma.platformAnnouncementClick.findMany({
    where: { staffId, announcementId: { in: ids }, dismissedAt: { not: null } },
    select: { announcementId: true },
    take: ids.length,
  })
  const yaCerrado = new Set(cerrados.map(c => c.announcementId))

  if (bloquear) {
    return { banner: bloquear, modal: yaCerrado.has(bloquear.id) ? null : bloquear }
  }
  if (avisar && !yaCerrado.has(avisar.id)) {
    return { banner: avisar.showAsBanner ? avisar : null, modal: avisar.showAsModal ? avisar : null }
  }
  return null
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
 *
 * 🔴 Actualizador del POS (r7, spec §4.7.3): `app` es la app que pregunta, leída de sus cabeceras SÓLO por la ruta
 * (`readHomeAppIdentity`). Si viene y está debajo de un aviso de actualizar de su plataforma, ese aviso ocupa el lugar del
 * banner y de la ventana (`avisoDeActualizar`). Sin `app` (el DASHBOARD, o una app que no se puede comparar) todo sigue
 * como siempre, y el camino de hoy nunca enseña un aviso de actualizar (`posAppPlatform: null`).
 */
export async function getActiveForHome(staffId: string, app?: HomeAppIdentity | null) {
  const ahora = new Date()

  if (app) {
    const aviso = await avisoDeActualizar(staffId, app, ahora)
    if (aviso) return aviso
  }

  const activos = await prisma.platformAnnouncement.findMany({
    where: {
      // Los avisos de actualizar no tienen acuses y sólo los elige la versión de la app (arriba).
      posAppPlatform: null,
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

  // 🔴 Lo que apaga la ventana es haberla CERRADO, no que el aviso esté leído.
  //
  // La versión anterior usaba `Notification.isRead` y estaba mal: la campana del
  // dashboard marca TODO como leído nada más ABRIRLA ("Mark all as read when opening the
  // dropdown"), así que asomarse al buzón apagaba una ventana que la persona nunca vio.
  // Lo encontró el founder probándolo el 2026-08-27.
  const cerrados = await prisma.platformAnnouncementClick.findMany({
    where: {
      staffId,
      announcementId: { in: mios.map(a => a.id) },
      dismissedAt: { not: null },
    },
    select: { announcementId: true },
  })
  const yaCerrado = new Set(cerrados.map(c => c.announcementId))

  return {
    // 🔴 LOS DOS respetan el cierre. La primera versión sólo filtraba la ventana, así que
    // cerrabas el banner con la X, recargabas y volvía a salir.
    banner: mios.find(a => a.showAsBanner && !yaCerrado.has(a.id)) ?? null,
    modal: mios.find(a => a.showAsModal && !yaCerrado.has(a.id)) ?? null,
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
  const [entregas, enviadas, avisos, aperturas, ctas] = await Promise.all([
    // 🔴 Se cuentan NEGOCIOS y PERSONAS distintos, no entregas: alguien dueño de 12
    // sucursales genera 12 entregas él solo, y ese número exagera el alcance real. Mismo
    // criterio que la lista y que el conteo en vivo del compositor.
    prisma.platformAnnouncementDelivery.groupBy({
      by: ['staffId', 'venueId'],
      where: { announcementId },
    }),
    prisma.platformAnnouncementDelivery.groupBy({
      by: ['staffId'],
      where: { announcementId, status: 'SENT' },
    }),
    prisma.platformAnnouncementDelivery.findMany({
      where: { announcementId, notificationId: { not: null } },
      select: { notificationId: true },
    }),
    prisma.platformAnnouncementClick.count({ where: { announcementId } }),
    prisma.platformAnnouncementClick.count({ where: { announcementId, ctaAt: { not: null } } }),
  ])

  const leidos = await prisma.notification.count({
    where: {
      entityType: ENTITY,
      entityId: announcementId,
      type: NotificationType.ANNOUNCEMENT,
      isRead: true,
      id: { in: avisos.map(a => a.notificationId as string) },
    },
  })

  return {
    reachedVenues: new Set(entregas.map(e => e.venueId)).size,
    reachedPeople: new Set(entregas.map(e => e.staffId)).size,
    delivered: enviadas.length,
    read: leidos,
    opened: aperturas,
    cta: ctas,
  }
}
