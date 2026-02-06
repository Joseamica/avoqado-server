import { PaymentMethod, ProductType, TransactionStatus, OrderStatus } from '@prisma/client'
import { NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { GeneralStatsResponse, GeneralStatsQuery } from '../../schemas/dashboard/generalStats.schema'
import { SharedQueryService } from './shared-query.service'
import { parseDateRange } from '../../utils/datetime'

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

  // Fetch payments with order status to filter out cancelled orders
  const payments = await prisma.payment.findMany({
    where: {
      venueId,
      createdAt: {
        gte: fromDate,
        lte: toDate,
      },
    },
    include: {
      order: {
        select: {
          status: true,
        },
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  })

  // Filter out:
  // 1. Pending/Failed payments (only COMPLETED should count as sales)
  // 2. Payments from cancelled orders (should not count towards total sales)
  const validPayments = payments.filter(p => {
    if (p.status !== TransactionStatus.COMPLETED) return false
    if (p.order?.status === OrderStatus.CANCELLED) return false
    return true
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
  const extraMetrics = await generateExtraMetrics(venueId, fromDate, toDate)

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

async function generateExtraMetrics(venueId: string, fromDate: Date, toDate: Date) {
  // Fetch table performance data
  const tablePerformance = await generateTablePerformance(venueId, fromDate, toDate)

  // Fetch staff performance data
  const staffPerformanceMetrics = await generateStaffPerformance(venueId, fromDate, toDate)

  // Fetch product profitability data
  const productProfitability = await generateProductProfitability(venueId, fromDate, toDate)

  // Generate peak hours data
  const peakHoursData = await generatePeakHoursData(venueId, fromDate, toDate)

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

async function generatePeakHoursData(venueId: string, fromDate: Date, toDate: Date) {
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
    const hour = order.createdAt.getHours()
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

  // Fetch only essential data for basic metrics
  // Include order relationship to filter out payments from cancelled orders
  const payments = await prisma.payment.findMany({
    where: {
      venueId,
      createdAt: {
        gte: fromDate,
        lte: toDate,
      },
    },
    select: {
      id: true,
      amount: true,
      method: true,
      tipAmount: true,
      status: true,
      createdAt: true,
      order: {
        select: {
          status: true,
        },
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  })

  // Filter out:
  // 1. Pending/Failed payments (only COMPLETED should count as sales)
  // 2. Payments from cancelled orders (should not count towards total sales)
  const validPayments = payments.filter(p => {
    // Only include completed payments
    if (p.status !== TransactionStatus.COMPLETED) return false
    // Exclude payments from cancelled orders
    if (p.order?.status === OrderStatus.CANCELLED) return false
    return true
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
      return await generatePeakHoursData(venueId, fromDate, toDate)

    case 'weekly-trends':
      return await generateWeeklyTrendsData(venueId, fromDate, toDate)

    // Strategic Analytics Chart Types
    case 'revenue-trends':
      return await getRevenueTrendsData(venueId, fromDate, toDate)

    case 'aov-trends':
      return await getAOVTrendsData(venueId, fromDate, toDate)

    case 'order-frequency':
      return await getOrderFrequencyData(venueId, fromDate, toDate)

    case 'customer-satisfaction':
      return await getCustomerSatisfactionData(venueId, fromDate, toDate)

    case 'kitchen-performance':
      return await getKitchenPerformanceData(venueId, fromDate, toDate)

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
  const payments = await prisma.payment.findMany({
    where: {
      venueId,
      ...dateFilter,
    },
    select: {
      tipAmount: true,
      createdAt: true,
      status: true,
    },
  })

  // Only include COMPLETED payments (exclude PENDING, FAILED, etc.)
  const validPayments = payments.filter(p => p.status === TransactionStatus.COMPLETED)

  const transformedPayments = validPayments.map(payment => ({
    createdAt: payment.createdAt.toISOString(),
    tips: [{ amount: Number(payment.tipAmount) }],
  }))

  return { payments: transformedPayments }
}

async function getSalesByPaymentMethodData(venueId: string, dateFilter: any) {
  const payments = await prisma.payment.findMany({
    where: {
      venueId,
      ...dateFilter,
    },
    select: {
      amount: true,
      method: true,
      createdAt: true,
      status: true,
    },
  })

  // Only include COMPLETED payments (exclude PENDING, FAILED, etc.)
  const validPayments = payments.filter(p => p.status === TransactionStatus.COMPLETED)

  const transformedPayments = validPayments.map(payment => ({
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
async function getRevenueTrendsData(venueId: string, fromDate: Date, toDate: Date) {
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
      payments: true,
    },
  })

  const revenueByDate = new Map<string, number>()

  orders.forEach(order => {
    const dateStr = order.createdAt.toISOString().split('T')[0]
    const revenue = order.payments
      .filter(payment => payment.status === TransactionStatus.COMPLETED)
      .reduce((sum, payment) => sum + Number(payment.amount), 0)

    revenueByDate.set(dateStr, (revenueByDate.get(dateStr) || 0) + revenue)
  })

  const revenue = Array.from(revenueByDate.entries())
    .map(([date, amount]) => ({
      date,
      revenue: amount,
      formattedDate: new Date(date).toLocaleDateString('es-ES', {
        month: 'short',
        day: 'numeric',
      }),
    }))
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

  return { revenue }
}

async function getAOVTrendsData(venueId: string, fromDate: Date, toDate: Date) {
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
      payments: true,
    },
  })

  const aovByDate = new Map<string, { total: number; count: number }>()

  orders.forEach(order => {
    const dateStr = order.createdAt.toISOString().split('T')[0]
    const revenue = order.payments
      .filter(payment => payment.status === TransactionStatus.COMPLETED)
      .reduce((sum, payment) => sum + Number(payment.amount), 0)

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
      formattedDate: new Date(date).toLocaleDateString('es-ES', {
        month: 'short',
        day: 'numeric',
      }),
    }))
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

  return { aov }
}

async function getOrderFrequencyData(venueId: string, fromDate: Date, toDate: Date) {
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
    const hour = order.createdAt.getHours()
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

async function getCustomerSatisfactionData(venueId: string, fromDate: Date, toDate: Date) {
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
    const dateStr = review.createdAt.toISOString().split('T')[0]
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
      formattedDate: new Date(date).toLocaleDateString('es-ES', {
        month: 'short',
        day: 'numeric',
      }),
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
