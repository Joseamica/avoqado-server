/**
 * Tarjetas de regalo · reembolsos y cancelación de la venta (Parte B del plan 1a; spec §5.5 y §5.6; índice R2).
 *
 * - `alRegistrarReembolsoEnTx` es el gancho ÚNICO que llaman `issueRefund` (panel, POS y MCP) y `recordRefund` (terminal) DENTRO de
 *   la transacción del reembolso, después de escribir el REFUND y de encolar sus reversas.
 * - `bloquearSobresDelReembolsoEnTx` toma los candados de los sobres ANTES de que el núcleo reclame el turno. Un canje toma
 *   Order → sobres → Shift; un reembolso que tomara Shift → sobres se abrazaría con él (40P01). Jerarquía de un reembolso:
 *   Order → Payment → sobres → Shift.
 * - La cancelación de la venta (iniciar / liberar) vive aquí también (B2).
 */
import { Prisma, type PrismaClient } from '@prisma/client'
import { recordGiftCardAnomaly } from './giftCardAnomaly'
import { GiftCardError } from './giftCardErrors'
import {
  desactivarSobresDeCuentaEnTx,
  lockGiftCardsForUpdate,
  rechazarSiRegresaASobreDesactivado,
  revertirCanjeEnTx,
} from './giftCardLedger'
import { leerSiEsCuentaDeTarjetas } from './giftCardMarks'
import { isGiftCardTenderKind } from './giftCardTender'

type Tx = Prisma.TransactionClient
/** Lecturas que también corren fuera de una transacción (el detalle del dashboard, C4). */
type Db = Prisma.TransactionClient | PrismaClient

/**
 * Tope de LECTURA de los sobres que toca un reembolso (enmienda E3: no es el tope de venta `MAX_SOBRES_POR_CUENTA` = 20 de
 * `giftCardLimits.ts`): la suma de una operación es menor a $70,000 y cada sobre vale al menos $100.
 */
export const TOPE_LECTURA_SOBRES_DEL_REEMBOLSO = 700

export const MENSAJE_SALDO_SOLO_A_SALDO =
  'Lo pagado con tarjeta de regalo sólo regresa al saldo de la tarjeta; no se devuelve en efectivo ni por transferencia.'

/** Lo que el llamador ya leyó del cobro original bajo su candado. */
export interface CobroOriginalDeTarjetas {
  orderId: string
  tenderSystemKind: string | null
}

export interface AlRegistrarReembolsoInput {
  venueId: string
  originalPaymentId: string
  refundPaymentId: string
  /** Lo devuelto (venta + propina), en pesos. */
  amount: Prisma.Decimal
  staffId?: string | null
  /**
   * `true` SÓLO en `recordRefund`: cuando la terminal registra, el SDK YA devolvió el dinero. Rechazar ahí dejaría el reembolso real
   * sin asiento y el sobre vivo: se desactiva y queda una anomalía para revisar.
   */
  dineroYaDevuelto?: boolean
  /** Si el llamador ya lo leyó bajo su candado, no se vuelve a leer. */
  original?: CobroOriginalDeTarjetas
}

async function leerCobroOriginal(tx: Tx, venueId: string, paymentId: string): Promise<CobroOriginalDeTarjetas | null> {
  const fila = await tx.payment.findFirst({
    where: { id: paymentId, venueId },
    select: { orderId: true, tenderType: { select: { systemKind: true } } },
  })
  return fila ? { orderId: fila.orderId, tenderSystemKind: fila.tenderType?.systemKind ?? null } : null
}

/** Los sobres de una cuenta de tarjetas, en orden estable y con tope. */
export async function sobresDeLaCuenta(tx: Db, orderId: string): Promise<string[]> {
  const renglones = await tx.orderItem.findMany({
    where: { orderId, giftCardId: { not: null } },
    select: { giftCardId: true },
    orderBy: { id: 'asc' },
    take: TOPE_LECTURA_SOBRES_DEL_REEMBOLSO + 1,
  })
  if (renglones.length > TOPE_LECTURA_SOBRES_DEL_REEMBOLSO) {
    throw new Error(`La cuenta ${orderId} tiene más de ${TOPE_LECTURA_SOBRES_DEL_REEMBOLSO} sobres: no se puede revisar completa.`)
  }
  return renglones.map(r => r.giftCardId).filter((id): id is string => !!id)
}

/** Los sobres que tocó un cobro con saldo (sus `REDEEM`). */
async function sobresDelCanje(tx: Tx, venueId: string, paymentId: string): Promise<string[]> {
  const canjes = await tx.giftCardActivity.findMany({
    where: { venueId, paymentId, type: 'REDEEM' },
    select: { giftCardId: true },
    orderBy: { id: 'asc' },
    take: TOPE_LECTURA_SOBRES_DEL_REEMBOLSO,
  })
  return [...new Set(canjes.map(c => c.giftCardId))]
}

/**
 * Excepción escrita a E4 (índice): la activación toma los sobres PENDING de la cuenta que se está pagando DESPUÉS del turno.
 * Por eso, antes de tocar CUALQUIER sobre de una venta de tarjetas, el reembolso comprueba que la venta esté PAGADA: una
 * venta pagada ya no tiene activación en curso (la hizo el cobro que la saldó), así que un reembolso nunca espera sobres
 * que una activación tiene tomados. Sin pagar ⇒ ningún candado de sobre.
 */
async function ventaPagada(tx: Tx, venueId: string, orderId: string): Promise<boolean> {
  const orden = await tx.order.findFirst({ where: { id: orderId, venueId }, select: { paymentStatus: true } })
  return orden?.paymentStatus === 'PAID'
}

export async function bloquearSobresDelReembolsoEnTx(
  tx: Tx,
  p: { venueId: string; originalPaymentId: string; original?: CobroOriginalDeTarjetas },
): Promise<void> {
  // El cobro original tiene que existir (el llamador lo leyó bajo su candado, o se lee aquí); si no, nada que bloquear.
  const original = p.original ?? (await leerCobroOriginal(tx, p.venueId, p.originalPaymentId))
  if (!original) return
  let ids: string[] = []
  if (isGiftCardTenderKind(original.tenderSystemKind)) {
    const delCanje = await sobresDelCanje(tx, p.venueId, p.originalPaymentId)
    if (delCanje.length === 0) return
    // Nota 1 de B1 (ruling 7 de A8): con el sobre ya bloqueado, uno DEACTIVATED se rechaza AQUÍ, antes de que el núcleo reclame
    // el turno y escriba el REFUND; así nada se escribe. `revertirCanjeEnTx` repite la guardia para quien lo llame sin esto.
    await rechazarSiRegresaASobreDesactivado(tx, p.venueId, await lockGiftCardsForUpdate(tx, delCanje))
    return
  } else if (await leerSiEsCuentaDeTarjetas(tx, original.orderId)) {
    // E4 (excepción escrita): la venta PAGADA se comprueba ANTES de cualquier candado de sobre.
    if (!(await ventaPagada(tx, p.venueId, original.orderId))) return
    ids = await sobresDeLaCuenta(tx, original.orderId)
  }
  if (ids.length > 0) await lockGiftCardsForUpdate(tx, ids)
}

export async function alRegistrarReembolsoEnTx(tx: Tx, p: AlRegistrarReembolsoInput): Promise<void> {
  const original = p.original ?? (await leerCobroOriginal(tx, p.venueId, p.originalPaymentId))
  if (!original) return
  if (isGiftCardTenderKind(original.tenderSystemKind)) {
    // Spec §5.5: lo pagado con saldo regresa al saldo; `revertirCanjeEnTx` nunca pasa de lo canjeado y aún reembolsable.
    await revertirCanjeEnTx(tx, {
      venueId: p.venueId,
      originalPaymentId: p.originalPaymentId,
      refundPaymentId: p.refundPaymentId,
      amount: p.amount,
      staffId: p.staffId ?? null,
    })
    return
  }
  if (!(await leerSiEsCuentaDeTarjetas(tx, original.orderId))) return
  await devolverVentaDeTarjetasEnTx(tx, p, original.orderId)
}

/** R2: devolver dinero de una cuenta de tarjetas = cancelarla. */
async function devolverVentaDeTarjetasEnTx(tx: Tx, p: AlRegistrarReembolsoInput, orderId: string): Promise<void> {
  // E4 (excepción escrita): antes de leer o bloquear un solo sobre, la venta tiene que estar PAGADA. Sin pagar, sus sobres
  // siguen PENDING (no valen nada) y no se tocan: el panel rechaza; la terminal, que YA devolvió el dinero (E1), registra
  // y deja la anomalía para que una persona lo revise.
  if (!(await ventaPagada(tx, p.venueId, orderId))) {
    if (!p.dineroYaDevuelto) {
      throw new GiftCardError(
        'GIFT_CARD_CANCEL_NOT_STARTED',
        'Esta venta de tarjetas todavía no está pagada: cancela la cuenta desde el POS.',
        409,
      )
    }
    await recordGiftCardAnomaly(tx, {
      check: 'REFUND_WITHOUT_CANCEL',
      id: p.refundPaymentId,
      venueId: p.venueId,
      detail: { orderId, originalPaymentId: p.originalPaymentId, ventaPagada: false, monto: p.amount.toString() },
    })
    return
  }
  const ids = await sobresDeLaCuenta(tx, orderId)
  if (ids.length > 0) await lockGiftCardsForUpdate(tx, ids)
  const sobres = await tx.giftCard.findMany({ where: { id: { in: ids } }, select: { id: true, status: true }, take: ids.length })
  // Ya cancelada por otro cobro de la misma cuenta (una venta pagada en dos cobros se devuelve en dos reembolsos): nada que desactivar.
  if (sobres.length > 0 && sobres.every(s => s.status === 'DEACTIVATED')) return
  const canjes = await tx.giftCardActivity.count({ where: { giftCardId: { in: ids }, type: 'REDEEM' } })
  if (!p.dineroYaDevuelto) {
    if (canjes > 0) {
      throw new GiftCardError('GIFT_CARD_ALREADY_USED', 'Una de las tarjetas de esta venta ya se usó: la venta no se puede devolver.', 409)
    }
    throw new GiftCardError(
      'GIFT_CARD_CANCEL_NOT_STARTED',
      'Para devolver la venta de una tarjeta de regalo primero inicia su cancelación en Tarjetas de regalo › Cancelar venta.',
      409,
    )
  }
  // La terminal YA devolvió el dinero (enmienda E1): el sobre no puede seguir vivo. `dineroYaDevuelto` le dice a la libreta (A4) que
  // no valide R2 —sin cancelación iniciada o con un sobre ya usado— y desactive cada sobre vivo con lo que le quedaba. Queda la
  // anomalía para que una persona lo revise.
  await desactivarSobresDeCuentaEnTx(tx, {
    venueId: p.venueId,
    orderId,
    refundPaymentId: p.refundPaymentId,
    reason: 'SALE_CANCELLED',
    staffId: p.staffId ?? null,
    dineroYaDevuelto: true,
  })
  await recordGiftCardAnomaly(tx, {
    check: 'REFUND_WITHOUT_CANCEL',
    id: p.refundPaymentId,
    venueId: p.venueId,
    detail: { orderId, originalPaymentId: p.originalPaymentId, canjes, monto: p.amount.toString() },
  })
}
