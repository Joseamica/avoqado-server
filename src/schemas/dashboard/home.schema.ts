// src/types/dashboard.types.ts

// Interfaz para filtros de fecha
export interface DateFilter {
    from: Date
    to: Date
  }
  
  // Métricas básicas
  export interface BasicMetrics {
    totalSales: number
    totalPayments: number
    fiveStarReviews: number
    totalTips: number
    tipCount: number
    avgTipPercentage: number
  }
  
  // Rendimiento de mesas
  export interface TablePerformance {
    tableId: string
    tableNumber: number
    capacity: number
    avgTicket: number
    rotationRate: number
    totalRevenue: number
  }
  
  // Rendimiento del personal
  export interface StaffPerformance {
    staffId: string
    name: string
    role: string
    totalSales: number
    totalTips: number
    orderCount: number
    avgPrepTime: number
  }
  
  // Rentabilidad de productos
  export interface ProductProfitability {
    name: string
    type: string
    price: number
    cost: number
    margin: number
    marginPercentage: number
    quantity: number
    totalRevenue: number
  }
  
  // Datos de horas pico
  export interface PeakHoursData {
    hour: number
    sales: number
    transactions: number
  }
  
  // Tendencias semanales
  export interface WeeklyTrendsData {
    day: string
    currentWeek: number
    previousWeek: number
    changePercentage: number
  }
  
  // Tiempos de preparación por categoría
  export interface PrepTimesByCategory {
    entradas: { avg: number; target: number }
    principales: { avg: number; target: number }
    postres: { avg: number; target: number }
    bebidas: { avg: number; target: number }
  }
  
  // Analytics completos
  export interface AnalyticsData {
    tablePerformance: TablePerformance[]
    staffPerformanceMetrics: StaffPerformance[]
    productProfitability: ProductProfitability[]
    peakHoursData: PeakHoursData[]
    weeklyTrendsData: WeeklyTrendsData[]
    prepTimesByCategory: PrepTimesByCategory
  }

  // src/schemas/dashboard.schema.ts
import { z } from 'zod'

// Schema común para parámetros de venue
export const dashboardVenueParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid({ message: 'El ID del venue debe ser un CUID válido.' }),
  }),
})

// Schema común para query de fechas
export const dashboardDateQuerySchema = z.object({
  query: z.object({
    fromDate: z.string().datetime({ message: 'fromDate debe ser una fecha ISO válida.' }).optional(),
    toDate: z.string().datetime({ message: 'toDate debe ser una fecha ISO válida.' }).optional(),
  }),
})

// Schema combinado para endpoints de dashboard con fechas
export const dashboardWithDatesSchema = dashboardVenueParamsSchema.merge(dashboardDateQuerySchema)

// Tipos inferidos
export type DashboardVenueParams = z.infer<typeof dashboardVenueParamsSchema.shape.params>
export type DashboardDateQuery = z.infer<typeof dashboardDateQuerySchema.shape.query>
export type DashboardWithDates = {
  params: DashboardVenueParams
  query: DashboardDateQuery
}