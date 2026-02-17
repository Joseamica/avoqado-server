// src/services/superadmin/training.service.ts
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { TrainingCategory, TrainingDifficulty, TrainingStatus, TrainingMediaType, TrainingQuestionType } from '@prisma/client'
import { BadRequestError, NotFoundError } from '../../errors/AppError'

// ===== TYPES =====

interface CreateTrainingModuleData {
  title: string
  description: string
  coverImageUrl?: string
  category?: TrainingCategory
  difficulty?: TrainingDifficulty
  estimatedMinutes?: number
  isRequired?: boolean
  position?: number
  status?: TrainingStatus
  featureTags?: string[]
  venueIds?: string[]
  organizationId?: string
  quizPassThreshold?: number
  quizMaxAttempts?: number
  createdBy: string
  createdByName: string
}

interface UpdateTrainingModuleData {
  title?: string
  description?: string
  coverImageUrl?: string | null
  category?: TrainingCategory
  difficulty?: TrainingDifficulty
  estimatedMinutes?: number
  isRequired?: boolean
  position?: number
  status?: TrainingStatus
  featureTags?: string[]
  venueIds?: string[]
  organizationId?: string | null
  quizPassThreshold?: number
  quizMaxAttempts?: number
}

interface CreateStepData {
  stepNumber: number
  title: string
  instruction: string
  mediaType?: TrainingMediaType
  mediaUrl?: string
  thumbnailUrl?: string
  tipText?: string
}

interface UpdateStepData {
  stepNumber?: number
  title?: string
  instruction?: string
  mediaType?: TrainingMediaType
  mediaUrl?: string | null
  thumbnailUrl?: string | null
  tipText?: string | null
}

interface CreateQuizQuestionData {
  questionType?: TrainingQuestionType
  question: string
  options: string[]
  correctIndex: number
  correctIndices?: number[]
  position?: number
  explanation?: string
}

interface UpdateQuizQuestionData {
  questionType?: TrainingQuestionType
  question?: string
  options?: string[]
  correctIndex?: number
  correctIndices?: number[]
  position?: number
  explanation?: string | null
}

interface ListFilters {
  status?: TrainingStatus
  category?: TrainingCategory
  organizationId?: string
  search?: string
  page?: number
  limit?: number
}

// ===== SERVICE FUNCTIONS =====

/**
 * List all training modules with filters (Superadmin)
 */
export async function listTrainingModules(filters: ListFilters) {
  const page = filters.page || 1
  const limit = filters.limit || 50
  const skip = (page - 1) * limit

  const where: any = {}

  if (filters.status) {
    where.status = filters.status
  }
  if (filters.category) {
    where.category = filters.category
  }
  if (filters.organizationId) {
    where.organizationId = filters.organizationId
  }
  if (filters.search) {
    where.OR = [
      { title: { contains: filters.search, mode: 'insensitive' } },
      { description: { contains: filters.search, mode: 'insensitive' } },
    ]
  }

  const [trainings, total] = await Promise.all([
    prisma.trainingModule.findMany({
      where,
      include: {
        organization: { select: { id: true, name: true } },
        _count: {
          select: {
            steps: true,
            quizQuestions: true,
            progress: true,
          },
        },
      },
      orderBy: [{ position: 'asc' }, { createdAt: 'desc' }],
      skip,
      take: limit,
    }),
    prisma.trainingModule.count({ where }),
  ])

  return {
    trainings,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  }
}

/**
 * Get a single training module with all details
 */
export async function getTrainingModule(trainingId: string) {
  const training = await prisma.trainingModule.findUnique({
    where: { id: trainingId },
    include: {
      organization: { select: { id: true, name: true } },
      steps: { orderBy: { stepNumber: 'asc' } },
      quizQuestions: { orderBy: { position: 'asc' } },
      _count: {
        select: { progress: true },
      },
    },
  })

  if (!training) {
    throw new NotFoundError(`Training module ${trainingId} not found`)
  }

  return training
}

/**
 * Create a new training module
 */
export async function createTrainingModule(data: CreateTrainingModuleData) {
  // Validate organization exists if provided
  if (data.organizationId) {
    const org = await prisma.organization.findUnique({ where: { id: data.organizationId } })
    if (!org) {
      throw new BadRequestError(`Organization ${data.organizationId} not found`)
    }
  }

  const training = await prisma.trainingModule.create({
    data: {
      title: data.title,
      description: data.description,
      coverImageUrl: data.coverImageUrl || null,
      category: data.category || 'GENERAL',
      difficulty: data.difficulty || 'BASIC',
      estimatedMinutes: data.estimatedMinutes || 5,
      isRequired: data.isRequired || false,
      position: data.position || 0,
      status: data.status || 'DRAFT',
      featureTags: data.featureTags || [],
      venueIds: data.venueIds || [],
      organizationId: data.organizationId || null,
      quizPassThreshold: data.quizPassThreshold ?? 70,
      quizMaxAttempts: data.quizMaxAttempts ?? 0,
      createdBy: data.createdBy,
      createdByName: data.createdByName,
    },
    include: {
      organization: { select: { id: true, name: true } },
      _count: { select: { steps: true, quizQuestions: true } },
    },
  })

  logger.info('Training module created', { trainingId: training.id, title: training.title })
  return training
}

/**
 * Update a training module
 */
export async function updateTrainingModule(trainingId: string, data: UpdateTrainingModuleData) {
  const existing = await prisma.trainingModule.findUnique({ where: { id: trainingId } })
  if (!existing) {
    throw new NotFoundError(`Training module ${trainingId} not found`)
  }

  if (data.organizationId) {
    const org = await prisma.organization.findUnique({ where: { id: data.organizationId } })
    if (!org) {
      throw new BadRequestError(`Organization ${data.organizationId} not found`)
    }
  }

  const training = await prisma.trainingModule.update({
    where: { id: trainingId },
    data: {
      ...(data.title !== undefined && { title: data.title }),
      ...(data.description !== undefined && { description: data.description }),
      ...(data.coverImageUrl !== undefined && { coverImageUrl: data.coverImageUrl }),
      ...(data.category !== undefined && { category: data.category }),
      ...(data.difficulty !== undefined && { difficulty: data.difficulty }),
      ...(data.estimatedMinutes !== undefined && { estimatedMinutes: data.estimatedMinutes }),
      ...(data.isRequired !== undefined && { isRequired: data.isRequired }),
      ...(data.position !== undefined && { position: data.position }),
      ...(data.status !== undefined && { status: data.status }),
      ...(data.featureTags !== undefined && { featureTags: data.featureTags }),
      ...(data.venueIds !== undefined && { venueIds: data.venueIds }),
      ...(data.organizationId !== undefined && { organizationId: data.organizationId }),
      ...(data.quizPassThreshold !== undefined && { quizPassThreshold: data.quizPassThreshold }),
      ...(data.quizMaxAttempts !== undefined && { quizMaxAttempts: data.quizMaxAttempts }),
    },
    include: {
      organization: { select: { id: true, name: true } },
      steps: { orderBy: { stepNumber: 'asc' } },
      quizQuestions: { orderBy: { position: 'asc' } },
      _count: { select: { steps: true, quizQuestions: true, progress: true } },
    },
  })

  logger.info('Training module updated', { trainingId, title: training.title })
  return training
}

/**
 * Delete a training module (cascades to steps, quiz, progress)
 */
export async function deleteTrainingModule(trainingId: string) {
  const existing = await prisma.trainingModule.findUnique({ where: { id: trainingId } })
  if (!existing) {
    throw new NotFoundError(`Training module ${trainingId} not found`)
  }

  await prisma.trainingModule.delete({ where: { id: trainingId } })

  logger.warn('Training module deleted', { trainingId, title: existing.title })
}

// ===== STEPS =====

/**
 * Add a step to a training module
 */
export async function addStep(trainingId: string, data: CreateStepData) {
  const training = await prisma.trainingModule.findUnique({ where: { id: trainingId } })
  if (!training) {
    throw new NotFoundError(`Training module ${trainingId} not found`)
  }

  const step = await prisma.trainingStep.create({
    data: {
      trainingModuleId: trainingId,
      stepNumber: data.stepNumber,
      title: data.title,
      instruction: data.instruction,
      mediaType: data.mediaType || 'IMAGE',
      mediaUrl: data.mediaUrl || null,
      thumbnailUrl: data.thumbnailUrl || null,
      tipText: data.tipText || null,
    },
  })

  logger.info('Training step added', { trainingId, stepId: step.id, stepNumber: step.stepNumber })
  return step
}

/**
 * Update a step
 */
export async function updateStep(trainingId: string, stepId: string, data: UpdateStepData) {
  const step = await prisma.trainingStep.findFirst({
    where: { id: stepId, trainingModuleId: trainingId },
  })
  if (!step) {
    throw new NotFoundError(`Step ${stepId} not found in training ${trainingId}`)
  }

  const updated = await prisma.trainingStep.update({
    where: { id: stepId },
    data: {
      ...(data.stepNumber !== undefined && { stepNumber: data.stepNumber }),
      ...(data.title !== undefined && { title: data.title }),
      ...(data.instruction !== undefined && { instruction: data.instruction }),
      ...(data.mediaType !== undefined && { mediaType: data.mediaType }),
      ...(data.mediaUrl !== undefined && { mediaUrl: data.mediaUrl }),
      ...(data.thumbnailUrl !== undefined && { thumbnailUrl: data.thumbnailUrl }),
      ...(data.tipText !== undefined && { tipText: data.tipText }),
    },
  })

  logger.info('Training step updated', { trainingId, stepId })
  return updated
}

/**
 * Delete a step and re-number remaining steps
 */
export async function deleteStep(trainingId: string, stepId: string) {
  const step = await prisma.trainingStep.findFirst({
    where: { id: stepId, trainingModuleId: trainingId },
  })
  if (!step) {
    throw new NotFoundError(`Step ${stepId} not found in training ${trainingId}`)
  }

  await prisma.$transaction(async tx => {
    // Delete the step
    await tx.trainingStep.delete({ where: { id: stepId } })

    // Re-number remaining steps
    const remainingSteps = await tx.trainingStep.findMany({
      where: { trainingModuleId: trainingId },
      orderBy: { stepNumber: 'asc' },
    })

    for (let i = 0; i < remainingSteps.length; i++) {
      if (remainingSteps[i].stepNumber !== i + 1) {
        await tx.trainingStep.update({
          where: { id: remainingSteps[i].id },
          data: { stepNumber: i + 1 },
        })
      }
    }
  })

  logger.info('Training step deleted and re-numbered', { trainingId, stepId })
}

// ===== QUIZ QUESTIONS =====

/**
 * Add a quiz question
 */
export async function addQuizQuestion(trainingId: string, data: CreateQuizQuestionData) {
  const training = await prisma.trainingModule.findUnique({ where: { id: trainingId } })
  if (!training) {
    throw new NotFoundError(`Training module ${trainingId} not found`)
  }

  if (data.correctIndex < 0 || data.correctIndex >= data.options.length) {
    throw new BadRequestError('correctIndex must be a valid index within options array')
  }

  // Validate correctIndices for MULTI_SELECT
  if (data.correctIndices && data.correctIndices.length > 0) {
    for (const idx of data.correctIndices) {
      if (idx < 0 || idx >= data.options.length) {
        throw new BadRequestError('All correctIndices must be valid indices within options array')
      }
    }
  }

  const question = await prisma.trainingQuizQuestion.create({
    data: {
      trainingModuleId: trainingId,
      questionType: data.questionType || 'MULTIPLE_CHOICE',
      question: data.question,
      options: data.options,
      correctIndex: data.correctIndex,
      correctIndices: data.correctIndices || [],
      position: data.position || 0,
      explanation: data.explanation || null,
    },
  })

  logger.info('Quiz question added', { trainingId, questionId: question.id })
  return question
}

/**
 * Update a quiz question
 */
export async function updateQuizQuestion(trainingId: string, questionId: string, data: UpdateQuizQuestionData) {
  const question = await prisma.trainingQuizQuestion.findFirst({
    where: { id: questionId, trainingModuleId: trainingId },
  })
  if (!question) {
    throw new NotFoundError(`Quiz question ${questionId} not found in training ${trainingId}`)
  }

  if (data.correctIndex !== undefined && data.options) {
    if (data.correctIndex < 0 || data.correctIndex >= data.options.length) {
      throw new BadRequestError('correctIndex must be a valid index within options array')
    }
  }

  const updated = await prisma.trainingQuizQuestion.update({
    where: { id: questionId },
    data: {
      ...(data.question !== undefined && { question: data.question }),
      ...(data.options !== undefined && { options: data.options }),
      ...(data.questionType !== undefined && { questionType: data.questionType }),
      ...(data.correctIndex !== undefined && { correctIndex: data.correctIndex }),
      ...(data.correctIndices !== undefined && { correctIndices: data.correctIndices }),
      ...(data.position !== undefined && { position: data.position }),
      ...(data.explanation !== undefined && { explanation: data.explanation }),
    },
  })

  logger.info('Quiz question updated', { trainingId, questionId })
  return updated
}

/**
 * Delete a quiz question
 */
export async function deleteQuizQuestion(trainingId: string, questionId: string) {
  const question = await prisma.trainingQuizQuestion.findFirst({
    where: { id: questionId, trainingModuleId: trainingId },
  })
  if (!question) {
    throw new NotFoundError(`Quiz question ${questionId} not found in training ${trainingId}`)
  }

  await prisma.trainingQuizQuestion.delete({ where: { id: questionId } })

  logger.info('Quiz question deleted', { trainingId, questionId })
}

// ===== PROGRESS (for superadmin stats) =====

/**
 * Get completion stats for a training module
 */
export async function getTrainingProgress(trainingId: string) {
  const training = await prisma.trainingModule.findUnique({ where: { id: trainingId } })
  if (!training) {
    throw new NotFoundError(`Training module ${trainingId} not found`)
  }

  const progress = await prisma.trainingProgress.findMany({
    where: { trainingModuleId: trainingId },
    orderBy: { startedAt: 'desc' },
  })

  const totalStarted = progress.length
  const totalCompleted = progress.filter(p => p.isCompleted).length
  const totalPassed = progress.filter(p => p.quizPassed === true).length
  const averageScore =
    progress.filter(p => p.quizScore !== null).reduce((sum, p) => sum + (p.quizScore || 0), 0) /
    (progress.filter(p => p.quizScore !== null).length || 1)

  return {
    trainingId,
    stats: {
      totalStarted,
      totalCompleted,
      totalPassed,
      completionRate: totalStarted > 0 ? Math.round((totalCompleted / totalStarted) * 100) : 0,
      averageScore: Math.round(averageScore * 100) / 100,
    },
    progress,
  }
}

// ===== TPV FUNCTIONS =====

/**
 * Get available trainings for a TPV terminal (auto-filtered by org modules)
 */
export async function getTrainingsForTpv(venueId: string) {
  // Get venue → organization → enabled modules
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    include: {
      organization: {
        include: {
          organizationModules: {
            include: { module: { select: { code: true } } },
          },
        },
      },
    },
  })

  if (!venue || !venue.organization) {
    throw new NotFoundError('Venue or organization not found')
  }

  const orgId = venue.organization.id
  const enabledModuleCodes = (venue.organization.organizationModules || []).map(om => om.module.code)

  // Get all PUBLISHED trainings that are global OR belong to this org
  const allTrainings = await prisma.trainingModule.findMany({
    where: {
      status: 'PUBLISHED',
      OR: [{ organizationId: null }, { organizationId: orgId }],
    },
    include: {
      steps: { orderBy: { stepNumber: 'asc' } },
      quizQuestions: { orderBy: { position: 'asc' } },
      _count: { select: { steps: true, quizQuestions: true } },
    },
    orderBy: [{ isRequired: 'desc' }, { position: 'asc' }, { createdAt: 'desc' }],
  })

  // Filter by venue-level first, then feature tags
  // Hierarchy: venue-specific settings override org-level
  const filteredTrainings = allTrainings.filter(training => {
    // Venue-level filter: if venueIds is non-empty, only include if current venueId is in the list
    const trainingVenueIds = training.venueIds || []
    if (trainingVenueIds.length > 0) {
      if (!trainingVenueIds.includes(venueId)) return false
    }

    // Feature tag filter: if featureTags is non-empty, include only if at least one tag matches
    const trainingFeatureTags = training.featureTags || []
    if (trainingFeatureTags.length > 0) {
      if (!trainingFeatureTags.some(tag => enabledModuleCodes.includes(tag))) return false
    }

    return true
  })

  return filteredTrainings
}

/**
 * Get training detail for TPV
 */
export async function getTrainingDetailForTpv(trainingId: string) {
  const training = await prisma.trainingModule.findUnique({
    where: { id: trainingId, status: 'PUBLISHED' },
    include: {
      steps: { orderBy: { stepNumber: 'asc' } },
      quizQuestions: { orderBy: { position: 'asc' } },
    },
  })

  if (!training) {
    throw new NotFoundError(`Training module ${trainingId} not found or not published`)
  }

  return training
}

/**
 * Update progress for a staff member
 */
export async function updateProgress(
  trainingId: string,
  staffId: string,
  venueId: string,
  data: {
    lastStepViewed?: number
    isCompleted?: boolean
    quizScore?: number
    quizTotal?: number
    quizPassed?: boolean
    attemptNumber?: number
  },
) {
  const training = await prisma.trainingModule.findUnique({ where: { id: trainingId } })
  if (!training) {
    throw new NotFoundError(`Training module ${trainingId} not found`)
  }

  const progress = await prisma.trainingProgress.upsert({
    where: {
      trainingModuleId_staffId: { trainingModuleId: trainingId, staffId },
    },
    create: {
      trainingModuleId: trainingId,
      staffId,
      venueId,
      lastStepViewed: data.lastStepViewed || 0,
      isCompleted: data.isCompleted || false,
      quizScore: data.quizScore ?? null,
      quizTotal: data.quizTotal ?? null,
      quizPassed: data.quizPassed ?? null,
      attemptNumber: data.attemptNumber ?? 1,
      completedAt: data.isCompleted ? new Date() : null,
    },
    update: {
      ...(data.lastStepViewed !== undefined && { lastStepViewed: data.lastStepViewed }),
      ...(data.isCompleted !== undefined && { isCompleted: data.isCompleted }),
      ...(data.quizScore !== undefined && { quizScore: data.quizScore }),
      ...(data.quizTotal !== undefined && { quizTotal: data.quizTotal }),
      ...(data.quizPassed !== undefined && { quizPassed: data.quizPassed }),
      ...(data.attemptNumber !== undefined && { attemptNumber: data.attemptNumber }),
      ...(data.isCompleted && { completedAt: new Date() }),
    },
  })

  logger.info('Training progress updated', { trainingId, staffId, isCompleted: progress.isCompleted })
  return progress
}

/**
 * Get all progress for a staff member
 */
export async function getStaffProgress(staffId: string) {
  const progress = await prisma.trainingProgress.findMany({
    where: { staffId },
    include: {
      trainingModule: {
        select: { id: true, title: true, category: true, estimatedMinutes: true },
      },
    },
    orderBy: { startedAt: 'desc' },
  })

  return progress
}
