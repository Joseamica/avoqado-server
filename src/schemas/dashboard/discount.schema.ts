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

const SIN_CATEGORIAS = 'Elige al menos una categoría para un descuento por categorías'

// Codex r1 #3: los números sin mensaje salían con el de Zod en inglés («Number must be greater than or equal to 1»).
const Numero = z.number({ invalid_type_error: 'Debe ser un número', required_error: 'Falta un número' })
const enteroDesde = (n: number) => Numero.int('Debe ser un número entero').min(n, `Debe ser ${n} o más`)
const NoNegativo = Numero.min(0, 'No puede ser negativo')
const Porcentaje = NoNegativo.max(100, 'Puede ser hasta 100')
const Motivo = z.string().max(500, 'El motivo puede tener hasta 500 caracteres')
const Dias = z.array(enteroDesde(0).max(6, 'El día de la semana va de 0 a 6'))

export const createDiscountBodySchema = z
  .object({
    name: z.string().min(1, 'El nombre es obligatorio').max(100, 'El nombre puede tener hasta 100 caracteres'),
    description: z.string().max(500, 'La descripción puede tener hasta 500 caracteres').optional(),
    type: DiscountTypeSchema,
    value: Numero.min(0, 'El valor del descuento no puede ser negativo'),
    scope: DiscountScopeSchema.default('ORDER'),

    // Target IDs
    targetItemIds: z.array(z.string()).optional(),
    targetCategoryIds: z.array(z.string()).optional(),
    targetModifierIds: z.array(z.string()).optional(),
    targetModifierGroupIds: z.array(z.string()).optional(),
    customerGroupId: z.string().optional(),

    // Automatic application
    isAutomatic: z.boolean().default(false),
    priority: enteroDesde(0).default(0),

    // Rules
    minPurchaseAmount: NoNegativo.optional(),
    maxDiscountAmount: NoNegativo.optional(),
    minQuantity: enteroDesde(1).optional(),

    // BOGO
    buyQuantity: enteroDesde(1).optional(),
    getQuantity: enteroDesde(1).optional(),
    getDiscountPercent: Porcentaje.optional(),
    buyItemIds: z.array(z.string()).optional(),
    getItemIds: z.array(z.string()).optional(),

    // Time-based
    validFrom: z.coerce.date().optional(),
    validUntil: z.coerce.date().optional(),
    daysOfWeek: Dias.optional(),
    timeFrom: z
      .string()
      .regex(/^\d{2}:\d{2}$/, 'La hora debe tener formato HH:MM')
      .optional(),
    timeUntil: z
      .string()
      .regex(/^\d{2}:\d{2}$/, 'La hora debe tener formato HH:MM')
      .optional(),

    // Usage limits
    maxTotalUses: enteroDesde(1).optional(),
    maxUsesPerCustomer: enteroDesde(1).optional(),

    // Comp-specific
    requiresApproval: z.boolean().default(false),
    compReason: Motivo.optional(),

    // Tax handling
    applyBeforeTax: z.boolean().default(true),
    modifyTaxBasis: z.boolean().default(true),

    // Stacking
    isStackable: z.boolean().default(false),
    stackPriority: enteroDesde(0).default(0),

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
    { message: 'El porcentaje del descuento debe estar entre 0 y 100' },
  )
  .refine(
    data => {
      // Validate BOGO configuration
      if (data.scope === 'QUANTITY' || data.buyQuantity || data.getQuantity) {
        return data.buyQuantity && data.getQuantity
      }
      return true
    },
    { message: 'Para «Compra X y lleva Y» indica cuántos se compran y cuántos se llevan' },
  )
  .refine(
    data => {
      // Validate time range
      if ((data.timeFrom && !data.timeUntil) || (!data.timeFrom && data.timeUntil)) {
        return false
      }
      return true
    },
    { message: 'El horario necesita hora de inicio y hora de fin' },
  )
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
  // D14 (5-nov-2026): el panel dejaba guardar «Categorías» sin elegir ninguna. Una lista vacía las apps la leen como
  // «todas» y el motor del panel como «ninguna»: nadie la pidió así.
  .refine(data => data.scope !== 'CATEGORY' || (data.targetCategoryIds?.length ?? 0) > 0, {
    message: SIN_CATEGORIAS, // sin `path`: el 400 sale «Error de validación: Elige…», sin el nombre del campo en inglés
  })

// ==========================================
// UPDATE SCHEMAS
// ==========================================

export const updateDiscountBodySchema = z
  .object({
    name: z.string().min(1, 'El nombre es obligatorio').max(100, 'El nombre puede tener hasta 100 caracteres').optional(),
    description: z.string().max(500, 'La descripción puede tener hasta 500 caracteres').optional().nullable(),
    type: DiscountTypeSchema.optional(),
    value: Numero.min(0, 'El valor del descuento no puede ser negativo').optional(),
    scope: DiscountScopeSchema.optional(),

    // Target IDs
    targetItemIds: z.array(z.string()).optional(),
    targetCategoryIds: z.array(z.string()).optional(),
    targetModifierIds: z.array(z.string()).optional(),
    targetModifierGroupIds: z.array(z.string()).optional(),
    customerGroupId: z.string().optional().nullable(),

    // Automatic application
    isAutomatic: z.boolean().optional(),
    priority: enteroDesde(0).optional(),

    // Rules
    minPurchaseAmount: NoNegativo.optional().nullable(),
    maxDiscountAmount: NoNegativo.optional().nullable(),
    minQuantity: enteroDesde(1).optional().nullable(),

    // BOGO
    buyQuantity: enteroDesde(1).optional().nullable(),
    getQuantity: enteroDesde(1).optional().nullable(),
    getDiscountPercent: Porcentaje.optional().nullable(),
    buyItemIds: z.array(z.string()).optional(),
    getItemIds: z.array(z.string()).optional(),

    // Time-based
    validFrom: z.coerce.date().optional().nullable(),
    validUntil: z.coerce.date().optional().nullable(),
    daysOfWeek: Dias.optional(),
    timeFrom: z
      .string()
      .regex(/^\d{2}:\d{2}$/, 'La hora debe tener formato HH:MM')
      .optional()
      .nullable(),
    timeUntil: z
      .string()
      .regex(/^\d{2}:\d{2}$/, 'La hora debe tener formato HH:MM')
      .optional()
      .nullable(),

    // Usage limits
    // Al editar, 0 o negativo lo decide el servicio frente a lo guardado (limiteInvalido); null = sin límite.
    maxTotalUses: Numero.int('Debe ser un número entero').optional().nullable(),
    maxUsesPerCustomer: Numero.int('Debe ser un número entero').optional().nullable(),

    // Comp-specific
    requiresApproval: z.boolean().optional(),
    compReason: Motivo.optional().nullable(),

    // Tax handling
    applyBeforeTax: z.boolean().optional(),
    modifyTaxBasis: z.boolean().optional(),

    // Stacking
    isStackable: z.boolean().optional(),
    stackPriority: enteroDesde(0).optional(),

    // Status
    active: z.boolean().optional(),
  })
  // Al editar sólo se rechaza la lista vacía explícita: un cambio que no manda la lista (prender o apagar) la conserva.
  .refine(data => !(data.scope === 'CATEGORY' && data.targetCategoryIds?.length === 0), {
    message: SIN_CATEGORIAS,
  })

// ==========================================
// CUSTOMER DISCOUNT SCHEMAS
// ==========================================

export const assignDiscountToCustomerBodySchema = z.object({
  customerId: z.string().min(1, 'Elige un cliente'),
  validFrom: z.coerce.date().optional(),
  validUntil: z.coerce.date().optional(),
  maxUses: enteroDesde(1).optional(),
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
  venueId: z.string().min(1, 'Falta el negocio'),
  discountId: z.string().min(1, 'Falta el descuento'),
})

export const venueParamsSchema = z.object({
  venueId: z.string().min(1, 'Falta el negocio'),
})

// ==========================================
// TYPE EXPORTS
// ==========================================

export type GetDiscountsQuery = z.infer<typeof getDiscountsQuerySchema>
export type CreateDiscountBody = z.infer<typeof createDiscountBodySchema>
export type UpdateDiscountBody = z.infer<typeof updateDiscountBodySchema>
export type AssignDiscountToCustomerBody = z.infer<typeof assignDiscountToCustomerBodySchema>
