import { NextFunction, Request, Response } from 'express'
import textToSqlAssistantService from '../../services/dashboard/text-to-sql-assistant.service'
import { AssistantQueryDto } from '../../schemas/dashboard/assistant.schema'
import { UnauthorizedError } from '../../errors/AppError'
import logger from '../../config/logger'

/**
 * Procesa una consulta usando el sistema Text-to-SQL
 */
export const processTextToSqlQuery = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { message, conversationHistory }: AssistantQueryDto = req.body

    // Verificar que el usuario esté autenticado
    if (!req.authContext?.userId || !req.authContext?.venueId) {
      throw new UnauthorizedError('Usuario no autenticado')
    }

    // Log de auditoría de seguridad
    logger.info('🔍 Text-to-SQL query initiated', {
      venueId: req.authContext.venueId,
      userId: req.authContext.userId,
      messageLength: message.length,
      timestamp: new Date().toISOString(),
    })

    // Procesar la consulta con el servicio Text-to-SQL
    const response = await textToSqlAssistantService.processQuery({
      message,
      conversationHistory,
      venueId: req.authContext.venueId,
      userId: req.authContext.userId,
    })

    // Log del resultado
    logger.info('🔍 Text-to-SQL query completed', {
      venueId: req.authContext.venueId,
      userId: req.authContext.userId,
      confidence: response.confidence,
      queryGenerated: response.metadata.queryGenerated,
      queryExecuted: response.metadata.queryExecuted,
      rowsReturned: response.metadata.rowsReturned,
      executionTime: response.metadata.executionTime,
    })

    // Respuesta exitosa con metadatos de consulta SQL
    res.json({
      success: true,
      data: {
        response: response.response,
        suggestions: response.suggestions || [],
        metadata: {
          confidence: response.confidence,
          queryGenerated: response.metadata.queryGenerated,
          queryExecuted: response.metadata.queryExecuted,
          rowsReturned: response.metadata.rowsReturned,
          executionTime: response.metadata.executionTime,
          dataSourcesUsed: response.metadata.dataSourcesUsed,
          // Include SQL query in development for debugging
          ...(process.env.NODE_ENV === 'development' && { 
            sqlQuery: response.sqlQuery,
            queryResult: response.queryResult 
          })
        }
      }
    })

  } catch (error) {
    // Log del error para análisis
    logger.error('🔍 Text-to-SQL query failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
      venueId: req.authContext?.venueId,
      userId: req.authContext?.userId,
    })

    next(error)
  }
}