import { NextFunction, Request, Response } from 'express'
import * as orderDashboardService from '../../services/dashboard/order.dashboard.service'

export async function getOrdersData(
  req: Request<{ venueId: string }, {}, {}, { page?: string; pageSize?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const page = parseInt(req.query.page || '1')
    const pageSize = parseInt(req.query.pageSize || '10')

    const ordersData = await orderDashboardService.getOrders(venueId, page, pageSize)

    res.status(200).json(ordersData)
  } catch (error) {
    next(error)
  }
}

export async function getOrder(req: Request<{ orderId: string }>, res: Response, next: NextFunction) {
  try {
    const order = await orderDashboardService.getOrderById(req.params.orderId)
    res.status(200).json(order)
  } catch (error) {
    next(error)
  }
}

export async function updateOrder(req: Request<{ orderId: string }>, res: Response, next: NextFunction) {
  try {
    const updatedOrder = await orderDashboardService.updateOrder(req.params.orderId, req.body)
    res.status(200).json(updatedOrder)
  } catch (error) {
    next(error)
  }
}

export async function deleteOrder(req: Request<{ orderId: string }>, res: Response, next: NextFunction) {
  try {
    await orderDashboardService.deleteOrder(req.params.orderId)
    res.status(204).send() // 204 No Content es una respuesta común para DELETE exitoso
  } catch (error) {
    next(error)
  }
}
