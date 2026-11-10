import type { Prisma } from '@prisma/client'

import logger from '../../config/logger'
import { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
import { lockExistingOrderForPayment } from './paymentShiftClaim'
import { instruccionesParaCancelarRappi } from '../delivery-channels/providers/rappi/rappi.cancellation'
import { esCuentaDeFolioEnTx, findCardOnlineOrderInTx } from '../online-ordering/card/guards'
import { convertirBeneficiosEnCortesiaEnTx, sellarFolioAnuladoEnTx } from '../online-ordering/cortesiaDeFolio'
import type { TxConReintento } from '@/utils/serializableRetry'

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
/** La cancelación además mira (y suelta) la tarjeta apartada de un pedido en línea. */
type CancelGuardTx = GuardTx & Pick<Prisma.TransactionClient, 'onlineOrder' | 'onlineOrderCharge'>

export interface OrdenBajoCandado {
  id: string
  source: string
  posRawData: Prisma.JsonValue | null
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
  /** La mesa de la cuenta, releída bajo el candado (`rechazarCuentaDeMesa`). */
  tableId?: string | null
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
    select: {
      id: true,
      source: true,
      posRawData: true,
      paymentStatus: true,
      status: true,
      version: true,
      paidAmount: true,
      tipAmount: true,
      tableId: true,
    },
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

export const MENSAJE_CUENTA_DE_MESA = 'Esta cuenta es de una mesa: anúlala desde el POS, en la mesa («Anular cuenta»).'

export interface OrderCancelGuardOptions {
  /** Mensaje del 400 cuando la orden ya tiene dinero. Por defecto, los de `cancelOrder` móvil. */
  mensajeConDinero?: string
  /**
   * Además de `paymentStatus`, cuenta los `Payment` COMPLETED que no son reembolso (`type` nulo incluido: es legacy y
   * es dinero). El DELETE del dashboard lo exige por los estados inconsistentes históricos (PENDING con pagos).
   */
  contarPagosRegistrados?: boolean
  notFoundMessage?: string
  /**
   * Una cuenta ya CANCELLED/DELETED responde 409 `ORDER_ALREADY_CANCELLED` en vez de volver a cancelarse (y a auditarse).
   * El panel lo exige: su cliente HTTP reintenta solo los errores de red (Codex plan r1 #6, 30-oct). El POS no lo pide.
   */
  rechazarYaCancelada?: boolean
  /**
   * Una cuenta de mesa responde 400 `ORDER_IS_TABLE`: el panel no cancela mesas (se anulan en el POS). Se revisa BAJO el candado:
   * «Mover» puede ligarle una mesa entre una lectura previa y la cancelación (Codex código r1 #1, 30-oct).
   */
  rechazarCuentaDeMesa?: boolean
}

/** Se llama con la orden releída bajo su candado; sólo el aviso del proveedor puede cancelar un Rappi. */
export function rechazarCancelacionLocalDeRappi(order: { source: string; posRawData: unknown }): void {
  if (order.source === 'RAPPI') throw new BadRequestError(instruccionesParaCancelarRappi(order.posRawData), 'RAPPI_CANCEL_IN_PROVIDER')
}

/**
 * Candado de la orden → relectura → 400 si ya tiene dinero (PAID/PARTIAL) → 409 si hay un cobro de terminal vivo.
 * El orden importa: con dinero adentro la respuesta es «reembolsa primero», y no se consulta la terminal.
 * Devuelve la fila releída bajo el candado; la escritura de la cancelación va inmediatamente después, en la misma tx.
 */
export async function assertOrderCancellableUnderLock(
  tx: CancelGuardTx,
  input: { venueId: string; orderId: string },
  opciones: OrderCancelGuardOptions = {},
): Promise<OrdenBajoCandado> {
  const order = await lockAndReadOrderForCancel(tx, input, opciones.notFoundMessage)
  rechazarCancelacionLocalDeRappi(order)
  if (opciones.rechazarYaCancelada && (order.status === 'CANCELLED' || order.status === 'DELETED')) {
    throw new ConflictError('Esta cuenta ya estaba cancelada.', 'ORDER_ALREADY_CANCELLED')
  }
  if (opciones.rechazarCuentaDeMesa && order.tableId) {
    throw new BadRequestError(MENSAJE_CUENTA_DE_MESA, 'ORDER_IS_TABLE')
  }

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

  // Pedidos en línea fase 2 (Codex r1 #1): mientras el banco cobra la tarjeta, nadie cancela; con la tarjeta apartada, la
  // cancelación la suelta en esta MISMA transacción (`RELEASING`) y el conciliador la libera con Stripe.
  const card = await findCardOnlineOrderInTx(tx, input)
  if (card?.charge?.status === 'CAPTURING') {
    throw new ConflictError('Confirmando el pago con tarjeta de este pedido. Intenta en unos segundos.', 'ONLINE_ORDER_CONFIRMING_PAYMENT')
  }
  if (card?.charge?.status === 'AUTHORIZED') {
    await tx.onlineOrderCharge.updateMany({ where: { id: card.charge.id, status: 'AUTHORIZED' }, data: { status: 'RELEASING' } })
  }
  return order
}

/** Lo que una anulación le devolvió al cliente. */
export interface CanjesDevueltos {
  pointsRefunded: number
  stampRewardsReturned: string[]
  /**
   * Filas de canje que salieron de la venta (también las que ya no tenían qué devolver). En una cuenta de folio (S9) son las que se
   * convirtieron en cortesía: no salen, pero la venta sí tenía beneficios (la limpieza de abandonadas la anula en vez de borrarla).
   */
  filasQuitadas: number
  /** S9: las clientas con premio regresado en una cuenta de folio; quien anula despierta su pase después del commit. */
  clientasConPremio: string[]
}

/** Página de canjes: una venta real trae uno o dos; se recorre hasta agotarlos (Codex r2 #3: no hay tope por venta). */
const PAGINA_DE_CANJES = 100

/**
 * 🔴 LEALTAD (pizarrón hz:a8104ac8:D1, 31-oct). Una venta que se anula SIN cobrar le devuelve al cliente lo que canjeó en ella
 * —su premio de sellos y sus puntos— haciendo con cada canje EXACTAMENTE lo que hace «quitar el descuento»
 * (`removeOrderDiscountInTransaction`): devuelve, revierte el renglón, devuelve el impuesto, BORRA la fila y recalcula. Antes la
 * venta quedaba CANCELLED con el premio REDEEMED y los puntos gastados, sin salida desde el mostrador.
 *
 * Borrar la fila no es un detalle (Codex r1): con el premio de vuelta y su descuento todavía en la venta, el cliente se quedaba
 * con los dos si después alguien quitaba el descuento (segunda devolución), si se reintentaba la creación o si un cobro tardío
 * revivía la venta (`reabrirSiRecibeDinero`). Sin la fila, la venta revivida se calcula sin ese descuento y muestra el saldo.
 * Idempotente por la misma razón: una segunda llamada ya no encuentra la fila.
 *
 * Va dentro de la transacción del que anula, con la orden YA bloqueada (Order → Customer/StampReward, el orden de siempre).
 * Los descuentos que no son canje se quedan como historia de la venta anulada.
 *
 * 🔴 Tienda híbrida (S9, P2-5): en una cuenta de FOLIO (toda cuenta con `OnlineOrder`) no se borra nada: los beneficios regresan y su
 * fila se queda como cortesía (`convertirBeneficiosEnCortesiaEnTx`), así la cuenta conserva el precio que vio la clienta si después
 * llega dinero. `soloSiEsFolio`: en otra cuenta no hace nada (el camino de «Regresar el saldo y cancelar», que hoy no devuelve canjes).
 */
export async function devolverCanjesDeVentaAnuladaEnTx(
  tx: TxConReintento,
  input: { venueId: string; orderId: string; staffId?: string | null; camino: string; soloSiEsFolio?: true },
): Promise<CanjesDevueltos> {
  const devuelto: CanjesDevueltos = { pointsRefunded: 0, stampRewardsReturned: [], filasQuitadas: 0, clientasConPremio: [] }
  if (await esCuentaDeFolioEnTx(tx, input)) {
    // S9 (v5, B1): el sello va ANTES de convertir y también sin beneficios: es lo que dice después «este folio se anuló».
    await sellarFolioAnuladoEnTx(tx, input)
    const r = await convertirBeneficiosEnCortesiaEnTx(tx, input)
    return { pointsRefunded: r.puntos, stampRewardsReturned: r.premios, filasQuitadas: r.filas, clientasConPremio: r.clientasConPremio }
  }
  if (input.soloSiEsFolio) return devuelto
  const quitadas: string[] = []
  // Cada fila procesada se BORRA, así que cada página trae las que siguen; se repite hasta que no quede ninguna.
  for (;;) {
    // Canje = puntos (`loyaltyTransactionId`) o premio de sellos (`StampReward.orderDiscountId`, columna sin relación de Prisma).
    const canjes = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT od.id FROM "OrderDiscount" od
      WHERE od."orderId" = ${input.orderId}
        AND (od."loyaltyTransactionId" IS NOT NULL
             OR EXISTS (SELECT 1 FROM "StampReward" sr WHERE sr."orderDiscountId" = od.id AND sr."venueId" = ${input.venueId}))
      ORDER BY od.id
      LIMIT ${PAGINA_DE_CANJES}`
    if (canjes.length === 0) break
    // Import dinámico: order.mobile.service importa este módulo.
    const { removeOrderDiscountInTransaction } = await import('../mobile/order.mobile.service')
    for (const fila of canjes) {
      const r = await removeOrderDiscountInTransaction(tx, input.venueId, input.orderId, fila.id, input.staffId ?? undefined, {
        porAnulacion: true,
      })
      devuelto.pointsRefunded += r.refund?.pointsRefunded ?? 0
      if (r.stampRefund) devuelto.stampRewardsReturned.push(r.stampRefund.rewardId)
      quitadas.push(fila.id)
    }
    if (canjes.length < PAGINA_DE_CANJES) break
  }
  devuelto.filasQuitadas = quitadas.length
  if (quitadas.length === 0) return devuelto
  // La bitácora va en la MISMA transacción (como `reabrirSiRecibeDinero`): si la anulación se revierte, también su rastro.
  await tx.activityLog.create({
    data: {
      action: 'ORDER_CANCEL_LOYALTY_RETURNED',
      entity: 'Order',
      entityId: input.orderId,
      venueId: input.venueId,
      staffId: input.staffId ?? null,
      data: { camino: input.camino, orderDiscountIds: quitadas, ...devuelto },
    },
  })
  logger.info('🎁 [Anular] la venta anulada le devolvió al cliente sus canjes', { ...input, ...devuelto })
  return devuelto
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
