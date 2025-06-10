// src/errors/AppError.ts
class AppError extends Error {
  public statusCode: number
  public isOperational: boolean
  public status: string // 'fail' or 'error'

  constructor(message: string, statusCode: number, isOperational: boolean = true) {
    super(message)
    this.statusCode = statusCode
    this.isOperational = isOperational
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
  constructor(message: string = 'Acceso prohibido') {
    super(message, 403)
  }
}

export default AppError // Keep default export for the base class if used elsewhere
