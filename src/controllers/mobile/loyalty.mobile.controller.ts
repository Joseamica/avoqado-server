import { Request, Response, NextFunction } from 'express'
import * as loyaltyMobileService from '../../services/mobile/loyalty.mobile.service'
import { BadRequestError, UnauthorizedError } from '@/errors/AppError'
import { parseHttpOperation, manifestSchema, executeHttpOperation } from '@/services/mobile/http-operation.mobile.service'
import { sendHttpOperationReply } from './http-operation.mobile.controller'
import { logAction } from '@/services/dashboard/activity-log.service'

/**
 * GET /mobile/venues/:venueId/customers/:customerId/loyalty
 * Balance + program rules for the customer attached to a check. Pass
 * ?orderId= to also get how much may be redeemed against that order.
 */
export const getCustomerLoyalty = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, customerId } = req.params
    const orderId = typeof req.query.orderId === 'string' ? req.query.orderId : undefined
    const data = await loyaltyMobileService.getCustomerLoyalty(venueId, customerId, orderId)
    return res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /mobile/venues/:venueId/orders/:orderId/loyalty/redeem
 * Burns points and applies the matching discount to the OPEN check, atomically.
 */
export const redeemPoints = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId } = req.params
    const { customerId, points } = req.body || {}
    const staffId = (req as any).authContext?.userId as string | undefined

    if (!customerId || typeof customerId !== 'string') {
      return res.status(400).json({ success: false, message: 'customerId is required' })
    }
    if (typeof points !== 'number') {
      return res.status(400).json({ success: false, message: 'points is required' })
    }

    const operation = parseHttpOperation(req.body)
    if (!operation) {
      const data = await loyaltyMobileService.redeemPointsToOrder(venueId, orderId, customerId, points, staffId)
      return res.json({ success: true, data })
    }
    if (!staffId) throw new UnauthorizedError('Autenticación requerida')
    const parsed = manifestSchema.safeParse({ action: 'redeemLoyaltyPoints', refs: { orderId, customerId }, payload: { points } })
    if (!parsed.success || parsed.data.action !== 'redeemLoyaltyPoints')
      throw new BadRequestError('Datos de operación inválidos', 'HTTP_OPERATION_INVALID')
    const manifest = parsed.data
    let auditData: Parameters<typeof logAction>[0]['data']
    const reply = await executeHttpOperation({ venueId, actorId: staffId, operation, manifest }, async tx => {
      const r = await loyaltyMobileService.redeemPointsToOrderInTransaction(
        tx,
        venueId,
        orderId,
        manifest.refs.customerId,
        manifest.payload.points,
        staffId,
      )
      auditData = { customerId: manifest.refs.customerId, points: r.pointsToBurn, discountAmount: r.discountAmount }
      return {
        response: {
          status: 200,
          body: {
            success: true,
            data: { pointsRedeemed: r.pointsToBurn, discountAmount: r.discountAmount, newBalance: r.newBalance, order: r.totals },
          },
        },
        affectedRefs: [
          { kind: 'Order', id: orderId },
          { kind: 'Customer', id: manifest.refs.customerId },
          { kind: 'OrderDiscount', id: r.row.id },
          { kind: 'LoyaltyTransaction', id: r.transaction.id },
        ],
      }
    })
    if (reply.kind === 'TERMINAL' && reply.envelope.outcome === 'APPLIED' && reply.appliedNow) {
      void logAction({ action: 'LOYALTY_POINTS_REDEEMED', entity: 'Order', entityId: orderId, staffId, venueId, data: auditData })
    }
    return sendHttpOperationReply(res, operation, reply)
  } catch (error) {
    next(error)
  }
}
