// src/controllers/superadmin/training.superadmin.controller.ts
import { Request, Response, NextFunction } from 'express'
import * as trainingService from '../../services/superadmin/training.service'
import { uploadFileToStorage, buildStoragePath } from '../../services/storage.service'
import logger from '../../config/logger'
import { v4 as uuidv4 } from 'uuid'
import path from 'path'

/**
 * GET /api/v1/superadmin/trainings
 * List all training modules with filters
 */
export async function listTrainings(req: Request, res: Response, next: NextFunction) {
  try {
    const { status, category, organizationId, search, page, limit } = req.query

    const result = await trainingService.listTrainingModules({
      status: status as any,
      category: category as any,
      organizationId: organizationId as string,
      search: search as string,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    })

    res.json({
      success: true,
      data: result.trainings,
      pagination: result.pagination,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/superadmin/trainings/:trainingId
 * Get training detail with steps and quiz
 */
export async function getTraining(req: Request, res: Response, next: NextFunction) {
  try {
    const { trainingId } = req.params
    const training = await trainingService.getTrainingModule(trainingId)

    res.json({
      success: true,
      data: training,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/superadmin/trainings
 * Create a training module
 */
export async function createTraining(req: Request, res: Response, next: NextFunction) {
  try {
    const authContext = (req as any).authContext
    const training = await trainingService.createTrainingModule({
      ...req.body,
      createdBy: authContext.userId,
      createdByName: authContext.name || 'SuperAdmin',
    })

    res.status(201).json({
      success: true,
      data: training,
      message: `Training module "${training.title}" created successfully`,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * PATCH /api/v1/superadmin/trainings/:trainingId
 * Update a training module
 */
export async function updateTraining(req: Request, res: Response, next: NextFunction) {
  try {
    const { trainingId } = req.params
    const training = await trainingService.updateTrainingModule(trainingId, req.body)

    res.json({
      success: true,
      data: training,
      message: `Training module "${training.title}" updated successfully`,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * DELETE /api/v1/superadmin/trainings/:trainingId
 * Delete a training module
 */
export async function deleteTraining(req: Request, res: Response, next: NextFunction) {
  try {
    const { trainingId } = req.params
    await trainingService.deleteTrainingModule(trainingId)

    res.json({
      success: true,
      message: 'Training module deleted successfully',
    })
  } catch (error) {
    next(error)
  }
}

// ===== STEPS =====

/**
 * POST /api/v1/superadmin/trainings/:trainingId/steps
 */
export async function addStep(req: Request, res: Response, next: NextFunction) {
  try {
    const { trainingId } = req.params
    const step = await trainingService.addStep(trainingId, req.body)

    res.status(201).json({
      success: true,
      data: step,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * PATCH /api/v1/superadmin/trainings/:trainingId/steps/:stepId
 */
export async function updateStep(req: Request, res: Response, next: NextFunction) {
  try {
    const { trainingId, stepId } = req.params
    const step = await trainingService.updateStep(trainingId, stepId, req.body)

    res.json({
      success: true,
      data: step,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * DELETE /api/v1/superadmin/trainings/:trainingId/steps/:stepId
 */
export async function deleteStep(req: Request, res: Response, next: NextFunction) {
  try {
    const { trainingId, stepId } = req.params
    await trainingService.deleteStep(trainingId, stepId)

    res.json({
      success: true,
      message: 'Step deleted and remaining steps re-numbered',
    })
  } catch (error) {
    next(error)
  }
}

// ===== QUIZ =====

/**
 * POST /api/v1/superadmin/trainings/:trainingId/quiz
 */
export async function addQuizQuestion(req: Request, res: Response, next: NextFunction) {
  try {
    const { trainingId } = req.params
    const question = await trainingService.addQuizQuestion(trainingId, req.body)

    res.status(201).json({
      success: true,
      data: question,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * PATCH /api/v1/superadmin/trainings/:trainingId/quiz/:questionId
 */
export async function updateQuizQuestion(req: Request, res: Response, next: NextFunction) {
  try {
    const { trainingId, questionId } = req.params
    const question = await trainingService.updateQuizQuestion(trainingId, questionId, req.body)

    res.json({
      success: true,
      data: question,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * DELETE /api/v1/superadmin/trainings/:trainingId/quiz/:questionId
 */
export async function deleteQuizQuestion(req: Request, res: Response, next: NextFunction) {
  try {
    const { trainingId, questionId } = req.params
    await trainingService.deleteQuizQuestion(trainingId, questionId)

    res.json({
      success: true,
      message: 'Quiz question deleted',
    })
  } catch (error) {
    next(error)
  }
}

// ===== MEDIA UPLOAD =====

/**
 * POST /api/v1/superadmin/trainings/upload
 * Upload media file to Firebase Storage
 */
export async function uploadMedia(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file provided' })
    }

    const { trainingId } = req.body
    const { buffer, mimetype, originalname, size } = req.file

    const ext = path.extname(originalname).toLowerCase()
    const fileName = `${uuidv4()}${ext}`
    const folder = trainingId ? `trainings/${trainingId}` : 'trainings/temp'
    const filePath = buildStoragePath(`${folder}/${fileName}`)

    const url = await uploadFileToStorage(buffer, filePath, mimetype)

    logger.info('Training media uploaded', { filePath, size, mimetype })

    res.status(201).json({
      success: true,
      data: {
        url,
        fileName,
        mimetype,
        size,
      },
    })
  } catch (error) {
    next(error)
  }
}

// ===== PROGRESS STATS =====

/**
 * GET /api/v1/superadmin/trainings/:trainingId/progress
 */
export async function getProgress(req: Request, res: Response, next: NextFunction) {
  try {
    const { trainingId } = req.params
    const result = await trainingService.getTrainingProgress(trainingId)

    res.json({
      success: true,
      data: result,
    })
  } catch (error) {
    next(error)
  }
}
