/**
 * Upsell — validación de forma (Zod).
 *
 * 🔴 Mensajes en ESPAÑOL: el middleware de validación se los muestra al usuario
 * tal cual, así que un mensaje en inglés sale crudo en la UI.
 *
 * 🔴 Sólo FORMA. Las reglas de negocio (que el producto exista en el venue, que
 * esté habilitado para upsell, que no haya una regla duplicada) viven en el
 * servicio, donde hay acceso a la base y contexto del venue.
 */

import { z } from 'zod'

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

const timeField = z.string().regex(HHMM, 'La hora debe tener formato HH:mm (por ejemplo 09:00 o 22:30)').nullable().optional()

/** 0=domingo .. 6=sábado, igual que `Discount.daysOfWeek`. Vacío = todos los días. */
const daysOfWeekField = z
  .array(z.number().int().min(0, 'Los días van de 0 (domingo) a 6 (sábado)').max(6, 'Los días van de 0 (domingo) a 6 (sábado)'))
  .max(7, 'No puede haber más de 7 días')
  .optional()

/**
 * Selección de opciones obligatorias (spec 2026-08-16, B3). `nullable()` porque
 * `null` es la forma explícita de LIMPIAR una selección (p. ej. al cambiar de
 * producto sugerido en `updateUpsellRuleSchema`); `optional()` porque omitirla
 * del todo = "no toco la selección actual".
 *
 * 🔴 Sin esto en el schema, `z.object()` strippea la llave y
 * `src/middlewares/validation.ts` reemplaza `req.body` con el resultado ya sin
 * ella — el servicio nunca la ve, por perfecta que esté su validación.
 */
const suggestedModifiersField = z
  .array(z.object({ groupId: z.string().min(1), modifierId: z.string().min(1) }))
  .nullable()
  .optional()

export const createUpsellRuleSchema = z.object({
  body: z
    .object({
      triggerType: z.enum(['PRODUCT', 'CATEGORY', 'ALWAYS'], {
        errorMap: () => ({ message: 'El disparador debe ser PRODUCT, CATEGORY o ALWAYS' }),
      }),
      triggerProductIds: z.array(z.string().min(1)).optional(),
      triggerCategoryIds: z.array(z.string().min(1)).optional(),
      suggestedProductId: z.string().min(1, 'El producto sugerido es requerido'),
      suggestedModifiers: suggestedModifiersField,
      headline: z.string().max(120, 'El gancho no puede pasar de 120 caracteres').nullable().optional(),
      priority: z.number().int().min(0, 'La prioridad no puede ser negativa').max(1000, 'La prioridad máxima es 1000').optional(),
      daysOfWeek: daysOfWeekField,
      timeFrom: timeField,
      timeUntil: timeField,
    })
    .refine(d => d.triggerType !== 'PRODUCT' || (d.triggerProductIds?.length ?? 0) > 0, {
      message: 'Un disparador por producto necesita al menos un producto',
      path: ['triggerProductIds'],
    })
    .refine(d => d.triggerType !== 'CATEGORY' || (d.triggerCategoryIds?.length ?? 0) > 0, {
      message: 'Un disparador por categoría necesita al menos una categoría',
      path: ['triggerCategoryIds'],
    })
    // Una ventana necesita sus dos extremos. Uno solo no define nada.
    .refine(d => !!d.timeFrom === !!d.timeUntil, {
      message: 'Si defines una ventana de horario, necesitas la hora de inicio y la de fin',
      path: ['timeUntil'],
    }),
})

export const updateUpsellRuleSchema = z.object({
  body: z.object({
    suggestedProductId: z.string().min(1, 'El producto sugerido es requerido').optional(),
    suggestedModifiers: suggestedModifiersField,
    headline: z.string().max(120, 'El gancho no puede pasar de 120 caracteres').nullable().optional(),
    priority: z.number().int().min(0, 'La prioridad no puede ser negativa').max(1000, 'La prioridad máxima es 1000').optional(),
    daysOfWeek: daysOfWeekField,
    timeFrom: timeField,
    timeUntil: timeField,
  }),
})

/** Las tres perillas por venue. `tablePaying` exige red en el cliente (spec R1). */
export const setUpsellSurfacesSchema = z.object({
  body: z.object({
    counter: z.boolean({ required_error: 'Falta la perilla de mostrador' }),
    tableOrdering: z.boolean({ required_error: 'Falta la perilla de mesa (tomando la orden)' }),
    tablePaying: z.boolean({ required_error: 'Falta la perilla de mesa (cobrando)' }),
  }),
})

/** Marcar/desmarcar productos como sugeribles. Acepta varios para la acción masiva. */
export const setProductUpsellEnabledSchema = z.object({
  body: z.object({
    productIds: z.array(z.string().min(1)).min(1, 'Elige al menos un producto').max(500, 'Máximo 500 productos por operación'),
    enabled: z.boolean({ required_error: 'Falta indicar si se habilita o se deshabilita' }),
  }),
})

// ═══════════════════════════════════════════════════════════════════════════
// Mobile
// ═══════════════════════════════════════════════════════════════════════════

export const recordUpsellImpressionSchema = z.object({
  body: z.object({
    impressionId: z.string().min(1, 'Falta el identificador del momento'),
    shownRuleIds: z.array(z.string().min(1)).max(10, 'Demasiadas reglas en un solo momento'),
    accepted: z
      .array(
        z.object({
          ruleId: z.string().min(1),
          productId: z.string().min(1),
          orderItemExternalId: z.string().min(1),
        }),
      )
      .max(10, 'Demasiados productos aceptados en un solo momento')
      .optional(),
    // Pesos, unidades mayores (1.00 = un peso). Informativo: el ingreso del
    // reporte NO sale de aquí, sale de las líneas reales de la orden.
    reportedAmount: z.number().min(0, 'El monto no puede ser negativo').optional(),
    cartSubtotalBefore: z.number().min(0, 'El subtotal no puede ser negativo').optional(),
    surface: z.enum(['CUSTOMER_DISPLAY', 'CASHIER', 'NONE', 'HOLDOUT'], {
      errorMap: () => ({ message: 'Superficie inválida' }),
    }),
    context: z.enum(['counter', 'tableOrdering', 'tablePaying'], {
      errorMap: () => ({ message: 'El contexto debe ser counter, tableOrdering o tablePaying' }),
    }),
  }),
})

export const convertUpsellImpressionSchema = z.object({
  body: z.object({
    orderId: z.string().min(1, 'Falta el identificador de la orden'),
  }),
})
