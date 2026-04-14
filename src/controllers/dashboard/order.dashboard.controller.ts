import { NextFunction, Request, Response } from 'express'
import * as orderDashboardService from '../../services/dashboard/order.dashboard.service'

export async function getOrdersData(
  req: Request<
    { venueId: string },
    {},
    {},
    {
      page?: string
      pageSize?: string
      statuses?: string
      types?: string
      tableIds?: string
      staffIds?: string
      search?: string
      startDate?: string
      endDate?: string
    }
  >,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId } = req.params
    const page = parseInt(req.query.page || '1')
    const pageSize = parseInt(req.query.pageSize || '10')

    // Helper to parse comma-separated list from query string
    const parseList = (raw?: string): string[] | undefined => {
      if (!raw) return undefined
      const list = raw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
      return list.length > 0 ? list : undefined
    }

    const filters: orderDashboardService.OrderFilters = {
      statuses: parseList(req.query.statuses),
      types: parseList(req.query.types),
      tableIds: parseList(req.query.tableIds),
      staffIds: parseList(req.query.staffIds),
      search: req.query.search,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
    }

    const ordersData = await orderDashboardService.getOrders(venueId, page, pageSize, filters)

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

/**
 * POST /api/dashboard/:venueId/orders/:orderId/settle
 * Settle a single order's pending balance (mark pay-later order as paid)
 */
export async function settleOrder(
  req: Request<{ venueId: string; orderId: string }, {}, { notes?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, orderId } = req.params
    const { notes } = req.body

    const result = await orderDashboardService.settleOrder(venueId, orderId, notes)

    res.status(200).json(result)
  } catch (error) {
    next(error)
  }
}
