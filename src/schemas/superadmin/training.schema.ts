// src/schemas/superadmin/training.schema.ts
import { z } from 'zod'

// ===== PARAMS =====

export const trainingIdParamSchema = z.object({
  params: z.object({
    trainingId: z.string().min(1, 'Training ID is required'),
  }),
})

export const trainingStepIdParamSchema = z.object({
  params: z.object({
    trainingId: z.string().min(1, 'Training ID is required'),
    stepId: z.string().min(1, 'Step ID is required'),
  }),
})

export const trainingQuestionIdParamSchema = z.object({
  params: z.object({
    trainingId: z.string().min(1, 'Training ID is required'),
    questionId: z.string().min(1, 'Question ID is required'),
  }),
})

// ===== QUERY =====

export const listTrainingsQuerySchema = z.object({
  query: z.object({
    status: z.enum(['DRAFT', 'PUBLISHED']).optional(),
    category: z.enum(['VENTAS', 'INVENTARIO', 'PAGOS', 'ATENCION_CLIENTE', 'GENERAL']).optional(),
    organizationId: z.string().optional(),
    search: z.string().optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
})

// ===== BODY =====

export const createTrainingSchema = z.object({
  body: z.object({
    title: z.string().min(1, 'Title is required').max(200),
    description: z.string().min(1, 'Description is required'),
    coverImageUrl: z.string().url().optional(),
    category: z.enum(['VENTAS', 'INVENTARIO', 'PAGOS', 'ATENCION_CLIENTE', 'GENERAL']).optional(),
    difficulty: z.enum(['BASIC', 'INTERMEDIATE']).optional(),
    estimatedMinutes: z.number().int().min(1).max(480).optional(),
    isRequired: z.boolean().optional(),
    position: z.number().int().min(0).optional(),
    status: z.enum(['DRAFT', 'PUBLISHED']).optional(),
    featureTags: z.array(z.string()).optional(),
    venueIds: z.array(z.string()).optional(),
    organizationId: z.string().optional().nullable(),
  }),
})

export const updateTrainingSchema = z.object({
  params: z.object({
    trainingId: z.string().min(1, 'Training ID is required'),
  }),
  body: z.object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().min(1).optional(),
    coverImageUrl: z.string().url().optional().nullable(),
    category: z.enum(['VENTAS', 'INVENTARIO', 'PAGOS', 'ATENCION_CLIENTE', 'GENERAL']).optional(),
    difficulty: z.enum(['BASIC', 'INTERMEDIATE']).optional(),
    estimatedMinutes: z.number().int().min(1).max(480).optional(),
    isRequired: z.boolean().optional(),
    position: z.number().int().min(0).optional(),
    status: z.enum(['DRAFT', 'PUBLISHED']).optional(),
    featureTags: z.array(z.string()).optional(),
    venueIds: z.array(z.string()).optional(),
    organizationId: z.string().optional().nullable(),
  }),
})

// ===== STEPS =====

export const createStepSchema = z.object({
  params: z.object({
    trainingId: z.string().min(1, 'Training ID is required'),
  }),
  body: z.object({
    stepNumber: z.number().int().min(1),
    title: z.string().min(1, 'Title is required').max(200),
    instruction: z.string().min(1, 'Instruction is required'),
    mediaType: z.enum(['IMAGE', 'VIDEO']).optional(),
    mediaUrl: z.string().url().optional(),
    thumbnailUrl: z.string().url().optional(),
    tipText: z.string().optional(),
  }),
})

export const updateStepSchema = z.object({
  params: z.object({
    trainingId: z.string().min(1, 'Training ID is required'),
    stepId: z.string().min(1, 'Step ID is required'),
  }),
  body: z.object({
    stepNumber: z.number().int().min(1).optional(),
    title: z.string().min(1).max(200).optional(),
    instruction: z.string().min(1).optional(),
    mediaType: z.enum(['IMAGE', 'VIDEO']).optional(),
    mediaUrl: z.string().url().optional().nullable(),
    thumbnailUrl: z.string().url().optional().nullable(),
    tipText: z.string().optional().nullable(),
  }),
})

// ===== QUIZ =====

export const createQuizQuestionSchema = z.object({
  params: z.object({
    trainingId: z.string().min(1, 'Training ID is required'),
  }),
  body: z.object({
    question: z.string().min(1, 'Question is required'),
    options: z.array(z.string().min(1)).min(2, 'At least 2 options required').max(6),
    correctIndex: z.number().int().min(0),
    position: z.number().int().min(0).optional(),
  }),
})

export const updateQuizQuestionSchema = z.object({
  params: z.object({
    trainingId: z.string().min(1, 'Training ID is required'),
    questionId: z.string().min(1, 'Question ID is required'),
  }),
  body: z.object({
    question: z.string().min(1).optional(),
    options: z.array(z.string().min(1)).min(2).max(6).optional(),
    correctIndex: z.number().int().min(0).optional(),
    position: z.number().int().min(0).optional(),
  }),
})

// ===== TPV PROGRESS =====

export const updateProgressSchema = z.object({
  params: z.object({
    trainingId: z.string().min(1, 'Training ID is required'),
  }),
  body: z.object({
    staffId: z.string().optional(),
    lastStepViewed: z.number().int().min(0).optional(),
    isCompleted: z.boolean().optional(),
    quizScore: z.number().int().min(0).optional(),
    quizTotal: z.number().int().min(0).optional(),
    quizPassed: z.boolean().optional(),
  }),
})

export const getStaffProgressQuerySchema = z.object({
  query: z.object({
    staffId: z.string().optional(),
  }),
})
