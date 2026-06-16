import { CfdiStatus, OrderStatus, PaymentMethod, PaymentType, TransactionStatus } from '@prisma/client'

import { NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { parseDbDateRange } from '../../utils/datetime'
import { splitIvaIncluded } from '../fiscal/ivaMath'

/**
 * Accounting — Capa A (gerencial, read-model)
 *
 * Estado de resultados de INGRESOS de un local en un periodo. NO es contabilidad fiscal:
 * corre sobre los pagos que el sistema ya tiene, sin capturar nada. Incluido para todos
 * los venues (gateado por permiso `accounting:read`, sin paywall).
 *
 * Convención de dinero: precios IVA-INCLUIDO (en México el precio al público ya trae el IVA).
 *   neto (base) = monto / (1 + tasa) · IVA trasladado = monto − neto
 * Todo se reporta en CENTAVOS enteros para exactitud contable. Las propinas NO son ingreso
 * (se reportan aparte, informativas). Las devoluciones (type=REFUND, monto negativo) se
 * restan del ingreso.
 *
 * Limitación conocida (v1): no hay costo de venta capturado para retail (QUANTITY) ni
 * serializado, por eso este read-model reporta INGRESOS, no utilidad bruta. La tasa de IVA
 * se asume 0.16 a nivel venue (`taxRateAssumed`) — el desglose exacto por producto es una
 * iteración posterior.
 */

const DEFAULT_IVA_RATE = 0.16

export interface IncomeStatementFilters {
  /** Fecha inicial en zona horaria del local, formato 'YYYY-MM-DD'. */
  from: string
  /** Fecha final en zona horaria del local, formato 'YYYY-MM-DD'. */
  to: string
}

export interface IncomeStatement {
  venueId: string
  venueName: string
  currency: 'MXN'
  timezone: string
  period: { from: string; to: string }
  /** Tasa de IVA asumida para el desglose a nivel venue (v1: 0.16). */
  taxRateAssumed: number
  revenue: {
    /** Ventas brutas (IVA-incluido, sin propina), antes de devoluciones. */
    grossSalesCents: number
    /** Devoluciones del periodo (magnitud positiva). */
    refundsCents: number
    /** Ingreso real cobrado = ventas brutas − devoluciones (IVA-incluido). */
    netRevenueCents: number
    /** Base gravable: ingreso neto sin IVA. */
    taxableBaseCents: number
    /** IVA trasladado embebido en el ingreso neto. */
    ivaCents: number
  }
  /** Propinas (informativas, NO forman parte del ingreso). */
  tips: { totalCents: number }
  metrics: { salesCount: number; refundCount: number; averageTicketCents: number }
}

/** Convierte un Decimal/number de pesos a centavos enteros. */
const toCents = (d: { toString(): string } | number | null): number => (d == null ? 0 : Math.round(Number(d) * 100))

/**
 * Calcula el estado de resultados (ingresos) de un local para [from, to].
 *
 * @param venueId  Local (tenant). Toda query se aísla por este id.
 * @param filters  Rango de fechas en zona horaria del local.
 */
export async function getIncomeStatement(venueId: string, filters: IncomeStatementFilters): Promise<IncomeStatement> {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: { name: true, timezone: true },
  })
  if (!venue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found`)
  }

  const timezone = venue.timezone || 'America/Mexico_City'
  // Payment es data creada por Prisma → UTC real. parseDbDateRange convierte los límites
  // del día en zona del local a UTC real (fromZonedTime), NO "fake UTC".
  const { from, to } = parseDbDateRange(filters.from, filters.to, timezone)

  const rows = await prisma.payment.findMany({
    where: {
      venueId,
      status: TransactionStatus.COMPLETED,
      createdAt: { gte: from, lte: to },
      order: { status: { not: OrderStatus.CANCELLED } },
    },
    select: { amount: true, tipAmount: true, type: true },
  })

  let grossSalesCents = 0
  let refundsCents = 0
  let tipsCents = 0
  let salesCount = 0
  let refundCount = 0

  for (const r of rows) {
    // Pagos de prueba del superadmin no son ingreso.
    if (r.type === PaymentType.TEST) continue

    const amountCents = toCents(r.amount) // con signo: las devoluciones ya vienen negativas

    if (r.type === PaymentType.REFUND) {
      refundsCents += Math.abs(amountCents)
      refundCount += 1
      continue
    }

    // REGULAR / FAST / ADJUSTMENT / null (legacy) → venta real
    grossSalesCents += amountCents
    tipsCents += toCents(r.tipAmount)
    salesCount += 1
  }

  const netRevenueCents = grossSalesCents - refundsCents
  const { netCents: taxableBaseCents, taxCents: ivaCents } = splitIvaIncluded(netRevenueCents, DEFAULT_IVA_RATE)
  const averageTicketCents = salesCount > 0 ? Math.round(grossSalesCents / salesCount) : 0

  return {
    venueId,
    venueName: venue.name,
    currency: 'MXN',
    timezone,
    period: { from: filters.from, to: filters.to },
    taxRateAssumed: DEFAULT_IVA_RATE,
    revenue: { grossSalesCents, refundsCents, netRevenueCents, taxableBaseCents, ivaCents },
    tips: { totalCents: tipsCents },
    metrics: { salesCount, refundCount, averageTicketCents },
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Resumen del negocio + Bancos y cajas (Capa A, read-models)
// ───────────────────────────────────────────────────────────────────────────

/** Cada método de cobro cae en una "cuenta": efectivo (caja) o banco (depósito). */
const METHOD_BUCKET: Record<PaymentMethod, { key: string; kind: 'cash' | 'bank' }> = {
  CASH: { key: 'cash', kind: 'cash' },
  CREDIT_CARD: { key: 'card', kind: 'bank' },
  DEBIT_CARD: { key: 'card', kind: 'bank' },
  DIGITAL_WALLET: { key: 'wallet', kind: 'bank' },
  BANK_TRANSFER: { key: 'transfer', kind: 'bank' },
  CRYPTOCURRENCY: { key: 'crypto', kind: 'bank' },
  OTHER: { key: 'other', kind: 'bank' },
}

interface PeriodAccount {
  key: string
  kind: 'cash' | 'bank'
  methods: PaymentMethod[]
  inflowCents: number // con signo (las devoluciones restan)
  count: number // ventas (no devoluciones)
}

interface PeriodPaymentAgg {
  accounts: PeriodAccount[]
  cashInflowCents: number
  electronicInflowCents: number
  feesCents: number
}

/** Resuelve venue + timezone + rango UTC una sola vez. */
async function resolvePeriod(venueId: string, filters: { from: string; to: string }) {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { name: true, timezone: true } })
  if (!venue) throw new NotFoundError(`Venue with ID ${venueId} not found`)
  const timezone = venue.timezone || 'America/Mexico_City'
  const { from, to } = parseDbDateRange(filters.from, filters.to, timezone)
  return { venueName: venue.name, timezone, from, to }
}

/**
 * Agrega los pagos COMPLETADOS del periodo por método de cobro, separando
 * efectivo (caja) de electrónico (banco) y sumando las comisiones de procesamiento.
 * Las devoluciones (type=REFUND, monto negativo) restan del método correspondiente.
 */
async function aggregatePeriodPayments(venueId: string, from: Date, to: Date): Promise<PeriodPaymentAgg> {
  const rows = await prisma.payment.findMany({
    where: {
      venueId,
      status: TransactionStatus.COMPLETED,
      createdAt: { gte: from, lte: to },
      order: { status: { not: OrderStatus.CANCELLED } },
    },
    select: { amount: true, type: true, method: true, feeAmount: true },
  })

  const buckets = new Map<string, PeriodAccount>()
  let feesCents = 0

  for (const r of rows) {
    if (r.type === PaymentType.TEST) continue // pagos de prueba no cuentan
    const method = r.method ?? PaymentMethod.OTHER
    const def = METHOD_BUCKET[method] ?? METHOD_BUCKET.OTHER
    let acc = buckets.get(def.key)
    if (!acc) {
      acc = { key: def.key, kind: def.kind, methods: [], inflowCents: 0, count: 0 }
      buckets.set(def.key, acc)
    }
    if (!acc.methods.includes(method)) acc.methods.push(method)

    const amountCents = toCents(r.amount) // devoluciones ya vienen negativas
    acc.inflowCents += amountCents
    if (r.type === PaymentType.REFUND) continue // no suma conteo ni comisión
    acc.count += 1
    feesCents += toCents(r.feeAmount)
  }

  const accounts = [...buckets.values()].sort((a, b) => b.inflowCents - a.inflowCents)
  let cashInflowCents = 0
  let electronicInflowCents = 0
  for (const a of accounts) {
    if (a.kind === 'cash') cashInflowCents += a.inflowCents
    else electronicInflowCents += a.inflowCents
  }

  return { accounts, cashInflowCents, electronicInflowCents, feesCents }
}

/** Estados de cuenta subidos + cuántos depósitos cuadraron (conciliación bancaria). */
async function reconciliationSummary(venueId: string) {
  const [count, sums] = await Promise.all([
    prisma.bankStatement.count({ where: { venueId } }),
    prisma.bankStatement.aggregate({ where: { venueId }, _sum: { lineCount: true, matchedCount: true } }),
  ])
  return {
    statements: count,
    lineCount: sums._sum.lineCount ?? 0,
    matchedCount: sums._sum.matchedCount ?? 0,
  }
}

export interface BusinessSummary {
  venueId: string
  venueName: string
  currency: 'MXN'
  timezone: string
  period: { from: string; to: string }
  taxRateAssumed: number
  revenue: IncomeStatement['revenue']
  /** Facturación del periodo (CFDIs timbrados). */
  invoicing: {
    stampedCount: number
    stampedTotalCents: number
    nominativeCount: number
    globalCount: number
    /** Aproximación de lo facturado = total de CFDIs timbrados (IVA-incluido). */
    invoicedApproxCents: number
    /** Ingreso neto del periodo aún sin amparar por un CFDI (estimado, ≥ 0). */
    uninvoicedApproxCents: number
    /** % del ingreso neto ya facturado (0-100). */
    invoicedPct: number
  }
  /** Cómo cobró: efectivo (caja) vs electrónico (banco). */
  collection: { cashCents: number; electronicCents: number; cashPct: number }
  costs: { processingFeesCents: number }
  /** Ingreso neto − comisiones de procesamiento. NO es utilidad (no incluye COGS ni gastos). */
  result: { netAfterFeesCents: number }
  tips: { totalCents: number }
  reconciliation: { statements: number; lineCount: number; matchedCount: number }
  metrics: IncomeStatement['metrics']
}

/**
 * Resumen del negocio — la portada de Contabilidad (Capa A). Reúne en una sola
 * vista lo que el dueño quiere saber del periodo: cuánto ingresó, cuánto facturó,
 * cómo cobró (efectivo vs banco), qué pagó de comisiones y si su banco ya cuadró.
 * Read-model: corre sobre Payment + Cfdi + BankStatement, sin capturar nada.
 *
 * @param venueId  Local (tenant). Toda query se aísla por este id.
 * @param filters  Rango de fechas en zona horaria del local (YYYY-MM-DD).
 */
export async function getBusinessSummary(venueId: string, filters: IncomeStatementFilters): Promise<BusinessSummary> {
  const { venueName, timezone, from, to } = await resolvePeriod(venueId, filters)

  const [income, payAgg, recon, stampedAgg, byScope] = await Promise.all([
    getIncomeStatement(venueId, filters),
    aggregatePeriodPayments(venueId, from, to),
    reconciliationSummary(venueId),
    prisma.cfdi.aggregate({
      where: { venueId, status: CfdiStatus.STAMPED, stampedAt: { gte: from, lte: to } },
      _sum: { totalCents: true },
      _count: { _all: true },
    }),
    prisma.cfdi.groupBy({
      by: ['isGlobal'],
      where: { venueId, status: CfdiStatus.STAMPED, stampedAt: { gte: from, lte: to } },
      _count: { _all: true },
    }),
  ])

  const stampedCount = stampedAgg._count._all
  const stampedTotalCents = stampedAgg._sum.totalCents ?? 0
  const globalCount = byScope.find(g => g.isGlobal)?._count._all ?? 0
  const nominativeCount = stampedCount - globalCount

  const netRevenueCents = income.revenue.netRevenueCents
  const invoicedApproxCents = Math.min(stampedTotalCents, Math.max(netRevenueCents, 0))
  const uninvoicedApproxCents = Math.max(0, netRevenueCents - stampedTotalCents)
  const invoicedPct = netRevenueCents > 0 ? Math.round((invoicedApproxCents / netRevenueCents) * 100) : 0

  const cashCents = payAgg.cashInflowCents
  const electronicCents = payAgg.electronicInflowCents
  const totalInflow = cashCents + electronicCents
  const cashPct = totalInflow > 0 ? Math.round((cashCents / totalInflow) * 100) : 0

  return {
    venueId,
    venueName,
    currency: 'MXN',
    timezone,
    period: { from: filters.from, to: filters.to },
    taxRateAssumed: income.taxRateAssumed,
    revenue: income.revenue,
    invoicing: { stampedCount, stampedTotalCents, nominativeCount, globalCount, invoicedApproxCents, uninvoicedApproxCents, invoicedPct },
    collection: { cashCents, electronicCents, cashPct },
    costs: { processingFeesCents: payAgg.feesCents },
    result: { netAfterFeesCents: netRevenueCents - payAgg.feesCents },
    tips: income.tips,
    reconciliation: recon,
    metrics: income.metrics,
  }
}

export interface BankAndCashSummary {
  venueId: string
  venueName: string
  currency: 'MXN'
  timezone: string
  period: { from: string; to: string }
  accounts: PeriodAccount[]
  totals: {
    cashInflowCents: number
    electronicInflowCents: number
    feesCents: number
    /** Lo que debería llegar al banco = electrónico − comisiones. */
    netToBankCents: number
  }
  reconciliation: { statements: number; lineCount: number; matchedCount: number }
}

/**
 * Bancos y cajas — vista de las "cuentas de dinero" del local (Capa A). Para cada
 * forma de cobro (efectivo, tarjetas, transferencias, monederos…) muestra cuánto
 * entró en el periodo, separando lo que se quedó en CAJA (efectivo) de lo que va al
 * BANCO (electrónico, neto de comisiones). Liga con la conciliación bancaria.
 *
 * @param venueId  Local (tenant). Toda query se aísla por este id.
 * @param filters  Rango de fechas en zona horaria del local (YYYY-MM-DD).
 */
export async function getBankAndCashSummary(venueId: string, filters: IncomeStatementFilters): Promise<BankAndCashSummary> {
  const { venueName, timezone, from, to } = await resolvePeriod(venueId, filters)
  const [payAgg, recon] = await Promise.all([aggregatePeriodPayments(venueId, from, to), reconciliationSummary(venueId)])

  return {
    venueId,
    venueName,
    currency: 'MXN',
    timezone,
    period: { from: filters.from, to: filters.to },
    accounts: payAgg.accounts,
    totals: {
      cashInflowCents: payAgg.cashInflowCents,
      electronicInflowCents: payAgg.electronicInflowCents,
      feesCents: payAgg.feesCents,
      netToBankCents: payAgg.electronicInflowCents - payAgg.feesCents,
    },
    reconciliation: recon,
  }
}
