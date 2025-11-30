// src/schemas/dashboard/venueSettings.schema.ts

import { z } from 'zod'

/**
 * Schema for TPV settings update
 */
export const UpdateTpvSettingsSchema = z.object({
  params: z.object({
    venueId: z.string().min(1, 'Venue ID is required'),
  }),
  body: z.object({
    showReviewScreen: z.boolean().optional(),
    showTipScreen: z.boolean().optional(),
    showReceiptScreen: z.boolean().optional(),
    defaultTipPercentage: z.number().int().min(0).max(100).nullable().optional(),
  }),
})

export type UpdateTpvSettingsInput = z.infer<typeof UpdateTpvSettingsSchema>

/**
 * Schema for full venue settings update
 */
export const UpdateVenueSettingsSchema = z.object({
  params: z.object({
    venueId: z.string().min(1, 'Venue ID is required'),
  }),
  body: z.object({
    // Operations
    autoCloseShifts: z.boolean().optional(),
    shiftDuration: z.number().int().min(1).max(24).optional(),
    requirePinLogin: z.boolean().optional(),

    // Reviews
    autoReplyReviews: z.boolean().optional(),
    notifyBadReviews: z.boolean().optional(),
    badReviewThreshold: z.number().int().min(1).max(5).optional(),

    // Inventory
    trackInventory: z.boolean().optional(),
    lowStockAlert: z.boolean().optional(),
    lowStockThreshold: z.number().int().min(1).optional(),
    costingMethod: z.enum(['FIFO', 'LIFO', 'AVERAGE']).optional(),

    // Customer features
    allowReservations: z.boolean().optional(),
    allowTakeout: z.boolean().optional(),
    allowDelivery: z.boolean().optional(),

    // Payment
    acceptCash: z.boolean().optional(),
    acceptCard: z.boolean().optional(),
    acceptDigitalWallet: z.boolean().optional(),
    tipSuggestions: z.array(z.number().int().min(0).max(100)).max(6).optional(),
    paymentTiming: z.enum(['PAY_BEFORE', 'PAY_AFTER', 'PAY_AT_TABLE']).optional(),
    inventoryDeduction: z.enum(['ON_ORDER_CREATE', 'ON_PAYMENT_COMPLETE']).optional(),

    // TPV Screen Configuration
    tpvShowReviewScreen: z.boolean().optional(),
    tpvShowTipScreen: z.boolean().optional(),
    tpvShowReceiptScreen: z.boolean().optional(),
    tpvDefaultTipPercentage: z.number().int().min(0).max(100).nullable().optional(),
  }),
})

export type UpdateVenueSettingsInput = z.infer<typeof UpdateVenueSettingsSchema>

/**
 * Response schema for TPV settings
 */
export const TpvSettingsResponseSchema = z.object({
  showReviewScreen: z.boolean(),
  showTipScreen: z.boolean(),
  showReceiptScreen: z.boolean(),
  defaultTipPercentage: z.number().nullable(),
  tipSuggestions: z.array(z.number()),
  requirePinLogin: z.boolean(),
})

export type TpvSettingsResponse = z.infer<typeof TpvSettingsResponseSchema>
