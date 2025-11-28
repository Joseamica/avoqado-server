/**
 * Discount TPV Controller
 *
 * HTTP layer for TPV discount operations.
 * Thin controller - delegates business logic to service.
 *
 * @see docs/CUSTOMER_DISCOUNT_IMPLEMENTATION_PLAN.md - Phase 2 TPV Integration
 */

import { NextFunction, Request, Response } from 'express'
import * as discountTpvService from '@/services/tpv/discount.tpv.service'
import { DiscountType } from '@prisma/client'

// ==========================================
// GET AVAILABLE DISCOUNTS
// ==========================================

/**
 * Get available discounts for an order
 *
 * GET /api/v1/tpv/venues/:venueId/orders/:orderId/discounts/available
 */
export async function getAvailableDiscounts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, orderId } = req.params
    const customerId = req.query.customerId as string | undefined

    const discounts = await discountTpvService.getAvailableDiscounts(venueId, orderId, customerId)

    res.status(200).json({
      success: true,
      data: discounts,
      count: discounts.length,
    })
  } catch (error) {
    next(error)
  }
}

// ==========================================
// APPLY AUTOMATIC DISCOUNTS
// ==========================================

/**
 * Apply all eligible automatic discounts to an order
 *
 * POST /api/v1/tpv/venues/:venueId/orders/:orderId/discounts/auto
 */
export async function applyAutomaticDiscounts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, orderId } = req.params
    const authContext = (req as any).authContext
    const staffVenueId = authContext?.staffVenueId

    const result = await discountTpvService.applyAutomaticDiscounts(venueId, orderId, staffVenueId)

    res.status(200).json({
      success: true,
      data: result,
      message: result.applied > 0 ? `Applied ${result.applied} automatic discount(s)` : 'No automatic discounts applicable',
    })
  } catch (error) {
    next(error)
  }
}

// ==========================================
// APPLY PREDEFINED DISCOUNT
// ==========================================

/**
 * Apply a predefined discount to an order
 *
 * POST /api/v1/tpv/venues/:venueId/orders/:orderId/discounts/apply
 */
export async function applyPredefinedDiscount(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, orderId } = req.params
    const { discountId, authorizedById } = req.body as { discountId: string; authorizedById?: string }
    const authContext = (req as any).authContext
    const staffVenueId = authContext?.staffVenueId

    const result = await discountTpvService.applyPredefinedDiscount(venueId, orderId, discountId, staffVenueId, authorizedById)

    if (result.success) {
      res.status(200).json({
        success: true,
        data: {
          amount: result.amount,
          newOrderTotal: result.newOrderTotal,
        },
        message: 'Discount applied successfully',
      })
    } else {
      res.status(400).json({
        success: false,
        error: result.error,
      })
    }
  } catch (error) {
    next(error)
  }
}

// ==========================================
// APPLY MANUAL DISCOUNT
// ==========================================

/**
 * Apply a manual (on-the-fly) discount to an order
 *
 * POST /api/v1/tpv/venues/:venueId/orders/:orderId/discounts/manual
 */
export async function applyManualDiscount(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, orderId } = req.params
    const { type, value, reason, authorizedById } = req.body as {
      type: DiscountType
      value: number
      reason: string
      authorizedById?: string
    }
    const authContext = (req as any).authContext
    const staffVenueId = authContext?.staffVenueId

    const result = await discountTpvService.applyManualDiscount(venueId, orderId, type, value, reason, staffVenueId, authorizedById)

    if (result.success) {
      res.status(200).json({
        success: true,
        data: {
          amount: result.amount,
          newOrderTotal: result.newOrderTotal,
        },
        message: 'Manual discount applied successfully',
      })
    } else {
      res.status(400).json({
        success: false,
        error: result.error,
      })
    }
  } catch (error) {
    next(error)
  }
}

// ==========================================
// APPLY COUPON CODE
// ==========================================

/**
 * Apply a coupon code to an order
 *
 * POST /api/v1/tpv/venues/:venueId/orders/:orderId/discounts/coupon
 */
export async function applyCouponCode(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, orderId } = req.params
    const { couponCode } = req.body as { couponCode: string }
    const authContext = (req as any).authContext
    const staffVenueId = authContext?.staffVenueId

    const result = await discountTpvService.applyCouponCode(venueId, orderId, couponCode, staffVenueId)

    if (result.success) {
      res.status(200).json({
        success: true,
        data: {
          couponId: result.couponId,
          discountName: result.discountName,
          amount: result.amount,
          newOrderTotal: result.newOrderTotal,
        },
        message: `Coupon "${couponCode}" applied successfully`,
      })
    } else {
      res.status(400).json({
        success: false,
        error: result.error,
      })
    }
  } catch (error) {
    next(error)
  }
}

// ==========================================
// VALIDATE COUPON
// ==========================================

/**
 * Validate a coupon code without applying it
 *
 * POST /api/v1/tpv/venues/:venueId/coupons/validate
 */
export async function validateCoupon(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    const { couponCode, orderTotal, customerId } = req.body as {
      couponCode: string
      orderTotal: number
      customerId?: string
    }

    const result = await discountTpvService.validateCoupon(venueId, couponCode, orderTotal, customerId)

    res.status(200).json({
      success: result.valid,
      data: result,
    })
  } catch (error) {
    next(error)
  }
}

// ==========================================
// REMOVE DISCOUNT
// ==========================================

/**
 * Remove a discount from an order
 *
 * DELETE /api/v1/tpv/venues/:venueId/orders/:orderId/discounts/:discountId
 */
export async function removeDiscount(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, orderId, discountId } = req.params

    const result = await discountTpvService.removeDiscount(venueId, orderId, discountId)

    if (result.success) {
      res.status(200).json({
        success: true,
        data: {
          amount: result.amount,
          newOrderTotal: result.newOrderTotal,
        },
        message: 'Discount removed successfully',
      })
    } else {
      res.status(400).json({
        success: false,
        error: result.error,
      })
    }
  } catch (error) {
    next(error)
  }
}

// ==========================================
// GET ORDER DISCOUNTS
// ==========================================

/**
 * Get all discounts applied to an order
 *
 * GET /api/v1/tpv/venues/:venueId/orders/:orderId/discounts
 */
export async function getOrderDiscounts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, orderId } = req.params

    const discounts = await discountTpvService.getOrderDiscounts(venueId, orderId)

    const totalSavings = discounts.reduce((sum, d) => sum + d.amount, 0)

    res.status(200).json({
      success: true,
      data: discounts,
      count: discounts.length,
      totalSavings,
    })
  } catch (error) {
    next(error)
  }
}
