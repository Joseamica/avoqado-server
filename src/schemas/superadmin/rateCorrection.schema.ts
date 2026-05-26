import { z } from 'zod'

const rate = z.number().min(0).max(1)
const rateSet = z.object({
  debitRate: rate,
  creditRate: rate,
  amexRate: rate,
  internationalRate: rate,
  includesTax: z.boolean().nullable().optional(),
  taxRate: rate.nullable().optional(),
  fixedFeePerTransaction: z.number().min(0).nullable().optional(),
  fixedCostPerTransaction: z.number().min(0).nullable().optional(),
})

export const rateCorrectionBodySchema = z
  .object({
    accountType: z.enum(['PRIMARY', 'SECONDARY', 'TERTIARY']),
    newVenueRates: rateSet.optional(),
    newProviderRates: rateSet.optional(),
    dateFrom: z.string().datetime().optional(),
    dateTo: z.string().datetime().optional(),
    missingCostMode: z.enum(['FIX_PAYMENT_ONLY', 'CREATE_COST']),
  })
  .refine(b => b.newVenueRates || b.newProviderRates, {
    message: 'At least one of newVenueRates / newProviderRates is required',
  })

export type RateCorrectionBody = z.infer<typeof rateCorrectionBodySchema>
