/**
 * Mobile Refund Service
 *
 * Unassociated refund management for iOS/Android POS apps.
 * Creates a refund Payment + VenueTransaction + optional cash drawer event.
 */

import prisma from '../../utils/prismaClient'
import { BadRequestError } from '../../errors/AppError'
import { logAction } from '../dashboard/activity-log.service'
import { postCashRefundToDrawer } from '../shared/cashDrawerPosting'
import { turnoAbiertoDelNegocio } from '../shared/turnoDeCaja'
import { Decimal } from '@prisma/client/runtime/library'

// ============================================================================
// CREATE UNASSOCIATED REFUND
// ============================================================================

interface CreateRefundParams {
  venueId: string
  amount: number // cents (positive)
  reason: string
  /**
   * Cómo se devolvió el dinero DE VERDAD.
   *
   * `CASH` sale del cajón. Cualquier otro (CREDIT_CARD, DEBIT_CARD…) significa
   * que la devolución la hizo la TERMINAL con su propia función —no hay API
   * para eso— y aquí sólo se registra para que la venta deje de contar como
   * cobrada. Ese caso NO toca el cajón.
   */
  method: string
  staffId: string
  staffName?: string
}

/**
 * Create an unassociated refund (not linked to a specific original transaction).
 *
 * Flow:
 * 1. Create a refund order placeholder (status COMPLETED, paymentStatus REFUNDED)
 * 2. Create a Payment record with negative amount, status COMPLETED + type REFUND
 *    (convención canónica: así lo ven el cierre de turno, el de caja y el reporte
 *    de reembolsos — ver el comentario largo en el paso 2)
 * 3. Create a VenueTransaction with type REFUND
 * 4. If there's an open CashDrawerSession, create a PAY_OUT event
 * 5. Return the refund details
 */
export async function createRefund(params: CreateRefundParams) {
  const { venueId, amount, reason, method, staffId, staffName } = params

  if (!amount || amount <= 0) {
    throw new BadRequestError('El monto debe ser mayor a 0')
  }

  if (!reason || !reason.trim()) {
    throw new BadRequestError('El motivo del reembolso es requerido')
  }

  const amountDecimal = centsToDecimal(amount) // positive (e.g., 50.00)
  const negativeAmount = new Decimal((-Number(amountDecimal)).toFixed(2)) // negative (e.g., -50.00)

  // Steps 1-3 + decremento del turno en UNA transacción: un reembolso a medias
  // (Payment sin VenueTransaction, o turno sin decrementar) descuadra dinero.
  const orderNumber = `REF-${Date.now()}`
  const { order, payment } = await prisma.$transaction(async tx => {
    // 🔴 El turno abierto del NEGOCIO (`../shared/turnoDeCaja.ts`), resuelto IGUAL que el
    // refund del TPV (`refund.tpv.service.ts`) y que el cobro (`order.mobile.service.ts`).
    // Sin `shiftId` el Payment REFUND era invisible para el CIERRE DE TURNO, que
    // selecciona por `{ shiftId, status: 'COMPLETED' }` (`shift.tpv.service.ts:1342`).
    //
    // Se resuelve y se RECLAMA DENTRO de la transacción (audit 2026-08-13): leerlo
    // afuera dejaba una ventana en la que el turno cerraba en medio y el refund se
    // estampaba en un turno YA CERRADO — con el decremento llegando después del
    // reporte. El updateMany condicional (status OPEN) es el candado: si el turno
    // cerró entre la lectura y el claim, count=0 y el refund entra SIN turno (lo
    // recoge el cierre de caja por ventana de tiempo), nunca en uno cerrado.
    let shiftId: string | null = null
    const currentShift = await turnoAbiertoDelNegocio(tx, venueId)
    if (currentShift) {
      // El claim ES el decremento (espejo del refund TPV): el cierre usa también
      // los contadores denormalizados; sin esto el reporte sobrestima ventas.
      // 🔴 `venueId` en el `where` no es decorativo: por id solo, el claim aceptaba el turno de
      // OTRO negocio. El riel de la TPV (`refund.tpv.service.ts`), del que éste se copió, ya lo
      // llevaba — este quedó más laxo que su hermano. Los tres rieles usan ahora el mismo claim.
      const claimed = await tx.shift.updateMany({
        where: { id: currentShift.id, venueId, status: 'OPEN', endTime: null },
        data: { totalSales: { decrement: amountDecimal } },
      })
      if (claimed.count === 1) {
        shiftId = currentShift.id
      }
    }

    // Step 1: Create a refund placeholder order
    const order = await tx.order.create({
      data: {
        venueId,
        // 🔴 La orden testigo cae en el MISMO turno que su `Payment` de abajo: se reusa el
        // `shiftId` ya RECLAMADO arriba, nunca una segunda consulta. Si el claim falló (el
        // turno cerró en medio), las dos quedan sin turno — juntas, que es lo que importa:
        // una orden en un turno y su reembolso en otro descuadra el corte.
        // ⚠️ Consecuencia declarada: el testigo cuenta como una orden más del turno en
        // `getActiveShifts`. Se acepta a cambio de que Order y Payment nunca divergan.
        shiftId,
        orderNumber,
        type: 'TAKEOUT',
        source: 'AVOQADO_IOS',
        subtotal: negativeAmount,
        taxAmount: new Decimal('0.00'),
        total: negativeAmount,
        status: 'COMPLETED',
        paymentStatus: 'REFUNDED',
        createdById: staffId,
      },
    })

    // Step 2: Create Payment record
    const payment = await tx.payment.create({
      data: {
        venueId,
        orderId: order.id,
        shiftId: shiftId ?? undefined,
        processedById: staffId,
        amount: negativeAmount,
        tipAmount: new Decimal('0.00'),
        // Antes: `(method === 'CASH' ? 'CASH' : 'CASH')`, o sea SIEMPRE efectivo.
        // Una devolución hecha en la terminal quedaba registrada como salida de
        // efectivo, así que el arqueo perdía un dinero que nunca salió del cajón y
        // no había forma de saber por dónde se devolvió.
        method: method as any,
        source: 'POS',
        // 🔴 Convención CANÓNICA de reembolso: monto negativo + COMPLETED + REFUND, igual
        // que el TPV (`refund.tpv.service.ts:276`) y el dashboard (`refund.dashboard.service.ts:403`).
        //
        // Antes se guardaba `status: 'REFUNDED'` + `type: 'REGULAR'`, y eso lo volvía
        // INVISIBLE para el cierre de turno y el cierre de caja, que consultan
        // `status: 'COMPLETED'` (`shift.tpv.service.ts:1342`, `cashCloseout.dashboard.service.ts:74`).
        // El dinero SÍ salía del cajón —abajo se crea el PAY_OUT— pero el efectivo esperado
        // no bajaba: el conteo acusaba un FALTANTE del tamaño del reembolso, o sea que le
        // echaba la culpa al cajero. Con `type: REGULAR` tampoco salía en el reporte de
        // reembolsos, que exige `type: 'REFUND'` (`refunds.dashboard.service.ts:87`).
        //
        // La ORDEN sigue marcándose `paymentStatus: 'REFUNDED'` (arriba) — es otro campo y
        // `areaTicketV7.mobile.service.ts:2038` depende de él.
        status: 'COMPLETED',
        type: 'REFUND',
        feePercentage: new Decimal('0.0000'),
        feeAmount: new Decimal('0.00'),
        netAmount: negativeAmount,
        // Paridad con el refund del TPV: el decremento del turno se aplica
        // inline abajo; el marker evita que `scripts/backfill-refund-shift-totals.ts`
        // lo aplique dos veces.
        processorData: {
          refundReason: reason,
          shiftBackfilled: true,
        },
      },
    })

    // Step 3: Create VenueTransaction
    await tx.venueTransaction.create({
      data: {
        venueId,
        paymentId: payment.id,
        type: 'REFUND',
        grossAmount: negativeAmount,
        feeAmount: new Decimal('0.00'),
        netAmount: negativeAmount,
      },
    })

    return { order, payment }
  })

  // Step 4: el reembolso en efectivo sale del cajón.
  //
  // 🔴 Migrado al helper compartido (2026-08-16). Antes esto vivía aquí con un
  // `if (method === 'CASH')` donde `method` venía del CUERPO que manda el cliente:
  // un cliente que lo omitiera saltaba el movimiento EN SILENCIO (comprobado con
  // curl), y un vale que cuenta como efectivo físico se quedaba fuera del arqueo.
  // Ahora la pregunta la contesta `tenderSemantics`, igual que el enganche de ventas.
  //
  // La razón de fondo para compartir el código: la OTRA ruta de reembolso —la que la
  // app usa de verdad, `refund.dashboard.service`— no restaba nada, y el cajón
  // inventaba un sobrante del tamaño de lo devuelto. Con las dos entrando por el
  // mismo helper hay UN solo lugar que sabe restar, y no puede volver a separarse.
  //
  // El comportamiento visible NO cambia: mismo PAY_OUT, mismo monto, misma nota. Lo
  // que se gana es la llave de idempotencia derivada del id del reembolso.
  await postCashRefundToDrawer({
    venueId,
    refundPaymentId: payment.id,
    method,
    amount: amountDecimal,
    staffId,
    staffName: staffName || 'Staff',
    orderId: order.id,
    reason,
  })

  logAction({
    staffId,
    venueId,
    action: 'REFUND_CREATED',
    entity: 'Payment',
    entityId: payment.id,
    data: {
      amount: Number(amountDecimal),
      reason,
      method,
      orderNumber,
      source: 'MOBILE',
    },
  })

  return {
    refundId: payment.id,
    orderId: order.id,
    orderNumber,
    amount, // cents
    reason,
    method,
    createdAt: payment.createdAt.toISOString(),
  }
}

// ============================================================================
// HELPERS
// ============================================================================

function centsToDecimal(cents: number): Decimal {
  return new Decimal((cents / 100).toFixed(2))
}
