import { NextFunction, Request, Response } from 'express'
import textToSqlAssistantService from '../../services/dashboard/text-to-sql-assistant.service'
import { AssistantActionConfirmDto, AssistantActionPreviewDto, AssistantQueryDto } from '../../schemas/dashboard/assistant.schema'
import { UnauthorizedError, ForbiddenError } from '../../errors/AppError'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { UserRole } from '../../services/dashboard/table-access-control.service'

const CREATE_PRODUCT_ACTION_COMMAND_PREFIX = '__AIOPS_CREATE_PRODUCT__:'
type SensitiveRiskLevel = 'none' | 'medium' | 'high' | 'critical'

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

const extractReferencedVenueSlug = (message: string): string | null => {
  const normalized = normalizeForSecurityCheck(message)

  // Match patterns like:
  // - "en el venue avoqado-full"
  // - "venue avoqado-full"
  // - "sucursal avoqado-full"
  const match = normalized.match(/\b(?:venue|sucursal|branch)\s+([a-z0-9][a-z0-9-]{1,62})\b/)
  return match?.[1] || null
}

const isCrossVenueRequest = (message: string, currentVenueSlug: string): boolean => {
  const normalized = normalizeForSecurityCheck(message)
  const normalizedCurrentVenueSlug = normalizeForSecurityCheck(currentVenueSlug)
  const referencedVenueSlug = extractReferencedVenueSlug(message)

  if (referencedVenueSlug && referencedVenueSlug !== normalizedCurrentVenueSlug) {
    return true
  }

  // Explicit intent to access another branch/venue
  return /\b(otra|otro)\s+(sucursal|venue|branch)\b/.test(normalized)
}

/**
 * Clasifica el riesgo de seguridad de una consulta.
 */
const classifySensitiveRisk = (message: string): SensitiveRiskLevel => {
  const normalized = normalizeForSecurityCheck(message)
  const criticalPatterns = [
    /\b(password|contrasena|api[\s_-]*key|apikey|secret|secreto|credentials?|access[\s_-]*token|jwt)\b/,
    /\b(stripe.*secret|refresh[\s_-]*token|webhook[\s_-]*secret)\b/,
  ]
  const highPatterns = [
    /\b(base de datos|database|schema|esquema|tablas?|tables?|columnas?|columns?)\b/,
    /\b(information_schema|pg_catalog|pg_tables)\b/,
    /\b(auditoria|audit|logs?|historial completo|informacion confidencial|datos sensibles)\b/,
  ]
  const mediumPatterns = [/\b(superadmin|owner|propietario|admin|administrador(?:es)?)\b/, /\b(rol|roles|role|permissions?|permisos?)\b/]

  if (criticalPatterns.some(pattern => pattern.test(normalized))) return 'critical'
  if (highPatterns.some(pattern => pattern.test(normalized))) return 'high'
  if (mediumPatterns.some(pattern => pattern.test(normalized))) return 'medium'
  return 'none'
}

/**
 * Política de acceso por riesgo:
 * - critical/high: SUPERADMIN
 * - medium/none: permitido (el servicio aplicará ACL de tablas/columnas por rol)
 */
const hasPermissionForSensitiveRisk = (userRole: string, riskLevel: SensitiveRiskLevel): boolean => {
  if (riskLevel === 'critical' || riskLevel === 'high') {
    return userRole === 'SUPERADMIN'
  }
  return true
}

const resolveAuthenticatedVenueContext = async (
  req: Request,
  options?: {
    expectedVenueSlug?: string
    expectedUserId?: string
  },
): Promise<{ venueId: string; userId: string; role: string; venueSlug: string }> => {
  if (!req.authContext?.userId || !req.authContext?.venueId || !req.authContext?.role) {
    throw new UnauthorizedError('Usuario no autenticado')
  }

  if (options?.expectedUserId && options.expectedUserId !== req.authContext.userId) {
    logger.warn('🚨 userId mismatch detected in Text-to-SQL request', {
      expectedUserId: req.authContext.userId,
      receivedUserId: options.expectedUserId,
    })
    throw new ForbiddenError('Los identificadores enviados no coinciden con tu sesión activa.')
  }

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

  if (options?.expectedVenueSlug && currentVenueRecord.slug !== options.expectedVenueSlug) {
    logger.warn('🚨 venueSlug mismatch detected in Text-to-SQL request', {
      expectedVenueId: req.authContext.venueId,
      expectedSlug: currentVenueRecord?.slug,
      receivedSlug: options.expectedVenueSlug,
    })
    throw new ForbiddenError('El venue seleccionado no coincide con tu sesión activa.')
  }

  return {
    venueId: req.authContext.venueId,
    userId: req.authContext.userId,
    role: req.authContext.role,
    venueSlug: currentVenueRecord.slug,
  }
}

const buildSanitizedMetadata = (metadata: Record<string, any> | undefined, confidence: number): Record<string, unknown> => {
  const sanitizedMetadata: Record<string, unknown> = {
    confidence,
    queryGenerated: metadata?.queryGenerated,
    queryExecuted: metadata?.queryExecuted,
    rowsReturned: metadata?.rowsReturned,
    executionTime: metadata?.executionTime,
    blocked: metadata?.blocked,
    violationType: metadata?.violationType,
    riskLevel: metadata?.riskLevel,
    reasonCode: metadata?.reasonCode,
    routedTo: metadata?.routedTo,
    intent: metadata?.intent,
  }

  if (metadata && 'warnings' in metadata) {
    sanitizedMetadata.warnings = metadata.warnings
  }

  if (metadata && 'bulletproofValidation' in metadata) {
    sanitizedMetadata.bulletproofValidation = metadata.bulletproofValidation
  }

  if (metadata && 'action' in metadata) {
    sanitizedMetadata.action = metadata.action
  }

  if (metadata && 'idempotency' in metadata) {
    sanitizedMetadata.idempotency = metadata.idempotency
  }

  return sanitizedMetadata
}

/**
 * Procesa una consulta usando el sistema Text-to-SQL
 */
export const processTextToSqlQuery = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { message, conversationHistory, venueSlug, userId, includeVisualization, referencesContext }: AssistantQueryDto = req.body
    const sensitiveRiskLevel = classifySensitiveRisk(message)
    const crudBridgeMessage = isCrudBridgeMessage(message)
    const authContext = await resolveAuthenticatedVenueContext(req, {
      expectedVenueSlug: venueSlug,
      expectedUserId: userId,
    })

    if (isCrossVenueRequest(message, authContext.venueSlug)) {
      logger.warn('🚨 Cross-venue query attempt blocked in assistant', {
        userId: authContext.userId,
        venueId: authContext.venueId,
        currentVenueSlug: authContext.venueSlug,
        queryPreview: message.substring(0, 120),
      })

      res.json({
        success: true,
        data: {
          response: 'No puedo acceder a información de otra sucursal. Solo puedo responder con datos del venue activo en tu sesión.',
          suggestions: [
            'Muéstrame el inventario de esta sucursal',
            '¿Cuántas recetas tengo en este venue?',
            'Dame las alertas de inventario de esta sucursal',
          ],
          metadata: {
            confidence: 1,
            queryGenerated: false,
            queryExecuted: false,
            blocked: true,
            riskLevel: 'critical',
            reasonCode: 'cross_venue_request_blocked',
            routedTo: 'Blocked',
          },
        },
      })
      return
    }

    // Verificar permisos para consultas sensibles
    if (sensitiveRiskLevel !== 'none' && !crudBridgeMessage && !hasPermissionForSensitiveRisk(authContext.role, sensitiveRiskLevel)) {
      logger.warn('🚨 Intento de acceso a datos sensibles bloqueado', {
        userId: authContext.userId,
        venueId: authContext.venueId,
        role: authContext.role,
        riskLevel: sensitiveRiskLevel,
        crudBridgeMessage,
        query: message.substring(0, 100), // Solo los primeros 100 caracteres por seguridad
      })

      if (sensitiveRiskLevel === 'high') {
        res.json({
          success: true,
          data: {
            response:
              'Esa solicitud parece orientada a estructura interna del sistema. Puedo ayudarte con métricas operativas del negocio; por ejemplo ventas, ticket promedio, reseñas, productos top o turnos activos.',
            suggestions: [
              'Dame un resumen de mi negocio esta semana',
              '¿Cuánto vendí hoy y cómo voy vs ayer?',
              '¿Qué productos se vendieron más este mes?',
            ],
            metadata: {
              confidence: 1,
              queryGenerated: false,
              queryExecuted: false,
              blocked: true,
              riskLevel: 'high',
              reasonCode: 'sensitive_high_requires_superadmin',
              routedTo: 'Blocked',
            },
          },
        })
        return
      }

      throw new ForbiddenError(
        'Acceso denegado: Esta consulta requiere permisos de SUPERADMIN para acceder a información sensible del sistema.',
      )
    }

    // Log de auditoría de seguridad
    logger.info('🔍 Text-to-SQL query initiated', {
      venueId: authContext.venueId,
      userId: authContext.userId,
      role: authContext.role,
      messageLength: message.length,
      sensitiveRiskLevel,
      isCrudBridgeMessage: crudBridgeMessage,
      timestamp: new Date().toISOString(),
    })

    // Procesar la consulta con el servicio Text-to-SQL
    const response = await textToSqlAssistantService.processQuery({
      message,
      conversationHistory,
      venueId: authContext.venueId,
      userId: authContext.userId,
      venueSlug: authContext.venueSlug,
      userRole: authContext.role as UserRole, // Pass for security validation
      ipAddress: req.ip || req.socket.remoteAddress || 'unknown', // Pass for audit logging
      includeVisualization, // Pass flag for chart generation
      referencesContext, // Pass AI references context for contextual queries
    })

    // Log del resultado
    logger.info('🔍 Text-to-SQL query completed', {
      venueId: authContext.venueId,
      userId: authContext.userId,
      role: authContext.role,
      confidence: response.confidence,
      queryGenerated: response.metadata.queryGenerated,
      queryExecuted: response.metadata.queryExecuted,
      rowsReturned: response.metadata.rowsReturned,
      executionTime: response.metadata.executionTime,
      sensitiveRiskLevel,
      isCrudBridgeMessage: crudBridgeMessage,
    })

    // Respuesta exitosa con metadatos de consulta SQL
    const { sqlQuery, queryResult, metadata, ...assistantPayload } = response

    const sanitizedMetadata = buildSanitizedMetadata(metadata as Record<string, any> | undefined, assistantPayload.confidence)

    const includeDebugInfo = process.env.NODE_ENV !== 'production' && authContext.role === 'SUPERADMIN'

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

export const previewAssistantAction = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { actionType, draft, conversationId }: AssistantActionPreviewDto = req.body
    const authContext = await resolveAuthenticatedVenueContext(req)

    const preview = await textToSqlAssistantService.previewAction({
      actionType,
      draft,
      conversationId,
      venueId: authContext.venueId,
      userId: authContext.userId,
      userRole: authContext.role as UserRole,
      ipAddress: req.ip || req.socket.remoteAddress || 'unknown',
    })

    res.json({
      success: true,
      data: preview,
    })
  } catch (error) {
    logger.error('🔍 Assistant action preview failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
      venueId: req.authContext?.venueId,
      userId: req.authContext?.userId,
      role: req.authContext?.role,
    })
    next(error)
  }
}

export const confirmAssistantAction = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { actionId, idempotencyKey, confirmed }: AssistantActionConfirmDto = req.body
    const authContext = await resolveAuthenticatedVenueContext(req)

    const result = await textToSqlAssistantService.confirmAction({
      actionId,
      idempotencyKey,
      confirmed,
      venueId: authContext.venueId,
      userId: authContext.userId,
      userRole: authContext.role as UserRole,
      ipAddress: req.ip || req.socket.remoteAddress || 'unknown',
    })

    res.json({
      success: true,
      data: result,
    })
  } catch (error) {
    logger.error('🔍 Assistant action confirmation failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
      venueId: req.authContext?.venueId,
      userId: req.authContext?.userId,
      role: req.authContext?.role,
    })
    next(error)
  }
}
