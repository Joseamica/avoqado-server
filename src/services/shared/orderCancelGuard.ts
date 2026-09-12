import type { Prisma } from '@prisma/client'

import logger from '../../config/logger'
import { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
import { lockExistingOrderForPayment } from './paymentShiftClaim'

/**
 * Diseño §C.6 (11-sep): TODA ruta que cancela o anula una orden tiene que hacerlo bajo el MISMO candado de `Order` que
 * toman la admisión de un cobro de terminal (`terminal-payment.service`, advisory de terminal → `Order FOR UPDATE`) y el
 * registro del dinero (`payment.tpv.service`, `Order → Payment → Shift`). Fuera de ese candado, una admisión o un pago
 * pueden colarse entre «leí que no hay cobro» y «cancelé», y la orden termina CANCELLED con un cobro vivo encima o ya
 * pagada. Antes sólo `cancelOrder` móvil (T22) lo hacía; este módulo es esa regla escrita UNA vez.
 *
 * Reglas de uso:
 *  - Se llama AL INICIO de la transacción del llamador, antes de tocar `OrderItem`, `OrderServiceCharge` u `Order`
 *    (así el orden de candados queda `Order → renglones`, el mismo del registro de un pago por producto).
 *  - Nunca tomar aquí el advisory de terminal: invertiría el orden `advisory → Order` de la admisión.
 *  - Nunca llamar dentro de la transacción a funciones que abren SU PROPIA transacción sobre la misma orden
 *    (`onOrderCancelled`, `revertReferralRewardForOrder`, `syncAutomaticServiceCharges`): esperarían su propio candado
 *    hasta el P2028. Los efectos van después del commit.
 */

export const ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE = 'ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE' as const

const MENSAJE_COBRO_VIVO =
  'Hay un cobro en curso en la terminal para esta orden. Cancela o espera el resultado del cobro antes de cancelar la orden.'

type GuardTx = Pick<Prisma.TransactionClient, '$queryRaw' | 'order' | 'payment' | 'terminalPaymentRequest'>

export interface OrdenBajoCandado {
  id: string
  paymentStatus: string
  status: string
  version: number
  /** Lo cobrado según la orden (importe + propina de los pagos no-reembolso), releído bajo el candado. */
  paidAmount: Prisma.Decimal
  /**
   * La propina ya cobrada, releída bajo el candado: el registro de un cobro la escribe SIN subir `Order.version`, así
   * que un CAS de versión no la ve. Quien recalcule el total debe usar ésta, no la de una prelectura.
   */
  tipAmount: Prisma.Decimal
}

/**
 * Toma el candado de la orden y la relee DENTRO de él. `lockExistingOrderForPayment` es el mismo `SELECT … FOR UPDATE`
 * que usan la admisión y el registro; la relectura (filtrada por venue) es la que decide si la orden existe aquí.
 */
export async function lockAndReadOrderForCancel(
  tx: GuardTx,
  input: { venueId: string; orderId: string },
  notFoundMessage = 'Order not found',
): Promise<OrdenBajoCandado> {
  await lockExistingOrderForPayment(tx, input)
  const order = await tx.order.findUnique({
    where: { id: input.orderId, venueId: input.venueId },
    select: { id: true, paymentStatus: true, status: true, version: true, paidAmount: true, tipAmount: true },
  })
  if (!order) throw new NotFoundError(notFoundMessage)
  return order as OrdenBajoCandado
}

/**
 * La consulta que NO lanza: el cobro de terminal vivo (el más reciente) sobre la orden, o `null`. Para rutas que no
 * pueden rechazar (el borrado de POS-sync es verdad externa) pero sí tienen que avisar. Corre con el `tx` del llamador.
 */
export async function findLiveTerminalCharge(
  tx: GuardTx,
  input: { venueId: string; orderId: string },
): Promise<{ requestId: string } | null> {
  const { terminalPaymentService } = await import('../terminal-payment.service')
  return terminalPaymentService.findChargeBlockingOrderCancel(input.venueId, input.orderId, tx as Prisma.TransactionClient)
}

/**
 * El cobro de terminal cuyo desenlace no está ACREDITADO (ver `UNRESOLVED_FINANCIAL_OUTCOME`, que vive UNA vez en
 * `terminal-payment.service`) y que por eso impide cancelar o anular. Lanza el 409 del contrato
 * (`ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE`, `details.requestId`) que las apps ya conocen; `details` extra es aditivo.
 *
 * Import dinámico: el servicio de terminal arrastra `socketManager`, `terminalRegistry` y `opsAlert`, que no deben
 * cargar en `order.tpv` / `order.dashboard` ni en sus pruebas sólo por esta consulta.
 */
export async function assertNoLiveTerminalCharge(
  tx: GuardTx,
  input: { venueId: string; orderId: string },
  opciones: { mensaje?: string; detallesExtra?: Record<string, unknown> } = {},
): Promise<void> {
  const bloqueador = await findLiveTerminalCharge(tx, input)
  if (bloqueador) {
    throw new ConflictError(opciones.mensaje ?? MENSAJE_COBRO_VIVO, ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE, {
      requestId: bloqueador.requestId,
      ...(opciones.detallesExtra ?? {}),
    })
  }
}

export interface OrderCancelGuardOptions {
  /** Mensaje del 400 cuando la orden ya tiene dinero. Por defecto, los de `cancelOrder` móvil. */
  mensajeConDinero?: string
  /**
   * Además de `paymentStatus`, cuenta los `Payment` COMPLETED que no son reembolso (`type` nulo incluido: es legacy y
   * es dinero). El DELETE del dashboard lo exige por los estados inconsistentes históricos (PENDING con pagos).
   */
  contarPagosRegistrados?: boolean
  notFoundMessage?: string
}

/**
 * Candado de la orden → relectura → 400 si ya tiene dinero (PAID/PARTIAL) → 409 si hay un cobro de terminal vivo.
 * El orden importa: con dinero adentro la respuesta es «reembolsa primero», y no se consulta la terminal.
 * Devuelve la fila releída bajo el candado; la escritura de la cancelación va inmediatamente después, en la misma tx.
 */
export async function assertOrderCancellableUnderLock(
  tx: GuardTx,
  input: { venueId: string; orderId: string },
  opciones: OrderCancelGuardOptions = {},
): Promise<OrdenBajoCandado> {
  const order = await lockAndReadOrderForCancel(tx, input, opciones.notFoundMessage)

  // 🔴 Ninguna orden CON DINERO ENCIMA se cancela — ni PAID ni PARTIAL. Con pagos hechos el camino es reembolsar y
  // después cancelar, igual que en Square.
  if (order.paymentStatus === 'PAID' || order.paymentStatus === 'PARTIAL') {
    throw new BadRequestError(
      opciones.mensajeConDinero ??
        (order.paymentStatus === 'PAID'
          ? 'Cannot cancel a paid order'
          : 'Esta cuenta ya tiene pagos registrados. Reembólsalos antes de cancelarla.'),
    )
  }
  if (opciones.contarPagosRegistrados) {
    const pagos = await tx.payment.count({
      where: {
        orderId: input.orderId,
        venueId: input.venueId,
        status: 'COMPLETED',
        // `type <> 'REFUND'` en SQL descarta los NULL: el OR es lo que hace contar los legacy.
        OR: [{ type: null }, { type: { not: 'REFUND' } }],
      },
    })
    if (pagos > 0) {
      throw new BadRequestError(opciones.mensajeConDinero ?? 'Esta cuenta ya tiene pagos registrados. Reembólsalos antes de cancelarla.')
    }
  }

  await assertNoLiveTerminalCharge(tx, input)
  return order
}

/**
 * El aviso en tiempo real que `cancelOrder` ya emitía (auditoría Fable 11-sep, P3-7): `ORDER_UPDATED` con el estado
 * nuevo, DESPUÉS del commit, para que las pantallas abiertas (POS, TPV, dashboard) no sigan mostrando una cuenta viva
 * que ya se canceló. Import dinámico por la misma razón que el servicio de terminal. Nunca lanza: la cancelación ya
 * quedó firme y un aviso perdido no puede convertirla en un error.
 */
export async function avisarOrdenCancelada(venueId: string, orderId: string, status: 'CANCELLED' | 'DELETED' = 'CANCELLED'): Promise<void> {
  try {
    const [{ socketManager }, { SocketEventType }] = await Promise.all([
      import('../../communication/sockets/managers/socketManager'),
      import('../../communication/sockets/types'),
    ])
    socketManager.getBroadcastingService()?.broadcastToVenue(venueId, SocketEventType.ORDER_UPDATED, { orderId, status })
  } catch (error) {
    logger.warn('[orderCancelGuard] No se pudo avisar ORDER_UPDATED de una orden cancelada', {
      venueId,
      orderId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
