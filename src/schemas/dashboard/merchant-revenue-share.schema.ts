/**
 * Request schemas for the MerchantRevenueShare CRUD endpoints.
 * Mensajes en español — los errores de Zod llegan crudos al dashboard.
 *
 * Spec: docs/superpowers/specs/2026-05-22-revenue-share-fee-model-design.md
 */
import { z } from 'zod'

const cardRates = z.object({
  DEBIT: z.number().min(0, 'La tasa de débito no puede ser negativa').max(1, 'La tasa de débito debe ser ≤ 1'),
  CREDIT: z.number().min(0, 'La tasa de crédito no puede ser negativa').max(1, 'La tasa de crédito debe ser ≤ 1'),
  AMEX: z.number().min(0, 'La tasa AMEX no puede ser negativa').max(1, 'La tasa AMEX debe ser ≤ 1'),
  INTERNATIONAL: z.number().min(0, 'La tasa internacional no puede ser negativa').max(1, 'La tasa internacional debe ser ≤ 1'),
})

export const createMerchantRevenueShareSchema = z.object({
  merchantAccountId: z.string().min(1, 'El merchant es obligatorio'),
  /** `null` o ausente = venta directa (sin agregador). */
  aggregatorPrice: cardRates.nullable().optional(),
  aggregatorPriceIncludesTax: z.boolean().default(false),
  avoqadoShareOfProviderMargin: z
    .number()
    .min(0, 'El share del provider debe ser ≥ 0')
    .max(1, 'El share del provider debe ser ≤ 1')
    .default(0.5),
  avoqadoShareOfAggregatorMargin: z
    .number()
    .min(0, 'El share del agregador debe ser ≥ 0')
    .max(1, 'El share del agregador debe ser ≤ 1')
    .nullable()
    .optional(),
  taxRate: z.number().min(0).max(1).default(0.16),
  intermediaryFeeRate: z
    .number({ invalid_type_error: 'El manejo del intermediario debe ser un número' })
    .finite('El manejo del intermediario debe ser finito')
    .min(0, 'El manejo del intermediario no puede ser negativo')
    .max(1, 'El manejo del intermediario no puede superar el 100%')
    .optional(),
  active: z.boolean().default(true),
  notes: z.string().optional(),
})

export const updateMerchantRevenueShareSchema = createMerchantRevenueShareSchema.partial().omit({ merchantAccountId: true })

export type CreateMerchantRevenueShareInput = z.infer<typeof createMerchantRevenueShareSchema>
export type UpdateMerchantRevenueShareInput = z.infer<typeof updateMerchantRevenueShareSchema>

/** Operación atómica de la consola; los CRUD anteriores conservan su contrato. */
export const saveMerchantEconomicsSchema = z.object({
  costId: z.string().cuid('El costo indicado no es válido').nullable(),
  revenueShareId: z.string().cuid('El reparto indicado no es válido').nullable(),
  cost: z.object({
    debitRate: cardRates.shape.DEBIT,
    creditRate: cardRates.shape.CREDIT,
    amexRate: cardRates.shape.AMEX,
    internationalRate: cardRates.shape.INTERNATIONAL,
    includesTax: z.boolean({ invalid_type_error: 'Indica si el costo incluye IVA', required_error: 'Indica si el costo incluye IVA' }),
    taxRate: z
      .number({ invalid_type_error: 'La tasa de IVA debe ser un número', required_error: 'La tasa de IVA es obligatoria' })
      .min(0, 'La tasa de IVA no puede ser negativa')
      .max(1, 'La tasa de IVA no puede superar el 100%'),
    fixedCostPerTransaction: z
      .number({ invalid_type_error: 'El costo fijo debe ser un número' })
      .finite('El costo fijo debe ser finito')
      .min(0, 'El costo fijo no puede ser negativo')
      .nullable()
      .optional(),
  }),
  revenueShare: createMerchantRevenueShareSchema.omit({ merchantAccountId: true }),
})
export type SaveMerchantEconomicsInput = z.infer<typeof saveMerchantEconomicsSchema>
