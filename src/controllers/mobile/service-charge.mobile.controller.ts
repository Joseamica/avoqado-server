import { Request, Response, NextFunction } from 'express'
import * as serviceChargeService from '../../services/mobile/service-charge.mobile.service'
import { BadRequestError, UnauthorizedError } from '@/errors/AppError'
import {
  parseHttpOperation,
  executeHttpOperation,
  manifestSchema,
  type HttpManifest,
} from '@/services/mobile/http-operation.mobile.service'
import { sendHttpOperationReply } from './http-operation.mobile.controller'
import { logAction } from '@/services/dashboard/activity-log.service'

/**
 * GET /mobile/venues/:venueId/service-charges
 * Catálogo de cobros por servicio activos del venue.
 */
export const listServiceCharges = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const data = await serviceChargeService.listServiceCharges(venueId)
    return res.json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /mobile/venues/:venueId/orders/:orderId/service-charges
 * Aplica un cobro del catálogo a la cuenta abierta (SUMA al total).
 */
export const applyServiceCharge = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId } = req.params
    const { serviceChargeId } = req.body || {}
    const staffId = (req as any).authContext?.userId as string | undefined
    const operation = parseHttpOperation(req.body)
    if (!operation) {
      if (!serviceChargeId || typeof serviceChargeId !== 'string') {
        return res.status(400).json({ success: false, message: 'serviceChargeId is required' })
      }
      const data = await serviceChargeService.applyServiceCharge(venueId, orderId, serviceChargeId, staffId)
      return res.json({ success: true, data })
    }
    if (!staffId) throw new UnauthorizedError('Autenticación requerida')
    const parsed = manifestSchema.safeParse({ action: 'applyServiceCharge', refs: { orderId, serviceChargeId }, payload: {} })
    if (!parsed.success || parsed.data.action !== 'applyServiceCharge')
      throw new BadRequestError('Datos de operación inválidos', 'HTTP_OPERATION_INVALID')
    const manifest = parsed.data
    let auditData: Parameters<typeof logAction>[0]['data']
    const reply = await executeHttpOperation({ venueId, actorId: staffId, operation, manifest }, async tx => {
      const r = await serviceChargeService.applyServiceChargeInTransaction(tx, venueId, orderId, manifest.refs.serviceChargeId, staffId)
      auditData = { serviceChargeId: manifest.refs.serviceChargeId, name: r.charge.name, amount: r.amount }
      return {
        response: { status: 200, body: { success: true, data: r.totals } },
        affectedRefs: [
          { kind: 'Order', id: orderId },
          { kind: 'OrderServiceCharge', id: r.row.id },
        ],
      }
    })
    if (reply.kind === 'TERMINAL' && reply.envelope.outcome === 'APPLIED' && reply.appliedNow) {
      void logAction({ action: 'ORDER_SERVICE_CHARGE_APPLIED', entity: 'Order', entityId: orderId, staffId, venueId, data: auditData })
    }
    return sendHttpOperationReply(res, operation, reply)
  } catch (error) {
    next(error)
  }
}

/**
 * DELETE /mobile/venues/:venueId/orders/:orderId/service-charges/:orderServiceChargeId
 * Quita un cobro aplicado de la cuenta.
 */
export const removeServiceCharge = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, orderId, orderServiceChargeId } = req.params
    const staffId = (req as any).authContext?.userId as string | undefined
    const operation = parseHttpOperation(req.body)
    if (!operation) {
      const data = await serviceChargeService.removeServiceCharge(venueId, orderId, orderServiceChargeId, staffId)
      return res.json({ success: true, data })
    }
    if (!staffId) throw new UnauthorizedError('Autenticación requerida')
    const manifest: HttpManifest = { action: 'removeServiceCharge', refs: { orderId, orderServiceChargeId }, payload: {} }
    let removedName: string | undefined
    const reply = await executeHttpOperation({ venueId, actorId: staffId, operation, manifest }, async tx => {
      const { row, totals } = await serviceChargeService.removeServiceChargeInTransaction(tx, venueId, orderId, orderServiceChargeId)
      removedName = row.name
      return {
        response: { status: 200, body: { success: true, data: totals } },
        affectedRefs: [
          { kind: 'Order', id: orderId },
          { kind: 'OrderServiceCharge', id: row.id },
        ],
      }
    })
    if (reply.kind === 'TERMINAL' && reply.envelope.outcome === 'APPLIED' && reply.appliedNow) {
      void logAction({
        action: 'ORDER_SERVICE_CHARGE_REMOVED',
        entity: 'Order',
        entityId: orderId,
        staffId,
        venueId,
        data: { orderServiceChargeId, name: removedName },
      })
    }
    return sendHttpOperationReply(res, operation, reply)
  } catch (error) {
    next(error)
  }
}
