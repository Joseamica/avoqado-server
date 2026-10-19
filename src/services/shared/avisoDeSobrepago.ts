import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'

/**
 * 🚨 SOBREPAGO — gritar y dejar rastro, NUNCA rechazar ni lanzar.
 *
 * Cuando alguien llama aquí, el dinero YA entró (la tarjeta se cobró en el banco, o el efectivo que la cola sin red reenvía ya está
 * en el cajón): rechazarlo dejaría dinero cobrado SIN registro, un cobro fantasma peor que el sobrepago. El pago SIEMPRE se registra;
 * lo que se elimina es la invisibilidad (caso Mindform: $734 cobrados sobre una cuenta de $380, invisible 2 meses).
 * `wasAlreadyPaid` distingue un cobro que aterriza sobre una venta YA cerrada.
 *
 * La comparten la terminal (`updateOrderTotalsForStandalonePayment`) y el POS móvil (`payCashOrder`): MISMO texto, que Better Stack
 * vigila, y MISMA fila `SOBREPAGO_DETECTADO` en `ActivityLog`. Quien llama decide CUÁNDO avisar.
 */
export function avisarSobrepago(s: {
  orderId: string
  venueId: string
  totalPaid: number
  orderTotal: number
  overpaidBy: number
  wasAlreadyPaid: boolean
  paymentId: string | null
  staffId: string | null
}): void {
  const { orderId, venueId, totalPaid, orderTotal, overpaidBy, wasAlreadyPaid, paymentId, staffId } = s
  // BetterStack debe alertar sobre '🚨 [Sobrepago]'.
  logger.error('🚨 [Sobrepago] Se cobró MÁS de lo que vale la cuenta — el pago se registra, pero requiere revisión', {
    orderId,
    venueId,
    totalPaid,
    orderTotal,
    overpaidBy,
    wasAlreadyPaid,
    paymentId,
    staffId,
  })
  // Fire-and-forget FUERA de toda transacción: una falla del audit jamás puede tocar el cobro.
  void prisma.activityLog
    .create({
      data: {
        action: 'SOBREPAGO_DETECTADO',
        entity: 'Order',
        entityId: orderId,
        staffId,
        venueId,
        data: { totalPaid, orderTotal, overpaidBy, wasAlreadyPaid, paymentId },
      },
    })
    .catch(err => {
      logger.error('🚨 [Sobrepago] No se pudo escribir el ActivityLog del sobrepago', {
        orderId,
        error: err instanceof Error ? err.message : err,
      })
    })
}
