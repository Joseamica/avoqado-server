/**
 * Folios de merma para el dashboard web — spec §4.6: las declaraciones que no pudieron descontar
 * nada (todo «sin existencia») no tienen movimiento, así que SÓLO se ven aquí.
 *
 *   GET /api/v1/dashboard/venues/:venueId/inventory/waste-reports
 *     ?page&pageSize&search&startDate&endDate   → 200 { success: true, data: { items, total, page, pageSize } }
 *
 * Candados (los pone la RUTA, no este controlador): `checkFeatureAccess('INVENTORY_TRACKING')` de
 * todo el router de inventario y `checkPermission('inventory:read')`, que además resuelve el rol en
 * el venue de la URL (membresía vigente o dueño de la organización).
 *
 * 🔴 UN solo candado de permiso (Ruling 19): aquí NO se re-evalúa con `requireWastePermission`.
 * `checkPermission` respeta el PIN de gerente (`X-Permission-Override`, de un solo uso); una segunda
 * evaluación que no lo conoce contestaría 403 con el PIN ya gastado — el defecto que la tarea 8
 * cerró en `/mobile`.
 *
 * Controlador PROPIO del dashboard (no el de `/mobile`): así cada namespace puede cambiar su
 * contrato sin arrastrar al otro. La query se valida con el MISMO esquema que el catálogo del POS
 * (paginación con tope 200, búsqueda ≤ 200, fechas ISO 8601 CON zona horaria; 422
 * `INVALID_WASTE_PAYLOAD` en español).
 */
import { NextFunction, Request, Response } from 'express'
import { UnauthorizedError } from '../../../errors/AppError'
import { listWasteReports } from '../../../services/shared/inventoryWasteRead.service'
import { parseWasteSchema, WasteQuerySchema } from '../../../schemas/mobile/inventoryWaste.mobile.schema'

export async function listWasteReportsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.authContext?.userId) throw new UnauthorizedError()
    const query = parseWasteSchema(WasteQuerySchema, req.query)
    // Mismo envoltorio `{ success, data }` que el resto de las rutas de inventario del dashboard.
    res.json({ success: true, data: await listWasteReports(req.params.venueId, query) })
  } catch (error) {
    next(error)
  }
}
