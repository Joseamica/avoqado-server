/**
 * Blumon Error Parser
 *
 * Converts technical Blumon API errors into user-friendly Spanish messages.
 *
 * **Design Decision**: Parse both error codes AND descriptions to provide
 * the best possible user experience. Some errors have structured JSON,
 * others are plain text descriptions.
 *
 * **Why**: Users should never see technical error codes or JSON. They need
 * clear, actionable Spanish messages that tell them what went wrong and
 * what to do next.
 *
 * @module utils/blumon-error-parser
 */

/**
 * Blumon error response structure (when available)
 */
interface BlumonErrorResponse {
  code?: string
  description?: string
  httpStatusCode?: number
  binInformation?: {
    bin: string
    bank: string
    product: string
    type: string
    brand: string
  }
}

/**
 * User-friendly error message with action
 */
export interface FriendlyError {
  /** User-facing title */
  title: string
  /** Detailed explanation */
  message: string
  /** What the user should do next */
  action: string
  /** Whether retry is allowed */
  canRetry: boolean
  /** Original error code for debugging */
  code?: string
}

/**
 * Error code to friendly message mapping
 *
 * Based on Blumon API documentation and real-world testing
 */
const ERROR_MESSAGES: Record<string, FriendlyError> = {
  // Card validation errors
  CARD_DECLINED: {
    title: 'Tarjeta Rechazada',
    message: 'Tu banco rechazó la transacción. Esto puede ocurrir por varias razones.',
    action: 'Intenta con otra tarjeta o contacta a tu banco para más información.',
    canRetry: true,
    code: 'CARD_DECLINED',
  },

  INSUFFICIENT_FUNDS: {
    title: 'Fondos Insuficientes',
    message: 'Tu tarjeta no tiene saldo suficiente para completar esta compra.',
    action: 'Intenta con otra tarjeta o verifica el saldo disponible.',
    canRetry: true,
    code: 'INSUFFICIENT_FUNDS',
  },

  EXPIRED_CARD: {
    title: 'Tarjeta Vencida',
    message: 'La tarjeta que ingresaste ha expirado.',
    action: 'Usa una tarjeta vigente para continuar con tu pago.',
    canRetry: true,
    code: 'EXPIRED_CARD',
  },

  INVALID_CVV: {
    title: 'CVV Incorrecto',
    message: 'El código de seguridad (CVV) que ingresaste no es válido.',
    action: 'Verifica el CVV en el reverso de tu tarjeta e intenta nuevamente.',
    canRetry: true,
    code: 'INVALID_CVV',
  },

  INVALID_CARD_NUMBER: {
    title: 'Número de Tarjeta Inválido',
    message: 'El número de tarjeta que ingresaste no es válido.',
    action: 'Verifica que hayas ingresado correctamente los 16 dígitos.',
    canRetry: true,
    code: 'INVALID_CARD_NUMBER',
  },

  INVALID_EXPIRY: {
    title: 'Fecha de Expiración Inválida',
    message: 'La fecha de expiración que ingresaste no es válida.',
    action: 'Verifica la fecha en tu tarjeta (MM/AA) e intenta nuevamente.',
    canRetry: true,
    code: 'INVALID_EXPIRY',
  },

  // Transaction limit errors
  TX_001: {
    title: 'Límite de Transacción Excedido',
    message: 'El monto de esta transacción excede el límite permitido por tu banco.',
    action: 'Intenta con un monto menor o contacta a tu banco para aumentar tu límite.',
    canRetry: false,
    code: 'TX_001',
  },

  TX_003: {
    title: 'Límite Mensual Excedido',
    message: 'Has alcanzado el límite mensual de transacciones permitidas.',
    action: 'Intenta con otra tarjeta o espera hasta el próximo mes.',
    canRetry: true,
    code: 'TX_003',
  },

  // Network and system errors
  TIMEOUT: {
    title: 'Tiempo de Espera Agotado',
    message: 'La transacción tardó demasiado en procesarse.',
    action: 'Por favor, intenta nuevamente en unos momentos.',
    canRetry: true,
    code: 'TIMEOUT',
  },

  NETWORK_ERROR: {
    title: 'Error de Conexión',
    message: 'No pudimos conectarnos con el banco para procesar tu pago.',
    action: 'Verifica tu conexión a internet e intenta nuevamente.',
    canRetry: true,
    code: 'NETWORK_ERROR',
  },

  SYSTEM_ERROR: {
    title: 'Error del Sistema',
    message: 'Ocurrió un error inesperado al procesar tu pago.',
    action: 'Por favor, intenta nuevamente o contacta al soporte.',
    canRetry: true,
    code: 'SYSTEM_ERROR',
  },

  // Session errors
  SESSION_EXPIRED: {
    title: 'Sesión Expirada',
    message: 'Tu sesión de pago ha expirado por seguridad.',
    action: 'Inicia el proceso de pago nuevamente.',
    canRetry: false,
    code: 'SESSION_EXPIRED',
  },

  SESSION_ALREADY_COMPLETED: {
    title: 'Pago Ya Completado',
    message: 'Este pago ya fue procesado exitosamente.',
    action: 'Revisa tu historial de transacciones.',
    canRetry: false,
    code: 'SESSION_ALREADY_COMPLETED',
  },

  // Default fallback
  UNKNOWN_ERROR: {
    title: 'Error Desconocido',
    message: 'Ocurrió un error al procesar tu pago.',
    action: 'Por favor, intenta nuevamente o contacta al soporte.',
    canRetry: true,
    code: 'UNKNOWN_ERROR',
  },
}

/**
 * Parse Blumon error into user-friendly message
 *
 * Handles multiple error formats:
 * - Structured JSON with error code
 * - Plain text descriptions
 * - API error messages
 *
 * @param error - Error from Blumon API
 * @returns User-friendly error message
 *
 * @example
 * ```typescript
 * try {
 *   await blumonTpvService.tokenizeCard(...)
 * } catch (error) {
 *   const friendlyError = parseBlumonError(error)
 *   return res.status(400).json({
 *     error: friendlyError.title,
 *     message: friendlyError.message,
 *     action: friendlyError.action,
 *     canRetry: friendlyError.canRetry
 *   })
 * }
 * ```
 */
export function parseBlumonError(error: any): FriendlyError {
  // Handle Error objects
  const errorMessage = error?.message || error?.toString() || 'Unknown error'

  // Try to parse as JSON (Blumon structured errors)
  try {
    const parsed: BlumonErrorResponse = JSON.parse(errorMessage)

    // Look up by error code
    if (parsed.code && ERROR_MESSAGES[parsed.code]) {
      return ERROR_MESSAGES[parsed.code]
    }

    // Fallback to description matching
    if (parsed.description) {
      return matchErrorByDescription(parsed.description)
    }
  } catch {
    // Not JSON, try to match by plain text description
    return matchErrorByDescription(errorMessage)
  }

  // Ultimate fallback
  return ERROR_MESSAGES.UNKNOWN_ERROR
}

/**
 * Match error by Spanish description
 *
 * Blumon sometimes returns errors in Spanish without structured codes.
 * This function maps common Spanish error messages to their error codes.
 *
 * @param description - Spanish error description
 * @returns Matched friendly error
 */
function matchErrorByDescription(description: string): FriendlyError {
  const lowerDescription = description.toLowerCase()

  // Card declined variations
  if (lowerDescription.includes('rechazada') || lowerDescription.includes('declined') || lowerDescription.includes('denegada')) {
    return ERROR_MESSAGES.CARD_DECLINED
  }

  // Insufficient funds
  if (
    lowerDescription.includes('fondos insuficientes') ||
    lowerDescription.includes('insufficient funds') ||
    lowerDescription.includes('saldo insuficiente')
  ) {
    return ERROR_MESSAGES.INSUFFICIENT_FUNDS
  }

  // Expired card
  if (lowerDescription.includes('expirado') || lowerDescription.includes('vencida') || lowerDescription.includes('expired')) {
    return ERROR_MESSAGES.EXPIRED_CARD
  }

  // Invalid CVV
  if (lowerDescription.includes('cvv') || lowerDescription.includes('código de seguridad') || lowerDescription.includes('security code')) {
    return ERROR_MESSAGES.INVALID_CVV
  }

  // Transaction limits
  if (
    lowerDescription.includes('límite de transacción') ||
    lowerDescription.includes('transaction limit') ||
    lowerDescription.includes('excede el monto permitido') ||
    lowerDescription.includes('tx_001')
  ) {
    return ERROR_MESSAGES.TX_001
  }

  if (
    lowerDescription.includes('límite mensual') ||
    lowerDescription.includes('monthly limit') ||
    lowerDescription.includes('monto mensual permitido') ||
    lowerDescription.includes('tx_003')
  ) {
    return ERROR_MESSAGES.TX_003
  }

  // Session errors
  if (lowerDescription.includes('expired') || lowerDescription.includes('expirada')) {
    return ERROR_MESSAGES.SESSION_EXPIRED
  }

  if (lowerDescription.includes('already completed') || lowerDescription.includes('ya completado')) {
    return ERROR_MESSAGES.SESSION_ALREADY_COMPLETED
  }

  // Timeout
  if (lowerDescription.includes('timeout') || lowerDescription.includes('tiempo agotado')) {
    return ERROR_MESSAGES.TIMEOUT
  }

  // Network errors
  if (lowerDescription.includes('network') || lowerDescription.includes('conexión') || lowerDescription.includes('connection')) {
    return ERROR_MESSAGES.NETWORK_ERROR
  }

  // Fallback
  return ERROR_MESSAGES.UNKNOWN_ERROR
}

/**
 * Get all possible error messages (for documentation/testing)
 */
export function getAllErrorMessages(): Record<string, FriendlyError> {
  return ERROR_MESSAGES
}
