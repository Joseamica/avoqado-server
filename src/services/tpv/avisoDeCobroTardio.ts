/**
 * «Apareció el cobro de una venta que dabas por no cobrada» — el aviso AL CAJERO (plan 18-sep, Task 7).
 *
 * 🔴 El hueco que cierra: el tratamiento de la aprobación tardía ya detectaba este caso, pero lo único que hacía
 * era `sendOpsAlert`, o sea un correo a operaciones. La persona que puede cobrar de nuevo por error —el cajero que
 * declaró— no se enteraba de nada. El mockup que aprobó el founder dibuja exactamente esta pantalla.
 *
 * Va dirigido a QUIEN DECLARÓ, no al venue entero: es su declaración la que el dinero acaba de contradecir, y es
 * quien tiene al cliente enfrente.
 *
 * 🔴 Decisión de compatibilidad, no de estilo: NO se agrega un valor a `NotificationType`. El decoder estricto de
 * iOS tira el arreglo ENTERO al toparse un tipo desconocido (la lección de los conteos cancelados, 7-sep), así que
 * estrenar uno dejaría sin buzón a las apps ya publicadas. Se reusa `PAYMENT_RECEIVED`, que además es literal: un
 * pago entró.
 */
import { NotificationPriority, NotificationType } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import socketManager from '../../communication/sockets'
import { readUnchargedReconciliation } from './uncharged-reconciliation.service'

/**
 * Fire-and-forget: NUNCA lanza y NUNCA corre dentro de la transacción del dinero. Un aviso que falla no puede
 * deshacer el registro de un cobro — ésa es la misma regla que `logAction`.
 */
export async function avisarCobroTardioAlCajero(ctx: {
  requestId: string
  venueId: string
  paymentId: string
  terminalId: string | null
  orderId: string | null
}): Promise<void> {
  try {
    const row = await prisma.terminalPaymentRequest.findFirst({
      where: { requestId: ctx.requestId, venueId: ctx.venueId },
      // El id y el importe se leen de la MISMA fila: así el sitio que engancha esto sólo pasa lo que ya tiene.
      select: { id: true, amountCents: true, operatorReconciliation: true },
    })
    // Sólo este caso: la declaración del CAJERO. La de gerencia («no se presentó tarjeta») tiene su propio
    // tratamiento, y una liberación por ventana no tiene a quién avisarle en particular.
    const declaracion = readUnchargedReconciliation(row?.operatorReconciliation)
    if (!declaracion?.staffId) return

    const pesos = ((row?.amountCents ?? 0) / 100).toFixed(2)
    const notificacion = await prisma.notification.create({
      data: {
        recipientId: declaracion.staffId,
        venueId: ctx.venueId,
        type: NotificationType.PAYMENT_RECEIVED,
        priority: NotificationPriority.HIGH,
        title: 'Apareció el cobro de una venta anterior',
        message:
          `El banco aprobó $${pesos} de una venta que habías dado por no cobrada. ` +
          'Avoqado ya lo registró: no lo cobres otra vez.',
        entityType: 'TerminalPaymentRequest',
        entityId: row?.id ?? null,
        metadata: {
          requestId: ctx.requestId,
          paymentId: ctx.paymentId,
          terminalId: ctx.terminalId,
          orderId: ctx.orderId,
          resolutionId: declaracion.id,
        },
      },
    })
    // 🔴 Guardar no es avisar: un buzón que nadie abre no le dice nada al cajero que está por cobrar otra vez.
    // Se emite EN VIVO por el mismo canal que el resto de las notificaciones.
    //
    // 🔴 Y por eso NO se usa `createNotification` del dashboard, que sí emitiría: esa función LANZA si el
    // usuario tiene el tipo deshabilitado o está en horas de silencio. Un aviso de DINERO no se puede poder
    // silenciar — es la misma regla de los anuncios: la fila siempre existe, sólo la entrega respeta preferencias.
    try {
      socketManager.getBroadcastingService()?.broadcastNewNotification({
        notificationId: notificacion.id,
        recipientId: notificacion.recipientId,
        venueId: notificacion.venueId || '',
        userId: notificacion.recipientId,
        type: notificacion.type,
        title: notificacion.title,
        message: notificacion.message,
        priority: 'HIGH',
        isRead: false,
        metadata: (notificacion.metadata as Record<string, unknown>) || undefined,
      })
    } catch (err) {
      // La fila ya está guardada: el cajero la verá al abrir el buzón aunque el socket esté caído.
      logger.warn('⚠️ [TerminalPayment] el aviso quedó GUARDADO pero no se pudo emitir en vivo', {
        requestId: ctx.requestId,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    logger.warn('🧾 [TerminalPayment] cobro tardío sobre una declaración del cajero — avisado en el aparato', {
      requestId: ctx.requestId,
      venueId: ctx.venueId,
      staffId: declaracion.staffId,
      paymentId: ctx.paymentId,
    })
  } catch (err) {
    logger.warn('⚠️ [TerminalPayment] no se pudo avisar al cajero del cobro tardío — el dinero SÍ quedó registrado', {
      requestId: ctx.requestId,
      venueId: ctx.venueId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
