/**
 * E-commerce Merchant Controller
 *
 * Handles HTTP requests for e-commerce merchant management (dashboard).
 * Thin layer that orchestrates service calls and sends responses.
 *
 * **Architecture**: Controllers are HTTP-agnostic orchestrators.
 * - Extract data from req (params, query, body)
 * - Call service layer (business logic)
 * - Send JSON responses
 * - NO business logic in controllers!
 *
 * @module controllers/dashboard/ecommerceMerchant
 */

import { Request, Response } from 'express'
import * as ecommerceMerchantService from '@/services/dashboard/ecommerceMerchant.service'
import logger from '@/config/logger'

// ═══════════════════════════════════════════════════════════════════════════
// LIST & GET
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/dashboard/venues/:venueId/ecommerce-merchants
 * Lists e-commerce merchants for a venue
 */
export async function listEcommerceMerchants(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const { active, sandboxMode, providerId, limit, offset } = req.query

    const result = await ecommerceMerchantService.listEcommerceMerchants({
      venueId,
      active: active ? active === 'true' : undefined,
      sandboxMode: sandboxMode ? sandboxMode === 'true' : undefined,
      providerId: providerId as string | undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    })

    res.json({
      success: true,
      data: result,
    })
  } catch (error: any) {
    logger.error('Error listing e-commerce merchants:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to list e-commerce merchants',
    })
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/ecommerce-merchants/:id
 * Gets a single e-commerce merchant by ID
 */
export async function getEcommerceMerchant(req: Request, res: Response) {
  try {
    const { venueId, id } = req.params

    const merchant = await ecommerceMerchantService.getEcommerceMerchantById(id, venueId)

    res.json({
      success: true,
      data: merchant,
    })
  } catch (error: any) {
    logger.error('Error getting e-commerce merchant:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to get e-commerce merchant',
    })
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CREATE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/v1/dashboard/venues/:venueId/ecommerce-merchants
 * Creates a new e-commerce merchant
 *
 * ⚠️ IMPORTANT: Response includes secret key (sk_live_xxx or sk_test_xxx)
 * This is the ONLY time the client will see the secret key!
 * Client must save it immediately - we never store it in plaintext.
 */
export async function createEcommerceMerchant(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const data = req.body

    // Merge venueId from params (takes precedence over body)
    const createData = {
      ...data,
      venueId,
    }

    const merchant = await ecommerceMerchantService.createEcommerceMerchant(createData)

    res.status(201).json({
      success: true,
      data: merchant,
      message: '✅ E-commerce merchant created successfully',
      warning: "⚠️ Save the secret key (sk_xxx) now! You won't be able to see it again.",
    })
  } catch (error: any) {
    logger.error('Error creating e-commerce merchant:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to create e-commerce merchant',
    })
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// UPDATE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * PUT /api/v1/dashboard/venues/:venueId/ecommerce-merchants/:id
 * Updates an e-commerce merchant
 */
export async function updateEcommerceMerchant(req: Request, res: Response) {
  try {
    const { venueId, id } = req.params
    const data = req.body

    const merchant = await ecommerceMerchantService.updateEcommerceMerchant(id, data, venueId)

    res.json({
      success: true,
      data: merchant,
      message: 'E-commerce merchant updated successfully',
    })
  } catch (error: any) {
    logger.error('Error updating e-commerce merchant:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to update e-commerce merchant',
    })
  }
}

/**
 * PATCH /api/v1/dashboard/venues/:venueId/ecommerce-merchants/:id/toggle
 * Toggles e-commerce merchant active status
 */
export async function toggleEcommerceMerchantStatus(req: Request, res: Response) {
  try {
    const { venueId, id } = req.params
    const { active } = req.body

    const merchant = await ecommerceMerchantService.toggleEcommerceMerchantStatus(id, active, venueId)

    res.json({
      success: true,
      data: merchant,
      message: `E-commerce merchant ${active ? 'activated' : 'deactivated'} successfully`,
    })
  } catch (error: any) {
    logger.error('Error toggling e-commerce merchant status:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to toggle e-commerce merchant status',
    })
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// API KEYS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/dashboard/venues/:venueId/ecommerce-merchants/:id/keys
 * Gets API keys for an e-commerce merchant
 *
 * Note: Secret key is masked (sk_live_••••••••)
 * Only shows full secret key on creation or regeneration.
 */
export async function getAPIKeys(req: Request, res: Response) {
  try {
    const { venueId, id } = req.params

    const keys = await ecommerceMerchantService.getAPIKeys(id, venueId)

    res.json({
      success: true,
      data: keys,
    })
  } catch (error: any) {
    logger.error('Error getting API keys:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to get API keys',
    })
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/ecommerce-merchants/:id/regenerate-keys
 * Regenerates API keys for an e-commerce merchant
 *
 * ⚠️ WARNING: This invalidates old keys!
 * All existing integrations will break until they update to new keys.
 *
 * Response includes new secret key (sk_xxx) - save it immediately!
 */
export async function regenerateAPIKeys(req: Request, res: Response) {
  try {
    const { venueId, id } = req.params

    const keys = await ecommerceMerchantService.regenerateAPIKeys(id, venueId)

    res.json({
      success: true,
      data: keys,
      message: '✅ API keys regenerated successfully',
      warning: '⚠️ OLD KEYS ARE NOW INVALID! Save the new secret key (sk_xxx) now.',
    })
  } catch (error: any) {
    logger.error('Error regenerating API keys:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to regenerate API keys',
    })
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DELETE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * DELETE /api/v1/dashboard/venues/:venueId/ecommerce-merchants/:id
 * Deletes an e-commerce merchant
 *
 * ⚠️ CASCADE: Also deletes all checkout sessions
 */
export async function deleteEcommerceMerchant(req: Request, res: Response) {
  try {
    const { venueId, id } = req.params

    const result = await ecommerceMerchantService.deleteEcommerceMerchant(id, venueId)

    res.json({
      success: true,
      data: result,
      message: 'E-commerce merchant deleted successfully',
    })
  } catch (error: any) {
    logger.error('Error deleting e-commerce merchant:', error)
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to delete e-commerce merchant',
    })
  }
}
