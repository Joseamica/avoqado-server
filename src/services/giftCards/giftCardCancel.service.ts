/**
 * Tarjetas de regalo · reembolsos y cancelación de la venta (Parte B del plan 1a; spec §5.5 y §5.6; índice R2).
 *
 * - `alRegistrarReembolsoEnTx` es el gancho ÚNICO que llaman `issueRefund` (panel, POS y MCP) y `recordRefund` (terminal) DENTRO de
 *   la transacción del reembolso, después de escribir el REFUND y de encolar sus reversas.
 * - `bloquearSobresDelReembolsoEnTx` toma los candados de los sobres ANTES de que el núcleo reclame el turno. Un canje toma
 *   Order → sobres → Shift; un reembolso que tomara Shift → sobres se abrazaría con él (40P01). Jerarquía de un reembolso:
 *   Order → Payment → sobres → Shift.
 * - Una venta de tarjetas SIN pagar se devuelve como cualquier abono; la devolución que deja su dinero en $0 la cancela (r1, fix 1).
 * - La cancelación de la venta (iniciar / liberar) vive aquí también (B2): `iniciarCancelacionDeVenta` bloquea TODOS los sobres
 *   con `CANCEL_IN_PROGRESS` antes del reembolso real; el gancho de arriba los desactiva cuando ese reembolso se registra; y
 *   `liberarCancelacionDeVenta` los desbloquea sólo si el gerente comprobó que la devolución NO se hizo (r1 F6).
 */
import { createHash } from 'crypto'
import { GiftCardReason, Prisma, type GiftCardStatus, type PrismaClient } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'
import logger from '@/config/logger'
import { BadRequestError } from '@/errors/AppError'
import { DEFAULT_TIMEZONE } from '@/utils/datetime'
import prisma from '@/utils/prismaClient'
import { logAction } from '../dashboard/activity-log.service'
import { avisarOrdenCancelada, findLiveTerminalCharge } from '../shared/orderCancelGuard'
import { ORDER_LOCK_WAIT_BUDGET, lockExistingOrderForPayment } from '../shared/paymentShiftClaim'
import { recordGiftCardAnomaly } from './giftCardAnomaly'
import { GiftCardError } from './giftCardErrors'
import {
  desactivarSobresDeCuentaEnTx,
  desactivarSobresPendientesDeCuentaEnTx,
  lockGiftCardsForUpdate,
  operarSobreDeGerenteEnTx,
  revertirCanjeEnTx,
  type OperacionDeGerente,
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

/** «En tienda, sólo el mismo día del cobro» (R2), en la zona del venue: nunca con la fecha del servidor. */
export function mismoDiaDelVenue(a: Date, b: Date, timezone: string): boolean {
  return formatInTimeZone(a, timezone, 'yyyy-MM-dd') === formatInTimeZone(b, timezone, 'yyyy-MM-dd')
}

/**
 * La libreta deduplica por `[venueId, operationKey]` (un renglón por llave). El gerente manda UNA llave por diálogo; cada sobre de la
 * cuenta recibe la suya derivada, así un reintento con la misma llave encuentra todos sus renglones y no escribe nada nuevo.
 */
export function claveDeSobre(operationKey: string, giftCardId: string): string {
  const clave = `${operationKey}:${giftCardId}`
  // La libreta (A4) acepta llaves de 8 a 128 y la ruta deja llegar hasta 128 (C3): una llave larga se resume con su sha256
  // (64 + 1 + id ≤ 128). Determinista, así el reintento con la misma llave encuentra los mismos renglones.
  return clave.length <= 128 ? clave : `${createHash('sha256').update(operationKey).digest('hex')}:${giftCardId}`
}

/** El bloqueo VIGENTE de un sobre: el de su último BLOCK/UNBLOCK, si fue BLOCK. */
export interface BloqueoVigente {
  reason: GiftCardReason | null
  note: string | null
  at: Date
}

/**
 * El bloqueo VIGENTE de cada sobre: su último BLOCK/UNBLOCK (una consulta, índice `[giftCardId, createdAt]`). Sólo trae entrada el
 * sobre cuyo último movimiento de bloqueo es BLOCK. r1 D-2: el detalle del dashboard (C4, `currentBlock`) lee de aquí el motivo
 * vigente; nunca de la primera página de la libreta, que tras varios ajustes ya no lo trae. Es la misma regla con la que la libreta
 * (A4, `desactivarSobresDeCuentaEnTx`) decide si una cancelación está iniciada.
 */
export async function bloqueosVigentes(db: Db, ids: string[]): Promise<Map<string, BloqueoVigente>> {
  if (ids.length === 0) return new Map()
  const filas = await db.$queryRaw<
    Array<{ giftCardId: string; type: string; reason: GiftCardReason | null; note: string | null; createdAt: Date }>
  >(Prisma.sql`
    SELECT DISTINCT ON (a."giftCardId") a."giftCardId" AS "giftCardId", a.type::text AS type, a.reason::text AS reason,
           a.note AS note, a."createdAt" AS "createdAt"
    FROM "GiftCardActivity" a
    WHERE a."giftCardId" IN (${Prisma.join(ids)})
      AND a.type IN ('BLOCK', 'UNBLOCK')
    ORDER BY a."giftCardId", a."createdAt" DESC, a.id DESC`)
  return new Map(filas.filter(f => f.type === 'BLOCK').map(f => [f.giftCardId, { reason: f.reason, note: f.note, at: f.createdAt }]))
}

/** El motivo del bloqueo VIGENTE de cada sobre. `null` = no está bloqueado por la libreta. Misma lectura que `bloqueosVigentes`. */
async function motivosDeBloqueoVigentes(db: Db, ids: string[]): Promise<Map<string, GiftCardReason | null>> {
  const vigentes = await bloqueosVigentes(db, ids)
  return new Map(ids.map(id => [id, vigentes.get(id)?.reason ?? null]))
}

/** Todos los sobres BLOCKED y su bloqueo vigente es `CANCEL_IN_PROGRESS` (R2: la cancelación de la venta está iniciada). */
function todosEnCancelacion(sobres: Array<{ id: string; status: GiftCardStatus }>, motivos: Map<string, GiftCardReason | null>): boolean {
  return sobres.length > 0 && sobres.every(s => s.status === 'BLOCKED' && motivos.get(s.id) === GiftCardReason.CANCEL_IN_PROGRESS)
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
 * arrepiente a media compra—. r2: también una PAGADA con todos sus sobres PENDING (F8 negó la activación), que es lo mismo. Sus sobres siguen PENDING: no valen nada, y F8 impide activarlos si lo conservado no cubre la venta.
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
  // Un cobro de terminal vivo todavía puede traer dinero: la cancelación general tampoco cancela con uno así, y la cuenta sigue.
  // Si ese cobro ENTRA, la cuenta queda PAGADA (`computeOrderBalance` no resta las devoluciones) y F8 niega la activación: queda
  // PAGADA con todos sus sobres PENDING. Su salida es devolver ese dinero desde el panel: la rama «pagada con todo PENDING» de
  // `devolverVentaDeTarjetasEnTx` la trata como una venta sin pagar y la cierra aquí al llegar a $0 (B1 r2). Si el cobro FALLA,
  // la cuenta queda abierta en $0 con sus sobres PENDING (no hay dinero atrapado).
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
  // B1 r2 (fix 1): PAGADA pero con TODOS sus sobres PENDING y ningún canje = F8 negó la activación (se devolvió dinero antes de
  // completarla, o entró tarde un cobro de terminal que estaba vivo al llegar a $0). Esos sobres nunca se pudieron usar y valen $0,
  // así que la cuenta se trata EXACTAMENTE como una sin pagar: se devuelve sin tocar sobres y, en $0, se cierra. Sin esto el dinero
  // quedaba atrapado: aquí abajo `GIFT_CARD_CANCEL_NOT_STARTED`, «Cancelar venta» de B2 rechaza sobres PENDING y la cancelación
  // general rechaza una cuenta PAGADA. Cualquier otra venta pagada (un sobre vivo, bloqueado o desactivado) sigue el flujo de B2.
  if (canjes === 0 && sobres.length > 0 && sobres.every(s => s.status === 'PENDING')) {
    return cerrarVentaSinPagarSiYaNoQuedaDinero(tx, p, orderId)
  }
  // B2 (R2): la cancelación se inició —TODOS sus sobres BLOCKED y su bloqueo vigente es CANCEL_IN_PROGRESS— y nunca se usó ⇒ este
  // reembolso cancela la venta: un DEACTIVATE por sobre, ligado a él, sin anomalía (por cualquier canal: es el camino previsto). El
  // motivo vigente se lee bajo el candado de los sobres que ya tomó esta tx; sólo se consulta si todos están BLOCKED. Con un canje
  // que se coló, o un sobre bloqueado por otro motivo, sigue abajo (ALREADY_USED / CANCEL_NOT_STARTED / E1 de la terminal).
  if (canjes === 0 && sobres.length > 0 && sobres.every(s => s.status === 'BLOCKED')) {
    if (todosEnCancelacion(sobres, await motivosDeBloqueoVigentes(tx, ids))) {
      await desactivarSobresDeCuentaEnTx(tx, {
        venueId: p.venueId,
        orderId,
        refundPaymentId: p.refundPaymentId,
        reason: 'SALE_CANCELLED',
        staffId: p.staffId ?? null,
        // r1 M6: como E1. Desde la terminal el dinero YA salió: la libreta no debe poder rechazar aquí y dejarlo fuera sin asiento.
        // Desde el panel (false) la libreta vuelve a validar R2 bajo su candado y, si rechaza, el reembolso entero se deshace.
        dineroYaDevuelto: p.dineroYaDevuelto === true,
      })
      return SIN_CANCELAR
    }
  }
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

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// B2 · «Cancelar venta» (spec §5.6; índice R2 y Review Focus 5)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const NO_ES_VENTA_DE_TARJETAS = 'No encontramos esa venta de tarjetas de regalo en este negocio.'
const noEsVentaDeTarjetas = () => new GiftCardError('GIFT_CARD_NOT_FOUND', NO_ES_VENTA_DE_TARJETAS, 404)

/**
 * El BLOQUEAR que escribe «Cancelar venta» en cada sobre. Una sola función para el inicio y para comprobar un reintento (r1 B-7):
 * la libreta (A4) compara la huella de ESTE contenido (sobre, tipo, motivo, nota) con la del renglón que ya ocupa la llave.
 */
function bloqueoDeCancelacion(orderNumber: string | null): OperacionDeGerente {
  return {
    tipo: 'BLOQUEAR',
    reason: GiftCardReason.CANCEL_IN_PROGRESS,
    note: orderNumber ? `Cancelación de la venta ${orderNumber}` : 'Cancelación de la venta',
  }
}

/** El DESBLOQUEAR de «liberar»: contenido fijo, así el reintento con la misma llave tiene la misma huella. */
const DESBLOQUEO_DE_CANCELACION: OperacionDeGerente = {
  tipo: 'DESBLOQUEAR',
  reason: GiftCardReason.CANCEL_IN_PROGRESS,
  note: 'Se liberó la cancelación: el reembolso no se hizo.',
}

/**
 * Abre la cuenta bajo su candado y comprueba que es de tarjetas; después toma los candados de TODOS sus sobres y devuelve sus ids.
 * Jerarquía fija: Order (la de la VENTA) → sobres, como el reembolso (Order → Payment → sobres → Shift) y el canje (Order de la
 * mercancía → sobres → Shift): nadie que tenga un sobre espera esta Order, así que nunca se cruzan. Nota 3 (A4 menor 2): se REUSA
 * `lockGiftCardsForUpdate`, el mismo helper (y el mismo orden) que el canje y el reembolso; un orden propio aquí (p. ej. por id)
 * sí podría cruzarse con el de ellos.
 */
async function abrirVentaDeTarjetasEnTx(tx: Tx, venueId: string, orderId: string): Promise<string[]> {
  if (!(await lockExistingOrderForPayment(tx, { venueId, orderId }))) throw noEsVentaDeTarjetas()
  if (!(await leerSiEsCuentaDeTarjetas(tx, orderId))) throw noEsVentaDeTarjetas()
  const ids = await sobresDeLaCuenta(tx, orderId)
  if (ids.length === 0) throw noEsVentaDeTarjetas()
  await lockGiftCardsForUpdate(tx, ids)
  return ids
}

/**
 * Nota 4 (r1 B-7): las llaves derivadas de ESTA operación (`claveDeSobre(operationKey, sobre)`) que ya tienen renglón en la libreta.
 * Que la llave exista NO basta: las llaves públicas admiten `:` y otra operación —incluso sobre OTRO sobre— pudo ocupar
 * `<operationKey>:<giftCardId>`. Cada llave ocupada se valida con la libreta (A4) sobre el sobre de ESTA venta al que corresponde, que
 * compara la huella del contenido BAJO su candado: el mismo contenido ⇒ `replay` (no escribe nada); otro ⇒ 409
 * IDEMPOTENCY_KEY_REUSED y la transacción entera se deshace. Los sobres ya están tomados (`abrirVentaDeTarjetasEnTx`): pedirlos otra
 * vez no espera. Devuelve los sobres cuya operación ya estaba registrada.
 */
async function sobresYaOperadosConLaLlaveEnTx(
  tx: Tx,
  p: { venueId: string; staffId: string; operationKey: string; ids: string[]; op: OperacionDeGerente },
): Promise<Set<string>> {
  const claves = p.ids.map(id => claveDeSobre(p.operationKey, id))
  const previas = await tx.giftCardActivity.findMany({
    where: { venueId: p.venueId, operationKey: { in: claves } },
    select: { operationKey: true },
    take: claves.length,
  })
  const ocupadas = new Set(previas.map(a => a.operationKey))
  const repetidos = new Set<string>()
  for (const id of p.ids) {
    const operationKey = claveDeSobre(p.operationKey, id)
    if (!ocupadas.has(operationKey)) continue
    await operarSobreDeGerenteEnTx(tx, { venueId: p.venueId, giftCardId: id, staffId: p.staffId, operationKey, op: p.op })
    repetidos.add(id)
  }
  return repetidos
}

/** Por qué hoy no se puede cancelar una venta de tarjetas (lo que pinta el detalle del dashboard, C4). */
export type MotivoSinCancelarVenta = 'NOT_PAID' | 'NOT_SAME_DAY' | 'ALREADY_USED' | 'ALREADY_CANCELLED' | 'IN_PROGRESS'

/**
 * Decisión 1 del coordinador: `cancel` del detalle de una tarjeta. `reason: null` con `allowed: false` = sin venta (no es de este
 * negocio o no es de tarjetas), o un sobre de la venta bloqueado por OTRO motivo (iniciar respondería 409 `GIFT_CARD_BLOCKED`).
 */
export interface CancelacionDeVenta {
  allowed: boolean
  reason: MotivoSinCancelarVenta | null
  /**
   * C4 (nota 2 del coordinador): el texto del rechazo que lanzaría `iniciarCancelacionDeVenta` (el mismo `GiftCardError`), para que el
   * panel diga cuál de los tres `NOT_PAID` es. `null` si se puede o si ya está en curso, y en `SIN_VENTA` (no es cuenta de tarjetas).
   */
  message: string | null
}

interface EvaluacionDeCancelacion extends Omit<CancelacionDeVenta, 'message'> {
  /** El rechazo que lanza `iniciarCancelacionDeVenta`; `null` si se puede o si ya está en curso. */
  error: GiftCardError | null
  orderNumber: string | null
  sobres: Array<{ id: string; status: GiftCardStatus }>
}

/**
 * La ÚNICA regla de «¿se puede cancelar esta venta de tarjetas?» (R2, spec §5.6). La usan `iniciarCancelacionDeVenta` (bajo el
 * candado de la cuenta y de sus sobres, y lanza `error`) y el detalle del dashboard (`estadoDeCancelacionDeVenta`, sin candados, sólo
 * para pintar el botón). Orden:
 *  1. Ya cancelada (algún sobre DEACTIVATED) va antes que «sin pagar» y que «otro día»: es lo que de verdad le pasa a la venta, y el
 *     gerente no tiene nada más que hacer (una venta sin pagar que se canceló también cae aquí).
 *  2. Sin pagar ⇒ NOT_PAID: se cancela la cuenta desde el POS (o se devuelve el abono, B1).
 *  3. En curso va antes que el día: una cancelación iniciada ayer se LIBERA (o se devuelve) aunque ya no se pueda iniciar otra.
 *  4. PAGADA con un sobre PENDING ⇒ NOT_PAID (nota 2), también antes que el día (r1 M1): F8 negó la activación. Con TODOS
 *     PENDING su salida NO es «Cancelar venta» sino devolver el cobro desde el panel, que el gancho de B1 trata como una venta sin
 *     pagar y cierra en $0 (B1 r2), sin importar el día; mandarlo a «sólo el mismo día» lo alejaba de esa salida. Con una mezcla
 *     (algún sobre ya activo) no hay salida automática y el texto no promete ninguna (r1 M2).
 *  5. Mismo día del cobro (zona del venue) · 6. ningún REDEEM.
 *  7. Un sobre bloqueado por OTRO motivo ⇒ `reason: null` + GIFT_CARD_BLOCKED (primero se desbloquea).
 */
async function evaluarCancelacionDeVenta(
  db: Db,
  p: { venueId: string; orderId: string; ids: string[]; timezone: string; ahora: Date },
): Promise<EvaluacionDeCancelacion> {
  const orden = await db.order.findFirst({
    where: { id: p.orderId, venueId: p.venueId },
    select: { paymentStatus: true, orderNumber: true },
  })
  const orderNumber = orden?.orderNumber ?? null
  const sobres = await db.giftCard.findMany({
    where: { id: { in: p.ids }, venueId: p.venueId },
    select: { id: true, status: true },
    orderBy: { id: 'asc' },
    take: p.ids.length,
  })
  const no = (reason: MotivoSinCancelarVenta | null, error: GiftCardError): EvaluacionDeCancelacion => ({
    allowed: false,
    reason,
    error,
    orderNumber,
    sobres,
  })
  if (!orden || sobres.length === 0) return no(null, noEsVentaDeTarjetas())
  if (sobres.some(s => s.status === 'DEACTIVATED')) {
    return no('ALREADY_CANCELLED', new GiftCardError('GIFT_CARD_SALE_ALREADY_CANCELLED', 'Esta venta de tarjetas ya se canceló.', 409))
  }
  if (orden.paymentStatus !== 'PAID') {
    return no(
      'NOT_PAID',
      new GiftCardError('GIFT_CARD_SALE_NOT_PAID', 'Esta venta de tarjetas todavía no está pagada: cancela la cuenta desde el POS.', 409),
    )
  }
  const motivos = await motivosDeBloqueoVigentes(db, p.ids)
  if (todosEnCancelacion(sobres, motivos)) return { allowed: false, reason: 'IN_PROGRESS', error: null, orderNumber, sobres }
  if (sobres.some(s => s.status === 'PENDING')) {
    // r1 M2: «reembolsa el cobro, se cancela sola» sólo es verdad con TODOS los sobres PENDING (el gancho de B1 usa `every`). Una
    // mezcla con un sobre ya activo no tiene esa salida: texto neutro, sin prometer ninguna.
    const todosPendientes = sobres.every(s => s.status === 'PENDING')
    return no(
      'NOT_PAID',
      new GiftCardError(
        'GIFT_CARD_SALE_NOT_PAID',
        todosPendientes
          ? 'Las tarjetas de esta venta no se activaron: no hace falta cancelarla. Para devolver el dinero, reembolsa el cobro; al quedar en $0 la venta se cancela sola.'
          : 'Una de las tarjetas de esta venta todavía no se activa, así que la venta no se puede cancelar desde aquí. Repórtalo a soporte para revisarla.',
        409,
      ),
    )
  }
  const cobro = await db.payment.findFirst({
    where: { venueId: p.venueId, orderId: p.orderId, status: 'COMPLETED', OR: [{ type: null }, { type: { not: 'REFUND' } }] },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { createdAt: true },
  })
  if (!cobro || !mismoDiaDelVenue(cobro.createdAt, p.ahora, p.timezone)) {
    return no(
      'NOT_SAME_DAY',
      new GiftCardError(
        'GIFT_CARD_CANCEL_WINDOW_CLOSED',
        'La venta de una tarjeta de regalo sólo se cancela en tienda el mismo día en que se cobró.',
        409,
      ),
    )
  }
  const canjes = await db.giftCardActivity.count({ where: { giftCardId: { in: p.ids }, type: 'REDEEM' } })
  if (canjes > 0) {
    return no(
      'ALREADY_USED',
      new GiftCardError('GIFT_CARD_ALREADY_USED', 'Una de las tarjetas de esta venta ya se usó: la venta no se puede cancelar.', 409),
    )
  }
  if (sobres.some(s => s.status === 'BLOCKED' && motivos.get(s.id) !== GiftCardReason.CANCEL_IN_PROGRESS)) {
    return no(
      null,
      new GiftCardError(
        'GIFT_CARD_BLOCKED',
        'Una de las tarjetas de esta venta está bloqueada por otro motivo; desbloquéala antes de cancelar la venta.',
        409,
      ),
    )
  }
  return { allowed: true, reason: null, error: null, orderNumber, sobres }
}

export const SIN_VENTA: CancelacionDeVenta = Object.freeze({ allowed: false, reason: null, message: null })

/**
 * Para el detalle de una tarjeta en el dashboard (C4): ¿se puede cancelar SU venta, y si no, por qué? Sin candados (sólo pinta el
 * botón; `iniciarCancelacionDeVenta` vuelve a evaluar bajo candado). Mismas reglas: `evaluarCancelacionDeVenta`.
 */
export async function estadoDeCancelacionDeVenta(venueId: string, orderId: string, ahora: Date = new Date()): Promise<CancelacionDeVenta> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  if (!venue) return SIN_VENTA
  if (!(await leerSiEsCuentaDeTarjetas(prisma, orderId))) return SIN_VENTA
  const ids = await sobresDeLaCuenta(prisma, orderId)
  if (ids.length === 0) return SIN_VENTA
  const e = await evaluarCancelacionDeVenta(prisma, { venueId, orderId, ids, timezone: venue.timezone || DEFAULT_TIMEZONE, ahora })
  return { allowed: e.allowed, reason: e.reason, message: e.error?.message ?? null }
}

/**
 * Paso 1 de cancelar la venta (spec §5.6): bloquea TODOS sus sobres con `CANCEL_IN_PROGRESS` ANTES de pedir el reembolso real, así
 * nadie puede gastarlos mientras se devuelve el dinero. Bajo el candado: mismo día del cobro (zona del venue) y ningún `REDEEM`.
 * Idempotente por `operationKey` (una llave derivada por sobre, `claveDeSobre`): el reintento con la misma llave no escribe nada
 * y devuelve lo mismo mientras esa cancelación siga en curso o haya terminado con la devolución; si ya se liberó ⇒ 409
 * GIFT_CARD_CANCEL_NOT_STARTED (r1 M3: una cancelación nueva lleva llave nueva); si otra operación ya ocupa una de esas llaves ⇒
 * 409 IDEMPOTENCY_KEY_REUSED. La bitácora
 * `GIFT_CARD_SALE_CANCEL_STARTED` sólo se escribe si esta llamada bloqueó algo (F9: lo decide la libreta bajo candado).
 */
export async function iniciarCancelacionDeVenta(
  venueId: string,
  orderId: string,
  p: { staffId: string; operationKey: string },
): Promise<{ giftCardIds: string[] }> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  if (!venue) throw noEsVentaDeTarjetas()
  const timezone = venue.timezone || DEFAULT_TIMEZONE

  const r = await prisma.$transaction(async tx => {
    const ids = await abrirVentaDeTarjetasEnTx(tx, venueId, orderId)
    const orden = await tx.order.findFirst({ where: { id: orderId, venueId }, select: { orderNumber: true } })
    const op = bloqueoDeCancelacion(orden?.orderNumber ?? null)
    // Reintento de la MISMA operación (el dashboard reintenta, `api.ts`): la libreta lo reconoce por su huella y no escribe.
    const repetidos = await sobresYaOperadosConLaLlaveEnTx(tx, { venueId, staffId: p.staffId, operationKey: p.operationKey, ids, op })
    if (repetidos.size === ids.length) {
      // r1 M3: el reintento COMPLETO responde según el estado de HOY, bajo el candado de los sobres. Si esa cancelación sigue en
      // curso, o ya terminó con la devolución (todos DEACTIVATED), es la misma respuesta. Si se liberó después (los sobres volvieron
      // a ACTIVE, o cambiaron por otra cosa), responder «iniciada» le mentiría al panel con las tarjetas gastables: 409. Para
      // cancelar otra vez el panel acuña una llave NUEVA por intento (D4); la misma llave sólo sirve para reintentar ese intento.
      const hoy = await tx.giftCard.findMany({ where: { id: { in: ids }, venueId }, select: { id: true, status: true }, take: ids.length })
      const sigue =
        hoy.length > 0 && (hoy.every(s => s.status === 'DEACTIVATED') || todosEnCancelacion(hoy, await motivosDeBloqueoVigentes(tx, ids)))
      if (!sigue) {
        throw new GiftCardError(
          'GIFT_CARD_CANCEL_NOT_STARTED',
          'Esta cancelación ya se liberó y las tarjetas volvieron a estar disponibles. Si quieres cancelar la venta, inicia una nueva cancelación.',
          409,
        )
      }
      return { giftCardIds: ids, nueva: false }
    }

    // La MISMA regla que pinta el botón del detalle (C4): `evaluarCancelacionDeVenta` (decisión 1 del coordinador).
    const e = await evaluarCancelacionDeVenta(tx, { venueId, orderId, ids, timezone, ahora: new Date() })
    if (e.error) throw e.error
    // Ya en cancelación (otra persona la inició con otra llave): se respeta tal cual y no se escribe nada.
    if (e.reason === 'IN_PROGRESS') return { giftCardIds: ids, nueva: false }
    let nueva = false
    for (const s of e.sobres) {
      // Sólo los ACTIVE: los que ya están BLOCKED aquí son de esta misma cancelación (la regla rechaza cualquier otro motivo).
      if (s.status !== 'ACTIVE' || repetidos.has(s.id)) continue
      const hecho = await operarSobreDeGerenteEnTx(tx, {
        venueId,
        giftCardId: s.id,
        staffId: p.staffId,
        operationKey: claveDeSobre(p.operationKey, s.id),
        op,
      })
      if (!hecho.replay) nueva = true
    }
    return { giftCardIds: ids, nueva }
  }, ORDER_LOCK_WAIT_BUDGET)

  if (r.nueva) {
    void logAction({
      staffId: p.staffId,
      venueId,
      action: 'GIFT_CARD_SALE_CANCEL_STARTED',
      entity: 'Order',
      entityId: orderId,
      data: { giftCardIds: r.giftCardIds },
    })
  }
  return { giftCardIds: r.giftCardIds }
}

/**
 * El gerente COMPROBÓ que el reembolso real NO se hizo (la terminal lo rechazó de forma definitiva, o el cliente cambió de opinión
 * antes de devolverle nada): los sobres vuelven a ACTIVE con `UNBLOCK`. r1 F6: un timeout de la terminal NO prueba que el dinero no
 * salió (la devolución puede registrarse después), así que liberar exige `confirmacionNoDevuelto: true` —la casilla del panel—, y
 * sin ella responde 400 ANTES de abrir la transacción; lo incierto se queda bloqueado y B7 avisa a las 24 h (`CANCEL_STUCK`). Nada
 * libera solo. Una venta ya devuelta no se libera (GIFT_CARD_SALE_ALREADY_CANCELLED). Idempotente por `operationKey` como iniciar:
 * el reintento no escribe otro UNBLOCK; otra operación con esa llave ⇒ IDEMPOTENCY_KEY_REUSED.
 */
export async function liberarCancelacionDeVenta(
  venueId: string,
  orderId: string,
  p: { staffId: string; operationKey: string; confirmacionNoDevuelto: true },
): Promise<void> {
  if (p?.confirmacionNoDevuelto !== true) {
    throw new BadRequestError(
      'Para liberar confirma que comprobaste que la devolución NO se hizo. Si no lo sabes, la tarjeta se queda bloqueada.',
    )
  }
  const liberadas = await prisma.$transaction(async tx => {
    const ids = await abrirVentaDeTarjetasEnTx(tx, venueId, orderId)
    const repetidos = await sobresYaOperadosConLaLlaveEnTx(tx, {
      venueId,
      staffId: p.staffId,
      operationKey: p.operationKey,
      ids,
      op: DESBLOQUEO_DE_CANCELACION,
    })
    if (repetidos.size === ids.length) return []
    const filas = await tx.giftCard.findMany({ where: { id: { in: ids }, venueId }, select: { id: true, status: true }, take: ids.length })
    const estado = new Map(filas.map(s => [s.id, s.status]))
    if (filas.some(s => s.status === 'DEACTIVATED')) {
      throw new GiftCardError(
        'GIFT_CARD_SALE_ALREADY_CANCELLED',
        'Esta venta ya se canceló y su dinero ya se devolvió: no hay nada que liberar.',
        409,
      )
    }
    const motivos = await motivosDeBloqueoVigentes(tx, ids)
    const hechas: string[] = []
    for (const id of ids) {
      if (repetidos.has(id) || estado.get(id) !== 'BLOCKED' || motivos.get(id) !== GiftCardReason.CANCEL_IN_PROGRESS) continue
      const hecho = await operarSobreDeGerenteEnTx(tx, {
        venueId,
        giftCardId: id,
        staffId: p.staffId,
        operationKey: claveDeSobre(p.operationKey, id),
        op: DESBLOQUEO_DE_CANCELACION,
      })
      if (!hecho.replay) hechas.push(id)
    }
    return hechas
  }, ORDER_LOCK_WAIT_BUDGET)

  if (liberadas.length > 0) {
    void logAction({
      staffId: p.staffId,
      venueId,
      action: 'GIFT_CARD_SALE_CANCEL_RELEASED',
      entity: 'Order',
      entityId: orderId,
      data: { giftCardIds: liberadas },
    })
  }
}
