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
import AppError from '@/errors/AppError'
import logger from '@/config/logger'
import { tienePermisoEnVenue } from '@/middlewares/permissionFlag.middleware'
import { conCortesiaSiRegala, pinDeLaCortesia, tieneCortesiaAutorizada } from '@/middlewares/cortesiaPidePermiso.middleware'

/** D3: la sesión de la TPV no trae `staffVenueId`; `appliedById` es la membresía de quien llama (sin ella, sin autor). */
const membresiaDe = (req: Request) => discountTpvService.membresiaDeQuienLlama(req.params.venueId, req.authContext?.userId)

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
    const staffVenueId = await membresiaDe(req)

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
    // D2 (hz:f34960c5:D2): el `authorizedById` del cuerpo ya no cuenta; la aprobación sale del permiso comprobado en la ruta.
    const { discountId } = req.body as { discountId: string }
    const staffVenueId = await membresiaDe(req)

    const result = await discountTpvService.applyPredefinedDiscount(
      venueId,
      orderId,
      discountId,
      staffVenueId,
      tieneCortesiaAutorizada(req) ? { porPin: pinDeLaCortesia(req) } : undefined,
    )

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
    const staffVenueId = await membresiaDe(req)

    // D1: una COMP la acredita `checkCortesiaEnDescuento` en la ruta (con el PIN que autorizó la cortesía, Codex r4 #3). Un % o
    // fijo que resulta dejar la cuenta en $0 lo descubre el motor; entonces se pide `orders:comp` aquí (hz:e0b12f00:D1).
    const result = await conCortesiaSiRegala(req, res, cortesia =>
      discountTpvService.applyManualDiscount(venueId, orderId, type, value, reason, staffVenueId, authorizedById, cortesia),
    )
    if (!result) return

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
    const staffVenueId = await membresiaDe(req)

    // D14: un cupón de cortesía regala la cuenta; el servicio lo rechaza si quien llama no tiene `orders:comp` (como la venta de D5).
    const puedeRegalar = await tienePermisoEnVenue(req, 'orders:comp')
    const result = await discountTpvService.applyCouponCode(venueId, orderId, couponCode, staffVenueId, puedeRegalar)

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
    // La TPV sólo lee `error` en el rechazo del cupón (`DiscountRepositoryImpl.kt:312`); sin ella pinta «Coupon already applied or
    // invalid» y esconde la causa (R11 de una importada, IVA anterior…). Mismo sobre que el manejador global, más `success`/`error`.
    if (error instanceof AppError && error.statusCode < 500) {
      logger.warn(`Coupon rejected: ${error.message}`, { code: error.code, statusCode: error.statusCode })
      res.status(error.statusCode).json({
        success: false,
        error: error.message,
        message: error.message,
        ...(error.code && { code: error.code }),
        ...(error.details !== undefined && { details: error.details }),
      })
      return
    }
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
    const { userId: staffId } = (req as any).authContext

    const result = await discountTpvService.removeDiscount(venueId, orderId, discountId, staffId)

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
