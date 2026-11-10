/**
 * Modifier Inventory Analytics Schema
 *
 * Zod validation schemas for modifier inventory analytics endpoints.
 */

import { z } from 'zod'
import { existingId } from '../common/existingId.schema'

// Shared venue param validation
const venueIdParam = z.object({
  venueId: z.string().cuid('El ID del negocio no es válido'),
})

// Date string validation (ISO 8601)
const isoDateString = z
  .string()
  .refine(
    val => {
      const date = new Date(val)
      return !isNaN(date.getTime())
    },
    { message: 'Formato de fecha inválido. Usa el formato ISO 8601, por ejemplo 2024-01-15T00:00:00.000Z' },
  )
  .transform(val => new Date(val))

/**
 * GET /venues/:venueId/modifiers/inventory/usage
 * Query modifier usage statistics
 */
export const GetModifierUsageStatsSchema = z.object({
  params: venueIdParam,
  query: z.object({
    startDate: isoDateString.optional(),
    endDate: isoDateString.optional(),
    modifierGroupId: existingId('El ID del grupo de extras no es válido').optional(),
    limit: z
      .string()
      .optional()
      .transform(val => (val ? parseInt(val, 10) : 50))
      .refine(val => val >= 1 && val <= 500, {
        message: 'El límite debe estar entre 1 y 500',
      }),
  }),
})
export type GetModifierUsageStatsDto = z.infer<typeof GetModifierUsageStatsSchema>

/**
 * GET /venues/:venueId/modifiers/inventory/low-stock
 * Get modifiers with low stock alerts
 */
export const GetModifiersLowStockSchema = z.object({
  params: venueIdParam,
})
export type GetModifiersLowStockDto = z.infer<typeof GetModifiersLowStockSchema>

/**
 * GET /venues/:venueId/modifiers/inventory/summary
 * Get comprehensive modifier inventory summary
 */
export const GetModifierInventorySummarySchema = z.object({
  params: venueIdParam,
  query: z.object({
    startDate: isoDateString.optional(),
    endDate: isoDateString.optional(),
  }),
})
export type GetModifierInventorySummaryDto = z.infer<typeof GetModifierInventorySummarySchema>

/**
 * GET /venues/:venueId/modifiers/inventory/list
 * Get all modifiers with inventory configuration
 */
export const GetModifiersWithInventorySchema = z.object({
  params: venueIdParam,
  query: z.object({
    groupId: existingId('El ID del grupo de extras no es válido').optional(),
    includeInactive: z
      .string()
      .optional()
      .transform(val => val === 'true'),
  }),
})
export type GetModifiersWithInventoryDto = z.infer<typeof GetModifiersWithInventorySchema>
