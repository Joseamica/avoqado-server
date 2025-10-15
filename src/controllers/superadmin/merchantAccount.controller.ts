import { Request, Response, NextFunction } from 'express'
import * as merchantAccountService from '../../services/superadmin/merchantAccount.service'
import logger from '../../config/logger'
import { BadRequestError } from '../../errors/AppError'

/**
 * MerchantAccount Controller
 *
 * REST API endpoints for managing merchant accounts with encrypted credentials.
 * All endpoints require SUPERADMIN role (enforced by parent router middleware).
 */

/**
 * GET /api/v1/superadmin/merchant-accounts
 * Get all merchant accounts with optional filters
 */
export async function getMerchantAccounts(req: Request, res: Response, next: NextFunction) {
  try {
    const { providerId, active } = req.query

    const filters: any = {}

    if (providerId) {
      filters.providerId = providerId as string
    }

    if (active !== undefined) {
      filters.active = active === 'true'
    }

    const accounts = await merchantAccountService.getMerchantAccounts(filters)

    res.json({
      success: true,
      data: accounts,
      count: accounts.length,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/superadmin/merchant-accounts/:id
 * Get a single merchant account by ID
 */
export async function getMerchantAccount(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params
    const { includeCredentials } = req.query

    // Only decrypt credentials if explicitly requested
    const shouldIncludeCredentials = includeCredentials === 'true'

    const account = await merchantAccountService.getMerchantAccount(id, shouldIncludeCredentials)

    res.json({
      success: true,
      data: account,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/superadmin/merchant-accounts/:id/credentials
 * Get decrypted credentials for a merchant account
 * SECURITY: Only use this endpoint when needed for payment processing setup
 */
export async function getMerchantAccountCredentials(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params

    const credentials = await merchantAccountService.getDecryptedCredentials(id)

    logger.warn('Merchant account credentials accessed', {
      accountId: id,
      requestedBy: (req as any).user?.uid,
    })

    res.json({
      success: true,
      data: credentials,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/superadmin/merchant-accounts
 * Create a new merchant account
 */
export async function createMerchantAccount(req: Request, res: Response, next: NextFunction) {
  try {
    const { providerId, externalMerchantId, alias, displayName, active, displayOrder, credentials, providerConfig } = req.body

    // Validate required fields
    if (!providerId) {
      throw new BadRequestError('providerId is required')
    }

    if (!externalMerchantId) {
      throw new BadRequestError('externalMerchantId is required')
    }

    if (!credentials || typeof credentials !== 'object') {
      throw new BadRequestError('credentials object is required')
    }

    if (!credentials.merchantId || !credentials.apiKey) {
      throw new BadRequestError('credentials must include merchantId and apiKey')
    }

    const account = await merchantAccountService.createMerchantAccount({
      providerId,
      externalMerchantId,
      alias,
      displayName,
      active,
      displayOrder,
      credentials,
      providerConfig,
    })

    logger.info('Merchant account created via API', {
      accountId: account.id,
      createdBy: (req as any).user?.uid,
    })

    res.status(201).json({
      success: true,
      data: account,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * PUT /api/v1/superadmin/merchant-accounts/:id
 * Update a merchant account
 */
export async function updateMerchantAccount(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params
    const { externalMerchantId, alias, displayName, active, displayOrder, credentials, providerConfig } = req.body

    const account = await merchantAccountService.updateMerchantAccount(id, {
      externalMerchantId,
      alias,
      displayName,
      active,
      displayOrder,
      credentials,
      providerConfig,
    })

    logger.info('Merchant account updated via API', {
      accountId: id,
      updatedBy: (req as any).user?.uid,
    })

    res.json({
      success: true,
      data: account,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * PATCH /api/v1/superadmin/merchant-accounts/:id/toggle
 * Toggle merchant account active status
 */
export async function toggleMerchantAccountStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params

    const account = await merchantAccountService.toggleMerchantAccountStatus(id)

    logger.info('Merchant account status toggled via API', {
      accountId: id,
      newStatus: account.active,
      toggledBy: (req as any).user?.uid,
    })

    res.json({
      success: true,
      data: account,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * DELETE /api/v1/superadmin/merchant-accounts/:id
 * Delete a merchant account
 * Only allowed if no cost structures or venue configs reference it
 */
export async function deleteMerchantAccount(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params

    await merchantAccountService.deleteMerchantAccount(id)

    logger.warn('Merchant account deleted via API', {
      accountId: id,
      deletedBy: (req as any).user?.uid,
    })

    res.json({
      success: true,
      message: 'Merchant account deleted successfully',
    })
  } catch (error) {
    next(error)
  }
}
