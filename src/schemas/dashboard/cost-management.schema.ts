import { z } from 'zod'
import { TransactionCardType, AccountType, ProfitStatus } from '@prisma/client'

// ===== QUERY SCHEMAS =====

/**
 * Schema for profit metrics query parameters
 */
export const profitMetricsQuerySchema = z.object({
  query: z.object({
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    venueId: z.string().optional(),
    providerId: z.string().optional(),
  }),
})

/**
 * Schema for monthly profits query parameters
 */
export const monthlyProfitsQuerySchema = z.object({
  query: z.object({
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    venueId: z.string().optional(),
    status: z.nativeEnum(ProfitStatus).optional(),
  }),
})

/**
 * Schema for transaction costs query parameters
 */
export const transactionCostsQuerySchema = z.object({
  query: z.object({
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    venueId: z.string().optional(),
    providerId: z.string().optional(),
    transactionType: z.nativeEnum(TransactionCardType).optional(),
    limit: z.string().transform(Number).optional(),
    offset: z.string().transform(Number).optional(),
  }),
})

/**
 * Schema for provider cost structures query parameters
 */
export const providerCostStructuresQuerySchema = z.object({
  query: z.object({
    providerId: z.string().optional(),
    merchantAccountId: z.string().optional(),
    active: z
      .string()
      .transform(val => val === 'true')
      .optional(),
  }),
})

/**
 * Schema for venue pricing structures query parameters
 */
export const venuePricingStructuresQuerySchema = z.object({
  query: z.object({
    venueId: z.string().optional(),
    accountType: z.nativeEnum(AccountType).optional(),
    active: z
      .string()
      .transform(val => val === 'true')
      .optional(),
  }),
})

/**
 * Schema for merchant accounts query parameters
 */
export const merchantAccountsQuerySchema = z.object({
  query: z.object({
    providerId: z.string().optional(),
  }),
})

// ===== BODY SCHEMAS =====

/**
 * Schema for profit recalculation request
 */
export const recalculateProfitsSchema = z.object({
  body: z.object({
    startDate: z.string().min(1, 'Start date is required'),
    endDate: z.string().min(1, 'End date is required'),
    venueId: z.string().optional(),
  }),
})

/**
 * Schema for provider cost structure creation/update
 */
export const providerCostStructureSchema = z.object({
  body: z.object({
    providerId: z.string().min(1, 'Provider ID is required'),
    merchantAccountId: z.string().min(1, 'Merchant account ID is required'),
    debitRate: z.number().min(0).max(1, 'Debit rate must be between 0 and 1'),
    creditRate: z.number().min(0).max(1, 'Credit rate must be between 0 and 1'),
    amexRate: z.number().min(0).max(1, 'Amex rate must be between 0 and 1'),
    internationalRate: z.number().min(0).max(1, 'International rate must be between 0 and 1'),
    fixedCostPerTransaction: z.number().min(0).optional(),
    monthlyFee: z.number().min(0).optional(),
    minimumVolume: z.number().min(0).optional(),
    volumeDiscount: z.number().min(0).max(1).optional(),
    effectiveFrom: z.string().min(1, 'Effective from date is required'),
    effectiveTo: z.string().optional(),
    proposalReference: z.string().optional(),
    notes: z.string().optional(),
  }),
})

/**
 * Schema for venue pricing structure creation/update
 */
export const venuePricingStructureSchema = z.object({
  body: z.object({
    venueId: z.string().min(1, 'Venue ID is required'),
    accountType: z.nativeEnum(AccountType),
    debitRate: z.number().min(0).max(1, 'Debit rate must be between 0 and 1'),
    creditRate: z.number().min(0).max(1, 'Credit rate must be between 0 and 1'),
    amexRate: z.number().min(0).max(1, 'Amex rate must be between 0 and 1'),
    internationalRate: z.number().min(0).max(1, 'International rate must be between 0 and 1'),
    fixedFeePerTransaction: z.number().min(0).optional(),
    monthlyServiceFee: z.number().min(0).optional(),
    minimumMonthlyVolume: z.number().min(0).optional(),
    volumePenalty: z.number().min(0).optional(),
    effectiveFrom: z.string().min(1, 'Effective from date is required'),
    effectiveTo: z.string().optional(),
    contractReference: z.string().optional(),
    notes: z.string().optional(),
  }),
})

/**
 * Schema for updating monthly profit status
 */
export const updateMonthlyProfitStatusSchema = z.object({
  params: z.object({
    monthlyProfitId: z.string().min(1, 'Monthly profit ID is required'),
  }),
  body: z.object({
    status: z.nativeEnum(ProfitStatus),
    notes: z.string().optional(),
  }),
})

/**
 * Schema for export profit data request
 */
export const exportProfitDataQuerySchema = z.object({
  query: z.object({
    startDate: z.string().min(1, 'Start date is required'),
    endDate: z.string().min(1, 'End date is required'),
    format: z.enum(['csv', 'xlsx']).default('csv'),
    includeTransactionDetails: z
      .string()
      .transform(val => val === 'true')
      .optional(),
  }),
})

// ===== ENHANCED VENUE CREATION SCHEMA =====

/**
 * Enhanced venue creation schema with payment processing and pricing
 */
export const enhancedCreateVenueSchema = z.object({
  body: z.object({
    // Basic venue information
    name: z.string().min(1, 'Venue name is required'),
    type: z.string().min(1, 'Venue type is required'),
    logo: z.string().url('Logo must be a valid URL').optional().nullable(),
    address: z.string().min(1, 'Address is required'),
    city: z.string().min(1, 'City is required'),
    state: z.string().min(1, 'State is required'),
    country: z.string().default('MX'),
    zipCode: z.string().min(1, 'ZIP code is required'),
    phone: z.string().min(1, 'Phone number is required'),
    email: z.string().email('Valid email is required'),
    website: z.string().url().optional(),

    // Payment configuration
    enablePaymentProcessing: z.boolean().default(true),
    primaryAccountId: z.string().optional(),
    secondaryAccountId: z.string().optional(),
    tertiaryAccountId: z.string().optional(),
    routingRules: z.any().optional(), // JSON object for routing rules

    // Pricing configuration
    setupPricingStructure: z.boolean().default(true),
    pricingTier: z.enum(['STANDARD', 'PREMIUM', 'ENTERPRISE', 'CUSTOM']).default('STANDARD'),
    debitRate: z.number().min(0).max(1).optional(),
    creditRate: z.number().min(0).max(1).optional(),
    amexRate: z.number().min(0).max(1).optional(),
    internationalRate: z.number().min(0).max(1).optional(),
    fixedFeePerTransaction: z.number().min(0).optional(),
    monthlyServiceFee: z.number().min(0).optional(),
    minimumMonthlyVolume: z.number().min(0).optional(),

    // Business configuration
    currency: z.string().default('MXN'),
    timezone: z.string().default('America/Mexico_City'),
    businessType: z.string().default('RESTAURANT'),

    // User context
    userId: z.string().optional(),
  }),
})

// ===== TYPE EXPORTS =====

export type ProfitMetricsQuery = z.infer<typeof profitMetricsQuerySchema>['query']
export type MonthlyProfitsQuery = z.infer<typeof monthlyProfitsQuerySchema>['query']
export type TransactionCostsQuery = z.infer<typeof transactionCostsQuerySchema>['query']
export type RecalculateProfitsBody = z.infer<typeof recalculateProfitsSchema>['body']
export type ProviderCostStructureBody = z.infer<typeof providerCostStructureSchema>['body']
export type VenuePricingStructureBody = z.infer<typeof venuePricingStructureSchema>['body']
export type UpdateMonthlyProfitStatusBody = z.infer<typeof updateMonthlyProfitStatusSchema>['body']
export type ExportProfitDataQuery = z.infer<typeof exportProfitDataQuerySchema>['query']
export type EnhancedCreateVenueBody = z.infer<typeof enhancedCreateVenueSchema>['body']
