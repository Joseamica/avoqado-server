import { z } from 'zod'

// Query parameters schema for general stats endpoint
export const GeneralStatsQuerySchema = z.object({
  fromDate: z.string().datetime().optional(),
  toDate: z.string().datetime().optional(),
})

// Type definitions for general stats response
export const TablePerformanceSchema = z.object({
  tableId: z.string(),
  tableNumber: z.number(),
  totalSales: z.number(),
  avgTicket: z.number(),
  turnoverRate: z.number(),
  occupancyRate: z.number(),
})

export const StaffPerformanceSchema = z.object({
  staffId: z.string(),
  name: z.string(),
  role: z.string(),
  totalSales: z.number(),
  totalTips: z.number(),
  orderCount: z.number(),
  avgPrepTime: z.number(),
})

export const ProductProfitabilitySchema = z.object({
  name: z.string(),
  type: z.string(),
  price: z.number(),
  cost: z.number(),
  margin: z.number(),
  marginPercentage: z.number(),
  quantity: z.number(),
  totalRevenue: z.number(),
})

export const PeakHoursDataSchema = z.object({
  hour: z.number(),
  sales: z.number(),
  transactions: z.number(),
})

export const WeeklyTrendsDataSchema = z.object({
  day: z.string(),
  currentWeek: z.number(),
  previousWeek: z.number(),
  changePercentage: z.number(),
})

export const PrepTimesByCategorySchema = z.object({
  entradas: z.object({
    avg: z.number(),
    target: z.number(),
  }),
  principales: z.object({
    avg: z.number(),
    target: z.number(),
  }),
  postres: z.object({
    avg: z.number(),
    target: z.number(),
  }),
  bebidas: z.object({
    avg: z.number(),
    target: z.number(),
  }),
})

export const ExtraMetricsSchema = z.object({
  tablePerformance: z.array(TablePerformanceSchema),
  staffPerformanceMetrics: z.array(StaffPerformanceSchema),
  productProfitability: z.array(ProductProfitabilitySchema),
  peakHoursData: z.array(PeakHoursDataSchema),
  weeklyTrendsData: z.array(WeeklyTrendsDataSchema),
  prepTimesByCategory: PrepTimesByCategorySchema,
})

// Payment schema adapted from legacy structure
export const PaymentSchema = z.object({
  id: z.string(),
  amount: z.number(),
  method: z.string(),
  createdAt: z.string(),
  tips: z.array(z.object({
    amount: z.number(),
  })),
})

// Feedback schema adapted from legacy structure
export const FeedbackSchema = z.object({
  id: z.string(),
  stars: z.number(),
  createdAt: z.string(),
})

// Product schema adapted from legacy structure
export const ProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  quantity: z.number(),
  price: z.number(),
})

// Main response schema
export const GeneralStatsResponseSchema = z.object({
  payments: z.array(PaymentSchema),
  feedbacks: z.array(FeedbackSchema),
  products: z.array(ProductSchema),
  extraMetrics: ExtraMetricsSchema,
})

// Export types
export type GeneralStatsQuery = z.infer<typeof GeneralStatsQuerySchema>
export type GeneralStatsResponse = z.infer<typeof GeneralStatsResponseSchema>
export type TablePerformance = z.infer<typeof TablePerformanceSchema>
export type StaffPerformance = z.infer<typeof StaffPerformanceSchema>
export type ProductProfitability = z.infer<typeof ProductProfitabilitySchema>
export type PeakHoursData = z.infer<typeof PeakHoursDataSchema>
export type WeeklyTrendsData = z.infer<typeof WeeklyTrendsDataSchema>
export type PrepTimesByCategory = z.infer<typeof PrepTimesByCategorySchema>
export type ExtraMetrics = z.infer<typeof ExtraMetricsSchema>
