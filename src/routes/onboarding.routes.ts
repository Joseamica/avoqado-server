/**
 * Onboarding Routes
 *
 * Handles multi-step onboarding wizard for new organizations
 */

import express from 'express'
import multer from 'multer'
import rateLimit from 'express-rate-limit'
import { validateRequest } from '../middlewares/validation'
import { authenticateTokenMiddleware } from '../middlewares/authenticateToken.middleware'
import * as onboardingController from '../controllers/onboarding.controller'
import {
  SignupSchema,
  StartOnboardingSchema,
  GetOnboardingProgressSchema,
  UpdateStep1Schema,
  UpdateStep2Schema,
  UpdateStep3Schema,
  UpdateStep4Schema,
  UpdateStep5Schema,
  UpdateStep6Schema,
  UpdateStep7Schema,
  UpdateStep8Schema,
  CompleteOnboardingSchema,
  GetMenuTemplateSchema,
} from '../schemas/onboarding.schema'

const router = express.Router()

// Rate limiters for security (FAANG best practices)
// More permissive in development for easier testing
const isDevelopment = process.env.NODE_ENV !== 'production'

const signupRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: isDevelopment ? 100 : 3, // Dev: 100/hour, Prod: 3/hour
  message: 'Too many signup attempts from this IP. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => req.ip || 'unknown',
})

const verificationRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isDevelopment ? 50 : 5, // Dev: 50/15min, Prod: 5/15min
  message: 'Too many verification attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => req.body.email || req.ip || 'unknown',
})

const resendRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: isDevelopment ? 20 : 3, // Dev: 20/hour, Prod: 3/hour
  message: 'Too many resend requests. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => req.body.email || req.ip || 'unknown',
})

const emailStatusRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: isDevelopment ? 100 : 5, // Dev: 100/min, Prod: 5/min
  message: 'Too many email status checks. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => req.ip || 'unknown',
})

/**
 * @openapi
 * /api/v1/onboarding/signup:
 *   post:
 *     tags: [Onboarding]
 *     summary: Create new user account
 *     description: Creates a new user account with organization (no authentication required)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password, firstName, lastName, organizationName]
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string, minLength: 8 }
 *               firstName: { type: string }
 *               lastName: { type: string }
 *               organizationName: { type: string }
 *     responses:
 *       201:
 *         description: Account created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 message: { type: string }
 *                 staff:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     email: { type: string }
 *                     firstName: { type: string }
 *                     lastName: { type: string }
 *                     organizationId: { type: string }
 *                 organization:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     name: { type: string }
 *       400:
 *         description: Validation error or email already exists
 */
router.post('/signup', signupRateLimiter, validateRequest(SignupSchema), onboardingController.signup)

/**
 * @openapi
 * /api/v1/onboarding/verify-email:
 *   post:
 *     tags: [Onboarding]
 *     summary: Verify user email with PIN code
 *     description: Verifies user email using 4-digit PIN code sent during signup
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, verificationCode]
 *             properties:
 *               email: { type: string, format: email }
 *               verificationCode: { type: string, pattern: '^\\d{4}$' }
 *     responses:
 *       200:
 *         description: Email verified successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 message: { type: string }
 *                 emailVerified: { type: boolean }
 *       400:
 *         description: Invalid or expired verification code
 */
router.post('/verify-email', verificationRateLimiter, onboardingController.verifyEmail)

/**
 * @openapi
 * /api/v1/onboarding/resend-verification:
 *   post:
 *     tags: [Onboarding]
 *     summary: Resend verification code
 *     description: Resends a new 4-digit verification code to the user's email
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email: { type: string, format: email }
 *     responses:
 *       200:
 *         description: Verification code resent successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 message: { type: string }
 *       400:
 *         description: Email not found or already verified
 */
router.post('/resend-verification', resendRateLimiter, onboardingController.resendVerification)

/**
 * @openapi
 * /api/v1/onboarding/email-status:
 *   get:
 *     tags: [Onboarding]
 *     summary: Check email verification status
 *     description: Checks if an email exists and is verified (public endpoint)
 *     parameters:
 *       - in: query
 *         name: email
 *         required: true
 *         schema: { type: string, format: email }
 *         description: Email address to check
 *     responses:
 *       200:
 *         description: Email status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 emailExists: { type: boolean }
 *                 emailVerified: { type: boolean }
 *       400:
 *         description: Email parameter is required
 */
router.get('/email-status', emailStatusRateLimiter, onboardingController.getEmailStatus)

/**
 * @openapi
 * /api/v1/onboarding/setup-intent:
 *   post:
 *     tags: [Onboarding]
 *     summary: Create SetupIntent for card validation during onboarding
 *     description: Creates a Stripe SetupIntent without a customer. The PaymentMethod will be attached to a customer when the venue is created.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: SetupIntent created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     clientSecret: { type: string }
 *       401:
 *         description: Authentication required
 */
router.post('/setup-intent', authenticateTokenMiddleware, onboardingController.createSetupIntent)

// Configure multer for CSV uploads (memory storage, max 5MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB max
  },
  fileFilter: (req, file, cb) => {
    // Only accept CSV files
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true)
    } else {
      cb(new Error('Only CSV files are allowed'))
    }
  },
})

// Configure multer for KYC document uploads (memory storage, max 10MB)
const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max
  },
  fileFilter: (_req, file, cb) => {
    // Accept PDF, JPG, JPEG, PNG files
    const allowedMimeTypes = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png']
    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error('Only PDF, JPG, JPEG, and PNG files are allowed'))
    }
  },
})

/**
 * @openapi
 * /api/v1/onboarding/organizations/{organizationId}/start:
 *   post:
 *     tags: [Onboarding]
 *     summary: Initialize onboarding progress
 *     description: Creates or retrieves onboarding progress for an organization
 *     parameters:
 *       - in: path
 *         name: organizationId
 *         required: true
 *         schema: { type: string, format: cuid }
 *     responses:
 *       200:
 *         description: Onboarding initialized successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 progress:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     currentStep: { type: number }
 *                     completedSteps: { type: array, items: { type: number } }
 *                     startedAt: { type: string, format: date-time }
 */
router.post(
  '/organizations/:organizationId/start',
  authenticateTokenMiddleware,
  validateRequest(StartOnboardingSchema),
  onboardingController.startOnboarding,
)

/**
 * @openapi
 * /api/v1/onboarding/organizations/{organizationId}/progress:
 *   get:
 *     tags: [Onboarding]
 *     summary: Get current onboarding progress
 *     parameters:
 *       - in: path
 *         name: organizationId
 *         required: true
 *         schema: { type: string, format: cuid }
 *     responses:
 *       200:
 *         description: Onboarding progress retrieved
 *       404:
 *         description: Onboarding progress not found
 */
router.get(
  '/organizations/:organizationId/progress',
  validateRequest(GetOnboardingProgressSchema),
  onboardingController.getOnboardingProgress,
)

/**
 * @openapi
 * /api/v1/onboarding/organizations/{organizationId}/step/1:
 *   put:
 *     tags: [Onboarding]
 *     summary: Update Step 1 - User Info
 *     parameters:
 *       - in: path
 *         name: organizationId
 *         required: true
 *         schema: { type: string, format: cuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, firstName, lastName]
 *             properties:
 *               email: { type: string, format: email }
 *               firstName: { type: string, minLength: 1, maxLength: 50 }
 *               lastName: { type: string, minLength: 1, maxLength: 50 }
 *               phone: { type: string }
 *     responses:
 *       200:
 *         description: Step 1 completed successfully
 */
router.put('/organizations/:organizationId/step/1', validateRequest(UpdateStep1Schema), onboardingController.updateStep1)

/**
 * @openapi
 * /api/v1/onboarding/organizations/{organizationId}/step/2:
 *   put:
 *     tags: [Onboarding]
 *     summary: Update Step 2 - Onboarding Type (Demo vs Real)
 *     parameters:
 *       - in: path
 *         name: organizationId
 *         required: true
 *         schema: { type: string, format: cuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [onboardingType]
 *             properties:
 *               onboardingType: { type: string, enum: [DEMO, REAL] }
 *     responses:
 *       200:
 *         description: Step 2 completed successfully
 */
router.put(
  '/organizations/:organizationId/step/2',
  authenticateTokenMiddleware,
  validateRequest(UpdateStep2Schema),
  onboardingController.updateStep2,
)

/**
 * @openapi
 * /api/v1/onboarding/organizations/{organizationId}/step/3:
 *   put:
 *     tags: [Onboarding]
 *     summary: Update Step 3 - Business Info
 *     parameters:
 *       - in: path
 *         name: organizationId
 *         required: true
 *         schema: { type: string, format: cuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string, minLength: 1, maxLength: 100 }
 *               type: { type: string }
 *               venueType: { type: string }
 *               timezone: { type: string }
 *               address: { type: string }
 *               city: { type: string }
 *               state: { type: string }
 *               country: { type: string }
 *               zipCode: { type: string }
 *               phone: { type: string }
 *               email: { type: string, format: email }
 *     responses:
 *       200:
 *         description: Step 3 completed successfully
 */
router.put(
  '/organizations/:organizationId/step/3',
  authenticateTokenMiddleware,
  validateRequest(UpdateStep3Schema),
  onboardingController.updateStep3,
)

/**
 * @openapi
 * /api/v1/onboarding/organizations/{organizationId}/step/4:
 *   put:
 *     tags: [Onboarding]
 *     summary: Update Step 4 - Menu Data (manual entry)
 *     parameters:
 *       - in: path
 *         name: organizationId
 *         required: true
 *         schema: { type: string, format: cuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [method]
 *             properties:
 *               method: { type: string, enum: [manual, csv] }
 *               categories:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     name: { type: string }
 *                     slug: { type: string }
 *                     description: { type: string }
 *               products:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     name: { type: string }
 *                     sku: { type: string }
 *                     description: { type: string }
 *                     price: { type: number }
 *                     type: { type: string }
 *                     categorySlug: { type: string }
 *     responses:
 *       200:
 *         description: Step 4 completed successfully
 */
router.put('/organizations/:organizationId/step/4', validateRequest(UpdateStep4Schema), onboardingController.updateStep4)

/**
 * @openapi
 * /api/v1/onboarding/organizations/{organizationId}/upload-menu-csv:
 *   post:
 *     tags: [Onboarding]
 *     summary: Upload menu CSV file (Step 4 alternative)
 *     parameters:
 *       - in: path
 *         name: organizationId
 *         required: true
 *         schema: { type: string, format: cuid }
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: CSV file with menu data
 *     responses:
 *       200:
 *         description: CSV uploaded and validated successfully
 *       400:
 *         description: CSV validation failed
 */
router.post('/organizations/:organizationId/upload-menu-csv', upload.single('file'), onboardingController.uploadMenuCSV)

/**
 * @openapi
 * /api/v1/onboarding/menu-template:
 *   get:
 *     tags: [Onboarding]
 *     summary: Download CSV template for menu import
 *     parameters:
 *       - in: query
 *         name: format
 *         schema: { type: string, enum: [csv], default: csv }
 *     responses:
 *       200:
 *         description: CSV template downloaded
 *         content:
 *           text/csv:
 *             schema:
 *               type: string
 */
router.get('/menu-template', validateRequest(GetMenuTemplateSchema), onboardingController.getMenuTemplate)

/**
 * @openapi
 * /api/v1/onboarding/organizations/{organizationId}/step/5:
 *   put:
 *     tags: [Onboarding]
 *     summary: Update Step 5 - Team Invites (optional)
 *     parameters:
 *       - in: path
 *         name: organizationId
 *         required: true
 *         schema: { type: string, format: cuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [teamInvites]
 *             properties:
 *               teamInvites:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     email: { type: string, format: email }
 *                     role: { type: string }
 *     responses:
 *       200:
 *         description: Step 5 completed successfully
 */
router.put('/organizations/:organizationId/step/5', validateRequest(UpdateStep5Schema), onboardingController.updateStep5)

/**
 * @openapi
 * /api/v1/onboarding/organizations/{organizationId}/step/6:
 *   put:
 *     tags: [Onboarding]
 *     summary: Update Step 6 - Selected Premium Features
 *     parameters:
 *       - in: path
 *         name: organizationId
 *         required: true
 *         schema: { type: string, format: cuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               selectedFeatures:
 *                 type: array
 *                 items: { type: string }
 *     responses:
 *       200:
 *         description: Step 6 completed successfully
 */
router.put('/organizations/:organizationId/step/6', validateRequest(UpdateStep6Schema), onboardingController.updateStep6)

/**
 * @openapi
 * /api/v1/onboarding/organizations/{organizationId}/step/7:
 *   put:
 *     tags: [Onboarding]
 *     summary: Update Step 7 - KYC Documents
 *     parameters:
 *       - in: path
 *         name: organizationId
 *         required: true
 *         schema: { type: string, format: cuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [entityType, documents]
 *             properties:
 *               entityType: { type: string, enum: [PERSONA_FISICA, PERSONA_MORAL] }
 *               documents:
 *                 type: object
 *                 properties:
 *                   ineUrl: { type: string }
 *                   rfcDocumentUrl: { type: string }
 *                   comprobanteDomicilioUrl: { type: string }
 *                   caratulaBancariaUrl: { type: string }
 *                   actaDocumentUrl: { type: string }
 *                   poderLegalUrl: { type: string }
 *     responses:
 *       200:
 *         description: Step 7 completed successfully
 */
router.put(
  '/organizations/:organizationId/step/7',
  authenticateTokenMiddleware,
  validateRequest(UpdateStep7Schema),
  onboardingController.updateStep7,
)

/**
 * @openapi
 * /api/v1/onboarding/organizations/{organizationId}/kyc/document/{documentKey}:
 *   put:
 *     tags: [Onboarding]
 *     summary: Upload a KYC document during onboarding
 *     description: Upload a single KYC document (INE, RFC, etc.) during onboarding. The document is stored in Firebase Storage and the URL is saved to OnboardingProgress.
 *     parameters:
 *       - in: path
 *         name: organizationId
 *         required: true
 *         schema: { type: string, format: cuid }
 *       - in: path
 *         name: documentKey
 *         required: true
 *         schema:
 *           type: string
 *           enum: [ine, rfcDocument, comprobanteDomicilio, caratulaBancaria, actaDocument, poderLegal]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Document uploaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 message: { type: string }
 *                 data:
 *                   type: object
 *                   properties:
 *                     documentKey: { type: string }
 *                     url: { type: string }
 *       400:
 *         description: Invalid document key or no file provided
 */
router.put(
  '/organizations/:organizationId/kyc/document/:documentKey',
  authenticateTokenMiddleware,
  documentUpload.single('file'),
  onboardingController.uploadKycDocument,
)

/**
 * @openapi
 * /api/v1/onboarding/organizations/{organizationId}/step/8:
 *   put:
 *     tags: [Onboarding]
 *     summary: Update Step 8 - CLABE Payment Info
 *     parameters:
 *       - in: path
 *         name: organizationId
 *         required: true
 *         schema: { type: string, format: cuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [clabe, accountHolder]
 *             properties:
 *               clabe: { type: string, pattern: '^\\d{18}$' }
 *               bankName: { type: string }
 *               accountHolder: { type: string }
 *     responses:
 *       200:
 *         description: Step 8 completed successfully
 *       400:
 *         description: Invalid CLABE
 */
router.put(
  '/organizations/:organizationId/step/8',
  authenticateTokenMiddleware,
  validateRequest(UpdateStep8Schema),
  onboardingController.updateStep8,
)

/**
 * @openapi
 * /api/v1/onboarding/organizations/{organizationId}/complete:
 *   post:
 *     tags: [Onboarding]
 *     summary: Complete onboarding and create venue
 *     description: Finalizes onboarding process and creates the venue with all collected data
 *     parameters:
 *       - in: path
 *         name: organizationId
 *         required: true
 *         schema: { type: string, format: cuid }
 *     responses:
 *       201:
 *         description: Onboarding completed successfully, venue created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *                 venue:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     slug: { type: string }
 *                     name: { type: string }
 *                     status: { type: string, enum: [TRIAL, ONBOARDING, PENDING_ACTIVATION, ACTIVE, SUSPENDED, ADMIN_SUSPENDED, CLOSED] }
 *                 summary:
 *                   type: object
 *                   properties:
 *                     categoriesCreated: { type: number }
 *                     productsCreated: { type: number }
 *                     demoDataSeeded: { type: boolean }
 *       400:
 *         description: Missing required steps
 *       404:
 *         description: Onboarding progress not found
 */
router.post(
  '/organizations/:organizationId/complete',
  authenticateTokenMiddleware,
  validateRequest(CompleteOnboardingSchema),
  onboardingController.completeOnboarding,
)

export default router
