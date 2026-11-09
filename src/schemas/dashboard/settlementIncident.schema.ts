import { z } from 'zod'

/**
 * Validation schemas for settlement incident endpoints
 */

/**
 * Query schema for listing incidents with optional status filter
 */
export const incidentListQuerySchema = z.object({
  query: z
    .object({
      status: z.enum(['pending', 'active', 'all']).optional(),
    })
    .optional(),
})

/**
 * Body schema for confirming a settlement incident
 */
export const confirmIncidentSchema = z.object({
  body: z.object({
    settlementArrived: z.boolean({
      required_error: 'Indica si la liquidación ya llegó',
      invalid_type_error: 'Indica con sí o no si la liquidación ya llegó',
    }),
    actualDate: z.string().datetime({ message: 'La fecha real de llegada no es válida' }).optional(),
    notes: z.string().max(1000, 'Las notas admiten hasta 1000 caracteres').optional(),
  }),
})

/**
 * Body schema for escalating an incident
 */
export const escalateIncidentSchema = z.object({
  body: z.object({
    notes: z.string().max(1000, 'Las notas admiten hasta 1000 caracteres').optional(),
  }),
})

/**
 * Body schema for bulk confirming multiple incidents
 */
export const bulkConfirmIncidentSchema = z.object({
  body: z.object({
    incidentIds: z
      .array(z.string().cuid('Cada incidentId debe ser un CUID válido'))
      .min(1, 'Se requiere al menos un incidente para confirmar')
      .max(2000, 'No se pueden confirmar más de 2000 liquidaciones a la vez'),
    settlementArrived: z.boolean({
      required_error: 'Indica si la liquidación ya llegó',
      invalid_type_error: 'Indica con sí o no si la liquidación ya llegó',
    }),
    actualDate: z.string().datetime({ message: 'La fecha real de llegada no es válida' }).optional(),
    notes: z.string().max(1000, 'Las notas admiten hasta 1000 caracteres').optional(),
  }),
})
