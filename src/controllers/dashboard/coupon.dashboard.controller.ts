/**
 * Coupon Dashboard Controller
 *
 * Thin controller layer - orchestrates HTTP, delegates to service.
 * Contains NO business logic, only:
 * - Request/response handling
 * - Calling service functions
 * - Error responses
 *
 * @see CLAUDE.md - Layered Architecture section
 * @see src/services/dashboard/coupon.dashboard.service.ts - Business logic
 */

import { Request, Response, NextFunction } from 'express'
import * as couponService from '@/services/dashboard/coupon.dashboard.service'
import {
  getCouponsQuerySchema,
  getRedemptionsQuerySchema,
  createCouponBodySchema,
  updateCouponBodySchema,
  bulkGenerateCouponsBodySchema,
  validateCouponBodySchema,
  recordRedemptionBodySchema,
} from '@/schemas/dashboard/coupon.schema'

// ==========================================
// COUPON CRUD
// ==========================================

/**
 * GET /api/v1/dashboard/venues/:venueId/coupons
 * List all coupon codes with pagination and filtering
 */
export async function getCouponCodes(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const query = getCouponsQuerySchema.parse(req.query)

    const result = await couponService.getCouponCodes(venueId, query.page, query.pageSize, query.search, query.discountId, query.active)

    res.json(result)
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/coupons/stats
 * Get coupon statistics
 */
export async function getCouponStats(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params

    const stats = await couponService.getCouponStats(venueId)

    res.json(stats)
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/coupons/:couponId
 * Get single coupon code by ID
 */
export async function getCouponCodeById(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, couponId } = req.params

    const coupon = await couponService.getCouponCodeById(venueId, couponId)

    res.json(coupon)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/coupons
 * Create a new coupon code
 */
export async function createCouponCode(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const body = createCouponBodySchema.parse(req.body)

    const coupon = await couponService.createCouponCode(venueId, body)

    res.status(201).json(coupon)
  } catch (error) {
    next(error)
  }
}

/**
 * PUT /api/v1/dashboard/venues/:venueId/coupons/:couponId
 * Update an existing coupon code
 */
export async function updateCouponCode(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, couponId } = req.params
    const body = updateCouponBodySchema.parse(req.body)

    const coupon = await couponService.updateCouponCode(venueId, couponId, body)

    res.json(coupon)
  } catch (error) {
    next(error)
  }
}

/**
 * DELETE /api/v1/dashboard/venues/:venueId/coupons/:couponId
 * Delete a coupon code
 */
export async function deleteCouponCode(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, couponId } = req.params

    await couponService.deleteCouponCode(venueId, couponId)

    res.status(204).send()
  } catch (error) {
    next(error)
  }
}

// ==========================================
// BULK OPERATIONS
// ==========================================

/**
 * POST /api/v1/dashboard/venues/:venueId/coupons/bulk-generate
 * Bulk generate coupon codes
 */
export async function bulkGenerateCoupons(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const body = bulkGenerateCouponsBodySchema.parse(req.body)

    const result = await couponService.bulkGenerateCouponCodes(venueId, body)

    res.status(201).json(result)
  } catch (error) {
    next(error)
  }
}

// ==========================================
// COUPON VALIDATION
// ==========================================

/**
 * POST /api/v1/dashboard/venues/:venueId/coupons/validate
 * Validate a coupon code
 */
export async function validateCouponCode(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const body = validateCouponBodySchema.parse(req.body)

    const result = await couponService.validateCouponCode(venueId, body.code, body.orderTotal, body.customerId)

    res.json(result)
  } catch (error) {
    next(error)
  }
}

// ==========================================
// COUPON REDEMPTIONS
// ==========================================

/**
 * POST /api/v1/dashboard/venues/:venueId/coupons/:couponId/redeem
 * Record a coupon redemption
 */
export async function recordRedemption(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, couponId } = req.params
    const body = recordRedemptionBodySchema.parse(req.body)

    const result = await couponService.recordCouponRedemption(venueId, couponId, body.orderId, body.amountSaved, body.customerId)

    res.status(201).json(result)
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/coupons/redemptions
 * Get coupon redemption history
 */
export async function getCouponRedemptions(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const query = getRedemptionsQuerySchema.parse(req.query)

    const result = await couponService.getCouponRedemptions(venueId, query.page, query.pageSize, query.couponId, query.customerId)

    res.json(result)
  } catch (error) {
    next(error)
  }
}
