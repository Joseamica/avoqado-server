import type { NextFunction, Request, Response } from 'express'
import prisma from '@/utils/prismaClient'
import { checkPermission } from './checkPermission.middleware'

/**
 * Cancellation is intentionally side-aware:
 * - destination/requester uses inventory-transfers:request
 * - source/approver uses inventory-transfers:approve
 */
export const checkInterVenueTransferCancelPermission = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const venueId = req.params.venueId
    const transfer = await prisma.interVenueTransfer.findFirst({
      where: {
        id: req.params.transferId,
        OR: [{ sourceVenueId: venueId }, { destinationVenueId: venueId }],
      },
      select: { sourceVenueId: true },
    })
    if (!transfer) {
      res.status(404).json({ success: false, message: 'Traslado no encontrado' })
      return
    }

    const permission = transfer.sourceVenueId === venueId ? 'inventory-transfers:approve' : 'inventory-transfers:request'
    await checkPermission(permission)(req, res, next)
  } catch (error) {
    next(error)
  }
}
;(checkInterVenueTransferCancelPermission as any).requiredPermission = 'inventory-transfers:approve|inventory-transfers:request'
