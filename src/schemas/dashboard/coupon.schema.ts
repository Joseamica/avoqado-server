/**
 * Coupon Zod Schemas
 *
 * Request/response validation schemas for coupon management endpoints.
 *
 * @see src/services/dashboard/coupon.dashboard.service.ts
 */

import { z } from 'zod'

// ==========================================
// QUERY SCHEMAS
// ==========================================

export const getCouponsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  discountId: z.string().optional(),
  active: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform(val => (val === true || val === 'true' ? true : val === false || val === 'false' ? false : undefined)),
})

export const getRedemptionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  couponId: z.string().optional(),
  customerId: z.string().optional(),
})

// ==========================================
// CREATE SCHEMAS
// ==========================================

export const createCouponBodySchema = z
  .object({
    discountId: z.string().min(1, 'Elige el descuento del cupón'),
    code: z
      .string()
      .min(3, 'El código debe tener al menos 3 caracteres')
      .max(30, 'El código puede tener hasta 30 caracteres')
      .regex(/^[A-Za-z0-9-_]+$/, 'El código sólo puede tener letras, números, guiones y guiones bajos'),
    maxUses: z.number().int().min(1).optional(),
    maxUsesPerCustomer: z.number().int().min(1).optional(),
    minPurchaseAmount: z.number().min(0).optional(),
    validFrom: z.coerce.date().optional(),
    validUntil: z.coerce.date().optional(),
    active: z.boolean().default(true),
  })
  .refine(
    data => {
      // Validate date range
      if (data.validFrom && data.validUntil && data.validFrom > data.validUntil) {
        return false
      }
      return true
    },
    { message: 'La fecha de inicio debe ser antes de la fecha de fin' },
  )

// ==========================================
// UPDATE SCHEMAS
// ==========================================

export const updateCouponBodySchema = z.object({
  code: z
    .string()
    .min(3, 'El código debe tener al menos 3 caracteres')
    .max(30, 'El código puede tener hasta 30 caracteres')
    .regex(/^[A-Za-z0-9-_]+$/, 'El código sólo puede tener letras, números, guiones y guiones bajos')
    .optional(),
  maxUses: z.number().int().min(1).optional().nullable(),
  maxUsesPerCustomer: z.number().int().min(1).optional().nullable(),
  minPurchaseAmount: z.number().min(0).optional().nullable(),
  validFrom: z.coerce.date().optional().nullable(),
  validUntil: z.coerce.date().optional().nullable(),
  active: z.boolean().optional(),
})

// ==========================================
// BULK GENERATE SCHEMA
// ==========================================

export const bulkGenerateCouponsBodySchema = z.object({
  discountId: z.string().min(1, 'Elige el descuento del cupón'),
  prefix: z
    .string()
    .max(10, 'El prefijo puede tener hasta 10 caracteres')
    .regex(/^[A-Za-z0-9-_]*$/, 'El prefijo sólo puede tener letras, números, guiones y guiones bajos')
    .optional(),
  quantity: z.number().int().min(1, 'La cantidad debe ser al menos 1').max(1000, 'La cantidad puede ser hasta 1000'),
  codeLength: z.number().int().min(4).max(20).default(8),
  maxUsesPerCode: z.number().int().min(1).optional(),
  maxUsesPerCustomer: z.number().int().min(1).optional(),
  validFrom: z.coerce.date().optional(),
  validUntil: z.coerce.date().optional(),
})

// ==========================================
// VALIDATION SCHEMA
// ==========================================

export const validateCouponBodySchema = z.object({
  code: z.string().min(1, 'Code is required'),
  orderTotal: z.number().min(0).optional(),
  customerId: z.string().optional(),
})

// ==========================================
// REDEMPTION SCHEMA
// ==========================================

export const recordRedemptionBodySchema = z.object({
  orderId: z.string().min(1, 'Order ID is required'),
  amountSaved: z.number().min(0, 'Amount saved must be positive'),
  customerId: z.string().optional(),
})

// ==========================================
// COMMON PARAM SCHEMAS
// ==========================================

export const couponParamsSchema = z.object({
  venueId: z.string().min(1, 'Falta el negocio'),
  couponId: z.string().min(1, 'Falta el cupón'),
})

export const venueParamsSchema = z.object({
  venueId: z.string().min(1, 'Falta el negocio'),
})

// ==========================================
// TYPE EXPORTS
// ==========================================

export type GetCouponsQuery = z.infer<typeof getCouponsQuerySchema>
export type GetRedemptionsQuery = z.infer<typeof getRedemptionsQuerySchema>
export type CreateCouponBody = z.infer<typeof createCouponBodySchema>
export type UpdateCouponBody = z.infer<typeof updateCouponBodySchema>
export type BulkGenerateCouponsBody = z.infer<typeof bulkGenerateCouponsBodySchema>
export type ValidateCouponBody = z.infer<typeof validateCouponBodySchema>
export type RecordRedemptionBody = z.infer<typeof recordRedemptionBodySchema>
