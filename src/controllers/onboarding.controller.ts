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

    // FAANG Pattern (Approach B): Do NOT set cookies on signup
    // User must verify email first before getting authenticated
    // This prevents bot accounts and ensures email validity
    // Cookies will be set after successful email verification

    logger.info(`New user signup (pending verification): ${result.staff.email}, org: ${result.organization.name}`)

    res.status(201).json({
      success: true,
      message: 'Account created successfully. Please verify your email to continue.',
      staff: result.staff,
      organization: result.organization,
    })
  } catch (error) {
    logger.error('Error during signup:', error)
    next(error)
  }
}

/**
 * POST /api/v1/onboarding/verify-email
 *
 * Verifies user email with 6-digit PIN code and auto-login
 * FAANG Pattern (Approach B): Tokens are generated ONLY after email verification
 */
export async function verifyEmail(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { email, verificationCode } = req.body

    if (!email || !verificationCode) {
      throw new BadRequestError('Email and verification code are required')
    }

    // Verify email and get tokens for auto-login
    const result = await signupService.verifyEmailCode(email, verificationCode)

    // Set auth cookies after successful verification (auto-login)
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

    logger.info(`Email verified and user auto-logged in: ${email}`)

    res.status(200).json({
      success: true,
      message: 'Email verified successfully. You are now logged in.',
      emailVerified: result.emailVerified,
    })
  } catch (error) {
    logger.error('Error during email verification:', error)
    next(error)
  }
}

/**
 * POST /api/v1/onboarding/resend-verification
 *
 * Resends verification code to user's email
 */
export async function resendVerification(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { email } = req.body

    if (!email) {
      throw new BadRequestError('Email is required')
    }

    const result = await signupService.resendVerificationCode(email)

    logger.info(`Verification code resent successfully to: ${email}`)

    res.status(200).json({
      success: true,
      message: result.message,
    })
  } catch (error) {
    logger.error('Error resending verification code:', error)
    next(error)
  }
}

/**
 * GET /api/v1/onboarding/email-status
 *
 * Checks if an email exists and is verified (public endpoint)
 */
export async function getEmailStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { email } = req.query

    if (!email || typeof email !== 'string') {
      throw new BadRequestError('Email is required')
    }

    const result = await signupService.checkEmailVerificationStatus(email)

    res.status(200).json({
      emailExists: result.emailExists,
      emailVerified: result.emailVerified,
    })
  } catch (error) {
    logger.error('Error checking email status:', error)
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

    logger.info(`🎯 Step 6: Saving selected features for organization ${organizationId}:`, {
      selectedFeatures,
      count: selectedFeatures?.length || 0,
    })

    const progress = await onboardingProgressService.updateOnboardingStep(organizationId, 6, {
      step6_selectedFeatures: selectedFeatures,
    })

    logger.info(`✅ Step 6 completed for organization: ${organizationId}`, {
      savedFeatures: progress.step6_selectedFeatures,
    })

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
    const { stripePaymentMethodId } = req.body // Payment method from Stripe Elements
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

    // Log payment method and features before creating venue
    logger.info(`🎯 Completing onboarding for organization ${organizationId}:`, {
      stripePaymentMethodId: stripePaymentMethodId || 'none',
      selectedFeatures: progress.step6_selectedFeatures || [],
      featuresCount: (progress.step6_selectedFeatures || []).length,
      onboardingType: progress.step2_onboardingType,
    })

    // Prepare venue creation input
    const venueInput: venueCreationService.CreateVenueInput = {
      organizationId,
      userId: authContext.userId, // Pass userId to create StaffVenue
      onboardingType: progress.step2_onboardingType,
      businessInfo: progress.step3_businessInfo as any,
      menuData: progress.step4_menuData as any,
      paymentInfo: progress.step7_paymentInfo as any,
      selectedFeatures: progress.step6_selectedFeatures || [],
      stripePaymentMethodId, // Pass payment method for trial setup
      teamInvites: progress.step5_teamInvites as any, // Pass team invites for processing
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
