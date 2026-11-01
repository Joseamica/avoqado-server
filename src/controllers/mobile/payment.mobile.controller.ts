import { Request, Response, NextFunction } from 'express'
import * as orderMobileService from '../../services/mobile/order.mobile.service'
import * as paymentTpvService from '../../services/tpv/payment.tpv.service'
import { describeSaleStampForPayment } from '../../services/shared/loyaltyOnLateCustomer'
import { customerAttributionActor, customerAttributionActorForRecordedPayment } from '../../middlewares/customerAttribution.middleware'

export async function getCashPaymentByKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  res.set('Cache-Control', 'no-store')
  try {
    const { venueId, idempotencyKey } = req.params
    const data = await orderMobileService.getCashPaymentByKey(venueId, idempotencyKey)
    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

/**
 * Record a fast payment (no order, just amount)
 * Used for custom amounts and quick payments from iOS app
 */
export async function recordFastPayment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const orgId = req.authContext?.orgId
    const userId = req.authContext?.userId
    const venueId: string = req.params.venueId

    const paymentData = req.body

    const result = await paymentTpvService.recordFastPayment(
      venueId,
      paymentData,
      userId,
      orgId,
      paymentData.customerId ? await customerAttributionActorForRecordedPayment(req) : {},
    )

    res.status(201).json({
      success: true,
      data: result,
      message: 'Fast payment recorded successfully',
    })
  } catch (error) {
    next(error)
  }
}

export async function attachCustomerToPayment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, paymentId } = req.params
    const { customerId } = req.body
    // El actor sale del TOKEN, nunca del body (regla authContext): es quien queda en el sello y en la bitácora.
    // `data` lleva los campos de la orden de siempre más `loyalty` (sello tardío; campo nuevo y opcional para las apps).
    const order = await orderMobileService.attachCustomerToPayment(venueId, paymentId, customerId, req.authContext?.userId, {
      actor: await customerAttributionActor(req),
    })

    res.status(200).json({
      success: true,
      data: order,
      message: 'Customer attached to payment successfully',
    })
  } catch (error) {
    next(error)
  }
}

export async function attachCustomerToLatestPayment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    const { customerId, amountCents, tipCents, staffId } = req.body

    const order = await orderMobileService.attachCustomerToLatestPayment(venueId, {
      customerId,
      amountCents,
      tipCents,
      // `staffId` del body = quién COBRÓ (filtra el pago, como siempre). El actor = quien liga, del token.
      staffId,
      actorStaffId: req.authContext?.userId,
      actor: await customerAttributionActor(req),
    })

    res.status(200).json({
      success: true,
      data: order,
      message: 'Customer attached to latest payment successfully',
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /mobile/venues/:venueId/payments/:paymentId/loyalty — el renglón del sello en «Cobro exitoso» cuando el cliente venía
 * desde el carrito. `data: null` si la venta no tiene cliente (o sigue abierta); `reason: 'PENDING'` si la lealtad aún corre
 * (también la venta que una liga tardía reabrió y espera su sello). Sólo lee; el pago se busca dentro del negocio de la URL.
 */
export async function getPaymentLoyalty(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, paymentId } = req.params
    const data = await describeSaleStampForPayment({ venueId, paymentId })
    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}
