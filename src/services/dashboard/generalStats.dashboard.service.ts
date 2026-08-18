import { PaymentMethod, ProductType, TransactionStatus, OrderStatus, Prisma } from '@prisma/client'
import { NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { GeneralStatsResponse, GeneralStatsQuery } from '../../schemas/dashboard/generalStats.schema'
import { SharedQueryService } from './shared-query.service'
import { isItemLevelDiscount, lineRevenue } from './lineRevenue'
import { parseDateRange, DEFAULT_TIMEZONE } from '../../utils/datetime'
import { DateTime } from 'luxon'
// ⚠️ TECH DEBT — delete when MindForm migrates to native QR module.
// See: src/services/legacy/mergedPayments.service.ts for full context.
import { fetchPaymentsForAnalytics } from '../legacy/mergedPayments.service'

export async function getGeneralStatsData(venueId: string, filters: GeneralStatsQuery = {}): Promise<GeneralStatsResponse> {
  // Validate venue exists
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
  })

  if (!venue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found`)
  }

  // Set default date range (last 7 days) if not provided
  const { from: fromDate, to: toDate } = parseDateRange(filters.fromDate, filters.toDate, 7)

  // Build where clause for date filtering
  const dateFilter = {
    createdAt: {
      gte: fromDate,
      lte: toDate,
    },
  }

  // Fetch only valid payments: COMPLETED status, non-cancelled orders
  // Filters applied at database level to avoid loading unnecessary data
  const validPayments = await prisma.payment.findMany({
    where: {
      venueId,
      status: TransactionStatus.COMPLETED,
      createdAt: {
        gte: fromDate,
        lte: toDate,
      },
      order: {
        status: { not: OrderStatus.CANCELLED },
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  })

  // Fetch reviews data
  const reviews = await prisma.review.findMany({
    where: {
      venueId,
      ...dateFilter,
    },
    orderBy: {
      createdAt: 'desc',
    },
  })

  // Fetch products data from orders (exclude PENDING - draft/cart orders)
  const orders = await prisma.order.findMany({
    where: {
      venueId,
      status: { notIn: [OrderStatus.PENDING, OrderStatus.CANCELLED, OrderStatus.DELETED] },
      ...dateFilter,
    },
    include: {
      items: {
        include: {
          product: true,
        },
      },
    },
  })

  // Process products data
  const productsMap = new Map<string, any>()

  orders.forEach(order => {
    order.items.forEach(item => {
      if (item.product) {
        const productKey = `${item.product.id}-${item.product.name}`
        const existing = productsMap.get(productKey)

        if (existing) {
          existing.quantity += item.quantity
        } else {
          productsMap.set(productKey, {
            id: item.product.id,
            name: item.product.name,
            type: item.product.type || ProductType.OTHER,
            quantity: item.quantity,
            price: Number(item.product.price),
          })
        }
      }
    })
  })

  const products = Array.from(productsMap.values())

  // Generate extra metrics
  const extraMetrics = await generateExtraMetrics(venueId, fromDate, toDate, venue.timezone)

  // Transform data to match legacy format
  const transformedPayments = validPayments.map(payment => ({
    id: payment.id,
    amount: Number(payment.amount),
    method: mapPaymentMethod(payment.method),
    createdAt: payment.createdAt.toISOString(),
    tips: [
      {
        amount: Number(payment.tipAmount),
      },
    ],
  }))

  const transformedReviews = reviews.map(review => ({
    id: review.id,
    stars: review.overallRating,
    createdAt: review.createdAt.toISOString(),
  }))

  const transformedProducts = products.map(product => ({
    id: product.id,
    name: product.name,
    type: product.type,
    quantity: product.quantity,
    price: product.price,
  }))

  return {
    payments: transformedPayments,
    reviews: transformedReviews,
    products: transformedProducts,
    extraMetrics,
  }
}

async function generateExtraMetrics(venueId: string, fromDate: Date, toDate: Date, timezone?: string | null) {
  // Fetch table performance data
  const tablePerformance = await generateTablePerformance(venueId, fromDate, toDate)

  // Fetch staff performance data
  const staffPerformanceMetrics = await generateStaffPerformance(venueId, fromDate, toDate)

  // Fetch product profitability data
  const productProfitability = await generateProductProfitability(venueId, fromDate, toDate)

  // Generate peak hours data
  const peakHoursData = await generatePeakHoursData(venueId, fromDate, toDate, timezone)

  // Generate weekly trends data
  const weeklyTrendsData = await generateWeeklyTrendsData(venueId, fromDate, toDate, timezone)

  const prepTimesByCategory = await generatePrepTimesByCategory(venueId, fromDate, toDate)

  return {
    tablePerformance,
    staffPerformanceMetrics,
    productProfitability,
    peakHoursData,
    weeklyTrendsData,
    prepTimesByCategory,
  }
}

async function generateTablePerformance(venueId: string, fromDate: Date, toDate: Date) {
  const orders = await prisma.order.findMany({
    where: {
      venueId,
      status: { notIn: [OrderStatus.PENDING, OrderStatus.CANCELLED, OrderStatus.DELETED] },
      createdAt: {
        gte: fromDate,
        lte: toDate,
      },
    },
    include: {
      table: true,
    },
  })

  const tableStatsMap = new Map<string, any>()

  orders.forEach(order => {
    if (order.table) {
      const tableKey = `${order.table.id}-${order.table.number}`
      const existing = tableStatsMap.get(tableKey)

      if (existing) {
        existing.totalSales += Number(order.total)
        existing.orderCount += 1
      } else {
        tableStatsMap.set(tableKey, {
          tableId: order.table.id,
          tableNumber: parseInt(order.table.number),
          totalSales: Number(order.total),
          orderCount: 1,
          avgTicket: 0,
          turnoverRate: 0,
          occupancyRate: 0,
        })
      }
    }
  })

  return Array.from(tableStatsMap.values()).map(table => ({
    ...table,
    avgTicket: table.orderCount > 0 ? table.totalSales / table.orderCount : 0,
    turnoverRate: table.orderCount * 0.8, // Mock calculation
    occupancyRate: Math.min(table.orderCount * 10, 100), // Mock calculation
    rotationRate: table.orderCount * 0.5 || 0, // Mock calculation for rotation rate
    totalRevenue: table.totalSales || 0, // Ensure totalRevenue is available
  }))
}

/**
 * **REFACTORED: Now uses SharedQueryService for 100% consistency with chatbot**
 *
 * Uses SharedQueryService.getStaffPerformance() as single source of truth.
 * Transforms response to match legacy generalStats format.
 */
async function generateStaffPerformance(venueId: string, fromDate: Date, toDate: Date) {
  // Use SharedQueryService as single source of truth
  const staffPerformance = await SharedQueryService.getStaffPerformance(
    venueId,
    { from: fromDate, to: toDate }, // Custom date range
    undefined, // Use venue's configured timezone
  )

  // Transform to match legacy generalStats format
  return staffPerformance.map(staff => ({
    staffId: staff.staffId,
    name: staff.staffName, // SharedQueryService uses 'staffName', generalStats expects 'name'
    role: staff.role,
    totalSales: staff.totalRevenue, // SharedQueryService uses 'totalRevenue', generalStats expects 'totalSales'
    totalTips: staff.totalTips,
    orderCount: staff.totalOrders, // SharedQueryService uses 'totalOrders', generalStats expects 'orderCount'
    // El tiempo de preparación por empleado no se mide hoy: la comanda (KdsOrder) no
    // guarda quién la preparó. Devolvía `Math.random()`. Se deja en 0 —"sin medición"—
    // conservando el campo para no romper el contrato con el dashboard.
    avgPrepTime: 0,
  }))
}

async function generateProductProfitability(venueId: string, fromDate: Date, toDate: Date) {
  const orders = await prisma.order.findMany({
    where: {
      venueId,
      status: { notIn: [OrderStatus.PENDING, OrderStatus.CANCELLED, OrderStatus.DELETED] },
      createdAt: {
        gte: fromDate,
        lte: toDate,
      },
    },
    include: {
      items: {
        // `modifiers` is REQUIRED by lineRevenue — without it the modifier
        // revenue ($33,811 across the DB) silently disappears from this report.
        include: {
          product: true,
          modifiers: true,
        },
      },
    },
  })

  const productStatsMap = new Map<string, any>()

  orders.forEach(order => {
    order.items.forEach(item => {
      if (item.product) {
        const productKey = item.product.id
        const existing = productStatsMap.get(productKey)

        const itemRevenue = lineRevenue(item) // net of the line's own discount
        const estimatedCost = Number(item.unitPrice) * 0.3 // Mock 30% cost ratio

        if (existing) {
          existing.quantity += item.quantity
          existing.totalRevenue += itemRevenue
          existing.totalCost += estimatedCost * item.quantity
        } else {
          productStatsMap.set(productKey, {
            name: item.product.name,
            type: item.product.type || ProductType.OTHER,
            price: Number(item.product.price),
            quantity: item.quantity,
            totalRevenue: itemRevenue,
            totalCost: estimatedCost * item.quantity,
          })
        }
      }
    })
  })

  return Array.from(productStatsMap.values()).map(product => {
    const margin = product.totalRevenue - product.totalCost
    const marginPercentage = product.totalRevenue > 0 ? (margin / product.totalRevenue) * 100 : 0

    return {
      ...product,
      cost: product.quantity > 0 ? product.totalCost / product.quantity : 0,
      margin: product.quantity > 0 ? margin / product.quantity : 0,
      marginPercentage: marginPercentage || 0, // Ensure never undefined
    }
  })
}

async function generatePeakHoursData(venueId: string, fromDate: Date, toDate: Date, timezone?: string | null) {
  const tz = timezone || DEFAULT_TIMEZONE
  const orders = await prisma.order.findMany({
    where: {
      venueId,
      status: { notIn: [OrderStatus.PENDING, OrderStatus.CANCELLED, OrderStatus.DELETED] },
      createdAt: {
        gte: fromDate,
        lte: toDate,
      },
    },
  })

  const hourlyData = new Map<number, { sales: number; transactions: number }>()

  orders.forEach(order => {
    const hour = DateTime.fromJSDate(order.createdAt, { zone: 'utc' }).setZone(tz).hour
    const existing = hourlyData.get(hour)

    if (existing) {
      existing.sales += Number(order.total)
      existing.transactions += 1
    } else {
      hourlyData.set(hour, {
        sales: Number(order.total),
        transactions: 1,
      })
    }
  })

  return Array.from(hourlyData.entries()).map(([hour, data]) => ({
    hour,
    sales: data.sales,
    transactions: data.transactions,
  }))
}

// Tiempo de preparación por categoría.
//
// Hoy NO es medible por categoría: `KdsOrderItem` guarda `productName` como texto
// libre y no tiene liga a `Product`, así que no hay forma de saber a qué tipo de
// producto pertenece una línea de comanda. Para medirlo de verdad hay que agregar
// `productId` a `KdsOrderItem` y sellar los tiempos por línea.
//
// Esta función DEVOLVÍA VALORES INVENTADOS: constantes fijas idénticas para todos los
// venues. Las cuatro categorías van en 0 —que se lee como "sin medición"— en vez de
// fabricar un número.
//
// ⚠️ Un intento anterior de este arreglo calculaba el promedio GLOBAL de todas las
// comandas y lo estampaba en `principales`. Eso NO es medir: el número era real pero
// la etiqueta mentía, y nadie río abajo podía distinguir "los platos fuertes tardan X"
// de "todas las comandas tardan X". Sustituir un dato inventado por uno mal etiquetado
// no es arreglarlo. El promedio global sí se reporta, pero en su propio campo y dicho
// con todas sus letras.
//
// `target` es la meta configurada por tipo de servicio, no un dato medido.
// La forma de la respuesta se CONSERVA (nunca se quita un campo de una API); `overall`
// es aditivo y los clientes viejos simplemente lo ignoran.
async function generatePrepTimesByCategory(venueId: string, fromDate: Date, toDate: Date) {
  const comandas = await prisma.kdsOrder.findMany({
    where: {
      venueId,
      startedAt: { not: null },
      completedAt: { not: null },
      createdAt: { gte: fromDate, lte: toDate },
    },
    select: { startedAt: true, completedAt: true },
  })

  const minutos = comandas.map(c => (c.completedAt!.getTime() - c.startedAt!.getTime()) / 60000).filter(m => m > 0 && m < 24 * 60) // descarta comandas que quedaron abiertas

  const promedioGlobal = minutos.length ? Math.round((minutos.reduce((a, b) => a + b, 0) / minutos.length) * 10) / 10 : 0

  return {
    entradas: { avg: 0, target: 10 },
    principales: { avg: 0, target: 15 },
    postres: { avg: 0, target: 5 },
    bebidas: { avg: 0, target: 3 },
    // Lo único que hoy SÍ se mide: la comanda completa, de que entra a cocina a que
    // sale. `medicion` dice sobre cuántas comandas se calculó, para que un promedio
    // sacado de tres tickets no se lea igual que uno sacado de mil.
    overall: { avg: promedioGlobal, target: null, medicion: minutos.length },
  }
}

// Venta por día de la semana del periodo solicitado, contra el periodo inmediato
// anterior de la MISMA duración. El día se determina en la zona horaria del venue,
// no en la del servidor: en producción Node corre en UTC y agrupar sin convertir
// mueve la venta nocturna al día siguiente.
async function generateWeeklyTrendsData(venueId: string, fromDate: Date, toDate: Date, timezone?: string | null) {
  const tz = timezone || DEFAULT_TIMEZONE
  const weekdays = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo']

  // Periodo anterior: se desplaza un número ENTERO DE SEMANAS hacia atrás, no la
  // duración exacta del rango. Es la diferencia entre comparar lunes contra lunes o
  // lunes contra jueves: con un rango de 10 días, restar 10 días mueve cada día de la
  // semana tres posiciones y la "comparación" queda sin sentido, aunque los totales
  // sean reales. Como la gráfica se indexa por día de la semana, el desfase tiene que
  // ser múltiplo de 7.
  const MS_POR_DIA = 24 * 60 * 60 * 1000
  const diasDelRango = Math.max(1, Math.ceil((toDate.getTime() - fromDate.getTime()) / MS_POR_DIA))
  const desfaseMs = Math.ceil(diasDelRango / 7) * 7 * MS_POR_DIA
  const prevFrom = new Date(fromDate.getTime() - desfaseMs)
  const prevTo = new Date(toDate.getTime() - desfaseMs)

  const orders = await prisma.order.findMany({
    where: {
      venueId,
      status: { notIn: [OrderStatus.PENDING, OrderStatus.CANCELLED, OrderStatus.DELETED] },
      OR: [{ createdAt: { gte: fromDate, lte: toDate } }, { createdAt: { gte: prevFrom, lte: prevTo } }],
    },
    select: { total: true, createdAt: true },
  })

  // Luxon: weekday 1 = lunes … 7 = domingo, que es el orden del arreglo.
  // Se acumula en Decimal, no en float: es dinero, y este total se compara contra
  // reportes que sí son Decimal. Sumar decenas de miles de `Number` deriva centavos.
  const current = Array.from({ length: 7 }, () => new Prisma.Decimal(0))
  const previous = Array.from({ length: 7 }, () => new Prisma.Decimal(0))

  for (const order of orders) {
    const idx = DateTime.fromJSDate(order.createdAt, { zone: 'utc' }).setZone(tz).weekday - 1
    const esActual = order.createdAt >= fromDate && order.createdAt <= toDate
    const bucket = esActual ? current : previous
    bucket[idx] = bucket[idx].add(order.total)
  }

  return weekdays.map((day, i) => {
    const currentWeek = current[i].toDecimalPlaces(2).toNumber()
    const previousWeek = previous[i].toDecimalPlaces(2).toNumber()
    // Sin base de comparación no existe variación porcentual: 0, no un número
    // inventado. El dashboard pinta `previousWeek` al lado, así que el 0 se lee en
    // contexto y no se confunde con "no cambió".
    const changePercentage = previousWeek === 0 ? 0 : Math.round(((currentWeek - previousWeek) / previousWeek) * 100)

    return { day, currentWeek, previousWeek, changePercentage }
  })
}

// Accepts both the native Prisma `PaymentMethod` enum and the legacy MindForm
// string form ('CARD'/'CASH') already produced by qrPayments.legacy.service →
// mergedPayments.service. Falling through would bucket legacy QR payments as
// 'OTHER' and hide them from the "Sales by method" pie chart on /home.
function mapPaymentMethod(method: PaymentMethod | string): string {
  switch (method) {
    case 'CASH':
      return 'CASH'
    case 'CREDIT_CARD':
    case 'DEBIT_CARD':
    case 'CARD': // legacy MindForm passthrough
      return 'CARD'
    case 'DIGITAL_WALLET':
      return 'OTHER'
    default:
      return 'OTHER'
  }
}

/**
 * Get basic metrics data for initial dashboard load (priority data)
 */
export async function getBasicMetricsData(venueId: string, filters: GeneralStatsQuery = {}) {
  // Validate venue exists
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
  })

  if (!venue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found`)
  }

  // Set default date range (last 7 days) if not provided
  const { from: fromDate, to: toDate } = parseDateRange(filters.fromDate, filters.toDate, 7)

  // Build where clause for date filtering
  const dateFilter = {
    createdAt: {
      gte: fromDate,
      lte: toDate,
    },
  }

  // Fetch only valid payments: COMPLETED status, non-cancelled orders, and
  // exclude refund payments (type=REFUND). Refund Payments also carry
  // status=COMPLETED but they're corrections, not sales — including them here
  // makes the "Total ventas" KPI negative on days that only had refunds and
  // inflates downstream derived metrics (avg ticket, tips, etc.).
  //
  // ⚠️ Uses fetchPaymentsForAnalytics instead of prisma.payment.findMany directly
  // so MindForm's legacy QR payments are included in KPIs. For ~999 other
  // venues this is a no-op (single string comparison, zero extra queries).
  // Remove once MindForm is on the native QR module.
  const validPayments = await fetchPaymentsForAnalytics(venueId, {
    fromDate,
    toDate,
  })

  // Fetch reviews for star rating
  const reviews = await prisma.review.findMany({
    where: {
      venueId,
      ...dateFilter,
    },
    select: {
      id: true,
      overallRating: true,
      createdAt: true,
    },
  })

  // Transform data for basic metrics
  const transformedPayments = validPayments.map(payment => ({
    id: payment.id,
    amount: payment.amount,
    method: mapPaymentMethod(payment.method),
    createdAt: payment.createdAt.toISOString(),
    tips: [
      {
        amount: payment.tipAmount,
      },
    ],
  }))

  const transformedReviews = reviews.map(review => ({
    id: review.id,
    stars: review.overallRating,
    createdAt: review.createdAt.toISOString(),
  }))

  // Generate payment methods data for pie chart
  const paymentMethodsData = generatePaymentMethodsData(transformedPayments)

  return {
    payments: transformedPayments,
    reviews: transformedReviews,
    paymentMethodsData,
  }
}

/**
 * Get specific chart data based on chart type
 */
export async function getChartData(venueId: string, chartType: string, filters: GeneralStatsQuery = {}) {
  // Validate venue exists
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
  })

  if (!venue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found`)
  }

  const { from: fromDate, to: toDate } = parseDateRange(filters.fromDate, filters.toDate, 7)

  const dateFilter = {
    createdAt: {
      gte: fromDate,
      lte: toDate,
    },
  }

  switch (chartType) {
    case 'best-selling-products':
      return await getBestSellingProductsData(venueId, dateFilter)

    case 'tips-over-time':
      return await getTipsOverTimeData(venueId, dateFilter)

    case 'sales-by-payment-method':
      return await getSalesByPaymentMethodData(venueId, dateFilter)

    case 'peak-hours':
      return await generatePeakHoursData(venueId, fromDate, toDate, venue.timezone)

    case 'weekly-trends':
      return await generateWeeklyTrendsData(venueId, fromDate, toDate, venue.timezone)

    // Strategic Analytics Chart Types
    case 'revenue-trends':
      return await getRevenueTrendsData(venueId, fromDate, toDate, venue.timezone)

    case 'aov-trends':
      return await getAOVTrendsData(venueId, fromDate, toDate, venue.timezone)

    case 'order-frequency':
      return await getOrderFrequencyData(venueId, fromDate, toDate, venue.timezone)

    case 'customer-satisfaction':
      return await getCustomerSatisfactionData(venueId, fromDate, toDate, venue.timezone)

    case 'kitchen-performance':
      return await getKitchenPerformanceData(venueId, fromDate, toDate)

    case 'sales-by-weekday':
      return await getSalesByWeekdayData(venueId, fromDate, toDate, venue.timezone)

    case 'category-mix':
      return await getCategoryMixData(venueId, dateFilter)

    case 'channel-mix':
      return await getChannelMixData(venueId, dateFilter)

    case 'sales-heatmap':
      return await getSalesHeatmapData(venueId, fromDate, toDate, venue.timezone)

    case 'discount-analysis':
      return await getDiscountAnalysisData(venueId, dateFilter)

    case 'reservation-overview':
      return await getReservationOverviewData(venueId, fromDate, toDate, venue.timezone)

    case 'staff-ranking':
      return await getStaffRankingData(venueId, dateFilter)

    default:
      throw new NotFoundError(`Chart type '${chartType}' not found`)
  }
}

/**
 * Get extended metrics data based on metric type
 */
export async function getExtendedMetrics(venueId: string, metricType: string, filters: GeneralStatsQuery = {}) {
  // Validate venue exists
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
  })

  if (!venue) {
    throw new NotFoundError(`Venue with ID ${venueId} not found`)
  }

  const { from: fromDate, to: toDate } = parseDateRange(filters.fromDate, filters.toDate, 7)

  switch (metricType) {
    case 'table-performance':
      return await generateTablePerformance(venueId, fromDate, toDate)

    case 'product-profitability':
      return await generateProductProfitability(venueId, fromDate, toDate)

    case 'staff-performance':
      return await generateStaffPerformance(venueId, fromDate, toDate)

    case 'prep-times':
      return {
        prepTimesByCategory: {
          entradas: { avg: 8, target: 10 },
          principales: { avg: 12, target: 15 },
          postres: { avg: 4, target: 5 },
          bebidas: { avg: 2, target: 3 },
        },
      }

    // Strategic Analytics Metric Types
    case 'staff-efficiency':
      return { staffPerformance: await generateStaffPerformance(venueId, fromDate, toDate) }

    case 'table-efficiency':
      return { tablePerformance: await generateTablePerformance(venueId, fromDate, toDate) }

    case 'product-analytics':
      return { productProfitability: await generateProductProfitability(venueId, fromDate, toDate) }

    default:
      throw new NotFoundError(`Metric type '${metricType}' not found`)
  }
}

// Helper functions for chart data
async function getBestSellingProductsData(venueId: string, dateFilter: any) {
  const orders = await prisma.order.findMany({
    where: {
      venueId,
      status: { notIn: [OrderStatus.PENDING, OrderStatus.CANCELLED, OrderStatus.DELETED] },
      ...dateFilter,
    },
    include: {
      items: {
        include: {
          product: true,
        },
      },
    },
  })

  const productsMap = new Map<string, any>()

  orders.forEach(order => {
    order.items.forEach(item => {
      if (item.product) {
        const productKey = `${item.product.id}-${item.product.name}`
        const existing = productsMap.get(productKey)

        if (existing) {
          existing.quantity += item.quantity
        } else {
          productsMap.set(productKey, {
            id: item.product.id,
            name: item.product.name,
            type: item.product.type || ProductType.OTHER,
            quantity: item.quantity,
            price: Number(item.product.price),
          })
        }
      }
    })
  })

  const products = Array.from(productsMap.values())
  return { products }
}

async function getTipsOverTimeData(venueId: string, dateFilter: { createdAt: { gte: Date; lte: Date } }) {
  // Exclude refund payments — their tipAmount is negative (post 2026-04-19
  // tip-split fix) and would under-report tips earned on sales.
  // ⚠️ Uses fetchPaymentsForAnalytics so MindForm legacy QR is included.
  // Remove helper + revert to prisma.payment.findMany once native QR ships.
  const payments = await fetchPaymentsForAnalytics(venueId, {
    fromDate: dateFilter.createdAt.gte,
    toDate: dateFilter.createdAt.lte,
  })

  const transformedPayments = payments.map(payment => ({
    createdAt: payment.createdAt.toISOString(),
    tips: [{ amount: payment.tipAmount }],
  }))

  return { payments: transformedPayments }
}

async function getSalesByPaymentMethodData(venueId: string, dateFilter: { createdAt: { gte: Date; lte: Date } }) {
  // Exclude refund payments from the "sales by method" breakdown — refunds
  // have negative amount and would show up as deductions in the chart.
  // ⚠️ Uses fetchPaymentsForAnalytics so MindForm legacy QR is included.
  // Remove helper + revert to prisma.payment.findMany once native QR ships.
  const payments = await fetchPaymentsForAnalytics(venueId, {
    fromDate: dateFilter.createdAt.gte,
    toDate: dateFilter.createdAt.lte,
  })

  const transformedPayments = payments.map(payment => ({
    amount: payment.amount,
    method: mapPaymentMethod(payment.method),
    createdAt: payment.createdAt.toISOString(),
  }))

  return { payments: transformedPayments }
}

function generatePaymentMethodsData(payments: any[]) {
  const methodTotals: Record<string, number> = {}

  payments.forEach(payment => {
    const methodKey = payment.method || 'OTHER'
    const method = methodKey === 'CASH' ? 'Efectivo' : methodKey === 'CARD' ? 'Tarjeta' : 'Otro'
    methodTotals[method] = (methodTotals[method] || 0) + Number(payment.amount)
  })

  return Object.entries(methodTotals).map(([method, total]) => ({ method, total }))
}

// Strategic Analytics Chart Data Functions
async function getRevenueTrendsData(venueId: string, fromDate: Date, toDate: Date, timezone?: string | null) {
  const tz = timezone || DEFAULT_TIMEZONE
  const orders = await prisma.order.findMany({
    where: {
      venueId,
      status: { notIn: [OrderStatus.PENDING, OrderStatus.CANCELLED, OrderStatus.DELETED] },
      createdAt: {
        gte: fromDate,
        lte: toDate,
      },
    },
    include: {
      payments: {
        where: { status: TransactionStatus.COMPLETED },
        select: { amount: true },
      },
    },
  })

  const revenueByDate = new Map<string, number>()

  orders.forEach(order => {
    const dateStr = DateTime.fromJSDate(order.createdAt, { zone: 'utc' }).setZone(tz).toISODate()!
    const revenue = order.payments.reduce((sum, payment) => sum + Number(payment.amount), 0)
    revenueByDate.set(dateStr, (revenueByDate.get(dateStr) || 0) + revenue)
  })

  const revenue = Array.from(revenueByDate.entries())
    .map(([date, amount]) => ({
      date,
      revenue: amount,
      formattedDate: DateTime.fromISO(date, { zone: tz }).toLocaleString({ month: 'short', day: 'numeric' }, { locale: 'es' }),
    }))
    .sort((a, b) => a.date.localeCompare(b.date))

  return { revenue }
}

async function getAOVTrendsData(venueId: string, fromDate: Date, toDate: Date, timezone?: string | null) {
  const tz = timezone || DEFAULT_TIMEZONE
  const orders = await prisma.order.findMany({
    where: {
      venueId,
      status: { notIn: [OrderStatus.PENDING, OrderStatus.CANCELLED, OrderStatus.DELETED] },
      createdAt: {
        gte: fromDate,
        lte: toDate,
      },
    },
    include: {
      payments: {
        where: { status: TransactionStatus.COMPLETED },
        select: { amount: true },
      },
    },
  })

  const aovByDate = new Map<string, { total: number; count: number }>()

  orders.forEach(order => {
    const dateStr = DateTime.fromJSDate(order.createdAt, { zone: 'utc' }).setZone(tz).toISODate()!
    const revenue = order.payments.reduce((sum, payment) => sum + Number(payment.amount), 0)

    if (revenue > 0) {
      const existing = aovByDate.get(dateStr) || { total: 0, count: 0 }
      existing.total += revenue
      existing.count += 1
      aovByDate.set(dateStr, existing)
    }
  })

  const aov = Array.from(aovByDate.entries())
    .map(([date, data]) => ({
      date,
      aov: data.count > 0 ? data.total / data.count : 0,
      orderCount: data.count,
      formattedDate: DateTime.fromISO(date, { zone: tz }).toLocaleString({ month: 'short', day: 'numeric' }, { locale: 'es' }),
    }))
    .sort((a, b) => a.date.localeCompare(b.date))

  return { aov }
}

async function getOrderFrequencyData(venueId: string, fromDate: Date, toDate: Date, timezone?: string | null) {
  const tz = timezone || DEFAULT_TIMEZONE
  const orders = await prisma.order.findMany({
    where: {
      venueId,
      status: { notIn: [OrderStatus.PENDING, OrderStatus.CANCELLED, OrderStatus.DELETED] },
      createdAt: {
        gte: fromDate,
        lte: toDate,
      },
    },
  })

  const frequencyByHour = new Map<number, number>()

  orders.forEach(order => {
    const hour = DateTime.fromJSDate(order.createdAt, { zone: 'utc' }).setZone(tz).hour
    frequencyByHour.set(hour, (frequencyByHour.get(hour) || 0) + 1)
  })

  const frequency = Array.from(frequencyByHour.entries())
    .map(([hour, count]) => ({
      hour: `${hour}:00`,
      orders: count,
      hourNum: hour,
    }))
    .sort((a, b) => a.hourNum - b.hourNum)

  return { frequency }
}

async function getCustomerSatisfactionData(venueId: string, fromDate: Date, toDate: Date, timezone?: string | null) {
  const tz = timezone || DEFAULT_TIMEZONE
  const reviews = await prisma.review.findMany({
    where: {
      venueId,
      createdAt: {
        gte: fromDate,
        lte: toDate,
      },
    },
  })

  const satisfactionByDate = new Map<string, { totalRating: number; count: number }>()

  reviews.forEach(review => {
    const dateStr = DateTime.fromJSDate(review.createdAt, { zone: 'utc' }).setZone(tz).toISODate()!
    const existing = satisfactionByDate.get(dateStr) || { totalRating: 0, count: 0 }
    existing.totalRating += review.overallRating
    existing.count += 1
    satisfactionByDate.set(dateStr, existing)
  })

  const satisfaction = Array.from(satisfactionByDate.entries())
    .map(([date, data]) => ({
      date,
      rating: data.count > 0 ? (data.totalRating / data.count).toFixed(1) : 0,
      reviewCount: data.count,
      formattedDate: DateTime.fromISO(date, { zone: tz }).toLocaleString({ month: 'short', day: 'numeric' }, { locale: 'es' }),
    }))
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

  return { satisfaction }
}

async function getKitchenPerformanceData(venueId: string, fromDate: Date, toDate: Date) {
  // Mock kitchen performance data based on product categories
  // In a real implementation, you would track order preparation times
  const products = await prisma.product.findMany({
    where: {
      venueId,
    },
    include: {
      orderItems: {
        where: {
          order: {
            venueId,
            createdAt: {
              gte: fromDate,
              lte: toDate,
            },
          },
        },
      },
    },
  })

  const performanceByCategory = new Map<string, { orders: number; avgPrepTime: number }>()

  products.forEach(product => {
    const category = product.type || ProductType.OTHER
    const orderCount = product.orderItems.length

    if (orderCount > 0) {
      const existing = performanceByCategory.get(category) || { orders: 0, avgPrepTime: 0 }
      existing.orders += orderCount
      // El tiempo de preparación por categoría no se mide hoy: `KdsOrderItem` no tiene
      // liga a `Product`, así que no se puede saber el tipo de una línea de comanda.
      // Devolvía una constante por categoría más `Math.random()`. Se deja en 0.
      existing.avgPrepTime = 0
      performanceByCategory.set(category, existing)
    }
  })

  const kitchen = Array.from(performanceByCategory.entries()).map(([category, data]) => {
    const categoryName = category === ProductType.FOOD ? 'Comida' : category === ProductType.BEVERAGE ? 'Bebidas' : 'Otros'
    const target = category === ProductType.FOOD ? 15 : category === ProductType.BEVERAGE ? 5 : 10

    return {
      category: categoryName,
      prepTime: data.avgPrepTime,
      target,
      orders: data.orders,
    }
  })

  return { kitchen }
}

// ==========================================
// Dashboard Engine: Additional Chart Types
// ==========================================

async function getSalesByWeekdayData(venueId: string, fromDate: Date, toDate: Date, timezone?: string | null) {
  const tz = timezone || DEFAULT_TIMEZONE
  const orders = await prisma.order.findMany({
    where: {
      venueId,
      status: { notIn: [OrderStatus.PENDING, OrderStatus.CANCELLED, OrderStatus.DELETED] },
      createdAt: { gte: fromDate, lte: toDate },
    },
    select: { createdAt: true, total: true },
  })

  const weekdayNames = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo']
  const weekdayData = new Map<number, { sales: number; transactions: number }>()

  orders.forEach(order => {
    // Luxon weekday: 1=Monday...7=Sunday
    const weekday = DateTime.fromJSDate(order.createdAt, { zone: 'utc' }).setZone(tz).weekday
    const existing = weekdayData.get(weekday) || { sales: 0, transactions: 0 }
    existing.sales += Number(order.total)
    existing.transactions += 1
    weekdayData.set(weekday, existing)
  })

  return weekdayNames.map((name, i) => {
    const data = weekdayData.get(i + 1) || { sales: 0, transactions: 0 }
    return { day: name, sales: data.sales, transactions: data.transactions }
  })
}

async function getCategoryMixData(venueId: string, dateFilter: { createdAt: { gte: Date; lte: Date } }) {
  const orderItems = await prisma.orderItem.findMany({
    where: {
      order: {
        venueId,
        status: { notIn: [OrderStatus.PENDING, OrderStatus.CANCELLED, OrderStatus.DELETED] },
        ...dateFilter,
      },
    },
    select: { categoryName: true, total: true, quantity: true },
  })

  const categoryMap = new Map<string, { revenue: number; quantity: number }>()

  orderItems.forEach(item => {
    const category = item.categoryName || 'Sin categoría'
    const existing = categoryMap.get(category) || { revenue: 0, quantity: 0 }
    existing.revenue += Number(item.total || 0)
    existing.quantity += item.quantity
    categoryMap.set(category, existing)
  })

  const totalRevenue = Array.from(categoryMap.values()).reduce((sum, d) => sum + d.revenue, 0)

  return Array.from(categoryMap.entries())
    .map(([category, data]) => ({
      category,
      revenue: data.revenue,
      quantity: data.quantity,
      percentage: totalRevenue > 0 ? (data.revenue / totalRevenue) * 100 : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue)
}

async function getChannelMixData(venueId: string, dateFilter: { createdAt: { gte: Date; lte: Date } }) {
  const orders = await prisma.order.findMany({
    where: {
      venueId,
      status: { notIn: [OrderStatus.PENDING, OrderStatus.CANCELLED, OrderStatus.DELETED] },
      ...dateFilter,
    },
    select: { type: true, total: true },
  })

  const channelMap = new Map<string, { revenue: number; count: number }>()

  orders.forEach(order => {
    const channel = order.type || 'DINE_IN'
    const existing = channelMap.get(channel) || { revenue: 0, count: 0 }
    existing.revenue += Number(order.total)
    existing.count += 1
    channelMap.set(channel, existing)
  })

  const totalRevenue = Array.from(channelMap.values()).reduce((sum, d) => sum + d.revenue, 0)

  return Array.from(channelMap.entries())
    .map(([channel, data]) => ({
      channel,
      revenue: data.revenue,
      count: data.count,
      percentage: totalRevenue > 0 ? (data.revenue / totalRevenue) * 100 : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue)
}

async function getSalesHeatmapData(venueId: string, fromDate: Date, toDate: Date, timezone?: string | null) {
  const tz = timezone || DEFAULT_TIMEZONE
  const orders = await prisma.order.findMany({
    where: {
      venueId,
      status: { notIn: [OrderStatus.PENDING, OrderStatus.CANCELLED, OrderStatus.DELETED] },
      createdAt: { gte: fromDate, lte: toDate },
    },
    select: { createdAt: true, total: true },
  })

  // Build heatmap: weekday (0-6) x hour (0-23)
  const heatmap: Array<{ day: number; hour: number; value: number }> = []
  const grid = new Map<string, number>()

  orders.forEach(order => {
    const dt = DateTime.fromJSDate(order.createdAt, { zone: 'utc' }).setZone(tz)
    const key = `${dt.weekday - 1}-${dt.hour}` // 0=Mon, 6=Sun
    grid.set(key, (grid.get(key) || 0) + Number(order.total))
  })

  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      heatmap.push({ day, hour, value: grid.get(`${day}-${hour}`) || 0 })
    }
  }

  return { heatmap }
}

/**
 * Discount analysis — counts BOTH places a giveaway can be booked.
 *
 * This used to filter `Order.discountAmount > 0` only. Combos and promotions
 * write their giveaway on the LINE (`OrderItem.discountAmount`) and leave
 * `Order.discountAmount` at 0, so a day with two discounted combos reported
 * `{ ordersWithDiscount: 0, totalDiscount: 0 }`.
 *
 * The two sources are kept SEPARATE in the response (`orderLevelDiscount` /
 * `itemLevelDiscount`) rather than silently merged: an accountant needs to see
 * whether a peso came off the whole ticket or off one product, and the split is
 * additive — the pre-existing fields keep their meaning ("all discount"), the
 * breakdown is new.
 *
 * A line only counts as item-level when its own total is already net of the
 * discount (`isItemLevelDiscount`). "Cobrar" cortesías leave the line GROSS and
 * book the giveaway on `Order.discountAmount` instead — counting both sides
 * would double them. Same trap `salesGiveaways.ts` documents for Sales Summary.
 */
async function getDiscountAnalysisData(venueId: string, dateFilter: { createdAt: { gte: Date; lte: Date } }) {
  const statusFilter = { notIn: [OrderStatus.PENDING, OrderStatus.CANCELLED, OrderStatus.DELETED] }

  const orders = await prisma.order.findMany({
    where: {
      venueId,
      status: statusFilter,
      ...dateFilter,
      OR: [{ discountAmount: { gt: 0 } }, { items: { some: { discountAmount: { gt: 0 } } } }],
    },
    select: {
      total: true,
      discountAmount: true,
      subtotal: true,
      // `weightQuantity` matters: isItemLevelDiscount compares `total` against
      // price × UNITS, and a weighted line's units are its kilos, not `quantity`.
      items: { select: { quantity: true, unitPrice: true, discountAmount: true, total: true, weightQuantity: true } },
    },
  })

  const totalOrders = await prisma.order.count({
    where: { venueId, status: statusFilter, ...dateFilter },
  })

  let orderLevelDiscount = 0
  let itemLevelDiscount = 0
  let totalRevenue = 0
  let ordersWithDiscount = 0

  for (const order of orders) {
    const orderDiscount = Number(order.discountAmount || 0)
    const itemDiscount = order.items.reduce((sum, item) => (isItemLevelDiscount(item) ? sum + Number(item.discountAmount || 0) : sum), 0)

    // The `OR` above matches on the RAW line discount; a line whose giveaway is
    // already inside Order.discountAmount contributes nothing, so an order can
    // reach here with no countable discount at all.
    if (orderDiscount <= 0 && itemDiscount <= 0) continue

    ordersWithDiscount += 1
    orderLevelDiscount += orderDiscount
    itemLevelDiscount += itemDiscount
    totalRevenue += Number(order.total)
  }

  const totalDiscount = orderLevelDiscount + itemLevelDiscount

  return {
    ordersWithDiscount,
    totalOrders,
    discountRate: totalOrders > 0 ? (ordersWithDiscount / totalOrders) * 100 : 0,
    totalDiscount,
    // Breakdown of `totalDiscount` — whole-ticket vs per-product giveaways.
    orderLevelDiscount,
    itemLevelDiscount,
    averageDiscount: ordersWithDiscount > 0 ? totalDiscount / ordersWithDiscount : 0,
    revenueWithDiscount: totalRevenue,
  }
}

async function getReservationOverviewData(venueId: string, fromDate: Date, toDate: Date, timezone?: string | null) {
  const tz = timezone || DEFAULT_TIMEZONE

  // Check if venue has reservations table — return empty if not
  const reservationCount = await prisma.reservation
    .count({
      where: { venueId, createdAt: { gte: fromDate, lte: toDate } },
    })
    .catch(() => 0)

  if (reservationCount === 0) {
    return { reservations: [], summary: { total: 0, confirmed: 0, cancelled: 0, noShow: 0 } }
  }

  const reservations = await prisma.reservation.findMany({
    where: { venueId, createdAt: { gte: fromDate, lte: toDate } },
    select: { createdAt: true, status: true, partySize: true },
  })

  const byDate = new Map<string, { total: number; confirmed: number; cancelled: number }>()

  reservations.forEach(r => {
    const dateStr = DateTime.fromJSDate(r.createdAt, { zone: 'utc' }).setZone(tz).toISODate()!
    const existing = byDate.get(dateStr) || { total: 0, confirmed: 0, cancelled: 0 }
    existing.total += 1
    if (r.status === 'CONFIRMED' || r.status === 'COMPLETED') existing.confirmed += 1
    if (r.status === 'CANCELLED') existing.cancelled += 1
    byDate.set(dateStr, existing)
  })

  return {
    reservations: Array.from(byDate.entries())
      .map(([date, data]) => ({ date, ...data }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    summary: {
      total: reservations.length,
      confirmed: reservations.filter(r => r.status === 'CONFIRMED' || r.status === 'COMPLETED').length,
      cancelled: reservations.filter(r => r.status === 'CANCELLED').length,
      noShow: reservations.filter(r => r.status === 'NO_SHOW').length,
    },
  }
}

async function getStaffRankingData(venueId: string, dateFilter: { createdAt: { gte: Date; lte: Date } }) {
  const orders = await prisma.order.findMany({
    where: {
      venueId,
      status: { notIn: [OrderStatus.PENDING, OrderStatus.CANCELLED, OrderStatus.DELETED] },
      ...dateFilter,
      createdById: { not: null },
    },
    select: {
      total: true,
      tipAmount: true,
      createdById: true,
      createdBy: { select: { firstName: true, lastName: true } },
    },
  })

  const staffMap = new Map<string, { name: string; revenue: number; orders: number; tips: number }>()

  orders.forEach(order => {
    const staffId = order.createdById!
    const existing = staffMap.get(staffId) || {
      name: `${order.createdBy?.firstName || ''} ${order.createdBy?.lastName || ''}`.trim() || 'Sin nombre',
      revenue: 0,
      orders: 0,
      tips: 0,
    }
    existing.revenue += Number(order.total)
    existing.orders += 1
    existing.tips += Number(order.tipAmount || 0)
    staffMap.set(staffId, existing)
  })

  return Array.from(staffMap.values())
    .map(s => ({
      ...s,
      averageTicket: s.orders > 0 ? s.revenue / s.orders : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue)
}
