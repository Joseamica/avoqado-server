// src/services/shared/cancellationReason.ts
import { z } from 'zod'
import type Stripe from 'stripe'

/**
 * Why the owner cancels, as the dashboard and the MCP send it (spec §4.4). Stripe gets its own vocabulary (feedback +
 * comment); ActivityLog keeps ours, so a report can tell a temporary closure apart from "doesn't use it".
 */
export const CANCELLATION_REASONS = [
  'TOO_EXPENSIVE',
  'UNUSED',
  'MISSING_FEATURES',
  'TOO_COMPLEX',
  'SWITCHED_SERVICE',
  'TEMPORARY',
  'OTHER',
] as const
export type CancellationReason = (typeof CANCELLATION_REASONS)[number]

// A type alias, not an interface: it must fit the `data: Record<string, unknown>` of logAction and auditMcpWrite.
export type CancellationInput = {
  reason?: CancellationReason
  comment?: string
}

/** Optional fields shared by every cancel endpoint and MCP tool. Shape only. */
export const cancellationFields = {
  reason: z
    .enum(CANCELLATION_REASONS, { errorMap: () => ({ message: 'El motivo de cancelación no es válido.' }) })
    .optional()
    .describe('Por qué cancela el dueño (opcional)'),
  comment: z
    .string({ invalid_type_error: 'El comentario debe ser texto.' })
    .trim()
    .max(500, 'El comentario admite hasta 500 caracteres.')
    .optional()
    .transform(value => value || undefined)
    .describe('Comentario libre del dueño, hasta 500 caracteres (opcional)'),
}

const STRIPE_FEEDBACK: Record<CancellationReason, Stripe.SubscriptionUpdateParams.CancellationDetails.Feedback> = {
  TOO_EXPENSIVE: 'too_expensive',
  UNUSED: 'unused',
  MISSING_FEATURES: 'missing_features',
  TOO_COMPLEX: 'too_complex',
  SWITCHED_SERVICE: 'switched_service',
  TEMPORARY: 'unused',
  OTHER: 'other',
}

/** Stripe's cancellation_details for this input, or undefined when the owner said nothing. */
export function toStripeCancellationDetails(input: CancellationInput): Stripe.SubscriptionUpdateParams.CancellationDetails | undefined {
  if (!input.reason && !input.comment) return undefined
  const comment = input.reason === 'TEMPORARY' ? `[temporal] ${input.comment ?? ''}`.trim() : input.comment
  return {
    ...(input.reason ? { feedback: STRIPE_FEEDBACK[input.reason] } : {}),
    ...(comment ? { comment } : {}),
  }
}

/** The reason and comment as ActivityLog stores them, keys only when present. */
export function cancellationAuditData(input: CancellationInput): CancellationInput {
  return { ...(input.reason ? { reason: input.reason } : {}), ...(input.comment ? { comment: input.comment } : {}) }
}
