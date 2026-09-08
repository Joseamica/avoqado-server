/**
 * Dashboard Stock Count Controller
 *
 * Exposes stock counts to the web dashboard for auditing purposes.
 * Stock counts are created by the mobile POS apps (iOS/Android) — from the
 * dashboard an accountant or manager reviews the history (read) and can let a
 * forgotten draft go (cancel). Nothing here adjusts inventory.
 *
 * La lectura vive en `services/dashboard/stockCountAudit.service` (acotada:
 * pagina en la base y resume sólo la página); cancelar reusa el servicio móvil,
 * que es donde vive el reclamo atómico.
 */

import { Request, Response, NextFunction } from 'express'
import { listStockCountsForAudit, getStockCountForAudit } from '../../../services/dashboard/stockCountAudit.service'
import { cancelStockCount as cancelStockCountService } from '../../../services/mobile/inventory.mobile.service'

/** Un ISO date-time válido, o undefined. Nunca una fecha civil pelada (trampa de zona horaria). */
function fechaOpcional(v: unknown): Date | undefined {
  if (typeof v !== 'string' || !v) return undefined
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? undefined : d
}

/**
 * GET /api/v1/dashboard/venues/:venueId/inventory/stock-counts
 *
 * Query params:
 *   - status: 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED'
 *   - type: 'CYCLE' | 'FULL'
 *   - startDate, endDate: ISO date-time strings (filters by createdAt)
 *   - page, pageSize: pagination (defaults 1 / 50; el tope lo impone el servidor)
 */
export async function listStockCounts(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { status, type, startDate, endDate, page, pageSize } = req.query
    const { rows, pagination } = await listStockCountsForAudit(venueId, {
      status: status === 'IN_PROGRESS' || status === 'COMPLETED' || status === 'CANCELLED' ? status : undefined,
      type: type === 'CYCLE' || type === 'FULL' ? type : undefined,
      startDate: fechaOpcional(startDate),
      endDate: fechaOpcional(endDate),
      // Un parámetro AUSENTE llega al servicio como `undefined` a propósito: el default
      // (y el tope) viven en UN solo sitio, `STOCK_COUNT_PAGE_DEFAULT`. Repetir el `50`
      // aquí lo dejaba en dos, y dos copias de una regla divergen en cuanto alguien
      // toca una. Lo ilegible sigue viajando como NaN — el servicio ya lo acota.
      page: page === undefined ? undefined : parseInt(String(page), 10),
      pageSize: pageSize === undefined ? undefined : parseInt(String(pageSize), 10),
    })
    res.json({ success: true, data: rows, pagination })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/v1/dashboard/venues/:venueId/inventory/stock-counts/:countId
 *
 * Get a single stock count with its full item list.
 */
export async function getStockCount(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, countId } = req.params
    const count = await getStockCountForAudit(venueId, countId)
    if (!count) {
      return res.status(404).json({ success: false, message: 'Conteo no encontrado' })
    }
    res.json({ success: true, data: count })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /api/v1/dashboard/venues/:venueId/inventory/stock-counts/:countId/cancel
 *
 * Dejar ir un borrador que nadie va a terminar. Un conteo cancelado nunca
 * ajustó el inventario; se conserva para consulta.
 */
export async function cancelStockCount(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, countId } = req.params
    const { userId } = (req as any).authContext
    const count = await cancelStockCountService(countId, venueId, userId)
    res.json({ success: true, data: count })
  } catch (error) {
    next(error)
  }
}
