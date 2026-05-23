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
  active: z.boolean().default(true),
  notes: z.string().optional(),
})

export const updateMerchantRevenueShareSchema = createMerchantRevenueShareSchema.partial().omit({ merchantAccountId: true })

export type CreateMerchantRevenueShareInput = z.infer<typeof createMerchantRevenueShareSchema>
export type UpdateMerchantRevenueShareInput = z.infer<typeof updateMerchantRevenueShareSchema>
