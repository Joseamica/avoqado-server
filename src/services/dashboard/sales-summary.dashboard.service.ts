import { sqlPaymentIsNotExchangeCredit } from '../exchanges/exchangeMarks'
/**
 * Sales Summary Dashboard Service
 *
 * Calculates comprehensive sales metrics for venues.
 * Used by the Sales Summary report in the dashboard.
 *
 * Accounting Structure:
 * - grossSales = items + serviceCosts (Order.subtotal + service fees)
 *   Mexico model: prices INCLUDE the IVA. A native order's subtotal already carries it; an order that charged the IVA ON TOP
 *   (onboarding demo data, imported SoftRestaurant history) adds it back (`sqlImpuestoQueSeCobraAparte`, D16), so every sale is
 *   what the customer paid for the goods. Tips are never sales.
 * - items: Sum of Order.subtotal + IVA charged on top (item prices as paid, without tips)
 * - serviceCosts: Service fees, delivery fees (future)
 * - discounts: Total discounts applied
 * - refunds: Total refunded payments
 * - netSales: grossSales - discounts - refunds
 * - deferredSales: Unpaid/partial orders total
 * - taxes: Total taxes collected (pass-through)
 * - tips: Total tips
 *
 * Costs breakdown:
 * - platformFees: Avoqado platform fees (from VenueTransaction.feeAmount)
 * - staffCommissions: Commissions paid to staff (from CommissionCalculation.netCommission)
 *
 * Calculated totals:
 * - totalCollected: netSales + tips - platformFees (actual cash flow)
 * - netProfit: netSales - platformFees - staffCommissions (true venue profit)
 */

import { Prisma, TransactionCardType } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'
import { localInstantRaw, localWallClockRaw, utcTs, utcTsParam } from '@/utils/sqlDates'

import logger from '@/config/logger'
import { BadRequestError } from '@/errors/AppError'
import { foldGiveawaysIntoSummary } from '@/services/dashboard/salesGiveaways'
import {
  cargarReglasFaltantes,
  projectPaymentSettlement,
  type ActiveConfig,
} from '@/services/dashboard/settlementCalendar.dashboard.service'
import {
  MINDFORM_NEW_VENUE_ID,
  sumsLegacyQrPayments,
  AVISO_PUENTE_QR_CAIDO,
  forEachLegacyPaymentPage,
  getLegacyPeriodMetrics,
  type LegacyPeriodMetric,
  type LegacyPeriodReportType,
} from '@/services/legacy/qrPayments.legacy.service'
import prisma from '@/utils/prismaClient'
import { sanitizeTimezone } from '@/utils/sanitizeTimezone'
import {
  WHERE_COBRO_NO_ES_SALDO_DE_REGALO,
  WHERE_ORDEN_SIN_TARJETAS,
  sqlCobroNoEsSaldoDeRegalo,
  sqlOrdenSinTarjetasTexto,
} from '@/services/giftCards/giftCardMarks'
import { montoSaldoAFavorSql, sqlNoEsDelMedioSaldoAFavor } from '@/services/storeCredit/saldoAFavorEnLectores'
import { sqlImpuestoQueSeCobraAparte } from '@/services/shared/orderBalance'
import {
  NOT_DRAWER_CASH_WHERE,
  paymentCountsAsDrawerCash,
  paymentIsAvoqadoSettled,
  sqlEsEfectivoDelCajon,
} from '@/services/shared/tenderSemantics'
import { proyectarComisionYNeto } from '@/services/payments/proyeccionMonetaria'
import {
  sqlCobroDeCuentaSinCobrar,
  sqlComisionDeTerceros,
  sqlCuentaCobrada,
  sqlLoQueFaltaCobrar,
} from '@/services/dashboard/salesSummaryPoblacion'
import { dondeHoraRealEntre, sqlHoraReal, sqlRangoHoraReal, sqlRangoHoraRealSql } from '@/services/shared/horaRealDelAparato'
import {
  computeSalesByChannel,
  type SalesBreakdownRow,
  type SalesChannel,
  type SalesOrderType,
} from '@/services/dashboard/salesSummaryCanales'
import { computePrepaidOutsideSales } from '@/services/dashboard/salesSummaryCobradoPorAdelantado'

// ============================================================
// Types
// ============================================================

export interface SalesSummaryMetrics {
  // Order-derived metrics — null when filtering by paymentMethod/cardType
  // because Order rows can't be reliably split across payment buckets
  // (a single Order may be paid by multiple Payments with different methods).
  grossSales: number | null
  items: number | null
  serviceCosts: number | null
  discounts: number | null
  refunds: number
  netSales: number | null
  deferredSales: number | null
  taxes: number | null
  tips: number
  // Costs breakdown (for clarity)
  platformFees: number // Avoqado platform fees (from VenueTransaction)
  staffCommissions: number // Commissions paid to staff (from CommissionCalculation)
  // Legacy field for backwards compatibility (= platformFees)
  commissions: number
  totalCollected: number
  // True profit after all costs
  netProfit: number // netSales - platformFees - tenderCommissions - staffCommissions
  transactionCount: number
  /**
   * D6 (base de caja, founder 15-sep-2026) — aditivo. «Sin cobrar»: lo que todavía deben las cuentas abiertas o pagadas a medias
   * del rango, sin propina y en las unidades de `grossSales`. NO es venta. `null` en la vista de movimientos (filtro de método o
   * de comercio), como las demás métricas de orden.
   */
  unpaidSales?: number | null
  /** D6 — aditivo. Cuántas de esas cuentas deben algo. */
  unpaidOrders?: number | null
  /**
   * D1 — aditivo. Comisiones de terceros: la comisión CONGELADA en cada cobro por su tipo de pago (Rappi, Uber Eats, DiDi, vales
   * con comisión), con signo (el ajuste del proveedor la regresa en negativo). Ya restada de `totalCollected` y `netProfit`.
   * No es de Avoqado: ésa es `platformFees`.
   */
  tenderCommissions?: number
  /** D10.1 — aditivo. Cuántas devoluciones hay en `refunds` (ya no cuentan en `transactionCount`). */
  refundCount?: number
  // Tarjetas de regalo (1a, spec §7) — aditivos; sólo en la vista sin filtro de método.
  /** Tarjetas cargadas en el rango, menos sus cancelaciones. NO es venta: no está en grossSales. */
  giftCardLoads?: number
  /** Sobres de cuentas de tarjetas PAGADAS en el rango. */
  giftCardLoadsCount?: number
  /**
   * Pagado con saldo (venta + propina), menos sus reversos. YA está dentro de las ventas: se muestra para leerlo aparte. Sólo de
   * tarjetas VENDIDAS: lo gastado de un saldo a favor es venta normal (S8b).
   */
  paidWithGiftCardBalance?: number
  // Carril G · D5 — aditivos; sólo con `includePrepaid` y en la vista de ventas. Cobrado por adelantado que NO es venta (no está en
  // grossSales ni en totalCollected), como las tarjetas de regalo cargadas: `salesSummaryCobradoPorAdelantado.ts`.
  /** Paquetes de clases comprados en línea, por la fecha de su compra. */
  packagesSoldOnline?: number
  packagesSoldOnlineCount?: number
  /** Depósitos de reservas cobrados en el rango menos los devueltos en el rango (neto). */
  reservationDeposits?: number
  /** Cuántos depósitos se cobraron en el rango. */
  reservationDepositsCount?: number
  /** Lo devuelto de depósitos en el rango. */
  reservationDepositsRefunded?: number
  /** Paquetes en línea cobrados en otra moneda (no se suman a los pesos de arriba). */
  packagesSoldOnlineOtherCurrencies?: Array<{ currency: string; amount: number; count: number }>
}

export interface PaymentMethodBreakdown {
  method: string
  amount: number
  count: number
  percentage: number
}

export interface PaymentMethodDetailedBreakdown {
  bucket: 'CARD' | 'CASH' | 'OTHER' | 'QR_LEGACY'
  /** Movimiento del cajón: cobros MENOS devoluciones completadas, con propina (puede ser negativo el día de una devolución). */
  amount: number
  /** Filas completadas del cajón, devoluciones incluidas. Para «cuántos cobros» usa `chargedCount`. */
  count: number
  percentage: number
  tips: number
  refunds: number
  platformFees: number
  // Aditivos (carril C, 21-nov-2026): el estado de cuenta separa lo cobrado de lo devuelto (D10.2) y la comisión de terceros (D1).
  /** Sólo cobros (sin devoluciones), con propina. `chargedAmount − amount` = devoluciones completadas del cajón. */
  chargedAmount?: number
  /** Cuántos cobros (sin devoluciones). */
  chargedCount?: number
  /** Comisión congelada de Rappi/Uber o de un tipo de pago propio (`tenderCommissionAmount`), con signo (la revertida resta). */
  tenderCommissions?: number
  /** Lo devuelto de cuentas CANCELADAS o borradas: sí salió dinero, pero la cabecera no lo resta (su venta tampoco se cuenta). */
  cancelledOrderRefunds?: number
  subBuckets?: Array<{
    type: 'CREDIT' | 'DEBIT' | 'AMEX' | 'INTERNATIONAL'
    amount: number
    count: number
    percentage: number
    platformFees: number
    chargedAmount?: number
    chargedCount?: number
    /** Aditivo (carril C): la comisión redondeada por cobro, como el estado de cuenta y la liquidación. */
    platformFeesCents?: number
  }>
}

/** Lo pagado con saldo de tarjeta de regalo, fuera de los buckets (un bucket nuevo tumba al dashboard que no lo conoce). */
export interface GiftCardBalanceBreakdown {
  amount: number
  count: number
  tips: number
  refunds: number
}

export interface GiftCardFigures {
  loads: number
  loadsCount: number
  loadRefunds: number
  balancePaid: number
  balanceCount: number
  balanceTips: number
  balanceReversals: number
  /**
   * Saldo a favor (spec 2026-10-30 §5.3, S8b), las dos patas con signo: la devolución a saldo (negativa) y lo gastado de un sobre de
   * saldo a favor menos lo que regresó a él. Es VENTA normal (método OTHER), nunca «pagado con saldo» de tarjetas vendidas.
   */
  storeCreditNet: number
  /**
   * Cuántas filas tienen una pata de saldo a favor (cuentan en OTHER): cada devolución a saldo y cada fila con el medio de tarjetas que
   * canjeó o regresó algo a un sobre de saldo a favor. POR PATA (S10 r3, ruling): un cobro mixto cuenta aquí y también en
   * `balanceCount`, como el desglose por medio de pago del mercado; así «importe ≠ 0 ⇒ conteo > 0» se cumple siempre. La suma de los
   * conteos por método es de PATAS, no de cobros: el total de cobros es `transactionCount`.
   */
  storeCreditCount: number
}

export interface TimePeriodMetrics {
  period: string // ISO date string or label (e.g., "Monday", "09:00")
  periodLabel?: string // Human-readable label
  metrics: SalesSummaryMetrics
}

export interface MerchantAccountBreakdown {
  merchantAccountId: string
  displayName: string // "Amaena - A" / alias / provider name fallback
  provider: string // "AngelPay (Nexgo)" / "Blumon PAX"
  affiliation: string | null // angelpayAffiliation when present
  // What was charged to the card INCLUDING tips (amount + tipAmount) — card only
  // (merchantAccountId IS NOT NULL). Tips ride the card and land in the bank, and
  // the venue commission is charged on amount+tip (see transactionCost.service), so
  // excluding them understated what the venue receives AND made this panel disagree
  // with the settlement calendar. Decision: Jose 2026-06-10 — include tips.
  collectedOnCard: number
  platformFee: number // SUM(TransactionCost.venueChargeAmount + venueFixedFee) — same fee the settlement engine nets out
  netToReceive: number // collectedOnCard - platformFee — reconciles with settlementCalendar nets
  transactionCount: number
  // Soonest estimated settlement for this merchant within the range (Entrega 2);
  // present only when includeSettlementProjection=true. nextDate is YYYY-MM-DD in
  // venue timezone, or null when no settlement config can project these payments.
  estimatedSettlement?: {
    nextDate: string | null
    settlementDays: number | null
  }
  // Active settlement rules per card type (from SettlementConfiguration where
  // effectiveTo IS NULL). Lets the UI say "Visa/MC: 1 día hábil · Amex: 3 días
  // hábiles" per merchant. Present only when includeMerchantBreakdown=true and
  // the account has active rules; omitted otherwise.
  settlementRules?: Array<{ cardType: TransactionCardType; settlementDays: number }>
  /** Aditivo (D10.2): lo devuelto a tarjeta en el rango (positivo), ya restado de `collectedOnCard` y `netToReceive`. */
  refunds?: number
  /** Aditivo (D10.2): cuántas de `transactionCount` son devoluciones. Cobros = `transactionCount − refundCount`. */
  refundCount?: number
  /** Aditivo (carril C): neto de sus cobros sin fecha estimada (sin costo todavía o sin regla); con `includeSettlementProjection`. */
  unprojectedNet?: number
}

/**
 * Aditivo (carril C, 21-nov-2026): el dinero de un destino del estado de cuenta. Misma forma y significado que un comercio:
 * `collected`/`netToReceive`/`transactionCount` ya incluyen sus devoluciones (con signo); `refunds` es lo devuelto (positivo).
 */
export interface MoneyDestination {
  collected: number
  refunds: number
  refundCount: number
  platformFee: number
  netToReceive: number
  transactionCount: number
}

/**
 * Aditivo (carril C): a dónde fue cada cobro del estado de cuenta, UN destino por cobro, leído en la MISMA consulta que los
 * cajones y que «Por comercio» (así «Te queda» = efectivo + banco + otros − comisión de terceros cuadra sin restas ni lecturas
 * en otro momento). Lo decide `destinationOf` con la autoridad de `tenderSemantics`:
 * - `drawer`: está en el cajón (`paymentCountsAsDrawerCash`), aunque traiga comercio;
 * - `terminal`: tiene comercio de terminal (lo que suma «Por comercio»);
 * - `online`: sin comercio, en línea de Avoqado y lo deposita Avoqado (tienda, ligas, checkout, Mercado Pago; D11). La devolución
 *   que no trae los sellos hereda los de su cobro (`processorData.originalPaymentId`);
 * - `other`: lo demás (Rappi/Uber, transferencias, vales, tarjetas de otra terminal o sin comercio, QR del sistema anterior).
 * `tenderCommissions` es la comisión congelada de terceros (D1): se resta aparte, no de un destino (un pedido de Rappi cobrado
 * en efectivo sigue entero en el cajón). Cada importe va redondeado al centavo.
 */
export interface StatementDestinations {
  drawer: MoneyDestination
  terminal: MoneyDestination
  online: MoneyDestination
  other: MoneyDestination
  tenderCommissions: number
}

export type StatementDestinationKey = 'drawer' | 'terminal' | 'online' | 'other'

/**
 * El destino de un grupo de cobros (carril C). Orden: cajón → (sólo se registra → otros) → comercio de terminal → en línea → otros. Sin
 * comercio ni sello en línea nada va al banco: el respaldo viejo de `paymentIsAvoqadoSettled` da por «depositable» todo lo que no
 * es efectivo (su falsedad conocida, documentada ahí), y así se colaban tarjetas de SoftRestaurant, de prueba y de otra terminal.
 */
export function destinationOf(g: {
  method: string
  fundsFlow: string | null
  tenderCountsAsCash: boolean | null
  hasTender: boolean
  hasMerchant: boolean
  enLinea: boolean
}): StatementDestinationKey {
  const pago = {
    method: g.method,
    fundsFlow: g.fundsFlow,
    tenderTypeId: g.hasTender ? 'con-tipo' : null,
    tenderCountsAsCash: g.tenderCountsAsCash,
  }
  if (paymentCountsAsDrawerCash(pago)) return 'drawer'
  // Lo que Avoqado sólo REGISTRA no llega al banco aunque traiga comercio (una devolución por transferencia hereda la afiliación
  // del cobro original, Codex r3 #5).
  if (!paymentIsAvoqadoSettled(pago)) return 'other'
  if (g.hasMerchant) return 'terminal'
  if (g.enLinea) return 'online'
  return 'other'
}

/**
 * La población de `terminal` (`destinationOf`) como `where` de Prisma, para la proyección: tiene comercio, NO está en el cajón y
 * la deposita Avoqado. Escrita sin `NOT` sobre columnas que pueden ser NULL (un `NOT (x = v)` con x NULL descarta la fila). La
 * paridad con `destinationOf` la cuida `sales-summary.dashboard.service.test.ts`.
 */
export const WHERE_COBRO_DE_TERMINAL_DE_AVOQADO: Prisma.PaymentWhereInput = {
  merchantAccountId: { not: null },
  OR: [
    { fundsFlow: 'AVOQADO_PROCESSED' },
    {
      fundsFlow: null,
      method: { not: 'CASH' },
      OR: [{ tenderCountsAsCash: null }, { tenderCountsAsCash: false }],
      NOT: { tenderTypeId: { not: null }, method: 'OTHER' },
    },
  ],
}

// Entrega 2 — settlement projection ("¿cuándo cae el dinero?").
// The date-range picker scopes WHICH sales; the calendar shows WHEN that card
// money lands, grouped by settlement date and merchant. Estimate only (rule-based
// until a bank API confirms). Cash is excluded — it is immediate.
export interface SettlementCalendarMerchant {
  merchantAccountId: string
  displayName: string
  platformFee: number
  netToReceive: number
  transactionCount: number
}

export interface SettlementCalendarDay {
  date: string // YYYY-MM-DD settlement date in venue timezone
  status: 'settled' | 'pending' | 'projected' // vs today: past / today / future
  totalNet: number
  byMerchant: SettlementCalendarMerchant[]
}

export interface SalesSummaryResponse {
  dateRange: {
    startDate: Date
    endDate: Date
  }
  reportType: ReportType
  summary: SalesSummaryMetrics
  byPaymentMethod?: PaymentMethodBreakdown[]
  /**
   * Aditivo (tarjetas de regalo, full-testing v2 #1): VENTAS por método para la barra bajo «Total de Ventas»: sin los cobros de
   * cuentas de tarjetas y con lo pagado con saldo como `GIFT_CARD`. `byPaymentMethod` sigue siendo DINERO (B5). Sólo sin filtro y
   * en negocios que tienen tarjetas; sin él, los dos son iguales. Saldo a favor (S8b): la devolución a saldo y lo gastado de un sobre
   * van en `OTHER` (su método), como venta.
   */
  salesByPaymentMethod?: PaymentMethodBreakdown[]
  byPaymentMethodDetailed?: PaymentMethodDetailedBreakdown[]
  byPeriod?: TimePeriodMetrics[] // Time-based breakdown
  byMerchantAccount?: MerchantAccountBreakdown[] // additive; present only when includeMerchantBreakdown=true
  /** Aditivo (carril C): a dónde fue cada cobro del estado de cuenta; con `groupBy=paymentMethod`, sin filtro de método y con `includeMerchantBreakdown`. */
  statementDestinations?: StatementDestinations
  settlementCalendar?: SettlementCalendarDay[] // additive; present only when includeSettlementProjection=true
  giftCardBalanceBreakdown?: GiftCardBalanceBreakdown // aditivo (tarjetas de regalo); con groupBy=paymentMethod y sin filtro
  /**
   * Carril G · D4 — aditivos; sólo con `includeChannelBreakdown` (Pro) y en la vista de ventas. La cabecera repartida por canal
   * (por dónde entró) y por tipo de pedido (cómo se entregó): cada tabla suma la cabecera al centavo.
   */
  byChannel?: SalesBreakdownRow<SalesChannel>[]
  byOrderType?: SalesBreakdownRow<SalesOrderType>[]
  /** El controlador lo pone cuando se pidió el desglose por canal y el plan del negocio no lo incluye (la pantalla pinta el candado). */
  channelBreakdownLocked?: true
  /**
   * Las tablas por canal se leyeron un instante después de la cabecera y alguna cifra ya no es la misma (entró una venta entre las
   * dos lecturas). Se dice en vez de esconderlo; se arregla al recargar. Lo cierra la foto única del reporte (D17 del carril B2).
   */
  channelBreakdownOutOfSync?: true
  filtered: boolean
  /**
   * Additive; present ONLY when the MindForm legacy QR bridge could not answer (legacy DB down,
   * broken query, pool not configured). Without it, "legacy rows are zero" and "the legacy query
   * failed" are indistinguishable — a COALESCE on the enum `method` column failed for weeks and the
   * report silently under-counted Mindform's QR revenue whenever a method filter was applied.
   * D15 (2026-11-16): it also covers the page walk behind the headline totals — a bridge failure on a later page
   * used to leave a PARTIAL sum reported as complete. Any legacy read that fails sets it; none of them clears it.
   */
  legacyUnavailable?: true
}

export type ReportType = 'summary' | 'hours' | 'days' | 'weeks' | 'months' | 'hourlySum' | 'dailySum'

export type PaymentMethodFilter = 'CASH' | 'CARD' | 'QR_LEGACY' | 'OTHER'

/**
 * La comisión de UN cobro (alias `p` para Payment y `tc` para su TransactionCost, 1:1): su costo (cargo + cuota fija) si lo tiene; si no,
 * y sólo si es un cobro en línea de Avoqado, la que trae el propio `Payment` (Codex r4 H1): el de Stripe de pedidos en línea, las ligas,
 * Checkout y Mercado Pago no tienen costo y su comisión vive en `feeAmount`. «En línea de Avoqado» = `fundsFlow = AVOQADO_PROCESSED` (lo
 * nuevo, y la devolución que lo copia y trae la comisión devuelta en negativo) o un comercio en línea (`ecommerceMerchantId`: lo de antes
 * de `fundsFlow`, Codex r6). El resto sin costo publica 0 como siempre: el importador de SoftRestaurant y el efectivo de los demos guardan
 * un `feeAmount` que no se cobró (Codex r5). El de terminal sin costo todavía trae 0.
 */
/** «En línea de Avoqado» del cobro con alias `alias`: siempre true o false (nunca NULL), así se puede agrupar y negar. */
const sqlEnLineaDeAvoqado = (alias: 'p' | 'orig') =>
  `(COALESCE(${alias}."fundsFlow" = 'AVOQADO_PROCESSED', false) OR ${alias}."ecommerceMerchantId" IS NOT NULL)`
const SQL_COMISION_DEL_COBRO = `CASE WHEN tc."id" IS NOT NULL THEN COALESCE(tc."venueChargeAmount", 0) + COALESCE(tc."venueFixedFee", 0) WHEN ${sqlEnLineaDeAvoqado('p')} THEN COALESCE(p."feeAmount", 0) ELSE 0 END`

export type CardTypeFilter = 'CREDIT' | 'DEBIT' | 'AMEX' | 'INTERNATIONAL'

export interface SalesSummaryFilters {
  startDate: string
  endDate: string
  groupBy?: 'none' | 'paymentMethod'
  reportType?: ReportType
  timezone?: string
  merchantAccountId?: string
  paymentMethod?: PaymentMethodFilter
  cardType?: CardTypeFilter
  includeMerchantBreakdown?: boolean // additive opt-in; default off preserves existing payload
  includeSettlementProjection?: boolean // additive opt-in; adds settlementCalendar + per-merchant estimatedSettlement
  /** La B (C1): no corre el agregado de CommissionCalculation y `staffCommissions` sale 0. Sin la opción, el panel no cambia. */
  skipStaffCommissions?: boolean
  /** Carril G · D4: `byChannel` y `byOrderType` (el controlador sólo la deja pasar con ADVANCED_REPORTS). */
  includeChannelBreakdown?: boolean
  /** Carril G · D5: paquetes vendidos en línea y depósitos de reservas en `summary` (renglones que no son venta). */
  includePrepaid?: boolean
}

/** Round money to cents — keeps API/MCP payloads free of float-accumulation noise. */
const round2 = (n: number): number => Math.round(n * 100) / 100

// ============================================================
// Payment Filter Helpers
// ============================================================

/**
 * Zeroed summary shell. Used by the QR_LEGACY short-circuit when there is
 * nothing to compute (non-MindForm venue reaching the legacy branch defensively).
 * Order-derived metrics are null to mirror the filtered-view contract.
 */
function emptySummary(): SalesSummaryMetrics {
  return {
    grossSales: null,
    items: null,
    serviceCosts: null,
    discounts: null,
    refunds: 0,
    netSales: null,
    deferredSales: null,
    taxes: null,
    tips: 0,
    platformFees: 0,
    staffCommissions: 0,
    commissions: 0,
    totalCollected: 0,
    netProfit: 0,
    transactionCount: 0,
  }
}

/**
 * Build a legacy-only period metric (order-derived fields null, payment-derived
 * fields filled from the legacy aggregate). Used by the QR_LEGACY short-circuit
 * to populate byPeriod without the native queries. Part of the MindForm QR
 * bridge — delete when native QR ships.
 */
function legacyOnlyMetrics(amount: number, tips: number, count: number): SalesSummaryMetrics {
  return {
    ...emptySummary(),
    tips,
    totalCollected: amount + tips,
    netProfit: amount,
    transactionCount: count,
  }
}

/**
 * Assign each bucket's `percentage` against a tips-INCLUSIVE grand total (the
 * sum of the `amount` fields, which already include tips) and sort by amount
 * descending. Using the same basis as the `amount` field keeps the percentage
 * trustworthy for any consumer and makes the native + legacy-append paths use an
 * identical denominator.
 */
function withPercentages(buckets: PaymentMethodBreakdown[]): PaymentMethodBreakdown[] {
  const grandTotal = buckets.reduce((s, p) => s + p.amount, 0)
  return buckets
    .map(p => ({ ...p, percentage: grandTotal > 0 ? Number(((p.amount / grandTotal) * 100).toFixed(1)) : 0 }))
    .sort((a, b) => b.amount - a.amount)
}

/**
 * Build a Prisma where fragment narrowing payments to a single method/card-type
 * bucket. Mirrors the canonical mapping in `transactionCost.service.ts`
 * (`determineTransactionCardType`) so a payment that counts as AMEX here
 * counts as AMEX everywhere else.
 *
 * QR_LEGACY is handled outside Prisma — see the short-circuit in
 * getSalesSummary. We throw here as defense-in-depth so any direct caller
 * (e.g. a test) gets a clear failure instead of silent zero rows.
 */
export function buildPaymentWhereFilter(paymentMethod?: PaymentMethodFilter, cardType?: CardTypeFilter): Prisma.PaymentWhereInput {
  if (!paymentMethod) return {}

  if (paymentMethod === 'CASH') return { method: 'CASH' }

  if (paymentMethod === 'OTHER') {
    return { method: { in: ['DIGITAL_WALLET', 'BANK_TRANSFER', 'CRYPTOCURRENCY', 'OTHER'] } }
  }

  if (paymentMethod === 'QR_LEGACY') {
    throw new Error('QR_LEGACY should be short-circuited by getSalesSummary, not reach the filter builders')
  }

  // paymentMethod === 'CARD'
  if (!cardType) {
    return { method: { in: ['CREDIT_CARD', 'DEBIT_CARD'] } }
  }

  // ── NULL-safe exclusions (must mirror buildPaymentSqlClause exactly) ──
  // Prisma's scalar `not` and JSON-path `NOT { equals }` BOTH drop rows where
  // the column / JSON key is NULL or absent (SQL `x <> v` and `NOT (NULL = v)`
  // are NULL → excluded). Real payments very often have a NULL cardBrand and a
  // NULL/absent processorData.isInternational, so the naive negation silently
  // dropped the vast majority of CREDIT/DEBIT rows (incident found via
  // /full-testing 2026-06-02: CREDIT 157→20, DEBIT 117→0, negative totals when
  // the Prisma count disagreed with the SQL fee sum). These OR-forms restore
  // the NULL/absent rows so Prisma matches the SQL clause 1:1.
  const notAmexBrand: Prisma.PaymentWhereInput = {
    OR: [{ cardBrand: null }, { cardBrand: { not: 'AMERICAN_EXPRESS' } }],
  }
  const notInternational: Prisma.PaymentWhereInput = {
    OR: [
      { processorData: { equals: Prisma.DbNull } }, // column is SQL NULL
      { processorData: { path: ['isInternational'], equals: Prisma.AnyNull } }, // key absent / JSON null
      { NOT: { processorData: { path: ['isInternational'], equals: true } } }, // present & not true
    ],
  }

  if (cardType === 'INTERNATIONAL') {
    // Positive match — no NULL hazard (only rows explicitly flagged true).
    return {
      method: { in: ['CREDIT_CARD', 'DEBIT_CARD'] },
      processorData: { path: ['isInternational'], equals: true },
    }
  }

  if (cardType === 'AMEX') {
    return {
      method: { in: ['CREDIT_CARD', 'DEBIT_CARD'] },
      cardBrand: 'AMERICAN_EXPRESS',
      AND: [notInternational],
    }
  }

  // CREDIT or DEBIT — exclude AMEX brand and exclude international flag,
  // both NULL-safe so cards with no captured brand / processorData still count.
  return {
    method: cardType === 'CREDIT' ? 'CREDIT_CARD' : 'DEBIT_CARD',
    AND: [notAmexBrand, notInternational],
  }
}

/**
 * SQL twin for raw-SQL queries. Returns " AND <clause>" or "" if no filter.
 * `columnPrefix` is the table alias (e.g. 'p' for "p.method").
 */
export function buildPaymentSqlClause(
  paymentMethod: PaymentMethodFilter | undefined,
  cardType: CardTypeFilter | undefined,
  columnPrefix = '',
): string {
  if (!paymentMethod) return ''

  const c = columnPrefix ? `${columnPrefix}.` : ''
  const pdJson = `${c}"processorData"`
  const pdIsIntl = `(${pdJson}->>'isInternational')::boolean = true`
  const pdNotIntl = `(${pdJson} IS NULL OR (${pdJson}->>'isInternational') IS NULL OR (${pdJson}->>'isInternational')::boolean = false)`

  if (paymentMethod === 'CASH') return ` AND ${c}method = 'CASH'`
  if (paymentMethod === 'OTHER') return ` AND ${c}method IN ('DIGITAL_WALLET','BANK_TRANSFER','CRYPTOCURRENCY','OTHER')`
  if (paymentMethod === 'QR_LEGACY') {
    throw new Error('QR_LEGACY should be short-circuited by getSalesSummary, not reach the filter builders')
  }

  // CARD
  if (!cardType) return ` AND ${c}method IN ('CREDIT_CARD','DEBIT_CARD')`
  if (cardType === 'INTERNATIONAL') return ` AND ${c}method IN ('CREDIT_CARD','DEBIT_CARD') AND ${pdIsIntl}`
  if (cardType === 'AMEX')
    return ` AND ${c}method IN ('CREDIT_CARD','DEBIT_CARD') AND ${c}"cardBrand" = 'AMERICAN_EXPRESS' AND ${pdNotIntl}`

  const method = cardType === 'CREDIT' ? 'CREDIT_CARD' : 'DEBIT_CARD'
  return ` AND ${c}method = '${method}' AND (${c}"cardBrand" IS NULL OR ${c}"cardBrand" <> 'AMERICAN_EXPRESS') AND ${pdNotIntl}`
}

/**
 * SINGLE SOURCE OF TRUTH for how the active (paymentMethod, cardType) filter
 * admits MindForm legacy QR rows. Both the row-level summary merge
 * (legacyMatchesFilter) and the SQL period query (calculateTimePeriodMetrics)
 * derive from this so they can never drift apart.
 *
 * Legacy rows lack processorData.isInternational and a reliable cardBrand, so:
 *   - INTERNATIONAL / AMEX / DEBIT → excluded (legacy can't satisfy them)
 *   - CREDIT or CARD-without-cardType → include card-method legacy rows
 *   - CASH → include cash-method legacy rows
 *   - OTHER → excluded; no filter / QR_LEGACY → include all
 *
 * `method` is the legacy method bucket to keep ('CARD' | 'CASH'); when
 * undefined, all eligible legacy rows are kept.
 */
export function legacyAdmission(
  paymentMethod: PaymentMethodFilter | undefined,
  cardType: CardTypeFilter | undefined,
): { include: boolean; method?: 'CARD' | 'CASH' } {
  if (!paymentMethod) return { include: true }
  if (paymentMethod === 'QR_LEGACY') return { include: true }
  if (paymentMethod === 'CASH') return { include: true, method: 'CASH' }
  if (paymentMethod === 'OTHER') return { include: false }
  // CARD
  if (!cardType || cardType === 'CREDIT') return { include: true, method: 'CARD' }
  return { include: false } // DEBIT / AMEX / INTERNATIONAL
}

/**
 * Row-level twin of legacyAdmission: does THIS legacy payment (already mapped to
 * 'CARD' | 'CASH') match the active filter?
 */
export function legacyMatchesFilter(
  legacyMethod: string,
  paymentMethod: PaymentMethodFilter | undefined,
  cardType: CardTypeFilter | undefined,
): boolean {
  const admission = legacyAdmission(paymentMethod, cardType)
  if (!admission.include) return false
  if (!admission.method) return true
  return legacyMethod === admission.method
}

export type BreakdownBucket = 'CARD' | 'CASH' | 'OTHER' | 'QR_LEGACY'
export type CardSubBucket = 'CREDIT' | 'DEBIT' | 'AMEX' | 'INTERNATIONAL'

/**
 * Classify a payment into a breakdown bucket + optional card sub-bucket.
 * Mirrors determineTransactionCardType in transactionCost.service.ts so a
 * payment that counts as AMEX here counts as AMEX everywhere else: international
 * wins first, then AMEX brand, then the card method (credit/debit).
 */
export function bucketOf(
  method: string,
  cardBrand: string | null,
  isInternational: boolean,
): { bucket: BreakdownBucket; sub?: CardSubBucket } {
  if (method === 'CASH') return { bucket: 'CASH' }
  if (method === 'CREDIT_CARD' || method === 'DEBIT_CARD') {
    if (isInternational) return { bucket: 'CARD', sub: 'INTERNATIONAL' }
    if (cardBrand === 'AMERICAN_EXPRESS') return { bucket: 'CARD', sub: 'AMEX' }
    return { bucket: 'CARD', sub: method === 'CREDIT_CARD' ? 'CREDIT' : 'DEBIT' }
  }
  return { bucket: 'OTHER' }
}

/**
 * `!!processorData?.isInternational` evaluated in SQL, with JavaScript's
 * truthiness — the rule the per-row breakdown applied before it moved into the
 * database: true / non-zero number / non-empty string / object / array are
 * truthy; false, 0, "", null and a missing key (or a non-object
 * processorData) are not.
 */
const IS_INTERNATIONAL_SQL = Prisma.sql`(CASE jsonb_typeof(p."processorData" -> 'isInternational')
  WHEN 'boolean' THEN (p."processorData" ->> 'isInternational')::boolean
  WHEN 'number' THEN (p."processorData" ->> 'isInternational')::numeric <> 0
  WHEN 'string' THEN (p."processorData" ->> 'isInternational') <> ''
  WHEN 'object' THEN true
  WHEN 'array' THEN true
  ELSE false
END)`

// ============================================================
// Main Service Function
// ============================================================

/** Sumas de un comercio, ya agregadas (con signo: las devoluciones restan de `collected` y `fee`). */
export interface MerchantSums {
  merchantAccountId: string
  collected: number
  fee: number
  txns: number
  refunds: number
  refundCount: number
}

/**
 * Per-merchant-account card breakdown for the reconciliation view, from sums that the caller already aggregated.
 *
 * Carril C (21-nov-2026): `getSalesSummary` takes the sums from the SAME read as the per-method buckets and the statement
 * destinations (`leerMovimientosDelEstado`), so «Por comercio», «Llega a tu banco» and «Te queda» come from the same rows and
 * the same moment of the database: hora real (D93), COMPLETED, the merchant and method filters (D9.2), never a cash payment
 * that carries a merchant (it is in the drawer). Here only the names and the active settlement rules are looked up.
 */
export async function buildMerchantAccountBreakdown(rows: MerchantSums[]): Promise<MerchantAccountBreakdown[]> {
  if (rows.length === 0) return []

  const merchantAccountIds = rows.map(r => r.merchantAccountId)
  const accounts = await prisma.merchantAccount.findMany({
    where: { id: { in: merchantAccountIds } },
    select: {
      id: true,
      displayName: true,
      alias: true,
      angelpayAffiliation: true,
      displayOrder: true,
      provider: { select: { name: true } },
    },
  })
  const byId = new Map(accounts.map(a => [a.id, a]))

  // Active settlement rules per (merchant, card type) — same pattern the Saldo
  // Disponible breakdown uses (effectiveTo IS NULL = currently in force). Lets the
  // UI show "Visa/MC: 1 día hábil · Amex: 3 días hábiles" per merchant.
  const activeConfigs =
    (await prisma.settlementConfiguration.findMany({
      where: { merchantAccountId: { in: merchantAccountIds }, effectiveTo: null },
      select: { merchantAccountId: true, cardType: true, settlementDays: true },
    })) ?? []
  const rulesByMerchant = new Map<string, Array<{ cardType: TransactionCardType; settlementDays: number }>>()
  for (const cfg of activeConfigs) {
    const list = rulesByMerchant.get(cfg.merchantAccountId) ?? []
    list.push({ cardType: cfg.cardType, settlementDays: cfg.settlementDays })
    rulesByMerchant.set(cfg.merchantAccountId, list)
  }

  return rows
    .map(r => {
      const a = byId.get(r.merchantAccountId)
      const collected = round2(Number(r.collected))
      const fee = round2(Number(r.fee))
      const rules = rulesByMerchant.get(r.merchantAccountId)
      return {
        merchantAccountId: r.merchantAccountId,
        displayName: a?.displayName || a?.alias || 'Comercio',
        provider: a?.provider?.name ?? '',
        affiliation: a?.angelpayAffiliation ?? null,
        collectedOnCard: collected,
        platformFee: fee,
        netToReceive: round2(collected - fee),
        transactionCount: Number(r.txns),
        ...(rules?.length ? { settlementRules: rules } : {}),
        refunds: round2(Number(r.refunds ?? 0)),
        refundCount: Number(r.refundCount ?? 0),
      }
    })
    .sort((x, y) => y.collectedOnCard - x.collectedOnCard)
}

/**
 * Settlement projection (Entrega 2) — "¿cuándo cae el dinero de tarjeta?"
 *
 * Loads the card payments in range, finds the SettlementConfiguration active at
 * each payment's createdAt (matched by effectiveFrom/effectiveTo, NOT just the
 * currently-active row), and projects the settlement date with the same engine
 * Saldo Disponible uses (calculateSettlementDate → business days + MX holidays +
 * cutoff). It then groups by (settlementDate, merchant).
 *
 * Estimate only: a payment with no matching config is skipped (honest "—" — it
 * can't be projected). Cash never enters here (it's immediate). Returns the
 * calendar plus, per merchant, the soonest upcoming settlement date for the
 * breakdown's "Cae" column.
 */
/**
 * Página del recorrido de pagos de la proyección (query-guard 2026-09-18).
 *
 * Este resumen sirve también a la TPV (`GET /mobile/venues/:id/reports/sales-summary`).
 * Medido en producción el 15 y el 18-sep: 2,274 filas por llamada, pedidas desde una
 * terminal en el mostrador. Es hermano de `getSettlementsLandingInWeek` (arreglado el
 * 7-sep) y del calendario del superadmin: mismo motor, mismo patrón de traer-y-proyectar.
 */
const SETTLEMENT_PROJECTION_PAGE_SIZE = 500

function cederElEventLoopProyeccion(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

export async function computeSettlementProjection(
  venueId: string,
  startDate: Date,
  endDate: Date,
  venueTimezone: string,
  merchantAccountId?: string,
  /** Carril C: también lee los cobros sin costo para contarlos como «sin fecha». Sólo el estado de cuenta lo pide (la MCP no). */
  contarSinFecha = false,
): Promise<{
  calendar: SettlementCalendarDay[]
  nextByMerchant: Map<string, { nextDate: string | null; settlementDays: number | null }>
  /** Carril C: por comercio, el neto de los cobros que no se pudieron proyectar (sin costo todavía o sin regla de depósito). */
  unprojectedByMerchant: Map<string, number>
}> {
  // Los mismos cobros que «Por comercio» (hora real y, si hay, sólo el comercio filtrado, D9.2). La fecha de
  // depósito se sigue calculando con `createdAt`. Los que no tienen costo también se leen: no entran al calendario (como antes),
  // pero su neto se cuenta como «sin fecha estimada» en vez de deducirlo restando dos sumas distintas (Codex r1 del carril C, #6).
  // Sólo cobros de terminal que deposita Avoqado (`destinationOf` = terminal): un efectivo con comercio está en el cajón y una
  // devolución por transferencia sólo se registra (Codex r3 #2 y #5).
  const paymentWhere = dondeHoraRealEntre(
    {
      venueId,
      status: 'COMPLETED' as const,
      AND: [
        WHERE_COBRO_DE_TERMINAL_DE_AVOQADO,
        ...(merchantAccountId ? [{ merchantAccountId }] : []),
        // Sin costo no hay fecha: sólo se leen si alguien va a contar ese dinero como «sin fecha» (Codex r5 #5).
        ...(contarSinFecha ? [] : [{ transactionCost: { isNot: null } }]),
      ],
    },
    startDate,
    endDate,
  )

  // Las reglas y los nombres se cargan conforme APARECEN los comercios en cada página, una
  // vez cada uno: antes se pedían de golpe con la lista completa de comercios, que sólo se
  // conocía tras hidratar todos los pagos.
  const configs: ActiveConfig[] = []
  const comerciosCargados = new Set<string>()
  const nameById = new Map<string, string>()

  async function cargarNombresFaltantes(ids: Array<string | null>): Promise<void> {
    const faltantes: string[] = []
    for (const id of ids) {
      if (!id || nameById.has(id)) continue
      nameById.set(id, 'Comercio') // reserva el hueco para no volver a pedirlo
      faltantes.push(id)
    }
    if (faltantes.length === 0) return
    const filas = await prisma.merchantAccount.findMany({
      where: { id: { in: faltantes } },
      select: { id: true, displayName: true, alias: true },
    })
    for (const a of filas) nameById.set(a.id, a.displayName || a.alias || 'Comercio')
  }

  const todayKey = formatInTimeZone(new Date(), venueTimezone, 'yyyy-MM-dd')

  // dateKey -> merchantId -> accumulator
  const days = new Map<string, Map<string, SettlementCalendarMerchant>>()
  // merchantId -> { dates seen, settlementDays of the matched config }
  const datesByMerchant = new Map<string, { dates: Set<string>; settlementDays: number | null }>()
  const unprojectedByMerchant = new Map<string, number>()

  let cursorId: string | undefined
  while (true) {
    const pagina = await prisma.payment.findMany({
      where: paymentWhere,
      select: {
        id: true,
        amount: true,
        tipAmount: true,
        createdAt: true,
        merchantAccountId: true,
        transactionCost: {
          select: { transactionType: true, venueChargeAmount: true, venueFixedFee: true },
        },
      },
      orderBy: [{ id: 'asc' }], // clave única: sin ella una página puede repetir u omitir filas
      take: SETTLEMENT_PROJECTION_PAGE_SIZE,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    })
    if (pagina.length === 0) break

    const idsDeLaPagina = pagina.map(p => p.merchantAccountId)
    await cargarReglasFaltantes(idsDeLaPagina, comerciosCargados, configs)
    await cargarNombresFaltantes(idsDeLaPagina)

    for (const p of pagina) {
      const merchantId = p.merchantAccountId
      if (!merchantId) continue

      // configs is ordered effectiveFrom desc, so projectPaymentSettlement's `find`
      // picks the most recent config whose window contains the payment date.
      const projection = projectPaymentSettlement({ ...p, merchantAccountId: merchantId }, configs, venueTimezone)
      if (!projection) {
        // No cost or no matching rule → can't project honestly; out of the calendar, counted as «sin fecha estimada».
        const tc = p.transactionCost
        const bruto = Number(p.amount) + Number(p.tipAmount ?? 0)
        const neto = tc ? proyectarComisionYNeto(bruto, tc.venueChargeAmount, tc.venueFixedFee).net : bruto
        unprojectedByMerchant.set(merchantId, (unprojectedByMerchant.get(merchantId) ?? 0) + neto)
        continue
      }

      const { settlementDateKey: dateKey, commission: fee, net, settlementDays } = projection

      if (!days.has(dateKey)) days.set(dateKey, new Map())
      const merchantsForDay = days.get(dateKey)!
      if (!merchantsForDay.has(merchantId)) {
        merchantsForDay.set(merchantId, {
          merchantAccountId: merchantId,
          displayName: nameById.get(merchantId) ?? 'Comercio',
          platformFee: 0,
          netToReceive: 0,
          transactionCount: 0,
        })
      }
      const slot = merchantsForDay.get(merchantId)!
      slot.platformFee += fee
      slot.netToReceive += net
      slot.transactionCount += 1

      const md = datesByMerchant.get(merchantId)
      if (!md) {
        datesByMerchant.set(merchantId, { dates: new Set([dateKey]), settlementDays })
      } else {
        md.dates.add(dateKey)
        // Only report a rule when it is unambiguous: a merchant whose card types
        // settle differently (e.g. debit 1 day, Amex 3) gets null instead of a
        // last-write-wins value that depends on payment iteration order.
        if (md.settlementDays !== settlementDays) md.settlementDays = null
      }
    }

    // Una página corta es la última: no se pide una consulta de más.
    if (pagina.length < SETTLEMENT_PROJECTION_PAGE_SIZE) break
    cursorId = pagina[pagina.length - 1].id
    await cederElEventLoopProyeccion()
  }

  const calendar: SettlementCalendarDay[] = Array.from(days.entries())
    .map(([date, merchants]) => {
      // Accumulate raw, round once at the output boundary (cents).
      const byMerchant = Array.from(merchants.values())
        .map(m => ({ ...m, platformFee: round2(m.platformFee), netToReceive: round2(m.netToReceive) }))
        .sort((a, b) => b.netToReceive - a.netToReceive)
      const totalNet = round2(byMerchant.reduce((s, m) => s + m.netToReceive, 0))
      const status: SettlementCalendarDay['status'] = date < todayKey ? 'settled' : date === todayKey ? 'pending' : 'projected'
      return { date, status, totalNet, byMerchant }
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

  // Per merchant: soonest date that is today-or-future; if all are past, the most recent past date.
  const nextByMerchant = new Map<string, { nextDate: string | null; settlementDays: number | null }>()
  for (const [merchantId, { dates, settlementDays }] of datesByMerchant) {
    const sorted = Array.from(dates).sort()
    const upcoming = sorted.filter(d => d >= todayKey)
    const nextDate = upcoming.length > 0 ? upcoming[0] : sorted.length > 0 ? sorted[sorted.length - 1] : null
    nextByMerchant.set(merchantId, { nextDate, settlementDays })
  }

  for (const [id, neto] of unprojectedByMerchant) unprojectedByMerchant.set(id, round2(neto))
  return { calendar, nextByMerchant, unprojectedByMerchant }
}

/**
 * Las cifras de tarjetas de regalo del rango (spec §7), en SQL y en tres lecturas acotadas a agregados:
 * - cargado: renglones con `giftCardId` de cuentas PAGADAS creadas en el rango (misma base de fecha que las ventas brutas);
 * - cancelado: `REFUND` del rango cuya cuenta es de tarjetas y está PAGADA (la parte de venta, sin propina, como lo cargado). Sólo
 *   las pagadas: el abono devuelto de una venta que nunca se pagó no restó nada de lo cargado y no puede dejar la cifra negativa;
 * - pagado con saldo: cobros del tender de sistema del rango, venta + propina, y sus reversos. Sólo de tarjetas VENDIDAS (S8b): la parte
 *   de cada canje que salió de un sobre de saldo a favor (`montoSaldoAFavorSql`) va con las devoluciones a saldo en `storeCreditNet`.
 */
export async function computeGiftCardFigures(
  venueId: string,
  start: Date,
  end: Date,
  merchantAccountId?: string,
): Promise<GiftCardFigures> {
  const porComercioDeOrden = merchantAccountId
    ? Prisma.sql`AND o.id IN (SELECT "orderId" FROM "Payment" WHERE "merchantAccountId" = ${merchantAccountId})`
    : Prisma.empty
  const porComercioDeCobro = merchantAccountId ? Prisma.sql`AND p."merchantAccountId" = ${merchantAccountId}` : Prisma.empty
  const [cargas, cancelaciones, saldo] = await Promise.all([
    prisma.$queryRaw<Array<{ amount: string; count: number }>>`
      SELECT COALESCE(SUM(oi.total), 0)::text AS amount, COUNT(*)::int AS count
      FROM "OrderItem" oi
      JOIN "Order" o ON o.id = oi."orderId"
      WHERE o."venueId" = ${venueId}
        AND o."createdAt" >= ${utcTs(start)}
        AND o."createdAt" <= ${utcTs(end)}
        AND o."paymentStatus" = 'PAID'
        AND oi."giftCardId" IS NOT NULL
        ${porComercioDeOrden}
    `,
    prisma.$queryRaw<Array<{ amount: string }>>`
      SELECT COALESCE(SUM(ABS(p.amount)), 0)::text AS amount
      FROM "Payment" p
      JOIN "Order" o ON o.id = p."orderId"
      WHERE p."venueId" = ${venueId}
        AND p."createdAt" >= ${utcTs(start)}
        AND p."createdAt" <= ${utcTs(end)}
        AND p.type = 'REFUND'
        AND p.status = 'COMPLETED'
        AND o."paymentStatus" = 'PAID'
        AND EXISTS (SELECT 1 FROM "OrderItem" gc_oi WHERE gc_oi."orderId" = p."orderId" AND gc_oi."giftCardId" IS NOT NULL)
        ${porComercioDeCobro}
    `,
    prisma.$queryRaw<
      Array<{ amount: string; count: number; tips: string; reversals: string; storeCreditNet: string; storeCreditCount: number }>
    >`
      SELECT
        COALESCE(SUM(p.amount + p."tipAmount" - sf.monto) FILTER (WHERE t."systemKind" = 'GIFT_CARD' AND p.type IS DISTINCT FROM 'REFUND'), 0)::text AS amount,
        (COUNT(*) FILTER (WHERE t."systemKind" = 'GIFT_CARD' AND p.type IS DISTINCT FROM 'REFUND' AND p.amount + p."tipAmount" > sf.monto))::int AS count,
        COALESCE(SUM(ROUND(p."tipAmount" * (p.amount + p."tipAmount" - sf.monto) / NULLIF(p.amount + p."tipAmount", 0), 2))
          FILTER (WHERE t."systemKind" = 'GIFT_CARD' AND p.type IS DISTINCT FROM 'REFUND'), 0)::text AS tips,
        COALESCE(SUM(ABS(p.amount + p."tipAmount") - sf.monto) FILTER (WHERE t."systemKind" = 'GIFT_CARD' AND p.type = 'REFUND'), 0)::text AS reversals,
        COALESCE(SUM(CASE
          WHEN t."systemKind" = 'STORE_CREDIT' THEN p.amount + p."tipAmount"
          WHEN p.type = 'REFUND' THEN -sf.monto
          ELSE sf.monto END), 0)::text AS "storeCreditNet",
        (COUNT(*) FILTER (WHERE t."systemKind" = 'STORE_CREDIT' OR sf.monto > 0))::int AS "storeCreditCount"
      FROM "Payment" p
      JOIN "VenueTenderType" t ON t."venueId" = p."venueId" AND t.id = p."tenderTypeId"
      CROSS JOIN LATERAL (SELECT ${montoSaldoAFavorSql('p')} AS monto) sf
      WHERE p."venueId" = ${venueId}
        AND p."createdAt" >= ${utcTs(start)}
        AND p."createdAt" <= ${utcTs(end)}
        AND p.status = 'COMPLETED'
        AND t."systemKind" IN ('GIFT_CARD', 'STORE_CREDIT')
        ${porComercioDeCobro}
    `,
  ])
  return {
    loads: round2(Number(cargas[0]?.amount ?? 0)),
    loadsCount: Number(cargas[0]?.count ?? 0),
    loadRefunds: round2(Number(cancelaciones[0]?.amount ?? 0)),
    balancePaid: round2(Number(saldo[0]?.amount ?? 0)),
    balanceCount: Number(saldo[0]?.count ?? 0),
    balanceTips: round2(Number(saldo[0]?.tips ?? 0)),
    balanceReversals: round2(Number(saldo[0]?.reversals ?? 0)),
    storeCreditNet: round2(Number(saldo[0]?.storeCreditNet ?? 0)),
    storeCreditCount: Number(saldo[0]?.storeCreditCount ?? 0),
  }
}

/**
 * Get sales summary for a venue within a date range
 */
export async function getSalesSummary(venueId: string, filters: SalesSummaryFilters): Promise<SalesSummaryResponse> {
  const {
    startDate,
    endDate,
    groupBy = 'none',
    reportType = 'summary',
    timezone = 'America/Mexico_City',
    merchantAccountId,
    paymentMethod,
    cardType,
  } = filters

  // Validate dates
  const parsedStartDate = new Date(startDate)
  const parsedEndDate = new Date(endDate)

  if (isNaN(parsedStartDate.getTime())) {
    throw new BadRequestError(`Invalid startDate: ${startDate}`)
  }
  if (isNaN(parsedEndDate.getTime())) {
    throw new BadRequestError(`Invalid endDate: ${endDate}`)
  }

  // When a payment-method filter is active, order-derived metrics become
  // misleading (a single order can be paid by mixed methods). We compute only
  // payment-derived metrics and return null for grossSales/items/discounts/
  // taxes/deferred — frontend hides those rows.
  const isFiltered = !!paymentMethod
  // D9.1 (21-nov-2026): con un comercio elegido la vista también es «de movimientos», como con un método: una cuenta de $300
  // pagada $100 con el comercio A y $200 en efectivo no es una venta de A de $300. Las métricas de orden van en null y lo cobrado
  // sale de los pagos de ese comercio. Los desgloses por método (estado de cuenta) conservan su compuerta `isFiltered`.
  const vistaDeMovimientos = isFiltered || !!merchantAccountId

  // QR_LEGACY short-circuit. This filter only makes sense for MindForm (the one
  // venue with legacy avo-pwa QR payments). We compute the summary directly from
  // the legacy DB and skip the 8 native queries entirely — the native Payment
  // table has no QR_LEGACY rows, and buildPaymentWhereFilter throws on QR_LEGACY.
  if (paymentMethod === 'QR_LEGACY') {
    // Only MindForm has legacy QR data. Controller already rejects QR_LEGACY
    // for other venues; this is defense-in-depth. D9.1 (Codex r1 #8): the legacy QR rows have no merchant account, so with a
    // merchant chosen nothing of them belongs to it.
    if (venueId !== MINDFORM_NEW_VENUE_ID || merchantAccountId) {
      return {
        dateRange: { startDate: parsedStartDate, endDate: parsedEndDate },
        reportType,
        summary: emptySummary(),
        filtered: true,
      }
    }

    let amount = 0
    let tips = 0
    let legacyCount = 0
    const paginas = await forEachLegacyPaymentPage(
      { startDate: parsedStartDate.toISOString(), endDate: parsedEndDate.toISOString() },
      rows => {
        for (const payment of rows) {
          if (payment.status !== 'COMPLETED' || payment.type === 'REFUND') continue
          amount += Number(payment.amount)
          tips += Number(payment.tipAmount)
          legacyCount += 1
        }
      },
    )
    const summary: SalesSummaryMetrics = {
      ...emptySummary(),
      tips,
      totalCollected: amount + tips,
      netProfit: amount,
      transactionCount: legacyCount,
    }

    // For a non-summary reportType, build the time-series from legacy alone so
    // the period bars match this legacy-only headline total. Order-derived
    // metrics are null; payment-derived metrics come from the legacy aggregate.
    let byPeriod: TimePeriodMetrics[] | undefined
    // The headline total above is partial if the page walk failed; the period query below can only ADD to the flag.
    let legacyUnavailable = paginas.unavailable
    if ((reportType as string) !== 'summary') {
      const legacyPeriod = await getLegacyPeriodMetrics(
        parsedStartDate.toISOString(),
        parsedEndDate.toISOString(),
        reportType as LegacyPeriodReportType,
        timezone, // no methodFilter — all legacy
      )
      legacyUnavailable ||= legacyPeriod.unavailable
      const legacyRowsByPeriod = legacyPeriod.rows
      const legacyMap = new Map(legacyRowsByPeriod.map(r => [r.periodKey, r]))
      const allPeriods = generateAllPeriods(reportType)
      if (allPeriods.length > 0) {
        // Sum types (hourlySum/dailySum): iterate the fixed 0-23 / 0-6 buckets,
        // filling zeros for periods with no legacy rows.
        byPeriod = allPeriods.map(periodValue => {
          const legacy = legacyMap.get(String(Number(periodValue)))
          return {
            period: formatPeriod(periodValue, reportType, timezone),
            periodLabel: formatPeriodLabel(periodValue, reportType, timezone),
            metrics: legacyOnlyMetrics(legacy?.amount ?? 0, legacy?.tips ?? 0, legacy?.count ?? 0),
          }
        })
      } else {
        // Date types: iterate the legacy period keys (epoch-ms → Date).
        byPeriod = legacyRowsByPeriod.map(r => {
          const periodValue = new Date(Number(r.periodKey))
          return {
            period: formatPeriod(periodValue, reportType, timezone),
            periodLabel: formatPeriodLabel(periodValue, reportType, timezone),
            metrics: legacyOnlyMetrics(r.amount, r.tips, r.count),
          }
        })
      }
    }

    // Carril C: con el desglose pedido (exporte / MCP), el estado del periodo de ese filtro también: todo es «otros» (esos cobros
    // no tienen comercio ni los deposita Avoqado). Sin esto, `sections=statement` salía vacío con dinero encontrado (Codex r4 #4).
    const vacio = (): MoneyDestination => ({
      collected: 0,
      refunds: 0,
      refundCount: 0,
      platformFee: 0,
      netToReceive: 0,
      transactionCount: 0,
    })
    const legado = round2(amount + tips)
    const estadoLegado: StatementDestinations | undefined = filters.includeMerchantBreakdown
      ? {
          drawer: vacio(),
          terminal: vacio(),
          online: vacio(),
          // Con un comercio elegido, nada: esos cobros no tienen comercio (como en la ruta normal; Codex r5 #1).
          other: merchantAccountId ? vacio() : { ...vacio(), collected: legado, netToReceive: legado, transactionCount: legacyCount },
          tenderCommissions: 0,
        }
      : undefined
    return {
      dateRange: { startDate: parsedStartDate, endDate: parsedEndDate },
      reportType,
      summary,
      byPeriod,
      ...(estadoLegado ? { byMerchantAccount: [], statementDestinations: estadoLegado } : {}),
      filtered: true,
      ...(legacyUnavailable ? { legacyUnavailable: true as const } : {}),
    }
  }

  const paymentWhereFilter = buildPaymentWhereFilter(paymentMethod, cardType)
  // D9.1 (Codex r1 #7): la TPV guarda el comercio del serial también en un cobro en EFECTIVO; ese dinero no es de ese comercio.
  // Un solo `AND` con las piezas: el filtro de tarjeta trae su propio `AND` y un spread lo pisaría.
  const filtrosDePago: Prisma.PaymentWhereInput[] = [
    ...(merchantAccountId ? [{ merchantAccountId }, NOT_DRAWER_CASH_WHERE] : []),
    ...(paymentMethod ? [paymentWhereFilter] : []),
  ]
  const paymentLevelFilter: Prisma.PaymentWhereInput = filtrosDePago.length > 0 ? { AND: filtrosDePago } : {}
  // El gemelo en SQL del filtro de comercio, para las consultas crudas (parámetro $4).
  const merchantSqlClause = merchantAccountId ? ` AND p."merchantAccountId" = $4 AND NOT ${sqlEsEfectivoDelCajon('p')}` : ''

  logger.info('Calculating sales summary', { venueId, startDate, endDate, groupBy, merchantAccountId, paymentMethod, cardType })

  // Base date filter. Orders and payments are filtered by their REAL time (D93, «B» like Square): the device time of a sale made
  // without internet (`clientCreatedAt`) or, if none, its arrival (`createdAt`). `enElRango` wraps the caller's where in an AND, so
  // it never collides with its own OR/AND keys (card-type filters). Commissions keep their own `createdAt` (`dateFilter`).
  const dateFilter = {
    createdAt: {
      gte: parsedStartDate,
      lte: parsedEndDate,
    },
  }
  const enElRango = <W extends object>(where: W) => dondeHoraRealEntre(where, parsedStartDate, parsedEndDate)

  // Payment-level merchant filter for the by-method breakdowns below (which keep their own gate). D9.1 (Codex r2 #6): never the
  // cash a TPV stamped with the merchant of its serial — same pieces as `filtrosDePago`, to go inside each `AND`.
  const filtroDeComercio: Prisma.PaymentWhereInput[] = merchantAccountId ? [{ merchantAccountId }, NOT_DRAWER_CASH_WHERE] : []

  // Kick off the filtered payment-volume query in parallel with the rest of
  // the core-metric awaits below. We need this number only when deriving
  // totalCollected/netProfit under a filter; awaiting at the derived-metrics
  // block lets the other 8 queries run concurrently with this one.
  const paymentVolumeForFilteredPromise: Promise<number> = vistaDeMovimientos
    ? prisma.payment
        .aggregate({
          where: enElRango({ venueId, status: 'COMPLETED' as const, ...paymentLevelFilter }),
          _sum: { amount: true },
        })
        .then(r => Number(r._sum.amount || 0))
    : Promise.resolve(0)

  // ============================================================
  // Calculate Core Metrics
  // ============================================================

  // 1. Gross Sales, service charges, taxes, Discounts and the hidden giveaways — ONE statement, ONE snapshot.
  // Skipped in the movement view (payment-method or merchant filter) — orders can't be honestly split per bucket.
  //
  // D6 (base de caja, founder 15-sep-2026): only accounts that are a SALE — collected (`sqlCuentaCobrada`), not a draft,
  // cancelled or deleted, and not a gift-card sale. An open or half-paid account goes to «Sin cobrar» (query 4).
  // D2: `serviceChargeAmount` is taxable revenue that adds to the account total (`computeStoredOrderTotal`), never inside the
  // subtotal: it is its own sum and grossSales = items + serviceCosts.
  //
  // Discounts are the EFFECTIVE merchandise discount PER ORDER, LEAST(discountAmount, subtotal): since B2/B2c the header is
  // the Σ of the discount rows WITHOUT a cap (a cortesía on top of an account-level fixed discount leaves it above the
  // subtotal); charging caps the merchandise at 0 (`computeStoredOrderTotal`), so subtracting the nominal header turned a $0
  // account into a negative sale (Codex B2c r1, P2). The cap goes INSIDE the SUM: capping the period total would let one
  // order's excess eat another order's sales.
  // 🔴 The gross and the discount MUST come from the same statement (Codex B2c r2): read in two queries, a sale saved between
  // them counted its discount but not its gross ($100 + an interleaved $200 − $150 ⇒ net −$50).
  //
  // 1b. The hidden giveaways (Square-style Discounts & Comps), in the SAME statement and over the SAME accounts. Promotion lines
  // and mobile/TABLE_SERVICE cortesías follow the NET convention: their giveaway is in neither Order.subtotal nor
  // Order.discountAmount, so the report showed a $200-catalog combo sold at $99 as $99 gross / $0 discounts. Cobrar cortesías
  // are excluded by total=0 (they already create an OrderDiscount COMP row — counting them here would double-count). Same
  // lateral sums as the period query, so the bars keep summing to the headline.
  //
  // 🔴 «Sin cobrar» (query 4 de antes) sale del MISMO enunciado (Codex r2 #3): leídos en dos, una mesa liquidada entre las dos
  // lecturas salía abierta en la primera y pagada en la segunda, y desaparecía de las dos. Una cuenta abierta que sus cobros ya
  // cubren es venta y no está «Sin cobrar» (Codex r2 #5: la misma bandera para las dos, sin tolerancias distintas).
  const grossSalesResult = !vistaDeMovimientos
    ? await prisma
        .$queryRawUnsafe<
          Array<{
            subtotal: Prisma.Decimal | null
            service: Prisma.Decimal | null
            tax: Prisma.Decimal | null
            discounts: Prisma.Decimal | null
            promo_discount_cents: Prisma.Decimal | null
            comp_given_away: Prisma.Decimal | null
            deferred: Prisma.Decimal | null
            unpaid: Prisma.Decimal | null
            cuentas: number | null
          }>
        >(
          `
      SELECT SUM(subtotal + ${sqlImpuestoQueSeCobraAparte()}) FILTER (WHERE cuenta.es_venta) AS subtotal,
             SUM("serviceChargeAmount") FILTER (WHERE cuenta.es_venta) AS service,
             SUM("taxAmount") FILTER (WHERE cuenta.es_venta) AS tax,
             SUM(LEAST("discountAmount", subtotal)) FILTER (WHERE cuenta.es_venta) AS discounts,
             SUM(promo."discount_cents") FILTER (WHERE cuenta.es_venta) AS promo_discount_cents,
             SUM(comp."given_away") FILTER (WHERE cuenta.es_venta) AS comp_given_away,
             SUM("remainingBalance") FILTER (WHERE cuenta.abierta) AS deferred,
             SUM(cuenta.falta) FILTER (WHERE cuenta.abierta AND NOT cuenta.es_venta) AS unpaid,
             (COUNT(*) FILTER (WHERE cuenta.abierta AND NOT cuenta.es_venta AND cuenta.falta > 0.005))::int AS cuentas
      FROM "Order"
      CROSS JOIN LATERAL (
        SELECT ${sqlCuentaCobrada('"Order"')} AS es_venta,
               "Order"."paymentStatus" IN ('PENDING', 'PARTIAL') AS abierta,
               (CASE WHEN "Order"."paymentStatus" IN ('PENDING', 'PARTIAL') THEN ${sqlLoQueFaltaCobrar('"Order"')} ELSE 0 END) AS falta
      ) cuenta
      LEFT JOIN LATERAL (
        SELECT SUM("discountCents") AS discount_cents FROM "OrderPromotion" WHERE "orderId" = "Order".id
      ) promo ON TRUE
      LEFT JOIN LATERAL (
        SELECT SUM("discountAmount") AS given_away FROM "OrderItem" WHERE "orderId" = "Order".id AND "isCortesia" = TRUE AND total = 0
      ) comp ON TRUE
      WHERE "venueId" = $1
        AND ${sqlRangoHoraReal('"Order"', utcTsParam(2), utcTsParam(3))}
        AND status NOT IN ('PENDING', 'CANCELLED', 'DELETED')
        AND ${sqlOrdenSinTarjetasTexto('"Order".id')}
    `,
          venueId,
          parsedStartDate,
          parsedEndDate,
        )
        .then(rows => ({
          subtotal: Number(rows[0]?.subtotal ?? 0),
          serviceCosts: Number(rows[0]?.service ?? 0),
          taxAmount: Number(rows[0]?.tax ?? 0),
          discounts: Number(rows[0]?.discounts ?? 0),
          promoDiscountCents: Number(rows[0]?.promo_discount_cents ?? 0),
          hiddenCompPesos: Number(rows[0]?.comp_given_away ?? 0),
          deferred: Number(rows[0]?.deferred ?? 0),
          unpaid: Number(rows[0]?.unpaid ?? 0),
          cuentas: Number(rows[0]?.cuentas ?? 0),
        }))
    : null

  // 2. Items - Using Order.subtotal (more reliable than OrderItem aggregation
  // because some orders synced from POS don't have OrderItem records)
  // NOTE: items = grossSalesResult.subtotal (already queried above)
  const promoDiscountCents = grossSalesResult?.promoDiscountCents ?? 0
  const hiddenCompPesos = grossSalesResult?.hiddenCompPesos ?? 0

  // 3. Refunds — sum of refund Payments (type=REFUND, status=COMPLETED).
  // The legacy query filtered `status='REFUNDED'` which matched a handful of
  // pre-sprint hack records (original Payments flipped to status=REFUNDED with
  // a negative amount) and missed every real refund since the 2026-04 refund
  // sprint, which creates Payments with type=REFUND, status=COMPLETED, negative
  // amount and negative tipAmount (post-2026-04-19 tip split fix).
  const refundsResult = await prisma.payment.aggregate({
    where: enElRango({
      venueId,
      type: 'REFUND' as const,
      ...paymentLevelFilter,
      // Tarjetas de regalo: la cancelación de una venta de tarjetas no es devolución de mercancía (resta de «tarjetas cargadas»).
      // El REFUND de un cobro con saldo SÍ se queda: devuelve mercancía.
      // Codex r3 #1 (pedidos en línea): la devolución de una cuenta que NO cuenta como venta (cancelada o borrada) tampoco se
      // resta, igual que su venta no se suma arriba. Sin esto, devolver un pedido rechazado que el negocio había cobrado a mano en
      // su Stripe dejaba las ventas netas en −$250. Codex r4 H5: sólo sin filtro de método; filtrada, la vista es de movimientos
      // (ventas netas nulas, cobrado = suma con signo) y la devolución que sí salió se ve.
      // Codex r2 #7: en la vista de movimientos (método o comercio) TODA devolución que salió, también la cancelación de una venta de
      // tarjetas de regalo: «Total cobrado» ahí ya la resta (suma con signo) y sin esto «Devoluciones» no la explicaba.
      ...(vistaDeMovimientos
        ? {}
        : {
            order: {
              ...WHERE_ORDEN_SIN_TARJETAS,
              status: { notIn: ['CANCELLED', 'DELETED'] as Array<'CANCELLED' | 'DELETED'> },
            },
          }),
    }),
    _sum: {
      amount: true,
      tipAmount: true,
      // D6 (Codex r1 #2): lo que una devolución de un ABONO volvió a deber (D19). No devuelve mercancía: la cuenta sigue abierta y
      // lo debe en «Sin cobrar». En la vista de ventas no se resta (antes: $100 abonados $40 y devueltos ⇒ −$40 de venta neta).
      reopenedAmount: true,
      // Codex r2 #4: y la propina de ese abono, que también vuelve a deberse.
      reopenedTipAmount: true,
    },
    _count: true,
  })

  // 4. Las cuentas abiertas («Ventas diferidas» y, D6, «Sin cobrar») salen del enunciado 1 (Codex r2 #3).
  const openAccountsResult = grossSalesResult

  // 5. Tips - From completed payments (more accurate than order tips)
  // D6 (Codex r4 #1): en la vista de ventas, sin los cobros de una cuenta abierta que todavía no es venta (un abono): su propina,
  // su comisión y su transacción entran cuando la cuenta se cobra completa, igual que su venta. Ahí, propinas y transacciones salen
  // de un solo enunciado en SQL (el predicado no cabe en Prisma); en la vista de movimientos, como siempre.
  const cobrosDeVentas = !vistaDeMovimientos
    ? await prisma
        .$queryRawUnsafe<Array<{ tips: Prisma.Decimal | null; cobros: number | null }>>(
          `
    SELECT SUM(p."tipAmount") AS tips,
           (COUNT(*) FILTER (WHERE p.type IS DISTINCT FROM 'REFUND' AND ${sqlOrdenSinTarjetasTexto('p."orderId"')}))::int AS cobros
    FROM "Payment" p
    WHERE p."venueId" = $1
      AND ${sqlRangoHoraReal('p', utcTsParam(2), utcTsParam(3))}
      AND p."status" = 'COMPLETED'
      AND NOT ${sqlCobroDeCuentaSinCobrar('p')}
  `,
          venueId,
          parsedStartDate,
          parsedEndDate,
        )
        .then(rows => ({ tips: Number(rows[0]?.tips ?? 0), cobros: Number(rows[0]?.cobros ?? 0) }))
    : null
  const tipsResult = vistaDeMovimientos
    ? await prisma.payment.aggregate({
        where: enElRango({
          venueId,
          status: 'COMPLETED' as const,
          ...paymentLevelFilter,
        }),
        _sum: {
          tipAmount: true,
        },
      })
    : null

  // 6. Platform Fees (Avoqado fees) - From TransactionCost.venueChargeAmount
  // (joined via Payment because TransactionCost has no venueId column).
  // VenueTransaction.feeAmount is currently not synced from TransactionCost,
  // so reading the canonical value from TransactionCost avoids reporting $0.
  // The payment-method clause is appended as a SQL fragment from
  // buildPaymentSqlClause — only enum-derived literals (CASH/CREDIT_CARD/etc),
  // never user-supplied strings, so it is safe to concatenate.
  const platformFeesSqlClause = buildPaymentSqlClause(paymentMethod, cardType, 'p')
  const platformFeesMerchantClause = merchantSqlClause
  // Codex r4 H1: un cobro sin TransactionCost (Stripe de pedidos en línea, ligas) trae su comisión en `Payment.feeAmount`; las filas de
  // costo de siempre se conservan todas (cualquier estado del pago), y sólo se agregan los cobros COMPLETED sin costo.
  const platformFeesQuery = `
    SELECT COALESCE(SUM(${SQL_COMISION_DEL_COBRO}), 0)::float AS sum_fee
    FROM "Payment" p
    LEFT JOIN "TransactionCost" tc ON tc."paymentId" = p.id
    WHERE p."venueId" = $1
      AND ${sqlRangoHoraReal('p', utcTsParam(2), utcTsParam(3))}
      AND (tc."id" IS NOT NULL OR p."status" = 'COMPLETED')
      ${vistaDeMovimientos ? '' : `AND NOT ${sqlCobroDeCuentaSinCobrar('p')}`}
      ${platformFeesMerchantClause}
      ${platformFeesSqlClause}
  `
  const platformFeesParams: Array<string | Date> = merchantAccountId
    ? [venueId, parsedStartDate, parsedEndDate, merchantAccountId]
    : [venueId, parsedStartDate, parsedEndDate]
  const platformFeesRows = await prisma.$queryRawUnsafe<Array<{ sum_fee: number }>>(platformFeesQuery, ...platformFeesParams)

  // 7. Staff Commissions (paid to employees) - From CommissionCalculation
  // CommissionCalculation has paymentId → Payment.merchantAccountId for filtering
  const hasPaymentFilter = vistaDeMovimientos
  const staffCommissionsResult = filters.skipStaffCommissions
    ? null
    : await prisma.commissionCalculation.aggregate({
        where: {
          venueId,
          createdAt: dateFilter.createdAt,
          status: { not: 'VOIDED' },
          ...(hasPaymentFilter ? { payment: paymentLevelFilter } : {}),
        },
        _sum: {
          netCommission: true,
        },
      })

  // 8. Transaction Count - Completed CHARGES
  // Tarjetas de regalo (B5 r1, M-2): sin filtro de método, los cobros se cuentan como las ventas brutas, sin los de cuentas de
  // tarjetas (lo pagado con saldo SÍ cuenta). Con filtro es la vista de dinero y no se toca.
  // D10.1 (21-nov-2026): una devolución también es COMPLETED, pero no es una transacción de venta: «Ventas brutas $100 · 2
  // transacciones» con un cobro y una devolución. Se cuentan cobros; las devoluciones llevan su conteo aparte (`refundCount`).
  // NULL-safe: un cobro viejo con `type` NULL sí cuenta (Prisma `not` sola deja fuera los NULL).
  const transactionCountResult = cobrosDeVentas
    ? cobrosDeVentas.cobros
    : await prisma.payment.count({
        where: enElRango({
          venueId,
          status: 'COMPLETED' as const,
          AND: [...filtrosDePago, { OR: [{ type: null }, { type: { not: 'REFUND' as const } }] }],
        }),
      })

  // 9. D1 · Comisiones de terceros (Rappi, Uber Eats, DiDi y los tipos de pago propios con comisión): la congelada en cada cobro, con
  // signo (el ajuste del proveedor la regresa en negativo; una devolución manual no hereda comisión). Aparte de las de Avoqado: en
  // ese carril `feeAmount` es 0, así que no hay doble resta. Vista de ventas: sólo la de cobros de cuentas que son venta.
  const tenderCommissionsRows = await prisma.$queryRawUnsafe<Array<{ total: Prisma.Decimal | null }>>(
    `
    SELECT SUM(${sqlComisionDeTerceros('p', vistaDeMovimientos)}) AS total
    FROM "Payment" p
    WHERE p."venueId" = $1
      AND ${sqlRangoHoraReal('p', utcTsParam(2), utcTsParam(3))}
      AND p."status" = 'COMPLETED'
      AND p."tenderCommissionAmount" IS NOT NULL
      ${merchantSqlClause}
      ${platformFeesSqlClause}
  `,
    ...platformFeesParams,
  )

  // ============================================================
  // Calculate Derived Metrics
  // ============================================================

  // Order-derived metrics — null when filtering by paymentMethod/cardType so
  // the frontend hides the rows rather than showing meaningless values.
  // Gross Sales = Item subtotals (Order.subtotal) + service costs
  // Does NOT include taxes or tips (those are shown separately)
  // This follows standard accounting where taxes are pass-through, not revenue
  // Square-style: gross shows the catalog price and the giveaway shows in
  // Discounts — folding the SAME amount into both keeps netSales untouched.
  const { grossSales, items, discounts } = foldGiveawaysIntoSummary(
    {
      grossSales: grossSalesResult ? grossSalesResult.subtotal + grossSalesResult.serviceCosts : null,
      items: grossSalesResult ? grossSalesResult.subtotal : null,
      discounts: grossSalesResult ? grossSalesResult.discounts : null,
    },
    promoDiscountCents,
    hiddenCompPesos,
  )
  const taxes = grossSalesResult ? grossSalesResult.taxAmount : null
  const deferredSales = openAccountsResult ? openAccountsResult.deferred : null
  const unpaidSales = openAccountsResult ? round2(openAccountsResult.unpaid) : null
  const unpaidOrders = openAccountsResult ? openAccountsResult.cuentas : null
  // D2: los cargos por servicio de las mismas cuentas (`Order.serviceChargeAmount`). Ya están dentro de `grossSales`.
  const serviceCosts = grossSalesResult ? grossSalesResult.serviceCosts : null

  // Payment-derived metrics — always computed (filter or not).
  // Refund amounts are stored negative on Payment.amount/tipAmount. Sum both so
  // the total includes the tip portion (tip split fix 2026-04-19), take abs so
  // downstream consumers treat "refunds" as a positive magnitude.
  // D6 (Codex r1 #2): en la vista de ventas, la parte de una devolución que sólo regresó un ABONO (y volvió a deberse) no es
  // devolución de venta. En la vista de movimientos sí: ese dinero salió.
  const abonosDevueltos = vistaDeMovimientos
    ? 0
    : Number(refundsResult._sum.reopenedAmount || 0) + Number(refundsResult._sum.reopenedTipAmount || 0)
  const refunds = Math.max(
    0,
    Math.abs(Number(refundsResult._sum.amount || 0) + Number(refundsResult._sum.tipAmount || 0)) - abonosDevueltos,
  )
  // Codex r4 #2: en la vista de ventas no cuentan las devoluciones que sólo regresaron un abono (su importe tampoco cuenta).
  const devolucionesDeAbono = vistaDeMovimientos
    ? 0
    : await prisma.payment.count({
        where: enElRango({
          venueId,
          type: 'REFUND' as const,
          reopenedAmount: { gt: 0 },
          order: {
            ...WHERE_ORDEN_SIN_TARJETAS,
            status: { notIn: ['CANCELLED', 'DELETED'] as Array<'CANCELLED' | 'DELETED'> },
          },
        }),
      })
  const refundCount = Math.max(0, Number(refundsResult._count || 0) - Number(devolucionesDeAbono || 0))
  const tips = cobrosDeVentas ? cobrosDeVentas.tips : Number(tipsResult?._sum.tipAmount || 0)
  const platformFees = Number(platformFeesRows[0]?.sum_fee || 0)
  const tenderCommissions = round2(Number(tenderCommissionsRows[0]?.total ?? 0))
  const staffCommissions = Number(staffCommissionsResult?._sum.netCommission || 0)

  // Net Sales = Gross Sales - Discounts - Refunds (null when filtered)
  const netSales = grossSales !== null && discounts !== null ? grossSales - discounts - refunds : null

  // Under filter, derive totalCollected and netProfit from filtered payment
  // volume directly (Payment.amount sum) rather than from netSales. The
  // promise was kicked off near the top of the function so it runs in
  // parallel with the other core-metric queries.
  const paymentVolumeForFiltered = await paymentVolumeForFilteredPromise

  // Total Collected = Net Sales + Tips - Platform Fees - Third-party fees (D1)
  // Mexico model: taxes are already included in prices, NOT added on top
  // This represents the actual cash flow (money in account after platform fees)
  const totalCollected = vistaDeMovimientos
    ? paymentVolumeForFiltered + tips - platformFees - tenderCommissions
    : netSales !== null
      ? netSales + tips - platformFees - tenderCommissions
      : 0

  // Net Profit = Net Sales - Platform Fees - Third-party fees - Staff Commissions
  // This is the true profit after all costs to the venue
  // Note: Tips are NOT subtracted here because they are pass-through to employees
  const netProfit = vistaDeMovimientos
    ? paymentVolumeForFiltered - platformFees - tenderCommissions - staffCommissions
    : netSales !== null
      ? netSales - platformFees - tenderCommissions - staffCommissions
      : 0

  const summary: SalesSummaryMetrics = {
    grossSales,
    items,
    serviceCosts,
    discounts,
    refunds,
    netSales,
    deferredSales,
    taxes,
    tips,
    platformFees,
    staffCommissions,
    commissions: platformFees, // Legacy field for backwards compatibility
    totalCollected,
    netProfit,
    transactionCount: transactionCountResult,
    unpaidSales,
    unpaidOrders,
    tenderCommissions,
    refundCount,
  }

  // ⚠️ MindForm legacy QR bridge. Mirrors the gate in
  // payment.dashboard.service.ts and mergedPayments.service.ts.
  // DELETE this block when the native QR module ships — search the repo for
  // MINDFORM_NEW_VENUE_ID (and sumsLegacyQrPayments) to find every gate.
  let legacyAggregate: { amount: number; tips: number; count: number } | null = null
  // D15: true when ANY legacy read of this report could not answer (the page walk here, the period query below).
  let legacyUnavailable = false
  // A filter that admits NO legacy row (OTHER, CARD → DEBIT / AMEX / INTERNATIONAL) never asks the bridge: nothing of it can
  // be part of that total, so its outage cannot make the total incomplete either. Asking anyway copied the bridge failure
  // into a total it does not feed — a false "may be incomplete" (Codex r2 #2). Same gate as the period query below.
  // D9.1 (21-nov): with a merchant chosen nothing of the legacy QR belongs to it (it has no merchant account): not summed, not asked.
  if (sumsLegacyQrPayments(venueId) && legacyAdmission(paymentMethod, cardType).include && !merchantAccountId) {
    legacyAggregate = { amount: 0, tips: 0, count: 0 }
    const paginas = await forEachLegacyPaymentPage(
      { startDate: parsedStartDate.toISOString(), endDate: parsedEndDate.toISOString() },
      rows => {
        for (const payment of rows) {
          if (payment.status !== 'COMPLETED' || payment.type === 'REFUND') continue
          if (!legacyMatchesFilter(payment.method, paymentMethod, cardType)) continue
          legacyAggregate!.amount += Number(payment.amount)
          legacyAggregate!.tips += Number(payment.tipAmount)
          legacyAggregate!.count += 1
        }
      },
    )
    legacyUnavailable = paginas.unavailable

    if (legacyAggregate.count > 0) {
      // Payment-derived totals always include matching legacy volume.
      summary.tips += legacyAggregate.tips
      summary.transactionCount += legacyAggregate.count
      summary.totalCollected += legacyAggregate.amount + legacyAggregate.tips
      summary.netProfit += legacyAggregate.amount

      // Order-derived totals only when NOT filtered (legacy sold real food,
      // so grossSales/netSales should include it on the unfiltered view).
      if (!vistaDeMovimientos) {
        summary.grossSales = (summary.grossSales ?? 0) + legacyAggregate.amount
        summary.items = (summary.items ?? 0) + legacyAggregate.amount
        summary.netSales = (summary.netSales ?? 0) + legacyAggregate.amount
      }
    }
  }

  // ============================================================
  // Tarjetas de regalo (spec §7): «tarjetas cargadas» y «pagado con saldo», aparte de la mercancía. Sólo sin filtro de método.
  // ============================================================
  const tarjetas = !isFiltered ? await computeGiftCardFigures(venueId, parsedStartDate, parsedEndDate, merchantAccountId) : null
  // D9.1: en la vista de movimientos (también con comercio) la cabecera no lleva cifras de orden; «Total cobrado» ahí SÍ trae el
  // dinero de una venta de tarjetas, así que el renglón «cargadas (no es venta)» se contradiría. Los desgloses de abajo las siguen usando.
  if (tarjetas && !vistaDeMovimientos) {
    summary.giftCardLoads = round2(tarjetas.loads - tarjetas.loadRefunds)
    summary.giftCardLoadsCount = tarjetas.loadsCount
    summary.paidWithGiftCardBalance = round2(tarjetas.balancePaid - tarjetas.balanceReversals)
  }

  // Carril G · D5: paquetes en línea y depósitos de reservas, aparte de las ventas (no crean cuenta ni cobro). Como las tarjetas
  // cargadas, sólo en la vista de ventas: en la de movimientos la cabecera son cobros de un método o comercio, y éstos no lo son.
  if (filters.includePrepaid && !vistaDeMovimientos) {
    Object.assign(summary, await computePrepaidOutsideSales(venueId, parsedStartDate, parsedEndDate))
  }

  // ============================================================
  // Payment Method Breakdown (if requested)
  // ============================================================

  let byPaymentMethod: PaymentMethodBreakdown[] | undefined
  let salesByPaymentMethod: PaymentMethodBreakdown[] | undefined

  // Skip breakdown under filter — the user already drilled in to one bucket,
  // a single-row breakdown adds no information.
  if (groupBy === 'paymentMethod' && !isFiltered) {
    const paymentsByMethod = await prisma.payment.groupBy({
      by: ['method'],
      where: enElRango({
        venueId,
        status: 'COMPLETED' as const,
        // Tarjetas de regalo: lo pagado con saldo no se mezcla con OTHER (va en `giftCardBalanceBreakdown`).
        AND: [WHERE_COBRO_NO_ES_SALDO_DE_REGALO, ...filtroDeComercio],
      }),
      _sum: {
        amount: true,
        tipAmount: true,
      },
      _count: true,
    })

    byPaymentMethod = paymentsByMethod.map(p => ({
      method: p.method,
      amount: Number(p._sum.amount || 0) + Number(p._sum.tipAmount || 0),
      count: p._count,
      percentage: 0, // assigned by withPercentages below
    }))

    // Percentages are computed against a tips-INCLUSIVE grand total (the sum of
    // the `amount` fields, which already include tips) so the field is trustworthy
    // for any consumer (e.g. the mobile controller) — `amount` and its percentage
    // share the same basis. Same helper is reused after the legacy bucket is
    // appended so both paths use an identical denominator.
    byPaymentMethod = withPercentages(byPaymentMethod)

    // Append MindForm's legacy QR volume as its own bucket, then recompute every
    // percentage against the new (larger) grand total so the slices still sum to
    // 100%. Depends on the Part D legacyAggregate block above having populated
    // `legacyAggregate` first.
    if (sumsLegacyQrPayments(venueId) && legacyAggregate && legacyAggregate.count > 0) {
      const legacyTotal = legacyAggregate.amount + legacyAggregate.tips
      byPaymentMethod = withPercentages([
        ...(byPaymentMethod ?? []),
        { method: 'QR_LEGACY', amount: legacyTotal, count: legacyAggregate.count, percentage: 0 },
      ])
    }

    // Tarjetas de regalo (full-testing v2 #1): VENTAS por método para la barra bajo «Total de Ventas» (que es ventas): los mismos
    // cobros SIN los de cuentas de tarjetas (sus cargas y sus cancelaciones) y CON lo pagado con saldo como `GIFT_CARD`, neto de
    // reversos y con propina como las demás filas. Sólo en negocios con tarjetas (índice por venueId): sin ninguna, no hay cuentas de
    // tarjetas ni saldo y las dos vistas son la misma, así que no se pregunta nada más.
    if (tarjetas && (await prisma.giftCard.findFirst({ where: { venueId }, select: { id: true } }))) {
      const ventas = await prisma.payment.groupBy({
        by: ['method'],
        where: enElRango({
          venueId,
          status: 'COMPLETED' as const,
          AND: [WHERE_COBRO_NO_ES_SALDO_DE_REGALO, { order: WHERE_ORDEN_SIN_TARJETAS }, ...filtroDeComercio],
        }),
        _sum: { amount: true, tipAmount: true },
        _count: true,
      })
      const saldo = round2(tarjetas.balancePaid - tarjetas.balanceReversals)
      const ventasPorMetodo = ventas.map(p => ({
        method: String(p.method),
        amount: Number(p._sum.amount || 0) + Number(p._sum.tipAmount || 0),
        count: p._count,
        percentage: 0,
      }))
      // Saldo a favor (S8b): sus dos patas —la devolución a saldo y lo gastado de un sobre— son VENTA con su método (OTHER). El filtro
      // de arriba deja fuera todo medio de sistema; sin esto la barra no cuadraba con «Total de ventas» el día de la devolución.
      // Importe y conteo, cada uno por su lado (S10 r2 y r3): la fila sale si hubo alguna pata de saldo a favor (conteo, por pata) o
      // si su neto no es 0; así la compuerta es correcta por sí misma aunque el conteo cambie de regla.
      if (tarjetas.storeCreditCount > 0 || tarjetas.storeCreditNet !== 0) {
        const otro = ventasPorMetodo.find(m => m.method === 'OTHER')
        if (otro) {
          otro.amount = round2(otro.amount + tarjetas.storeCreditNet)
          otro.count += tarjetas.storeCreditCount
        } else ventasPorMetodo.push({ method: 'OTHER', amount: tarjetas.storeCreditNet, count: tarjetas.storeCreditCount, percentage: 0 })
      }
      salesByPaymentMethod = withPercentages([
        ...ventasPorMetodo,
        ...byPaymentMethod.filter(m => m.method === 'QR_LEGACY'),
        // S10 r3: sale con cualquier movimiento de tarjetas vendidas —conteo, bruto o reverso—, aunque el neto sea 0 (gastado y devuelto).
        ...(tarjetas.balanceCount > 0 || tarjetas.balancePaid !== 0 || tarjetas.balanceReversals !== 0
          ? [{ method: 'GIFT_CARD', amount: saldo, count: tarjetas.balanceCount, percentage: 0 }]
          : []),
      ])
    }
  }

  // ============================================================
  // Enriched Payment Method Breakdown (Card → Credit/Debit/AMEX/International) + estado de cuenta (carril C)
  // ============================================================
  // Surfaces the per-bucket platform commission so a venue owner can SEE that
  // e.g. AMEX really costs ~4.5%. Same gate as byPaymentMethod (only on the
  // unfiltered grouped view — under a filter the user already drilled into one
  // bucket, so a single-bucket breakdown adds nothing).
  //
  // Carril C (21-nov-2026): the SAME read also feeds the period statement — where each charge went (`statementDestinations`,
  // one destination per charge) and «Por comercio» (`byMerchantAccount`) — so «Te queda», «Llega a tu banco» and the merchant
  // rows come from the same rows and the same moment of the database (Codex r1/r2 of the lane: two reads could disagree). With
  // `includeMerchantBreakdown` it also runs under a method filter (the export asks «Efectivo» + «Desglose por comercio»): then
  // only the statement pieces come out, never `byPaymentMethodDetailed`.

  let byPaymentMethodDetailed: PaymentMethodDetailedBreakdown[] | undefined
  let statementDestinations: StatementDestinations | undefined
  let merchantSums: MerchantSums[] = []
  const wantsBuckets = groupBy === 'paymentMethod' && !isFiltered
  const wantsStatement = !!filters.includeMerchantBreakdown

  if (wantsBuckets || wantsStatement) {
    // Per-bucket and per-sub-bucket accumulator. `amount` INCLUDES tips for
    // consistency with byPaymentMethod (its `amount` is amount+tipAmount).
    type Acc = {
      amount: number
      count: number
      tips: number
      refunds: number
      platformFees: number
      chargedAmount: number
      chargedCount: number
      tenderCommissions: number
      cancelledOrderRefunds: number
      platformFeesCents: number
    }
    const newAcc = (): Acc => ({
      amount: 0,
      count: 0,
      tips: 0,
      refunds: 0,
      platformFees: 0,
      chargedAmount: 0,
      chargedCount: 0,
      tenderCommissions: 0,
      cancelledOrderRefunds: 0,
      platformFeesCents: 0,
    })
    const buckets = new Map<BreakdownBucket, Acc>()
    const subBuckets = new Map<CardSubBucket, Acc>()
    const ensure = <K>(map: Map<K, Acc>, key: K): Acc => {
      let acc = map.get(key)
      if (!acc) {
        acc = newAcc()
        map.set(key, acc)
      }
      return acc
    }

    // Aggregated IN THE DATABASE, grouped by exactly what bucketOf needs
    // (method, brand, international flag) — a handful of rows whatever the
    // range. Until 2026-09-24 this hydrated ONE ROW PER PAYMENT and added them
    // up in JS: a month of Testarudo was 3,109 rows and tripped the query-guard
    // on the POS Informe de ventas (which always asks for this breakdown).
    //
    // (1) Completed payments with their platform fee (TransactionCost is 1:1 by
    // paymentId, so the LEFT JOIN never fans out). (2) Refund payments, summed
    // as positive magnitudes row by row (ABS inside the SUM, as before).
    // Es DINERO, como `byPaymentMethod`: ni lo pagado con saldo ni la devolución a saldo a favor (S8b: no salió de la caja ni del banco).
    // Carril C: cada grupo trae además lo que decide su DESTINO (`destinationOf`) y su comercio; la cuenta (`Order`) y el cobro
    // original de una devolución se unen 1:1 por llave primaria, así que no multiplican filas.
    // D9.1 (carril C): con comercio, tampoco el efectivo que la TPV guardó con su comercio (no sale en «Ya en tu mano»).
    const merchantSql = merchantAccountId
      ? Prisma.sql`AND p."merchantAccountId" = ${merchantAccountId} AND NOT ${Prisma.raw(sqlEsEfectivoDelCajon('p'))}`
      : Prisma.empty
    // Sólo literales de enum (`buildPaymentSqlClause`), nunca texto del usuario; vacío sin filtro de método.
    const metodoSql = Prisma.raw(buildPaymentSqlClause(paymentMethod, cardType, 'p'))
    type GroupRow = { method: string; cardBrand: string | null; isIntl: boolean; count: number }
    const [completedGroups, refundGroups] = await Promise.all([
      prisma.$queryRaw<
        Array<
          GroupRow & {
            fundsFlow: string | null
            tenderCountsAsCash: boolean | null
            hasTender: boolean
            merchantAccountId: string | null
            enLinea: boolean
            amount: string
            tips: string
            fees: string
            feesCents: string
            chargedAmount: string
            chargedCount: number
            refundAmount: string
            tenderCommissions: string
            cancelledOrderRefunds: string
          }
        >
      >`
        SELECT p."method"::text AS "method",
               p."cardBrand"::text AS "cardBrand",
               ${IS_INTERNATIONAL_SQL} AS "isIntl",
               p."fundsFlow"::text AS "fundsFlow",
               p."tenderCountsAsCash" AS "tenderCountsAsCash",
               (p."tenderTypeId" IS NOT NULL) AS "hasTender",
               p."merchantAccountId" AS "merchantAccountId",
               (${Prisma.raw(sqlEnLineaDeAvoqado('p'))} OR ${Prisma.raw(sqlEnLineaDeAvoqado('orig'))}) AS "enLinea",
               COUNT(*)::int AS "count",
               COALESCE(SUM(p."amount"), 0)::text AS "amount",
               COALESCE(SUM(p."tipAmount"), 0)::text AS "tips",
               COALESCE(SUM(${Prisma.raw(SQL_COMISION_DEL_COBRO)}), 0)::text AS "fees",
               COALESCE(SUM(ROUND((${Prisma.raw(SQL_COMISION_DEL_COBRO)})::numeric, 2)), 0)::text AS "feesCents",
               COALESCE(SUM(p."amount" + p."tipAmount") FILTER (WHERE p."type" IS DISTINCT FROM 'REFUND'), 0)::text AS "chargedAmount",
               (COUNT(*) FILTER (WHERE p."type" IS DISTINCT FROM 'REFUND'))::int AS "chargedCount",
               COALESCE(-SUM(p."amount" + p."tipAmount") FILTER (WHERE p."type" = 'REFUND'), 0)::text AS "refundAmount",
               COALESCE(SUM(COALESCE(p."tenderCommissionAmount", 0)), 0)::text AS "tenderCommissions",
               COALESCE(-SUM(p."amount" + p."tipAmount") FILTER (WHERE p."type" = 'REFUND' AND o."status" IN ('CANCELLED', 'DELETED')), 0)::text AS "cancelledOrderRefunds"
        FROM "Payment" p
        LEFT JOIN "TransactionCost" tc ON tc."paymentId" = p.id
        LEFT JOIN "Order" o ON o.id = p."orderId"
        LEFT JOIN "Payment" orig ON p."type" = 'REFUND' AND orig.id = p."processorData" ->> 'originalPaymentId' AND orig."venueId" = p."venueId"
        WHERE p."venueId" = ${venueId}
          AND ${sqlRangoHoraRealSql('p', parsedStartDate, parsedEndDate)}
          AND p."status" = 'COMPLETED'
          ${merchantSql}
          ${metodoSql}
          AND ${sqlCobroNoEsSaldoDeRegalo('p')}
          AND ${sqlPaymentIsNotExchangeCredit('p')}
          AND ${sqlNoEsDelMedioSaldoAFavor('p')}
        GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
      `,
      wantsBuckets
        ? prisma.$queryRaw<Array<GroupRow & { refunds: string }>>`
        SELECT p."method"::text AS "method",
               p."cardBrand"::text AS "cardBrand",
               ${IS_INTERNATIONAL_SQL} AS "isIntl",
               COUNT(*)::int AS "count",
               COALESCE(SUM(ABS(p."amount" + p."tipAmount")), 0)::text AS "refunds"
        FROM "Payment" p
        WHERE p."venueId" = ${venueId}
          AND ${sqlRangoHoraRealSql('p', parsedStartDate, parsedEndDate)}
          AND p."type" = 'REFUND'
          ${merchantSql}
          AND ${sqlCobroNoEsSaldoDeRegalo('p')}
          AND ${sqlPaymentIsNotExchangeCredit('p')}
          AND ${sqlNoEsDelMedioSaldoAFavor('p')}
        GROUP BY 1, 2, 3
      `
        : Promise.resolve([] as Array<GroupRow & { refunds: string }>),
    ])

    // Completed payments → bucket (+ sub-bucket) accumulators, and each group's money to its ONE destination.
    const nuevoDestino = (): MoneyDestination => ({
      collected: 0,
      refunds: 0,
      refundCount: 0,
      platformFee: 0,
      netToReceive: 0,
      transactionCount: 0,
    })
    const destinos: Record<StatementDestinationKey, MoneyDestination> = {
      drawer: nuevoDestino(),
      terminal: nuevoDestino(),
      online: nuevoDestino(),
      other: nuevoDestino(),
    }
    const porComercio = new Map<string, MerchantSums>()
    let tenderCommissionsTotal = 0
    for (const row of completedGroups) {
      const { bucket, sub } = bucketOf(row.method, row.cardBrand, row.isIntl)
      const amt = Number(row.amount)
      const tip = Number(row.tips)
      const fee = Number(row.fees)
      const count = Number(row.count)
      const charged = Number(row.chargedAmount)
      const chargedCount = Number(row.chargedCount)
      const refunded = Number(row.refundAmount)

      const b = ensure(buckets, bucket)
      b.amount += amt + tip // tips-inclusive, matching byPaymentMethod
      b.tips += tip
      b.count += count
      b.platformFees += fee
      b.chargedAmount += charged
      b.chargedCount += chargedCount
      b.tenderCommissions += Number(row.tenderCommissions)
      b.cancelledOrderRefunds += Number(row.cancelledOrderRefunds)

      if (sub) {
        const s = ensure(subBuckets, sub)
        s.amount += amt + tip
        s.tips += tip
        s.count += count
        s.platformFees += fee
        s.chargedAmount += charged
        s.chargedCount += chargedCount
        s.platformFeesCents += Number(row.feesCents)
      }

      // El estado de cuenta usa la comisión redondeada POR COBRO, como la liquidación (`proyectarComisionYNeto`): así banco, «Por
      // comercio» y el calendario no se separan un centavo (Codex r3 #4). `platformFees` del cajón sigue siendo la suma cruda.
      const feeCents = Number(row.feesCents)
      const destino = destinationOf({ ...row, enLinea: !!row.enLinea, hasMerchant: row.merchantAccountId != null })
      const d = destinos[destino]
      d.collected += amt + tip
      d.platformFee += feeCents
      d.refunds += refunded
      d.refundCount += count - chargedCount
      d.transactionCount += count
      if (destino === 'terminal' && row.merchantAccountId) {
        const m = porComercio.get(row.merchantAccountId) ?? {
          merchantAccountId: row.merchantAccountId,
          collected: 0,
          fee: 0,
          txns: 0,
          refunds: 0,
          refundCount: 0,
        }
        m.collected += amt + tip
        m.fee += feeCents
        m.txns += count
        m.refunds += refunded
        m.refundCount += count - chargedCount
        porComercio.set(row.merchantAccountId, m)
      }
      tenderCommissionsTotal += Number(row.tenderCommissions)
    }

    // Refund payments → bucket refunds (positive magnitude). Refunds aren't
    // attributed down to sub-buckets (the dashboard surfaces refunds at the
    // bucket level only).
    for (const row of refundGroups) {
      const { bucket } = bucketOf(row.method, row.cardBrand, row.isIntl)
      const b = ensure(buckets, bucket)
      b.refunds += Number(row.refunds)
    }

    // MindForm legacy QR → its own QR_LEGACY bucket (no recorded platform fees).
    // legacyAggregate was populated by the Part D block above (declared with let
    // before this block, so it's in scope here). The bridge guard
    // is redundant (legacyAggregate is null otherwise) but kept so the
    // "delete when native QR ships" repo-grep on sumsLegacyQrPayments finds it.
    // Carril C (D9.2): those payments carry no merchant, so with a merchant chosen they enter neither a bucket nor a destination.
    if (sumsLegacyQrPayments(venueId) && legacyAggregate && legacyAggregate.count > 0 && !merchantAccountId) {
      const acc = ensure(buckets, 'QR_LEGACY')
      acc.amount += legacyAggregate.amount + legacyAggregate.tips
      acc.tips += legacyAggregate.tips
      acc.count += legacyAggregate.count
      acc.chargedAmount += legacyAggregate.amount + legacyAggregate.tips
      acc.chargedCount += legacyAggregate.count
      destinos.other.collected += legacyAggregate.amount + legacyAggregate.tips
      destinos.other.transactionCount += legacyAggregate.count
    }

    if (wantsBuckets) {
      // Grand total = sum of bucket amounts (already tips-inclusive), the same
      // denominator basis byPaymentMethod uses, so percentages are trustworthy.
      // Carril C: la lectura agrupa ahora también por destino y comercio, así que un cajón suma MÁS grupos en JS; sin este
      // redondeo, 100 + 100.33 salía 200.32999999999998 y un porcentaje cambiaba de 77.1 % a 77.0 % (Codex r4 #3). Las
      // columnas de dinero tienen a lo más 4 decimales (la comisión), así que a 4 decimales la suma vuelve a ser exacta.
      const exacto = (n: number) => Math.round(n * 1e4) / 1e4
      for (const acc of [...buckets.values(), ...subBuckets.values()]) {
        for (const k of Object.keys(acc) as Array<keyof Acc>) acc[k] = exacto(acc[k])
      }
      const grandTotal = exacto(Array.from(buckets.values()).reduce((s, b) => s + b.amount, 0))
      const pct = (part: number, whole: number): number => (whole > 0 ? Number(((part / whole) * 100).toFixed(1)) : 0)

      const bucketOrder: BreakdownBucket[] = ['CARD', 'CASH', 'OTHER', 'QR_LEGACY']
      const subOrder: CardSubBucket[] = ['CREDIT', 'DEBIT', 'AMEX', 'INTERNATIONAL']

      byPaymentMethodDetailed = bucketOrder
        .filter(key => buckets.has(key))
        .map(key => {
          const b = buckets.get(key)!
          const entry: PaymentMethodDetailedBreakdown = {
            bucket: key,
            amount: b.amount,
            count: b.count,
            percentage: pct(b.amount, grandTotal),
            tips: b.tips,
            refunds: b.refunds,
            platformFees: b.platformFees,
            chargedAmount: b.chargedAmount,
            chargedCount: b.chargedCount,
            tenderCommissions: b.tenderCommissions,
            cancelledOrderRefunds: b.cancelledOrderRefunds,
          }

          // Attach card sub-buckets (only present types), percentages relative to
          // the CARD bucket total so they sum to ~100 within the card breakdown.
          if (key === 'CARD') {
            const subs = subOrder
              .filter(sk => subBuckets.has(sk))
              .map(sk => {
                const s = subBuckets.get(sk)!
                return {
                  type: sk,
                  amount: s.amount,
                  count: s.count,
                  percentage: pct(s.amount, b.amount),
                  platformFees: s.platformFees,
                  chargedAmount: s.chargedAmount,
                  chargedCount: s.chargedCount,
                  platformFeesCents: s.platformFeesCents,
                }
              })
            if (subs.length > 0) entry.subBuckets = subs
          }

          return entry
        })
    }

    if (wantsStatement) {
      // Al centavo, como un comercio: cobrado y comisión redondeados, y el neto es su resta (lo que el dueño ve cuadra).
      const redondeado = (d: MoneyDestination): MoneyDestination => {
        const collected = round2(d.collected)
        const platformFee = round2(d.platformFee)
        return { ...d, collected, platformFee, refunds: round2(d.refunds), netToReceive: round2(collected - platformFee) }
      }
      statementDestinations = {
        drawer: redondeado(destinos.drawer),
        terminal: redondeado(destinos.terminal),
        online: redondeado(destinos.online),
        other: redondeado(destinos.other),
        tenderCommissions: round2(tenderCommissionsTotal),
      }
      merchantSums = Array.from(porComercio.values())
    }
  }

  // Tarjetas de regalo: lo pagado con saldo, fuera de los buckets (un bucket nuevo tumba la página del dashboard que no lo conoce).
  const giftCardBalanceBreakdown: GiftCardBalanceBreakdown | undefined =
    groupBy === 'paymentMethod' && tarjetas
      ? { amount: tarjetas.balancePaid, count: tarjetas.balanceCount, tips: tarjetas.balanceTips, refunds: tarjetas.balanceReversals }
      : undefined

  // ============================================================
  // Time-Period Breakdown (if reportType is not 'summary')
  // ============================================================

  let byPeriod: TimePeriodMetrics[] | undefined

  if (reportType !== 'summary') {
    const periodos = await calculateTimePeriodMetrics(
      venueId,
      parsedStartDate,
      parsedEndDate,
      reportType,
      timezone,
      merchantAccountId,
      paymentMethod,
      cardType,
    )
    byPeriod = periodos.periods
    legacyUnavailable ||= periodos.legacyUnavailable
  }

  // Per-merchant card breakdown for the reconciliation view (additive; opt-in).
  // Reuses parsedStartDate/parsedEndDate — the same bounds the platform-fees query uses.
  let byMerchantAccount: MerchantAccountBreakdown[] | undefined
  if (filters.includeMerchantBreakdown) {
    // D9.2: las sumas salen de la misma lectura que los cajones, con el comercio y el método filtrados (si no, «Por comercio» y
    // su exporte hablaban de todos); aquí sólo se ponen nombres y reglas.
    byMerchantAccount = await buildMerchantAccountBreakdown(merchantSums)
  }

  // Settlement projection (Entrega 2; additive, opt-in). Adds the "¿cuándo cae?"
  // calendar and enriches each merchant row with its soonest settlement date.
  let settlementCalendar: SettlementCalendarDay[] | undefined
  // Skipped under a payment-method filter: the UI hides the reconciliation block
  // there (a filtered view can't honestly answer "¿dónde está tu dinero?"), so
  // computing the full-card projection would be wasted work and a confusing payload.
  if (filters.includeSettlementProjection && !paymentMethod) {
    const projection = await computeSettlementProjection(venueId, parsedStartDate, parsedEndDate, timezone, merchantAccountId, true)
    settlementCalendar = projection.calendar
    if (byMerchantAccount) {
      byMerchantAccount = byMerchantAccount.map(m => ({
        ...m,
        estimatedSettlement: projection.nextByMerchant.get(m.merchantAccountId) ?? { nextDate: null, settlementDays: null },
        unprojectedNet: projection.unprojectedByMerchant.get(m.merchantAccountId) ?? 0,
      }))
    }
  }

  // Carril G · D4: la cabecera repartida por canal y por tipo de pedido (misma población, cada tabla suma la cabecera).
  const canales =
    filters.includeChannelBreakdown && !vistaDeMovimientos
      ? await computeSalesByChannel(venueId, parsedStartDate, parsedEndDate, { cabecera: summary, legacy: legacyAggregate })
      : null

  // Sin importes (la B lo lee también, caso 23): sólo cuántos cobros y de qué reporte.
  logger.info('Sales summary calculated', {
    venueId,
    transactionCount: transactionCountResult,
    reportType,
    periodsCount: byPeriod?.length,
    filtered: vistaDeMovimientos,
  })

  return {
    dateRange: {
      startDate: parsedStartDate,
      endDate: parsedEndDate,
    },
    reportType,
    summary,
    byPaymentMethod,
    ...(salesByPaymentMethod ? { salesByPaymentMethod } : {}),
    byPaymentMethodDetailed,
    byPeriod,
    byMerchantAccount,
    ...(statementDestinations ? { statementDestinations } : {}),
    settlementCalendar,
    ...(giftCardBalanceBreakdown ? { giftCardBalanceBreakdown } : {}),
    ...(canales ? { byChannel: canales.byChannel, byOrderType: canales.byOrderType } : {}),
    ...(canales && !canales.cuadra ? { channelBreakdownOutOfSync: true as const } : {}),
    // D9.1: true en la vista de movimientos (método o comercio) — las métricas de orden vienen en null.
    filtered: vistaDeMovimientos,
    ...(legacyUnavailable ? { legacyUnavailable: true as const } : {}),
  }
}

// ============================================================
// Sales Summary Export (summary flatten + detailed rows + caps)
// ============================================================

/** Section ids the summary export can include. */
export type SalesSummaryExportSection = 'totals' | 'paymentMethods' | 'cardTypes' | 'merchantAccounts' | 'byPeriod' | 'statement'

/** One flattened row for the summary-mode export (rendered by encodeExport columns). */
export interface SalesSummaryExportRow {
  /** `'aviso'` is not a requestable section: it is the warning row a `legacyUnavailable` report carries (D15). */
  section: SalesSummaryExportSection | 'aviso'
  label: string
  count: number | null
  amount: number | null
  percentage: number | null
}

/** Detailed-mode + summary-mode filter inputs (superset of SalesSummaryFilters used by the report). */
export interface SalesSummaryExportFilters {
  startDate: string
  endDate: string
  paymentMethod?: PaymentMethodFilter
  cardType?: CardTypeFilter
  merchantAccountId?: string
  /** Detailed mode only — single or multi staff. */
  staffIds?: string[]
  /** Detailed mode only — cash-session / shift scope. */
  shiftId?: string
}

const round2x = (n: number | null | undefined): number | null => (n == null ? null : Math.round(n * 100) / 100)

/**
 * Flatten an already-computed SalesSummaryResponse into labeled rows, one per requested section.
 * Order-derived totals can be null under a payment-method filter — preserved as null (the
 * export columns render null as '').
 */
export function flattenSalesSummaryForExport(
  report: SalesSummaryResponse,
  sections: SalesSummaryExportSection[],
): { rows: SalesSummaryExportRow[] } {
  const want = new Set(sections)
  const rows: SalesSummaryExportRow[] = []
  const s = report.summary

  // D15: the screen warns that the totals may be incomplete; the file (and the MCP export) must say it too. First row,
  // whatever sections were requested, so nobody reads the numbers below as complete.
  if (report.legacyUnavailable) {
    rows.push({ section: 'aviso', label: AVISO_PUENTE_QR_CAIDO, count: null, amount: null, percentage: null })
  }

  if (want.has('totals')) {
    const t = (label: string, amount: number | null, count: number | null = null): SalesSummaryExportRow => ({
      section: 'totals',
      label,
      count,
      amount: round2x(amount),
      percentage: null,
    })
    // Carril B (21-nov): los renglones nuevos de la pantalla, cada uno con su leyenda y sólo si no es 0 (un servidor viejo, la vista
    // de movimientos o un día sin cargos no agregan filas vacías).
    const hay = (n: number | null | undefined): n is number => typeof n === 'number' && round2x(n) !== 0
    rows.push(t('Ventas brutas', s.grossSales, s.transactionCount))
    if (hay(s.serviceCosts)) rows.push(t('Cargos por servicio (incluidos en ventas brutas)', s.serviceCosts))
    rows.push(t('Descuentos', s.discounts == null ? null : -s.discounts))
    rows.push(t('Reembolsos', -s.refunds))
    rows.push(t('Ventas netas', s.netSales))
    if (hay(s.unpaidSales)) rows.push(t('Sin cobrar: cuentas abiertas (no es venta)', s.unpaidSales, s.unpaidOrders ?? null))
    rows.push(t('Impuestos', s.taxes))
    rows.push(t('Propinas', s.tips))
    rows.push(t('Comisiones de plataforma', -s.platformFees))
    if (hay(s.tenderCommissions)) rows.push(t('Comisiones de terceros (Rappi, Uber Eats, tipos de pago)', -s.tenderCommissions))
    rows.push(t('Total cobrado', s.totalCollected))
    // Tarjetas de regalo (spec §7): fuera de las ventas, cada una con su leyenda.
    if (s.giftCardLoads !== undefined) {
      rows.push(t('Tarjetas de regalo cargadas (no es venta)', s.giftCardLoads, s.giftCardLoadsCount ?? null))
    }
    if (s.paidWithGiftCardBalance !== undefined) {
      rows.push(t('Pagado con saldo de tarjeta de regalo (incluido en ventas y propinas)', s.paidWithGiftCardBalance))
    }
  }
  if (want.has('paymentMethods') && report.byPaymentMethod) {
    for (const m of report.byPaymentMethod) {
      rows.push({
        section: 'paymentMethods',
        label: m.method,
        count: m.count,
        amount: round2x(m.amount),
        percentage: round2x(m.percentage),
      })
    }
    // Tarjetas de regalo (Q100), igual que «Métodos de pago» del panel (B5/M2, `SalesSummary.tsx` `lineaDeSaldo`): los métodos son
    // DINERO; el saldo va aparte, BRUTO y sin porcentaje, y lo que regresó al saldo se dice en su propia fila. Sin sobres ni saldo
    // en el rango no sale ninguna de las dos. S10 r3 (Codex r3): la compuerta mira el bruto y el reverso, no el neto: gastado y devuelto
    // completo deja el neto en 0 y los dos movimientos tienen que verse.
    const saldo = report.giftCardBalanceBreakdown
    if (saldo && (saldo.count > 0 || saldo.amount !== 0 || saldo.refunds !== 0)) {
      rows.push({
        section: 'paymentMethods',
        label: 'Saldo de tarjeta de regalo',
        count: saldo.count,
        amount: round2x(saldo.amount),
        percentage: null,
      })
      if (saldo.refunds > 0) {
        rows.push({
          section: 'paymentMethods',
          label: 'Regresó al saldo de tarjetas',
          count: null,
          amount: round2x(saldo.refunds),
          percentage: null,
        })
      }
    }
  }
  // NOTE (see Task 6 FIX 7): getSalesSummary only populates byPaymentMethodDetailed when
  // groupBy==='paymentMethod' AND no paymentMethod filter is active (it is the unfiltered
  // card-type sub-bucketing). So when the caller has an active paymentMethod filter, this
  // section is silently empty — the dialog disables the "Card-type detail" checkbox in that
  // case so the user can never select a section that yields nothing.
  if (want.has('cardTypes') && report.byPaymentMethodDetailed) {
    for (const b of report.byPaymentMethodDetailed) {
      for (const sub of b.subBuckets ?? []) {
        rows.push({
          section: 'cardTypes',
          label: sub.type,
          count: sub.count,
          amount: round2x(sub.amount),
          percentage: round2x(sub.percentage),
        })
      }
    }
  }
  if (want.has('merchantAccounts') && report.byMerchantAccount) {
    // Carril C: la cantidad es de COBROS (una devolución no es una transacción, D10.2), y lo que llega al banco sin comercio de
    // terminal (cobros en línea, D11) va en su propia fila, como en la pantalla.
    for (const ma of report.byMerchantAccount) {
      rows.push({
        section: 'merchantAccounts',
        label: ma.displayName,
        count: ma.transactionCount - (ma.refundCount ?? 0),
        amount: round2x(ma.netToReceive),
        percentage: null,
      })
    }
    const enLinea = report.statementDestinations?.online
    if (enLinea && enLinea.transactionCount > 0) {
      rows.push({
        section: 'merchantAccounts',
        label: 'Cobros en línea',
        count: enLinea.transactionCount - enLinea.refundCount,
        amount: round2x(enLinea.netToReceive),
        percentage: null,
      })
    }
  }
  // Carril C: el «Estado del periodo» (dinero, no ventas) para el archivo y la MCP del exporte. Sale con `includeMerchantBreakdown`.
  const destinos = report.statementDestinations
  if (want.has('statement') && destinos) {
    const lista = [destinos.drawer, destinos.terminal, destinos.online, destinos.other]
    const suma = (pick: (d: MoneyDestination) => number) => round2(lista.reduce((acc, d) => acc + pick(d), 0))
    const fila = (label: string, amount: number, count: number | null = null): SalesSummaryExportRow => ({
      section: 'statement',
      label,
      count,
      amount: round2x(amount),
      percentage: null,
    })
    const teQueda = suma(d => d.netToReceive) - destinos.tenderCommissions
    rows.push(
      fila(
        'Cobraste',
        suma(d => d.collected + d.refunds),
        suma(d => d.transactionCount - d.refundCount),
      ),
    )
    rows.push(
      fila(
        'Devoluciones',
        -suma(d => d.refunds),
        suma(d => d.refundCount),
      ),
    )
    rows.push(fila('Comisiones de Avoqado', -suma(d => d.platformFee)))
    rows.push(fila('Comisión de plataformas y tipos de pago', -destinos.tenderCommissions))
    rows.push(fila('Te queda', teQueda))
    rows.push(fila('Ya en tu mano (efectivo)', destinos.drawer.netToReceive))
    rows.push(fila('Llega a tu banco', destinos.terminal.netToReceive + destinos.online.netToReceive))
    rows.push(fila('Otros métodos', destinos.other.netToReceive))
  }
  if (want.has('byPeriod') && report.byPeriod) {
    for (const p of report.byPeriod) {
      rows.push({
        section: 'byPeriod',
        label: p.periodLabel || p.period,
        count: p.metrics.transactionCount,
        amount: round2x(p.metrics.totalCollected),
        percentage: null,
      })
    }
  }
  return { rows }
}

/** Shared WHERE used by both count + fetch for detailed-mode rows (honors the active filter). */
export function buildSalesSummaryDetailWhere(venueId: string, filters: SalesSummaryExportFilters): Prisma.PaymentWhereInput {
  const paymentWhereFilter = buildPaymentWhereFilter(filters.paymentMethod, filters.cardType)
  const where: Prisma.PaymentWhereInput = {
    venueId,
    status: 'COMPLETED',
    createdAt: { gte: new Date(filters.startDate), lte: new Date(filters.endDate) },
    ...(filters.merchantAccountId ? { merchantAccountId: filters.merchantAccountId } : {}),
    ...(filters.staffIds && filters.staffIds.length > 0 ? { processedById: { in: filters.staffIds } } : {}),
    ...(filters.shiftId ? { shiftId: filters.shiftId } : {}),
    ...paymentWhereFilter,
  }
  // D9.1 (Codex r2 #6): con comercio, el detalle tampoco trae el efectivo que la TPV estampó con el comercio de su serial (la
  // cabecera y «Métodos de pago» ya no lo cuentan). En un AND aparte: el filtro de tarjeta trae su propio `AND`.
  return filters.merchantAccountId ? { AND: [where, NOT_DRAWER_CASH_WHERE] } : where
}

/** Pre-flight count for detailed-mode export (caller compares against the row cap before fetching). */
export async function countSalesSummaryDetailRows(venueId: string, filters: SalesSummaryExportFilters): Promise<number> {
  return prisma.payment.count({ where: buildSalesSummaryDetailWhere(venueId, filters) })
}

/** Fetch capped detailed-mode payment rows; flat select with everything the export columns pluck. */
export const SALES_SUMMARY_DETAIL_SELECT = {
  id: true,
  createdAt: true,
  method: true,
  cardBrand: true,
  maskedPan: true,
  processorData: true,
  amount: true,
  tipAmount: true,
  status: true,
  source: true,
  orderId: true,
  processedBy: { select: { firstName: true, lastName: true } },
  merchantAccount: { select: { displayName: true, externalMerchantId: true } },
} satisfies Prisma.PaymentSelect

export async function fetchSalesSummaryDetailRows(venueId: string, filters: SalesSummaryExportFilters, limit: number) {
  return prisma.payment.findMany({
    where: buildSalesSummaryDetailWhere(venueId, filters),
    select: SALES_SUMMARY_DETAIL_SELECT,
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
}

/** Página por keyset (createdAt desc, id desc) para exportes en segundo plano. `corte` deja fuera lo que entró después de pedirlo. */
export async function fetchSalesSummaryDetailPage(
  venueId: string,
  filters: SalesSummaryExportFilters,
  corte: Date,
  keyset: Prisma.PaymentWhereInput,
  limit: number,
) {
  return prisma.payment.findMany({
    where: { AND: [buildSalesSummaryDetailWhere(venueId, filters), { createdAt: { lte: corte } }, keyset] },
    select: SALES_SUMMARY_DETAIL_SELECT,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
  })
}

export async function countSalesSummaryDetailRowsHasta(venueId: string, filters: SalesSummaryExportFilters, corte: Date): Promise<number> {
  return prisma.payment.count({ where: { AND: [buildSalesSummaryDetailWhere(venueId, filters), { createdAt: { lte: corte } }] } })
}

// ============================================================
// Helper: Calculate Time-Period Metrics
// ============================================================

/**
 * Calculate metrics grouped by time period
 */
async function calculateTimePeriodMetrics(
  venueId: string,
  startDate: Date,
  endDate: Date,
  reportType: ReportType,
  timezone: string,
  merchantAccountId?: string,
  paymentMethod?: PaymentMethodFilter,
  cardType?: CardTypeFilter,
): Promise<{ periods: TimePeriodMetrics[]; legacyUnavailable: boolean }> {
  // When a payment-method filter is active, order-derived metrics (gross/items/
  // discounts/taxes/deferred) become null and the corresponding raw queries are
  // skipped. Payment-derived queries get the SQL clause appended.
  // D9.1: a merchant filter is the same movement view (the headline's `vistaDeMovimientos`).
  const isFiltered = !!paymentMethod || !!merchantAccountId
  const paymentSqlClause = buildPaymentSqlClause(paymentMethod, cardType)
  const paymentSqlClauseWithPrefix = buildPaymentSqlClause(paymentMethod, cardType, 'p')

  // SECURITY: Sanitize timezone to prevent SQL injection
  const safeTz = sanitizeTimezone(timezone)

  // Determine SQL grouping based on reportType
  // Time-based periods are returned as the INSTANT the bucket starts (midnight / hour on the
  // venue clock): formatPeriod/formatPeriodLabel and the dashboard format them in the venue zone.
  // Venue wall clock of the UTC column. A single `AT TIME ZONE tz` read the stored UTC value
  // as if it were local time: a 20:00 sale was bucketed on the next day, at hour 02.
  const agruparPor = (columna: string): string | null => {
    const wall = localWallClockRaw(safeTz, columna)
    switch (reportType) {
      case 'hours':
        return localInstantRaw(safeTz, `DATE_TRUNC('hour', ${wall})`)
      case 'days':
        return localInstantRaw(safeTz, `DATE_TRUNC('day', ${wall})`)
      case 'weeks':
        return localInstantRaw(safeTz, `DATE_TRUNC('week', ${wall})`)
      case 'months':
        return localInstantRaw(safeTz, `DATE_TRUNC('month', ${wall})`)
      case 'hourlySum':
        // Group by hour of day (0-23)
        return `EXTRACT(HOUR FROM ${wall})`
      case 'dailySum':
        // Group by day of week (0=Sunday, 6=Saturday)
        return `EXTRACT(DOW FROM ${wall})`
      default:
        return null
    }
  }
  // D93 («B», como Square): órdenes y cobros van a la barra de su hora REAL (la del aparato si se hicieron sin internet; si no, la
  // llegada), la misma que el rango de arriba (`enElRango`), para que las barras sigan sumando la cabecera. Sin calificar a propósito:
  // la consulta de comisiones de plataforma la reescribe a `p.`. Las comisiones del personal (sin esa columna) van por su `createdAt`.
  const groupByExpressionOrNull = agruparPor(sqlHoraReal())
  if (!groupByExpressionOrNull) return { periods: [], legacyUnavailable: false }
  const groupByExpression: string = groupByExpressionOrNull
  const commissionGroupByExpression = agruparPor('"createdAt"') as string
  const orderByExpression = 'period'
  const rangoHoraReal = sqlRangoHoraReal('', '$2::timestamp', '$3::timestamp')

  // Optional merchant filter clause for raw SQL queries. D9.1: never the cash a TPV stamped with the merchant of its serial, and
  // no «orders with some payment of that merchant» any more (the order queries are skipped in the movement view).
  const merchantPaymentClause = merchantAccountId ? `AND "merchantAccountId" = $4 AND NOT ${sqlEsEfectivoDelCajon()}` : ''
  const merchantPlatformClause = merchantAccountId ? `AND p."merchantAccountId" = $4 AND NOT ${sqlEsEfectivoDelCajon('p')}` : ''
  const merchantCommissionClause = merchantAccountId
    ? `AND "paymentId" IN (SELECT id FROM "Payment" WHERE "merchantAccountId" = $4 AND NOT ${sqlEsEfectivoDelCajon()})`
    : ''

  // Query order metrics grouped by period
  // Using subtotal for gross_sales (not total) to match accounting standards
  // The two lateral sums are the HIDDEN giveaways (promotions + NET-convention
  // cortesías with total=0 — same discriminator as HIDDEN_COMP_LINE_WHERE);
  // they get folded into gross_sales/discounts per row with the SAME
  // foldGiveawaysIntoSummary the headline uses, so the bars keep summing to it.
  // D6: the sales (collected accounts) and the open ones («Ventas diferidas», «Sin cobrar») come from the SAME statement, like the
  // headline (Codex r2 #3), and a period with only open accounts still gets its bar (Codex r1 #3).
  const orderMetricsQuery = `
    SELECT
      ${groupByExpression} as period,
      COALESCE(SUM(subtotal + ${sqlImpuestoQueSeCobraAparte()}) FILTER (WHERE cuenta.es_venta), 0) as gross_sales,
      -- D2: the service charges of the same accounts (grossSales = items + serviceCosts).
      COALESCE(SUM("serviceChargeAmount") FILTER (WHERE cuenta.es_venta), 0) as service_costs,
      COALESCE(SUM("taxAmount") FILTER (WHERE cuenta.es_venta), 0) as taxes,
      -- EFFECTIVE discount per order (header can exceed the subtotal since B2/B2c); same rule as the summary cards.
      COALESCE(SUM(LEAST("discountAmount", subtotal)) FILTER (WHERE cuenta.es_venta), 0) as discounts,
      COALESCE(SUM(promo."discount_cents") FILTER (WHERE cuenta.es_venta), 0) as promo_discount_cents,
      COALESCE(SUM(comp."given_away") FILTER (WHERE cuenta.es_venta), 0) as comp_given_away,
      COALESCE(SUM("remainingBalance") FILTER (WHERE cuenta.abierta), 0) as deferred_sales,
      COALESCE(SUM(cuenta.falta) FILTER (WHERE cuenta.abierta AND NOT cuenta.es_venta), 0) as unpaid_sales,
      COUNT(*) FILTER (WHERE cuenta.abierta AND NOT cuenta.es_venta AND cuenta.falta > 0.005) as unpaid_orders,
      COUNT(*) FILTER (WHERE cuenta.es_venta) as order_count
    FROM "Order"
    CROSS JOIN LATERAL (
      SELECT ${sqlCuentaCobrada('"Order"')} AS es_venta,
             "Order"."paymentStatus" IN ('PENDING', 'PARTIAL') AS abierta,
             (CASE WHEN "Order"."paymentStatus" IN ('PENDING', 'PARTIAL') THEN ${sqlLoQueFaltaCobrar('"Order"')} ELSE 0 END) AS falta
    ) cuenta
    LEFT JOIN LATERAL (
      SELECT SUM("discountCents") AS discount_cents
      FROM "OrderPromotion" WHERE "orderId" = "Order".id
    ) promo ON TRUE
    LEFT JOIN LATERAL (
      SELECT SUM("discountAmount") AS given_away
      FROM "OrderItem" WHERE "orderId" = "Order".id AND "isCortesia" = TRUE AND total = 0
    ) comp ON TRUE
    WHERE "venueId" = $1
      AND ${rangoHoraReal}
      -- Must mirror the summary filter so the period bars sum to the headline total (D6: the sales are the collected ones, see
      -- the FILTERs above).
      AND status NOT IN ('PENDING', 'CANCELLED', 'DELETED')
      AND ${sqlOrdenSinTarjetasTexto('"Order".id')}
      -- Codex r3/r4: only a sale or an open account that owes something makes a bar (an imported REFUNDED account, or an open
      -- account given away whole, alone used to make a day of zeros).
      AND (cuenta.es_venta OR (cuenta.abierta AND (cuenta.falta > 0.005 OR "remainingBalance" <> 0)))
    GROUP BY ${groupByExpression}
    ORDER BY ${orderByExpression}
  `

  // Query payment metrics grouped by period — payment-method clause appended
  // before GROUP BY so the filter narrows rows, not groups.
  // ⭐ Tarjetas de regalo (B5 r1, M-2): sin filtro de método, los cobros de las barras se cuentan como la cabecera —sin los de
  // cuentas de tarjetas—; con filtro es la vista de dinero y cuentan todos. El monto y la propina no cambian.
  // D10.1: como la cabecera, una devolución no es una transacción (NULL-safe: el `type` NULL de un cobro viejo sí cuenta).
  // D6 (Codex r4 #1): en la vista de ventas, sin los cobros de una cuenta abierta que todavía no es venta (WHERE de abajo).
  const cobrosQueCuentan = ` FILTER (WHERE "Payment".type IS DISTINCT FROM 'REFUND'${
    isFiltered ? '' : ` AND ${sqlOrdenSinTarjetasTexto('"Payment"."orderId"')}`
  })`
  const paymentMetricsQuery = `
    SELECT
      ${groupByExpression} as period,
      COALESCE(SUM(amount), 0) as payment_amount,
      COALESCE(SUM("tipAmount"), 0) as tips,
      -- D1: the third-party commission frozen on each charge, with the headline's population.
      COALESCE(SUM(${sqlComisionDeTerceros('', isFiltered)}), 0) as tender_commissions,
      COUNT(*)${cobrosQueCuentan} as transaction_count
    FROM "Payment"
    WHERE "venueId" = $1
      AND ${rangoHoraReal}
      AND status = 'COMPLETED'
      ${isFiltered ? '' : `AND NOT ${sqlCobroDeCuentaSinCobrar('')}`}
      ${merchantPaymentClause}
      ${paymentSqlClause}
    GROUP BY ${groupByExpression}
    ORDER BY ${orderByExpression}
  `

  // Query refunds grouped by period — REFUND Payments have negative amount and
  // (since 2026-04-19) negative tipAmount. Use ABS so "refunds" is a positive
  // magnitude matching the consumer contract of the non-raw aggregate above.
  // D6 (Codex r1 #2, r2 #4): in the sales view, the part of a refund that only returned a down payment and its tip
  // (`reopenedAmount`/`reopenedTipAmount`, owed again in «Sin cobrar») is not a sales refund — same rule as the headline. In the
  // movement view every refund that went out counts, a gift-card cancellation too (Codex r2 #7).
  const refundsQuery = `
    SELECT
      ${groupByExpression} as period,
      COALESCE(SUM(ABS(amount) + ABS("tipAmount")${
        isFiltered ? '' : ' - COALESCE("reopenedAmount", 0) - COALESCE("reopenedTipAmount", 0)'
      }), 0) as refunds
    FROM "Payment"
    WHERE "venueId" = $1
      AND ${rangoHoraReal}
      AND type = 'REFUND'
      ${
        isFiltered
          ? ''
          : `AND ${sqlOrdenSinTarjetasTexto('"Payment"."orderId"')}
      -- Codex r3 #1: igual que el resumen, la devolución de una cuenta cancelada o borrada no se resta (r4 H5: sin filtro).
      AND NOT EXISTS (SELECT 1 FROM "Order" o WHERE o.id = "Payment"."orderId" AND o.status IN ('CANCELLED', 'DELETED'))`
      }
      ${merchantPaymentClause}
      ${paymentSqlClause}
    GROUP BY ${groupByExpression}
    ORDER BY ${orderByExpression}
  `

  // Query platform fees (Avoqado fees) grouped by period.
  // Source: TransactionCost.venueChargeAmount joined to Payment for venueId/date.
  // VenueTransaction.feeAmount is not currently synced from TransactionCost.
  const conAliasP = (sql: string) => sql.replace(/"createdAt"/g, 'p."createdAt"').replace(/"clientCreatedAt"/g, 'p."clientCreatedAt"')
  const platformFeesGroupBy = conAliasP(groupByExpression)
  const platformFeesOrderBy = conAliasP(orderByExpression)
  // Codex r4 H1 y A2: la misma comisión que la cabecera (costo con su cuota fija, o `Payment.feeAmount` del cobro sin costo).
  const platformFeesQuery = `
    SELECT
      ${platformFeesGroupBy} as period,
      COALESCE(SUM(${SQL_COMISION_DEL_COBRO}), 0) as platform_fees
    FROM "Payment" p
    LEFT JOIN "TransactionCost" tc ON tc."paymentId" = p.id
    WHERE p."venueId" = $1
      AND ${conAliasP(rangoHoraReal)}
      AND (tc."id" IS NOT NULL OR p."status" = 'COMPLETED')
      ${isFiltered ? '' : `AND NOT ${sqlCobroDeCuentaSinCobrar('p')}`}
      ${merchantPlatformClause}
      ${paymentSqlClauseWithPrefix}
    GROUP BY ${platformFeesGroupBy}
    ORDER BY ${platformFeesOrderBy}
  `

  // Query staff commissions grouped by period
  // When a payment-method filter is active, also constrain the inner Payment
  // subquery so only commissions for matching payments are aggregated.
  const staffCommissionsPaymentInnerClause = isFiltered ? buildPaymentSqlClause(paymentMethod, cardType) : ''
  const staffCommissionsPaymentSubquery = isFiltered
    ? `AND "paymentId" IN (SELECT id FROM "Payment" WHERE "venueId" = $1 ${staffCommissionsPaymentInnerClause})`
    : ''
  const staffCommissionsQuery = `
    SELECT
      ${commissionGroupByExpression} as period,
      COALESCE(SUM("netCommission"), 0) as staff_commissions
    FROM "CommissionCalculation"
    WHERE "venueId" = $1
      AND "createdAt" >= $2::timestamp
      AND "createdAt" <= $3::timestamp
      AND status != 'VOIDED'
      ${merchantCommissionClause}
      ${staffCommissionsPaymentSubquery}
    GROUP BY ${commissionGroupByExpression}
    ORDER BY ${orderByExpression}
  `

  // Execute all queries in parallel
  // When merchantAccountId is provided, it becomes the 4th parameter ($4) for all queries
  // 🔴 El rango va como TEXTO sin zona, no como Date.
  //
  // `Order.createdAt` y `Payment.createdAt` son `timestamp WITHOUT time zone` y
  // guardan UTC. Al pasar un Date, Prisma lo manda tipado como timestamptz y
  // Postgres lo convierte a la zona de la sesión antes de comparar: el rango se
  // corre 6 horas y las ventas del día quedan fuera. El resultado era `byPeriod`
  // VACÍO — la gráfica del POS decía "Sin datos para este periodo" mientras el
  // resumen de arriba mostraba $750 en ventas, la misma pantalla contradiciéndose.
  //
  // Con el valor como texto (`2026-08-03T17:32:06.455`) y `$2::timestamp` en la
  // query, Postgres compara timestamp contra timestamp, sin conversión de por medio.
  const rangeStart = startDate.toISOString().slice(0, 23)
  const rangeEnd = endDate.toISOString().slice(0, 23)
  const queryParams: [string, string, string, ...string[]] = merchantAccountId
    ? [venueId, rangeStart, rangeEnd, merchantAccountId]
    : [venueId, rangeStart, rangeEnd]

  // Under a payment-method filter, skip order-derived queries entirely — their
  // results would be misleading because a single order can't be split per method.
  type FilaDeOrdenes = {
    period: Date | number
    gross_sales: number
    service_costs: number
    taxes: number
    discounts: number
    promo_discount_cents: number
    comp_given_away: number
    deferred_sales: number
    unpaid_sales: number
    unpaid_orders: bigint
    order_count: bigint
  }
  const [orderMetrics, paymentMetrics, refundsMetrics, platformFeesMetrics, staffCommissionsMetrics] = await Promise.all([
    isFiltered ? Promise.resolve([] as FilaDeOrdenes[]) : prisma.$queryRawUnsafe<FilaDeOrdenes[]>(orderMetricsQuery, ...queryParams),
    prisma.$queryRawUnsafe<
      Array<{ period: Date | number; payment_amount: number; tips: number; tender_commissions: number; transaction_count: bigint }>
    >(paymentMetricsQuery, ...queryParams),
    prisma.$queryRawUnsafe<Array<{ period: Date | number; refunds: number }>>(refundsQuery, ...queryParams),
    prisma.$queryRawUnsafe<Array<{ period: Date | number; platform_fees: number }>>(platformFeesQuery, ...queryParams),
    prisma.$queryRawUnsafe<Array<{ period: Date | number; staff_commissions: number }>>(staffCommissionsQuery, ...queryParams),
  ])

  // Create maps for quick lookup
  // Use String(Number()) to normalize Decimal/BigInt types from PostgreSQL
  const paymentMap = new Map(paymentMetrics.map(p => [String(Number(p.period)), p]))
  const refundsMap = new Map(refundsMetrics.map(r => [String(Number(r.period)), r]))
  const platformFeesMap = new Map(platformFeesMetrics.map(c => [String(Number(c.period)), c]))
  const staffCommissionsMap = new Map(staffCommissionsMetrics.map(c => [String(Number(c.period)), c]))
  const orderMetricsMap = new Map(orderMetrics.map(o => [String(Number(o.period)), o]))

  // Debug logging for dailySum/hourlySum
  if (reportType === 'dailySum' || reportType === 'hourlySum') {
    logger.info(`[SalesSummary] ${reportType} orderMetrics keys:`, Array.from(orderMetricsMap.keys()))
    logger.info(
      `[SalesSummary] ${reportType} orderMetrics values:`,
      orderMetrics.map(o => ({ period: o.period, gross_sales: o.gross_sales })),
    )
  }

  // ⚠️ MindForm legacy QR bridge — merge legacy QR into the time-series so the
  // period bars sum to the legacy-inclusive headline total. Delete with the
  // rest of the MindForm QR bridge when native QR ships.
  let legacyPeriodMap = new Map<string, LegacyPeriodMetric>()
  let legacyUnavailable = false
  // D9.1: the legacy QR rows have no merchant account — with a merchant chosen they are not part of the bars.
  if (venueId === MINDFORM_NEW_VENUE_ID && (reportType as string) !== 'summary' && !merchantAccountId) {
    // Single source of truth for which legacy rows the active filter admits.
    // QR_LEGACY never reaches here (getSalesSummary short-circuits it).
    const admission = legacyAdmission(paymentMethod, cardType)
    if (admission.include) {
      const legacyPeriod = await getLegacyPeriodMetrics(
        startDate.toISOString(),
        endDate.toISOString(),
        reportType as LegacyPeriodReportType,
        timezone,
        admission.method,
      )
      legacyPeriodMap = new Map(legacyPeriod.rows.map(r => [r.periodKey, r]))
      legacyUnavailable = legacyPeriod.unavailable
    }
  }

  // Generate all periods for summary report types (fill zeros for missing periods)
  const allPeriods = generateAllPeriods(reportType)

  // Combine metrics by period — use allPeriods for summary types (0-23 / 0-6
  // already cover any legacy buckets); otherwise drive from whichever native
  // metric source has rows (payment under filter; order metrics in the default
  // path), then union in any legacy-only periods so they still render.
  let periodsToProcess: Array<Date | number>
  if (allPeriods.length > 0) {
    periodsToProcess = allPeriods
  } else {
    // Codex r5 (H1): también los periodos que sólo traen cobros, devoluciones o comisión (una devolución otro día sin pedidos nuevos):
    // antes la barra se descartaba y la gráfica no sumaba la cabecera. Por clave, en orden de tiempo.
    const porClave = new Map<string, Date | number>()
    // Codex D93 r1 #1: y las de comisión del personal SOLA (su cobro ahora puede caer en otra barra por su hora real).
    // D6 (Codex r1 #3): `orderMetrics` trae también el periodo de una cuenta abierta SOLA (ya no es venta; sin eso desaparecía).
    for (const filas of [isFiltered ? [] : orderMetrics, paymentMetrics, refundsMetrics, platformFeesMetrics, staffCommissionsMetrics])
      for (const f of filas) if (!porClave.has(String(Number(f.period)))) porClave.set(String(Number(f.period)), f.period)
    const nativePeriods = [...porClave.entries()].sort(([a], [b]) => Number(a) - Number(b)).map(([, period]) => period)
    const seen = new Set(porClave.keys())
    const legacyOnly: Array<Date | number> = []
    for (const key of legacyPeriodMap.keys()) {
      if (!seen.has(key)) legacyOnly.push(new Date(Number(key))) // epoch-ms key → Date for formatPeriod
    }
    periodsToProcess = [...nativePeriods, ...legacyOnly].sort((a, b) => Number(a) - Number(b)) // Codex r6: los legacy, en su lugar
  }

  // Un byPeriod vacío deja la gráfica del POS en "Sin datos para este periodo"
  // mientras el resumen de arriba muestra ventas — la pantalla se contradice sola.
  // Cuando pase, este log dice de dónde vino el vacío en vez de obligar a repetir
  // toda la investigación.
  if (periodsToProcess.length === 0) {
    logger.warn(
      `[SalesSummary] byPeriod VACÍO — reportType=${reportType} isFiltered=${isFiltered} ` +
        `orderMetrics=${orderMetrics.length} paymentMetrics=${paymentMetrics.length} ` +
        `allPeriods=${allPeriods.length} rango=${startDate.toISOString()}..${endDate.toISOString()}`,
    )
  }

  const result: TimePeriodMetrics[] = periodsToProcess.map(periodValue => {
    const periodKey = String(Number(periodValue))
    const order = orderMetricsMap.get(periodKey)
    const payment = paymentMap.get(periodKey)
    const refund = refundsMap.get(periodKey)
    const platformFee = platformFeesMap.get(periodKey)
    const staffCommission = staffCommissionsMap.get(periodKey)

    // MindForm legacy QR contribution for this period (0 if none). Folded into
    // the formulas below so each period rolls up to the Part D summary total.
    const legacy = legacyPeriodMap.get(periodKey)
    const legacyAmount = legacy ? legacy.amount : 0
    const legacyTips = legacy ? legacy.tips : 0
    const legacyCount = legacy ? legacy.count : 0

    // Order-derived metrics are null when filtered (order rows can't be honestly
    // split per payment bucket). When NOT filtered, legacy sold real food so its
    // amount folds into grossSales (and therefore items/netSales).
    // Hidden giveaways (promos + NET-convention comps) fold with the SAME
    // function as the headline so the period bars keep summing to it.
    const { grossSales, discounts } = foldGiveawaysIntoSummary(
      {
        grossSales: isFiltered ? null : Number(order?.gross_sales || 0) + Number(order?.service_costs || 0) + legacyAmount,
        items: null,
        discounts: isFiltered ? null : Number(order?.discounts || 0),
      },
      Number(order?.promo_discount_cents || 0),
      Number(order?.comp_given_away || 0),
    )
    const taxes = isFiltered ? null : Number(order?.taxes || 0)
    const deferredSales = isFiltered ? null : Number(order?.deferred_sales || 0)
    const unpaidSales = isFiltered ? null : round2(Number(order?.unpaid_sales || 0))
    const unpaidOrders = isFiltered ? null : Number(order?.unpaid_orders || 0)
    const serviceCosts = isFiltered ? null : Number(order?.service_costs || 0)

    // Payment-derived metrics are always present; legacy tips/count always count.
    const refunds = Number(refund?.refunds || 0)
    const tips = Number(payment?.tips || 0) + legacyTips
    const platformFees = Number(platformFee?.platform_fees || 0)
    const staffCommissions = Number(staffCommission?.staff_commissions || 0)
    const paymentAmount = Number(payment?.payment_amount || 0)
    const tenderCommissions = round2(Number(payment?.tender_commissions || 0))

    // grossSales already includes legacyAmount (unfiltered), so netSales does too.
    const netSales = grossSales !== null && discounts !== null ? grossSales - discounts - refunds : null

    // Mexico model: taxes are already included in prices, NOT added on top.
    // Total Collected = Net Sales + Tips - Platform Fees (actual cash flow).
    // Under filter, derive from filtered payment volume directly; legacy volume
    // (amount + tips) is added on top in both branches. Note `tips` already
    // includes legacyTips, so only legacyAmount is added explicitly here.
    const totalCollected = isFiltered
      ? paymentAmount + tips - platformFees - tenderCommissions + legacyAmount
      : netSales !== null
        ? netSales + tips - platformFees - tenderCommissions
        : 0
    // Net Profit = Net Sales - Platform Fees - Third-party fees - Staff Commissions (true profit).
    // netSales already includes legacyAmount when unfiltered; under filter add it.
    const netProfit = isFiltered
      ? paymentAmount - platformFees - tenderCommissions - staffCommissions + legacyAmount
      : netSales !== null
        ? netSales - platformFees - tenderCommissions - staffCommissions
        : 0

    return {
      period: formatPeriod(periodValue, reportType, timezone),
      periodLabel: formatPeriodLabel(periodValue, reportType, timezone),
      metrics: {
        grossSales,
        // items = gross without the service charges (D2), like the headline.
        items: grossSales !== null && serviceCosts !== null ? round2(grossSales - serviceCosts) : null,
        serviceCosts,
        discounts,
        refunds,
        netSales,
        deferredSales,
        taxes,
        tips,
        platformFees,
        staffCommissions,
        commissions: platformFees, // Legacy field for backwards compatibility
        totalCollected,
        netProfit,
        transactionCount: Number(payment?.transaction_count || 0) + legacyCount,
        unpaidSales,
        unpaidOrders,
        tenderCommissions,
      },
    }
  })

  return { periods: result, legacyUnavailable }
}

/**
 * Generate all periods for summary report types (to show $0 for missing periods)
 */
function generateAllPeriods(reportType: ReportType): number[] {
  switch (reportType) {
    case 'hourlySum':
      // All 24 hours: 0-23
      return Array.from({ length: 24 }, (_, i) => i)
    case 'dailySum':
      // All 7 days: 0=Sunday to 6=Saturday
      return Array.from({ length: 7 }, (_, i) => i)
    default:
      // For other report types, return empty (use actual data)
      return []
  }
}

/**
 * Format period value for API response
 */
function formatPeriod(period: Date | number, reportType: ReportType, _timezone: string): string {
  if (reportType === 'hourlySum') {
    // Hour of day (0-23)
    return String(period).padStart(2, '0') + ':00'
  }
  if (reportType === 'dailySum') {
    // Day of week (0=Sunday)
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
    return days[Number(period)] || String(period)
  }
  // ISO date string for time-based periods
  if (period instanceof Date) {
    return period.toISOString()
  }
  return String(period)
}

/**
 * Format human-readable period label
 */
function formatPeriodLabel(period: Date | number, reportType: ReportType, timezone: string): string {
  if (reportType === 'hourlySum') {
    const hour = Number(period)
    const suffix = hour >= 12 ? 'PM' : 'AM'
    const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour
    return `${displayHour}:00 ${suffix}`
  }
  if (reportType === 'dailySum') {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    return days[Number(period)] || String(period)
  }
  if (period instanceof Date) {
    // Format based on report type
    const options: Intl.DateTimeFormatOptions = { timeZone: timezone }
    switch (reportType) {
      case 'hours':
        options.hour = '2-digit'
        options.minute = '2-digit'
        options.day = 'numeric'
        options.month = 'short'
        break
      case 'days':
        options.weekday = 'short'
        options.day = 'numeric'
        options.month = 'short'
        break
      case 'weeks':
        options.day = 'numeric'
        options.month = 'short'
        break
      case 'months':
        options.month = 'long'
        options.year = 'numeric'
        break
    }
    return period.toLocaleDateString('es-MX', options)
  }
  return String(period)
}
