import { z } from 'zod'

export const conversationEntrySchema = z.object({
  role: z.enum(['user', 'assistant'], {
    required_error: 'El rol es requerido.',
    invalid_type_error: 'El rol debe ser "user" o "assistant".',
  }),
  content: z
    .string({
      required_error: 'El contenido es requerido.',
    })
    .min(1, 'El contenido no puede estar vacío.'),
  timestamp: z
    .string({
      required_error: 'La fecha es requerida.',
    })
    .datetime('La fecha debe estar en formato ISO válido.')
    .transform(dateStr => new Date(dateStr)),
})

export const assistantQuerySchema = z.object({
  body: z.object({
    message: z
      .string({
        required_error: 'El mensaje es requerido.',
      })
      .min(1, 'El mensaje no puede estar vacío.')
      .max(2000, 'El mensaje no puede exceder 2000 caracteres.'),
    conversationHistory: z.array(conversationEntrySchema).max(50, 'El historial no puede exceder 50 entradas.').optional(),
    venueSlug: z.string().trim().min(1, 'El identificador del venue no puede estar vacío.').optional(),
    userId: z.string().trim().min(1, 'El identificador del usuario no puede estar vacío.').optional(),
  }),
})

export const assistantResponseSchema = z.object({
  response: z.string(),
  suggestions: z.array(z.string()).optional(),
  conversationId: z.string().optional(),
  trainingDataId: z.string().optional(),
})

export const feedbackSubmissionSchema = z.object({
  body: z.object({
    trainingDataId: z
      .string({
        required_error: 'El ID de datos de entrenamiento es requerido.',
      })
      .min(1, 'El ID de datos de entrenamiento no puede estar vacío.'),
    feedbackType: z.enum(['CORRECT', 'INCORRECT', 'PARTIALLY_CORRECT'], {
      required_error: 'El tipo de feedback es requerido.',
      invalid_type_error: 'El tipo de feedback debe ser CORRECT, INCORRECT o PARTIALLY_CORRECT.',
    }),
    correctedResponse: z.string().optional(),
    correctedSql: z.string().optional(),
    userNotes: z.string().optional(),
  }),
})

// Inferimos los tipos para usarlos en el controlador y servicio
export type ConversationEntryDto = z.infer<typeof conversationEntrySchema>
export type AssistantQueryDto = z.infer<typeof assistantQuerySchema.shape.body>
export type AssistantResponseDto = z.infer<typeof assistantResponseSchema>
export type FeedbackSubmissionDto = z.infer<typeof feedbackSubmissionSchema.shape.body>
