import { NextFunction, Request, Response } from 'express'
import textToSqlAssistantService from '../../services/dashboard/text-to-sql-assistant.service'
import { AssistantQueryDto } from '../../schemas/dashboard/assistant.schema'
import { UnauthorizedError, ForbiddenError } from '../../errors/AppError'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { UserRole } from '../../services/dashboard/table-access-control.service'

/**
 * Detecta si una consulta contiene información sensible que requiere rol SUPERADMIN
 */
const isSensitiveQuery = (message: string): boolean => {
  const sensitiveIndicators = [
    // User/Role management queries
    'roles',
    'role',
    'usuario',
    'usuarios',
    'user',
    'users',
    'staff',
    'empleado',
    'empleados',
    'admin',
    'administrador',
    'superadmin',
    'owner',
    'propietario',
    'manager',
    'gerente',

    // System/Organization queries
    'organización',
    'organizacion',
    'organization',
    'sistema',
    'system',
    'configuración',
    'configuration',
    'permisos',
    'permissions',
    'acceso',
    'access',
    'seguridad',
    'security',

    // Database/Technical queries
    'tabla',
    'tablas',
    'table',
    'tables',
    'esquema',
    'schema',
    'base de datos',
    'database',
    'estructura',
    'structure',
    'columna',
    'columnas',
    'column',
    'columns',

    // Sensitive business data
    'contraseña',
    'password',
    'token',
    'api',
    'clave',
    'key',
    'secret',
    'secreto',
    'credenciales',
    'credentials',
    'login',
    'sesión',
    'session',

    // Financial/Audit queries
    'audit',
    'auditoria',
    'log',
    'logs',
    'historial completo',
    'todos los registros',
    'información confidencial',
    'datos sensibles',
    'privado',
    'private',

    // System queries that could reveal architecture
    'cuántos',
    'cuantos',
    'todos los',
    'all',
    'lista completa',
    'complete list',
  ]

  const lowerMessage = message.toLowerCase().trim()
  return sensitiveIndicators.some(indicator => lowerMessage.includes(indicator))
}

/**
 * Verifica si el usuario tiene permisos para ejecutar consultas sensibles
 */
const hasPermissionForSensitiveQuery = (userRole: string): boolean => {
  return userRole === 'SUPERADMIN'
}

/**
 * Procesa una consulta usando el sistema Text-to-SQL
 */
export const processTextToSqlQuery = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { message, conversationHistory, venueSlug, userId }: AssistantQueryDto = req.body

    // Verificar que el usuario esté autenticado
    if (!req.authContext?.userId || !req.authContext?.venueId || !req.authContext?.role) {
      throw new UnauthorizedError('Usuario no autenticado')
    }

    // Validar coherencia del userId enviado por el cliente
    if (userId && userId !== req.authContext.userId) {
      logger.warn('🚨 userId mismatch detected in Text-to-SQL request', {
        expectedUserId: req.authContext.userId,
        receivedUserId: userId,
      })
      throw new ForbiddenError('Los identificadores enviados no coinciden con tu sesión activa.')
    }

    // Validar coherencia del venueSlug si fue enviado por el cliente
    const currentVenueRecord = await prisma.venue.findUnique({
      where: { id: req.authContext.venueId },
      select: { slug: true },
    })

    if (!currentVenueRecord) {
      logger.error('Authenticated venue not found in database', {
        venueId: req.authContext.venueId,
        userId: req.authContext.userId,
      })
      throw new ForbiddenError('No se encontró información del venue activo')
    }

    if (venueSlug) {
      if (currentVenueRecord.slug !== venueSlug) {
        logger.warn('🚨 venueSlug mismatch detected in Text-to-SQL request', {
          expectedVenueId: req.authContext.venueId,
          expectedSlug: currentVenueRecord?.slug,
          receivedSlug: venueSlug,
        })
        throw new ForbiddenError('El venue seleccionado no coincide con tu sesión activa.')
      }
    }

    // Verificar permisos para consultas sensibles
    if (isSensitiveQuery(message) && !hasPermissionForSensitiveQuery(req.authContext.role)) {
      logger.warn('🚨 Intento de acceso a datos sensibles bloqueado', {
        userId: req.authContext.userId,
        venueId: req.authContext.venueId,
        role: req.authContext.role,
        query: message.substring(0, 100), // Solo los primeros 100 caracteres por seguridad
      })

      throw new ForbiddenError(
        'Acceso denegado: Esta consulta requiere permisos de SUPERADMIN para acceder a información sensible del sistema.',
      )
    }

    // Log de auditoría de seguridad
    logger.info('🔍 Text-to-SQL query initiated', {
      venueId: req.authContext.venueId,
      userId: req.authContext.userId,
      role: req.authContext.role,
      messageLength: message.length,
      isSensitive: isSensitiveQuery(message),
      timestamp: new Date().toISOString(),
    })

    // Procesar la consulta con el servicio Text-to-SQL
    const response = await textToSqlAssistantService.processQuery({
      message,
      conversationHistory,
      venueId: req.authContext.venueId,
      userId: req.authContext.userId,
      venueSlug: currentVenueRecord?.slug,
      userRole: req.authContext.role as UserRole, // Pass for security validation
      ipAddress: req.ip || req.socket.remoteAddress || 'unknown', // Pass for audit logging
    })

    // Log del resultado
    logger.info('🔍 Text-to-SQL query completed', {
      venueId: req.authContext.venueId,
      userId: req.authContext.userId,
      role: req.authContext.role,
      confidence: response.confidence,
      queryGenerated: response.metadata.queryGenerated,
      queryExecuted: response.metadata.queryExecuted,
      rowsReturned: response.metadata.rowsReturned,
      executionTime: response.metadata.executionTime,
      isSensitive: isSensitiveQuery(message),
    })

    // Respuesta exitosa con metadatos de consulta SQL
    const { sqlQuery, queryResult, metadata, ...assistantPayload } = response

    const sanitizedMetadata: Record<string, unknown> = {
      confidence: assistantPayload.confidence,
      queryGenerated: metadata?.queryGenerated,
      queryExecuted: metadata?.queryExecuted,
      rowsReturned: metadata?.rowsReturned,
      executionTime: metadata?.executionTime,
    }

    if (metadata && 'bulletproofValidation' in metadata) {
      sanitizedMetadata.bulletproofValidation = (metadata as any).bulletproofValidation
    }

    const includeDebugInfo = process.env.NODE_ENV !== 'production' && req.authContext.role === 'SUPERADMIN'

    if (includeDebugInfo) {
      if (metadata?.dataSourcesUsed) {
        sanitizedMetadata.dataSourcesUsed = metadata.dataSourcesUsed
      }

      const debugSample =
        Array.isArray(queryResult) || queryResult === null || typeof queryResult !== 'object' ? queryResult : { ...queryResult }

      sanitizedMetadata.debug = {
        sqlQuery,
        sample: Array.isArray(debugSample) ? debugSample.slice(0, 5) : debugSample,
      }
    }

    res.json({
      success: true,
      data: {
        response: assistantPayload.response,
        suggestions: assistantPayload.suggestions || [],
        trainingDataId: assistantPayload.trainingDataId, // Include for feedback functionality
        metadata: sanitizedMetadata,
      },
    })
  } catch (error) {
    // Log del error para análisis
    logger.error('🔍 Text-to-SQL query failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
      venueId: req.authContext?.venueId,
      userId: req.authContext?.userId,
      role: req.authContext?.role,
    })

    next(error)
  }
}
