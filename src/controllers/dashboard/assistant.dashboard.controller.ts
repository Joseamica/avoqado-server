import { NextFunction, Request, Response } from 'express'
import assistantService from '../../services/dashboard/assistant.dashboard.service'
import { AssistantQueryDto } from '../../schemas/dashboard/assistant.schema'
import { UnauthorizedError } from '../../errors/AppError'
import logger from '../../config/logger'

/**
 * Interface para el usuario autenticado en la request
 */
interface AuthenticatedRequest extends Request {
  user?: {
    id: string
    venueId: string
    role: string
  }
}

/**
 * Procesa una consulta del asistente de IA
 *
 * @param {AuthenticatedRequest} req - El objeto de la solicitud de Express con usuario autenticado
 * @param {Response} res - El objeto de la respuesta de Express
 * @param {NextFunction} next - La función next de Express
 */
export const processAssistantQuery = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { message, conversationHistory }: AssistantQueryDto = req.body

    // Verificar que el usuario esté autenticado
    if (!req.authContext?.userId || !req.authContext?.venueId) {
      throw new UnauthorizedError('Usuario no autenticado')
    }

    // Procesar la consulta del asistente (el schema ya convierte los timestamps)
    const response = await assistantService.processQuery({
      message,
      conversationHistory,
      venueId: req.authContext.venueId,
      userId: req.authContext.userId,
    })

    logger.info('Assistant query processed successfully', {
      userId: req.authContext.userId,
      venueId: req.authContext.venueId,
      messageLength: message.length,
    })

    res.status(200).json({
      success: true,
      data: response,
    })
  } catch (error) {
    logger.error('Error in processAssistantQuery controller', {
      error,
      userId: req.authContext?.userId,
      venueId: req.authContext?.venueId,
    })

    next(error)
  }
}

/**
 * Obtiene sugerencias predefinidas para el asistente
 *
 * @param {AuthenticatedRequest} req - El objeto de la solicitud de Express con usuario autenticado
 * @param {Response} res - El objeto de la respuesta de Express
 * @param {NextFunction} next - La función next de Express
 */
export const getAssistantSuggestions = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    // Verificar que el usuario esté autenticado
    if (!req.authContext?.venueId) {
      throw new UnauthorizedError('Usuario no autenticado')
    }

    // Sugerencias predefinidas basadas en las funcionalidades de Avoqado
    const suggestions = [
      '¿Cuáles fueron las ventas de hoy?',
      '¿Qué mesero generó más propinas esta semana?',
      '¿Cuáles son los productos más vendidos del mes?',
      '¿Hay alguna alerta que deba revisar?',
      '¿Cómo van las calificaciones de clientes?',
      'Muéstrame el resumen del día de ayer',
      '¿Qué productos tienen stock bajo?',
      '¿Cómo puedo mejorar las ventas de productos lentos?',
    ]

    logger.info('Assistant suggestions retrieved', {
      userId: req.authContext.userId,
      venueId: req.authContext.venueId,
    })

    res.status(200).json({
      success: true,
      data: {
        suggestions,
      },
    })
  } catch (error) {
    logger.error('Error in getAssistantSuggestions controller', {
      error,
      userId: req.authContext?.userId,
      venueId: req.authContext?.venueId,
    })

    next(error)
  }
}
