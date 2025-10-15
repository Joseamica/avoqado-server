import { Request, Response, NextFunction } from 'express'
import * as paymentProviderService from '../../services/superadmin/paymentProvider.service'
import logger from '../../config/logger'

/**
 * GET /api/v1/superadmin/payment-providers
 * Get all payment providers with optional filters
 */
export async function getPaymentProviders(req: Request, res: Response, next: NextFunction) {
  try {
    const { type, countryCode, active } = req.query

    const filters: any = {}
    if (type) filters.type = type
    if (countryCode) filters.countryCode = countryCode
    if (active !== undefined) filters.active = active === 'true'

    const providers = await paymentProviderService.getPaymentProviders(filters)

    res.json({
      success: true,
      data: providers,
      meta: {
        count: providers.length,
      },
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/superadmin/payment-providers/:id
 * Get a single payment provider by ID
 */
export async function getPaymentProvider(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params

    const provider = await paymentProviderService.getPaymentProvider(id)

    res.json({
      success: true,
      data: provider,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/superadmin/payment-providers/code/:code
 * Get a payment provider by code
 */
export async function getPaymentProviderByCode(req: Request, res: Response, next: NextFunction) {
  try {
    const { code } = req.params

    const provider = await paymentProviderService.getPaymentProviderByCode(code)

    res.json({
      success: true,
      data: provider,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/superadmin/payment-providers
 * Create a new payment provider
 */
export async function createPaymentProvider(req: Request, res: Response, next: NextFunction) {
  try {
    const { code, name, type, countryCode, configSchema, active } = req.body

    // Validation
    if (!code || !name || !type || !countryCode || !Array.isArray(countryCode)) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: code, name, type, countryCode (array)',
      })
    }

    const provider = await paymentProviderService.createPaymentProvider({
      code,
      name,
      type,
      countryCode,
      configSchema,
      active,
    })

    logger.info('Payment provider created via API', {
      providerId: provider.id,
      code: provider.code,
    })

    res.status(201).json({
      success: true,
      data: provider,
      message: `Payment provider ${provider.code} created successfully`,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * PUT /api/v1/superadmin/payment-providers/:id
 * Update a payment provider
 */
export async function updatePaymentProvider(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params
    const { name, type, countryCode, configSchema, active } = req.body

    const provider = await paymentProviderService.updatePaymentProvider(id, {
      name,
      type,
      countryCode,
      configSchema,
      active,
    })

    logger.info('Payment provider updated via API', {
      providerId: id,
      code: provider.code,
    })

    res.json({
      success: true,
      data: provider,
      message: `Payment provider ${provider.code} updated successfully`,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * PATCH /api/v1/superadmin/payment-providers/:id/toggle
 * Toggle payment provider active status
 */
export async function togglePaymentProviderStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params

    const provider = await paymentProviderService.togglePaymentProviderStatus(id)

    logger.info('Payment provider status toggled via API', {
      providerId: id,
      code: provider.code,
      newStatus: provider.active,
    })

    res.json({
      success: true,
      data: provider,
      message: `Payment provider ${provider.code} ${provider.active ? 'activated' : 'deactivated'}`,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * DELETE /api/v1/superadmin/payment-providers/:id
 * Delete (soft delete) a payment provider
 */
export async function deletePaymentProvider(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params

    await paymentProviderService.deletePaymentProvider(id)

    logger.info('Payment provider deleted via API', {
      providerId: id,
    })

    res.json({
      success: true,
      message: 'Payment provider deactivated successfully',
    })
  } catch (error) {
    next(error)
  }
}
