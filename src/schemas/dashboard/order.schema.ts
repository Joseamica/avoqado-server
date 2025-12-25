import { Order, Staff, Table } from '@prisma/client'
import { z } from 'zod'

export type PaginatedOrdersResponse = {
  data: (Order & {
    createdBy: Staff | null
    servedBy: Staff | null
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
