/**
 * Loyalty Program Zod Validation Schemas
 *
 * WHY: Type-safe request validation for loyalty program management.
 *
 * PATTERN: Zod schemas → Controllers validate → Services execute
 */

import { z } from 'zod'
import { LoyaltyTransactionType } from '@prisma/client'

/**
 * Update Loyalty Config Schema
 */
export const UpdateLoyaltyConfigSchema = z.object({
  body: z.object({
    pointsPerDollar: z.number().min(0, 'Points per dollar must be non-negative').optional(),
    minPurchaseAmount: z.number().min(0, 'Minimum purchase amount must be non-negative').optional(),
    redemptionRate: z.number().min(0, 'Redemption rate must be non-negative').optional(),
    minRedemptionPoints: z.number().int().min(0, 'Minimum redemption points must be non-negative').optional(),
    maxRedemptionPercentage: z
      .number()
      .min(0, 'Maximum redemption percentage must be at least 0')
      .max(100, 'Maximum redemption percentage cannot exceed 100')
      .optional(),
    pointsExpirationDays: z.number().int().min(0, 'Points expiration days must be non-negative').optional(),
    enabled: z.boolean().optional(),
  }),
})

/**
 * Calculate Points for Amount Schema
 */
export const CalculatePointsSchema = z.object({
  body: z.object({
    amount: z.number().positive('Amount must be positive'),
  }),
})

/**
 * Calculate Discount from Points Schema
 */
export const CalculateDiscountSchema = z.object({
  body: z.object({
    points: z.number().int().positive('Points must be positive'),
    orderTotal: z.number().positive('Order total must be positive'),
  }),
})

/**
 * Redeem Points Schema
 */
export const RedeemPointsSchema = z.object({
  body: z.object({
    points: z.number().int().positive('Points must be positive'),
    orderId: z.string().cuid('Invalid order ID format'),
  }),
})

/**
 * Adjust Points Schema (Manual adjustment by staff)
 */
export const AdjustPointsSchema = z.object({
  body: z.object({
    points: z.number().int('Points must be an integer'),
    reason: z.string().min(5, 'Reason must be at least 5 characters').max(500, 'Reason must be less than 500 characters'),
  }),
})

/**
 * Loyalty Transactions Query Parameters
 */
export const LoyaltyTransactionsQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().optional(),
    pageSize: z.coerce.number().int().positive().max(100).optional(),
    type: z.nativeEnum(LoyaltyTransactionType).optional(),
  }),
})

/**
 * Route Parameters for loyalty operations
 */
export const LoyaltyParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
    customerId: z.string().cuid('Invalid customer ID format'),
  }),
})

/**
 * Venue-only params
 */
export const LoyaltyVenueParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('Invalid venue ID format'),
  }),
})

/**
 * TypeScript types inferred from schemas
 */
export type UpdateLoyaltyConfigInput = z.infer<typeof UpdateLoyaltyConfigSchema>['body']
export type CalculatePointsInput = z.infer<typeof CalculatePointsSchema>['body']
export type CalculateDiscountInput = z.infer<typeof CalculateDiscountSchema>['body']
export type RedeemPointsInput = z.infer<typeof RedeemPointsSchema>['body']
export type AdjustPointsInput = z.infer<typeof AdjustPointsSchema>['body']
export type LoyaltyTransactionsQuery = z.infer<typeof LoyaltyTransactionsQuerySchema>['query']

/**
 * Diseño de la credencial del cliente (Apple/Google Wallet).
 *
 * 🔴 Los colores se validan aquí Y en el servicio, y no es duplicación ociosa: por
 * esta puerta entra el dashboard, pero el servicio también lo llaman el MCP y los
 * scripts. Un color mal formado no revienta — Apple lo ignora y pinta la tarjeta
 * gris, semanas después, en el iPhone de un cliente.
 */
const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'El color debe venir como #RRGGBB, por ejemplo #7ADD2C')

export const CardDesignUpdateSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('El identificador del negocio no es válido'),
  }),
  // 🔴 `.strict()`: un campo desconocido se rechaza en vez de ignorarse. Sin esto,
  // un `venueId` en el cuerpo pasaría al upsert y reescribiría a qué negocio
  // pertenece el diseño.
  body: z
    .object({
      logoUrl: z.string().url('El logo debe ser una URL válida').nullable().optional(),
      iconUrl: z.string().url('El icono debe ser una URL válida').nullable().optional(),
      stampImageUrl: z.string().url('El sello debe ser una URL válida').nullable().optional(),
      backgroundColor: hexColorSchema.optional(),
      textColor: hexColorSchema.optional(),
      labelColor: hexColorSchema.optional(),
      stripColor: hexColorSchema.optional(),
      stampFilledColor: hexColorSchema.optional(),
      // Null es válido y significa "derívalo del color del sello lleno".
      stampEmptyColor: hexColorSchema.nullable().optional(),
      stampShape: z
        .enum(['CIRCLE', 'STAR', 'HEART', 'SQUARE'], {
          errorMap: () => ({ message: 'La forma del sello debe ser CIRCLE, STAR, HEART o SQUARE' }),
        })
        .optional(),
    })
    .strict('Hay un campo que no pertenece al diseño de la tarjeta'),
})
