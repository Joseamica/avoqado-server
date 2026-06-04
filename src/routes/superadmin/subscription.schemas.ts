import { z } from 'zod'

/**
 * Zod schemas for the superadmin PLAN_PRO subscription endpoints.
 *
 * Shape/format only — business rules live in subscription.service.ts.
 * Zod messages MUST be in Spanish — the validation middleware shows them raw.
 */

const STATES = ['none', 'trial', 'active', 'canceling', 'past_due', 'suspended', 'canceled'] as const

export const listSubscriptionsSchema = z.object({
  query: z.object({
    state: z.enum(STATES, { errorMap: () => ({ message: 'Estado de suscripción inválido' }) }).optional(),
    q: z.string().trim().min(1).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(25),
  }),
})

/** Body for POST /venues/:venueId/grant-trial — grant a DB-only PLAN_PRO trial of `days`. */
export const grantTrialSchema = z.object({
  body: z.object({
    days: z
      .number({ required_error: 'Los días son requeridos' })
      .int('Los días deben ser un número entero')
      .positive('Los días deben ser mayores a 0'),
  }),
})

/** Body for POST /venues/:venueId/adjust-end-date — shift the PLAN_PRO end date by `deltaDays` (negative shortens). */
export const adjustEndDateSchema = z.object({
  body: z.object({
    deltaDays: z
      .number({ required_error: 'deltaDays es requerido' })
      .int('deltaDays debe ser un número entero')
      .refine(v => v !== 0, 'deltaDays no puede ser 0'),
  }),
})
