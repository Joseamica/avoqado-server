/**
 * Tienda híbrida, S9 (P2-5): si un folio no se paga, lo que la clienta usó en él regresa al instante, y la cuenta conserva el precio
 * que ella vio. Al anular la cuenta de un folio (vencer, cancelar, rechazar, «Regresar el saldo y cancelar», anular o borrar desde el
 * panel), cada beneficio que se le puede devolver —sus puntos, su premio de sellos, su cupón y un descuento del catálogo con límite de
 * usos— vuelve a ella, y su fila se queda en la cuenta como cortesía del mismo importe, IVA y reparto, congelada como importe fijo y
 * SIN enlaces (`discountId`, `couponCodeId`, `loyaltyTransactionId`; el premio, sin su `orderDiscountId`). Sin enlaces ningún contador
 * la vuelve a mirar: si después llega dinero que ya se había cobrado, la cuenta lo salda con la aritmética de hoy y nada se gasta dos
 * veces. «Cuenta de folio» = toda cuenta con `OnlineOrder` (decisión 14 del plan); las demás anulaciones siguen borrando sus canjes.
 */
import { Prisma } from '@prisma/client'

import logger from '@/config/logger'
import type { TxConReintento } from '@/utils/serializableRetry'

export const MOTIVO_BENEFICIO_REGRESADO = 'Beneficio regresado a la clienta al anular el folio'

/**
 * S9 (rediseño v5, A0/B1): la marca durable de «este folio se anuló alguna vez». Un folio «Nadie» cuya CUENTA se anula sin cerrar el
 * pedido (el panel, el POS, «Regresar el saldo y cancelar») no tiene fecha de cierre: se le pone `cancelledAt`. Los cierres
 * (`expiredAt`, `cancelledAt`, `rejectedAt` del CAS) ya la traen y el `where` no los toca. Bajo el candado de la orden de quien anula
 * (o de quien reabre: la conciliación cubre lo anulado antes del despliegue). Nadie borra esas fechas ni decide el estado con ellas.
 */
export async function sellarFolioAnuladoEnTx(tx: Pick<Prisma.TransactionClient, 'onlineOrder'>, a: { venueId: string; orderId: string }) {
  await tx.onlineOrder.updateMany({
    where: { orderId: a.orderId, venueId: a.venueId, requiresAcceptance: false, expiredAt: null, cancelledAt: null, rejectedAt: null },
    data: { cancelledAt: new Date() },
  })
}

export interface BeneficiosRegresados {
  /** Filas convertidas en cortesía. */
  filas: number
  /** Σ del importe de esas filas: lo que la clienta tenía de beneficio en el folio. */
  montoRegresado: Prisma.Decimal
  puntos: number
  /** Ids de los `StampReward` que regresaron. */
  premios: string[]
  /** Las clientas con premio regresado: quien anula despierta su pase de Wallet después del commit. */
  clientasConPremio: string[]
}

/** Página de lectura: una venta real trae uno o dos beneficios; se lee hasta agotarlas (como `devolverCanjesDeVentaAnuladaEnTx`). */
const PAGINA = 100

interface FilaDevolvible {
  id: string
  amount: Prisma.Decimal
  discountId: string | null
  couponCodeId: string | null
  loyaltyTransactionId: string | null
  /** El premio de sellos canjeado en esta fila (`StampReward.orderDiscountId`, columna sin relación de Prisma). */
  premioId: string | null
  /** El contador de usos del descuento del catálogo se baja sólo si tiene tope total y no es cupón (el cupón cuenta al pagar). */
  bajaUso: boolean
}

/**
 * Corre con la orden YA bloqueada, dentro de la transacción de quien anula (abierta con `withDeadlockRetry`); no abre otra. Lee primero
 * TODAS las filas que se pueden devolver y las procesa por tipo, en el orden de la tabla «Orden de candados de la parte 2» (prevención):
 * (1) `Discount` en UNA pasada ascendente (`bloquearDescuentosEnOrdenEnTx`) con `currentUses − 1` de los que tienen `maxTotalUses`;
 * (2) premios por id ascendente (`refundStampRewardForOrderDiscount`, deja su fila en la bandeja de Wallet); (3) puntos
 * (`refundLoyaltyForOrderDiscount`, con la cuenta ya tomada); (4) la conversión de las filas. Las demás filas (descuentos sin límite,
 * de grupo, cortesías a mano) se quedan como historia. No escribe ni bloquea `WalletPass`. Idempotente: una fila convertida ya no
 * tiene enlaces y la siguiente llamada no la encuentra.
 */
export async function convertirBeneficiosEnCortesiaEnTx(
  tx: TxConReintento,
  input: { venueId: string; orderId: string; staffId?: string | null; camino: string },
): Promise<BeneficiosRegresados> {
  const { venueId, orderId } = input
  const filas: FilaDevolvible[] = []
  for (let despues: string | null = null; ; ) {
    const pagina: Array<{
      id: string
      amount: Prisma.Decimal
      discountId: string | null
      couponCodeId: string | null
      loyaltyTransactionId: string | null
      discount: { maxTotalUses: number | null; maxUsesPerCustomer: number | null } | null
    }> = await tx.orderDiscount.findMany({
      where: { orderId, order: { venueId }, ...(despues ? { id: { gt: despues } } : {}) },
      select: {
        id: true,
        amount: true,
        discountId: true,
        couponCodeId: true,
        loyaltyTransactionId: true,
        discount: { select: { maxTotalUses: true, maxUsesPerCustomer: true } },
      },
      orderBy: { id: 'asc' },
      take: PAGINA,
    })
    if (pagina.length === 0) break
    const premios = await tx.stampReward.findMany({
      where: { venueId, orderDiscountId: { in: pagina.map(f => f.id) } },
      select: { id: true, orderDiscountId: true },
      take: pagina.length,
    })
    const premioDe = new Map(premios.map(p => [p.orderDiscountId, p.id]))
    for (const f of pagina) {
      const premioId = premioDe.get(f.id) ?? null
      const conLimite = f.discount?.maxTotalUses != null || f.discount?.maxUsesPerCustomer != null
      if (!f.loyaltyTransactionId && !f.couponCodeId && !premioId && !(f.discountId && conLimite)) continue
      filas.push({
        id: f.id,
        amount: new Prisma.Decimal(f.amount),
        discountId: f.discountId,
        couponCodeId: f.couponCodeId,
        loyaltyTransactionId: f.loyaltyTransactionId,
        premioId,
        bajaUso: !!f.discountId && !f.couponCodeId && f.discount?.maxTotalUses != null,
      })
    }
    if (pagina.length < PAGINA) break
    despues = pagina[pagina.length - 1].id
  }
  const regresado: BeneficiosRegresados = {
    filas: 0,
    montoRegresado: new Prisma.Decimal(0),
    puntos: 0,
    premios: [],
    clientasConPremio: [],
  }
  if (filas.length === 0) return regresado

  // Import dinámico: estos módulos importan `orderCancelGuard`, que importa éste.
  const [{ bloquearDescuentosEnOrdenEnTx }, { refundStampRewardForOrderDiscount }, { refundLoyaltyForOrderDiscount }] = await Promise.all([
    import('@/services/dashboard/discountEngine.service'),
    import('@/services/wallet/redeemStampReward.service'),
    import('@/services/mobile/loyalty.mobile.service'),
  ])

  // (1) Los usos del catálogo: cada fila de un descuento con tope total le había sumado un uso al aplicarse.
  const usos = new Map<string, number>()
  for (const f of filas) if (f.bajaUso) usos.set(f.discountId!, (usos.get(f.discountId!) ?? 0) + 1)
  if (usos.size > 0) {
    for (const d of await bloquearDescuentosEnOrdenEnTx(tx, venueId, usos.keys())) {
      await tx.discount.update({ where: { id: d.id }, data: { currentUses: Math.max(0, d.currentUses - (usos.get(d.id) ?? 0)) } })
    }
  }

  // (2) Premios, por id ascendente del PREMIO (no de la fila).
  const clientas = new Set<string>()
  for (const f of filas.filter(x => x.premioId).sort((a, b) => (a.premioId! < b.premioId! ? -1 : 1))) {
    const premio = await refundStampRewardForOrderDiscount(tx, venueId, { id: f.id })
    if (!premio) continue
    regresado.premios.push(premio.rewardId)
    clientas.add(premio.customerId)
  }

  // (3) Puntos. `refundLoyaltyForOrderDiscount` no desliga la fila: la desliga (4), y por eso no se devuelven dos veces.
  for (const f of filas) {
    if (!f.loyaltyTransactionId) continue
    const puntos = await refundLoyaltyForOrderDiscount(tx, venueId, f, input.staffId ?? undefined)
    regresado.puntos += puntos?.pointsRefunded ?? 0
  }

  // (4) La cortesía: mismo importe, IVA (`taxReduction`) y reparto (no se tocan); importe fijo y sin enlaces.
  for (const f of filas) {
    await tx.orderDiscount.update({
      where: { id: f.id },
      data: {
        isComp: true,
        compReason: MOTIVO_BENEFICIO_REGRESADO,
        type: 'FIXED_AMOUNT',
        value: f.amount,
        discountId: null,
        couponCodeId: null,
        loyaltyTransactionId: null,
      },
    })
    regresado.montoRegresado = regresado.montoRegresado.plus(f.amount)
  }
  regresado.filas = filas.length
  regresado.clientasConPremio = [...clientas]

  // En la MISMA transacción: si la anulación se revierte, también su rastro.
  await tx.activityLog.create({
    data: {
      action: 'ONLINE_ORDER_BENEFITS_RETURNED',
      entity: 'Order',
      entityId: orderId,
      venueId,
      staffId: input.staffId ?? null,
      data: {
        camino: input.camino,
        orderDiscountIds: filas.map(f => f.id),
        montoRegresado: regresado.montoRegresado.toFixed(2),
        puntos: regresado.puntos,
        premios: regresado.premios,
      },
    },
  })
  logger.info('🎁 [Folio anulado] sus beneficios regresaron a la clienta y su fila quedó como cortesía', {
    venueId,
    orderId,
    camino: input.camino,
    filas: regresado.filas,
    montoRegresado: regresado.montoRegresado.toFixed(2),
  })
  return regresado
}

/**
 * Después del commit: despierta al enviador de Wallet por cada clienta con premio regresado. Si no se llama (o falla), el barrido lo
 * manda: la fila de la bandeja ya quedó en la transacción. Nunca lanza ni espera.
 */
export function despertarPasesTrasCommit(venueId: string, clientas: readonly string[] | undefined): void {
  if (!clientas?.length) return
  void import('@/services/wallet/notifyPassUpdated.service')
    .then(({ notifyCustomerPassUpdated }) => Promise.all(clientas.map(c => notifyCustomerPassUpdated(venueId, c))))
    .catch(error =>
      logger.warn('[Folio anulado] no se pudo despertar el pase de Wallet; lo manda el barrido', {
        venueId,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
}
