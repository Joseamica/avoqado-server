// src/errors/AppError.ts
class AppError extends Error {
  public statusCode: number
  public isOperational: boolean
  public status: string // 'fail' or 'error'
  public code?: string // Error code for frontend detection (Stripe/GitHub pattern)

  constructor(message: string, statusCode: number, isOperational: boolean = true, code?: string) {
    super(message)
    this.statusCode = statusCode
    this.isOperational = isOperational
    this.code = code
    // Adjusted status logic: 4xx is 'fail', 5xx is 'error'
    this.status = statusCode >= 400 && statusCode < 500 ? 'fail' : statusCode >= 500 && statusCode < 600 ? 'error' : 'error'

    // Mantener el stack trace adecuado para nuestra subclase de Error
    Object.setPrototypeOf(this, new.target.prototype) // Use new.target for correct prototype chain

    // Capturar el stack trace, excluyendo la llamada al constructor
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor)
    }
  }
}

export class BadRequestError extends AppError {
  constructor(message: string = 'Solicitud incorrecta') {
    super(message, 400)
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = 'Recurso no encontrado') {
    super(message, 404)
  }
}

export class ConflictError extends AppError {
  constructor(message: string = 'Conflicto de recurso') {
    super(message, 409)
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'No autorizado') {
    super(message, 401)
  }
}

export class InternalServerError extends AppError {
  constructor(message: string = 'Error interno del servidor') {
    super(message, 500)
  }
}

// Consider re-adding other specific error classes if they were used elsewhere and are now missing:
export class AuthenticationError extends AppError {
  constructor(message: string = 'No autenticado') {
    super(message, 401)
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = 'Acceso prohibido', code?: string) {
    super(message, 403, true, code)
  }
}

export class ValidationError extends AppError {
  constructor(message: string = 'Error de validación') {
    super(message, 422)
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message: string = 'Demasiadas solicitudes. Intenta de nuevo más tarde.') {
    super(message, 429)
  }
}

export class IncompatibleDeviceError extends AppError {
  constructor(message: string = 'Dispositivo incompatible con el procesador de pagos') {
    super(message, 409, true, 'INCOMPATIBLE_DEVICE')
  }
}

/**
 * Task 12 / validation point #3: thrown when `Terminal.brand` is mutated to a
 * value that would orphan currently-assigned merchants. The dashboard catches
 * this (HTTP 409, code `TERMINAL_BRAND_CHANGE_BLOCKED`), reads
 * `incompatibleMerchants` from the response payload, and prompts the operator
 * to confirm. On confirm, it re-issues the PATCH with `forceUnassign: true`,
 * which prunes the incompatible merchants atomically with the brand change.
 *
 * Carrying structured detail on an AppError is intentional — the global error
 * handler serializes `details` into the JSON response.
 */
export class TerminalBrandChangeBlocked extends AppError {
  public details: { incompatibleMerchants: Array<{ id: string; name: string; code: string }> }
  constructor(incompatibleMerchants: Array<{ id: string; name: string; code: string }>) {
    super(
      'Cambiar la marca del terminal dejaría huérfanos a uno o más comercios asignados. Confirma para continuar.',
      409,
      true,
      'TERMINAL_BRAND_CHANGE_BLOCKED',
    )
    this.details = { incompatibleMerchants }
  }
}

/**
 * Thrown when a charge is sent to a PAX terminal that is already processing
 * another payment (terminal payment arbitration, Slice 0). A physical terminal
 * runs ONE EMV transaction at a time, so a concurrent second request must be
 * rejected fast — never silently emitted (which would double-charge).
 *
 * The mobile controller maps this to HTTP 409 with body
 * `{ status: 'failed', code: 'TERMINAL_BUSY', errorMessage, blockingRequest }`.
 * `status: 'failed'` is deliberate: old iOS/Desktop clients parse the body
 * `status` field and already degrade `failed` safely; new clients branch on
 * `code`/`blockingRequest` to offer "pick another terminal".
 */
export interface TerminalBusyBlockingRequest {
  requestId: string
  amountCents?: number
  senderDevice?: string
  ageSeconds: number
}

export class TerminalBusyError extends AppError {
  public details: { blockingRequest: TerminalBusyBlockingRequest }
  constructor(message: string, blockingRequest: TerminalBusyBlockingRequest) {
    super(message, 409, true, 'TERMINAL_BUSY')
    this.details = { blockingRequest }
  }
}

export default AppError // Keep default export for the base class if used elsewhere
