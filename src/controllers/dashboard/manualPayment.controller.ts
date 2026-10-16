import { NextFunction, Request, Response } from 'express'

import logger from '@/config/logger'
import { tienePermisoEnVenue } from '@/middlewares/permissionFlag.middleware'
import * as manualPaymentService from '@/services/dashboard/manualPayment.service'
import { CreateManualPaymentInput } from '@/schemas/dashboard/manualPayment.schema'

/**
 * 🔴 R6-2 (ronda 6 post-QA de sellos tardíos; Codex recheck-10 P2): en los tres handlers, UNA sola sucursal por operación — la de
 * la URL (`req.params.venueId`). Es la que evalúan `checkPermission('payment:create-manual')` y `tienePermisoEnVenue`, y la
 * convención de los controllers del panel. Con la del TOKEN, una sesión de A pedía `/venues/B/payments/manual`: el permiso se
 * comprobaba en B y se escribía en A.
 */
export async function createManualPayment(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId } = (req as any).authContext
    const { venueId } = req.params
    const body = req.body as CreateManualPaymentInput
    // 🔴 R5-1 (ronda 5 post-QA de sellos tardíos; decisión «A»): ligar un cliente a una venta YA cobrada exige `payments:create`
    // (el servicio decide bajo el candado de la venta). Sólo se resuelve si el pago trae cliente Y va a una venta existente.
    const opciones = body.customerId && body.orderId ? { puedeCambiarClienteEnVentaCobrada: await puedeCobrar(req) } : {}
    const payment = await manualPaymentService.createManualPayment(venueId, userId, body, opciones)
    res.status(201).json({ success: true, data: payment })
  } catch (err) {
    next(err)
  }
}

/**
 * ¿Quien registra tiene `payments:create`? Con el resolvedor EFECTIVO de siempre (`tienePermisoEnVenue`: el mismo de
 * `checkPermission`, con las personalizaciones del negocio y los conjuntos de permisos). Falla CERRADO: si no se puede resolver,
 * el servicio no cambia el cliente de una venta cobrada (403) y queda en el log.
 */
async function puedeCobrar(req: Request): Promise<boolean> {
  try {
    return await tienePermisoEnVenue(req, 'payments:create')
  } catch (error) {
    logger.warn('[MANUAL_PAYMENT] No se pudo resolver payments:create para ligar el cliente: se trata como sin permiso', {
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

export async function getExternalSources(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const limit = Number(req.query.limit ?? 10)
    const sources = await manualPaymentService.getExternalSources(venueId, limit)
    res.json({ success: true, data: sources })
  } catch (err) {
    next(err)
  }
}

export async function getEligibleWaiters(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const waiters = await manualPaymentService.getEligibleWaiters(venueId)
    res.json({ success: true, data: waiters })
  } catch (err) {
    next(err)
  }
}
