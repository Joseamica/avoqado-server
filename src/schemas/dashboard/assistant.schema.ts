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
    .min(1, 'El contenido no puede estar vacío.')
    .max(3000, 'El contenido no puede exceder 3000 caracteres.'),
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
    includeVisualization: z.boolean().optional().default(false),
    referencesContext: z.string().max(4000, 'El contexto de referencias no puede exceder 4000 caracteres.').optional(),
  }),
})

export const assistantActionPreviewSchema = z.object({
  body: z.object({
    actionType: z.string().min(1, { message: 'El tipo de acción es requerido' }),
    draft: z
      .object({
        name: z.string().min(1, 'El nombre no puede estar vacío.').max(120, 'El nombre no puede exceder 120 caracteres.').optional(),
        price: z.union([z.number(), z.string()]).optional(),
        sku: z.string().max(64, 'El SKU no puede exceder 64 caracteres.').optional(),
        categoryId: z.string().trim().min(1, 'La categoría no puede estar vacía.').optional(),
        type: z.string().max(40).optional(),
        needsModifiers: z.boolean().optional(),
        modifierGroupIds: z.array(z.string().trim().min(1)).max(50, 'No puedes enviar más de 50 modificadores.').optional(),
      })
      .default({}),
    conversationId: z.string().trim().min(1).max(120).optional(),
  }),
})

export const assistantActionConfirmSchema = z.object({
  body: z.object({
    actionId: z.string().uuid('El actionId debe ser un UUID válido.'),
    idempotencyKey: z.string().uuid('El idempotencyKey debe ser un UUID válido.'),
    confirmed: z.literal(true, {
      errorMap: () => ({ message: 'Debes confirmar explícitamente la acción.' }),
    }),
    doubleConfirmed: z.boolean().optional().default(false),
  }),
})

// Schema for chart visualization data
export const chartVisualizationSchema = z.object({
  type: z.enum(['bar', 'line', 'pie', 'area']),
  title: z.string(),
  description: z.string().optional(),
  data: z.array(z.record(z.any())),
  config: z.object({
    xAxis: z.object({ key: z.string(), label: z.string() }).optional(),
    yAxis: z.object({ key: z.string(), label: z.string() }).optional(),
    dataKeys: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        color: z.string().optional(),
      }),
    ),
  }),
})

// Schema for when visualization was requested but couldn't be generated
export const visualizationSkippedSchema = z.object({
  skipped: z.literal(true),
  reason: z.string(),
})

// Union type: either a chart or a skip reason
export const visualizationResultSchema = z.union([chartVisualizationSchema, visualizationSkippedSchema])

export const assistantResponseSchema = z.object({
  response: z.string(),
  suggestions: z.array(z.string()).optional(),
  conversationId: z.string().optional(),
  trainingDataId: z.string().optional(),
  visualization: visualizationResultSchema.optional(),
  tokenUsage: z
    .object({
      promptTokens: z.number(),
      completionTokens: z.number(),
      totalTokens: z.number(),
    })
    .optional(),
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
    correctedResponse: z.string().max(3000, 'La corrección de respuesta no puede exceder 3000 caracteres.').optional(),
    correctedSql: z.string().max(5000, 'La corrección SQL no puede exceder 5000 caracteres.').optional(),
    userNotes: z.string().max(2000, 'Las notas no pueden exceder 2000 caracteres.').optional(),
  }),
})

// Inferimos los tipos para usarlos en el controlador y servicio
export type ConversationEntryDto = z.infer<typeof conversationEntrySchema>
export type AssistantQueryDto = z.infer<typeof assistantQuerySchema.shape.body>
export type AssistantActionPreviewDto = z.infer<typeof assistantActionPreviewSchema.shape.body>
export type AssistantActionConfirmDto = z.infer<typeof assistantActionConfirmSchema.shape.body>
export type AssistantResponseDto = z.infer<typeof assistantResponseSchema>
export type FeedbackSubmissionDto = z.infer<typeof feedbackSubmissionSchema.shape.body>
export type ChartVisualization = z.infer<typeof chartVisualizationSchema>
export type VisualizationSkipped = z.infer<typeof visualizationSkippedSchema>
export type VisualizationResult = z.infer<typeof visualizationResultSchema>
