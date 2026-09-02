import { z } from 'zod'
import {
  StripeEventOwnerKind,
  StripeEventRouteKey,
  WebhookClaimPhase,
  WebhookClassificationState,
  WebhookEventStatus,
} from '@prisma/client'

const legacyDateString = (message: string) =>
  z.string().refine(value => value.trim().length > 0 && !Number.isNaN(new Date(value).getTime()), { message })

export const listSuperadminWebhooksSchema = z.object({
  query: z.object({
    eventType: z.string().trim().min(1, 'El tipo de evento no puede estar vacío').optional(),
    status: z.nativeEnum(WebhookEventStatus, { errorMap: () => ({ message: 'Estado de webhook inválido' }) }).optional(),
    classificationState: z
      .nativeEnum(WebhookClassificationState, { errorMap: () => ({ message: 'Estado de clasificación inválido' }) })
      .optional(),
    ownerKind: z.nativeEnum(StripeEventOwnerKind, { errorMap: () => ({ message: 'Owner de webhook inválido' }) }).optional(),
    routeKey: z.nativeEnum(StripeEventRouteKey, { errorMap: () => ({ message: 'Ruta de webhook inválida' }) }).optional(),
    claimPhase: z.nativeEnum(WebhookClaimPhase, { errorMap: () => ({ message: 'Fase de claim inválida' }) }).optional(),
    venueId: z.string().trim().min(1, 'El identificador de la sucursal no puede estar vacío').optional(),
    // The current Dashboard sends YYYY-MM-DD from <input type="date">. Keep
    // every parseable legacy date accepted by the old new Date(value) path.
    startDate: legacyDateString('La fecha inicial no es válida').optional(),
    endDate: legacyDateString('La fecha final no es válida').optional(),
    limit: z.string().regex(/^\d+$/, 'El límite debe ser un entero no negativo').optional(),
    offset: z.string().regex(/^\d+$/, 'El offset debe ser un entero no negativo').optional(),
  }),
})

export const retrySuperadminWebhookSchema = z.object({
  params: z.object({
    eventId: z.string().trim().min(1, 'El identificador del webhook es requerido'),
  }),
  body: z
    .object({
      reason: z
        .string()
        .trim()
        .min(3, 'El motivo debe tener al menos 3 caracteres')
        .max(160, 'El motivo no puede exceder 160 caracteres')
        .optional(),
    })
    .strict('El cuerpo contiene campos no permitidos')
    .default({}),
})

export type RetrySuperadminWebhookBody = z.infer<typeof retrySuperadminWebhookSchema>['body']
