import { NextFunction, Request, Response } from 'express'
import {
  queryVenueActivityLogs,
  getVenueDistinctActions,
  getVenueDistinctEntities,
  countVenueActivityLogsForExport,
  fetchVenueActivityLogsForExport,
} from '../../services/dashboard/activity-log.service'
import { redactSensitive, summarizeLogData } from '../../services/dashboard/activityLog.format'
import {
  encodeExport,
  sendExport,
  parseFormatParam,
  parseColumnsParam,
  getRowCapForFormat,
  type ExportColumnDef,
} from '../../services/dashboard/export.helpers'

export async function getActivityLog(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = (req as any).authContext
    const result = await queryVenueActivityLogs({
      venueId,
      page: req.query.page ? Number(req.query.page) : undefined,
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
      staffId: req.query.staffId as string | undefined,
      action: req.query.action as string | undefined,
      entity: req.query.entity as string | undefined,
      search: req.query.search as string | undefined,
      startDate: req.query.startDate as string | undefined,
      endDate: req.query.endDate as string | undefined,
    })
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export async function getActivityLogActions(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = (req as any).authContext
    res.json({ success: true, data: await getVenueDistinctActions(venueId) })
  } catch (err) {
    next(err)
  }
}

export async function getActivityLogEntities(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = (req as any).authContext
    res.json({ success: true, data: await getVenueDistinctEntities(venueId) })
  } catch (err) {
    next(err)
  }
}

/**
 * Audit log export.
 *
 * The matrix answers "exportable" for the audit trail; it wasn't. Three things this does
 * that the listing does not have to worry about:
 *
 * 1. **Redacts server-side.** The dashboard redacts sensitive keys at render time, and only
 *    on one of its two audit screens — a downloaded file passes through neither.
 * 2. **Summarizes the jsonb.** Dumping raw JSON into a cell makes the file unreadable, and
 *    an audit trail nobody reads is not an audit trail. The untouched JSON still ships in
 *    its own column.
 * 3. **Refuses instead of truncating.** An export that silently returns the first N rows is
 *    worse than one that says no: the file looks complete.
 */
export async function exportActivityLog(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = (req as any).authContext
    const format = parseFormatParam(req.query.format)
    const requestedColumnIds = parseColumnsParam(req.query.columns)
    const cap = getRowCapForFormat(format)

    // Same filters the screen is showing — exporting "everything" while the user looks at a
    // filtered view is the kind of mistake that is found late and badly.
    const filters = {
      venueId,
      staffId: req.query.staffId as string | undefined,
      action: req.query.action as string | undefined,
      entity: req.query.entity as string | undefined,
      search: req.query.search as string | undefined,
      startDate: req.query.startDate as string | undefined,
      endDate: req.query.endDate as string | undefined,
    }

    const total = await countVenueActivityLogsForExport(filters)
    if (total > cap) {
      res.status(413).json({
        success: false,
        message:
          format === 'pdf'
            ? `El rango contiene ${total.toLocaleString()} movimientos. El PDF está limitado a ${cap.toLocaleString()}. Usa CSV o Excel, o acota el rango con filtros.`
            : `El rango contiene ${total.toLocaleString()} movimientos. El máximo por exportación es ${cap.toLocaleString()}. Acota el rango con filtros.`,
      })
      return
    }

    const rows = await fetchVenueActivityLogsForExport({ ...filters, cap })
    type Row = (typeof rows)[number]

    const allColumns: ExportColumnDef<Row>[] = [
      { id: 'createdAt', label: 'Fecha y hora', value: r => r.createdAt?.toISOString() ?? '' },
      { id: 'action', label: 'Acción', value: r => r.action },
      {
        id: 'staffName',
        label: 'Usuario',
        value: r => (r.staff ? `${r.staff.firstName ?? ''} ${r.staff.lastName ?? ''}`.trim() : 'Sistema'),
      },
      { id: 'entity', label: 'Entidad', value: r => r.entity ?? '' },
      { id: 'entityId', label: 'ID de entidad', value: r => r.entityId ?? '' },
      { id: 'summary', label: 'Detalle', value: r => summarizeLogData(r.data) },
      { id: 'ipAddress', label: 'Dirección IP', value: r => r.ipAddress ?? '' },
      // Full payload last and off by default: it is what an investigation needs and what
      // makes the file unreadable for everyone else.
      { id: 'dataJson', label: 'Datos (JSON)', value: r => (r.data ? JSON.stringify(redactSensitive(r.data)) : '') },
    ]

    const defaultColumnIds = allColumns.filter(c => c.id !== 'dataJson').map(c => c.id)
    const encoded = await encodeExport(format, {
      allColumns,
      requestedColumnIds: requestedColumnIds.length > 0 ? requestedColumnIds : defaultColumnIds,
      rows,
      title: 'Bitácora',
    })

    sendExport(res, encoded, 'bitacora')
  } catch (err) {
    next(err)
  }
}
