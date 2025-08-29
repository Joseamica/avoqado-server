import { Request, Response, NextFunction } from 'express'
import * as tpvDashboardService from '../../services/dashboard/tpv.dashboard.service'
import { GetTerminalsQuery, UpdateTpvBody } from '../../schemas/dashboard/tpv.schema'

/**
 * Controlador para manejar la solicitud GET de terminales.
 */
export async function getTerminals(
  req: Request<{ venueId: string }, {}, {}, GetTerminalsQuery>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // 1. Extraer el ID del venue de los parámetros de la ruta
    const { venueId } = req.params

    // 2. Parsear los query params de paginación y filtros, con valores por defecto
    const page = parseInt(req.query.page || '1', 10)
    const pageSize = parseInt(req.query.pageSize || '10', 10)
    const { status, type } = req.query

    // 3. Llamar al servicio con los datos ya procesados
    const terminalsData = await tpvDashboardService.getTerminalsData(venueId, page, pageSize, {
      status,
      type,
    })

    // 4. Enviar la respuesta exitosa al cliente
    res.status(200).json(terminalsData)
  } catch (error) {
    // 5. Si algo falla, pasar el error al manejador de errores de Express
    next(error)
  }
}

/**
 * Controlador para obtener una terminal específica por ID.
 */
export async function getTpvById(req: Request<{ venueId: string; tpvId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, tpvId } = req.params

    const tpv = await tpvDashboardService.getTpvById(venueId, tpvId)

    res.status(200).json(tpv)
  } catch (error) {
    next(error)
  }
}

/**
 * Controlador para actualizar una terminal.
 */
export async function updateTpv(
  req: Request<{ venueId: string; tpvId: string }, {}, UpdateTpvBody>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { venueId, tpvId } = req.params
    const updateData = req.body

    const updatedTpv = await tpvDashboardService.updateTpv(venueId, tpvId, updateData)

    res.status(200).json(updatedTpv)
  } catch (error) {
    next(error)
  }
}
