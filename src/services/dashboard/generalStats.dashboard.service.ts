import { PaymentMethod, ProductType, TransactionStatus, OrderStatus } from '@prisma/client'
import { NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { GeneralStatsResponse, GeneralStatsQuery } from '../../schemas/dashboard/generalStats.schema'
import { SharedQueryService } from './shared-query.service'
import { parseDateRange, DEFAULT_TIMEZONE } from '../../utils/datetime'
import { DateTime } from 'luxon'

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
  const weeklyTrendsData = await generateWeeklyTrendsData(venueId, fromDate, toDate)

  // Generate prep times by category (mock data for now)
  const prepTimesByCategory = {
    entradas: { avg: 8, target: 10 },
    principales: { avg: 12, target: 15 },
    postres: { avg: 4, target: 5 },
    bebidas: { avg: 2, target: 3 },
  }

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
    avgPrepTime: Math.floor(Math.random() * 10) + 5, // Mock data (not tracked in DB yet)
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
        include: {
          product: true,
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

        const itemRevenue = item.quantity * Number(item.unitPrice)
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

async function generateWeeklyTrendsData(_venueId: string, _fromDate: Date, _toDate: Date) {
  const weekdays = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo']

  return weekdays.map(day => ({
    day,
    currentWeek: Math.floor(Math.random() * 1000) + 500,
    previousWeek: Math.floor(Math.random() * 1000) + 400,
    changePercentage: Math.floor(Math.random() * 40) - 20,
  }))
}

function mapPaymentMethod(method: PaymentMethod): string {
  switch (method) {
    case PaymentMethod.CASH:
      return 'CASH'
    case PaymentMethod.CREDIT_CARD:
    case PaymentMethod.DEBIT_CARD:
      return 'CARD'
    case PaymentMethod.DIGITAL_WALLET:
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
  const validPayments = await prisma.payment.findMany({
    where: {
      venueId,
      status: TransactionStatus.COMPLETED,
      type: { not: 'REFUND' },
      createdAt: {
        gte: fromDate,
        lte: toDate,
      },
      order: {
        status: { not: OrderStatus.CANCELLED },
      },
    },
    select: {
      id: true,
      amount: true,
      method: true,
      tipAmount: true,
      type: true,
      createdAt: true,
    },
    orderBy: {
      createdAt: 'desc',
    },
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
      return await generateWeeklyTrendsData(venueId, fromDate, toDate)

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

async function getTipsOverTimeData(venueId: string, dateFilter: any) {
  // Exclude refund payments — their tipAmount is negative (post 2026-04-19
  // tip-split fix) and would under-report tips earned on sales.
  const payments = await prisma.payment.findMany({
    where: {
      venueId,
      status: TransactionStatus.COMPLETED,
      type: { not: 'REFUND' },
      ...dateFilter,
    },
    select: {
      tipAmount: true,
      createdAt: true,
    },
  })

  const transformedPayments = payments.map(payment => ({
    createdAt: payment.createdAt.toISOString(),
    tips: [{ amount: Number(payment.tipAmount) }],
  }))

  return { payments: transformedPayments }
}

async function getSalesByPaymentMethodData(venueId: string, dateFilter: any) {
  // Exclude refund payments from the "sales by method" breakdown — refunds
  // have negative amount and would show up as deductions in the chart.
  const payments = await prisma.payment.findMany({
    where: {
      venueId,
      status: TransactionStatus.COMPLETED,
      type: { not: 'REFUND' },
      ...dateFilter,
    },
    select: {
      amount: true,
      method: true,
      createdAt: true,
    },
  })

  const transformedPayments = payments.map(payment => ({
    amount: Number(payment.amount),
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
      // Mock prep time based on category
      const basePrepTime = category === ProductType.FOOD ? 12 : category === ProductType.BEVERAGE ? 3 : 8
      existing.avgPrepTime = basePrepTime + Math.floor(Math.random() * 5)
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

async function getDiscountAnalysisData(venueId: string, dateFilter: { createdAt: { gte: Date; lte: Date } }) {
  const orders = await prisma.order.findMany({
    where: {
      venueId,
      status: { notIn: [OrderStatus.PENDING, OrderStatus.CANCELLED, OrderStatus.DELETED] },
      ...dateFilter,
      discountAmount: { gt: 0 },
    },
    select: { total: true, discountAmount: true, subtotal: true },
  })

  const totalOrders = await prisma.order.count({
    where: {
      venueId,
      status: { notIn: [OrderStatus.PENDING, OrderStatus.CANCELLED, OrderStatus.DELETED] },
      ...dateFilter,
    },
  })

  const totalDiscount = orders.reduce((sum, o) => sum + Number(o.discountAmount || 0), 0)
  const totalRevenue = orders.reduce((sum, o) => sum + Number(o.total), 0)

  return {
    ordersWithDiscount: orders.length,
    totalOrders,
    discountRate: totalOrders > 0 ? (orders.length / totalOrders) * 100 : 0,
    totalDiscount,
    averageDiscount: orders.length > 0 ? totalDiscount / orders.length : 0,
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
