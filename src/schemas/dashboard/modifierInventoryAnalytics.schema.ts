/**
 * Modifier Inventory Analytics Schema
 *
 * Zod validation schemas for modifier inventory analytics endpoints.
 */

import { z } from 'zod'

// Shared venue param validation
const venueIdParam = z.object({
  venueId: z.string().cuid('Invalid venue ID format'),
})

// Date string validation (ISO 8601)
const isoDateString = z
  .string()
  .refine(
    val => {
      const date = new Date(val)
      return !isNaN(date.getTime())
    },
    { message: 'Invalid date format. Use ISO 8601 format (e.g., 2024-01-15T00:00:00.000Z)' },
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
    modifierGroupId: z.string().cuid('Invalid modifier group ID format').optional(),
    limit: z
      .string()
      .optional()
      .transform(val => (val ? parseInt(val, 10) : 50))
      .refine(val => val >= 1 && val <= 500, {
        message: 'Limit must be between 1 and 500',
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
    groupId: z.string().cuid('Invalid modifier group ID format').optional(),
    includeInactive: z
      .string()
      .optional()
      .transform(val => val === 'true'),
  }),
})
export type GetModifiersWithInventoryDto = z.infer<typeof GetModifiersWithInventorySchema>
