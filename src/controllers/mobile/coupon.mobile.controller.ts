/**
 * Mobile Coupon Controller
 *
 * CRUD + validation endpoints for coupon code management from mobile apps (iOS/Android).
 * Uses direct Prisma queries with mobile-standard response format.
 *
 * @route /api/v1/mobile/venues/:venueId/coupons
 */

import { Request, Response } from 'express'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'

// ==========================================
// LIST COUPONS
// ==========================================

/**
 * GET /api/v1/mobile/venues/:venueId/coupons
 *
 * List all coupon codes for a venue.
 */
export async function listCoupons(req: Request, res: Response) {
  try {
    const { venueId } = req.params

    const coupons = await prisma.couponCode.findMany({
      where: {
        discount: { venueId },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        discount: {
          select: {
            id: true,
            name: true,
            type: true,
            value: true,
            scope: true,
          },
        },
        _count: {
          select: {
            redemptions: true,
          },
        },
      },
    })

    const data = coupons.map(c => ({
      ...c,
      discount: {
        ...c.discount,
        value: Number(c.discount.value),
      },
      minPurchaseAmount: c.minPurchaseAmount ? Number(c.minPurchaseAmount) : null,
    }))

    return res.json({ success: true, data })
  } catch (error) {
    logger.error('Error listing coupons (mobile)', { error })
    return res.status(500).json({ success: false, message: 'Error al cargar cupones' })
  }
}

// ==========================================
// CREATE COUPON
// ==========================================

/**
 * POST /api/v1/mobile/venues/:venueId/coupons
 *
 * Create a new coupon code linked to an existing discount.
 */
export async function createCoupon(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const {
      discountId,
      code,
      maxUses,
      maxUsesPerCustomer,
      minPurchaseAmount,
      validFrom,
      validUntil,
      active,
    } = req.body

    if (!discountId) {
      return res.status(400).json({ success: false, message: 'discountId es requerido' })
    }
    if (!code || !code.trim()) {
      return res.status(400).json({ success: false, message: 'code es requerido' })
    }

    // Verify discount exists and belongs to venue
    const discount = await prisma.discount.findFirst({
      where: { id: discountId, venueId },
    })
    if (!discount) {
      return res.status(404).json({ success: false, message: 'Descuento no encontrado' })
    }

    // Normalize code to uppercase
    const normalizedCode = code.toUpperCase().trim()

    // Validate code format
    if (!/^[A-Z0-9\-_]+$/.test(normalizedCode)) {
      return res.status(400).json({
        success: false,
        message: 'El codigo solo puede contener letras, numeros, guiones y guiones bajos',
      })
    }
    if (normalizedCode.length < 3 || normalizedCode.length > 30) {
      return res.status(400).json({
        success: false,
        message: 'El codigo debe tener entre 3 y 30 caracteres',
      })
    }

    // Check uniqueness
    const existingCode = await prisma.couponCode.findUnique({
      where: { code: normalizedCode },
    })
    if (existingCode) {
      return res.status(400).json({
        success: false,
        message: `El codigo "${normalizedCode}" ya existe`,
      })
    }

    const coupon = await prisma.couponCode.create({
      data: {
        discountId,
        code: normalizedCode,
        maxUses: maxUses ?? null,
        maxUsesPerCustomer: maxUsesPerCustomer ?? null,
        minPurchaseAmount: minPurchaseAmount ?? null,
        validFrom: validFrom ? new Date(validFrom) : null,
        validUntil: validUntil ? new Date(validUntil) : null,
        active: active ?? true,
      },
      include: {
        discount: {
          select: {
            id: true,
            name: true,
            type: true,
            value: true,
          },
        },
      },
    })

    logger.info(`Coupon created (mobile): ${normalizedCode} for discount ${discount.name}`)

    return res.status(201).json({
      success: true,
      data: {
        ...coupon,
        discount: {
          ...coupon.discount,
          value: Number(coupon.discount.value),
        },
        minPurchaseAmount: coupon.minPurchaseAmount ? Number(coupon.minPurchaseAmount) : null,
      },
    })
  } catch (error) {
    logger.error('Error creating coupon (mobile)', { error })
    return res.status(500).json({ success: false, message: 'Error al crear cupon' })
  }
}

// ==========================================
// UPDATE COUPON
// ==========================================

/**
 * PUT /api/v1/mobile/venues/:venueId/coupons/:couponId
 *
 * Update an existing coupon code.
 */
export async function updateCoupon(req: Request, res: Response) {
  try {
    const { venueId, couponId } = req.params

    // Verify coupon exists and belongs to venue (through discount)
    const existing = await prisma.couponCode.findFirst({
      where: { id: couponId, discount: { venueId } },
    })
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Cupon no encontrado' })
    }

    const {
      code,
      maxUses,
      maxUsesPerCustomer,
      minPurchaseAmount,
      validFrom,
      validUntil,
      active,
    } = req.body

    // If updating code, normalize and check uniqueness
    let normalizedCode: string | undefined = undefined
    if (code !== undefined) {
      normalizedCode = (code as string).toUpperCase().trim()

      if (!/^[A-Z0-9\-_]+$/.test(normalizedCode!)) {
        return res.status(400).json({
          success: false,
          message: 'El codigo solo puede contener letras, numeros, guiones y guiones bajos',
        })
      }
      if (normalizedCode!.length < 3 || normalizedCode!.length > 30) {
        return res.status(400).json({
          success: false,
          message: 'El codigo debe tener entre 3 y 30 caracteres',
        })
      }

      // Check uniqueness only if code changed
      if (normalizedCode !== existing.code) {
        const existingCode = await prisma.couponCode.findUnique({
          where: { code: normalizedCode },
        })
        if (existingCode) {
          return res.status(400).json({
            success: false,
            message: `El codigo "${normalizedCode}" ya existe`,
          })
        }
      }
    }

    const coupon = await prisma.couponCode.update({
      where: { id: couponId },
      data: {
        ...(normalizedCode !== undefined && { code: normalizedCode }),
        ...(maxUses !== undefined && { maxUses }),
        ...(maxUsesPerCustomer !== undefined && { maxUsesPerCustomer }),
        ...(minPurchaseAmount !== undefined && { minPurchaseAmount }),
        ...(validFrom !== undefined && { validFrom: validFrom ? new Date(validFrom) : null }),
        ...(validUntil !== undefined && { validUntil: validUntil ? new Date(validUntil) : null }),
        ...(active !== undefined && { active }),
      },
      include: {
        discount: {
          select: {
            id: true,
            name: true,
            type: true,
            value: true,
          },
        },
      },
    })

    logger.info(`Coupon updated (mobile): ${coupon.code}`)

    return res.json({
      success: true,
      data: {
        ...coupon,
        discount: {
          ...coupon.discount,
          value: Number(coupon.discount.value),
        },
        minPurchaseAmount: coupon.minPurchaseAmount ? Number(coupon.minPurchaseAmount) : null,
      },
    })
  } catch (error) {
    logger.error('Error updating coupon (mobile)', { error })
    return res.status(500).json({ success: false, message: 'Error al actualizar cupon' })
  }
}

// ==========================================
// DELETE COUPON
// ==========================================

/**
 * DELETE /api/v1/mobile/venues/:venueId/coupons/:couponId
 *
 * Delete a coupon code.
 */
export async function deleteCoupon(req: Request, res: Response) {
  try {
    const { venueId, couponId } = req.params

    // Verify coupon exists and belongs to venue (through discount)
    const existing = await prisma.couponCode.findFirst({
      where: { id: couponId, discount: { venueId } },
    })
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Cupon no encontrado' })
    }

    await prisma.couponCode.delete({
      where: { id: couponId },
    })

    logger.info(`Coupon deleted (mobile): ${existing.code} (${couponId})`)

    return res.json({ success: true, data: { id: couponId } })
  } catch (error) {
    logger.error('Error deleting coupon (mobile)', { error })
    return res.status(500).json({ success: false, message: 'Error al eliminar cupon' })
  }
}

// ==========================================
// VALIDATE COUPON
// ==========================================

/**
 * POST /api/v1/mobile/venues/:venueId/coupons/validate
 *
 * Validate a coupon code. Checks:
 * - Code exists and belongs to venue
 * - Coupon is active
 * - Parent discount is active
 * - Not expired / not before valid date
 * - Usage limit not exceeded
 * - Minimum purchase amount met (if orderTotal provided)
 * - Per-customer limit not exceeded (if customerId provided)
 */
export async function validateCoupon(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const { code, orderTotal, customerId } = req.body

    if (!code || !code.trim()) {
      return res.status(400).json({ success: false, message: 'code es requerido' })
    }

    const normalizedCode = code.toUpperCase().trim()

    // Find the coupon with its parent discount
    const coupon = await prisma.couponCode.findFirst({
      where: {
        code: normalizedCode,
        discount: { venueId },
      },
      include: {
        discount: {
          select: {
            id: true,
            name: true,
            type: true,
            value: true,
            scope: true,
            maxDiscountAmount: true,
            active: true,
          },
        },
      },
    })

    if (!coupon) {
      return res.json({
        success: true,
        data: {
          valid: false,
          error: 'Codigo de cupon no encontrado',
          errorCode: 'NOT_FOUND',
        },
      })
    }

    // Check if coupon is active
    if (!coupon.active) {
      return res.json({
        success: true,
        data: {
          valid: false,
          error: 'El cupon esta inactivo',
          errorCode: 'INACTIVE',
        },
      })
    }

    // Check if parent discount is active
    if (!coupon.discount.active) {
      return res.json({
        success: true,
        data: {
          valid: false,
          error: 'El descuento asociado a este cupon esta inactivo',
          errorCode: 'INACTIVE',
        },
      })
    }

    const now = new Date()

    // Check validity period — not started
    if (coupon.validFrom && coupon.validFrom > now) {
      return res.json({
        success: true,
        data: {
          valid: false,
          error: `El cupon aun no es valido. Valido desde ${coupon.validFrom.toISOString()}`,
          errorCode: 'NOT_STARTED',
        },
      })
    }

    // Check validity period — expired
    if (coupon.validUntil && coupon.validUntil < now) {
      return res.json({
        success: true,
        data: {
          valid: false,
          error: 'El cupon ha expirado',
          errorCode: 'EXPIRED',
        },
      })
    }

    // Check usage limit
    if (coupon.maxUses !== null && coupon.currentUses >= coupon.maxUses) {
      return res.json({
        success: true,
        data: {
          valid: false,
          error: 'El limite de usos del cupon ha sido alcanzado',
          errorCode: 'USAGE_LIMIT',
        },
      })
    }

    // Check minimum purchase amount
    if (coupon.minPurchaseAmount !== null && orderTotal !== undefined) {
      if (orderTotal < Number(coupon.minPurchaseAmount)) {
        return res.json({
          success: true,
          data: {
            valid: false,
            error: `Compra minima de ${Number(coupon.minPurchaseAmount)} requerida`,
            errorCode: 'MIN_PURCHASE',
          },
        })
      }
    }

    // Check per-customer usage limit
    if (coupon.maxUsesPerCustomer !== null && customerId) {
      const customerRedemptions = await prisma.couponRedemption.count({
        where: {
          couponCodeId: coupon.id,
          customerId,
        },
      })

      if (customerRedemptions >= coupon.maxUsesPerCustomer) {
        return res.json({
          success: true,
          data: {
            valid: false,
            error: `Ya has usado este cupon ${coupon.maxUsesPerCustomer} vez/veces`,
            errorCode: 'CUSTOMER_LIMIT',
          },
        })
      }
    }

    // Coupon is valid
    return res.json({
      success: true,
      data: {
        valid: true,
        coupon: {
          id: coupon.id,
          code: coupon.code,
          discount: {
            id: coupon.discount.id,
            name: coupon.discount.name,
            type: coupon.discount.type,
            value: Number(coupon.discount.value),
            scope: coupon.discount.scope,
            maxDiscountAmount: coupon.discount.maxDiscountAmount
              ? Number(coupon.discount.maxDiscountAmount)
              : null,
          },
        },
      },
    })
  } catch (error) {
    logger.error('Error validating coupon (mobile)', { error })
    return res.status(500).json({ success: false, message: 'Error al validar cupon' })
  }
}
