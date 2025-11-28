/**
 * Discount Dashboard Controller
 *
 * Thin controller layer - orchestrates HTTP, delegates to service.
 * Contains NO business logic, only:
 * - Request/response handling
 * - Calling service functions
 * - Error responses
 *
 * @see CLAUDE.md - Layered Architecture section
 * @see src/services/dashboard/discount.dashboard.service.ts - Business logic
 */

import { Request, Response, NextFunction } from 'express'
import * as discountService from '@/services/dashboard/discount.dashboard.service'
import {
  getDiscountsQuerySchema,
  createDiscountBodySchema,
  updateDiscountBodySchema,
  assignDiscountToCustomerBodySchema,
} from '@/schemas/dashboard/discount.schema'

// ==========================================
// DISCOUNT CRUD
// ==========================================

/**
 * GET /api/v1/dashboard/venues/:venueId/discounts
 * List all discounts with pagination and filtering
 */
export async function getDiscounts(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const query = getDiscountsQuerySchema.parse(req.query)

    const result = await discountService.getDiscounts(
      venueId,
      query.page,
      query.pageSize,
      query.search,
      query.type,
      query.scope,
      query.isAutomatic,
      query.active,
    )

    res.json(result)
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/discounts/:discountId
 * Get single discount by ID
 */
export async function getDiscountById(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, discountId } = req.params

    const discount = await discountService.getDiscountById(venueId, discountId)

    res.json(discount)
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/discounts
 * Create a new discount
 */
export async function createDiscount(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const body = createDiscountBodySchema.parse(req.body)
    const authContext = (req as any).authContext

    const discount = await discountService.createDiscount(venueId, body, authContext?.staffVenueId)

    res.status(201).json(discount)
  } catch (error) {
    next(error)
  }
}

/**
 * PUT /api/v1/dashboard/venues/:venueId/discounts/:discountId
 * Update an existing discount
 */
export async function updateDiscount(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, discountId } = req.params
    const body = updateDiscountBodySchema.parse(req.body)

    const discount = await discountService.updateDiscount(venueId, discountId, body)

    res.json(discount)
  } catch (error) {
    next(error)
  }
}

/**
 * DELETE /api/v1/dashboard/venues/:venueId/discounts/:discountId
 * Delete a discount
 */
export async function deleteDiscount(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, discountId } = req.params

    await discountService.deleteDiscount(venueId, discountId)

    res.status(204).send()
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/discounts/:discountId/clone
 * Clone a discount
 */
export async function cloneDiscount(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, discountId } = req.params
    const authContext = (req as any).authContext

    const discount = await discountService.cloneDiscount(venueId, discountId, authContext?.staffVenueId)

    res.status(201).json(discount)
  } catch (error) {
    next(error)
  }
}

// ==========================================
// DISCOUNT STATISTICS
// ==========================================

/**
 * GET /api/v1/dashboard/venues/:venueId/discounts/stats
 * Get discount statistics
 */
export async function getDiscountStats(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params

    const stats = await discountService.getDiscountStats(venueId)

    res.json(stats)
  } catch (error) {
    next(error)
  }
}

// ==========================================
// CUSTOMER DISCOUNT ASSIGNMENT
// ==========================================

/**
 * POST /api/v1/dashboard/venues/:venueId/discounts/:discountId/customers
 * Assign a discount to a customer
 */
export async function assignDiscountToCustomer(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, discountId } = req.params
    const body = assignDiscountToCustomerBodySchema.parse(req.body)
    const authContext = (req as any).authContext

    const assignment = await discountService.assignDiscountToCustomer(venueId, discountId, body.customerId, authContext?.staffVenueId, {
      validFrom: body.validFrom,
      validUntil: body.validUntil,
      maxUses: body.maxUses,
    })

    res.status(201).json(assignment)
  } catch (error) {
    next(error)
  }
}

/**
 * DELETE /api/v1/dashboard/venues/:venueId/discounts/:discountId/customers/:customerId
 * Remove a discount from a customer
 */
export async function removeDiscountFromCustomer(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, discountId, customerId } = req.params

    await discountService.removeDiscountFromCustomer(venueId, discountId, customerId)

    res.status(204).send()
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/customers/:customerId/discounts
 * Get all discounts assigned to a customer
 */
export async function getCustomerDiscounts(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, customerId } = req.params

    const discounts = await discountService.getCustomerDiscounts(venueId, customerId)

    res.json(discounts)
  } catch (error) {
    next(error)
  }
}

// ==========================================
// AUTOMATIC DISCOUNTS
// ==========================================

/**
 * GET /api/v1/dashboard/venues/:venueId/discounts/automatic
 * Get all active automatic discounts
 */
export async function getActiveAutomaticDiscounts(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params

    const discounts = await discountService.getActiveAutomaticDiscounts(venueId)

    res.json(discounts)
  } catch (error) {
    next(error)
  }
}
