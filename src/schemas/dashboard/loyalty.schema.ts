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
    pointsPerDollar: z.number().min(0, 'Los puntos por cada $1 gastado no pueden ser negativos').optional(),
    // D7 (5-nov): el panel y el servicio usan estos nombres; sin ellos `validateRequest` los borraba y el panel respondía 200 sin guardar
    // (prender o apagar el programa, el bono, el mínimo para canjear, la caducidad). Los nombres de abajo (`enabled`,
    // `minRedemptionPoints`, `pointsExpirationDays`) se quedan aceptados: ningún cliente los manda hoy y el servicio no los lee.
    active: z.boolean({ invalid_type_error: 'Activo debe ser verdadero o falso' }).optional(),
    pointsPerVisit: z.number().int('Los puntos por visita son enteros').min(0, 'Los puntos por visita no pueden ser negativos').optional(),
    minPointsRedeem: z
      .number()
      .int('El mínimo para canjear se cuenta en puntos enteros')
      .min(0, 'El mínimo para canjear no puede ser negativo')
      .optional(),
    pointsExpireDays: z
      .number()
      .int('La caducidad se cuenta en días enteros')
      .min(0, 'La caducidad no puede ser negativa')
      .nullable()
      .optional(), // null = los puntos no caducan
    minPurchaseAmount: z.number().min(0, 'La compra mínima no puede ser negativa').optional(),
    redemptionRate: z.number().min(0, 'La tasa de canje no puede ser negativa').optional(),
    minRedemptionPoints: z.number().int().min(0, 'El mínimo de puntos para canjear no puede ser negativo').optional(),
    maxRedemptionPercentage: z
      .number()
      .min(0, 'El porcentaje máximo de canje no puede ser menor a 0')
      .max(100, 'El porcentaje máximo de canje no puede ser mayor a 100')
      .optional(),
    pointsExpirationDays: z.number().int().min(0, 'Los días hasta que expiran los puntos no pueden ser negativos').optional(),
    enabled: z.boolean().optional(),

    // ── Programa de sellos (la tarjeta de la cartera) ────────────────────────
    // Sin estas líneas `validateRequest` borra los campos antes del servicio y la
    // pantalla queda muerta con un 200 mentiroso. Los rangos duros (cartilla de 2 a
    // 50, premio coherente con su tipo, producto del mismo venue) viven en
    // `updateLoyaltyConfig`, que es por donde también entra el MCP.
    stampsEnabled: z.boolean().optional(),
    stampsRequired: z.number().int('La cartilla se cuenta en sellos enteros').min(2).max(50).optional(),
    maxStampsPerDay: z
      .number()
      .int('El tope diario se cuenta en sellos enteros')
      .min(0, 'El tope diario no puede ser negativo (0 = sin límite)')
      .optional(),
    stampRewardType: z
      .enum(['FREE_PRODUCT', 'FIXED_AMOUNT', 'PERCENTAGE'], {
        errorMap: () => ({ message: 'Tipo de premio inválido: FREE_PRODUCT, FIXED_AMOUNT o PERCENTAGE' }),
      })
      .optional(),
    stampRewardValue: z.number().min(0, 'El valor del premio no puede ser negativo').nullable().optional(),
    stampRewardProductId: z.string().nullable().optional(),
    stampRewardLabel: z.string().min(1).max(60, 'La etiqueta del premio no cabe en la tarjeta').optional(),
  }),
})

/**
 * Calculate Points for Amount Schema
 */
export const CalculatePointsSchema = z.object({
  body: z.object({
    amount: z.number().positive('El monto debe ser mayor a cero'),
  }),
})

/**
 * Calculate Discount from Points Schema
 */
export const CalculateDiscountSchema = z.object({
  body: z.object({
    points: z.number().int().positive('Los puntos deben ser mayores a cero'),
    orderTotal: z.number().positive('El total de la orden debe ser mayor a cero'),
  }),
})

/**
 * Redeem Points Schema
 */
export const RedeemPointsSchema = z.object({
  body: z.object({
    points: z.number().int().positive('Los puntos deben ser mayores a cero'),
    orderId: z.string().cuid('El ID de la orden no es válido'),
  }),
})

/**
 * Adjust Points Schema (Manual adjustment by staff)
 */
export const AdjustPointsSchema = z.object({
  body: z.object({
    points: z.number().int('Los puntos deben ser un número entero'),
    reason: z.string().min(5, 'El motivo debe tener al menos 5 caracteres').max(500, 'El motivo admite hasta 500 caracteres'),
  }),
})

/**
 * Ajuste manual de sellos: `stampsEarned` es el TOTAL que debe quedar (no un +/−) y los cuatro `expected*` son lo que vio
 * quien pide el ajuste (el CAS contra otro aparato o una venta que cambió la cartilla). `.strict()` para que un campo
 * desconocido se rechace en vez de borrarse en silencio.
 */
export const AdjustStampsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('El ID del negocio no es válido'),
    customerId: z.string().cuid('El ID del cliente no es válido'),
  }),
  body: z
    .object({
      stampsEarned: z
        .number()
        .int('Los sellos deben ser un número entero')
        .min(0, 'Los sellos no pueden ser negativos')
        .max(100, 'Máximo 100 sellos'),
      expectedStampCardId: z.string().cuid('La cartilla no es válida').nullable(),
      expectedStampsEarned: z.number().int().min(0),
      expectedVersion: z.number().int().min(0),
      // La meta que vio quien pide (F1): sin ella, un cliente sin cartilla («null/0/0») no ve que cambió la meta.
      expectedStampsRequired: z.number().int().min(1),
      reason: z
        .string()
        .trim()
        .min(5, 'El motivo debe tener al menos 5 caracteres')
        .max(500, 'El motivo debe tener menos de 500 caracteres'),
    })
    .strict(),
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
    venueId: z.string().cuid('El ID del negocio no es válido'),
    customerId: z.string().cuid('El ID del cliente no es válido'),
  }),
})

/**
 * Venue-only params
 */
export const LoyaltyVenueParamsSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('El ID del negocio no es válido'),
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

/**
 * Canje de un premio de cartilla. 🔴 DINERO: baja lo que el cliente paga.
 */
export const RedeemStampRewardSchema = z.object({
  params: z.object({
    venueId: z.string().cuid('El identificador del negocio no es válido'),
    rewardId: z.string().cuid('El identificador del premio no es válido'),
  }),
  body: z
    .object({
      orderId: z.string().cuid('El identificador de la cuenta no es válido'),
    })
    .strict('Hay un campo que no pertenece al canje'),
})
