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
