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

// Codex r1 #3: los números sin mensaje salían con el de Zod en inglés.
// D24 (5-nov): `validateRequest` ya no antepone el campo, así que cada número dice cuál es (frases sin género).
const Numero = (q: string) => z.number({ invalid_type_error: `${q} debe ser un número`, required_error: `Falta: ${q.toLowerCase()}` })
const enteroDesde = (n: number, q: string) => Numero(q).int(`${q} debe ser un número entero`).min(n, `${q} debe ser ${n} o más`)
const NoNegativo = (q: string) => Numero(q).min(0, `${q} debe ser 0 o más`)
// D14 v2: los límites de uso sólo validan la forma; 0, negativos y lo guardado los decide validarCambioDeDescuento.
const Limite = (q: string) => Numero(q).int(`${q} debe ser un número entero`)

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
    maxUses: Limite('El límite de usos').optional(),
    maxUsesPerCustomer: Limite('El límite de usos por cliente').optional(),
    minPurchaseAmount: NoNegativo('La compra mínima').optional(),
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
  // null = sin límite
  maxUses: Limite('El límite de usos').optional().nullable(),
  maxUsesPerCustomer: Limite('El límite de usos por cliente').optional().nullable(),
  minPurchaseAmount: NoNegativo('La compra mínima').optional().nullable(),
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
  quantity: enteroDesde(1, 'La cantidad').min(1, 'La cantidad debe ser al menos 1').max(1000, 'La cantidad puede ser hasta 1000'),
  codeLength: enteroDesde(4, 'El largo del código').max(20, 'El largo del código puede ser hasta 20').default(8),
  maxUsesPerCode: Limite('El límite de usos por código').optional(),
  maxUsesPerCustomer: Limite('El límite de usos por cliente').optional(),
  validFrom: z.coerce.date().optional(),
  validUntil: z.coerce.date().optional(),
})

// ==========================================
// VALIDATION SCHEMA
// ==========================================

export const validateCouponBodySchema = z.object({
  code: z.string().min(1, 'Escribe el código'),
  orderTotal: NoNegativo('El total de la cuenta').optional(),
  customerId: z.string().optional(),
})

// ==========================================
// REDEMPTION SCHEMA
// ==========================================

export const recordRedemptionBodySchema = z.object({
  orderId: z.string().min(1, 'El ID de la orden es obligatorio'),
  amountSaved: z.number().min(0, 'El monto ahorrado no puede ser negativo'),
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
