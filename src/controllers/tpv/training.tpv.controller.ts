// src/controllers/tpv/training.tpv.controller.ts
import { Request, Response, NextFunction } from 'express'
import * as trainingService from '../../services/superadmin/training.service'
import logger from '../../config/logger'

/**
 * GET /api/v1/tpv/trainings
 * List available trainings (auto-filtered by org modules)
 */
export async function getTrainings(req: Request, res: Response, next: NextFunction) {
  try {
    const authContext = (req as any).authContext
    const venueId = authContext.venueId

    if (!venueId) {
      return res.status(400).json({ success: false, error: 'Venue ID required' })
    }

    const trainings = await trainingService.getTrainingsForTpv(venueId)

    res.json({
      success: true,
      data: trainings,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/tpv/trainings/:trainingId
 * Get training detail with steps + quiz
 */
export async function getTrainingDetail(req: Request, res: Response, next: NextFunction) {
  try {
    const { trainingId } = req.params
    const training = await trainingService.getTrainingDetailForTpv(trainingId)

    res.json({
      success: true,
      data: training,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/tpv/trainings/:trainingId/progress
 * Update progress for current staff member
 */
export async function updateProgress(req: Request, res: Response, next: NextFunction) {
  try {
    const authContext = (req as any).authContext
    const { trainingId } = req.params
    const { staffId, lastStepViewed, isCompleted, quizScore, quizTotal, quizPassed } = req.body

    const resolvedStaffId = staffId || authContext.userId
    const venueId = authContext.venueId

    if (!venueId) {
      return res.status(400).json({ success: false, error: 'Venue ID required' })
    }

    const progress = await trainingService.updateProgress(trainingId, resolvedStaffId, venueId, {
      lastStepViewed,
      isCompleted,
      quizScore,
      quizTotal,
      quizPassed,
    })

    res.json({
      success: true,
      data: progress,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/tpv/trainings/progress
 * Get all progress for current staff member
 */
export async function getStaffProgress(req: Request, res: Response, next: NextFunction) {
  try {
    const { staffId } = req.query
    const authContext = (req as any).authContext
    const resolvedStaffId = (staffId as string) || authContext.userId

    const progress = await trainingService.getStaffProgress(resolvedStaffId)

    res.json({
      success: true,
      data: progress,
    })
  } catch (error) {
    next(error)
  }
}
