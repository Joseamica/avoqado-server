/**
 * Credit Pack Mobile Controller (iOS/Android POS — staff-facing)
 *
 * List packs, look up a customer's balance, sell a pack in person, and redeem a
 * credit. Listing reuses the public service; redemption reuses the dashboard
 * service; the in-person sale + by-id balance live in the mobile service.
 */

import { NextFunction, Request, Response } from 'express'
import prisma from '../../utils/prismaClient'
import { getAvailablePacks } from '../../services/dashboard/creditPack.public.service'
import { redeemItemManually } from '../../services/dashboard/creditPack.dashboard.service'
import * as creditPackService from '../../services/mobile/creditPack.mobile.service'

/**
 * Resolve the caller's StaffVenue.id from their Staff.id + venue — CreditTransaction.createdById
 * FKs to StaffVenue.id (not Staff.id), so passing the raw authContext userId would violate the FK
 * and roll the write back. Mirrors the dashboard controller's getStaffVenueId.
 */
async function resolveStaffVenueId(venueId: string, userId: string): Promise<string> {
  const sv = await prisma.staffVenue.findUnique({
    where: { staffId_venueId: { staffId: userId, venueId } },
    select: { id: true },
  })
  if (!sv) throw new Error('Staff no encontrado en este venue')
  return sv.id
}

/**
 * List the venue's active credit packs (optionally only those including a product).
 * @route GET /api/v1/mobile/venues/:venueId/credit-packs
 */
export const listPacks = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const productId = req.query.productId as string | undefined
    const packs = await getAvailablePacks(venueId, productId)
    return res.json({ success: true, packs })
  } catch (error) {
    next(error)
  }
}

/**
 * A customer's active, non-expired credit balances.
 * @route GET /api/v1/mobile/venues/:venueId/customers/:customerId/credit-balance
 */
export const getBalance = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, customerId } = req.params
    const result = await creditPackService.getCustomerCreditsById(venueId, customerId)
    return res.json({ success: true, ...result })
  } catch (error) {
    next(error)
  }
}

/**
 * Sell a pack to a customer in person (paid through the POS, not Stripe).
 * @route POST /api/v1/mobile/venues/:venueId/credit-packs/:packId/sell
 */
export const sellPack = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, packId } = req.params
    const { customerId, amountPaid, note } = req.body

    if (!customerId) {
      return res.status(400).json({ success: false, message: 'customerId es requerido' })
    }

    const staffVenueId = await resolveStaffVenueId(venueId, req.authContext?.userId || '')
    const purchase = await creditPackService.sellPackInPerson(venueId, packId, customerId, staffVenueId, {
      amountPaid: amountPaid != null ? Number(amountPaid) : undefined,
      note,
    })
    return res.status(201).json({ success: true, purchase })
  } catch (error) {
    next(error)
  }
}

/**
 * Redeem one credit from a balance (e.g. when the customer uses a session).
 * @route POST /api/v1/mobile/venues/:venueId/credit-balances/:balanceId/redeem
 */
export const redeemCredit = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, balanceId } = req.params
    const { reason } = req.body

    const staffVenueId = await resolveStaffVenueId(venueId, req.authContext?.userId || '')
    const transaction = await redeemItemManually(venueId, balanceId, staffVenueId, reason)
    return res.json({ success: true, transaction })
  } catch (error) {
    next(error)
  }
}
