/**
 * ⚠️ TEMPORARY TECH DEBT — DELETE WHEN NATIVE QR PAYMENTS SHIP ⚠️
 *
 * Single entry point to read venue payments for analytics (KPIs, charts,
 * settlement aggregations) that need to include MindForm's legacy QR payments
 * stored in the old avo-pwa Postgres database.
 *
 * Why this file exists:
 *   - MindForm's QR flow was built on a separate Postgres DB (legacy avo-pwa).
 *   - Until we migrate it to the native Avoqado QR module, its payments must
 *     still appear in this venue's /home KPIs, pie charts, tips-over-time, etc.
 *   - Without this bridge, MindForm sees incomplete totals in the dashboard.
 *
 * Why centralize it here (instead of copy-pasting `if (isMindForm)` everywhere):
 *   - Exactly ONE place owns the MindForm branch logic.
 *   - The non-MindForm path (~999 other venues) pays the cost of a single
 *     string comparison — the legacy pool (`legacyPool.ts`) stays lazy and
 *     never opens a connection.
 *   - When the native QR module ships, we delete this file + callers revert to
 *     a direct `prisma.payment.findMany` call.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHEN TO DELETE THIS FILE:
 *   Trigger: MindForm migrates to the native Avoqado QR flow and all its
 *   historical legacy payments are either imported into the new `Payment`
 *   table or intentionally retired from analytics.
 *
 *   Steps:
 *     1. Confirm no Payment with id prefix `legacy-` is referenced by any
 *        report, digital receipt, or settlement record.
 *     2. Delete this file (`mergedPayments.service.ts`).
 *     3. Delete `qrPayments.legacy.service.ts` and `legacyPool.ts`.
 *     4. Remove `LEGACY_DATABASE_URL` from `.env` and deployment secrets.
 *     5. Replace each `fetchPaymentsForAnalytics(...)` call with a direct
 *        `prisma.payment.findMany({ where: {...}, select: {...} })`.
 *     6. Remove the MindForm branch in
 *        `src/services/dashboard/payment.dashboard.service.ts` (the
 *        `getLegacyPayments` merge inside the payments list endpoint).
 *     7. Run `npm run pre-deploy` + full regression on MindForm's dashboard.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { Prisma, TransactionStatus } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { MINDFORM_NEW_VENUE_ID, getLegacyPayments } from './qrPayments.legacy.service'

export interface AnalyticsPaymentFilters {
  fromDate: Date
  toDate: Date
  /** Include refund-type payments. Default: false (analytics KPIs exclude refunds). */
  includeRefunds?: boolean
  /** Exclude payments attached to cancelled orders. Default: true. */
  excludeCancelledOrders?: boolean
}

/**
 * Normalized analytics payment shape — superset of fields needed by any /home
 * KPI, chart, or aggregation. Always uses `number` for amounts (Decimal → Number
 * conversion happens here so callers don't repeat it).
 */
export interface AnalyticsPayment {
  id: string
  amount: number
  tipAmount: number
  method: string
  type: string
  status: string
  createdAt: Date
  /** Staff who processed (charged) the payment — the tip-attribution axis the cash-closeout uses. Null for QR/self-serve and legacy rows. */
  processedById?: string | null
  processedByName?: string | null
}

/** Filtros de analítica → `where` de Prisma. UNA sola definición para las filas y para las sumas. */
function analyticsWhere(venueId: string, filters: AnalyticsPaymentFilters): Prisma.PaymentWhereInput {
  const { fromDate, toDate, includeRefunds = false, excludeCancelledOrders = true } = filters
  return {
    venueId,
    status: TransactionStatus.COMPLETED,
    createdAt: { gte: fromDate, lte: toDate },
    ...(includeRefunds ? {} : { type: { not: 'REFUND' } }),
    ...(excludeCancelledOrders ? { order: { status: { not: 'CANCELLED' } } } : {}),
  }
}

/**
 * Pagos QR legacy de MindForm, ya filtrados con las MISMAS reglas y normalizados.
 *
 * ⚠️ Gate: para cualquier otro venue devuelve [] SIN tocar la base legacy — el pool
 * (`legacyPool.ts`) sigue perezoso y nunca abre conexión. NO mover la comprobación
 * debajo del `await getLegacyPayments`.
 */
async function legacyAnalyticsPayments(
  venueId: string,
  filters: AnalyticsPaymentFilters,
  /** Qué cuenta `nativeCount` en el log: filas del rango, o sólo las que el agregado consideró. */
  native: { count: number; scope: 'rows' | 'by-method' | 'tips>0' },
): Promise<AnalyticsPayment[]> {
  if (venueId !== MINDFORM_NEW_VENUE_ID) return []
  const { fromDate, toDate, includeRefunds = false } = filters

  logger.info('[MergedPayments] MindForm detected — merging legacy QR payments into analytics', {
    venueId,
    fromDate: fromDate.toISOString(),
    toDate: toDate.toISOString(),
    nativeCount: native.count,
    nativeScope: native.scope,
  })

  const { rows: legacyRows } = await getLegacyPayments({
    startDate: fromDate.toISOString(),
    endDate: toDate.toISOString(),
  })

  // Apply the same analytics filters to legacy rows (mirrors `analyticsWhere` —
  // status=COMPLETED + type != REFUND). The legacy mapper already sets these fields
  // per `mapToPaymentShape` in qrPayments.legacy.service.ts.
  const legacyFiltered = legacyRows.filter(p => {
    if (p.status !== 'COMPLETED') return false
    if (!includeRefunds && p.type === 'REFUND') return false
    return true
  })

  const legacyNormalized: AnalyticsPayment[] = legacyFiltered.map(p => ({
    id: p.id,
    amount: Number(p.amount),
    tipAmount: Number(p.tipAmount),
    method: p.method,
    type: p.type,
    status: p.status,
    createdAt: p.createdAt,
    // Legacy QR payments were customer-initiated — no staff processed them.
    processedById: null,
    processedByName: null,
  }))

  logger.info('[MergedPayments] Legacy merge complete', {
    venueId,
    legacyRows: legacyRows.length,
    legacyKept: legacyNormalized.length,
    total: native.count + legacyNormalized.length,
    nativeScope: native.scope,
  })

  return legacyNormalized
}

/**
 * Fetch all analytics-eligible payments for a venue, merging MindForm's legacy
 * QR payments when applicable. Returns a normalized shape ready for aggregation.
 *
 * ⚠️ Devuelve FILAS sin tope (sólo la ventana de fechas acota). Un rango «este año»
 * son decenas de miles de pagos en un venue grande (incidente 2026-09-01). Si lo que
 * necesitas es un TOTAL, usa `aggregatePaymentsByMethod` / `aggregateTipsByProcessor`
 * de abajo: suman en Postgres y devuelven una fila por grupo.
 */
export async function fetchPaymentsForAnalytics(venueId: string, filters: AnalyticsPaymentFilters): Promise<AnalyticsPayment[]> {
  const newPayments = await prisma.payment.findMany({
    where: analyticsWhere(venueId, filters),
    select: {
      id: true,
      amount: true,
      tipAmount: true,
      method: true,
      type: true,
      status: true,
      createdAt: true,
      processedById: true,
      processedBy: { select: { firstName: true, lastName: true } },
    },
    orderBy: { createdAt: 'desc' },
  })

  const normalized: AnalyticsPayment[] = newPayments.map(p => ({
    id: p.id,
    amount: Number(p.amount),
    tipAmount: Number(p.tipAmount),
    method: String(p.method),
    type: String(p.type),
    status: String(p.status),
    createdAt: p.createdAt,
    processedById: p.processedById ?? null,
    processedByName: p.processedBy ? `${p.processedBy.firstName ?? ''} ${p.processedBy.lastName ?? ''}`.trim() || null : null,
  }))

  // ⚠️ Gate: short-circuit for non-MindForm venues (see legacyAnalyticsPayments).
  if (venueId !== MINDFORM_NEW_VENUE_ID) {
    return normalized
  }

  const legacyNormalized = await legacyAnalyticsPayments(venueId, filters, { count: normalized.length, scope: 'rows' })
  return [...normalized, ...legacyNormalized].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
}

// ─────────────────────────────────────────────────────────────────────────
// Agregados en Postgres (2026-09-01, query-guard en producción)
//
// Las herramientas del MCP `sales_by_payment_method` y `staff_tips` traían TODAS
// las filas del rango a Node sólo para sumarlas: un agente que pide «ventas de este
// año» materializaba 24 mil pagos. Estas dos funciones piden la suma a Postgres
// (`groupBy`, mismo `where` que las filas) y devuelven UNA fila por método o por
// cajero. El puente de MindForm se conserva: sus pagos QR viven en otra base y se
// suman aquí en Node, sólo para ese venue (conjunto histórico finito).
//
// `groupBy` y no `$queryRaw` a propósito: el filtro de fechas queda idéntico al de
// `findMany` (sin la trampa de zona de sesión documentada en `utils/sqlDates.ts`).
// ─────────────────────────────────────────────────────────────────────────

/** Suma por método de pago. `amount` y `tips` van separados: el caller decide si las propinas cuentan. */
export interface AnalyticsMethodTotal {
  method: string
  amount: number
  tips: number
  count: number
}

export async function aggregatePaymentsByMethod(venueId: string, filters: AnalyticsPaymentFilters): Promise<AnalyticsMethodTotal[]> {
  const grupos = await prisma.payment.groupBy({
    by: ['method'],
    where: analyticsWhere(venueId, filters),
    _sum: { amount: true, tipAmount: true },
    _count: { _all: true },
  })

  const porMetodo = new Map<string, AnalyticsMethodTotal>()
  let nativeCount = 0
  for (const g of grupos) {
    const method = String(g.method)
    porMetodo.set(method, {
      method,
      amount: Number(g._sum.amount ?? 0),
      tips: Number(g._sum.tipAmount ?? 0),
      count: g._count._all,
    })
    nativeCount += g._count._all
  }

  for (const p of await legacyAnalyticsPayments(venueId, filters, { count: nativeCount, scope: 'by-method' })) {
    const e = porMetodo.get(p.method) ?? { method: p.method, amount: 0, tips: 0, count: 0 }
    e.amount += p.amount
    e.tips += p.tipAmount
    e.count += 1
    porMetodo.set(p.method, e)
  }

  return [...porMetodo.values()]
}

/**
 * Propinas por quien COBRÓ (Payment.processedById), sólo pagos con propina > 0 —
 * la misma regla del corte de caja. `processedById: null` agrupa los pagos que nadie
 * procesó (QR / autoservicio / legacy).
 */
/** Cajeros distintos cuyo nombre se resuelve por llamada. Un venue real tiene decenas. */
export const MAX_CAJEROS_CON_NOMBRE = 500

export interface AnalyticsProcessorTips {
  processedById: string | null
  processedByName: string | null
  tips: number
  payments: number
}

export async function aggregateTipsByProcessor(venueId: string, filters: AnalyticsPaymentFilters): Promise<AnalyticsProcessorTips[]> {
  const grupos = await prisma.payment.groupBy({
    by: ['processedById'],
    where: { ...analyticsWhere(venueId, filters), tipAmount: { gt: 0 } },
    _sum: { tipAmount: true },
    _count: { _all: true },
  })

  // Nombres: acotado por cajeros DISTINTOS del rango (decenas), nunca por ventas. El tope
  // es real: si algún día hubiera más cajeros que MAX_CAJEROS_CON_NOMBRE, los sobrantes
  // salen como «Sin nombre» y se avisa — nunca se trunca en silencio.
  const ids = grupos.map(g => g.processedById).filter((id): id is string => typeof id === 'string' && id.length > 0)
  const nombres = new Map<string, string | null>()
  if (ids.length > 0) {
    if (ids.length > MAX_CAJEROS_CON_NOMBRE) {
      logger.warn('[MergedPayments] Más cajeros con propina que MAX_CAJEROS_CON_NOMBRE; los sobrantes salen sin nombre', {
        venueId,
        cajeros: ids.length,
        tope: MAX_CAJEROS_CON_NOMBRE,
      })
    }
    const staff = await prisma.staff.findMany({
      where: { id: { in: ids.slice(0, MAX_CAJEROS_CON_NOMBRE) } },
      select: { id: true, firstName: true, lastName: true },
      take: MAX_CAJEROS_CON_NOMBRE,
    })
    for (const s of staff) nombres.set(s.id, `${s.firstName ?? ''} ${s.lastName ?? ''}`.trim() || null)
  }

  const porCajero = new Map<string | null, AnalyticsProcessorTips>()
  let nativeCount = 0
  for (const g of grupos) {
    const id = g.processedById ?? null
    porCajero.set(id, {
      processedById: id,
      processedByName: id ? (nombres.get(id) ?? null) : null,
      tips: Number(g._sum.tipAmount ?? 0),
      payments: g._count._all,
    })
    nativeCount += g._count._all
  }

  for (const p of await legacyAnalyticsPayments(venueId, filters, { count: nativeCount, scope: 'tips>0' })) {
    if (p.tipAmount <= 0) continue
    const e = porCajero.get(null) ?? { processedById: null, processedByName: null, tips: 0, payments: 0 }
    e.tips += p.tipAmount
    e.payments += 1
    porCajero.set(null, e)
  }

  return [...porCajero.values()]
}
