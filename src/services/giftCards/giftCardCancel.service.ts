/**
 * Tarjetas de regalo · reembolsos y cancelación de la venta (Parte B del plan 1a; spec §5.5 y §5.6; índice R2).
 *
 * - `alRegistrarReembolsoEnTx` es el gancho ÚNICO que llaman `issueRefund` (panel, POS y MCP) y `recordRefund` (terminal) DENTRO de
 *   la transacción del reembolso, después de escribir el REFUND y de encolar sus reversas.
 * - `bloquearSobresDelReembolsoEnTx` toma los candados de los sobres ANTES de que el núcleo reclame el turno. Un canje toma
 *   Order → sobres → Shift; un reembolso que tomara Shift → sobres se abrazaría con él (40P01). Jerarquía de un reembolso:
 *   Order → Payment → sobres → Shift.
 * - Una venta de tarjetas SIN pagar se devuelve como cualquier abono; la devolución que deja su dinero en $0 la cancela (r1, fix 1).
 * - La cancelación de la venta (iniciar / liberar) vive aquí también (B2).
 */
import { Prisma, type PrismaClient } from '@prisma/client'
import logger from '@/config/logger'
import { logAction } from '../dashboard/activity-log.service'
import { avisarOrdenCancelada, findLiveTerminalCharge } from '../shared/orderCancelGuard'
import { recordGiftCardAnomaly } from './giftCardAnomaly'
import { GiftCardError } from './giftCardErrors'
import {
  desactivarSobresDeCuentaEnTx,
  desactivarSobresPendientesDeCuentaEnTx,
  lockGiftCardsForUpdate,
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

export interface AlRegistrarReembolsoResultado {
  /**
   * r1 (fix 1): este reembolso dejó en $0 el dinero de una venta de tarjetas SIN pagar y la misma transacción la canceló. El llamador
   * escribe `ORDER_CANCELLED` y avisa a las pantallas DESPUÉS del commit, como `deleteOrder`.
   */
  cuentaCancelada: boolean
}

const SIN_CANCELAR: AlRegistrarReembolsoResultado = Object.freeze({ cuentaCancelada: false })
const CERO = () => new Prisma.Decimal(0)

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
  // r1 (fix 2): aquí sólo se BLOQUEA. Un sobre DEACTIVATED entre los del canje NO se rechaza: quién recibe saldo depende del monto, y
  // eso lo decide `revertirCanjeEnTx` (nota 1) dentro de esta MISMA transacción, que se revierte entera si rechaza. Rechazar aquí
  // por cualquier sobre muerto —aunque ya se le hubiera devuelto todo— atrapaba la parte que le toca a uno vivo del mismo cobro.
  if (isGiftCardTenderKind(original.tenderSystemKind)) ids = await sobresDelCanje(tx, p.venueId, p.originalPaymentId)
  else if (await leerSiEsCuentaDeTarjetas(tx, original.orderId)) {
    // E4 (excepción escrita): la venta PAGADA se comprueba ANTES de cualquier candado de sobre.
    if (!(await ventaPagada(tx, p.venueId, original.orderId))) return
    ids = await sobresDeLaCuenta(tx, original.orderId)
  }
  if (ids.length > 0) await lockGiftCardsForUpdate(tx, ids)
}

export async function alRegistrarReembolsoEnTx(tx: Tx, p: AlRegistrarReembolsoInput): Promise<AlRegistrarReembolsoResultado> {
  const original = p.original ?? (await leerCobroOriginal(tx, p.venueId, p.originalPaymentId))
  if (!original) return SIN_CANCELAR
  if (isGiftCardTenderKind(original.tenderSystemKind)) {
    // Spec §5.5: lo pagado con saldo regresa al saldo; `revertirCanjeEnTx` nunca pasa de lo canjeado y aún reembolsable.
    await revertirCanjeEnTx(tx, {
      venueId: p.venueId,
      originalPaymentId: p.originalPaymentId,
      refundPaymentId: p.refundPaymentId,
      amount: p.amount,
      staffId: p.staffId ?? null,
    })
    return SIN_CANCELAR
  }
  if (!(await leerSiEsCuentaDeTarjetas(tx, original.orderId))) return SIN_CANCELAR
  return devolverVentaDeTarjetasEnTx(tx, p, original.orderId)
}

/**
 * El dinero que la cuenta conserva YA con este reembolso escrito: cobros COMPLETED menos devoluciones COMPLETED, venta Y propina
 * (la propina también es dinero que el negocio guarda). Las devoluciones se guardan negativas (`summarizeRefunds`).
 */
async function dineroConservado(tx: Tx, venueId: string, orderId: string): Promise<Prisma.Decimal> {
  const cobros = await tx.payment.aggregate({
    where: { venueId, orderId, status: 'COMPLETED', OR: [{ type: null }, { type: { not: 'REFUND' } }] },
    _sum: { amount: true, tipAmount: true },
  })
  const devoluciones = await tx.payment.aggregate({
    where: { venueId, orderId, status: 'COMPLETED', type: 'REFUND' },
    _sum: { amount: true, tipAmount: true },
  })
  const total = (s: { amount: Prisma.Decimal | null; tipAmount: Prisma.Decimal | null }) => (s.amount ?? CERO()).plus(s.tipAmount ?? CERO())
  return total(cobros._sum).minus(total(devoluciones._sum).abs())
}

/**
 * r1 (fix 1, ruling del coordinador): devolver un abono de una venta de tarjetas SIN pagar es un camino normal —el cliente se
 * arrepiente a media compra—. Sus sobres siguen PENDING: no valen nada, y F8 impide activarlos si lo conservado no cubre la venta.
 * Así que mientras quede dinero no se lee, bloquea ni desactiva ningún sobre (E4) y la cuenta sigue abierta. Cuando ESTE reembolso
 * deja lo conservado en $0, la misma transacción cancela la cuenta con las piezas de `deleteOrder` (estado con CAS + versión, y
 * `desactivarSobresPendientesDeCuentaEnTx`): si no, quedaría PARTIAL para siempre, porque ningún reembolso escribe `paymentStatus`
 * y la cancelación general rechaza una cuenta PARTIAL o con pagos.
 *
 * Candados: el llamador ya tiene la Order (Order → Payment → Shift). Tomar aquí los sobres PENDING después del turno es la misma
 * excepción escrita de E4 que la activación, y es segura por la misma razón: quien bloquea un sobre PENDING de esta cuenta
 * (activarla, cancelarla) toma ANTES la Order que este reembolso ya tiene, y nadie que tenga un sobre PENDING espera un turno.
 */
async function cerrarVentaSinPagarSiYaNoQuedaDinero(
  tx: Tx,
  p: AlRegistrarReembolsoInput,
  orderId: string,
): Promise<AlRegistrarReembolsoResultado> {
  if ((await dineroConservado(tx, p.venueId, orderId)).greaterThan(0)) return SIN_CANCELAR
  // Un cobro de terminal vivo todavía puede traer dinero: la cancelación general tampoco cancela con uno así. La cuenta sigue y su
  // desenlace decide (si cobra, ese dinero se devuelve como cualquier abono y la cuenta se cierra entonces).
  const vivo = await findLiveTerminalCharge(tx, { venueId: p.venueId, orderId })
  if (vivo) {
    logger.warn('[TARJETAS DE REGALO] Venta sin pagar devuelta completa con un cobro de terminal vivo: la cuenta sigue abierta', {
      venueId: p.venueId,
      orderId,
      refundPaymentId: p.refundPaymentId,
      requestId: vivo.requestId,
    })
    return SIN_CANCELAR
  }
  const cancelada = await tx.order.updateMany({
    where: { id: orderId, venueId: p.venueId, status: { notIn: ['CANCELLED', 'DELETED'] } },
    // La versión sube para que los escritores con CAS (anular, descontar) se enteren de la cancelación (como `deleteOrder`).
    data: { status: 'CANCELLED', version: { increment: 1 } },
  })
  // Spec § 5.1.8: una cuenta de tarjetas que se cancela sin haberse pagado deja sus sobres PENDING en DEACTIVATED. Idempotente.
  await desactivarSobresPendientesDeCuentaEnTx(tx, { venueId: p.venueId, orderId, staffId: p.staffId ?? null })
  return { cuentaCancelada: cancelada.count === 1 }
}

/**
 * DESPUÉS del commit (r1, fix 1): la venta sin pagar que su reembolso dejó en $0 quedó cancelada. Lo mismo que hace `deleteOrder`
 * tras cancelar: bitácora `ORDER_CANCELLED` (fuera de la transacción, sin esperar) y aviso a las pantallas abiertas. Nunca lanza.
 */
export async function avisarVentaDeTarjetasCanceladaPorReembolso(p: {
  venueId: string
  orderId: string
  refundPaymentId: string
  staffId?: string | null
}): Promise<void> {
  void logAction({
    staffId: p.staffId ?? null,
    venueId: p.venueId,
    action: 'ORDER_CANCELLED',
    entity: 'Order',
    entityId: p.orderId,
    data: { status: 'CANCELLED', motivo: 'VENTA_DE_TARJETAS_DEVUELTA', refundPaymentId: p.refundPaymentId },
  })
  await avisarOrdenCancelada(p.venueId, p.orderId, 'CANCELLED')
}

/** R2: devolver dinero de una cuenta de tarjetas PAGADA = cancelarla. Sin pagar: un abono más (r1, fix 1). */
async function devolverVentaDeTarjetasEnTx(tx: Tx, p: AlRegistrarReembolsoInput, orderId: string): Promise<AlRegistrarReembolsoResultado> {
  // E4 (excepción escrita): antes de leer o bloquear un solo sobre, la venta tiene que estar PAGADA. Sin pagar, sus sobres siguen
  // PENDING (no valen nada): la devolución se acepta por cualquier canal y, si deja la cuenta en $0, la cancela.
  if (!(await ventaPagada(tx, p.venueId, orderId))) return cerrarVentaSinPagarSiYaNoQuedaDinero(tx, p, orderId)
  const ids = await sobresDeLaCuenta(tx, orderId)
  const bloqueados = ids.length > 0 ? await lockGiftCardsForUpdate(tx, ids) : []
  const sobres = await tx.giftCard.findMany({ where: { id: { in: ids } }, select: { id: true, status: true }, take: ids.length })
  // Ya cancelada por otro cobro de la misma cuenta (una venta pagada en dos cobros se devuelve en dos reembolsos): nada que desactivar.
  // Nota 2 de B1 (A6): tampoco atrapa el dinero que llegó DESPUÉS a una venta pagada con todo desactivado.
  if (sobres.length > 0 && sobres.every(s => s.status === 'DEACTIVATED')) return SIN_CANCELAR
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
  // r1 (fix 4): la desactivación es de la CUENTA entera aunque la terminal haya devuelto sólo una parte. La anomalía dice si fue
  // parcial (lo devuelto contra lo que vale la venta) y cuánto saldo vivo se apagó, leídos bajo el candado de los sobres.
  const valorDeLaVenta = bloqueados.reduce((suma, c) => suma.plus(c.initialAmount), CERO())
  const saldoDesactivado = bloqueados.filter(c => c.status !== 'DEACTIVATED').reduce((suma, c) => suma.plus(c.balance), CERO())
  await recordGiftCardAnomaly(tx, {
    check: 'REFUND_WITHOUT_CANCEL',
    id: p.refundPaymentId,
    venueId: p.venueId,
    detail: {
      orderId,
      originalPaymentId: p.originalPaymentId,
      canjes,
      monto: p.amount.toString(),
      parcial: p.amount.lessThan(valorDeLaVenta),
      saldoDesactivado: saldoDesactivado.toFixed(2),
    },
  })
  return SIN_CANCELAR
}
