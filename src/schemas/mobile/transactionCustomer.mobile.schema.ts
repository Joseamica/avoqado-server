import { z } from 'zod'

export const transactionCustomerSchema = z.object({
  body: z.object({ customerId: z.string({ required_error: 'El cliente es requerido' }).cuid('El cliente no es válido') }),
})
