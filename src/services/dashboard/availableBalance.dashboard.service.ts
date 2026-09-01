import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { Prisma, TransactionCardType, SettlementStatus, SimulationType, PaymentMethod } from '@prisma/client'
import { NotFoundError } from '../../errors/AppError'
import { getEffectivePaymentConfig } from '@/services/organization-payment-config.service'
import { calculateSettlementDate, findActiveSettlementConfig } from '../payments/settlementCalculation.service'
import { addDays } from 'date-fns'
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'
import { projectPaymentSettlement, type ActiveConfig } from './settlementCalendar.dashboard.service'
import { DEFAULT_TIMEZONE } from '../../utils/datetime'
import { utcTs } from '../../utils/sqlDates'
import { getLastCloseoutDate } from './cashCloseout.dashboard.service'
import { paymentIsAvoqadoSettled, TENDER_SEMANTICS_SELECT } from '../shared/tenderSemantics'

// Extended card type that includes CASH (for frontend compatibility)
// CASH is not in Prisma enum but we treat it as a synthetic type
export type ExtendedCardType = TransactionCardType | 'CASH'

/**
 * Available Balance Dashboard Service
 *
 * Provides high-level functions for the Available Balance feature.
 * This service aggregates settlement data and presents it in a user-friendly format.
 *
 * Key functions:
 * - Get available balance summary (now, pending, next settlement)
 * - Breakdown by card type (Debit, Credit, Amex)
 * - Settlement timeline (past + future)
 * - Simulate transactions
 * - Project future balance based on historical patterns
 */

export interface AvailableBalanceSummary {
  totalSales: number
  totalFees: number
  availableNow: number // Already settled
  pendingSettlement: number // Awaiting settlement
  estimatedNextSettlement: {
    date: Date | null
    amount: number
  }
  // Card money we counted but could NOT cost (no TransactionCost — e.g. a merchant
  // account with no VenuePricingStructure). Surfaced so the UI can explain why the
  // per-card-type breakdown (which excludes these) doesn't sum to the summary:
  //   Σ byCardType.netAmount + uncostedAmount ≈ availableNow + pendingSettlement.
  uncostedCount: number
  uncostedAmount: number
}

export interface CardTypeBreakdown {
  cardType: ExtendedCardType
  baseSales: number // Venta (monto sin propina)
  tips: number // Propina
  totalSales: number // monto + propina (lo que el cliente cargó a la tarjeta)
  fees: number
  netAmount: number // totalSales - fees
  settlementDays: number | null // Typical settlement days (0 for cash - instant)
  pendingAmount: number
  settledAmount: number
  transactionCount: number
}

export interface TimelineEntry {
  date: Date
  cardType: ExtendedCardType
  transactionCount: number
  grossAmount: number
  fees: number
  netAmount: number
  status: SettlementStatus
  estimatedSettlementDate: Date | null
}

/**
 * A card payment's money is "available" (settled) once its estimated settlement
 * date has passed — the funds land on that date — OR it was explicitly confirmed
 * SETTLED. This is AUTOMATIC and date-driven: it does NOT require the manual
 * "confirmar liquidación" step, which venues don't use. Without this, money that
 * already landed would show as perpetually "pending" until someone clicked a
 * button nobody clicks.
 */
function hasSettlementLanded(status: SettlementStatus, estimatedSettlementDate: Date | null, now: Date): boolean {
  if (status === SettlementStatus.SETTLED) return true
  return estimatedSettlementDate != null && estimatedSettlementDate.getTime() <= now.getTime()
}

/**
 * Get available balance summary for a venue
 *
 * @param venueId - Venue ID
 * @param dateRange - Optional date range filter
 * @returns Available balance summary (includes CASH as immediately available)
 */
export async function getAvailableBalance(venueId: string, dateRange?: { from: Date; to: Date }): Promise<AvailableBalanceSummary> {
  logger.info('Fetching available balance summary', { venueId, dateRange })

  // Build base where clause for date range
  const dateFilter: any = {}
  if (dateRange) {
    dateFilter.createdAt = {
      gte: dateRange.from,
      lte: dateRange.to,
    }
  }

  const venueRecord = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  const venueTimezone = venueRecord?.timezone || DEFAULT_TIMEZONE

  // Get all completed card payments with settlement info
  //
  // 🔑 El saldo disponible es la promesa "Avoqado te va a depositar esto", así que
  // sólo puede contener dinero que Avoqado PROCESÓ. Una venta cobrada con una
  // terminal ajena (BBVA) o registrada como transferencia directa SÍ se registra en
  // Avoqado —centraliza use o no la TPV— y cuenta en ventas, corte, inventario y
  // reportes; pero ese dinero ya lo tiene el negocio o se lo deposita el otro banco.
  // El filtro por `paymentIsAvoqadoSettled` va DESPUÉS del query a propósito: un
  // `not:` de Prisma sobre un enum nullable deja fuera los NULL (todo lo histórico),
  // que es justo lo que NO queremos cambiar. Ver `shared/tenderSemantics.ts`.
  // ⚠️ Este findMany NO se convirtió a GROUP BY a propósito (2026-09-01): cada pago
  // pendiente pasa por `projectPaymentSettlement`, el motor de liquidación vivo
  // (config vigente por fecha, cutoff con timezone, días hábiles). Replicarlo en SQL
  // sería mantener el motor del dinero en DOS lenguajes. Lo que sí se recortó es el
  // ANCHO de cada fila: de todas las columnas + transaction completa a los campos que
  // el cálculo usa. Los rangos que devuelvan resultados gigantes los denuncia el
  // [query-guard] de runtime.
  const cardPaymentsRaw = await prisma.payment.findMany({
    where: {
      venueId,
      status: 'COMPLETED',
      method: {
        not: PaymentMethod.CASH, // Exclude cash, handle separately
      },
      ...dateFilter,
    },
    select: {
      amount: true,
      tipAmount: true,
      createdAt: true,
      merchantAccountId: true,
      ...TENDER_SEMANTICS_SELECT,
      transaction: {
        select: {
          status: true,
          estimatedSettlementDate: true,
          netSettlementAmount: true,
        },
      },
      transactionCost: {
        select: {
          venueChargeAmount: true,
          venueFixedFee: true,
          transactionType: true,
        },
      },
    },
  })

  // Dinero que Avoqado NO procesó (terminal ajena, transferencia directa, tender
  // personalizado) queda fuera del saldo. Con `fundsFlow` sin estampar —todo lo
  // histórico— el predicado cae al comportamiento legacy y el número no se mueve.
  const cardPayments = cardPaymentsRaw.filter(paymentIsAvoqadoSettled)

  // Settlement dates/nets for still-PENDING money are RECOMPUTED live via the same
  // shared engine as the week strip / settlement calendar / timeline — NOT read from
  // the stored transaction.{estimatedSettlementDate,netSettlementAmount}, which can go
  // stale (pre-engine-fix dates, a rate correction, a payment/tip edit after the first
  // estimate). Without this, "Próximo depósito" (this function) could disagree by a few
  // cents or a day with the settlement-week strip on the SAME page, which recomputes
  // live already. Money already SETTLED is left untouched — that already happened, and
  // recomputing after the fact would rewrite history for money the bank already moved.
  const pendingMerchantIds = Array.from(new Set(cardPayments.map(p => p.merchantAccountId).filter((x): x is string => Boolean(x))))
  const settlementConfigs: ActiveConfig[] = pendingMerchantIds.length
    ? await prisma.settlementConfiguration.findMany({
        where: { merchantAccountId: { in: pendingMerchantIds } },
        select: {
          merchantAccountId: true,
          cardType: true,
          settlementDays: true,
          settlementDayType: true,
          cutoffTime: true,
          cutoffTimezone: true,
          effectiveFrom: true,
          effectiveTo: true,
        },
        orderBy: { effectiveFrom: 'desc' },
      })
    : []

  // Get CASH payments (instant settlement, 0 fees) — agregado en Postgres: la única
  // lectura era la suma. Both REGULAR and REFUND payments carry status=COMPLETED;
  // refunds have negative amount AND (since 2026-04-19) negative tipAmount so
  // summing signed values across both fields yields the correct net cash balance.
  //
  // ⚠️ Réplica deliberada del where original: `{ createdAt: { gt: lastCloseout },
  // ...dateFilter }` — el spread PISABA el `gt`, así que con rango explícito el
  // corte de caja NO acota (y sin rango, sí). Cambiarlo movería el número.
  const lastCloseout = await getLastCloseoutDate(venueId)
  const cashCreatedAt = dateRange
    ? Prisma.sql`p."createdAt" >= ${utcTs(dateRange.from)} AND p."createdAt" <= ${utcTs(dateRange.to)}`
    : Prisma.sql`p."createdAt" > ${utcTs(lastCloseout)}`
  const cashRows =
    ((await prisma.$queryRaw<Array<{ total: Prisma.Decimal | null }>>`
    SELECT SUM(p."amount" + COALESCE(p."tipAmount", 0)) AS "total"
    FROM "Payment" p
    WHERE p."venueId" = ${venueId} AND p."status" = 'COMPLETED' AND p."method" = 'CASH'
      AND ${cashCreatedAt}
  `) as Array<{ total: Prisma.Decimal | null }>) ?? []

  // Calculate totals
  const now = new Date()
  let totalSales = 0
  let totalFees = 0
  let availableNow = 0
  let pendingSettlement = 0
  // Card money we could NOT cost (no TransactionCost — e.g. a merchant account
  // without a VenuePricingStructure). Counted into the balance at fee 0, but
  // surfaced so the UI can explain the gap vs the per-card-type breakdown.
  let uncostedCount = 0
  let uncostedAmount = 0
  const upcomingSettlements: { date: Date; amount: number }[] = []

  // Process card payments
  for (const payment of cardPayments) {
    // Include the tip: customer charged amount + tip; commission is on amount+tip.
    const amount = Number(payment.amount) + Number(payment.tipAmount ?? 0)
    // Venue fee = percentage charge + per-transaction fixed fee. Dropping the
    // fixed fee overstated the net the venue receives (it is netted out by the
    // settlement engine, so the stored netSettlementAmount already includes it).
    const fees = payment.transactionCost
      ? Number(payment.transactionCost.venueChargeAmount) + Number(payment.transactionCost.venueFixedFee)
      : 0
    const netAmount = amount - fees

    if (!payment.transactionCost) {
      uncostedCount += 1
      uncostedAmount += amount
    }

    totalSales += amount
    totalFees += fees

    // Recompute the settlement projection LIVE via the shared engine (date + net) —
    // wins over the stored transaction fields for money not yet settled. Falls back
    // to the stored values when a payment can't be projected (no cost / no rule).
    const projected =
      payment.transactionCost && payment.merchantAccountId
        ? projectPaymentSettlement(
            {
              amount: payment.amount,
              tipAmount: payment.tipAmount,
              createdAt: payment.createdAt,
              merchantAccountId: payment.merchantAccountId,
              transactionCost: payment.transactionCost,
            },
            settlementConfigs,
            venueTimezone,
          )
        : null
    // Noon venue-local avoids any day-boundary ambiguity when read back as an instant.
    const projectedDate = projected ? fromZonedTime(`${projected.settlementDateKey}T12:00:00.000`, venueTimezone) : null

    if (payment.transaction) {
      const { status, estimatedSettlementDate, netSettlementAmount } = payment.transaction

      if (status === SettlementStatus.SETTLED) {
        // Already landed and confirmed — authoritative; never rewrite money that
        // already moved, even if a rate correction happened afterward.
        availableNow += Number(netSettlementAmount || netAmount)
        continue
      }

      const effectiveDate = projectedDate ?? estimatedSettlementDate
      const effectiveNet = projected ? projected.net : Number(netSettlementAmount || netAmount)

      if (hasSettlementLanded(status, effectiveDate, now)) {
        // Landed automatically — its (recomputed) settlement date has passed.
        availableNow += effectiveNet
      } else {
        // Still pending — its settlement date is in the future.
        pendingSettlement += effectiveNet
        if (effectiveDate) {
          upcomingSettlements.push({ date: effectiveDate, amount: effectiveNet })
        }
      }
    } else {
      // No transaction record → no settlement date to project → treat as pending.
      pendingSettlement += netAmount
    }
  }

  // Add CASH payments (instant settlement, 0 fees, 100% available)
  const cashTotal = Number(cashRows[0]?.total ?? 0)
  totalSales += cashTotal
  // Cash has 0 fees, so no totalFees increment
  availableNow += cashTotal // Cash is immediately available

  // Find next settlement date and amount
  let estimatedNextSettlement: { date: Date | null; amount: number } = {
    date: null,
    amount: 0,
  }

  if (upcomingSettlements.length > 0) {
    // Sort by date ascending
    upcomingSettlements.sort((a, b) => a.date.getTime() - b.date.getTime())

    // Group by VENUE-LOCAL calendar day (not UTC) — a settlement instant near a UTC
    // day boundary (e.g. late-evening local time) formats to a DIFFERENT calendar day
    // in UTC than in the venue timezone, which would silently move money to the wrong
    // day here while the week strip (already venue-local) kept it on the right one.
    const settlementsByDate = new Map<string, number>()
    for (const settlement of upcomingSettlements) {
      const dateKey = formatInTimeZone(settlement.date, venueTimezone, 'yyyy-MM-dd')
      const currentAmount = settlementsByDate.get(dateKey) || 0
      settlementsByDate.set(dateKey, currentAmount + settlement.amount)
    }

    // Get first upcoming settlement
    const firstDate = upcomingSettlements[0].date
    const firstDateKey = formatInTimeZone(firstDate, venueTimezone, 'yyyy-MM-dd')
    estimatedNextSettlement = {
      date: firstDate,
      amount: settlementsByDate.get(firstDateKey) || 0,
    }
  }

  logger.info('Available balance calculated', {
    venueId,
    totalSales,
    availableNow,
    pendingSettlement,
    cashTotal,
    uncostedCount,
    uncostedAmount,
  })

  return {
    totalSales,
    totalFees,
    availableNow,
    pendingSettlement,
    estimatedNextSettlement,
    uncostedCount,
    uncostedAmount,
  }
}

/**
 * Get balance breakdown by card type
 *
 * @param venueId - Venue ID
 * @param dateRange - Optional date range filter
 * @returns Array of card type breakdowns (includes CASH as synthetic type)
 */
export async function getBalanceByCardType(venueId: string, dateRange?: { from: Date; to: Date }): Promise<CardTypeBreakdown[]> {
  logger.info('Fetching balance by card type', { venueId, dateRange })

  // Build base where clause for date range
  const dateFilter: any = {}
  if (dateRange) {
    dateFilter.createdAt = {
      gte: dateRange.from,
      lte: dateRange.to,
    }
  }

  // Agregado en Postgres (2026-09-01, incidente del event loop): antes se
  // materializaba cada pago del rango con su transaction completa solo para sumar
  // por tipo de tarjeta. Toda la lógica de este reporte es de columnas ALMACENADAS
  // (a diferencia de getAvailableBalance, que recomputa con el motor vivo), así
  // que la reducción entera baja a SQL:
  //  · settled/pending replica hasSettlementLanded: SETTLED explícito, o fecha
  //    estimada ya pasada.
  //  · COALESCE(netSettlementAmount, neto calculado) replica el `|| netAmount`
  //    de siempre (un Decimal 0 almacenado se respeta; solo NULL cae al cálculo).
  //  · El neto calculado = (monto + propina) − (cargo porcentual + fijo), la misma
  //    fórmula del settlement engine y del Sales Summary.
  const now = new Date()
  const cardDateCond = dateRange
    ? Prisma.sql` AND p."createdAt" >= ${utcTs(dateRange.from)} AND p."createdAt" <= ${utcTs(dateRange.to)}`
    : Prisma.empty
  const cardRows = await prisma.$queryRaw<
    Array<{
      cardType: TransactionCardType
      baseSales: Prisma.Decimal
      tips: Prisma.Decimal
      fees: Prisma.Decimal
      settledAmount: Prisma.Decimal
      pendingAmount: Prisma.Decimal
      transactionCount: number
      firstMerchantAccountId: string | null
    }>
  >`
    SELECT tc."transactionType"::text AS "cardType",
           SUM(p."amount") AS "baseSales",
           SUM(COALESCE(p."tipAmount", 0)) AS "tips",
           SUM(tc."venueChargeAmount" + tc."venueFixedFee") AS "fees",
           COALESCE(SUM(CASE
             WHEN t."paymentId" IS NOT NULL
                  AND (t."status" = 'SETTLED' OR (t."estimatedSettlementDate" IS NOT NULL AND t."estimatedSettlementDate" <= ${utcTs(now)}))
             THEN COALESCE(t."netSettlementAmount",
                           (p."amount" + COALESCE(p."tipAmount", 0)) - (tc."venueChargeAmount" + tc."venueFixedFee"))
             ELSE 0 END), 0) AS "settledAmount",
           COALESCE(SUM(CASE
             WHEN t."paymentId" IS NULL
             THEN (p."amount" + COALESCE(p."tipAmount", 0)) - (tc."venueChargeAmount" + tc."venueFixedFee")
             WHEN NOT (t."status" = 'SETTLED' OR (t."estimatedSettlementDate" IS NOT NULL AND t."estimatedSettlementDate" <= ${utcTs(now)}))
             THEN COALESCE(t."netSettlementAmount",
                           (p."amount" + COALESCE(p."tipAmount", 0)) - (tc."venueChargeAmount" + tc."venueFixedFee"))
             ELSE 0 END), 0) AS "pendingAmount",
           COUNT(*)::int AS "transactionCount",
           (ARRAY_AGG(tc."merchantAccountId" ORDER BY p."createdAt", p."id"))[1] AS "firstMerchantAccountId"
    FROM "Payment" p
    JOIN "TransactionCost" tc ON tc."paymentId" = p."id"
    LEFT JOIN "VenueTransaction" t ON t."paymentId" = p."id"
    WHERE p."venueId" = ${venueId} AND p."status" = 'COMPLETED'${cardDateCond}
    GROUP BY tc."transactionType"
    ORDER BY tc."transactionType"
  `

  // CASH separately (no transaction cost) — same deliberate replica as
  // getAvailableBalance: an explicit dateRange REPLACES the closeout cutoff
  // (the original spread overwrote `gt: lastCloseout`).
  const lastCloseoutForCash = await getLastCloseoutDate(venueId)
  const cashCond = dateRange
    ? Prisma.sql`p."createdAt" >= ${utcTs(dateRange.from)} AND p."createdAt" <= ${utcTs(dateRange.to)}`
    : Prisma.sql`p."createdAt" > ${utcTs(lastCloseoutForCash)}`
  const cashAgg = await prisma.$queryRaw<Array<{ baseSales: Prisma.Decimal | null; tips: Prisma.Decimal | null; n: number }>>`
    SELECT SUM(p."amount") AS "baseSales", SUM(COALESCE(p."tipAmount", 0)) AS "tips", COUNT(*)::int AS "n"
    FROM "Payment" p
    WHERE p."venueId" = ${venueId} AND p."status" = 'COMPLETED' AND p."method" = 'CASH' AND ${cashCond}
  `

  // Look up active SettlementConfiguration per (merchantAccountId, cardType)
  // so the UI can show the configured rule (e.g. "1 día háb.") instead of
  // averaging calendar-day deltas across historical payments — which was
  // misleading (mixed timezone shifts, weekend gaps, label said "días háb."
  // but the math was on calendar days). The merchant per card type is the one
  // on the group's OLDEST payment (deterministic; before, it was whichever row
  // the DB returned first).
  const merchantAccountIds = Array.from(new Set(cardRows.map(r => r.firstMerchantAccountId).filter(Boolean) as string[]))
  const activeConfigs = merchantAccountIds.length
    ? await prisma.settlementConfiguration.findMany({
        where: {
          merchantAccountId: { in: merchantAccountIds },
          effectiveTo: null,
        },
        select: { merchantAccountId: true, cardType: true, settlementDays: true },
      })
    : []
  const configuredDays = new Map<string, number>() // key: `${merchantAccountId}::${cardType}`
  for (const cfg of activeConfigs) {
    configuredDays.set(`${cfg.merchantAccountId}::${cfg.cardType}`, cfg.settlementDays)
  }

  // Ensamblar en el mismo shape de siempre (cash al final, como synthetic type)
  const byCardType = new Map<
    ExtendedCardType,
    {
      baseSales: number // monto sin propina
      tips: number // propina
      totalSales: number // monto + propina
      fees: number
      pendingAmount: number
      settledAmount: number
      transactionCount: number
      settlementDays: number | null // configured business days from SettlementConfiguration
    }
  >()

  for (const row of cardRows) {
    const baseSales = Number(row.baseSales)
    const tips = Number(row.tips)
    byCardType.set(row.cardType, {
      baseSales,
      tips,
      totalSales: baseSales + tips,
      fees: Number(row.fees),
      pendingAmount: Number(row.pendingAmount),
      settledAmount: Number(row.settledAmount),
      transactionCount: row.transactionCount,
      settlementDays: row.firstMerchantAccountId ? (configuredDays.get(`${row.firstMerchantAccountId}::${row.cardType}`) ?? null) : null,
    })
  }

  // Add CASH payments as synthetic card type (instant settlement, 0 fees)
  const cashCount = cashAgg[0]?.n ?? 0
  if (cashCount > 0) {
    const cashBase = Number(cashAgg[0]?.baseSales ?? 0)
    const cashTips = Number(cashAgg[0]?.tips ?? 0)
    const cashTotalSales = cashBase + cashTips
    byCardType.set('CASH', {
      baseSales: cashBase,
      tips: cashTips,
      totalSales: cashTotalSales,
      fees: 0, // Cash has no processing fees
      pendingAmount: 0, // Cash is never pending
      settledAmount: cashTotalSales, // Cash is always immediately settled
      transactionCount: cashCount,
      settlementDays: 0, // Instant settlement
    })
  }

  // Convert map to array
  const breakdown: CardTypeBreakdown[] = []
  for (const [cardType, data] of byCardType) {
    breakdown.push({
      cardType,
      baseSales: data.baseSales,
      tips: data.tips,
      totalSales: data.totalSales,
      fees: data.fees,
      netAmount: data.totalSales - data.fees,
      settlementDays: data.settlementDays,
      pendingAmount: data.pendingAmount,
      settledAmount: data.settledAmount,
      transactionCount: data.transactionCount,
    })
  }

  logger.info('Balance by card type calculated', { venueId, cardTypeCount: breakdown.length })

  return breakdown
}

/**
 * Get settlement timeline (past and future settlements)
 *
 * @param venueId - Venue ID
 * @param dateRange - Date range to show
 * @returns Array of timeline entries grouped by date
 */
export async function getSettlementTimeline(venueId: string, dateRange: { from: Date; to: Date }): Promise<TimelineEntry[]> {
  logger.info('Fetching settlement timeline', { venueId, dateRange })

  const venueRecord = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { timezone: true },
  })
  const venueTimezone = venueRecord?.timezone || DEFAULT_TIMEZONE

  // Get payments within date range. We pull `transactionCost.transactionType`
  // so we can split a transaction-day into per-card-type rows: payments on the
  // same day with different card types settle on different dates, and showing
  // a single Fecha de Liquidación per day misled users.
  //
  // ⚠️ NO convertido a GROUP BY (2026-09-01): cada grupo recomputa su fecha de
  // liquidación con el motor vivo (`projectPaymentSettlement`) sobre el primer
  // pago proyectable — duplicar ese motor en SQL es más peligroso que
  // materializar. El select acota el ancho por fila; el [query-guard] de runtime
  // denuncia los rangos gigantes.
  const payments = await prisma.payment.findMany({
    where: {
      venueId,
      status: 'COMPLETED',
      createdAt: {
        gte: dateRange.from,
        lte: dateRange.to,
      },
    },
    select: {
      amount: true,
      tipAmount: true,
      createdAt: true,
      merchantAccountId: true,
      method: true,
      transaction: {
        select: {
          status: true,
          estimatedSettlementDate: true,
        },
      },
      transactionCost: {
        select: {
          venueChargeAmount: true,
          venueFixedFee: true,
          transactionType: true,
        },
      },
    },
    orderBy: {
      createdAt: 'asc',
    },
  })

  // Settlement dates are RECOMPUTED on read via the corrected engine (same shared
  // helper as the week strip / settlement calendar), NOT taken from the stored
  // per-payment estimatedSettlementDate: payments created before the 2026-07-04
  // engine fix carry stale stored dates (e.g. weekend landings) and would
  // contradict the week strip rendered on the same page. The stored date remains
  // only as a fallback when a payment can't be projected (no cost / no rule).
  const merchantIds = Array.from(new Set(payments.map(p => p.merchantAccountId).filter((x): x is string => Boolean(x))))
  const configs: ActiveConfig[] = merchantIds.length
    ? await prisma.settlementConfiguration.findMany({
        where: { merchantAccountId: { in: merchantIds } },
        select: {
          merchantAccountId: true,
          cardType: true,
          settlementDays: true,
          settlementDayType: true,
          cutoffTime: true,
          cutoffTimezone: true,
          effectiveFrom: true,
          effectiveTo: true,
        },
        orderBy: { effectiveFrom: 'desc' },
      })
    : []

  // Group by (transaction date, card type)
  const timelineMap = new Map<string, TimelineEntry>()
  const recomputedGroups = new Set<string>() // groups whose date came from the live engine (wins over stored)

  for (const payment of payments) {
    const dateKey = formatInTimeZone(payment.createdAt, venueTimezone, 'yyyy-MM-dd')
    const cardType: ExtendedCardType =
      payment.method === PaymentMethod.CASH ? 'CASH' : (payment.transactionCost?.transactionType ?? TransactionCardType.OTHER)
    const groupKey = `${dateKey}::${cardType}`
    // Include the tip: customer charged amount + tip; commission is on amount+tip.
    const amount = Number(payment.amount) + Number(payment.tipAmount ?? 0)
    // Venue fee = percentage charge + per-transaction fixed fee.
    const fees = payment.transactionCost
      ? Number(payment.transactionCost.venueChargeAmount) + Number(payment.transactionCost.venueFixedFee)
      : 0
    const netAmount = amount - fees

    if (!timelineMap.has(groupKey)) {
      timelineMap.set(groupKey, {
        date: new Date(`${dateKey}T00:00:00.000Z`),
        cardType,
        transactionCount: 0,
        grossAmount: 0,
        fees: 0,
        netAmount: 0,
        status: SettlementStatus.PENDING,
        estimatedSettlementDate: null,
      })
    }

    const entry = timelineMap.get(groupKey)!
    entry.transactionCount += 1
    entry.grossAmount += amount
    entry.fees += fees
    entry.netAmount += netAmount

    // Prefer the live-engine date; fall back to the first stored date otherwise.
    const projected =
      payment.method !== PaymentMethod.CASH && payment.merchantAccountId && payment.transactionCost
        ? projectPaymentSettlement(
            {
              amount: payment.amount,
              tipAmount: payment.tipAmount,
              createdAt: payment.createdAt,
              merchantAccountId: payment.merchantAccountId,
              transactionCost: payment.transactionCost,
            },
            configs,
            venueTimezone,
          )
        : null
    if (projected && !recomputedGroups.has(groupKey)) {
      // Noon venue-local: formats back to the same calendar day in any client tz handling.
      entry.estimatedSettlementDate = fromZonedTime(`${projected.settlementDateKey}T12:00:00.000`, venueTimezone)
      recomputedGroups.add(groupKey)
    } else if (!recomputedGroups.has(groupKey) && payment.transaction?.estimatedSettlementDate && !entry.estimatedSettlementDate) {
      entry.estimatedSettlementDate = payment.transaction.estimatedSettlementDate
    }

    // If any transaction in the group is settled, mark group as settled
    if (payment.transaction?.status === SettlementStatus.SETTLED) {
      entry.status = SettlementStatus.SETTLED
    }
  }

  const timeline = Array.from(timelineMap.values()).sort((a, b) => {
    const t = a.date.getTime() - b.date.getTime()
    return t !== 0 ? t : a.cardType.localeCompare(b.cardType)
  })

  logger.info('Settlement timeline calculated', { venueId, entryCount: timeline.length })

  return timeline
}

/**
 * Simulate a manual transaction
 *
 * @param venueId - Venue ID
 * @param userId - User performing the simulation
 * @param params - Simulation parameters
 * @returns Simulation results
 */
export async function simulateTransaction(
  venueId: string,
  userId: string,
  params: {
    amount: number
    cardType: TransactionCardType
    transactionDate: Date
    transactionTime?: string
  },
): Promise<{
  grossAmount: number
  estimatedSettlementDate: Date | null
  netAmount: number
  fees: number
  settlementDays: number | null
  configuration: {
    settlementDays: number
    settlementDayType: string
    cutoffTime: string
  } | null
}> {
  logger.info('Simulating transaction', { venueId, params })

  // Get venue payment config to find merchant account (with org-level fallback)
  const effectiveResult = await getEffectivePaymentConfig(venueId)

  if (!effectiveResult) {
    throw new NotFoundError('Venue payment configuration not found')
  }

  const primaryAccountId = effectiveResult.config.primaryAccountId

  // Find settlement configuration
  const config = await findActiveSettlementConfig(primaryAccountId, params.cardType, params.transactionDate)

  if (!config) {
    logger.warn('No settlement configuration found for simulation', {
      venueId,
      cardType: params.cardType,
    })

    return {
      grossAmount: params.amount,
      estimatedSettlementDate: null,
      netAmount: params.amount,
      fees: 0,
      settlementDays: null,
      configuration: null,
    }
  }

  // Calculate settlement date
  const estimatedSettlementDate = calculateSettlementDate(params.transactionDate, config)

  // Calculate settlement days
  const settlementDays = Math.ceil((estimatedSettlementDate.getTime() - params.transactionDate.getTime()) / (1000 * 60 * 60 * 24))

  // Estimate fees (simplified - real calculation would need pricing structure)
  // For simulation, we'll use approximate percentages
  const feeRates: Record<TransactionCardType, number> = {
    [TransactionCardType.DEBIT]: 0.03, // 3%
    [TransactionCardType.CREDIT]: 0.035, // 3.5%
    [TransactionCardType.AMEX]: 0.04, // 4%
    [TransactionCardType.INTERNATIONAL]: 0.045, // 4.5%
    [TransactionCardType.OTHER]: 0.03,
  }

  const feeRate = feeRates[params.cardType]
  const fees = params.amount * feeRate
  const netAmount = params.amount - fees

  // Save simulation record
  const simulation = await prisma.settlementSimulation.create({
    data: {
      venueId,
      userId,
      simulationType: SimulationType.MANUAL_TRANSACTION,
      simulatedAmount: params.amount,
      cardType: params.cardType,
      simulatedDate: params.transactionDate,
      simulatedTime: params.transactionTime,
      results: {
        estimatedSettlementDate,
        netAmount,
        fees,
        settlementDays,
        configUsed: config.id,
      },
    },
  })

  logger.info('Transaction simulation completed', { simulationId: simulation.id })

  return {
    grossAmount: params.amount,
    estimatedSettlementDate,
    netAmount,
    fees,
    settlementDays,
    configuration: {
      settlementDays: config.settlementDays,
      settlementDayType: config.settlementDayType,
      cutoffTime: config.cutoffTime,
    },
  }
}

/**
 * Get settlement calendar - transactions grouped by settlement date
 *
 * This shows exactly how much money will be deposited each day.
 * Example: If Amex transaction on Nov 1 settles on Nov 3, and Visa transaction
 * on Nov 2 also settles on Nov 3, both amounts are grouped together for Nov 3.
 *
 * CASH payments are shown on their transaction date as instantly settled.
 *
 * @param venueId - Venue ID
 * @param dateRange - Date range of settlement dates to query
 * @returns Calendar entries grouped by settlement date
 */
export async function getSettlementCalendar(
  venueId: string,
  dateRange: { from: Date; to: Date },
): Promise<
  Array<{
    settlementDate: Date
    totalNetAmount: number
    transactionCount: number
    status: SettlementStatus
    byCardType: Array<{
      cardType: ExtendedCardType
      netAmount: number
      transactionCount: number
    }>
  }>
> {
  logger.info('Fetching settlement calendar', { venueId, dateRange })

  // Resolve venue timezone so we group by the user's local date, not UTC.
  // Without this, settlements crossing midnight UTC end up in different UTC
  // groups but render under the same local date in the frontend.
  const venueRecord = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { timezone: true },
  })
  const venueTimezone = venueRecord?.timezone || DEFAULT_TIMEZONE

  // Agregado en Postgres (2026-09-01): este calendario agrupa por la fecha de
  // liquidación ALMACENADA a propósito (no recomputa con el motor vivo), así que
  // la reducción baja completa a SQL: una fila por (día local de liquidación ×
  // tipo de tarjeta) para tarjetas, y una por día local para efectivo. Node solo
  // arma el anidado por fecha, igual que siempre.
  const cardGroups = await prisma.$queryRaw<
    Array<{
      dateKey: string
      cardType: string
      minSettlement: Date
      net: Prisma.Decimal
      n: number
      anySettled: boolean
      firstStatus: SettlementStatus
    }>
  >`
    SELECT to_char((t."estimatedSettlementDate" AT TIME ZONE 'UTC') AT TIME ZONE ${venueTimezone}, 'YYYY-MM-DD') AS "dateKey",
           COALESCE(tc."transactionType"::text, 'OTHER') AS "cardType",
           MIN(t."estimatedSettlementDate") AS "minSettlement",
           SUM(COALESCE(t."netSettlementAmount", 0)) AS "net",
           COUNT(*)::int AS "n",
           BOOL_OR(t."status" = 'SETTLED') AS "anySettled",
           (ARRAY_AGG(t."status"::text ORDER BY t."estimatedSettlementDate", p."id"))[1] AS "firstStatus"
    FROM "Payment" p
    JOIN "VenueTransaction" t ON t."paymentId" = p."id"
    LEFT JOIN "TransactionCost" tc ON tc."paymentId" = p."id"
    WHERE p."venueId" = ${venueId}
      AND p."status" = 'COMPLETED'
      AND p."method" <> 'CASH'
      AND t."estimatedSettlementDate" >= ${utcTs(dateRange.from)}
      AND t."estimatedSettlementDate" <= ${utcTs(dateRange.to)}
    GROUP BY 1, 2
    ORDER BY MIN(t."estimatedSettlementDate"), 2
  `

  // CASH in range (instant settlement on transaction date), since last closeout.
  const lastCloseoutForCalendar = await getLastCloseoutDate(venueId)
  const cashGroups = await prisma.$queryRaw<Array<{ dateKey: string; firstCreated: Date; net: Prisma.Decimal; n: number }>>`
    SELECT to_char((p."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${venueTimezone}, 'YYYY-MM-DD') AS "dateKey",
           MIN(p."createdAt") AS "firstCreated",
           SUM(p."amount" + COALESCE(p."tipAmount", 0)) AS "net",
           COUNT(*)::int AS "n"
    FROM "Payment" p
    WHERE p."venueId" = ${venueId}
      AND p."status" = 'COMPLETED'
      AND p."method" = 'CASH'
      AND p."createdAt" > ${utcTs(lastCloseoutForCalendar)}
      AND p."createdAt" >= ${utcTs(dateRange.from)}
      AND p."createdAt" <= ${utcTs(dateRange.to)}
    GROUP BY 1
    ORDER BY MIN(p."createdAt")
  `

  // Group by settlement date — mismo armado de siempre: la fecha del entry es la
  // del primer pago visto (con las filas en orden ascendente = la mínima del día)
  // y el status del día se vuelve SETTLED si CUALQUIER transacción lo está.
  const calendarMap = new Map<
    string,
    {
      settlementDate: Date
      totalNetAmount: number
      transactionCount: number
      status: SettlementStatus
      byCardType: Map<
        ExtendedCardType,
        {
          netAmount: number
          transactionCount: number
        }
      >
    }
  >()

  for (const group of cardGroups) {
    if (!calendarMap.has(group.dateKey)) {
      calendarMap.set(group.dateKey, {
        settlementDate: group.minSettlement,
        totalNetAmount: 0,
        transactionCount: 0,
        status: group.firstStatus,
        byCardType: new Map(),
      })
    }

    const entry = calendarMap.get(group.dateKey)!
    entry.totalNetAmount += Number(group.net)
    entry.transactionCount += group.n
    entry.byCardType.set(group.cardType as ExtendedCardType, {
      netAmount: Number(group.net),
      transactionCount: group.n,
    })
    if (group.anySettled) {
      entry.status = SettlementStatus.SETTLED
    }
  }

  for (const group of cashGroups) {
    if (!calendarMap.has(group.dateKey)) {
      calendarMap.set(group.dateKey, {
        settlementDate: group.firstCreated,
        totalNetAmount: 0,
        transactionCount: 0,
        status: SettlementStatus.SETTLED, // Cash is always settled
        byCardType: new Map(),
      })
    }

    const entry = calendarMap.get(group.dateKey)!
    entry.totalNetAmount += Number(group.net)
    entry.transactionCount += group.n
    entry.byCardType.set('CASH', {
      netAmount: Number(group.net),
      transactionCount: group.n,
    })
  }

  // Convert map to array
  const calendar = Array.from(calendarMap.values()).map(entry => ({
    settlementDate: entry.settlementDate,
    totalNetAmount: entry.totalNetAmount,
    transactionCount: entry.transactionCount,
    status: entry.status,
    byCardType: Array.from(entry.byCardType.entries()).map(([cardType, data]) => ({
      cardType,
      netAmount: data.netAmount,
      transactionCount: data.transactionCount,
    })),
  }))

  logger.info('Settlement calendar calculated', { venueId, entryCount: calendar.length })

  return calendar
}

/**
 * Project future balance based on historical patterns
 *
 * @param venueId - Venue ID
 * @param projectionDays - Number of days to project forward
 * @returns Projected daily balances
 */
export async function projectHistoricalBalance(
  venueId: string,
  projectionDays: number = 7,
): Promise<{
  projectedDailyRevenue: number
  projectedDailySettlements: { date: Date; amount: number }[]
}> {
  logger.info('Projecting future balance', { venueId, projectionDays })

  // Get last 30 days of completed payments to establish pattern
  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

  // Agregado en Postgres (2026-09-01): solo se necesitaba la suma por día. El
  // bucket es el día UTC A PROPÓSITO — el código de siempre agrupaba con
  // `toISOString().split('T')[0]`, y la columna guarda UTC real, así que el
  // to_char directo (sin AT TIME ZONE) reproduce exactamente esos buckets.
  const dailyRows = await prisma.$queryRaw<Array<{ day: string; total: Prisma.Decimal; n: number }>>`
    SELECT to_char(p."createdAt", 'YYYY-MM-DD') AS "day",
           SUM(p."amount") AS "total",
           COUNT(*)::int AS "n"
    FROM "Payment" p
    WHERE p."venueId" = ${venueId} AND p."status" = 'COMPLETED' AND p."createdAt" >= ${utcTs(thirtyDaysAgo)}
    GROUP BY 1
  `

  // Calculate average daily revenue
  const totalByDay = new Map(dailyRows.map(r => [r.day, Number(r.total)]))
  const totalRevenue = dailyRows.reduce((sum, r) => sum + Number(r.total), 0)
  const paymentCount = dailyRows.reduce((sum, r) => sum + r.n, 0)
  const projectedDailyRevenue = paymentCount > 0 ? totalRevenue / 30 : 0

  // Project future settlements (simplified - assumes average settlement time)
  const projectedDailySettlements: { date: Date; amount: number }[] = []
  const avgSettlementDays = 2 // Simplified assumption

  for (let i = 0; i < projectionDays; i++) {
    const settlementDate = addDays(new Date(), i)
    const transactionDate = addDays(settlementDate, -avgSettlementDays)

    // Check if we have historical data for this transaction date (UTC day)
    const historicalAmount = totalByDay.get(transactionDate.toISOString().split('T')[0]) ?? 0

    if (historicalAmount > 0) {
      projectedDailySettlements.push({
        date: settlementDate,
        amount: historicalAmount * 0.965, // Assume 3.5% fees
      })
    }
  }

  logger.info('Balance projection completed', {
    venueId,
    projectedDailyRevenue,
    settlementCount: projectedDailySettlements.length,
  })

  return {
    projectedDailyRevenue,
    projectedDailySettlements,
  }
}
