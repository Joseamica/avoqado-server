import { Order, Table } from '@prisma/client'
import { z } from 'zod'
import { StaffPublico } from '../../utils/staffPublicSelect'

export type PaginatedOrdersResponse = {
  data: (Order & {
    // Nunca `Staff` entero: la fila lleva el hash de la contraseña (30-sep).
    createdBy: StaffPublico | null
    servedBy: StaffPublico | null
    table: Table | null
  })[]
  meta: {
    total: number
    page: number
    pageSize: number
    pageCount: number
  }
}

/**
 * Schema for settling an order's pending balance
 */
export const SettleOrderSchema = z.object({
  params: z.object({
    venueId: z.string().cuid(),
    orderId: z.string().cuid(),
  }),
  body: z.object({
    notes: z.string().max(500).optional(),
  }),
})
