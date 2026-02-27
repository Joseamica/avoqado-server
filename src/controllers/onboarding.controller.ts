/**
 * Onboarding Controller
 *
 * Handles HTTP requests for the multi-step onboarding wizard.
 * This controller orchestrates venue creation for new organizations.
 */

import { Request, Response, NextFunction } from 'express'
import { EntityType, VenueType } from '@prisma/client'
import * as onboardingProgressService from '../services/onboarding/onboardingProgress.service'
import * as venueCreationService from '../services/onboarding/venueCreation.service'
import * as signupService from '../services/onboarding/signup.service'
import { createOnboardingSetupIntent } from '../services/stripe.service'
import { generateMenuCSVTemplate, parseMenuCSV } from '../utils/menuCsvParser'
import { validateCLABE } from '../utils/clabeValidator'
import logger from '../config/logger'
import { BadRequestError, NotFoundError } from '../errors/AppError'
import prisma from '../utils/prismaClient'

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

    // Cookie maxAge must match JWT expiration (24h default for onboarding)
    const accessTokenMaxAge = 24 * 60 * 60 * 1000 // 24 hours
    const refreshTokenMaxAge = 7 * 24 * 60 * 60 * 1000 // 7 days

    // Set auth cookies after successful verification (auto-login)
    res.cookie('accessToken', result.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging',
      sameSite: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging' ? 'none' : 'lax',
      maxAge: accessTokenMaxAge,
      path: '/',
    })

    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging',
      sameSite: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging' ? 'none' : 'lax',
      maxAge: refreshTokenMaxAge,
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
        step7_kycDocuments: progress.step7_kycDocuments,
        wizardVersion: progress.wizardVersion,
        v2SetupData: progress.v2SetupData,
        // Don't expose step8_paymentInfo for security (contains CLABE)
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
 * POST /api/v1/onboarding/setup-intent
 *
 * Creates a Stripe SetupIntent for onboarding (no customer yet)
 * Used to validate card details before venue creation
 */
export async function createSetupIntent(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const clientSecret = await createOnboardingSetupIntent()

    logger.info('✅ Created onboarding SetupIntent for card validation')

    res.status(200).json({
      success: true,
      data: {
        clientSecret,
      },
    })
  } catch (error) {
    logger.error('Error creating onboarding SetupIntent:', error)
    next(error)
  }
}

/**
 * PUT /api/v1/onboarding/organizations/:organizationId/step/7
 *
 * Updates Step 7: KYC Documents
 */
export async function updateStep7(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { organizationId } = req.params
    const { entityType, documents } = req.body

    const progress = await onboardingProgressService.updateOnboardingStep(organizationId, 7, {
      step7_kycDocuments: { entityType, documents },
    })

    logger.info(`Step 7 (KYC Documents) completed for organization: ${organizationId}`)

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
 * PUT /api/v1/onboarding/organizations/:organizationId/kyc/document/:documentKey
 *
 * Uploads a single KYC document during onboarding
 */
export async function uploadKycDocument(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { organizationId, documentKey } = req.params
    const file = req.file as Express.Multer.File

    if (!file) {
      throw new BadRequestError('No document provided')
    }

    // Valid document keys
    const validDocumentKeys = ['ine', 'rfcDocument', 'comprobanteDomicilio', 'caratulaBancaria', 'actaDocument', 'poderLegal']
    if (!validDocumentKeys.includes(documentKey)) {
      throw new BadRequestError(`Invalid document key: ${documentKey}. Valid keys are: ${validDocumentKeys.join(', ')}`)
    }

    const result = await onboardingProgressService.uploadKycDocument(organizationId, documentKey, {
      buffer: file.buffer,
      originalname: file.originalname,
      mimetype: file.mimetype,
    })

    logger.info(`KYC document uploaded for organization ${organizationId}: ${documentKey}`)

    res.status(200).json({
      success: true,
      message: 'Document uploaded successfully',
      data: {
        documentKey: result.documentKey,
        url: result.url,
      },
    })
  } catch (error) {
    logger.error('Error uploading KYC document:', error)
    next(error)
  }
}

/**
 * PUT /api/v1/onboarding/organizations/:organizationId/step/8
 *
 * Updates Step 8: CLABE Payment Info
 */
export async function updateStep8(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { organizationId } = req.params
    const { clabe, bankName, accountHolder } = req.body

    // Validate CLABE using our validator
    if (!validateCLABE(clabe)) {
      throw new BadRequestError('Invalid CLABE. Please check the number and try again.')
    }

    const progress = await onboardingProgressService.updateOnboardingStep(organizationId, 8, {
      step8_paymentInfo: { clabe, bankName, accountHolder },
    })

    logger.info(`Step 8 (Payment Info) completed for organization: ${organizationId}`)

    res.status(200).json({
      message: 'Step 8 completed successfully',
      currentStep: progress.currentStep,
    })
  } catch (error) {
    logger.error('Error updating Step 8:', error)
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

    // OPTIMISTIC LOCKING: Atomically mark as completing BEFORE creating venue
    // This prevents race condition where double-click creates 2 venues
    const lockResult = await prisma.onboardingProgress.updateMany({
      where: {
        organizationId,
        completedAt: null, // Only update if not already completed
      },
      data: {
        completedAt: new Date(),
      },
    })

    // If no rows updated, another request already completed onboarding
    if (lockResult.count === 0) {
      const existingVenue = await prisma.venue.findFirst({
        where: { organizationId },
        select: { id: true, slug: true, name: true, status: true },
      })

      if (existingVenue) {
        logger.info(
          `⚠️ Onboarding already completed (race condition prevented) for organization ${organizationId}, returning existing venue ${existingVenue.id}`,
        )
        res.status(200).json({
          message: 'Onboarding already completed',
          venue: existingVenue,
          summary: {
            categoriesCreated: 0,
            productsCreated: 0,
            demoDataSeeded: false,
          },
        })
        return
      }

      // Rare edge case: completedAt is set but no venue exists
      // This could happen if previous venue creation failed after setting completedAt
      // Reset the lock and let them retry
      logger.warn(`⚠️ Onboarding marked complete but no venue found for organization ${organizationId} - resetting lock`)
      await prisma.onboardingProgress.update({
        where: { organizationId },
        data: { completedAt: null },
      })
      throw new BadRequestError('Previous onboarding attempt failed. Please try again.')
    }

    logger.info(`🔒 Acquired onboarding lock for organization ${organizationId}`)

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
      kycDocuments: progress.step7_kycDocuments as any, // KYC documents from step 7
      paymentInfo: progress.step8_paymentInfo as any, // Payment info from step 8
      selectedFeatures: progress.step6_selectedFeatures || [],
      stripePaymentMethodId, // Pass payment method for trial setup
      teamInvites: progress.step5_teamInvites as any, // Pass team invites for processing
    }

    // Create venue and assign to user
    // If this fails, we need to release the lock (rollback completedAt)
    let result: Awaited<ReturnType<typeof venueCreationService.createVenueFromOnboarding>>
    try {
      result = await venueCreationService.createVenueFromOnboarding(venueInput)
    } catch (venueError) {
      // Rollback: Reset completedAt so user can retry
      logger.error(`❌ Venue creation failed for organization ${organizationId} - rolling back lock`, venueError)
      await prisma.onboardingProgress.update({
        where: { organizationId },
        data: { completedAt: null },
      })
      throw venueError
    }

    // No need to call completeOnboarding - we already set completedAt above

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

/**
 * GET /api/v1/onboarding/status
 *
 * Returns the current user's primary organization and onboarding progress.
 * Used by the V2 SetupWizard to restore state and get orgId.
 */
export async function getOnboardingStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const staffId = (req as any).user?.sub || (req as any).user?.id
    if (!staffId) {
      res.status(401).json({ message: 'Not authenticated' })
      return
    }

    // Find the user's primary organization
    const staffOrg = await prisma.staffOrganization.findFirst({
      where: { staffId, isPrimary: true, isActive: true },
      include: {
        organization: {
          select: { id: true, name: true, slug: true, onboardingCompletedAt: true },
        },
      },
    })

    if (!staffOrg?.organization) {
      res.status(404).json({ message: 'No organization found' })
      return
    }

    const org = staffOrg.organization

    // Get onboarding progress
    const progress = await prisma.onboardingProgress.findUnique({
      where: { organizationId: org.id },
    })

    res.status(200).json({
      organization: org,
      onboardingProgress: progress,
    })
  } catch (error) {
    next(error)
  }
}

// =============================================
// V2 Setup Wizard Controllers
// =============================================

/**
 * PUT /api/v1/onboarding/organizations/:organizationId/v2/step/:stepNumber
 *
 * Saves V2 step data
 */
export async function saveV2Step(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { organizationId, stepNumber } = req.params
    const stepData = req.body
    const step = parseInt(stepNumber, 10)

    // Per-step validation for critical fields
    if (step === 2) {
      if (!stepData.businessName || typeof stepData.businessName !== 'string' || stepData.businessName.trim().length === 0) {
        throw new BadRequestError('El nombre del negocio es requerido')
      }
    }

    if (step === 3) {
      if (!stepData.businessType || typeof stepData.businessType !== 'string') {
        throw new BadRequestError('El tipo de negocio es requerido')
      }
      if (!Object.values(VenueType).includes(stepData.businessType as VenueType)) {
        throw new BadRequestError(`Tipo de negocio invalido: ${stepData.businessType}`)
      }
    }

    if (step === 4) {
      if (!stepData.entityType || typeof stepData.entityType !== 'string') {
        throw new BadRequestError('El tipo de entidad es requerido')
      }
      // entitySubType should be the parent EntityType enum value
      if (stepData.entitySubType && !Object.values(EntityType).includes(stepData.entitySubType as EntityType)) {
        throw new BadRequestError(`Tipo de entidad padre invalido: ${stepData.entitySubType}`)
      }
    }

    if (step === 5) {
      if (!stepData.legalFirstName || typeof stepData.legalFirstName !== 'string' || stepData.legalFirstName.trim().length === 0) {
        throw new BadRequestError('El nombre legal es requerido')
      }
      if (!stepData.legalLastName || typeof stepData.legalLastName !== 'string' || stepData.legalLastName.trim().length === 0) {
        throw new BadRequestError('El apellido legal es requerido')
      }
    }

    if (step === 7) {
      if (!stepData.clabe || typeof stepData.clabe !== 'string') {
        throw new BadRequestError('La CLABE es requerida')
      }
      if (!/^\d{18}$/.test(stepData.clabe)) {
        throw new BadRequestError('La CLABE debe tener exactamente 18 digitos')
      }
      if (!validateCLABE(stepData.clabe)) {
        throw new BadRequestError('La CLABE es invalida (checksum incorrecto)')
      }
      if (!stepData.accountHolder || typeof stepData.accountHolder !== 'string' || stepData.accountHolder.trim().length === 0) {
        throw new BadRequestError('El nombre del titular es requerido')
      }
    }

    const progress = await onboardingProgressService.saveV2StepData(organizationId, step, stepData)

    logger.info(`V2 Step ${stepNumber} saved for organization: ${organizationId}`)

    res.status(200).json({
      success: true,
      message: `Step ${stepNumber} saved successfully`,
      currentStep: progress.currentStep,
    })
  } catch (error) {
    logger.error('Error saving V2 step:', error)
    next(error)
  }
}

/**
 * POST /api/v1/onboarding/organizations/:organizationId/v2/accept-terms
 *
 * Records terms acceptance
 */
export async function acceptV2Terms(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { organizationId } = req.params
    const { termsVersion } = req.body
    const ipAddress = req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown'

    const progress = await onboardingProgressService.acceptV2Terms(organizationId, termsVersion, ipAddress)

    logger.info(`V2 Terms accepted for organization: ${organizationId}`)

    res.status(200).json({
      success: true,
      message: 'Terms accepted successfully',
      currentStep: progress.currentStep,
    })
  } catch (error) {
    logger.error('Error accepting V2 terms:', error)
    next(error)
  }
}

/**
 * POST /api/v1/onboarding/organizations/:organizationId/v2/complete
 *
 * Completes V2 onboarding — creates venue from v2SetupData
 * Uses same optimistic-locking pattern as v1 to prevent double venue creation.
 */
export async function completeV2Onboarding(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { organizationId } = req.params
    const authContext = (req as any).authContext

    if (!authContext || !authContext.userId) {
      throw new BadRequestError('User authentication required')
    }

    // Extract and validate v2 setup data
    const { businessInfo, bankInfo, identityInfo, entityInfo } = await onboardingProgressService.getV2SetupDataForCompletion(organizationId)

    // OPTIMISTIC LOCKING: Atomically mark as completing BEFORE creating venue
    // This prevents race condition where double-click creates 2 venues
    const lockResult = await prisma.onboardingProgress.updateMany({
      where: {
        organizationId,
        completedAt: null, // Only update if not already completed
      },
      data: {
        completedAt: new Date(),
        currentStep: 7,
      },
    })

    // If no rows updated, another request already completed onboarding
    if (lockResult.count === 0) {
      const existingVenue = await prisma.venue.findFirst({
        where: { organizationId },
        select: { id: true, slug: true, name: true, status: true },
      })

      if (existingVenue) {
        logger.info(
          `⚠️ V2 Onboarding already completed (race condition prevented) for organization ${organizationId}, returning existing venue ${existingVenue.id}`,
        )
        res.status(200).json({
          success: true,
          message: 'Setup already completed',
          venue: existingVenue,
        })
        return
      }

      // Rare edge case: completedAt is set but no venue exists — reset lock
      logger.warn(`⚠️ V2 Onboarding marked complete but no venue found for organization ${organizationId} - resetting lock`)
      await prisma.onboardingProgress.update({
        where: { organizationId },
        data: { completedAt: null },
      })
      throw new BadRequestError('Previous setup attempt failed. Please try again.')
    }

    logger.info(`🔒 Acquired V2 onboarding lock for organization ${organizationId}`)

    // Prepare venue creation input (V2 is always REAL, no demo mode)
    const venueInput: venueCreationService.CreateVenueInput = {
      organizationId,
      userId: authContext.userId,
      onboardingType: 'REAL',
      businessInfo,
      paymentInfo: bankInfo?.clabe
        ? {
            clabe: bankInfo.clabe,
            bankName: bankInfo.bankName || '',
            accountHolder: bankInfo.accountHolder || '',
          }
        : undefined,
      selectedFeatures: [],
    }

    // Create venue — if this fails, release the lock
    let result: Awaited<ReturnType<typeof venueCreationService.createVenueFromOnboarding>>
    try {
      result = await venueCreationService.createVenueFromOnboarding(venueInput)
    } catch (venueError) {
      logger.error(`❌ V2 Venue creation failed for organization ${organizationId} - rolling back lock`, venueError)
      await prisma.onboardingProgress.update({
        where: { organizationId },
        data: { completedAt: null },
      })
      throw venueError
    }

    // Persist identity info (RFC, legalName, commercialName) from onboarding steps
    const venueUpdateData: Record<string, any> = {}
    if (identityInfo?.rfc) venueUpdateData.rfc = identityInfo.rfc
    if (entityInfo?.commercialName) venueUpdateData.legalName = entityInfo.commercialName
    else if (identityInfo?.legalFirstName && identityInfo?.legalLastName) {
      venueUpdateData.legalName = `${identityInfo.legalFirstName} ${identityInfo.legalLastName}`
    }

    if (Object.keys(venueUpdateData).length > 0) {
      await prisma.venue.update({
        where: { id: result.venue.id },
        data: venueUpdateData,
      })
    }

    // Mark organization as onboarding completed
    await prisma.organization.update({
      where: { id: organizationId },
      data: { onboardingCompletedAt: new Date() },
    })

    logger.info(`✅ V2 Onboarding completed for organization ${organizationId}, venue: ${result.venue.id} (${result.venue.slug})`)

    res.status(201).json({
      success: true,
      message: 'Setup completed successfully',
      venue: result.venue,
    })
  } catch (error) {
    logger.error('Error completing V2 onboarding:', error)
    next(error)
  }
}
