import { NextFunction, Request, Response } from 'express'

import * as orderTpvService from '../../services/tpv/order.tpv.service'

export async function getOrders(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const orgId = req.authContext?.orgId // 1. Extract from req (Controller)
    const venueId: string = req.params.venueId // 3. Extract from req (Controller, already validated)

    // 4. Call service with clean data (Controller delegates)
    const orders = await orderTpvService.getOrders(venueId, orgId)

    res.status(200).json(orders) // 5. Send HTTP response (Controller)
  } catch (error) {
    next(error) // 6. HTTP error handling (Controller)
  }
}

export async function getOrder(req: Request<{ venueId: string; orderId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const orgId = req.authContext?.orgId // 1. Extract from req (Controller)
    const venueId: string = req.params.venueId // 3. Extract from req (Controller, already validated)
    const orderId: string = req.params.orderId // 4. Extract from req (Controller, already validated)

    // 5. Call service with clean data (Controller delegates)
    const order = await orderTpvService.getOrder(venueId, orderId, orgId)

    res.status(200).json(order) // 6. Send HTTP response (Controller)
  } catch (error) {
    next(error) // 7. HTTP error handling (Controller)
  }
}
