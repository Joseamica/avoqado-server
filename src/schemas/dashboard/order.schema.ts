import { Order, Staff, Table } from '@prisma/client'

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
