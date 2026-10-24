import { NotificationPriority, NotificationType } from '@prisma/client'

import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import socketManager from '../../communication/sockets'

/**
 * 🚨 Rappi 2b (F7): dinero de un pedido de Rappi en efectivo que una persona tiene que conciliar con Rappi. Mismo patrón que
 * `avisarSobrepago`: gritar (Better Stack vigila «🚨 [Rappi efectivo]») y dejar fila en `ActivityLog`; además se le NOTIFICA a quien
 * administra el negocio (Codex código r1 #6: la bitácora sola no le avisa a nadie). NUNCA rechaza ni lanza: cuando se llama, el
 * dinero ya se registró.
 *  · `RAPPI_CASH_ON_CANCELLED_ORDER`: Rappi canceló y después llegó el dinero (sin red, tarde o con la terminal). Sigue cancelado.
 *  · `RAPPI_CASH_ORDER_OTHER_MEDIUM`: se cobró por otro medio (tarjeta, transferencia): la tarifa de Rappi no está en el cajón.
 *  · `DELIVERY_CANCELLED_AFTER_CASH`: la plataforma canceló un pedido que la caja ya había cobrado (la bitácora la escribe la
 *    cancelación dentro de su candado; aquí sólo se notifica).
 */
export type AvisoDeRappiEfectivo = 'RAPPI_CASH_ON_CANCELLED_ORDER' | 'RAPPI_CASH_ORDER_OTHER_MEDIUM'

const MENSAJE: Record<AvisoDeRappiEfectivo | 'DELIVERY_CANCELLED_AFTER_CASH', { titulo: string; texto: string }> = {
  RAPPI_CASH_ON_CANCELLED_ORDER: {
    titulo: 'Rappi canceló un pedido que se cobró',
    texto: 'Rappi canceló el pedido y se cobró en la caja: ponte de acuerdo con Rappi o devuélvele el dinero al cliente.',
  },
  RAPPI_CASH_ORDER_OTHER_MEDIUM: {
    titulo: 'Pedido de Rappi cobrado por otro medio',
    texto: 'Se cobró con tarjeta o transferencia un pedido de Rappi en efectivo: concilia con Rappi su tarifa.',
  },
  DELIVERY_CANCELLED_AFTER_CASH: {
    titulo: 'La plataforma canceló un pedido ya cobrado',
    texto: 'La plataforma canceló un pedido que ya se cobró en la caja: ponte de acuerdo con ella o devuélvele el dinero al cliente.',
  },
}

/** Roles que administran el dinero del negocio: a ellos les llega el aviso. */
const ROLES_QUE_CONCILIAN = ['OWNER', 'ADMIN', 'MANAGER'] as const

/**
 * La notificación a quienes concilian, con el tipo EXISTENTE `PAYMENT_RECEIVED` (las apps publicadas tiran el buzón entero ante un
 * tipo desconocido: misma decisión que `avisarCobroTardioAlCajero`). Una por persona y pedido: si ya existe, no se repite.
 * Fire-and-forget: nunca lanza.
 */
export async function notificarConciliacionDeReparto(a: {
  motivo: AvisoDeRappiEfectivo | 'DELIVERY_CANCELLED_AFTER_CASH'
  venueId: string
  orderId: string
  paymentId?: string | null
}): Promise<void> {
  try {
    const { titulo, texto } = MENSAJE[a.motivo]
    const clave = `${a.motivo}:${a.orderId}`
    // Codex código r2: «¿ya existe? → crear» bajo un candado de la base por motivo y pedido (sin Redis: `pg_advisory_xact_lock`).
    // Dos registros simultáneos del mismo pedido (dos aparatos sincronizando a la vez) dejan UNA notificación por persona.
    const creadas = await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'aviso-reparto:' + a.venueId + ':' + clave}))`
      const personas = await tx.staffVenue.findMany({
        where: { venueId: a.venueId, active: true, role: { in: [...ROLES_QUE_CONCILIAN] } },
        select: { staffId: true },
        take: 20,
      })
      const nuevas = []
      for (const { staffId } of personas) {
        const ya = await tx.notification.count({
          where: { venueId: a.venueId, recipientId: staffId, metadata: { path: ['avisoDeReparto'], equals: clave } },
        })
        if (ya > 0) continue
        nuevas.push(
          await tx.notification.create({
            data: {
              recipientId: staffId,
              venueId: a.venueId,
              type: NotificationType.PAYMENT_RECEIVED,
              priority: NotificationPriority.HIGH,
              title: titulo,
              message: texto,
              entityType: 'Order',
              entityId: a.orderId,
              metadata: { avisoDeReparto: clave, orderId: a.orderId, paymentId: a.paymentId ?? null, motivo: a.motivo },
            },
          }),
        )
      }
      return nuevas
    })
    // En vivo DESPUÉS del commit: nunca se avisa algo que no quedó guardado.
    for (const n of creadas) {
      try {
        socketManager.getBroadcastingService()?.broadcastNewNotification({
          notificationId: n.id,
          recipientId: n.recipientId,
          venueId: n.venueId || '',
          userId: n.recipientId,
          type: n.type,
          title: n.title,
          message: n.message,
          priority: 'HIGH',
          isRead: false,
          metadata: (n.metadata as Record<string, unknown>) || undefined,
        })
      } catch {
        // La fila ya está guardada: la verá al abrir el buzón aunque el socket esté caído.
      }
    }
  } catch (err) {
    logger.error('🚨 [Rappi efectivo] No se pudo notificar a quien concilia (la bitácora sí quedó)', {
      orderId: a.orderId,
      error: err instanceof Error ? err.message : err,
    })
  }
}

export function avisarDineroDeRappi(a: {
  action: AvisoDeRappiEfectivo
  orderId: string
  venueId: string
  paymentId: string
  staffId: string | null
  data?: Record<string, unknown>
}): void {
  const { texto } = MENSAJE[a.action]
  logger.error(`🚨 [Rappi efectivo] ${texto}`, { orderId: a.orderId, venueId: a.venueId, paymentId: a.paymentId, ...a.data })
  // Fire-and-forget FUERA de toda transacción: una falla del audit o del aviso jamás puede tocar el cobro.
  void prisma.activityLog
    .create({
      data: {
        action: a.action,
        entity: 'Order',
        entityId: a.orderId,
        staffId: a.staffId,
        venueId: a.venueId,
        data: { paymentId: a.paymentId, mensaje: texto, ...a.data },
      },
    })
    .catch(err => {
      logger.error('🚨 [Rappi efectivo] No se pudo escribir el ActivityLog del aviso', {
        orderId: a.orderId,
        error: err instanceof Error ? err.message : err,
      })
    })
  void notificarConciliacionDeReparto({ motivo: a.action, venueId: a.venueId, orderId: a.orderId, paymentId: a.paymentId })
}
