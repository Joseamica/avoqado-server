// src/routes/superadmin/training.routes.ts
import { Router } from 'express'
import multer from 'multer'
import * as trainingController from '../../controllers/superadmin/training.superadmin.controller'
import { validateRequest } from '../../middlewares/validation'
import {
  listTrainingsQuerySchema,
  trainingIdParamSchema,
  createTrainingSchema,
  updateTrainingSchema,
  createStepSchema,
  updateStepSchema,
  trainingStepIdParamSchema,
  createQuizQuestionSchema,
  updateQuizQuestionSchema,
  trainingQuestionIdParamSchema,
} from '../../schemas/superadmin/training.schema'

const router = Router()

// Configure multer for training media uploads (memory storage, max 50MB)
const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max
  },
  fileFilter: (_req, file, cb) => {
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime']
    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error('Only JPEG, PNG, WebP images and MP4/MOV videos are allowed'))
    }
  },
})

// ===== TRAINING MODULES CRUD =====

// List all trainings (with filters)
router.get('/', validateRequest(listTrainingsQuerySchema), trainingController.listTrainings)

// Create training module
router.post('/', validateRequest(createTrainingSchema), trainingController.createTraining)

// Upload media file
router.post('/upload', mediaUpload.single('file'), trainingController.uploadMedia)

// Get single training detail
router.get('/:trainingId', validateRequest(trainingIdParamSchema), trainingController.getTraining)

// Update training module
router.patch('/:trainingId', validateRequest(updateTrainingSchema), trainingController.updateTraining)

// Delete training module
router.delete('/:trainingId', validateRequest(trainingIdParamSchema), trainingController.deleteTraining)

// ===== STEPS =====

// Add step
router.post('/:trainingId/steps', validateRequest(createStepSchema), trainingController.addStep)

// Update step
router.patch('/:trainingId/steps/:stepId', validateRequest(updateStepSchema), trainingController.updateStep)

// Delete step
router.delete('/:trainingId/steps/:stepId', validateRequest(trainingStepIdParamSchema), trainingController.deleteStep)

// ===== QUIZ =====

// Add quiz question
router.post('/:trainingId/quiz', validateRequest(createQuizQuestionSchema), trainingController.addQuizQuestion)

// Update quiz question
router.patch('/:trainingId/quiz/:questionId', validateRequest(updateQuizQuestionSchema), trainingController.updateQuizQuestion)

// Delete quiz question
router.delete('/:trainingId/quiz/:questionId', validateRequest(trainingQuestionIdParamSchema), trainingController.deleteQuizQuestion)

// ===== PROGRESS STATS =====

// Get completion stats
router.get('/:trainingId/progress', validateRequest(trainingIdParamSchema), trainingController.getProgress)

export default router
