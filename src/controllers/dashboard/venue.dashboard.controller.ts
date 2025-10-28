// src/controllers/dashboard/venue.dashboard.controller.ts

/**
 * Venue Dashboard Controller
 *
 * ⚠️ DESIGN PRINCIPLE: Thin Controller Pattern
 *
 * Controllers are HTTP orchestration layers that:
 * 1. Extract data from HTTP request (req.body, req.params, req.authContext)
 * 2. Call service layer with clean data (no HTTP concepts)
 * 3. Send HTTP response (res.status(...).json(...))
 * 4. Pass errors to global error handler (next(error))
 *
 * Controllers should NOT:
 * ❌ Contain business logic (belongs in services)
 * ❌ Access database directly (use services)
 * ❌ Perform complex validations (use Zod schemas + middleware)
 *
 * Why thin controllers?
 * - Business logic is reusable (services can be called from CLI, tests, etc.)
 * - Easier to test (mock services instead of HTTP)
 * - Clear separation of concerns (HTTP ≠ Business Logic)
 */
import { NextFunction, Request, Response } from 'express'
import * as venueDashboardService from '../../services/dashboard/venue.dashboard.service'

import { CreateVenueDto, ListVenuesQueryDto, ConvertDemoVenueDto } from '../../schemas/dashboard/venue.schema'
import { EnhancedCreateVenueBody } from '../../schemas/dashboard/cost-management.schema'
import logger from '../../config/logger'

export async function listVenues(req: Request<{}, any, any, ListVenuesQueryDto>, res: Response, next: NextFunction): Promise<void> {
  try {
    const orgId = req.authContext?.orgId // 1. Extraer de req (Controller)
    if (!orgId) {
      // 2. Sanity check básico (Controller)
      return next(new Error('Contexto de organización no encontrado...'))
    }
    const queryOptions: ListVenuesQueryDto = req.query // 3. Extraer de req (Controller, ya validado)

    // 4. Llamada al servicio con datos limpios (Controller delega)
    const venues = await venueDashboardService.listVenuesForOrganization(orgId, queryOptions)

    res.status(200).json(venues) // 5. Enviar respuesta HTTP (Controller)
  } catch (error) {
    next(error) // 6. Manejo de error HTTP (Controller)
  }
}

export async function createVenue(req: Request<{}, any, CreateVenueDto>, res: Response, next: NextFunction): Promise<void> {
  try {
    const orgId = req.authContext?.orgId // 1. Extraer de req (Controller)
    if (!orgId) {
      // 2. Sanity check básico (Controller)
      return next(new Error('Contexto de organización no encontrado...'))
    }
    const venueData: CreateVenueDto = req.body // 3. Extraer de req (Controller, ya validado)

    // 4. Llamada al servicio con datos limpios (Controller delega)
    const newVenue = await venueDashboardService.createVenueForOrganization(orgId, venueData)

    res.status(201).json(newVenue) // 5. Enviar respuesta HTTP (Controller)
  } catch (error) {
    next(error) // 6. Manejo de error HTTP (Controller)
  }
}

export async function getVenueById(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const orgId = req.authContext?.orgId // 1. Extraer de req (Controller)
    if (!orgId) {
      // 2. Sanity check básico (Controller)
      return next(new Error('Contexto de organización no encontrado...'))
    }
    const venueId: string = req.params.venueId // 3. Extraer de req (Controller, ya validado)

    // 4. Llamada al servicio con datos limpios (Controller delega)
    // SUPERADMIN can access any venue across organizations
    const skipOrgCheck = req.authContext?.role === 'SUPERADMIN'
    const venue = await venueDashboardService.getVenueById(orgId, venueId, { skipOrgCheck })

    res.status(200).json(venue) // 5. Enviar respuesta HTTP (Controller)
  } catch (error) {
    next(error) // 6. Manejo de error HTTP (Controller)
  }
}

export async function updateVenue(req: Request<{ venueId: string }, any, any>, res: Response, next: NextFunction): Promise<void> {
  try {
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Contexto de organización no encontrado'))
    }

    const venueId: string = req.params.venueId
    const updateData = req.body

    // SUPERADMIN can update any venue across organizations
    const skipOrgCheck = req.authContext?.role === 'SUPERADMIN'
    const updatedVenue = await venueDashboardService.updateVenue(orgId, venueId, updateData, { skipOrgCheck })

    res.status(200).json({
      success: true,
      data: updatedVenue,
      message: 'Venue updated successfully',
    })
  } catch (error) {
    next(error)
  }
}

export async function deleteVenue(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Contexto de organización no encontrado'))
    }

    const venueId: string = req.params.venueId

    // SUPERADMIN can delete any venue across organizations
    const skipOrgCheck = req.authContext?.role === 'SUPERADMIN'
    await venueDashboardService.deleteVenue(orgId, venueId, { skipOrgCheck })

    res.status(200).json({
      success: true,
      message: 'Venue deleted successfully',
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Enhanced venue creation with payment processing and pricing configuration
 */
export async function createEnhancedVenue(
  req: Request<{}, any, EnhancedCreateVenueBody>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const orgId = req.authContext?.orgId
    if (!orgId) {
      logger.error('Organization context not found in enhanced venue creation')
      return next(new Error('Contexto de organización no encontrado'))
    }

    const userId = req.authContext?.userId
    if (!userId) {
      logger.error('User context not found in enhanced venue creation')
      return next(new Error('Contexto de usuario no encontrado'))
    }

    const venueData: EnhancedCreateVenueBody = req.body

    logger.info('Creating enhanced venue', {
      orgId,
      userId,
      venueName: venueData.name,
      enablePaymentProcessing: venueData.enablePaymentProcessing,
      setupPricingStructure: venueData.setupPricingStructure,
      pricingTier: venueData.pricingTier,
    })

    // Create the venue with enhanced features
    const newVenue = await venueDashboardService.createEnhancedVenue(orgId, userId, venueData)

    res.status(201).json({
      success: true,
      data: newVenue,
      message: 'Enhanced venue created successfully',
    })
  } catch (error) {
    logger.error('Error creating enhanced venue', {
      error: error instanceof Error ? error.message : 'Unknown error',
      orgId: req.authContext?.orgId,
      userId: req.authContext?.userId,
      venueName: req.body?.name,
    })
    next(error)
  }
}

/**
 * Convert demo venue to real venue
 */
export async function convertDemoVenue(
  req: Request<{ venueId: string }, any, ConvertDemoVenueDto>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const orgId = req.authContext?.orgId
    if (!orgId) {
      logger.error('Organization context not found in demo venue conversion')
      return next(new Error('Contexto de organización no encontrado'))
    }

    const venueId: string = req.params.venueId
    const conversionData: ConvertDemoVenueDto = req.body

    logger.info('Converting demo venue to real', {
      orgId,
      venueId,
      rfc: conversionData.rfc,
    })

    // SUPERADMIN can convert any venue across organizations
    const skipOrgCheck = req.authContext?.role === 'SUPERADMIN'
    const updatedVenue = await venueDashboardService.convertDemoVenue(orgId, venueId, conversionData, { skipOrgCheck })

    res.status(200).json({
      success: true,
      data: updatedVenue,
      message: 'Demo venue converted to real successfully',
    })
  } catch (error) {
    logger.error('Error converting demo venue', {
      error: error instanceof Error ? error.message : 'Unknown error',
      orgId: req.authContext?.orgId,
      venueId: req.params?.venueId,
    })
    next(error)
  }
}

/**
 * Upload venue document (tax or ID document)
 * Returns file buffer for frontend to upload to Firebase Storage
 *
 * Flow:
 * 1. Frontend sends file to this endpoint
 * 2. Backend validates file (size, type, permissions)
 * 3. Backend returns file buffer as base64
 * 4. Frontend uploads to Firebase Storage
 * 5. Frontend gets public URL from Firebase
 * 6. Frontend sends URL to conversion endpoint
 *
 * This pattern follows how companies like Stripe handle file uploads:
 * - Backend validates, frontend uploads to cloud storage
 * - Only store URLs in database (not binary data)
 * - Use CDN for fast global delivery
 */
export async function uploadVenueDocument(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const orgId = req.authContext?.orgId
    if (!orgId) {
      logger.error('Organization context not found in document upload')
      return next(new Error('Contexto de organización no encontrado'))
    }

    const venueId: string = req.params.venueId

    // Check if file was uploaded (using multer middleware)
    if (!req.file) {
      return next(new Error('No document file uploaded'))
    }

    const file = req.file

    // Validate file exists
    if (!file.buffer) {
      return next(new Error('File buffer is empty'))
    }

    // Auto-detect document type based on field name or query parameter
    let documentType: string
    if (req.query.type) {
      // Option 1: Use query parameter if provided
      documentType = (req.query.type as string).toLowerCase()
    } else if (file.fieldname) {
      // Option 2: Auto-detect from form field name
      const fieldName = file.fieldname.toLowerCase()
      if (fieldName.includes('tax') || fieldName.includes('csf') || fieldName.includes('fiscal')) {
        documentType = 'csf'
      } else if (fieldName.includes('acta')) {
        documentType = 'acta'
      } else if (fieldName.includes('id') || fieldName.includes('identif')) {
        documentType = 'id'
      } else {
        documentType = 'document' // Default generic name
      }
    } else {
      documentType = 'document' // Fallback
    }

    // Get file extension
    const extension = file.originalname.split('.').pop()?.toLowerCase() || 'pdf'

    // Rename file based on document type: CSF.pdf, ID.jpg, or Document.pdf
    let cleanFilename: string
    if (documentType === 'csf') {
      cleanFilename = `CSF.${extension}`
    } else if (documentType === 'acta') {
      cleanFilename = `ACTA.${extension}`
    } else if (documentType === 'id') {
      cleanFilename = `ID.${extension}`
    } else {
      cleanFilename = `Document.${extension}`
    }

    // Return file as base64 for frontend to upload to Firebase Storage
    const base64 = file.buffer.toString('base64')

    logger.info('Document validated, returning to frontend for Firebase upload', {
      orgId,
      venueId,
      originalFilename: file.originalname,
      cleanFilename,
      documentType,
      size: file.size,
      mimeType: file.mimetype,
    })

    res.status(200).json({
      success: true,
      data: {
        buffer: base64,
        filename: cleanFilename, // ✅ Now returns CSF.pdf or ID.jpg
        mimeType: file.mimetype,
        size: file.size,
      },
      message: 'Document validated successfully',
    })
  } catch (error) {
    logger.error('Error validating venue document', {
      error: error instanceof Error ? error.message : 'Unknown error',
      orgId: req.authContext?.orgId,
      venueId: req.params?.venueId,
    })
    next(error)
  }
}

/**
 * Update venue payment method
 * Allows venue owner to change the Stripe payment method
 */
export async function updateVenuePaymentMethod(
  req: Request<{ venueId: string }, any, { paymentMethodId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Contexto de organización no encontrado'))
    }

    const venueId: string = req.params.venueId
    const { paymentMethodId } = req.body

    // Call service to update payment method
    const skipOrgCheck = req.authContext?.role === 'SUPERADMIN'
    await venueDashboardService.updateVenuePaymentMethod(orgId, venueId, paymentMethodId, { skipOrgCheck })

    res.status(200).json({
      success: true,
      message: 'Payment method updated successfully',
    })
  } catch (error) {
    logger.error('Error updating venue payment method', {
      error: error instanceof Error ? error.message : 'Unknown error',
      orgId: req.authContext?.orgId,
      venueId: req.params?.venueId,
    })
    next(error)
  }
}

/**
 * Create Stripe Customer Portal session
 * Generates a URL to Stripe's hosted billing portal for subscription management
 */
export async function createBillingPortalSession(
  req: Request<{ venueId: string }, any, { returnUrl: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Contexto de organización no encontrado'))
    }

    const venueId: string = req.params.venueId
    const { returnUrl } = req.body

    // Call service to create billing portal session
    const skipOrgCheck = req.authContext?.role === 'SUPERADMIN'
    const portalUrl = await venueDashboardService.createVenueBillingPortalSession(orgId, venueId, returnUrl, { skipOrgCheck })

    res.status(200).json({
      success: true,
      url: portalUrl,
    })
  } catch (error) {
    logger.error('Error creating billing portal session', {
      error: error instanceof Error ? error.message : 'Unknown error',
      orgId: req.authContext?.orgId,
      venueId: req.params?.venueId,
    })
    next(error)
  }
}

/**
 * List payment methods for a venue
 */
export async function listVenuePaymentMethods(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Organization context not found'))
    }

    const venueId: string = req.params.venueId
    const skipOrgCheck = req.authContext?.role === 'SUPERADMIN'
    const paymentMethods = await venueDashboardService.listVenuePaymentMethods(orgId, venueId, { skipOrgCheck })

    res.status(200).json({
      success: true,
      data: paymentMethods,
    })
  } catch (error) {
    logger.error('Error listing payment methods', {
      error: error instanceof Error ? error.message : 'Unknown error',
      orgId: req.authContext?.orgId,
      venueId: req.params?.venueId,
    })
    next(error)
  }
}

/**
 * Detach (delete) a payment method from a venue
 */
export async function detachVenuePaymentMethod(
  req: Request<{ venueId: string; paymentMethodId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Organization context not found'))
    }

    const venueId: string = req.params.venueId
    const paymentMethodId: string = req.params.paymentMethodId
    const skipOrgCheck = req.authContext?.role === 'SUPERADMIN'

    await venueDashboardService.detachVenuePaymentMethod(orgId, venueId, paymentMethodId, { skipOrgCheck })

    res.status(200).json({
      success: true,
      message: 'Payment method deleted successfully',
    })
  } catch (error) {
    logger.error('Error detaching payment method', {
      error: error instanceof Error ? error.message : 'Unknown error',
      orgId: req.authContext?.orgId,
      venueId: req.params?.venueId,
      paymentMethodId: req.params?.paymentMethodId,
    })
    next(error)
  }
}

/**
 * Set default payment method for a venue
 */
export async function setVenueDefaultPaymentMethod(
  req: Request<{ venueId: string }, any, { paymentMethodId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Organization context not found'))
    }

    const venueId: string = req.params.venueId
    const { paymentMethodId } = req.body
    const skipOrgCheck = req.authContext?.role === 'SUPERADMIN'

    await venueDashboardService.setVenueDefaultPaymentMethod(orgId, venueId, paymentMethodId, { skipOrgCheck })

    res.status(200).json({
      success: true,
      message: 'Default payment method set successfully',
    })
  } catch (error) {
    logger.error('Error setting default payment method', {
      error: error instanceof Error ? error.message : 'Unknown error',
      orgId: req.authContext?.orgId,
      venueId: req.params?.venueId,
    })
    next(error)
  }
}

/**
 * Create SetupIntent for collecting payment method
 */
export async function createVenueSetupIntent(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const orgId = req.authContext?.orgId
    if (!orgId) {
      return next(new Error('Organization context not found'))
    }

    const venueId: string = req.params.venueId
    const skipOrgCheck = req.authContext?.role === 'SUPERADMIN'

    const clientSecret = await venueDashboardService.createVenueSetupIntent(orgId, venueId, { skipOrgCheck })

    res.status(200).json({
      success: true,
      data: { clientSecret },
    })
  } catch (error) {
    logger.error('Error creating SetupIntent', {
      error: error instanceof Error ? error.message : 'Unknown error',
      orgId: req.authContext?.orgId,
      venueId: req.params?.venueId,
    })
    next(error)
  }
}
