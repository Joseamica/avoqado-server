/**
 * Promotions Sales Report — el COMBO como renglón, con su NOMBRE.
 *
 * Contesta "¿me sirve la promo?": por promoción, cuántas veces se vendió, cuánto
 * valía a precio de lista (bruto), cuánto se regaló (descuento) y cuánto entró
 * (neto), más el desglose por período para la gráfica.
 *
 * ── Por qué existe (decisión del founder, 2026-08-18) ────────────────────────
 * El mercado se parte en dos justo aquí: Fudo, Toast y Maitre'D reportan el
 * combo COMO RENGLÓN ("En el reporte se registra la venta del combo como
 * producto principal"); Square desglosa los COMPONENTES en su Item Sales report
 * ("The Item Sales report shows the individual items from combos sold"). La
 * decisión fue dar **las dos vistas, sin switch**: este reporte responde la
 * primera pregunta y el mix de productos (`sales-by-item`) la segunda, marcando
 * cada componente con "dentro de «Combo X»". Un toggle habría producido doble
 * contabilidad silenciosa si alguien sumara los dos reportes.
 *
 * ── Dos invariantes que NO se negocian ──────────────────────────────────────
 *
 * 1. 🔑 **El nombre sale del SNAPSHOT, no de la promoción viva.** `OrderPromotion
 *    .snapshotJson` guarda el nombre tal como se cobró. Square documenta la
 *    trampa contraria: "If you update the name of a discount, comp or void, it
 *    will be recognized as a separate entry in reporting" — leer el nombre vivo
 *    reescribiría la historia de un período ya cerrado. Renombrar una promoción
 *    a media semana produce DOS renglones aquí, cada uno con lo que el cliente
 *    realmente vio, que es la respuesta honesta.
 *
 * 2. 🔑 **El dinero se calcula desde las LÍNEAS con `lineGrossSql`/
 *    `lineRevenueSql`**, la MISMA definición que usa `sales-by-item`, no desde
 *    los `…Cents` congelados de `OrderPromotion`. Dos razones: (a) así los dos
 *    reportes cuadran al centavo — es el punto entero de dar las dos vistas; y
 *    (b) los cents del snapshot son el valor al momento de aplicar la promo y no
 *    siguen a la línea si después se comparte, se cortesía o se le agrega un
 *    modificador de pago. `OrderPromotion` aporta la IDENTIDAD (nombre, tipo,
 *    veces vendida, needsReview); las líneas aportan el dinero.
 *
 * Los filtros de orden (status/paymentStatus/rango) son literalmente los de
 * `sales-by-item`: si divergen, los dos reportes dejan de cuadrar y vuelve el
 * problema que la decisión del founder quería evitar.
 */

import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { parseDbDateRange } from '@/utils/datetime'
import { sanitizeTimezone } from '@/utils/sanitizeTimezone'
import { localWallClockRaw, utcTsParam } from '@/utils/sqlDates'
import { lineGrossSql, lineRevenueSql } from './lineRevenue'

// ============================================================
// Types
// ============================================================

export type PromotionReportType = 'summary' | 'hours' | 'days' | 'weeks' | 'months'

export interface PromotionSalesFilters {
  startDate: string
  endDate: string
  reportType?: PromotionReportType
  /** Venue IANA timezone — decide en qué día/hora cae cada venta. */
  timezone?: string
}

export interface PromotionSalesRow {
  /** Id de la promoción viva (para enlazar a su pantalla). Puede repetirse si la renombraron. */
  promotionId: string
  /** El nombre TAL COMO SE COBRÓ (snapshot). Nunca el nombre vivo. */
  name: string
  /** BUNDLE | COMBO, del snapshot. */
  type: string | null
  /** FIXED_TOTAL | PER_UNIT (2x1), del snapshot. */
  pricingMode: string | null
  /** Veces que se vendió la promoción (instancias, no líneas). */
  timesSold: number
  /** Valor de lista de sus líneas, modificadores incluidos. */
  grossSales: number
  /** Lo que se regaló. */
  discounts: number
  /** grossSales − discounts. */
  netSales: number
  /** Instancias marcadas para revisión (promo archivada / fuera de vigencia al sincronizar). */
  needsReview: number
}

export interface PromotionPeriodMetrics {
  period: string
  periodLabel?: string
  timesSold: number
  grossSales: number
  discounts: number
  netSales: number
}

export interface PromotionSalesResponse {
  dateRange: { startDate: Date; endDate: Date }
  reportType: PromotionReportType
  timezone: string
  promotions: PromotionSalesRow[]
  byPeriod?: PromotionPeriodMetrics[]
  totals: {
    promotionsCount: number
    timesSold: number
    grossSales: number
    discounts: number
    netSales: number
    needsReview: number
  }
}

// ============================================================
// Shared SQL fragments
// ============================================================

/**
 * Filtro de órdenes — COPIA EXACTA del de `sales-by-item`. Si cambia allá,
 * cambia aquí en el mismo trabajo, o los dos reportes dejan de reconciliar.
 */
const ORDER_SCOPE_SQL = `
      o."venueId" = $1
      AND o."createdAt" >= ${utcTsParam(2)}
      AND o."createdAt" <= ${utcTsParam(3)}
      AND o.status NOT IN ('CANCELLED')
      AND o."paymentStatus" NOT IN ('REFUNDED')
`

/** El nombre cobrado; `Promotion.name` sólo como red de seguridad si el snapshot viniera vacío. */
const SNAPSHOT_NAME_SQL = `COALESCE(NULLIF(op."snapshotJson"->>'name', ''), pr.name, 'Promoción')`
const SNAPSHOT_TYPE_SQL = `COALESCE(NULLIF(op."snapshotJson"->>'type', ''), pr.type::text)`
const SNAPSHOT_MODE_SQL = `COALESCE(NULLIF(op."snapshotJson"->>'pricingMode', ''), pr."pricingMode"::text)`

/** Conversión tolerante a Decimal / BigInt / null de Prisma. */
function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0
  if (typeof value === 'object' && typeof (value as { toNumber?: () => number }).toNumber === 'function') {
    return (value as { toNumber: () => number }).toNumber()
  }
  if (typeof value === 'bigint') return Number(value)
  return Number(value)
}

// ============================================================
// Main service function
// ============================================================

export async function getPromotionSales(venueId: string, filters: PromotionSalesFilters): Promise<PromotionSalesResponse> {
  const { startDate, endDate, reportType = 'summary', timezone: rawTimezone } = filters

  // SEGURIDAD: la zona horaria se interpola en el SQL (no puede ir como parámetro
  // dentro de `AT TIME ZONE`), así que pasa por el saneador igual que sales-by-item.
  const timezone = sanitizeTimezone(rawTimezone || 'America/Mexico_City')

  // 🔴 Nunca `new Date('YYYY-MM-DD')` pelado: en prod Node corre en UTC y el rango
  // se recorrería un día entero (bug real de junio-2026). parseDbDateRange lee la
  // fecha en la zona del VENUE y es independiente del reloj del host.
  const { from: parsedStartDate, to: parsedEndDate } = parseDbDateRange(startDate, endDate, timezone)

  logger.info('Calculando reporte de promociones', { venueId, startDate, endDate, reportType })

  // ── Por promoción ─────────────────────────────────────────────────────────
  // El LEFT JOIN a OrderItem multiplica filas por línea del combo: por eso las
  // veces vendidas son COUNT(DISTINCT op.id) y no COUNT(*).
  const promotionsQuery = `
    SELECT
      op."promotionId" as promotion_id,
      ${SNAPSHOT_NAME_SQL} as promotion_name,
      ${SNAPSHOT_TYPE_SQL} as promotion_type,
      ${SNAPSHOT_MODE_SQL} as pricing_mode,
      COUNT(DISTINCT op.id)::integer as times_sold,
      COUNT(DISTINCT op.id) FILTER (WHERE op."needsReview")::integer as needs_review,
      COALESCE(SUM(${lineGrossSql()}), 0) as gross_sales,
      COALESCE(SUM(oi."discountAmount"), 0) as discounts,
      COALESCE(SUM(${lineRevenueSql()}), 0) as net_sales
    FROM "OrderPromotion" op
    INNER JOIN "Order" o ON o.id = op."orderId"
    LEFT JOIN "Promotion" pr ON pr.id = op."promotionId"
    LEFT JOIN "OrderItem" oi ON oi."orderPromotionId" = op.id
    WHERE ${ORDER_SCOPE_SQL}
    GROUP BY op."promotionId", ${SNAPSHOT_NAME_SQL}, ${SNAPSHOT_TYPE_SQL}, ${SNAPSHOT_MODE_SQL}
    ORDER BY net_sales DESC
  `

  const rows = await prisma.$queryRawUnsafe<
    Array<{
      promotion_id: string
      promotion_name: string
      promotion_type: string | null
      pricing_mode: string | null
      times_sold: number
      needs_review: number
      gross_sales: unknown
      discounts: unknown
      net_sales: unknown
    }>
  >(promotionsQuery, venueId, parsedStartDate, parsedEndDate)

  const promotions: PromotionSalesRow[] = rows.map(row => ({
    promotionId: row.promotion_id,
    name: row.promotion_name,
    type: row.promotion_type ?? null,
    pricingMode: row.pricing_mode ?? null,
    timesSold: Number(row.times_sold ?? 0),
    grossSales: toNumber(row.gross_sales),
    discounts: toNumber(row.discounts),
    netSales: toNumber(row.net_sales),
    needsReview: Number(row.needs_review ?? 0),
  }))

  const totals = promotions.reduce(
    (acc, p) => ({
      promotionsCount: acc.promotionsCount + 1,
      timesSold: acc.timesSold + p.timesSold,
      grossSales: acc.grossSales + p.grossSales,
      discounts: acc.discounts + p.discounts,
      netSales: acc.netSales + p.netSales,
      needsReview: acc.needsReview + p.needsReview,
    }),
    { promotionsCount: 0, timesSold: 0, grossSales: 0, discounts: 0, netSales: 0, needsReview: 0 },
  )

  // ── Por período (gráfica) ─────────────────────────────────────────────────
  let byPeriod: PromotionPeriodMetrics[] | undefined
  if (reportType !== 'summary') {
    byPeriod = await calculatePromotionPeriodMetrics(venueId, parsedStartDate, parsedEndDate, reportType, timezone)
  }

  logger.info('Reporte de promociones calculado', {
    venueId,
    promotionsCount: totals.promotionsCount,
    timesSold: totals.timesSold,
    netSales: totals.netSales,
  })

  return {
    dateRange: { startDate: parsedStartDate, endDate: parsedEndDate },
    reportType,
    timezone,
    promotions,
    byPeriod,
    totals,
  }
}

// ============================================================
// Helper: period breakdown
// ============================================================

async function calculatePromotionPeriodMetrics(
  venueId: string,
  startDate: Date,
  endDate: Date,
  reportType: Exclude<PromotionReportType, 'summary'>,
  timezone: string,
): Promise<PromotionPeriodMetrics[]> {
  const safeTz = sanitizeTimezone(timezone)

  const truncUnit: Record<Exclude<PromotionReportType, 'summary'>, string> = {
    hours: 'hour',
    days: 'day',
    weeks: 'week',
    months: 'month',
  }
  // Venue wall clock of the UTC column (double AT TIME ZONE). With a single one the stored
  // UTC value was read as local time: a 20:00 sale landed on the next day, at hour 02.
  const groupByExpression = `DATE_TRUNC('${truncUnit[reportType]}', ${localWallClockRaw(safeTz, 'o."createdAt"')})`

  const periodQuery = `
    SELECT
      ${groupByExpression} as period,
      COUNT(DISTINCT op.id)::integer as times_sold,
      COALESCE(SUM(${lineGrossSql()}), 0) as gross_sales,
      COALESCE(SUM(oi."discountAmount"), 0) as discounts,
      COALESCE(SUM(${lineRevenueSql()}), 0) as net_sales
    FROM "OrderPromotion" op
    INNER JOIN "Order" o ON o.id = op."orderId"
    LEFT JOIN "OrderItem" oi ON oi."orderPromotionId" = op.id
    WHERE ${ORDER_SCOPE_SQL}
    GROUP BY ${groupByExpression}
    ORDER BY period
  `

  const periodRows = await prisma.$queryRawUnsafe<
    Array<{ period: Date; times_sold: number; gross_sales: unknown; discounts: unknown; net_sales: unknown }>
  >(periodQuery, venueId, startDate, endDate)

  return periodRows.map(p => ({
    period: p.period instanceof Date ? p.period.toISOString() : String(p.period),
    periodLabel: formatPeriodLabel(p.period, reportType, timezone),
    timesSold: Number(p.times_sold ?? 0),
    grossSales: toNumber(p.gross_sales),
    discounts: toNumber(p.discounts),
    netSales: toNumber(p.net_sales),
  }))
}

/**
 * Etiqueta legible del período.
 *
 * 🔴 Se formatea en **UTC a propósito, no en la zona del venue**. `DATE_TRUNC(...
 * AT TIME ZONE tz)` devuelve un `timestamp WITHOUT time zone` que YA es la hora
 * de pared del negocio; Prisma lo entrega como Date sellado en UTC. Volver a
 * convertirlo a la zona del venue le restaría el offset otra vez y el 18 de
 * agosto se pintaría como 17 de agosto. El `timezone` sólo entra al SQL.
 */
function formatPeriodLabel(period: Date | string, reportType: Exclude<PromotionReportType, 'summary'>, _timezone: string): string {
  if (!(period instanceof Date)) return String(period)
  const options: Intl.DateTimeFormatOptions = { timeZone: 'UTC' }
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
