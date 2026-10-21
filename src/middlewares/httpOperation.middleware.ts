import type { RequestHandler } from 'express'
import { ConflictError } from '@/errors/AppError'
import { parseHttpOperation } from '@/services/mobile/http-operation.mobile.service'

export const httpOperationGuard =
  (supported: boolean): RequestHandler =>
  (req, _res, next) => {
    try {
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'httpOperation')) {
        if (!supported) throw new ConflictError('Esta acción todavía no admite recibos HTTP', 'HTTP_OPERATION_UNSUPPORTED')
        parseHttpOperation(req.body)
      }
      next()
    } catch (error) {
      next(error)
    }
  }
