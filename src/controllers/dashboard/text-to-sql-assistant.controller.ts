import { NextFunction, Request, Response } from 'express'
import textToSqlAssistantService from '../../services/dashboard/text-to-sql-assistant.service'
import { AssistantQueryDto } from '../../schemas/dashboard/assistant.schema'
import { UnauthorizedError, ForbiddenError } from '../../errors/AppError'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { UserRole } from '../../services/dashboard/table-access-control.service'

const CREATE_PRODUCT_ACTION_COMMAND_PREFIX = '__AIOPS_CREATE_PRODUCT__:'

const normalizeForSecurityCheck = (message: string): string => {
  return message
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}

const isCrudBridgeMessage = (message: string): boolean => {
  if (message.startsWith(CREATE_PRODUCT_ACTION_COMMAND_PREFIX)) {
    return true
  }

  const normalized = normalizeForSecurityCheck(message)
  return /\b(crear|crea|agregar|agrega|anadir|registrar|dar de alta|create|add|nuevo|nueva|new)\b.{0,30}\b(producto|product|item)s?\b/.test(
    normalized,
  )
}

/**
 * Detecta si una consulta contiene información sensible que requiere rol SUPERADMIN
 */
const isSensitiveQuery = (message: string): boolean => {
  const normalized = normalizeForSecurityCheck(message)
  const sensitivePatterns = [
    // Account/permission model
    /\b(superadmin|owner|propietario|admin|administrador(?:es)?)\b/,
    /\b(rol|roles|role|permissions?|permisos?)\b/,
    /\b(usuarios?|users?|staff|empleados?)\b/,

    // System internals
    /\b(base de datos|database|schema|esquema|tablas?|tables?|columnas?|columns?)\b/,
    /\b(configuracion|configuration|acceso|access|seguridad|security)\b/,

    // Credentials/secrets
    /\b(password|contrasena|api[\s_-]*key|apikey|secret|secreto|credenciales?|credentials|access[\s_-]*token|jwt)\b/,

    // Audit/compliance exports
    /\b(auditoria|audit|logs?|historial completo|informacion confidencial|datos sensibles)\b/,
  ]

  return sensitivePatterns.some(pattern => pattern.test(normalized))
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
    const { message, conversationHistory, venueSlug, userId, includeVisualization, referencesContext }: AssistantQueryDto = req.body
    const sensitiveQuery = isSensitiveQuery(message)
    const crudBridgeMessage = isCrudBridgeMessage(message)

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
    if (sensitiveQuery && !crudBridgeMessage && !hasPermissionForSensitiveQuery(req.authContext.role)) {
      logger.warn('🚨 Intento de acceso a datos sensibles bloqueado', {
        userId: req.authContext.userId,
        venueId: req.authContext.venueId,
        role: req.authContext.role,
        crudBridgeMessage,
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
      isSensitive: sensitiveQuery,
      isCrudBridgeMessage: crudBridgeMessage,
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
      includeVisualization, // Pass flag for chart generation
      referencesContext, // Pass AI references context for contextual queries
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
      isSensitive: sensitiveQuery,
      isCrudBridgeMessage: crudBridgeMessage,
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

    if (metadata && 'action' in metadata) {
      sanitizedMetadata.action = (metadata as any).action
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
        visualization: assistantPayload.visualization, // Include chart data when requested
        tokenUsage: assistantPayload.tokenUsage, // Include token usage for display
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
