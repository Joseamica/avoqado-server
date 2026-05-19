import { NextFunction, Request, Response } from 'express'
import * as orderDashboardService from '../../services/dashboard/order.dashboard.service'
import {
  encodeExport,
  sendExport,
  parseColumnsParam,
  parseFormatParam,
  getRowCapForFormat,
  type ExportColumnDef,
} from '../../services/dashboard/export.helpers'
import logger from '../../config/logger'

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

export async function getOrder(req: Request<{ venueId: string; orderId: string }>, res: Response, next: NextFunction) {
  try {
    const { venueId, orderId } = req.params
    const order = await orderDashboardService.getOrderById(venueId, orderId)
    res.status(200).json(order)
  } catch (error) {
    next(error)
  }
}

export async function updateOrder(req: Request<{ venueId: string; orderId: string }>, res: Response, next: NextFunction) {
  try {
    const { venueId, orderId } = req.params
    const updatedOrder = await orderDashboardService.updateOrder(venueId, orderId, req.body)
    res.status(200).json(updatedOrder)
  } catch (error) {
    next(error)
  }
}

export async function deleteOrder(req: Request<{ venueId: string; orderId: string }>, res: Response, next: NextFunction) {
  try {
    const { venueId, orderId } = req.params
    await orderDashboardService.deleteOrder(venueId, orderId)
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

// Ruta: GET /venues/:venueId/orders/export
//
// Streams a CSV / XLSX / PDF of orders matching the listing filters. Sync export — caps at 10k rows
// (1k for PDF). Async job queue replaces this when we ship one for large tenants.
export async function exportOrdersData(
  req: Request<
    { venueId: string },
    {},
    {},
    {
      format?: string
      columns?: string
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
    const format = parseFormatParam(req.query.format)
    const requestedColumnIds = parseColumnsParam(req.query.columns)
    const cap = getRowCapForFormat(format)

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

    const total = await orderDashboardService.countOrdersForExport(venueId, filters)
    if (total > cap) {
      res.status(413).json({
        success: false,
        message:
          format === 'pdf'
            ? `El rango contiene ${total.toLocaleString()} órdenes. PDF está limitado a ${cap.toLocaleString()}. Usa CSV o Excel, o reduce el rango con filtros.`
            : `El rango contiene ${total.toLocaleString()} órdenes. El máximo por export es ${cap.toLocaleString()}. Reduce el rango con filtros.`,
      })
      return
    }

    const rows = await orderDashboardService.fetchOrdersForExport(venueId, filters, cap)
    type Row = (typeof rows)[number]

    const allColumns: ExportColumnDef<Row>[] = [
      { id: 'createdAt', label: 'Fecha', value: r => r.createdAt?.toISOString() ?? '' },
      { id: 'orderId', label: 'ID', value: r => r.id },
      { id: 'orderNumber', label: 'Folio', value: r => r.orderNumber ?? '' },
      { id: 'type', label: 'Tipo', value: r => r.type ?? '' },
      {
        id: 'customerName',
        label: 'Cliente',
        value: r => (r as any).customerName ?? '',
      },
      { id: 'tableName', label: 'Mesa', value: r => r.table?.number ?? '' },
      {
        id: 'waiterName',
        label: 'Mesero',
        value: r => {
          const w = r.servedBy || r.createdBy
          return w ? `${w.firstName ?? ''} ${w.lastName ?? ''}`.trim() : ''
        },
      },
      { id: 'status', label: 'Estatus', value: r => r.status ?? '' },
      { id: 'productsCount', label: 'Productos', value: r => r._count?.items ?? 0 },
      { id: 'tipAmount', label: 'Propina', value: r => Number(r.tipAmount) || 0 },
      { id: 'total', label: 'Total', value: r => Number(r.total) || 0 },
    ]

    const encoded = await encodeExport(format, {
      allColumns,
      requestedColumnIds: requestedColumnIds.length > 0 ? requestedColumnIds : allColumns.map(c => c.id),
      rows,
      title: 'Órdenes',
    })

    logger.info('[Orders export]', { venueId, total, format, columns: requestedColumnIds.length })
    sendExport(res, encoded, 'orders')
  } catch (error) {
    logger.error('Error exporting orders', { error: error instanceof Error ? error.message : 'Unknown' })
    next(error)
  }
}
