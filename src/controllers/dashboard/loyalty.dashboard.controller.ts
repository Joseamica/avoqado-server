/**
 * Loyalty Program Controller (Thin HTTP Layer)
 *
 * WHY: Orchestrate HTTP requests/responses without business logic.
 *
 * PATTERN: Thin Controller Architecture
 * - Extract data from req (params, query, body)
 * - Call service method (business logic lives there)
 * - Return HTTP response
 * - NO business logic here (calculations, validations, database queries)
 *
 * RESPONSIBILITIES:
 * ✅ Extract request data
 * ✅ Call service functions
 * ✅ Return HTTP responses
 * ❌ Business logic (belongs in service)
 * ❌ Database queries (belongs in service)
 */

import { Request, Response } from 'express'
import * as loyaltyService from '@/services/dashboard/loyalty.dashboard.service'

/**
 * Resolve the caller's StaffVenue.id from their Staff.id (authContext.userId) + venue.
 * LoyaltyTransaction.createdById FKs to StaffVenue.id (not Staff.id) — `authContext` has no
 * `staffVenueId` field (see security.ts's AuthContext), so reading it directly always yields
 * `undefined`. Mirrors creditPack.dashboard.controller.ts's getStaffVenueId.
 */
async function getStaffVenueId(venueId: string, userId: string): Promise<string> {
  const prisma = (await import('../../utils/prismaClient')).default
  const sv = await prisma.staffVenue.findUnique({
    where: { staffId_venueId: { staffId: userId, venueId } },
    select: { id: true },
  })
  if (!sv) throw new Error('Staff no encontrado en este venue')
  return sv.id
}

/**
 * GET /api/dashboard/venues/:venueId/loyalty/config
 * Get loyalty configuration for venue
 */
export async function getLoyaltyConfig(req: Request, res: Response) {
  const { venueId } = req.params

  const result = await loyaltyService.getLoyaltyConfig(venueId)

  return res.status(200).json(result)
}

/**
 * PUT /api/dashboard/venues/:venueId/loyalty/config
 * Update loyalty configuration
 */
export async function updateLoyaltyConfig(req: Request, res: Response) {
  const { venueId } = req.params
  const data = req.body

  const result = await loyaltyService.updateLoyaltyConfig(venueId, data)

  return res.status(200).json(result)
}

/**
 * POST /api/dashboard/venues/:venueId/loyalty/calculate-points
 * Calculate points for a purchase amount
 */
export async function calculatePoints(req: Request, res: Response) {
  const { venueId } = req.params
  const { amount } = req.body

  const points = await loyaltyService.calculatePointsForAmount(venueId, amount)

  return res.status(200).json({ amount, points })
}

/**
 * POST /api/dashboard/venues/:venueId/loyalty/calculate-discount
 * Calculate discount value from points
 */
export async function calculateDiscount(req: Request, res: Response) {
  const { venueId } = req.params
  const { points, orderTotal } = req.body

  const discount = await loyaltyService.calculateDiscountFromPoints(venueId, points, orderTotal)

  return res.status(200).json({ points, orderTotal, discount })
}

/**
 * GET /api/dashboard/venues/:venueId/customers/:customerId/loyalty/balance
 * Get customer's loyalty points balance
 */
export async function getPointsBalance(req: Request, res: Response) {
  const { venueId, customerId } = req.params

  const balance = await loyaltyService.getCustomerPointsBalance(venueId, customerId)

  return res.status(200).json({ customerId, balance })
}

/**
 * POST /api/dashboard/venues/:venueId/customers/:customerId/loyalty/redeem
 * Redeem points for discount
 */
export async function redeemPoints(req: Request, res: Response) {
  const { venueId, customerId } = req.params
  const { points, orderId } = req.body
  const authContext = (req as any).authContext
  const staffId = authContext?.userId ? await getStaffVenueId(venueId, authContext.userId) : undefined

  const result = await loyaltyService.redeemPoints(venueId, customerId, points, orderId, staffId)

  return res.status(200).json(result)
}

/**
 * POST /api/dashboard/venues/:venueId/customers/:customerId/loyalty/adjust
 * Manual point adjustment by staff
 */
export async function adjustPoints(req: Request, res: Response) {
  const { venueId, customerId } = req.params
  const { points, reason } = req.body
  const authContext = (req as any).authContext

  if (!authContext?.userId) {
    return res.status(403).json({ error: 'Staff authentication required for point adjustments' })
  }

  const staffId = await getStaffVenueId(venueId, authContext.userId)

  const result = await loyaltyService.adjustPoints(venueId, customerId, points, reason, staffId)

  return res.status(200).json(result)
}

/**
 * GET /api/dashboard/venues/:venueId/customers/:customerId/loyalty/transactions
 * Get loyalty transaction history for customer
 */
export async function getLoyaltyTransactions(req: Request, res: Response) {
  const { venueId, customerId } = req.params
  const { page, pageSize, type } = req.query

  const result = await loyaltyService.getLoyaltyTransactions(venueId, customerId, {
    page: page ? Number(page) : undefined,
    pageSize: pageSize ? Number(pageSize) : undefined,
    type: type as any,
  })

  return res.status(200).json(result)
}

/**
 * POST /api/dashboard/venues/:venueId/loyalty/expire-old-points
 * Expire old loyalty points (admin/cron job endpoint)
 */
export async function expireOldPoints(req: Request, res: Response) {
  const { venueId } = req.params

  const result = await loyaltyService.expireOldPoints(venueId)

  return res.status(200).json(result)
}
