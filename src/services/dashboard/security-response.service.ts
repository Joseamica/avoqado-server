/**
 * Security Response Service
 *
 * Provides standardized security responses for blocked queries.
 * Implements the security template: "Por seguridad, no puedo proporcionar esa información..."
 *
 * @module SecurityResponseService
 */

import logger from '@/config/logger'

/**
 * Types of security violations
 */
export enum SecurityViolationType {
  CROSS_VENUE_ACCESS = 'CROSS_VENUE_ACCESS',
  SCHEMA_DISCOVERY = 'SCHEMA_DISCOVERY',
  SENSITIVE_TABLE_ACCESS = 'SENSITIVE_TABLE_ACCESS',
  SQL_INJECTION_ATTEMPT = 'SQL_INJECTION_ATTEMPT',
  PROMPT_INJECTION = 'PROMPT_INJECTION',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  MISSING_VENUE_FILTER = 'MISSING_VENUE_FILTER',
  UNAUTHORIZED_TABLE = 'UNAUTHORIZED_TABLE',
  PII_ACCESS_ATTEMPT = 'PII_ACCESS_ATTEMPT',
  DANGEROUS_OPERATION = 'DANGEROUS_OPERATION',
  CROSS_ORGANIZATION_ACCESS = 'CROSS_ORGANIZATION_ACCESS',
}

/**
 * Language codes supported
 */
export type Language = 'es' | 'en'

/**
 * Security response structure
 */
export interface SecurityResponse {
  blocked: true
  message: string
  alternativeSuggestions: string[]
  violationType: SecurityViolationType
  timestamp: Date
}

/**
 * Messages for each violation type in Spanish and English
 */
const VIOLATION_MESSAGES: Record<SecurityViolationType, Record<Language, string>> = {
  [SecurityViolationType.CROSS_VENUE_ACCESS]: {
    es: 'no puedo acceder a información de otro restaurante o sucursal',
    en: 'I cannot access information from another restaurant or branch',
  },
  [SecurityViolationType.SCHEMA_DISCOVERY]: {
    es: 'no puedo revelar la estructura interna de la base de datos',
    en: 'I cannot reveal the internal database structure',
  },
  [SecurityViolationType.SENSITIVE_TABLE_ACCESS]: {
    es: 'no puedo acceder a información sensible del personal o configuración interna',
    en: 'I cannot access sensitive staff information or internal configuration',
  },
  [SecurityViolationType.SQL_INJECTION_ATTEMPT]: {
    es: 'no puedo ejecutar esa consulta porque contiene patrones potencialmente peligrosos',
    en: 'I cannot execute that query because it contains potentially dangerous patterns',
  },
  [SecurityViolationType.PROMPT_INJECTION]: {
    es: 'no puedo procesar instrucciones que intenten modificar mi comportamiento',
    en: 'I cannot process instructions that attempt to modify my behavior',
  },
  [SecurityViolationType.RATE_LIMIT_EXCEEDED]: {
    es: 'has excedido el límite de consultas permitidas',
    en: 'you have exceeded the allowed query limit',
  },
  [SecurityViolationType.MISSING_VENUE_FILTER]: {
    es: 'no puedo ejecutar consultas sin filtro de sucursal',
    en: 'I cannot execute queries without a branch filter',
  },
  [SecurityViolationType.UNAUTHORIZED_TABLE]: {
    es: 'no tienes permisos para acceder a esa tabla',
    en: 'you do not have permission to access that table',
  },
  [SecurityViolationType.PII_ACCESS_ATTEMPT]: {
    es: 'no puedo devolver información personal sensible sin autorización específica',
    en: 'I cannot return sensitive personal information without specific authorization',
  },
  [SecurityViolationType.DANGEROUS_OPERATION]: {
    es: 'no puedo ejecutar operaciones de escritura o modificación de datos',
    en: 'I cannot execute write operations or data modifications',
  },
  [SecurityViolationType.CROSS_ORGANIZATION_ACCESS]: {
    es: 'no puedo acceder a información de otra organización',
    en: 'I cannot access information from another organization',
  },
}

/**
 * Alternative suggestions for each violation type
 */
const ALTERNATIVE_SUGGESTIONS: Record<SecurityViolationType, Record<Language, string[]>> = {
  [SecurityViolationType.CROSS_VENUE_ACCESS]: {
    es: [
      'Consultar datos solo de tu sucursal actual',
      'Cambiar de sucursal desde el menú principal si tienes acceso a múltiples sucursales',
      'Solicitar a un administrador los reportes consolidados',
    ],
    en: [
      'Query data only from your current branch',
      'Switch branches from the main menu if you have access to multiple branches',
      'Request consolidated reports from an administrator',
    ],
  },
  [SecurityViolationType.SCHEMA_DISCOVERY]: {
    es: [
      'Hacer preguntas sobre tus ventas, órdenes, productos o clientes',
      'Solicitar reportes de estadísticas de tu sucursal',
      'Consultar sobre el inventario disponible',
    ],
    en: [
      'Ask questions about your sales, orders, products, or customers',
      'Request statistical reports for your branch',
      'Query about available inventory',
    ],
  },
  [SecurityViolationType.SENSITIVE_TABLE_ACCESS]: {
    es: [
      'Consultar estadísticas agregadas del equipo (sin datos sensibles)',
      'Revisar tus propios permisos y roles',
      'Solicitar a un administrador información sobre el personal',
    ],
    en: [
      'Query aggregated team statistics (without sensitive data)',
      'Review your own permissions and roles',
      'Request staff information from an administrator',
    ],
  },
  [SecurityViolationType.SQL_INJECTION_ATTEMPT]: {
    es: [
      'Reformular tu pregunta de manera más simple',
      'Hacer consultas específicas sobre ventas, productos u órdenes',
      'Usar el dashboard para visualizar reportes predefinidos',
    ],
    en: [
      'Rephrase your question more simply',
      'Make specific queries about sales, products, or orders',
      'Use the dashboard to view predefined reports',
    ],
  },
  [SecurityViolationType.PROMPT_INJECTION]: {
    es: [
      'Hacer preguntas directas sobre tus datos de negocio',
      'Consultar sobre ventas, inventario, órdenes o clientes',
      'Solicitar reportes específicos de tu sucursal',
    ],
    en: [
      'Ask direct questions about your business data',
      'Query about sales, inventory, orders, or customers',
      'Request specific reports for your branch',
    ],
  },
  [SecurityViolationType.RATE_LIMIT_EXCEEDED]: {
    es: [
      'Esperar unos minutos antes de hacer más consultas',
      'Usar el dashboard para consultas rápidas',
      'Combinar múltiples preguntas en una sola consulta',
    ],
    en: [
      'Wait a few minutes before making more queries',
      'Use the dashboard for quick queries',
      'Combine multiple questions into a single query',
    ],
  },
  [SecurityViolationType.MISSING_VENUE_FILTER]: {
    es: [
      'Especificar que quieres datos de tu sucursal actual',
      'Usar frases como "en mi sucursal" o "aquí"',
      'El sistema automáticamente filtrará tus datos',
    ],
    en: [
      'Specify that you want data from your current branch',
      'Use phrases like "in my branch" or "here"',
      'The system will automatically filter your data',
    ],
  },
  [SecurityViolationType.UNAUTHORIZED_TABLE]: {
    es: [
      'Consultar sobre productos, ventas, u órdenes',
      'Solicitar a tu gerente acceso a esa información',
      'Revisar qué permisos tiene tu rol actual',
    ],
    en: [
      'Query about products, sales, or orders',
      'Request access to that information from your manager',
      'Review what permissions your current role has',
    ],
  },
  [SecurityViolationType.PII_ACCESS_ATTEMPT]: {
    es: [
      'Consultar estadísticas agregadas sin datos personales',
      'Solicitar a un administrador información específica si es necesaria',
      'Usar reportes anonimizados del dashboard',
    ],
    en: [
      'Query aggregated statistics without personal data',
      'Request specific information from an administrator if necessary',
      'Use anonymized reports from the dashboard',
    ],
  },
  [SecurityViolationType.DANGEROUS_OPERATION]: {
    es: [
      'Solo puedes hacer consultas de lectura de datos',
      'Usar las pantallas correspondientes para modificar datos',
      'Los cambios deben hacerse desde el dashboard, no desde el chat',
    ],
    en: [
      'You can only perform read-only data queries',
      'Use the appropriate screens to modify data',
      'Changes must be made from the dashboard, not from chat',
    ],
  },
  [SecurityViolationType.CROSS_ORGANIZATION_ACCESS]: {
    es: [
      'Consultar solo datos de tu organización actual',
      'Cambiar de organización desde el menú principal si tienes acceso múltiple',
      'Solicitar a un administrador global reportes consolidados',
    ],
    en: [
      'Query only data from your current organization',
      'Switch organizations from the main menu if you have multiple access',
      'Request consolidated reports from a global administrator',
    ],
  },
}

export class SecurityResponseService {
  /**
   * Generate a standardized security response
   *
   * @param violationType - Type of security violation
   * @param language - Language for the response (default: es)
   * @param customContext - Optional custom context to add to message
   * @returns SecurityResponse object
   */
  public static generateSecurityResponse(
    violationType: SecurityViolationType,
    language: Language = 'es',
    customContext?: string,
  ): SecurityResponse {
    const violationMessage = VIOLATION_MESSAGES[violationType]?.[language]
    const suggestions = ALTERNATIVE_SUGGESTIONS[violationType]?.[language] || []

    const baseMessage =
      language === 'es'
        ? 'Por seguridad, no puedo proporcionar esa información ni ejecutar esa acción.'
        : 'For security reasons, I cannot provide that information or execute that action.'

    const reasonMessage = violationMessage
      ? language === 'es'
        ? `${baseMessage} Esto se debe a que ${violationMessage}.`
        : `${baseMessage} This is because ${violationMessage}.`
      : baseMessage

    const helpMessage = suggestions.length > 0 ? (language === 'es' ? '\n\nPuedo ayudarte con:' : '\n\nI can help you with:') : ''

    const suggestionsList = suggestions.length > 0 ? '\n' + suggestions.map(s => `• ${s}`).join('\n') : ''

    const contextMessage = customContext ? `\n\n${customContext}` : ''

    const message = `${reasonMessage}${helpMessage}${suggestionsList}${contextMessage}`

    // Log the security violation
    logger.warn('🚨 Security violation detected', {
      violationType,
      language,
      timestamp: new Date().toISOString(),
    })

    return {
      blocked: true,
      message,
      alternativeSuggestions: suggestions,
      violationType,
      timestamp: new Date(),
    }
  }

  /**
   * Get a simple blocked message (without suggestions)
   *
   * @param violationType - Type of security violation
   * @param language - Language for the response
   * @returns Simple message string
   */
  public static getSimpleMessage(violationType: SecurityViolationType, language: Language = 'es'): string {
    const violationMessage = VIOLATION_MESSAGES[violationType]?.[language]

    if (!violationMessage) {
      return language === 'es'
        ? 'Por seguridad, no puedo proporcionar esa información ni ejecutar esa acción.'
        : 'For security reasons, I cannot provide that information or execute that action.'
    }

    return language === 'es' ? `Por seguridad, ${violationMessage}.` : `For security reasons, ${violationMessage}.`
  }

  /**
   * Sanitize user message for logging (remove potentially sensitive data)
   *
   * @param message - Original user message
   * @returns Sanitized message
   */
  public static sanitizeMessageForLogging(message: string): string {
    // Remove potential SQL keywords
    let sanitized = message.replace(/\b(password|token|secret|key|pin|ssn|credit[_-]?card)\b/gi, '[REDACTED]')

    // Remove email addresses
    sanitized = sanitized.replace(/[\w.-]+@[\w.-]+\.\w+/g, '[EMAIL]')

    // Remove phone numbers (basic pattern)
    sanitized = sanitized.replace(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, '[PHONE]')

    // Remove UUIDs (potential sensitive IDs)
    sanitized = sanitized.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[ID]')

    return sanitized
  }

  /**
   * Format a security error for API response
   *
   * @param violationType - Type of security violation
   * @param language - Language for the response
   * @returns API error response object
   */
  public static formatApiError(
    violationType: SecurityViolationType,
    language: Language = 'es',
  ): {
    success: false
    error: string
    code: string
    message: string
  } {
    const response = this.generateSecurityResponse(violationType, language)

    return {
      success: false,
      error: 'SECURITY_VIOLATION',
      code: violationType,
      message: response.message,
    }
  }
}
