import { z } from 'zod'
import { TransactionCardType, AccountType, ProfitStatus } from '@prisma/client'
import { zTimezone } from '@/utils/sanitizeTimezone'

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
    startDate: z.string().min(1, 'La fecha de inicio es obligatoria'),
    endDate: z.string().min(1, 'La fecha de fin es obligatoria'),
    venueId: z.string().optional(),
  }),
})

/**
 * Schema for provider cost structure creation/update
 */
export const providerCostStructureSchema = z.object({
  body: z.object({
    providerId: z.string().min(1, 'El proveedor es obligatorio'),
    merchantAccountId: z.string().min(1, 'La cuenta de comercio es obligatoria'),
    debitRate: z.number().min(0).max(1, 'La tasa de débito debe estar entre 0 y 1'),
    creditRate: z.number().min(0).max(1, 'La tasa de crédito debe estar entre 0 y 1'),
    amexRate: z.number().min(0).max(1, 'La tasa de American Express debe estar entre 0 y 1'),
    internationalRate: z.number().min(0).max(1, 'La tasa internacional debe estar entre 0 y 1'),
    // includesTax: false → tasa base, calc agrega IVA. true → tasa final.
    // null/undefined → legacy (no se aplica tax al calc).
    includesTax: z.boolean().nullable().optional(),
    taxRate: z.number().min(0).max(1).optional(),
    fixedCostPerTransaction: z.number().min(0).optional(),
    monthlyFee: z.number().min(0).optional(),
    minimumVolume: z.number().min(0).optional(),
    volumeDiscount: z.number().min(0).max(1).optional(),
    effectiveFrom: z.string().min(1, 'La fecha de inicio de vigencia es obligatoria'),
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
    venueId: z.string().min(1, 'El ID del negocio es obligatorio'),
    accountType: z.nativeEnum(AccountType),
    debitRate: z.number().min(0).max(1, 'La tasa de débito debe estar entre 0 y 1'),
    creditRate: z.number().min(0).max(1, 'La tasa de crédito debe estar entre 0 y 1'),
    amexRate: z.number().min(0).max(1, 'La tasa de American Express debe estar entre 0 y 1'),
    internationalRate: z.number().min(0).max(1, 'La tasa internacional debe estar entre 0 y 1'),
    includesTax: z.boolean().nullable().optional(),
    taxRate: z.number().min(0).max(1).optional(),
    fixedFeePerTransaction: z.number().min(0).optional(),
    monthlyServiceFee: z.number().min(0).optional(),
    minimumMonthlyVolume: z.number().min(0).optional(),
    volumePenalty: z.number().min(0).optional(),
    effectiveFrom: z.string().min(1, 'La fecha de inicio de vigencia es obligatoria'),
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
    monthlyProfitId: z.string().min(1, 'El ID de la utilidad mensual es obligatorio'),
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
    startDate: z.string().min(1, 'La fecha de inicio es obligatoria'),
    endDate: z.string().min(1, 'La fecha de fin es obligatoria'),
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
    name: z.string().min(1, 'El nombre del negocio es obligatorio'),
    type: z.string().min(1, 'El tipo de negocio es obligatorio'),
    logo: z.string().url('El logo debe ser una dirección web válida').optional().nullable(),
    address: z.string().min(1, 'La dirección es obligatoria'),
    city: z.string().min(1, 'La ciudad es obligatoria'),
    state: z.string().min(1, 'El estado es obligatorio'),
    country: z.string().default('MX'),
    zipCode: z.string().min(1, 'El código postal es obligatorio'),
    phone: z.string().min(1, 'El teléfono es obligatorio'),
    email: z.string().email('Escribe un correo electrónico válido'),
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
    includesTax: z.boolean().nullable().optional(),
    taxRate: z.number().min(0).max(1).optional(),
    fixedFeePerTransaction: z.number().min(0).optional(),
    monthlyServiceFee: z.number().min(0).optional(),
    minimumMonthlyVolume: z.number().min(0).optional(),

    // Business configuration
    currency: z.string().default('MXN'),
    timezone: zTimezone,
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
