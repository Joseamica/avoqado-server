import { Request, Response, NextFunction } from 'express'
import * as creditPackService from '../../services/dashboard/creditPack.dashboard.service'

// ==========================================
// CREDIT PACK DASHBOARD CONTROLLER
// ==========================================

// ---- CRUD ----

export async function getCreditPacks(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = (req as any).authContext
    const packs = await creditPackService.getCreditPacks(venueId)
    res.json(packs)
  } catch (error) {
    next(error)
  }
}

export async function getCreditPackById(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = (req as any).authContext
    const pack = await creditPackService.getCreditPackById(venueId, req.params.packId)
    res.json(pack)
  } catch (error) {
    next(error)
  }
}

export async function createCreditPack(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = (req as any).authContext
    const pack = await creditPackService.createCreditPack(venueId, req.body)
    res.status(201).json(pack)
  } catch (error) {
    next(error)
  }
}

export async function updateCreditPack(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = (req as any).authContext
    const pack = await creditPackService.updateCreditPack(venueId, req.params.packId, req.body)
    res.json(pack)
  } catch (error) {
    next(error)
  }
}

export async function deactivateCreditPack(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = (req as any).authContext
    await creditPackService.deactivateCreditPack(venueId, req.params.packId)
    res.status(204).send()
  } catch (error) {
    next(error)
  }
}

// ---- Purchases & Transactions ----

export async function getPurchases(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = (req as any).authContext
    const result = await creditPackService.getCustomerPurchases(venueId, req.query as any)
    res.json(result)
  } catch (error) {
    next(error)
  }
}

export async function getCustomerPurchases(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = (req as any).authContext
    const { customerId } = req.params
    const result = await creditPackService.getCustomerPurchases(venueId, { customerId, ...((req.query as any) || {}) })
    res.json(result)
  } catch (error) {
    next(error)
  }
}

export async function getTransactions(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = (req as any).authContext
    const result = await creditPackService.getTransactionHistory(venueId, req.query as any)
    res.json(result)
  } catch (error) {
    next(error)
  }
}

// ---- Manual Operations ----

export async function redeemItem(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, userId } = (req as any).authContext
    const { balanceId } = req.params
    const { reason } = req.body || {}

    // Get staffVenueId for createdBy
    const staffVenueId = await getStaffVenueId(venueId, userId)

    const result = await creditPackService.redeemItemManually(venueId, balanceId, staffVenueId, reason)
    res.json(result)
  } catch (error) {
    next(error)
  }
}

export async function adjustBalance(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, userId } = (req as any).authContext
    const { balanceId } = req.params
    const { quantity, reason } = req.body

    const staffVenueId = await getStaffVenueId(venueId, userId)

    const result = await creditPackService.adjustItemBalance(venueId, balanceId, quantity, reason, staffVenueId)
    res.json(result)
  } catch (error) {
    next(error)
  }
}

export async function refundPurchase(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, userId } = (req as any).authContext
    const { purchaseId } = req.params
    const { reason } = req.body

    const staffVenueId = await getStaffVenueId(venueId, userId)

    const result = await creditPackService.refundPurchase(venueId, purchaseId, staffVenueId, reason)
    res.json(result)
  } catch (error) {
    next(error)
  }
}

// Helper to get StaffVenue ID from userId + venueId
async function getStaffVenueId(venueId: string, userId: string): Promise<string> {
  const prisma = (await import('../../utils/prismaClient')).default
  const sv = await prisma.staffVenue.findUnique({
    where: { staffId_venueId: { staffId: userId, venueId } },
    select: { id: true },
  })
  if (!sv) throw new Error('Staff no encontrado en este venue')
  return sv.id
}
