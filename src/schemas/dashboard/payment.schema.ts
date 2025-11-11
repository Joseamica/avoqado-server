import { Order, Payment, Staff, MerchantAccount, PaymentProvider } from '@prisma/client'

export type PaymentWithRelations = Payment & {
  processedBy: Staff | null
  order: Order | null
  merchantAccount: (MerchantAccount & {
    provider: Pick<PaymentProvider, 'id' | 'code' | 'name'>
  }) | null
}

export type PaginatedPaymentsResponse = {
  data: PaymentWithRelations[]
  meta: {
    total: number
    page: number
    pageSize: number
    pageCount: number
  }
}
