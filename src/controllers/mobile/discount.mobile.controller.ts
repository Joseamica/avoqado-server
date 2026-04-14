/**
 * Mobile Discount Controller
 *
 * CRUD endpoints for discount management from mobile apps (iOS/Android).
 * Uses direct Prisma queries with mobile-standard response format.
 *
 * @route /api/v1/mobile/venues/:venueId/discounts
 */

import { Request, Response } from 'express'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'

// ==========================================
// LIST DISCOUNTS
// ==========================================

/**
 * GET /api/v1/mobile/venues/:venueId/discounts
 *
 * List all discounts for a venue.
 * Supports ?active=true query filter.
 */
export async function listDiscounts(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const activeParam = req.query.active as string | undefined

    const where: Record<string, unknown> = { venueId }
    if (activeParam === 'true') {
      where.active = true
    } else if (activeParam === 'false') {
      where.active = false
    }

    const discounts = await prisma.discount.findMany({
      where,
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
      include: {
        customerGroup: {
          select: {
            id: true,
            name: true,
            color: true,
          },
        },
        _count: {
          select: {
            couponCodes: true,
            customerDiscounts: true,
            orderDiscounts: true,
          },
        },
      },
    })

    // Convert Decimal fields to numbers for JSON serialization
    const data = discounts.map(d => ({
      ...d,
      value: Number(d.value),
      minPurchaseAmount: d.minPurchaseAmount ? Number(d.minPurchaseAmount) : null,
      maxDiscountAmount: d.maxDiscountAmount ? Number(d.maxDiscountAmount) : null,
      getDiscountPercent: d.getDiscountPercent ? Number(d.getDiscountPercent) : null,
    }))

    return res.json({ success: true, data })
  } catch (error) {
    logger.error('Error listing discounts (mobile)', { error })
    return res.status(500).json({ success: false, message: 'Error al cargar descuentos' })
  }
}

// ==========================================
// CREATE DISCOUNT
// ==========================================

/**
 * POST /api/v1/mobile/venues/:venueId/discounts
 *
 * Create a new discount.
 */
export async function createDiscount(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const {
      name,
      description,
      type,
      value,
      scope,
      targetItemIds,
      targetCategoryIds,
      targetModifierIds,
      targetModifierGroupIds,
      customerGroupId,
      isAutomatic,
      priority,
      minPurchaseAmount,
      maxDiscountAmount,
      minQuantity,
      buyQuantity,
      getQuantity,
      getDiscountPercent,
      buyItemIds,
      getItemIds,
      validFrom,
      validUntil,
      daysOfWeek,
      timeFrom,
      timeUntil,
      maxTotalUses,
      maxUsesPerCustomer,
      requiresApproval,
      compReason,
      applyBeforeTax,
      modifyTaxBasis,
      isStackable,
      stackPriority,
      active,
    } = req.body

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'name es requerido' })
    }
    if (!type) {
      return res.status(400).json({ success: false, message: 'type es requerido' })
    }
    if (value === undefined || value === null) {
      return res.status(400).json({ success: false, message: 'value es requerido' })
    }

    // Validate value based on type
    if (type === 'PERCENTAGE' && (value < 0 || value > 100)) {
      return res.status(400).json({ success: false, message: 'El valor del porcentaje debe estar entre 0 y 100' })
    }
    if (type === 'FIXED_AMOUNT' && value < 0) {
      return res.status(400).json({ success: false, message: 'El valor del monto fijo debe ser positivo' })
    }

    const staffVenueId = (req.authContext as any)?.staffVenueId

    const discount = await prisma.discount.create({
      data: {
        venueId,
        name: name.trim(),
        description: description || null,
        type,
        value: type === 'COMP' ? 100 : value,
        scope: scope || 'ORDER',
        targetItemIds: targetItemIds || [],
        targetCategoryIds: targetCategoryIds || [],
        targetModifierIds: targetModifierIds || [],
        targetModifierGroupIds: targetModifierGroupIds || [],
        customerGroupId: customerGroupId || null,
        isAutomatic: isAutomatic ?? false,
        priority: priority ?? 0,
        minPurchaseAmount: minPurchaseAmount ?? null,
        maxDiscountAmount: maxDiscountAmount ?? null,
        minQuantity: minQuantity ?? null,
        buyQuantity: buyQuantity ?? null,
        getQuantity: getQuantity ?? null,
        getDiscountPercent: getDiscountPercent ?? null,
        buyItemIds: buyItemIds || [],
        getItemIds: getItemIds || [],
        validFrom: validFrom ? new Date(validFrom) : null,
        validUntil: validUntil ? new Date(validUntil) : null,
        daysOfWeek: daysOfWeek || [],
        timeFrom: timeFrom || null,
        timeUntil: timeUntil || null,
        maxTotalUses: maxTotalUses ?? null,
        maxUsesPerCustomer: maxUsesPerCustomer ?? null,
        requiresApproval: requiresApproval ?? false,
        compReason: compReason || null,
        applyBeforeTax: applyBeforeTax ?? true,
        modifyTaxBasis: modifyTaxBasis ?? true,
        isStackable: isStackable ?? false,
        stackPriority: stackPriority ?? 0,
        active: active ?? true,
        createdById: staffVenueId || null,
      },
      include: {
        customerGroup: {
          select: {
            id: true,
            name: true,
            color: true,
          },
        },
      },
    })

    logger.info(`Discount created (mobile): ${discount.name} (${discount.id}) for venue ${venueId}`)

    return res.status(201).json({
      success: true,
      data: {
        ...discount,
        value: Number(discount.value),
        minPurchaseAmount: discount.minPurchaseAmount ? Number(discount.minPurchaseAmount) : null,
        maxDiscountAmount: discount.maxDiscountAmount ? Number(discount.maxDiscountAmount) : null,
        getDiscountPercent: discount.getDiscountPercent ? Number(discount.getDiscountPercent) : null,
      },
    })
  } catch (error) {
    logger.error('Error creating discount (mobile)', { error })
    return res.status(500).json({ success: false, message: 'Error al crear descuento' })
  }
}

// ==========================================
// UPDATE DISCOUNT
// ==========================================

/**
 * PUT /api/v1/mobile/venues/:venueId/discounts/:discountId
 *
 * Update an existing discount.
 */
export async function updateDiscount(req: Request, res: Response) {
  try {
    const { venueId, discountId } = req.params

    // Verify discount exists and belongs to venue
    const existing = await prisma.discount.findFirst({
      where: { id: discountId, venueId },
    })
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Descuento no encontrado' })
    }

    const {
      name,
      description,
      type,
      value,
      scope,
      targetItemIds,
      targetCategoryIds,
      targetModifierIds,
      targetModifierGroupIds,
      customerGroupId,
      isAutomatic,
      priority,
      minPurchaseAmount,
      maxDiscountAmount,
      minQuantity,
      buyQuantity,
      getQuantity,
      getDiscountPercent,
      buyItemIds,
      getItemIds,
      validFrom,
      validUntil,
      daysOfWeek,
      timeFrom,
      timeUntil,
      maxTotalUses,
      maxUsesPerCustomer,
      requiresApproval,
      compReason,
      applyBeforeTax,
      modifyTaxBasis,
      isStackable,
      stackPriority,
      active,
    } = req.body

    // Validate value based on type if provided
    const effectiveType = type ?? existing.type
    const effectiveValue = value ?? Number(existing.value)
    if (effectiveType === 'PERCENTAGE' && (effectiveValue < 0 || effectiveValue > 100)) {
      return res.status(400).json({ success: false, message: 'El valor del porcentaje debe estar entre 0 y 100' })
    }
    if (effectiveType === 'FIXED_AMOUNT' && effectiveValue < 0) {
      return res.status(400).json({ success: false, message: 'El valor del monto fijo debe ser positivo' })
    }

    const discount = await prisma.discount.update({
      where: { id: discountId },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(description !== undefined && { description }),
        ...(type !== undefined && { type }),
        ...(value !== undefined && { value }),
        ...(scope !== undefined && { scope }),
        ...(targetItemIds !== undefined && { targetItemIds }),
        ...(targetCategoryIds !== undefined && { targetCategoryIds }),
        ...(targetModifierIds !== undefined && { targetModifierIds }),
        ...(targetModifierGroupIds !== undefined && { targetModifierGroupIds }),
        ...(customerGroupId !== undefined && { customerGroupId }),
        ...(isAutomatic !== undefined && { isAutomatic }),
        ...(priority !== undefined && { priority }),
        ...(minPurchaseAmount !== undefined && { minPurchaseAmount }),
        ...(maxDiscountAmount !== undefined && { maxDiscountAmount }),
        ...(minQuantity !== undefined && { minQuantity }),
        ...(buyQuantity !== undefined && { buyQuantity }),
        ...(getQuantity !== undefined && { getQuantity }),
        ...(getDiscountPercent !== undefined && { getDiscountPercent }),
        ...(buyItemIds !== undefined && { buyItemIds }),
        ...(getItemIds !== undefined && { getItemIds }),
        ...(validFrom !== undefined && { validFrom: validFrom ? new Date(validFrom) : null }),
        ...(validUntil !== undefined && { validUntil: validUntil ? new Date(validUntil) : null }),
        ...(daysOfWeek !== undefined && { daysOfWeek }),
        ...(timeFrom !== undefined && { timeFrom }),
        ...(timeUntil !== undefined && { timeUntil }),
        ...(maxTotalUses !== undefined && { maxTotalUses }),
        ...(maxUsesPerCustomer !== undefined && { maxUsesPerCustomer }),
        ...(requiresApproval !== undefined && { requiresApproval }),
        ...(compReason !== undefined && { compReason }),
        ...(applyBeforeTax !== undefined && { applyBeforeTax }),
        ...(modifyTaxBasis !== undefined && { modifyTaxBasis }),
        ...(isStackable !== undefined && { isStackable }),
        ...(stackPriority !== undefined && { stackPriority }),
        ...(active !== undefined && { active }),
      },
      include: {
        customerGroup: {
          select: {
            id: true,
            name: true,
            color: true,
          },
        },
      },
    })

    logger.info(`Discount updated (mobile): ${discount.name} (${discount.id})`)

    return res.json({
      success: true,
      data: {
        ...discount,
        value: Number(discount.value),
        minPurchaseAmount: discount.minPurchaseAmount ? Number(discount.minPurchaseAmount) : null,
        maxDiscountAmount: discount.maxDiscountAmount ? Number(discount.maxDiscountAmount) : null,
        getDiscountPercent: discount.getDiscountPercent ? Number(discount.getDiscountPercent) : null,
      },
    })
  } catch (error) {
    logger.error('Error updating discount (mobile)', { error })
    return res.status(500).json({ success: false, message: 'Error al actualizar descuento' })
  }
}

// ==========================================
// DELETE DISCOUNT
// ==========================================

/**
 * DELETE /api/v1/mobile/venues/:venueId/discounts/:discountId
 *
 * Delete a discount.
 */
export async function deleteDiscount(req: Request, res: Response) {
  try {
    const { venueId, discountId } = req.params

    // Verify discount exists and belongs to venue
    const existing = await prisma.discount.findFirst({
      where: { id: discountId, venueId },
    })
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Descuento no encontrado' })
    }

    await prisma.discount.delete({
      where: { id: discountId },
    })

    logger.info(`Discount deleted (mobile): ${existing.name} (${discountId})`)

    return res.json({ success: true, data: { id: discountId } })
  } catch (error) {
    logger.error('Error deleting discount (mobile)', { error })
    return res.status(500).json({ success: false, message: 'Error al eliminar descuento' })
  }
}
