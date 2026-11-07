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
import { withDeadlockRetry } from '../../utils/serializableRetry'
import logger from '../../config/logger'
import { CAMBIO_CRUZADO, dondeEscribir, esCambioCruzado, validarCambioDeDescuento } from '../../services/dashboard/reglasDeDescuento'
import { validateCouponCode } from '../../services/dashboard/coupon.dashboard.service'
import { textoDeRechazoDeCupon } from '../../services/shared/cuponDeLaVenta'

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
    const { discountId, code, maxUses, maxUsesPerCustomer, minPurchaseAmount, validFrom, validUntil, active } = req.body

    if (!discountId) {
      return res.status(400).json({ success: false, message: 'discountId es requerido' })
    }
    // D14: ANDROID manda los usos tal como se escriben (0 incluido); la regla es la misma del panel.
    const invalido = validarCambioDeDescuento(null, { maxUses, maxUsesPerCustomer })
    if (invalido) return res.status(400).json({ success: false, message: invalido })
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

    const coupon = await withDeadlockRetry(
      tx =>
        tx.couponCode.create({
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
        }),
      { etiqueta: 'createCoupon' },
    )

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

    const { code, maxUses, maxUsesPerCustomer, minPurchaseAmount, validFrom, validUntil, active } = req.body
    const cambio = { maxUses, maxUsesPerCustomer }
    const invalido = validarCambioDeDescuento(existing, cambio)
    if (invalido) return res.status(400).json({ success: false, message: invalido })

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

    const coupon = await withDeadlockRetry(
      tx =>
        tx.couponCode.update({
          where: dondeEscribir(couponId, existing, cambio),
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
        }),
      { etiqueta: 'updateCoupon' },
    )

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
    if (esCambioCruzado(error)) return res.status(409).json({ success: false, message: CAMBIO_CRUZADO })
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

    await withDeadlockRetry(
      tx =>
        tx.couponCode.delete({
          where: { id: couponId },
        }),
      { etiqueta: 'deleteCoupon' },
    )

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
 * Validate a coupon code with `validateCouponCode`. Minimum purchase needs `orderTotal`; the per-customer limit needs `customerId`.
 */
export async function validateCoupon(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const { code, orderTotal, customerId } = req.body

    if (typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({ success: false, message: 'code es requerido' })
    }

    // D5: la MISMA regla que la creación de la venta y la terminal; aquí sólo se conserva la forma de la respuesta.
    const validation = await validateCouponCode(
      venueId,
      code,
      typeof orderTotal === 'number' ? orderTotal : undefined,
      typeof customerId === 'string' && customerId ? customerId : undefined,
    )

    if (!validation.valid || !validation.coupon) {
      return res.json({
        success: true,
        data: { valid: false, error: textoDeRechazoDeCupon(validation), errorCode: validation.errorCode },
      })
    }

    return res.json({ success: true, data: { valid: true, coupon: validation.coupon } })
  } catch (error) {
    logger.error('Error validating coupon (mobile)', { error })
    return res.status(500).json({ success: false, message: 'Error al validar cupon' })
  }
}
