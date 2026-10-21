import { Prisma, NotificationType, PlatformAnnouncementDeliveryStatus } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'

const DEFAULT_LIMIT = 200
const CLAIM_LEASE_MS = 5 * 60 * 1000
const REINTENTO_MS = 2 * 60 * 1000
const MAX_INTENTOS = 5

/** El CAS no casó: se deshace la transacción de la entrega sin contarla como falla. */
class ResultadoDescartado extends Error {}

/**
 * Reclama entregas listas con `FOR UPDATE SKIP LOCKED`: dos workers nunca se llevan la
 * misma fila. `attempts` se incrementa AQUÍ, no al fallar — si el proceso muere a media
 * entrega, el intento ya está contado y la fila no puede reintentarse infinitamente.
 *
 * Es el mismo mecanismo de `customerApprovalOutbox.service.ts`, deliberadamente: el
 * reparto anterior lo reinventaba con un `updateMany` condicional y no cerraba la carrera
 * (dos procesos podían pasar el claim y crear los mismos avisos).
 */
export async function claimDeliveries(input: { limit?: number; now: Date }): Promise<string[]> {
  const limit = Math.max(1, Math.min(DEFAULT_LIMIT, input.limit ?? DEFAULT_LIMIT))
  const now = input.now
  const leaseUntil = new Date(now.getTime() + CLAIM_LEASE_MS)
  // Las columnas DateTime de este schema son `timestamp without time zone`: un Date crudo
  // viaja como timestamptz y se corre en sesiones de DB que no estén en UTC.
  const nowSql = Prisma.sql`${now.toISOString()}::timestamp`
  const leaseSql = Prisma.sql`${leaseUntil.toISOString()}::timestamp`

  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    WITH candidates AS (
      SELECT d.id
      FROM "platform_announcement_deliveries" AS d
      WHERE d.status IN ('PENDING', 'FAILED')
        AND d.attempts < ${MAX_INTENTOS}
        AND d."nextAttemptAt" <= ${nowSql}
        AND (d."leaseUntil" IS NULL OR d."leaseUntil" <= ${nowSql})
      ORDER BY d."nextAttemptAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "platform_announcement_deliveries" AS d
    SET "leaseUntil" = ${leaseSql}, attempts = d.attempts + 1, "updatedAt" = CURRENT_TIMESTAMP
    FROM candidates
    WHERE d.id = candidates.id
    RETURNING d.id
  `)

  return rows.map(r => r.id)
}

/**
 * Retira las entregas que ya no tienen salida: el proceso murió a media entrega en sus
 * `MAX_INTENTOS` reclamos, así que siguen PENDING con el contador lleno y el lease vencido.
 * `claimDeliveries` ya no las toma y nada más las tocaba: se quedaban «pendientes» para
 * siempre y el alcance del anuncio nunca las contaba. Las deja FAILED, con la razón.
 *
 * Con el lease aún vigente el quinto intento sigue vivo: no se toca. Si ese worker vuelve
 * después, su CAS ya no casa (aquí se limpia `leaseUntil`) y su resultado se descarta.
 * Lo encontró el experimento pg-boss vs colas caseras (16-oct-2026).
 */
export async function retireExhaustedDeliveries(input: { now: Date }): Promise<number> {
  const r = await prisma.platformAnnouncementDelivery.updateMany({
    where: {
      status: PlatformAnnouncementDeliveryStatus.PENDING,
      attempts: { gte: MAX_INTENTOS },
      leaseUntil: { lte: input.now },
    },
    data: {
      status: PlatformAnnouncementDeliveryStatus.FAILED,
      leaseUntil: null,
      lastError: `Agotó los ${MAX_INTENTOS} intentos: el proceso se detuvo a media entrega en cada uno`,
    },
  })
  return r.count
}

/**
 * Entrega las filas reclamadas: crea el aviso en el buzón y marca la entrega.
 *
 * 🔴 El CAS (`where { id, attempts, leaseUntil }`) es lo que impide que dos workers
 * escriban el resultado de la misma fila. Si otro la reclamó mientras ésta entregaba, el
 * `updateMany` no casa y el resultado se descarta.
 */
export async function deliverClaimed(ids: string[], opts: { now: Date }): Promise<{ sent: number; failed: number }> {
  if (ids.length === 0) return { sent: 0, failed: 0 }

  const claimed = await prisma.platformAnnouncementDelivery.findMany({
    where: { id: { in: ids } },
    include: {
      announcement: {
        select: { id: true, title: true, body: true, actionLabel: true, actionUrl: true, priority: true },
      },
    },
  })

  let sent = 0
  let failed = 0

  for (const d of claimed) {
    const casWhere = { id: d.id, attempts: d.attempts, leaseUntil: d.leaseUntil }
    try {
      // 🔴 Candado por (persona, anuncio) alrededor de «¿ya tiene aviso? → créalo». Sin él,
      // dos workers sobre la misma persona (lease vencido con el primero vivo, deploy
      // solapado, o sus entregas de dos sucursales a la vez) pasan los dos el findFirst y
      // crean DOS avisos: lo reprodujo el experimento pg-boss vs colas caseras (16-oct-2026).
      // `Notification` no tiene llave única para esto, así que el candado es la garantía.
      // El resultado (SENT) se escribe en la MISMA transacción: si el CAS no casa, otro
      // worker ya se quedó con la fila y el aviso recién creado se deshace con ella.
      const enviada = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`announcement-notification:${d.staffId}:${d.announcement.id}`}, 0))::text`

        // 🔴 UN aviso por PERSONA, no uno por sucursal.
        //
        // La entrega SÍ es por (persona, venue) — eso es lo que mide el alcance por
        // negocio. Pero el aviso del buzón es uno solo: un anuncio de plataforma no
        // pertenece a una sucursal, y la campana del dashboard ni siquiera filtra por
        // sucursal, así que repartir uno por venue le mostraba 12 copias idénticas a quien
        // administra 12 negocios. Lo encontró el founder el 2026-08-27.
        const existente = await tx.notification.findFirst({
          where: {
            recipientId: d.staffId,
            entityType: 'PlatformAnnouncement',
            entityId: d.announcement.id,
            type: NotificationType.ANNOUNCEMENT,
          },
          select: { id: true },
        })

        if (existente) {
          const r = await tx.platformAnnouncementDelivery.updateMany({
            where: casWhere,
            data: {
              status: PlatformAnnouncementDeliveryStatus.SENT,
              notificationId: existente.id,
              deliveredAt: opts.now,
              leaseUntil: null,
              lastError: null,
            },
          })
          return r.count > 0
        }

        const notif = await tx.notification.create({
          data: {
            recipientId: d.staffId,
            venueId: d.venueId,
            type: NotificationType.ANNOUNCEMENT,
            title: d.announcement.title,
            message: d.announcement.body,
            actionLabel: d.announcement.actionLabel ?? undefined,
            // 🔴 NO se pone una ruta del detalle aquí. La versión anterior mandaba a
            // `/announcements/<id>`, que sólo existe en el superadmin: en el dashboard del
            // cliente daba 404 (lo encontró el founder el 27-ago). El detalle del anuncio
            // se abre en un modal desde el propio buzón, reconociéndolo por `entityType`.
            // Este campo queda para el botón que el anuncio traiga configurado, si trae.
            actionUrl: d.announcement.actionUrl ?? undefined,
            entityType: 'PlatformAnnouncement',
            entityId: d.announcement.id,
            priority: d.announcement.priority,
          },
        })

        const r = await tx.platformAnnouncementDelivery.updateMany({
          where: casWhere,
          data: {
            status: PlatformAnnouncementDeliveryStatus.SENT,
            notificationId: notif.id,
            deliveredAt: opts.now,
            leaseUntil: null,
            lastError: null,
          },
        })
        if (r.count === 0) throw new ResultadoDescartado()
        return true
      })
      if (enviada) sent++
    } catch (error) {
      // Otro worker reclamó la fila mientras ésta entregaba: su resultado manda.
      if (error instanceof ResultadoDescartado) continue
      const mensaje = error instanceof Error ? error.message : String(error)
      await prisma.platformAnnouncementDelivery.updateMany({
        where: casWhere,
        data: {
          status: PlatformAnnouncementDeliveryStatus.FAILED,
          nextAttemptAt: new Date(opts.now.getTime() + REINTENTO_MS),
          leaseUntil: null,
          lastError: mensaje,
        },
      })
      failed++
      logger.warn('No se pudo entregar un anuncio', { deliveryId: d.id, error: mensaje })
    }
  }

  return { sent, failed }
}
