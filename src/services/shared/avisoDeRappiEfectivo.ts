import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'

/**
 * 🚨 Rappi 2b (F7): dinero de un pedido de Rappi en efectivo que una persona tiene que conciliar con Rappi. Mismo patrón que
 * `avisarSobrepago`: gritar (Better Stack vigila «🚨 [Rappi efectivo]») y dejar fila en `ActivityLog`; NUNCA rechazar ni lanzar:
 * cuando se llama, el dinero ya se registró.
 *  · `RAPPI_CASH_ON_CANCELLED_ORDER`: Rappi canceló y después llegó el efectivo (sin red o tarde). El pedido sigue cancelado.
 *  · `RAPPI_CASH_ORDER_OTHER_MEDIUM`: se cobró por otro medio (tarjeta externa, transferencia): la tarifa de Rappi no está en
 *    el cajón y hay que conciliarla.
 */
export type AvisoDeRappiEfectivo = 'RAPPI_CASH_ON_CANCELLED_ORDER' | 'RAPPI_CASH_ORDER_OTHER_MEDIUM'

const MENSAJE: Record<AvisoDeRappiEfectivo, string> = {
  RAPPI_CASH_ON_CANCELLED_ORDER:
    'Rappi canceló el pedido y se cobró en efectivo: ponte de acuerdo con Rappi o devuélvele el dinero al cliente',
  RAPPI_CASH_ORDER_OTHER_MEDIUM: 'Se cobró un pedido de Rappi en efectivo por otro medio: concilia la tarifa de Rappi',
}

export function avisarDineroDeRappi(a: {
  action: AvisoDeRappiEfectivo
  orderId: string
  venueId: string
  paymentId: string
  staffId: string | null
  data?: Record<string, unknown>
}): void {
  logger.error(`🚨 [Rappi efectivo] ${MENSAJE[a.action]}`, { orderId: a.orderId, venueId: a.venueId, paymentId: a.paymentId, ...a.data })
  // Fire-and-forget FUERA de toda transacción: una falla del audit jamás puede tocar el cobro.
  void prisma.activityLog
    .create({
      data: {
        action: a.action,
        entity: 'Order',
        entityId: a.orderId,
        staffId: a.staffId,
        venueId: a.venueId,
        data: { paymentId: a.paymentId, mensaje: MENSAJE[a.action], ...a.data },
      },
    })
    .catch(err => {
      logger.error('🚨 [Rappi efectivo] No se pudo escribir el ActivityLog del aviso', {
        orderId: a.orderId,
        error: err instanceof Error ? err.message : err,
      })
    })
}
