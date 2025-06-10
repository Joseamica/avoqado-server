import { Payment, Order, Staff, TransactionStatus } from '@prisma/client'

export type PaginatedPaymentsResponse = {
  data: (Payment & { processedBy: Staff | null; order: Order | null })[]
  meta: {
    total: number
    page: number
    pageSize: number
    pageCount: number
  }
}
