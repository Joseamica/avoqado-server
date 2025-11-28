/**
 * Discount Zod Schemas
 *
 * Request/response validation schemas for discount management endpoints.
 *
 * @see src/services/dashboard/discount.dashboard.service.ts
 */

import { z } from 'zod'

// ==========================================
// ENUMS
// ==========================================

export const DiscountTypeSchema = z.enum(['PERCENTAGE', 'FIXED_AMOUNT', 'COMP'])
export const DiscountScopeSchema = z.enum(['ORDER', 'ITEM', 'CATEGORY', 'MODIFIER', 'MODIFIER_GROUP', 'CUSTOMER_GROUP', 'QUANTITY'])

// ==========================================
// QUERY SCHEMAS
// ==========================================

export const getDiscountsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  type: DiscountTypeSchema.optional(),
  scope: DiscountScopeSchema.optional(),
  isAutomatic: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform(val => (val === true || val === 'true' ? true : val === false || val === 'false' ? false : undefined)),
  active: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform(val => (val === true || val === 'true' ? true : val === false || val === 'false' ? false : undefined)),
})

// ==========================================
// CREATE SCHEMAS
// ==========================================

export const createDiscountBodySchema = z
  .object({
    name: z.string().min(1, 'Name is required').max(100, 'Name too long'),
    description: z.string().max(500, 'Description too long').optional(),
    type: DiscountTypeSchema,
    value: z.number().min(0, 'Value must be positive'),
    scope: DiscountScopeSchema.default('ORDER'),

    // Target IDs
    targetItemIds: z.array(z.string()).optional(),
    targetCategoryIds: z.array(z.string()).optional(),
    targetModifierIds: z.array(z.string()).optional(),
    targetModifierGroupIds: z.array(z.string()).optional(),
    customerGroupId: z.string().optional(),

    // Automatic application
    isAutomatic: z.boolean().default(false),
    priority: z.number().int().min(0).default(0),

    // Rules
    minPurchaseAmount: z.number().min(0).optional(),
    maxDiscountAmount: z.number().min(0).optional(),
    minQuantity: z.number().int().min(1).optional(),

    // BOGO
    buyQuantity: z.number().int().min(1).optional(),
    getQuantity: z.number().int().min(1).optional(),
    getDiscountPercent: z.number().min(0).max(100).optional(),
    buyItemIds: z.array(z.string()).optional(),
    getItemIds: z.array(z.string()).optional(),

    // Time-based
    validFrom: z.coerce.date().optional(),
    validUntil: z.coerce.date().optional(),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
    timeFrom: z
      .string()
      .regex(/^\d{2}:\d{2}$/, 'Time format must be HH:MM')
      .optional(),
    timeUntil: z
      .string()
      .regex(/^\d{2}:\d{2}$/, 'Time format must be HH:MM')
      .optional(),

    // Usage limits
    maxTotalUses: z.number().int().min(1).optional(),
    maxUsesPerCustomer: z.number().int().min(1).optional(),

    // Comp-specific
    requiresApproval: z.boolean().default(false),
    compReason: z.string().max(500).optional(),

    // Tax handling
    applyBeforeTax: z.boolean().default(true),
    modifyTaxBasis: z.boolean().default(true),

    // Stacking
    isStackable: z.boolean().default(false),
    stackPriority: z.number().int().min(0).default(0),

    // Status
    active: z.boolean().default(true),
  })
  .refine(
    data => {
      // Validate percentage is 0-100
      if (data.type === 'PERCENTAGE' && data.value > 100) {
        return false
      }
      return true
    },
    { message: 'Percentage discount value must be between 0 and 100' },
  )
  .refine(
    data => {
      // Validate BOGO configuration
      if (data.scope === 'QUANTITY' || data.buyQuantity || data.getQuantity) {
        return data.buyQuantity && data.getQuantity
      }
      return true
    },
    { message: 'BOGO discounts require both buyQuantity and getQuantity' },
  )
  .refine(
    data => {
      // Validate time range
      if ((data.timeFrom && !data.timeUntil) || (!data.timeFrom && data.timeUntil)) {
        return false
      }
      return true
    },
    { message: 'Both timeFrom and timeUntil must be provided together' },
  )
  .refine(
    data => {
      // Validate date range
      if (data.validFrom && data.validUntil && data.validFrom > data.validUntil) {
        return false
      }
      return true
    },
    { message: 'validFrom must be before validUntil' },
  )

// ==========================================
// UPDATE SCHEMAS
// ==========================================

export const updateDiscountBodySchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name too long').optional(),
  description: z.string().max(500, 'Description too long').optional().nullable(),
  type: DiscountTypeSchema.optional(),
  value: z.number().min(0, 'Value must be positive').optional(),
  scope: DiscountScopeSchema.optional(),

  // Target IDs
  targetItemIds: z.array(z.string()).optional(),
  targetCategoryIds: z.array(z.string()).optional(),
  targetModifierIds: z.array(z.string()).optional(),
  targetModifierGroupIds: z.array(z.string()).optional(),
  customerGroupId: z.string().optional().nullable(),

  // Automatic application
  isAutomatic: z.boolean().optional(),
  priority: z.number().int().min(0).optional(),

  // Rules
  minPurchaseAmount: z.number().min(0).optional().nullable(),
  maxDiscountAmount: z.number().min(0).optional().nullable(),
  minQuantity: z.number().int().min(1).optional().nullable(),

  // BOGO
  buyQuantity: z.number().int().min(1).optional().nullable(),
  getQuantity: z.number().int().min(1).optional().nullable(),
  getDiscountPercent: z.number().min(0).max(100).optional().nullable(),
  buyItemIds: z.array(z.string()).optional(),
  getItemIds: z.array(z.string()).optional(),

  // Time-based
  validFrom: z.coerce.date().optional().nullable(),
  validUntil: z.coerce.date().optional().nullable(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
  timeFrom: z
    .string()
    .regex(/^\d{2}:\d{2}$/, 'Time format must be HH:MM')
    .optional()
    .nullable(),
  timeUntil: z
    .string()
    .regex(/^\d{2}:\d{2}$/, 'Time format must be HH:MM')
    .optional()
    .nullable(),

  // Usage limits
  maxTotalUses: z.number().int().min(1).optional().nullable(),
  maxUsesPerCustomer: z.number().int().min(1).optional().nullable(),

  // Comp-specific
  requiresApproval: z.boolean().optional(),
  compReason: z.string().max(500).optional().nullable(),

  // Tax handling
  applyBeforeTax: z.boolean().optional(),
  modifyTaxBasis: z.boolean().optional(),

  // Stacking
  isStackable: z.boolean().optional(),
  stackPriority: z.number().int().min(0).optional(),

  // Status
  active: z.boolean().optional(),
})

// ==========================================
// CUSTOMER DISCOUNT SCHEMAS
// ==========================================

export const assignDiscountToCustomerBodySchema = z.object({
  customerId: z.string().min(1, 'Customer ID is required'),
  validFrom: z.coerce.date().optional(),
  validUntil: z.coerce.date().optional(),
  maxUses: z.number().int().min(1).optional(),
})

export const removeDiscountFromCustomerParamsSchema = z.object({
  venueId: z.string().min(1),
  discountId: z.string().min(1),
  customerId: z.string().min(1),
})

// ==========================================
// COMMON PARAM SCHEMAS
// ==========================================

export const discountParamsSchema = z.object({
  venueId: z.string().min(1, 'Venue ID is required'),
  discountId: z.string().min(1, 'Discount ID is required'),
})

export const venueParamsSchema = z.object({
  venueId: z.string().min(1, 'Venue ID is required'),
})

// ==========================================
// TYPE EXPORTS
// ==========================================

export type GetDiscountsQuery = z.infer<typeof getDiscountsQuerySchema>
export type CreateDiscountBody = z.infer<typeof createDiscountBodySchema>
export type UpdateDiscountBody = z.infer<typeof updateDiscountBodySchema>
export type AssignDiscountToCustomerBody = z.infer<typeof assignDiscountToCustomerBodySchema>
