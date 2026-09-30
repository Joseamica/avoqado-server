import { Order, Payment, MerchantAccount, PaymentProvider } from '@prisma/client'
import { StaffPublico } from '../../utils/staffPublicSelect'

export type PaymentWithRelations = Payment & {
  // Nunca `Staff` entero: el tipo prometía que la respuesta llevaba el hash de la contraseña (30-sep).
  processedBy: StaffPublico | null
  order: Order | null
  merchantAccount:
    | (MerchantAccount & {
        provider: Pick<PaymentProvider, 'id' | 'code' | 'name'>
      })
    | null
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
