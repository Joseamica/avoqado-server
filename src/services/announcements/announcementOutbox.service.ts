import { Prisma, NotificationType, PlatformAnnouncementDeliveryStatus } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'

const DEFAULT_LIMIT = 200
const CLAIM_LEASE_MS = 5 * 60 * 1000
const REINTENTO_MS = 2 * 60 * 1000
const MAX_INTENTOS = 5

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
        select: { id: true, title: true, body: true, actionLabel: true, priority: true },
      },
    },
  })

  let sent = 0
  let failed = 0

  for (const d of claimed) {
    const casWhere = { id: d.id, attempts: d.attempts, leaseUntil: d.leaseUntil }
    try {
      const notif = await prisma.notification.create({
        data: {
          recipientId: d.staffId,
          venueId: d.venueId,
          type: NotificationType.ANNOUNCEMENT,
          title: d.announcement.title,
          message: d.announcement.body,
          actionLabel: d.announcement.actionLabel ?? undefined,
          actionUrl: `/announcements/${d.announcement.id}`,
          entityType: 'PlatformAnnouncement',
          entityId: d.announcement.id,
          priority: d.announcement.priority,
        },
      })

      const r = await prisma.platformAnnouncementDelivery.updateMany({
        where: casWhere,
        data: {
          status: PlatformAnnouncementDeliveryStatus.SENT,
          notificationId: notif.id,
          deliveredAt: opts.now,
          leaseUntil: null,
          lastError: null,
        },
      })
      if (r.count > 0) sent++
    } catch (error) {
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
