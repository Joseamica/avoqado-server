import { AreaTicketCheckoutStatus, Prisma } from '@prisma/client'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import type { TxConReintento } from '@/utils/serializableRetry'
import {
  claseDeEstado,
  computeOrderBalance,
  esVentaCerrada,
  FULL_PAYMENT_TOLERANCE,
  PAGO_PARA_SALDO_SELECT,
  saldoDeCobroDeReparto,
  type CompletedPaymentForBalance,
  type OrderAmountsForBalance,
} from './orderBalance'

/**
 * D19 · un abono devuelto vuelve a deberse (founder 10-nov «A»; construido en la nube el 12-nov).
 *
 * ── El problema ─────────────────────────────────────────────────────────────
 * Una cuenta de $100 con un abono de $50 que se devolvía seguía diciendo «falta $50», y cobrar esos $50 la cerraba PAGADA con
 * $50 netos: el reembolso nunca reabría nada (regla del 18-ago, pensada para la venta ya cobrada y entregada).
 *
 * ── Por qué se decide AQUÍ y una sola vez ───────────────────────────────────
 * La primera versión (10-nov) reconstruía después «¿la cuenta todavía debía cuando se reembolsó?» con el total y los pagos de
 * HOY, y Codex la tumbó (`docs/audit/2026-11-10-d19-abono-devuelto/codex-r1.md`): una cortesía posterior, reasignar un cobro o
 * un pago cripto confirmado tarde cambiaban el pasado. Ahora quien ESCRIBE el reembolso, con la cuenta ya bloqueada, decide
 * cuánto vuelve a deberse con los cobros de ESE momento, lo graba en la propia fila (`Payment.reopenedAmount` /
 * `reopenedTipAmount`) y reescribe los totales guardados de la cuenta en la MISMA transacción. Nadie vuelve a adivinarlo: el
 * calculador (`summarizeRefunds`) sólo lo resta.
 *
 * ── La regla ────────────────────────────────────────────────────────────────
 *   reabre ⟺ cuenta VIVA (no cancelada ni borrada) · no CERRADA (PAID/REFUNDED) · y con sus cobros de antes todavía debía
 *   importe reabierto = min(importe devuelto, importe cobrado neto)
 *   propina reabierta = min(propina devuelta, propina cobrada neta)
 * Una devolución de producto sobre una venta cubierta o cerrada no reabre nada: la regla del 18-ago sigue para ésas.
 */

const ZERO = new Prisma.Decimal(0)
type DecimalLike = Prisma.Decimal | number | string | null | undefined
const dec = (v: DecimalLike) => (v == null ? ZERO : new Prisma.Decimal(v.toString()))
const minimo = (a: Prisma.Decimal, b: Prisma.Decimal) => (a.lessThan(b) ? a : b)
const noNegativo = (v: Prisma.Decimal) => (v.isNegative() ? ZERO : v)

export interface SaldoReabierto {
  reabre: boolean
  /** En positivo. 0 si no reabre. */
  reopenedAmount: Prisma.Decimal
  /** En positivo. 0 si no reabre. */
  reopenedTipAmount: Prisma.Decimal
  /** D649: la sesión de vales viva de la cuenta que se puso al día (para la bitácora de quien llama). */
  sesionDeVales?: { id: string; estadoAntes: string }
  /**
   * D649 segunda vuelta: la sesión de vales viva la tenía OTRA transacción y aquí no se pudo subir. Quien llama la sube DESPUÉS de su
   * commit con `subirVersionDeValesTrasCommit`; la red, por si esa subida no llega, ya quedó encolada aquí (`SUBIR_VERSION_DE_VALES`).
   */
  sesionDeValesOcupada?: string
}

const NADA: SaldoReabierto = { reabre: false, reopenedAmount: ZERO, reopenedTipAmount: ZERO }

type PagoConTerceros = CompletedPaymentForBalance & { thirdPartyCashAmount?: DecimalLike }
type CuentaParaReabrir = OrderAmountsForBalance & {
  paymentStatus: string | null | undefined
  /** Rappi 2b: con estos dos la cuenta también debe propina pactada y la tarifa de Rappi (`saldoDeCobroDeReparto`). */
  thirdPartyCashDue?: DecimalLike
  cashTipDue?: DecimalLike
}

/** ¿La cuenta todavía debe? En el carril de Rappi 2b, las tres partes (venta, propina pactada, tarifa); fuera de él, el saldo común. */
function todaviaDebe(order: CuentaParaReabrir, pagos: readonly PagoConTerceros[]): boolean {
  const reparto = saldoDeCobroDeReparto(
    { ...order, thirdPartyCashDue: order.thirdPartyCashDue ?? null, cashTipDue: order.cashTipDue ?? null },
    pagos,
  )
  if (reparto) return reparto.totalACobrar.greaterThan(FULL_PAYMENT_TOLERANCE)
  return !computeOrderBalance(order, pagos).isFullyPaid
}

/**
 * PURA. `pagosAntes` = los COMPLETED de la cuenta SIN el reembolso que se está escribiendo. Lo devuelto, en positivo.
 *
 * Rappi 2b (Codex plan r2 #4): «todavía debía» se mide con las tres partes. Con el saldo común, un pedido con la venta en $0 por
 * descuento del proveedor y sólo propina pactada cobrada a medias se veía «saldado» y devolver esa propina no reabría nada.
 */
export function saldoQueReabreElReembolso(input: {
  order: CuentaParaReabrir
  pagosAntes: readonly PagoConTerceros[]
  devueltoImporte: DecimalLike
  devueltoPropina: DecimalLike
}): SaldoReabierto {
  const { order } = input
  if (claseDeEstado(order.status) === 'CANCELADA') return NADA
  if (esVentaCerrada(order.paymentStatus)) return NADA
  if (!todaviaDebe(order, input.pagosAntes)) return NADA
  const antes = computeOrderBalance(order, input.pagosAntes)

  const propinaNeta = noNegativo(antes.tipAmount)
  const importeNeto = noNegativo(antes.paidAmount.minus(antes.tipAmount))
  const reopenedAmount = minimo(dec(input.devueltoImporte).abs(), importeNeto)
  const reopenedTipAmount = minimo(dec(input.devueltoPropina).abs(), propinaNeta)
  if (reopenedAmount.isZero() && reopenedTipAmount.isZero()) return NADA
  return { reabre: true, reopenedAmount, reopenedTipAmount }
}

/**
 * Lo llama quien acaba de crear un `Payment type=REFUND` colgado de una cuenta, DENTRO de su transacción y con la cuenta YA
 * bloqueada (`lockExistingOrderForPayment`). Si reabre: marca la fila y reescribe pagado, propina, total y
 * lo que falta de la cuenta (su `paymentStatus` se queda igual: ya era PENDING o PARTIAL) y, si es venta de vales, pone al día su
 * sesión viva (D649, `avisarALaSesionDeValesEnTx`). Si no, no escribe nada. Quien llama audita después del commit con lo que regresa.
 */
export async function fijarSaldoReabiertoEnTx(
  tx: TxConReintento,
  input: {
    venueId: string
    orderId: string
    refundPaymentId: string
    /** Lo devuelto, en positivo y en pesos. */
    devueltoImporte: DecimalLike
    devueltoPropina: DecimalLike
  },
): Promise<SaldoReabierto> {
  const order = await tx.order.findFirst({
    where: { id: input.orderId, venueId: input.venueId },
    select: {
      subtotal: true,
      discountAmount: true,
      serviceChargeAmount: true,
      contratoDePrecio: true,
      taxAmount: true,
      status: true,
      paymentStatus: true,
      thirdPartyCashDue: true,
      cashTipDue: true,
      // Una cuenta tiene un puñado de cobros: es la misma lectura que hace cada cobro para su saldo.
      payments: {
        where: { venueId: input.venueId, status: 'COMPLETED', id: { not: input.refundPaymentId } },
        select: { ...PAGO_PARA_SALDO_SELECT, thirdPartyCashAmount: true },
      },
    },
  })
  if (!order) return NADA

  const decision = saldoQueReabreElReembolso({
    order,
    pagosAntes: order.payments,
    devueltoImporte: input.devueltoImporte,
    devueltoPropina: input.devueltoPropina,
  })
  if (!decision.reabre) return decision

  await tx.payment.update({
    where: { id: input.refundPaymentId, venueId: input.venueId },
    data: { reopenedAmount: decision.reopenedAmount, reopenedTipAmount: decision.reopenedTipAmount },
  })

  const pagosDespues = [
    ...order.payments,
    {
      amount: dec(input.devueltoImporte).abs().negated(),
      tipAmount: dec(input.devueltoPropina).abs().negated(),
      type: 'REFUND',
      reopenedAmount: decision.reopenedAmount,
      reopenedTipAmount: decision.reopenedTipAmount,
    },
  ]
  const despues = computeOrderBalance(order, pagosDespues)
  // Rappi 2b: la columna `remainingBalance` del carril es lo que falta de las TRES partes (como la escribe `payCashOrder`; la lee el
  // reintento). Fuera del carril, el saldo común.
  const repartoDespues = saldoDeCobroDeReparto(order, pagosDespues)
  await tx.order.update({
    where: { id: input.orderId, venueId: input.venueId },
    data: {
      paidAmount: despues.paidAmount,
      tipAmount: despues.tipAmount,
      total: despues.total,
      remainingBalance: repartoDespues ? repartoDespues.totalACobrar : despues.remainingBalance,
      // 🔴 `paymentStatus` NO se toca (Codex plan r2 #2): la cuenta sigue PENDING/PARTIAL como hoy. Pasar a PENDING una cuenta con
      // sus cobros devueltos cambiaba conductas que leen ese estado (R44: el folio «Nadie» con su abono devuelto vence SIN cancelar
      // la cuenta; la guarda de cancelar). Lo que cambia son los importes, que es lo que estaba mal.
    },
  })
  return { ...decision, ...(await avisarALaSesionDeValesEnTx(tx, input)) }
}

/**
 * D649 (Codex apps-viejas r3): una venta de VALES también tiene su sesión de cobro, y el POS (ANDROID ≥2.25.22, WINDOWS, iOS 1.15.x)
 * descarta una respuesta de esa sesión con la MISMA versión y menos pagado, y una «sin abono» (ni PARTIALLY_PAID ni pagado > 0)
 * sobre una copia «con abono». Sin esto, tras devolver el abono la caja seguía proponiendo «Cobrar saldo» por lo de antes.
 * La sesión viva de la cuenta (`orderId` es único) sube su versión y, si seguía MATERIALIZED (el abono entró por otro canal:
 * pago manual, cripto, saldo del cliente), pasa a PARTIALLY_PAID: tuvo un abono y ya no se cancela (`CHECKOUT_HAS_PAYMENT`).
 *
 * 🔴 SKIP LOCKED: aquí la cuenta ya está bloqueada y la jerarquía de vales es sesión → vales → cuenta; esperar la sesión cruzaría
 * candados con un cobro de vales (40P01). Una fila que ya tomó esta transacción sí se devuelve.
 * Segunda vuelta (Codex apps-viejas r4): si otra transacción la tiene, NO basta con que «su siguiente cambio la suba»: puede acabar
 * rechazada y revertir (`ctx.rechazoDelPersonal` de un cobro de vales se lanza ya con los candados) o sólo leerla. Entonces se
 * devuelve `sesionDeValesOcupada` y quien llama la sube tras su commit (`subirVersionDeValesTrasCommit`). Como esa subida puede no
 * llegar (el proceso muere, la base falla; Codex r3), aquí mismo, en la transacción del reembolso, se encola su red durable: un
 * `SUBIR_VERSION_DE_VALES` que el trabajador de efectos corre si hace falta (subir de más no daña: la versión sólo crece).
 */
async function avisarALaSesionDeValesEnTx(
  tx: TxConReintento,
  input: { venueId: string; orderId: string; refundPaymentId: string },
): Promise<Pick<SaldoReabierto, 'sesionDeVales' | 'sesionDeValesOcupada'>> {
  const [sesion] = await tx.$queryRaw<Array<{ id: string; status: string }>>`
    SELECT id, status::text AS status FROM "AreaTicketCheckoutSession"
    WHERE "orderId" = ${input.orderId} AND "venueId" = ${input.venueId}
      AND status IN ('MATERIALIZED', 'PARTIALLY_PAID', 'PAYMENT_PENDING', 'RECONCILIATION_REQUIRED')
    FOR UPDATE SKIP LOCKED`
  if (!sesion) {
    // ¿No hay sesión viva, o la tiene otra transacción? Sin candado: sólo para saber si existe.
    const [ocupada] = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "AreaTicketCheckoutSession"
      WHERE "orderId" = ${input.orderId} AND "venueId" = ${input.venueId}
        AND status IN ('MATERIALIZED', 'PARTIALLY_PAID', 'PAYMENT_PENDING', 'RECONCILIATION_REQUIRED')`
    if (!ocupada) return {}
    const { enqueuePaymentEffect } = await import('@/services/tpv/paymentEffects.service')
    await enqueuePaymentEffect(tx, {
      venueId: input.venueId,
      paymentId: input.refundPaymentId,
      orderId: input.orderId,
      kind: 'SUBIR_VERSION_DE_VALES',
      dedupeKey: `vales-version:${input.refundPaymentId}:v1`,
      payload: { sessionId: ocupada.id },
      // La subida inmediata de quien llama va primero; el trabajador sólo la repite si hace falta (R4-4: nace diferido).
      nextAttemptAt: new Date(Date.now() + ESPERA_DE_LA_RED_DE_VALES_MS),
    })
    return { sesionDeValesOcupada: ocupada.id }
  }
  await tx.areaTicketCheckoutSession.update({
    where: { id: sesion.id },
    data: {
      version: { increment: 1 },
      ...(sesion.status === AreaTicketCheckoutStatus.MATERIALIZED ? { status: AreaTicketCheckoutStatus.PARTIALLY_PAID } : {}),
    },
  })
  return { sesionDeVales: { id: sesion.id, estadoAntes: sesion.status } }
}

/** Cuánto espera el trabajador antes de repetir la subida de la sesión de vales: la inmediata de quien reembolsa va primero. */
const ESPERA_DE_LA_RED_DE_VALES_MS = 60_000

/**
 * D649: sube la versión de una sesión de vales viva y, si seguía MATERIALIZED, la pasa a PARTIALLY_PAID, igual que
 * `avisarALaSesionDeValesEnTx`. Sin la cuenta: espera el candado de la sesión como cualquiera. Subirla de más es inofensivo: la versión
 * sólo crece y sólo se compara con candado en sesiones OPEN, que aquí no se tocan; una sesión pagada o cancelada tampoco. LANZA si la
 * base falla: el trabajador de efectos (`SUBIR_VERSION_DE_VALES`) lo reintenta. Devuelve si subió alguna.
 */
export async function subirVersionDeValesEnDb(
  db: Pick<Prisma.TransactionClient, 'areaTicketCheckoutSession'>,
  input: { venueId: string; sessionId: string },
): Promise<boolean> {
  // Primero las que ya tuvieron abono y luego la MATERIALIZED: así una sola de las dos la encuentra.
  const subida = await db.areaTicketCheckoutSession.updateMany({
    where: {
      id: input.sessionId,
      venueId: input.venueId,
      status: {
        in: [
          AreaTicketCheckoutStatus.PARTIALLY_PAID,
          AreaTicketCheckoutStatus.PAYMENT_PENDING,
          AreaTicketCheckoutStatus.RECONCILIATION_REQUIRED,
        ],
      },
    },
    data: { version: { increment: 1 } },
  })
  if (subida.count > 0) return true
  const materializada = await db.areaTicketCheckoutSession.updateMany({
    where: { id: input.sessionId, venueId: input.venueId, status: AreaTicketCheckoutStatus.MATERIALIZED },
    data: { version: { increment: 1 }, status: AreaTicketCheckoutStatus.PARTIALLY_PAID },
  })
  return materializada.count > 0
}

/**
 * D649 segunda vuelta: la subida de una sesión que estaba tomada al reabrir, DESPUÉS del commit del reembolso, para que la caja se
 * entere en el momento. Quien llama no la espera (la otra transacción puede tardar) y nunca lanza: el reembolso ya está hecho. Si no
 * llega (el proceso muere, la base falla), la sube el efecto `SUBIR_VERSION_DE_VALES` que quedó en la transacción del reembolso.
 */
export async function subirVersionDeValesTrasCommit(input: { venueId: string; sessionId: string }): Promise<void> {
  try {
    await subirVersionDeValesEnDb(prisma, input)
  } catch (error) {
    logger.error('[D649] No se pudo subir tras el commit la versión de la sesión de vales de un abono devuelto; la sube su efecto', {
      venueId: input.venueId,
      sessionId: input.sessionId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * D19: lo COBRADO que cubre la cuenta, para quien suma con `aggregate` en vez de leer la lista de pagos (el cierre de la TPV, la
 * guarda D7 de la terminal, la liga de un cliente, la anulación de artículos). Es la suma de siempre —los COMPLETED que no son
 * REFUND, con `type` NULL dentro, importe y propina por separado— MENOS lo que los reembolsos de abonos volvieron a deber. Pásalo
 * al calculador como un cobro sintético (`[{ amount, tipAmount }]`): da lo mismo que la lista completa por `summarizeRefunds`.
 *
 * 🔴 No escribas el `aggregate` sin REFUND a mano: así se quedaron fuera de D19 cinco lugares que decidían si la cuenta estaba
 * pagada (mapa del 12-nov).
 */
export async function cobradoQueCubreEnTx(
  tx: Pick<Prisma.TransactionClient, 'payment'>,
  w: { venueId: string; orderId: string },
): Promise<{ amount: Prisma.Decimal; tipAmount: Prisma.Decimal; cobros: number }> {
  const cobros = await tx.payment.aggregate({
    where: { venueId: w.venueId, orderId: w.orderId, status: 'COMPLETED', OR: [{ type: null }, { type: { not: 'REFUND' } }] },
    _sum: { amount: true, tipAmount: true },
    _count: true,
  })
  const reabierto = await tx.payment.aggregate({
    where: { venueId: w.venueId, orderId: w.orderId, status: 'COMPLETED', type: 'REFUND' },
    _sum: { reopenedAmount: true, reopenedTipAmount: true },
  })
  return {
    amount: dec(cobros?._sum?.amount).minus(dec(reabierto?._sum?.reopenedAmount).abs()),
    tipAmount: dec(cobros?._sum?.tipAmount).minus(dec(reabierto?._sum?.reopenedTipAmount).abs()),
    cobros: cobros?._count ?? 0,
  }
}
