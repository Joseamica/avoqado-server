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
      required_error: 'settlementArrived is required',
      invalid_type_error: 'settlementArrived must be a boolean',
    }),
    actualDate: z.string().datetime({ message: 'actualDate must be a valid ISO 8601 datetime' }).optional(),
    notes: z.string().max(1000, 'Notes cannot exceed 1000 characters').optional(),
  }),
})

/**
 * Body schema for escalating an incident
 */
export const escalateIncidentSchema = z.object({
  body: z.object({
    notes: z.string().max(1000, 'Notes cannot exceed 1000 characters').optional(),
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
      required_error: 'settlementArrived is required',
      invalid_type_error: 'settlementArrived must be a boolean',
    }),
    actualDate: z.string().datetime({ message: 'actualDate must be a valid ISO 8601 datetime' }).optional(),
    notes: z.string().max(1000, 'Notes cannot exceed 1000 characters').optional(),
  }),
})
