import { SaleVerificationStatus, Prisma } from '@prisma/client'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'

// ============================================================
// Sale Verification Dashboard Service
// ============================================================
// Provides sale verification data with staff and payment details
// for the dashboard Sales Report view

interface ScannedProduct {
  barcode: string
  format: string
  productName?: string | null
  productId?: string | null
  hasInventory: boolean
  quantity: number
}

interface SaleVerificationDashboardResponse {
  id: string
  venueId: string
  paymentId: string
  staffId: string
  photos: string[]
  scannedProducts: ScannedProduct[]
  status: SaleVerificationStatus
  inventoryDeducted: boolean
  deviceId: string | null
  notes: string | null
  createdAt: Date
  updatedAt: Date
  /** True if this payment has an associated sale verification record */
  hasVerification: boolean
  // Joined data
  staff: {
    id: string
    firstName: string
    lastName: string
    email: string
    photoUrl?: string | null
  } | null
  payment: {
    id: string
    amount: number
    status: string
    createdAt: Date
    order?: {
      id: string
      orderNumber: string
      total: number
      tags: string[]
    } | null
  } | null
}

interface ListSaleVerificationsParams {
  pageSize: number
  pageNumber: number
  status?: SaleVerificationStatus
  staffId?: string
  fromDate?: Date
  toDate?: Date
  search?: string
}

interface PaginatedResponse<T> {
  data: T[]
  pagination: {
    pageSize: number
    pageNumber: number
    totalCount: number
    totalPages: number
  }
}

interface SalesSummary {
  totalRevenue: number
  totalCount: number
  conciliatedCount: number
  pendingCount: number
  completedCount: number
  failedCount: number
  avgAmount: number
  /** Count of payments without any sale verification */
  withoutVerificationCount: number
}

/**
 * List sale verifications with staff and payment details
 * For dashboard Sales Report view
 *
 * Now queries from Payment and LEFT JOINs with SaleVerification
 * to return ALL payments (including those without verification)
 */
export async function listSaleVerificationsWithDetails(
  venueId: string,
  params: ListSaleVerificationsParams,
): Promise<PaginatedResponse<SaleVerificationDashboardResponse>> {
  logger.info(
    `[SALE VERIFICATION DASHBOARD] Listing verifications for venue ${venueId} | Page ${params.pageNumber}, Size ${params.pageSize}`,
  )

  // Build WHERE clause for payments
  const paymentWhere: Prisma.PaymentWhereInput = {
    order: {
      venueId,
    },
    status: 'COMPLETED', // Only completed payments
  }

  // Handle date range on payment createdAt
  if (params.fromDate && params.toDate) {
    paymentWhere.createdAt = {
      gte: params.fromDate,
      lte: params.toDate,
    }
  } else if (params.fromDate) {
    paymentWhere.createdAt = { gte: params.fromDate }
  } else if (params.toDate) {
    paymentWhere.createdAt = { lte: params.toDate }
  }

  // Filter by verification status if provided
  if (params.status) {
    paymentWhere.saleVerification = {
      status: params.status,
    }
  }

  // Filter by staff if provided
  if (params.staffId) {
    paymentWhere.saleVerification = {
      ...((paymentWhere.saleVerification as object) ?? {}),
      staffId: params.staffId,
    }
  }

  // Search filter
  if (params.search) {
    paymentWhere.OR = [
      { id: { contains: params.search, mode: 'insensitive' } },
      {
        saleVerification: {
          staff: {
            OR: [
              { firstName: { contains: params.search, mode: 'insensitive' } },
              { lastName: { contains: params.search, mode: 'insensitive' } },
            ],
          },
        },
      },
    ]
  }

  const [payments, totalCount] = await Promise.all([
    prisma.payment.findMany({
      where: paymentWhere,
      orderBy: { createdAt: 'desc' },
      skip: (params.pageNumber - 1) * params.pageSize,
      take: params.pageSize,
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            total: true,
            tags: true,
          },
        },
        saleVerification: {
          include: {
            staff: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                photoUrl: true,
              },
            },
          },
        },
      },
    }),
    prisma.payment.count({ where: paymentWhere }),
  ])

  const response: SaleVerificationDashboardResponse[] = payments.map(p => {
    const v = p.saleVerification
    const hasVerification = v !== null

    return {
      // Use verification ID if exists, otherwise payment ID as fallback
      id: v?.id ?? p.id,
      venueId,
      paymentId: p.id,
      staffId: v?.staffId ?? '',
      photos: v?.photos ?? [],
      scannedProducts: (v?.scannedProducts as unknown as ScannedProduct[]) ?? [],
      status: v?.status ?? ('PENDING' as SaleVerificationStatus),
      inventoryDeducted: v?.inventoryDeducted ?? false,
      deviceId: v?.deviceId ?? null,
      notes: v?.notes ?? null,
      createdAt: v?.createdAt ?? p.createdAt,
      updatedAt: v?.updatedAt ?? p.createdAt,
      hasVerification,
      staff: v?.staff ?? null,
      payment: {
        id: p.id,
        amount: Number(p.amount),
        status: p.status,
        createdAt: p.createdAt,
        order: p.order
          ? {
              id: p.order.id,
              orderNumber: p.order.orderNumber,
              total: Number(p.order.total),
              tags: p.order.tags,
            }
          : null,
      },
    }
  })

  logger.info(`[SALE VERIFICATION DASHBOARD] Found ${response.length} payments (total: ${totalCount})`)

  return {
    data: response,
    pagination: {
      pageSize: params.pageSize,
      pageNumber: params.pageNumber,
      totalCount,
      totalPages: Math.ceil(totalCount / params.pageSize),
    },
  }
}

/**
 * Get summary statistics for sale verifications
 * For dashboard metrics cards
 *
 * Now counts ALL completed payments and checks which have/don't have verification
 */
export async function getSaleVerificationsSummary(venueId: string, fromDate?: Date, toDate?: Date): Promise<SalesSummary> {
  logger.info(`[SALE VERIFICATION DASHBOARD] Getting summary for venue ${venueId}`)

  // Build WHERE clause for payments
  const paymentWhere: Prisma.PaymentWhereInput = {
    order: {
      venueId,
    },
    status: 'COMPLETED',
  }

  if (fromDate && toDate) {
    paymentWhere.createdAt = { gte: fromDate, lte: toDate }
  } else if (fromDate) {
    paymentWhere.createdAt = { gte: fromDate }
  } else if (toDate) {
    paymentWhere.createdAt = { lte: toDate }
  }

  // Get all completed payments with their sale verifications
  const payments = await prisma.payment.findMany({
    where: paymentWhere,
    include: {
      saleVerification: {
        select: { status: true },
      },
    },
  })

  // Calculate totals
  let totalRevenue = 0
  let completedCount = 0
  let pendingCount = 0
  let failedCount = 0
  let withoutVerificationCount = 0

  for (const p of payments) {
    const amount = typeof p.amount === 'number' ? p.amount : Number(p.amount)
    totalRevenue += amount

    if (p.saleVerification) {
      switch (p.saleVerification.status) {
        case 'COMPLETED':
          completedCount++
          break
        case 'PENDING':
          pendingCount++
          break
        case 'FAILED':
          failedCount++
          break
      }
    } else {
      withoutVerificationCount++
    }
  }

  const totalCount = payments.length
  const avgAmount = totalCount > 0 ? totalRevenue / totalCount : 0

  return {
    totalRevenue,
    totalCount,
    conciliatedCount: completedCount, // COMPLETED = conciliado
    pendingCount,
    completedCount,
    failedCount,
    avgAmount,
    withoutVerificationCount,
  }
}

/**
 * Get daily sales data for charts
 */
export async function getDailySalesData(
  venueId: string,
  fromDate: Date,
  toDate: Date,
): Promise<Array<{ date: string; revenue: number; count: number }>> {
  logger.info(`[SALE VERIFICATION DASHBOARD] Getting daily sales data for venue ${venueId}`)

  const verifications = await prisma.saleVerification.findMany({
    where: {
      venueId,
      createdAt: { gte: fromDate, lte: toDate },
    },
    include: {
      payment: {
        select: { amount: true },
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  // Group by day
  const dailyData = new Map<string, { revenue: number; count: number }>()

  for (const v of verifications) {
    const dateKey = v.createdAt.toISOString().split('T')[0]
    const existing = dailyData.get(dateKey) ?? { revenue: 0, count: 0 }
    const amount = v.payment?.amount ?? 0

    dailyData.set(dateKey, {
      revenue: existing.revenue + (typeof amount === 'number' ? amount : Number(amount)),
      count: existing.count + 1,
    })
  }

  return Array.from(dailyData.entries()).map(([date, data]) => ({
    date,
    revenue: data.revenue,
    count: data.count,
  }))
}

/**
 * Get staff for sale verifications filter
 */
export async function getStaffWithVerifications(venueId: string): Promise<
  Array<{
    id: string
    firstName: string
    lastName: string
    verificationCount: number
  }>
> {
  logger.info(`[SALE VERIFICATION DASHBOARD] Getting staff with verifications for venue ${venueId}`)

  const staffWithCounts = await prisma.saleVerification.groupBy({
    by: ['staffId'],
    where: { venueId },
    _count: { id: true },
  })

  const staffIds = staffWithCounts.map(s => s.staffId)

  const staff = await prisma.staff.findMany({
    where: { id: { in: staffIds } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
    },
  })

  return staff.map(s => {
    const count = staffWithCounts.find(sc => sc.staffId === s.id)?._count.id ?? 0
    return {
      id: s.id,
      firstName: s.firstName,
      lastName: s.lastName,
      verificationCount: count,
    }
  })
}
