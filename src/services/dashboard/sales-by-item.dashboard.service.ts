/**
 * Sales by Item Dashboard Service
 *
 * Calculates item-level sales metrics for venues.
 * Used by the Sales by Item report in the dashboard.
 *
 * Metrics per item:
 * - itemsSold: Count of OrderItem records (transactions)
 * - unitsSold: Sum of OrderItem.quantity
 * - grossSales: list value sold before discounts (price x units sold, plus
 *   paid modifiers) via the shared lineGrossSql()
 * - discounts: Sum of discountAmount + la parte de cada renglón en los descuentos de cuenta (lineOrderDiscountSql)
 * - netSales: grossSales - discounts
 * - refunds: From refunded orders (tracked separately)
 * - unitsInsidePackages / totalUnits: unidades vendidas como extra ligado al platillo (founder «B», 20-nov; sólo por producto)
 */

import logger from '@/config/logger'
import { BadRequestError } from '@/errors/AppError'
import { sqlOrdenSinTarjetasTexto } from '@/services/giftCards/giftCardMarks'
import prisma from '@/utils/prismaClient'
import { sanitizeTimezone } from '@/utils/sanitizeTimezone'
import { localInstantRaw, localWallClockRaw, utcTsParam } from '@/utils/sqlDates'
import { sqlHoraReal, sqlRangoHoraReal } from '@/services/shared/horaRealDelAparato'
import { lineGrossSql, lineOrderDiscountSql, lineRevenueSql } from './lineRevenue'

// ============================================================
// Types
// ============================================================

export type ReportType = 'summary' | 'hours' | 'days' | 'weeks' | 'months' | 'hourlySum' | 'dailySum'

export type GroupByOption = 'none' | 'category' | 'channel' | 'paymentMethod' | 'device' | 'source' | 'serviceOption' | 'itemType'

export interface SalesByItemFilters {
  startDate: string
  endDate: string
  reportType?: ReportType
  groupBy?: GroupByOption
  timezone?: string
  // Hour range filter (optional) - Format: "HH:mm"
  startHour?: string // e.g. "09:00"
  endHour?: string // e.g. "17:00"
  // Optional filters
  categoryId?: string
  productId?: string
  channel?: string
  paymentMethod?: string
  /**
   * «Dentro de paquete» (founder «B», 20-nov). Por omisión sí (con `groupBy = 'none'`). `/mobile` lo apaga: las apps de hoy reciben
   * exactamente lo de siempre, sin renglones ni campos nuevos y sin el candado de plan de los reportes avanzados (Codex r1 #5).
   */
  incluirDentroDePaquete?: boolean
}

export interface ItemSalesMetrics {
  productId: string | null
  productName: string
  productSku: string | null
  categoryName: string | null
  unit: string // 'c/u' (cada uno) or 'ea' (each)
  itemsSold: number // COUNT of OrderItems
  unitsSold: number // SUM of quantity
  grossSales: number // list value before discounts (see lineGrossSql)
  discounts: number // SUM of discountAmount
  netSales: number // grossSales - discounts
  /**
   * Qué parte de este renglón se vendió DENTRO de una promoción, con el nombre
   * del combo tal como se cobró (snapshot). Aditivo: sólo viene cuando
   * `groupBy = 'none'` y el producto salió en al menos una promoción.
   *
   * Este reporte sigue el modelo SQUARE — desglosa los COMPONENTES, no el combo
   * ("The Item Sales report shows the individual items from combos sold") — y el
   * reporte de promociones sigue el modelo FUDO/TOAST, el combo como renglón.
   * La decisión del founder (2026-08-18) fue dar las dos vistas SIN switch; esta
   * marca es lo que evita que las dos se lean como contabilidad doble: aquí se
   * ve, en el renglón del refresco, que 12 de sus 30 unidades salieron dentro de
   * «Combo Café + 2 Medialunas».
   */
  promotions?: Array<{ name: string; unitsSold: number; netSales: number }>
  /**
   * Atajo para pintar "dentro de «Combo X»" sin recorrer el arreglo: el nombre
   * cuando TODA la parte promocionada del renglón vino de UNA sola promoción.
   * `null` si vino de varias (ahí la UI dice "en N promociones" y el detalle
   * está en `promotions`) o si el producto nunca se vendió en promoción.
   */
  promotionName?: string | null
  /**
   * Familia (padre) ACTUAL de la variante: los reportes usan el nombre de hoy (spec de variantes §9); el renglón sigue
   * siendo por variante con el nombre de la venta. `null` en un producto suelto o con `groupBy` distinto de `'none'`.
   */
  productGroupId?: string | null
  productGroupName?: string | null
  /**
   * «Dentro de paquete» (founder «B», 20-nov-2026, Flautas): unidades de este platillo que se vendieron como EXTRA ligado a él
   * (`Modifier.linkedProductId`, p. ej. la flauta de papa dentro del paquete) = Σ renglón.quantity × extra.quantity. Aparte de
   * `unitsSold` (que no cambia) y sin dinero: el precio del extra va en el producto principal. Lee la liga ACTUAL del extra
   * (retroactiva). Sólo con `groupBy = 'none'`; ahí viene en todos los renglones (0 si no hay).
   */
  unitsInsidePackages?: number
  /** `unitsSold + unitsInsidePackages`. Sólo con `groupBy = 'none'`. */
  totalUnits?: number
}

export interface TimePeriodItemMetrics {
  period: string
  periodLabel?: string
  /**
   * List price: SUM(unitPrice * quantity). Deliberately GROSS — the chart that
   * plots it labels the bar "Ventas brutas", and the table's headline is gross
   * too (Square parity: gross sales and the giveaway shown as separate lines,
   * see `salesGiveaways.ts`).
   */
  grossSales: number
  itemsSold: number
  /**
   * SUM(OrderItem.discountAmount) and grossSales - discounts, per period.
   *
   * The chart used to carry ONLY the gross figure, so there was no way to
   * reconcile a bar against the table's `netSales` column — a period with a
   * combo showed 806 in the bar with nothing explaining the missing 25.
   * Additive: existing consumers keep reading `grossSales` unchanged.
   */
  discounts: number
  netSales: number
}

export interface SalesByItemResponse {
  dateRange: {
    startDate: Date
    endDate: Date
  }
  reportType: ReportType
  items: ItemSalesMetrics[]
  byPeriod?: TimePeriodItemMetrics[]
  totals: {
    itemsSold: number
    unitsSold: number
    grossSales: number
    discounts: number
    netSales: number
    /** Sólo con `groupBy = 'none'` (ver `ItemSalesMetrics.unitsInsidePackages`). */
    unitsInsidePackages?: number
    totalUnits?: number
  }
}

/**
 * Las órdenes y renglones que cuentan en este reporte: UNA definición para artículos, promociones, «Dentro de paquete» y barras,
 * para que ninguna consulta cuente órdenes distintas. Usa `o` (Order) y `oi` (OrderItem), y los parámetros $1 venue, $2/$3 rango.
 */
function ordenesDelReporte(hourFilterClause: string): string {
  return `o."venueId" = $1
      AND ${sqlRangoHoraReal('o', utcTsParam(2), utcTsParam(3))}
      AND o.status NOT IN ('CANCELLED')
      AND o."paymentStatus" NOT IN ('REFUNDED')
      AND oi."removedAt" IS NULL
      AND ${sqlOrdenSinTarjetasTexto('o.id')}
      ${hourFilterClause}`
}

// ============================================================
// Main Service Function
// ============================================================

/**
 * Get sales by item for a venue within a date range
 */
export async function getSalesByItem(venueId: string, filters: SalesByItemFilters): Promise<SalesByItemResponse> {
  const {
    startDate,
    endDate,
    reportType = 'summary',
    groupBy = 'none',
    timezone: rawTimezone = 'America/Mexico_City',
    startHour,
    endHour,
    incluirDentroDePaquete = true,
  } = filters

  // SECURITY: Sanitize timezone to prevent SQL injection
  const timezone = sanitizeTimezone(rawTimezone)

  // Validate dates
  const parsedStartDate = new Date(startDate)
  const parsedEndDate = new Date(endDate)

  if (isNaN(parsedStartDate.getTime())) {
    throw new BadRequestError(`Invalid startDate: ${startDate}`)
  }
  if (isNaN(parsedEndDate.getTime())) {
    throw new BadRequestError(`Invalid endDate: ${endDate}`)
  }

  logger.info('Calculating sales by item', { venueId, startDate, endDate, reportType, groupBy, startHour, endHour })

  // ============================================================
  // Query Item Sales Aggregation
  // ============================================================

  // Build query based on groupBy option
  const { selectFields, groupByFields, orderByField } = buildGroupByClause(groupBy)

  // Add Payment JOIN only when grouping by paymentMethod. A REFUND row (e.g. the delivery provider's
  // compensation for a removed line, spec KDS Uber [N-14]) is not a way the order was paid: joining it
  // would count every surviving line a second time. (Two PAYMENT rows of a split still duplicate — known.)
  // IS DISTINCT FROM, not <>: `type` is nullable and a legacy NULL row is a real payment.
  const paymentJoin =
    groupBy === 'paymentMethod' ? `LEFT JOIN "Payment" pay ON pay."orderId" = o.id AND pay.type IS DISTINCT FROM 'REFUND'` : ''

  // Add Terminal JOIN only when grouping by device
  const terminalJoin = groupBy === 'device' ? 'LEFT JOIN "Terminal" t ON t.id = o."terminalId"' : ''

  // Build hour filter clause if custom hours are provided
  // Filter by hour of day in the venue's timezone
  let hourFilterClause = ''
  if (startHour && endHour) {
    // Parse hours from "HH:mm" format
    const [startH] = startHour.split(':').map(Number)
    const [endH] = endHour.split(':').map(Number)

    if (!isNaN(startH) && !isNaN(endH)) {
      // Filter by hour of day (0-23)
      hourFilterClause = `
        AND EXTRACT(HOUR FROM ${localWallClockRaw(timezone, sqlHoraReal('o'))}) >= ${startH}
        AND EXTRACT(HOUR FROM ${localWallClockRaw(timezone, sqlHoraReal('o'))}) <= ${endH}
      `
    }
  }

  // Main query: aggregate sales by product or grouped dimension
  // Uses denormalized fields (productName, productSku, categoryName) for reliability
  // Some POS-synced orders may not have Product records linked
  const itemSalesQuery = `
    SELECT
      ${selectFields}
      COUNT(oi.id)::integer as items_sold,
      SUM(oi.quantity)::integer as units_sold,
      COALESCE(SUM(${lineGrossSql()}), 0) as gross_sales,
      COALESCE(SUM(oi."discountAmount" + ${lineOrderDiscountSql()}), 0) as discounts
    FROM "OrderItem" oi
    INNER JOIN "Order" o ON o.id = oi."orderId"
    LEFT JOIN "Product" p ON p.id = oi."productId"
    LEFT JOIN "MenuCategory" mc ON mc.id = p."categoryId"
    LEFT JOIN "ProductGroup" pg ON pg.id = p."productGroupId" AND pg."venueId" = o."venueId"
    ${paymentJoin}
    ${terminalJoin}
    WHERE ${ordenesDelReporte(hourFilterClause)}
    GROUP BY ${groupByFields}
    ORDER BY ${orderByField} DESC
  `

  const itemSalesResults = await prisma.$queryRawUnsafe<
    Array<{
      productId: string | null
      product_name: string
      product_sku: string | null
      category_name: string | null
      channel: string | null
      payment_method: string | null
      source: string | null
      terminal_id: string | null
      product_group_id: string | null
      product_group_name: string | null
      items_sold: number
      units_sold: number
      gross_sales: number
      discounts: number
    }>
  >(itemSalesQuery, venueId, parsedStartDate, parsedEndDate)

  // ============================================================
  // Promotion attribution (Square parity: components, marked)
  // ============================================================
  // Sólo tiene sentido en el desglose por PRODUCTO: en un agrupado por canal o
  // método de pago, "dentro de «Combo X»" no le pertenece a ningún renglón.
  // «Dentro de paquete» (founder «B», 20-nov): igual que la promoción, sólo le pertenece a un renglón de PRODUCTO.
  const [promotionAttribution, insidePackages] =
    groupBy === 'none'
      ? await Promise.all([
          getPromotionAttribution(venueId, parsedStartDate, parsedEndDate, hourFilterClause),
          incluirDentroDePaquete ? getUnitsInsidePackages(venueId, parsedStartDate, parsedEndDate, hourFilterClause) : null,
        ])
      : [new Map<string, Array<{ name: string; unitsSold: number; netSales: number }>>(), null]

  // Transform results based on groupBy
  const items: ItemSalesMetrics[] = itemSalesResults.map(row => {
    const grossSales = Number(row.gross_sales)
    const discounts = Number(row.discounts)

    // Determine display name based on groupBy
    let displayName = row.product_name
    if (groupBy === 'category') {
      displayName = row.category_name || 'Sin categorizar'
    } else if (groupBy === 'channel') {
      displayName = formatChannelName(row.channel)
    } else if (groupBy === 'paymentMethod') {
      displayName = formatPaymentMethodName(row.payment_method)
    } else if (groupBy === 'source') {
      displayName = formatSourceName(row.source)
    } else if (groupBy === 'device') {
      // Device uses Terminal name directly from the query result
      displayName = row.product_name // Already set to t.name or 'Sin terminal asignado'
    }

    const fromPromotions: Array<{ name: string; unitsSold: number; netSales: number }> | undefined =
      groupBy === 'none' ? promotionAttribution.get(attributionKey(row.productId, displayName)) : undefined

    return {
      productId: groupBy === 'none' ? row.productId : null,
      productName: displayName,
      productSku: groupBy === 'none' ? row.product_sku : null,
      categoryName: groupBy === 'none' ? row.category_name : null,
      productGroupId: row.product_group_id ?? null,
      productGroupName: row.product_group_name ?? null,
      unit: 'c/u',
      itemsSold: Number(row.items_sold),
      unitsSold: Number(row.units_sold),
      grossSales,
      discounts,
      netSales: grossSales - discounts,
      ...(fromPromotions && fromPromotions.length > 0
        ? {
            promotions: fromPromotions,
            promotionName: fromPromotions.length === 1 ? fromPromotions[0].name : null,
          }
        : {}),
    }
  })

  if (insidePackages) {
    // Cada platillo recibe lo de paquete UNA vez, en un renglón ELEGIDO sin depender del orden del SQL (Codex r1 #12): si lo
    // renombraron tiene varios renglones; gana el que lleva su nombre de HOY, si no el de más unidades, y al empate el nombre.
    const destino = new Map<string, ItemSalesMetrics>()
    for (const item of items) {
      const dentro = item.productId ? insidePackages.get(item.productId) : undefined
      if (!dentro) continue
      const actual = destino.get(item.productId!)
      if (!actual || renglonPreferido(item, actual, dentro.productName)) destino.set(item.productId!, item)
    }
    for (const item of items) {
      const dentro = item.productId && destino.get(item.productId) === item ? insidePackages.get(item.productId) : undefined
      item.unitsInsidePackages = dentro?.units ?? 0
      item.totalUnits = item.unitsSold + item.unitsInsidePackages
    }
    // Un platillo que sólo se vendió dentro de paquetes entra como renglón nuevo, con 0 sueltas y $0.
    for (const [productId, d] of insidePackages) {
      if (destino.has(productId)) continue
      items.push({
        productId,
        productName: d.productName,
        productSku: d.productSku,
        categoryName: d.categoryName,
        productGroupId: d.productGroupId,
        productGroupName: d.productGroupName,
        unit: 'c/u',
        itemsSold: 0,
        unitsSold: 0,
        grossSales: 0,
        discounts: 0,
        netSales: 0,
        unitsInsidePackages: d.units,
        totalUnits: d.units,
      })
    }
  }

  // ============================================================
  // Calculate Totals
  // ============================================================

  const totals: SalesByItemResponse['totals'] = items.reduce(
    (acc, item) => ({
      itemsSold: acc.itemsSold + item.itemsSold,
      unitsSold: acc.unitsSold + item.unitsSold,
      grossSales: acc.grossSales + item.grossSales,
      discounts: acc.discounts + item.discounts,
      netSales: acc.netSales + item.netSales,
    }),
    { itemsSold: 0, unitsSold: 0, grossSales: 0, discounts: 0, netSales: 0 },
  )
  if (insidePackages) {
    totals.unitsInsidePackages = items.reduce((acc, item) => acc + (item.unitsInsidePackages ?? 0), 0)
    totals.totalUnits = totals.unitsSold + totals.unitsInsidePackages
  }

  // ============================================================
  // Time-Period Breakdown (for charts)
  // ============================================================

  let byPeriod: TimePeriodItemMetrics[] | undefined

  if (reportType !== 'summary') {
    byPeriod = await calculateTimePeriodItemMetrics(venueId, parsedStartDate, parsedEndDate, reportType, timezone, startHour, endHour)
  }

  logger.info('Sales by item calculated', {
    venueId,
    itemCount: items.length,
    totalGrossSales: totals.grossSales,
    reportType,
    periodsCount: byPeriod?.length,
  })

  return {
    dateRange: {
      startDate: parsedStartDate,
      endDate: parsedEndDate,
    },
    reportType,
    items,
    byPeriod,
    totals,
  }
}

// ============================================================
// Helper: Promotion attribution ("dentro de «Combo X»")
// ============================================================

/**
 * Llave de merge con el renglón del reporte. El query principal agrupa por
 * `oi."productId"` + el nombre denormalizado, y `productId` puede ser NULL
 * (líneas de POS externo que nunca tuvieron `Product`), así que la llave usa
 * AMBOS y nunca sólo el id.
 */
function attributionKey(productId: string | null, productName: string): string {
  return `${productId ?? ''}|${productName}`
}

/**
 * Cuánto de cada producto se vendió DENTRO de una promoción, por nombre de
 * promoción tal como se cobró.
 *
 * 🔑 El nombre sale de `OrderPromotion.snapshotJson`, no de `Promotion.name`:
 * renombrar un combo no puede reescribir lo que el cliente vio en un período ya
 * cerrado (Square documenta esa misma trampa en sus reportes de descuentos).
 *
 * NO cambia ningún total: las líneas ya estaban contadas en el query principal
 * — esto sólo dice de dónde vinieron.
 */
async function getPromotionAttribution(
  venueId: string,
  startDate: Date,
  endDate: Date,
  hourFilterClause: string,
): Promise<Map<string, Array<{ name: string; unitsSold: number; netSales: number }>>> {
  const query = `
    SELECT
      oi."productId" as "productId",
      COALESCE(oi."productName", p.name, 'Sin descripción') as product_name,
      COALESCE(NULLIF(op."snapshotJson"->>'name', ''), pr.name, 'Promoción') as promotion_name,
      SUM(oi.quantity)::integer as units_sold,
      COALESCE(SUM(${lineRevenueSql()}), 0) as net_sales
    FROM "OrderItem" oi
    INNER JOIN "Order" o ON o.id = oi."orderId"
    INNER JOIN "OrderPromotion" op ON op.id = oi."orderPromotionId"
    LEFT JOIN "Promotion" pr ON pr.id = op."promotionId"
    LEFT JOIN "Product" p ON p.id = oi."productId"
    WHERE ${ordenesDelReporte(hourFilterClause)}
    GROUP BY oi."productId", COALESCE(oi."productName", p.name, 'Sin descripción'),
             COALESCE(NULLIF(op."snapshotJson"->>'name', ''), pr.name, 'Promoción')
    ORDER BY net_sales DESC
  `

  const rows = await prisma.$queryRawUnsafe<
    Array<{
      productId: string | null
      product_name: string
      promotion_name: string
      units_sold: number
      net_sales: number | bigint | { toNumber?: () => number }
    }>
  >(query, venueId, startDate, endDate)

  const byProduct = new Map<string, Array<{ name: string; unitsSold: number; netSales: number }>>()
  for (const row of rows) {
    const key = attributionKey(row.productId, row.product_name)
    const list = byProduct.get(key) ?? []
    const raw = row.net_sales
    const netSales =
      raw === null || raw === undefined
        ? 0
        : typeof raw === 'object' && typeof (raw as { toNumber?: () => number }).toNumber === 'function'
          ? (raw as { toNumber: () => number }).toNumber()
          : Number(raw)
    list.push({ name: row.promotion_name, unitsSold: Number(row.units_sold ?? 0), netSales })
    byProduct.set(key, list)
  }
  return byProduct
}

// ============================================================
// Helper: «Dentro de paquete» (founder «B», 20-nov-2026)
// ============================================================

/**
 * ¿`a` es mejor renglón que `b` para llevar lo de paquete de su platillo? Su nombre de hoy, luego más unidades, y al empate un orden
 * fijo por nombre, SKU y categoría vendidos: lo que separa dos renglones del mismo platillo en la consulta principal (Codex r2 #4: un
 * SKU cambiado deja dos renglones con el mismo nombre y las mismas unidades).
 */
function renglonPreferido(a: ItemSalesMetrics, b: ItemSalesMetrics, nombreDeHoy: string): boolean {
  const aHoy = a.productName === nombreDeHoy
  const bHoy = b.productName === nombreDeHoy
  if (aHoy !== bHoy) return aHoy
  if (a.unitsSold !== b.unitsSold) return a.unitsSold > b.unitsSold
  const llave = (r: ItemSalesMetrics) => [r.productName, r.productSku ?? '', r.categoryName ?? '']
  const [la, lb] = [llave(a), llave(b)]
  for (let i = 0; i < la.length; i++) if (la[i] !== lb[i]) return la[i] < lb[i]
  return false
}

/**
 * Unidades de cada platillo vendidas como EXTRA ligado a él (`Modifier.linkedProductId`): Σ renglón.quantity × extra.quantity, con
 * los MISMOS filtros de órdenes que las unidades sueltas (`ordenesDelReporte`). Sólo unidades: no lee ni un precio. La liga que
 * cuenta es la ACTUAL del extra (el renglón vendido no la copia), así que ligar o desligar hoy mueve el pasado: aceptado.
 * El platillo ligado tiene que ser del mismo negocio. Una consulta agregada: a lo más un renglón por platillo del negocio, igual que la
 * consulta principal del reporte, y SIN `LIMIT` (un tope recortaría renglones y totales sin salida para el usuario, Codex r1 #6).
 * La lee también la herramienta MCP `package_component_sales`, para que el asistente y la pantalla den el mismo número.
 */
export async function getUnitsInsidePackages(
  venueId: string,
  startDate: Date,
  endDate: Date,
  hourFilterClause: string,
): Promise<
  Map<
    string,
    {
      units: number
      productName: string
      productSku: string | null
      categoryName: string | null
      productGroupId: string | null
      productGroupName: string | null
    }
  >
> {
  const query = `
    SELECT
      lp.id as "productId",
      lp.name as product_name,
      lp.sku as product_sku,
      COALESCE(mc.name, 'Sin categorizar') as category_name,
      lp."productGroupId" as product_group_id,
      pg.name as product_group_name,
      SUM(oi.quantity * oim.quantity)::integer as units_inside
    FROM "OrderItemModifier" oim
    INNER JOIN "OrderItem" oi ON oi.id = oim."orderItemId"
    INNER JOIN "Order" o ON o.id = oi."orderId"
    INNER JOIN "Modifier" m ON m.id = oim."modifierId"
    INNER JOIN "Product" lp ON lp.id = m."linkedProductId" AND lp."venueId" = o."venueId"
    LEFT JOIN "MenuCategory" mc ON mc.id = lp."categoryId"
    LEFT JOIN "ProductGroup" pg ON pg.id = lp."productGroupId" AND pg."venueId" = o."venueId"
    WHERE ${ordenesDelReporte(hourFilterClause)}
      AND m."linkedProductId" IS NOT NULL
    GROUP BY lp.id, lp.name, lp.sku, mc.name, lp."productGroupId", pg.name
    ORDER BY units_inside DESC, lp.id
  `
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      productId: string
      product_name: string
      product_sku: string | null
      category_name: string | null
      product_group_id: string | null
      product_group_name: string | null
      units_inside: number
    }>
  >(query, venueId, startDate, endDate)
  return new Map(
    rows.map(r => [
      r.productId,
      {
        units: Number(r.units_inside ?? 0),
        productName: r.product_name,
        productSku: r.product_sku ?? null,
        categoryName: r.category_name ?? null,
        productGroupId: r.product_group_id ?? null,
        productGroupName: r.product_group_name ?? null,
      },
    ]),
  )
}

// ============================================================
// Helper: Calculate Time-Period Item Metrics
// ============================================================

/**
 * Calculate item sales metrics grouped by time period (for chart display)
 */
async function calculateTimePeriodItemMetrics(
  venueId: string,
  startDate: Date,
  endDate: Date,
  reportType: ReportType,
  timezone: string,
  startHour?: string,
  endHour?: string,
): Promise<TimePeriodItemMetrics[]> {
  // SECURITY: Sanitize timezone to prevent SQL injection
  const safeTz = sanitizeTimezone(timezone)

  // Determine SQL grouping based on reportType
  let groupByExpression: string
  let orderByExpression: string

  // Venue wall clock of the UTC column. A single `AT TIME ZONE tz` read the stored UTC value
  // as if it were local time: a 20:00 sale was bucketed on the next day, at hour 02.
  // D1 (tras D93 «B»): la hora REAL de la venta (la del aparato si se hizo sin internet; si no, la llegada), igual que el Resumen.
  const wall = localWallClockRaw(safeTz, sqlHoraReal('o'))

  // Time-based periods are returned as the INSTANT the bucket starts (midnight / hour on the
  // venue clock): formatPeriod/formatPeriodLabel and the dashboard format them in the venue zone.
  switch (reportType) {
    case 'hours':
      groupByExpression = localInstantRaw(safeTz, `DATE_TRUNC('hour', ${wall})`)
      orderByExpression = 'period'
      break
    case 'days':
      groupByExpression = localInstantRaw(safeTz, `DATE_TRUNC('day', ${wall})`)
      orderByExpression = 'period'
      break
    case 'weeks':
      groupByExpression = localInstantRaw(safeTz, `DATE_TRUNC('week', ${wall})`)
      orderByExpression = 'period'
      break
    case 'months':
      groupByExpression = localInstantRaw(safeTz, `DATE_TRUNC('month', ${wall})`)
      orderByExpression = 'period'
      break
    case 'hourlySum':
      // Group by hour of day (0-23)
      groupByExpression = `EXTRACT(HOUR FROM ${wall})`
      orderByExpression = 'period'
      break
    case 'dailySum':
      // Group by day of week (0=Sunday, 6=Saturday)
      groupByExpression = `EXTRACT(DOW FROM ${wall})`
      orderByExpression = 'period'
      break
    default:
      return []
  }

  // Build hour filter clause if custom hours are provided
  let hourFilterClause = ''
  if (startHour && endHour) {
    const [startH] = startHour.split(':').map(Number)
    const [endH] = endHour.split(':').map(Number)
    if (!isNaN(startH) && !isNaN(endH)) {
      hourFilterClause = `
        AND EXTRACT(HOUR FROM ${wall}) >= ${startH}
        AND EXTRACT(HOUR FROM ${wall}) <= ${endH}
      `
    }
  }

  // Query item sales grouped by period
  const periodMetricsQuery = `
    SELECT
      ${groupByExpression} as period,
      COALESCE(SUM(${lineGrossSql()}), 0) as gross_sales,
      COALESCE(SUM(oi."discountAmount" + ${lineOrderDiscountSql()}), 0) as discounts,
      COALESCE(SUM(${lineRevenueSql()}), 0) as net_sales,
      COUNT(oi.id)::integer as items_sold
    FROM "OrderItem" oi
    INNER JOIN "Order" o ON o.id = oi."orderId"
    WHERE ${ordenesDelReporte(hourFilterClause)}
    GROUP BY ${groupByExpression}
    ORDER BY ${orderByExpression}
  `

  const periodMetrics = await prisma.$queryRawUnsafe<
    Array<{
      period: Date | number
      gross_sales: number | bigint | { toNumber?: () => number }
      discounts: number | bigint | { toNumber?: () => number }
      net_sales: number | bigint | { toNumber?: () => number }
      items_sold: number
    }>
  >(periodMetricsQuery, venueId, startDate, endDate)

  // Helper to convert gross_sales to number (handles Decimal/BigInt from Prisma)
  const toNumber = (value: number | bigint | { toNumber?: () => number } | null | undefined): number => {
    if (value === null || value === undefined) return 0
    if (typeof value === 'object' && value.toNumber) return value.toNumber()
    if (typeof value === 'bigint') return Number(value)
    return Number(value)
  }

  // For summary report types (hourlySum, dailySum), fill in missing periods with zeros
  const allPeriods = generateAllPeriods(reportType)

  if (allPeriods.length > 0) {
    // Create map for quick lookup
    const metricsMap = new Map(periodMetrics.map(p => [Number(p.period), p]))

    // Generate result with all periods (filling zeros for missing)
    const result: TimePeriodItemMetrics[] = allPeriods.map(periodValue => {
      const metrics = metricsMap.get(periodValue)
      return {
        period: formatPeriod(periodValue, reportType, timezone),
        periodLabel: formatPeriodLabel(periodValue, reportType, timezone),
        grossSales: toNumber(metrics?.gross_sales),
        discounts: toNumber(metrics?.discounts),
        netSales: toNumber(metrics?.net_sales),
        itemsSold: Number(metrics?.items_sold || 0),
      }
    })

    logger.info('Period metrics (summary mode)', {
      count: result.length,
      totalGrossSales: result.reduce((acc, r) => acc + r.grossSales, 0),
    })

    return result
  }

  // For regular report types (hours, days, weeks, months), return data directly from query
  const result: TimePeriodItemMetrics[] = periodMetrics.map(p => ({
    period: formatPeriod(p.period, reportType, timezone),
    periodLabel: formatPeriodLabel(p.period, reportType, timezone),
    grossSales: toNumber(p.gross_sales),
    discounts: toNumber(p.discounts),
    netSales: toNumber(p.net_sales),
    itemsSold: Number(p.items_sold),
  }))

  logger.info('Period metrics (regular mode)', {
    count: result.length,
    sample: result.slice(0, 3),
    totalGrossSales: result.reduce((acc, r) => acc + r.grossSales, 0),
  })

  return result
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

// ============================================================
// Helper: Build GroupBy SQL Clause
// ============================================================

interface GroupByClause {
  selectFields: string
  groupByFields: string
  orderByField: string
}

/**
 * Build SQL SELECT, GROUP BY, and ORDER BY clauses based on groupBy option
 */
function buildGroupByClause(groupBy: GroupByOption): GroupByClause {
  switch (groupBy) {
    case 'category':
      return {
        selectFields: `
          NULL as "productId",
          COALESCE(oi."categoryName", mc.name, 'Sin categorizar') as product_name,
          NULL as product_sku,
          COALESCE(oi."categoryName", mc.name, 'Sin categorizar') as category_name,
          NULL as channel,
          NULL as payment_method,
          NULL as source,
          NULL as terminal_id,
          NULL as product_group_id,
          NULL as product_group_name,
        `,
        groupByFields: 'COALESCE(oi."categoryName", mc.name, \'Sin categorizar\')',
        orderByField: 'gross_sales',
      }

    case 'channel':
      return {
        selectFields: `
          NULL as "productId",
          COALESCE(o.channel, 'POS') as product_name,
          NULL as product_sku,
          NULL as category_name,
          COALESCE(o.channel, 'POS') as channel,
          NULL as payment_method,
          NULL as source,
          NULL as terminal_id,
          NULL as product_group_id,
          NULL as product_group_name,
        `,
        groupByFields: "COALESCE(o.channel, 'POS')",
        orderByField: 'gross_sales',
      }

    case 'paymentMethod':
      // Payment method is in the Payment table, not Order
      // We need to join with Payment and group by payment method
      return {
        selectFields: `
          NULL as "productId",
          COALESCE(pay.method::text, 'OTHER') as product_name,
          NULL as product_sku,
          NULL as category_name,
          NULL as channel,
          COALESCE(pay.method::text, 'OTHER') as payment_method,
          NULL as source,
          NULL as terminal_id,
          NULL as product_group_id,
          NULL as product_group_name,
        `,
        groupByFields: "COALESCE(pay.method::text, 'OTHER')",
        orderByField: 'gross_sales',
      }

    case 'source':
      // source is an OrderSource enum (TPV, QR, WEB, APP, PHONE, POS)
      // Cast to text to allow grouping
      return {
        selectFields: `
          NULL as "productId",
          COALESCE(o.source::text, 'TPV') as product_name,
          NULL as product_sku,
          NULL as category_name,
          NULL as channel,
          NULL as payment_method,
          COALESCE(o.source::text, 'TPV') as source,
          NULL as terminal_id,
          NULL as product_group_id,
          NULL as product_group_name,
        `,
        groupByFields: "COALESCE(o.source::text, 'TPV')",
        orderByField: 'gross_sales',
      }

    case 'device':
      // Device groupBy uses the actual Terminal table
      // Groups by terminal ID and shows terminal name for each device
      // Orders without terminalId are grouped as "Sin terminal asignado"
      return {
        selectFields: `
          NULL as "productId",
          COALESCE(t.name, 'Sin terminal asignado') as product_name,
          NULL as product_sku,
          NULL as category_name,
          NULL as channel,
          NULL as payment_method,
          NULL as source,
          o."terminalId" as terminal_id,
          NULL as product_group_id,
          NULL as product_group_name,
        `,
        groupByFields: 'o."terminalId", t.name',
        orderByField: 'gross_sales',
      }

    case 'none':
    default:
      // Default: group by product (original behavior)
      return {
        selectFields: `
          oi."productId",
          COALESCE(oi."productName", p.name, 'Sin descripción') as product_name,
          oi."productSku" as product_sku,
          COALESCE(oi."categoryName", mc.name, 'Sin categorizar') as category_name,
          NULL as channel,
          NULL as payment_method,
          NULL as source,
          NULL as terminal_id,
          p."productGroupId" as product_group_id,
          pg.name as product_group_name,
        `,
        // p."productGroupId" and pg.name follow from oi."productId" (one Product, one ProductGroup), so they never split a row.
        groupByFields: 'oi."productId", oi."productName", oi."productSku", oi."categoryName", p.name, mc.name, p."productGroupId", pg.name',
        orderByField: 'gross_sales',
      }
  }
}

// ============================================================
// Helper: Format Display Names
// ============================================================

/**
 * Format channel name for display
 */
function formatChannelName(channel: string | null): string {
  const channelMap: Record<string, string> = {
    POS: 'Punto de Venta (TPV)',
    QR: 'QR',
    WEB: 'Web',
    APP: 'App',
    DELIVERY: 'Delivery',
    KIOSK: 'Kiosko',
  }
  return channelMap[channel || 'POS'] || channel || 'Punto de Venta (TPV)'
}

/**
 * Format payment method name for display
 */
function formatPaymentMethodName(paymentMethod: string | null): string {
  const methodMap: Record<string, string> = {
    CASH: 'Efectivo',
    CARD: 'Tarjeta',
    TRANSFER: 'Transferencia',
    WALLET: 'Monedero',
    OTHER: 'Otro',
    CREDIT_CARD: 'Tarjeta de Crédito',
    DEBIT_CARD: 'Tarjeta de Débito',
  }
  return methodMap[paymentMethod || 'OTHER'] || paymentMethod || 'Otro'
}

/**
 * Format source/device name for display
 * OrderSource enum: TPV, QR, WEB, APP, PHONE, POS
 */
function formatSourceName(source: string | null): string {
  const sourceMap: Record<string, string> = {
    TPV: 'Terminal (TPV)',
    QR: 'Código QR',
    WEB: 'Sitio Web',
    APP: 'Aplicación Móvil',
    PHONE: 'Pedido Telefónico',
    POS: 'Punto de Venta (POS)',
  }
  return sourceMap[source || 'TPV'] || source || 'Terminal (TPV)'
}
