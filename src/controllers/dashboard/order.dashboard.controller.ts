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
import * as orderSummaryService from '../../services/dashboard/orderSummary.dashboard.service'
import {
  LIST_PAGE_SIZE_MAX,
  amountFilterFromQuery,
  clampLegacyPageSize,
  clampPage,
  clampPageSize,
  parseCsv,
} from '../../services/dashboard/listSummary.shared'

/** Un valor de query como cadena no vacía, o undefined. */
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
/** CSV o parámetro repetido (arreglo): los dos caminos llegan a parseCsv. */
const list = (v: unknown): string[] | undefined => (Array.isArray(v) ? parseCsv(v.map(String)) : parseCsv(str(v)))

/** Los filtros del listado, tal como llegan en la query (CSV) → `OrderFilters`. */
function orderFiltersFromQuery(q: Record<string, unknown>): orderDashboardService.OrderFilters {
  return {
    statuses: list(q.statuses),
    types: list(q.types),
    tableIds: list(q.tableIds),
    staffIds: list(q.staffIds),
    search: str(q.search),
    startDate: str(q.startDate),
    endDate: str(q.endDate),
  }
}

export async function getOrdersData(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    const q = req.query as Record<string, unknown>
    const page = clampPage(q.page)
    const boundedResponse = q.responseMode === 'paginated-v1'
    const pageSize = boundedResponse ? clampPageSize(q.pageSize) : clampLegacyPageSize(q.pageSize)

    const ordersData = await orderDashboardService.getOrders(venueId, page, pageSize, orderFiltersFromQuery(q))

    res.status(200).json({
      ...ordersData,
      meta: { ...ordersData.meta, ...(boundedResponse ? { maxPageSize: LIST_PAGE_SIZE_MAX, responseMode: 'paginated-v1' } : {}) },
    })
  } catch (error) {
    next(error)
  }
}

// Ruta: GET /venues/:venueId/orders/summary — conteos por estado y sumas, en Postgres
export async function getOrdersSummary(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    const q = req.query as Record<string, unknown>
    const summary = await orderSummaryService.getOrdersSummary(venueId, orderFiltersFromQuery(q), {
      total: amountFilterFromQuery(q, 'total'),
      tip: amountFilterFromQuery(q, 'tip'),
    })
    res.status(200).json({ success: true, data: summary })
  } catch (error) {
    next(error)
  }
}

// Ruta: GET /venues/:venueId/orders/filter-options — valores distintos para las píldoras
export async function getOrdersFilterOptions(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const options = await orderSummaryService.getOrderFilterOptions(req.params.venueId)
    res.status(200).json({ success: true, data: options })
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
