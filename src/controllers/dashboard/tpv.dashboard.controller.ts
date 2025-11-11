import { NextFunction, Request, Response } from 'express'
import { GetTerminalsQuery, UpdateTpvBody, CreateTpvBody } from '../../schemas/dashboard/tpv.schema'
import * as tpvDashboardService from '../../services/dashboard/tpv.dashboard.service'
import { HeartbeatData, tpvHealthService } from '../../services/tpv/tpv-health.service'
import { generateActivationCode as generateActivationCodeService } from '../../services/dashboard/terminal-activation.service'
import { BadRequestError } from '../../errors/AppError'

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

/**
 * Controlador para crear una nueva terminal.
 */
export async function createTpv(req: Request<{ venueId: string }, {}, CreateTpvBody>, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    const body = req.body
    const created = await tpvDashboardService.createTpv(venueId, body)
    res.status(201).json(created)
  } catch (error) {
    next(error)
  }
}

/**
 * Controlador para procesar heartbeat de TPV
 */
export async function processHeartbeat(req: Request<{}, {}, HeartbeatData>, res: Response, next: NextFunction): Promise<void> {
  try {
    const heartbeatData = req.body
    const clientIp = req.ip || req.connection.remoteAddress

    await tpvHealthService.processHeartbeat(heartbeatData, clientIp)

    res.status(200).json({
      success: true,
      message: 'Heartbeat processed successfully',
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Controlador para enviar comando a TPV
 */
export async function sendTpvCommand(
  req: Request<{ terminalId: string }, {}, { command: string; payload?: any }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { terminalId } = req.params
    const { command, payload } = req.body
    const requestedBy = (req as any).authContext?.userId || 'system'

    // Validate command logic
    if (command === 'EXIT_MAINTENANCE') {
      // Check if terminal is actually in maintenance mode
      const terminalHealth = await tpvHealthService.getTerminalHealth(terminalId)
      if (terminalHealth.status !== 'MAINTENANCE') {
        throw new BadRequestError(`Terminal ${terminalId} is not in maintenance mode (current status: ${terminalHealth.status})`)
      }
    } else if (command === 'MAINTENANCE_MODE') {
      // Check if terminal is already in maintenance mode
      const terminalHealth = await tpvHealthService.getTerminalHealth(terminalId)
      if (terminalHealth.status === 'MAINTENANCE') {
        throw new BadRequestError(`Terminal ${terminalId} is already in maintenance mode`)
      }
    } else if (command === 'REACTIVATE') {
      // Check if terminal is actually inactive
      const terminalHealth = await tpvHealthService.getTerminalHealth(terminalId)
      if (terminalHealth.status !== 'INACTIVE') {
        throw new BadRequestError(`Terminal ${terminalId} is not inactive (current status: ${terminalHealth.status})`)
      }
    }

    await tpvHealthService.sendCommand(terminalId, {
      type: command as any,
      payload,
      requestedBy,
    })

    res.status(200).json({
      success: true,
      message: `Command ${command} sent to terminal ${terminalId}`,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Controlador para obtener salud de terminales del venue
 */
export async function getVenueTerminalHealth(req: Request<{ venueId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params

    const healthSummary = await tpvHealthService.getVenueTerminalHealth(venueId)

    res.status(200).json(healthSummary)
  } catch (error) {
    next(error)
  }
}

/**
 * Controlador para obtener información detallada de salud de un terminal
 */
export async function getTerminalHealth(
  req: Request<{ venueId: string; tpvId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { tpvId } = req.params

    const terminalHealth = await tpvHealthService.getTerminalHealth(tpvId)

    res.status(200).json(terminalHealth)
  } catch (error) {
    next(error)
  }
}

/**
 * Generate activation code for terminal
 * Similar to Square POS device activation flow
 */
export async function generateActivationCode(
  req: Request<{ venueId: string; terminalId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { terminalId } = req.params
    const authContext = (req as any).authContext
    const staffId = authContext?.userId || authContext?.staffId

    if (!staffId) {
      throw new BadRequestError('Staff ID required to generate activation code')
    }

    const activationData = await generateActivationCodeService(terminalId, staffId)

    res.status(200).json(activationData)
  } catch (error) {
    next(error)
  }
}

/**
 * Delete terminal (only if not activated)
 */
export async function deleteTpv(req: Request<{ venueId: string; tpvId: string }>, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, tpvId } = req.params

    await tpvDashboardService.deleteTpv(venueId, tpvId)

    res.status(200).json({
      success: true,
      message: 'Terminal eliminada exitosamente',
    })
  } catch (error) {
    next(error)
  }
}
