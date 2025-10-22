/**
 * Onboarding Controller
 *
 * Handles HTTP requests for the multi-step onboarding wizard.
 * This controller orchestrates venue creation for new organizations.
 */

import { Request, Response, NextFunction } from 'express'
import * as onboardingProgressService from '../services/onboarding/onboardingProgress.service'
import * as venueCreationService from '../services/onboarding/venueCreation.service'
import * as signupService from '../services/onboarding/signup.service'
import { generateMenuCSVTemplate, parseMenuCSV } from '../utils/menuCsvParser'
import { validateCLABE } from '../utils/clabeValidator'
import logger from '../config/logger'
import { BadRequestError, NotFoundError } from '../errors/AppError'

/**
 * POST /api/v1/onboarding/signup
 *
 * Creates a new user account with organization
 */
export async function signup(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const signupData = req.body

    const result = await signupService.signupUser(signupData)

    // Set cookies (same as login)
    res.cookie('accessToken', result.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging',
      sameSite: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging' ? 'none' : 'lax',
      maxAge: 15 * 60 * 1000, // 15 minutes
      path: '/',
    })

    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging',
      sameSite: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging' ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: '/',
    })

    logger.info(`New user signup: ${result.staff.email}, org: ${result.organization.name}`)

    res.status(201).json({
      success: true,
      message: 'Account created successfully',
      staff: result.staff,
      organization: result.organization,
    })
  } catch (error) {
    logger.error('Error during signup:', error)
    next(error)
  }
}

/**
 * POST /api/v1/onboarding/organizations/:organizationId/start
 *
 * Initializes onboarding progress for an organization
 */
export async function startOnboarding(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { organizationId } = req.params

    const progress = await onboardingProgressService.getOrCreateOnboardingProgress(organizationId)

    logger.info(`Onboarding started for organization: ${organizationId}`)

    res.status(200).json({
      message: 'Onboarding initialized successfully',
      progress: {
        id: progress.id,
        currentStep: progress.currentStep,
        completedSteps: progress.completedSteps,
        startedAt: progress.startedAt,
      },
    })
  } catch (error) {
    logger.error('Error starting onboarding:', error)
    next(error)
  }
}

/**
 * GET /api/v1/onboarding/organizations/:organizationId/progress
 *
 * Retrieves current onboarding progress
 */
export async function getOnboardingProgress(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { organizationId } = req.params

    const progress = await onboardingProgressService.getOnboardingProgress(organizationId)

    if (!progress) {
      throw new NotFoundError('Onboarding progress not found for this organization')
    }

    const completionPercentage = await onboardingProgressService.getOnboardingCompletionPercentage(organizationId)

    res.status(200).json({
      progress: {
        id: progress.id,
        currentStep: progress.currentStep,
        completedSteps: progress.completedSteps,
        completionPercentage,
        startedAt: progress.startedAt,
        completedAt: progress.completedAt,
        // Step data (sanitized - don't expose sensitive info)
        step1_userInfo: progress.step1_userInfo,
        step2_onboardingType: progress.step2_onboardingType,
        step3_businessInfo: progress.step3_businessInfo,
        step4_menuData: progress.step4_menuData,
        step5_teamInvites: progress.step5_teamInvites,
        step6_selectedFeatures: progress.step6_selectedFeatures,
        // Don't expose step7_paymentInfo for security
      },
    })
  } catch (error) {
    logger.error('Error getting onboarding progress:', error)
    next(error)
  }
}

/**
 * PUT /api/v1/onboarding/organizations/:organizationId/step/1
 *
 * Updates Step 1: User Info
 */
export async function updateStep1(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { organizationId } = req.params
    const { email, firstName, lastName, phone } = req.body

    const progress = await onboardingProgressService.updateOnboardingStep(organizationId, 1, {
      step1_userInfo: { email, firstName, lastName, phone },
    })

    logger.info(`Step 1 completed for organization: ${organizationId}`)

    res.status(200).json({
      message: 'Step 1 completed successfully',
      currentStep: progress.currentStep,
    })
  } catch (error) {
    logger.error('Error updating Step 1:', error)
    next(error)
  }
}

/**
 * PUT /api/v1/onboarding/organizations/:organizationId/step/2
 *
 * Updates Step 2: Onboarding Type (Demo vs Real)
 */
export async function updateStep2(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { organizationId } = req.params
    const { onboardingType } = req.body

    const progress = await onboardingProgressService.updateOnboardingStep(organizationId, 2, {
      step2_onboardingType: onboardingType,
    })

    logger.info(`Step 2 completed for organization: ${organizationId}, type: ${onboardingType}`)

    res.status(200).json({
      message: 'Step 2 completed successfully',
      currentStep: progress.currentStep,
    })
  } catch (error) {
    logger.error('Error updating Step 2:', error)
    next(error)
  }
}

/**
 * PUT /api/v1/onboarding/organizations/:organizationId/step/3
 *
 * Updates Step 3: Business Info
 */
export async function updateStep3(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { organizationId } = req.params
    const businessInfo = req.body

    const progress = await onboardingProgressService.updateOnboardingStep(organizationId, 3, {
      step3_businessInfo: businessInfo,
    })

    logger.info(`Step 3 completed for organization: ${organizationId}`)

    res.status(200).json({
      message: 'Step 3 completed successfully',
      currentStep: progress.currentStep,
    })
  } catch (error) {
    logger.error('Error updating Step 3:', error)
    next(error)
  }
}

/**
 * PUT /api/v1/onboarding/organizations/:organizationId/step/4
 *
 * Updates Step 4: Menu Data (manual entry)
 */
export async function updateStep4(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { organizationId } = req.params
    const menuData = req.body

    const progress = await onboardingProgressService.updateOnboardingStep(organizationId, 4, {
      step4_menuData: menuData,
    })

    logger.info(`Step 4 completed for organization: ${organizationId}`)

    res.status(200).json({
      message: 'Step 4 completed successfully',
      currentStep: progress.currentStep,
    })
  } catch (error) {
    logger.error('Error updating Step 4:', error)
    next(error)
  }
}

/**
 * POST /api/v1/onboarding/organizations/:organizationId/upload-menu-csv
 *
 * Uploads and validates a CSV file for menu import (Step 4 alternative)
 */
export async function uploadMenuCSV(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { organizationId } = req.params

    // Check if file was uploaded (using multer middleware)
    if (!req.file) {
      throw new BadRequestError('No CSV file uploaded')
    }

    const fileBuffer = req.file.buffer
    const parseResult = await parseMenuCSV(fileBuffer)

    // Check for parsing errors
    if (parseResult.errors.length > 0) {
      res.status(400).json({
        message: 'CSV validation failed',
        errors: parseResult.errors,
        warnings: parseResult.warnings,
        validRows: parseResult.validRows,
        totalRows: parseResult.totalRows,
      })
      return
    }

    // Save menu data to onboarding progress
    const progress = await onboardingProgressService.updateOnboardingStep(organizationId, 4, {
      step4_menuData: {
        method: 'csv',
        categories: parseResult.categories,
        products: parseResult.products,
      },
    })

    logger.info(`Menu CSV uploaded for organization: ${organizationId}, ${parseResult.validRows} products`)

    res.status(200).json({
      message: 'CSV uploaded and validated successfully',
      currentStep: progress.currentStep,
      summary: {
        categoriesCreated: parseResult.categories.length,
        productsCreated: parseResult.products.length,
        warnings: parseResult.warnings,
      },
    })
  } catch (error) {
    logger.error('Error uploading menu CSV:', error)
    next(error)
  }
}

/**
 * GET /api/v1/onboarding/menu-template
 *
 * Downloads a CSV template for menu import
 */
export function getMenuTemplate(req: Request, res: Response, next: NextFunction): void {
  try {
    const csvTemplate = generateMenuCSVTemplate()

    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="menu-template.csv"')
    res.status(200).send(csvTemplate)

    logger.info('Menu CSV template downloaded')
  } catch (error) {
    logger.error('Error generating menu template:', error)
    next(error)
  }
}

/**
 * PUT /api/v1/onboarding/organizations/:organizationId/step/5
 *
 * Updates Step 5: Team Invites (optional)
 */
export async function updateStep5(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { organizationId } = req.params
    const { teamInvites } = req.body

    const progress = await onboardingProgressService.updateOnboardingStep(organizationId, 5, {
      step5_teamInvites: teamInvites,
    })

    logger.info(`Step 5 completed for organization: ${organizationId}, ${teamInvites.length} invites`)

    res.status(200).json({
      message: 'Step 5 completed successfully',
      currentStep: progress.currentStep,
    })
  } catch (error) {
    logger.error('Error updating Step 5:', error)
    next(error)
  }
}

/**
 * PUT /api/v1/onboarding/organizations/:organizationId/step/6
 *
 * Updates Step 6: Selected Premium Features
 */
export async function updateStep6(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { organizationId } = req.params
    const { selectedFeatures } = req.body

    const progress = await onboardingProgressService.updateOnboardingStep(organizationId, 6, {
      step6_selectedFeatures: selectedFeatures,
    })

    logger.info(`Step 6 completed for organization: ${organizationId}`)

    res.status(200).json({
      message: 'Step 6 completed successfully',
      currentStep: progress.currentStep,
    })
  } catch (error) {
    logger.error('Error updating Step 6:', error)
    next(error)
  }
}

/**
 * PUT /api/v1/onboarding/organizations/:organizationId/step/7
 *
 * Updates Step 7: CLABE Payment Info
 */
export async function updateStep7(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { organizationId } = req.params
    const { clabe, bankName, accountHolder } = req.body

    // Validate CLABE using our validator
    if (!validateCLABE(clabe)) {
      throw new BadRequestError('Invalid CLABE. Please check the number and try again.')
    }

    const progress = await onboardingProgressService.updateOnboardingStep(organizationId, 7, {
      step7_paymentInfo: { clabe, bankName, accountHolder },
    })

    logger.info(`Step 7 completed for organization: ${organizationId}`)

    res.status(200).json({
      message: 'Step 7 completed successfully',
      currentStep: progress.currentStep,
    })
  } catch (error) {
    logger.error('Error updating Step 7:', error)
    next(error)
  }
}

/**
 * POST /api/v1/onboarding/organizations/:organizationId/complete
 *
 * Completes onboarding and creates the venue
 */
export async function completeOnboarding(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { organizationId } = req.params
    const authContext = (req as any).authContext

    if (!authContext || !authContext.userId) {
      throw new BadRequestError('User authentication required')
    }

    // Get full onboarding progress
    const progress = await onboardingProgressService.getOnboardingProgress(organizationId)

    if (!progress) {
      throw new NotFoundError('Onboarding progress not found')
    }

    // Validate required steps completed
    if (!progress.step2_onboardingType) {
      throw new BadRequestError('Step 2 (Onboarding Type) must be completed')
    }

    if (!progress.step3_businessInfo) {
      throw new BadRequestError('Step 3 (Business Info) must be completed')
    }

    // Prepare venue creation input
    const venueInput: venueCreationService.CreateVenueInput = {
      organizationId,
      userId: authContext.userId, // Pass userId to create StaffVenue
      onboardingType: progress.step2_onboardingType,
      businessInfo: progress.step3_businessInfo as any,
      menuData: progress.step4_menuData as any,
      paymentInfo: progress.step7_paymentInfo as any,
      selectedFeatures: progress.step6_selectedFeatures || [],
    }

    // Create venue and assign to user
    const result = await venueCreationService.createVenueFromOnboarding(venueInput)

    // Mark onboarding as complete
    await onboardingProgressService.completeOnboarding(organizationId)

    logger.info(`✅ Onboarding completed for organization: ${organizationId}, venue: ${result.venue.id}, user: ${authContext.userId}`)

    res.status(201).json({
      message: 'Onboarding completed successfully',
      venue: result.venue,
      summary: {
        categoriesCreated: result.categoriesCreated,
        productsCreated: result.productsCreated,
        demoDataSeeded: result.demoDataSeeded,
      },
    })
  } catch (error) {
    logger.error('Error completing onboarding:', error)
    next(error)
  }
}
