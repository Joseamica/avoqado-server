import { NextFunction, Request, Response } from 'express'
import { AreaTicketFulfillmentMethod, AreaTicketPrintAttemptKind, AreaTicketPrintAttemptStatus, PaymentMethod } from '@prisma/client'

import logger from '../../config/logger'
import AppError from '../../errors/AppError'
import * as service from '../../services/mobile/areaTicketV7.mobile.service'

function requiredEnum<T extends string>(value: unknown, allowed: readonly T[], field: string, code: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new AppError(`${field} debe ser uno de: ${allowed.join(', ')}.`, 400, true, code)
  }
  return value as T
}

function deviceUid(req: Request): string {
  const raw = req.headers['x-device-id']
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' ? value.trim().slice(0, 64) : ''
}

function staffId(req: Request): string | undefined {
  return (req as any).authContext?.userId
}

function idempotencyKey(req: Request): string {
  const raw = req.headers['idempotency-key']
  const header = Array.isArray(raw) ? raw[0] : raw
  return (typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey : header) ?? ''
}

function success(res: Response, data: unknown, status = 200) {
  return res.status(status).json({ success: true, data, error: null })
}

function fail(error: unknown, req: Request, res: Response, next: NextFunction) {
  if (!(error instanceof AppError)) return next(error)
  logger.warn('[AREA TICKETS v7] Rechazo de dominio', {
    code: error.code,
    message: error.message,
    venueId: req.params.venueId,
  })
  return res.status(error.statusCode).json({
    success: false,
    data: null,
    error: {
      code: error.code ?? 'AREA_TICKET_REQUEST_FAILED',
      message: error.message,
      retryable: error.statusCode === 429 || error.statusCode >= 500,
      ...(error.details !== undefined ? { details: error.details } : {}),
    },
  })
}

export async function getSettings(req: Request, res: Response, next: NextFunction) {
  try {
    return success(res, await service.getAreaTicketSettings(req.params.venueId, deviceUid(req)))
  } catch (error) {
    return fail(error, req, res, next)
  }
}

export async function getScaleSettings(req: Request, res: Response, next: NextFunction) {
  try {
    return success(res, await service.getScaleSettings(req.params.venueId, deviceUid(req)))
  } catch (error) {
    return fail(error, req, res, next)
  }
}

export async function issue(req: Request, res: Response, next: NextFunction) {
  try {
    const ticket = await service.issueAreaTicket(req.params.venueId, {
      idempotencyKey: idempotencyKey(req),
      deviceUid: deviceUid(req),
      staffId: staffId(req),
      lines: req.body?.lines,
    })
    return success(res, { ticket }, 201)
  } catch (error) {
    return fail(error, req, res, next)
  }
}

export async function resolveScan(req: Request, res: Response, next: NextFunction) {
  try {
    const context = req.body?.context
    if (!['CHECKOUT', 'AREA_DELIVERY', 'PRODUCT_LOOKUP'].includes(context)) {
      throw new AppError('context debe ser CHECKOUT, AREA_DELIVERY o PRODUCT_LOOKUP.', 400)
    }
    const result = await service.resolveAreaTicketScan(
      req.params.venueId,
      typeof req.body?.code === 'string' ? req.body.code : '',
      context,
      deviceUid(req),
    )
    return success(res, result)
  } catch (error) {
    return fail(error, req, res, next)
  }
}

export async function createCheckout(req: Request, res: Response, next: NextFunction) {
  try {
    const checkout = await service.createAreaTicketCheckout(req.params.venueId, {
      idempotencyKey: idempotencyKey(req),
      deviceUid: deviceUid(req),
      staffId: staffId(req),
    })
    return success(res, { checkout }, 201)
  } catch (error) {
    return fail(error, req, res, next)
  }
}

export async function addTicket(req: Request, res: Response, next: NextFunction) {
  try {
    const checkout = await service.addTicketToCheckout(
      req.params.venueId,
      req.params.sessionId,
      typeof req.body?.code === 'string' ? req.body.code : '',
      {
        idempotencyKey: idempotencyKey(req),
        deviceUid: deviceUid(req),
        staffId: staffId(req),
      },
    )
    return success(res, { checkout })
  } catch (error) {
    return fail(error, req, res, next)
  }
}

export async function removeTicket(req: Request, res: Response, next: NextFunction) {
  try {
    const checkout = await service.removeTicketFromCheckout(req.params.venueId, req.params.sessionId, req.params.ticketId, {
      idempotencyKey: idempotencyKey(req),
      deviceUid: deviceUid(req),
      staffId: staffId(req),
    })
    return success(res, { checkout })
  } catch (error) {
    return fail(error, req, res, next)
  }
}

export async function materialize(req: Request, res: Response, next: NextFunction) {
  try {
    const checkout = await service.materializeAreaTicketCheckout(req.params.venueId, req.params.sessionId, {
      idempotencyKey: idempotencyKey(req),
      deviceUid: deviceUid(req),
      staffId: staffId(req),
      normalItems: req.body?.normalItems,
      source: req.body?.source,
      customerName: req.body?.customerName,
      note: req.body?.note,
    })
    return success(res, { checkout })
  } catch (error) {
    return fail(error, req, res, next)
  }
}

export async function heartbeat(req: Request, res: Response, next: NextFunction) {
  try {
    const checkout = await service.heartbeatAreaTicketCheckout(req.params.venueId, req.params.sessionId, {
      idempotencyKey: idempotencyKey(req),
      deviceUid: deviceUid(req),
      staffId: staffId(req),
    })
    return success(res, { checkout })
  } catch (error) {
    return fail(error, req, res, next)
  }
}

export async function preparePayment(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await service.prepareAreaTicketPayment(req.params.venueId, req.params.sessionId, {
      idempotencyKey: idempotencyKey(req),
      deviceUid: deviceUid(req),
      staffId: staffId(req),
      amount: typeof req.body?.amount === 'string' ? req.body.amount : '',
      method: requiredEnum(req.body?.method, Object.values(PaymentMethod), 'method', 'AREA_TICKET_INVALID_PAYMENT_METHOD'),
    })
    const uncertain = result.state === 'RECONCILIATION_REQUIRED' || result.checkout.status === 'RECONCILIATION_REQUIRED'
    return success(res, result, uncertain ? 202 : 200)
  } catch (error) {
    return fail(error, req, res, next)
  }
}

export async function getPaymentAttempt(req: Request, res: Response, next: NextFunction) {
  try {
    return success(
      res,
      await service.getAreaTicketPaymentAttempt(req.params.venueId, req.params.sessionId, req.params.attemptId, deviceUid(req)),
    )
  } catch (error) {
    return fail(error, req, res, next)
  }
}

export async function cancelCheckout(req: Request, res: Response, next: NextFunction) {
  try {
    const checkout = await service.cancelAreaTicketCheckout(req.params.venueId, req.params.sessionId, {
      idempotencyKey: idempotencyKey(req),
      deviceUid: deviceUid(req),
      staffId: staffId(req),
    })
    return success(res, { checkout })
  } catch (error) {
    return fail(error, req, res, next)
  }
}

export async function getCheckout(req: Request, res: Response, next: NextFunction) {
  try {
    return success(res, { checkout: await service.getAreaTicketCheckout(req.params.venueId, req.params.sessionId, deviceUid(req)) })
  } catch (error) {
    return fail(error, req, res, next)
  }
}

export async function recordPrintAttempt(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await service.recordAreaTicketPrintAttempt(req.params.venueId, req.params.ticketId, {
      idempotencyKey: idempotencyKey(req),
      deviceUid: deviceUid(req),
      staffId: staffId(req),
      status: requiredEnum(req.body?.status, Object.values(AreaTicketPrintAttemptStatus), 'status', 'AREA_TICKET_INVALID_PRINT_STATUS'),
      kind: requiredEnum(req.body?.kind, Object.values(AreaTicketPrintAttemptKind), 'kind', 'AREA_TICKET_INVALID_PRINT_KIND'),
      reason: req.body?.reason,
      errorCode: req.body?.errorCode,
    })
    return success(res, result)
  } catch (error) {
    return fail(error, req, res, next)
  }
}

export async function pendingFulfillment(req: Request, res: Response, next: NextFunction) {
  try {
    return success(
      res,
      await service.listPendingAreaTicketFulfillment(req.params.venueId, {
        deviceUid: deviceUid(req),
        cursor: typeof req.query.cursor === 'string' ? req.query.cursor : null,
        limit: typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined,
      }),
    )
  } catch (error) {
    return fail(error, req, res, next)
  }
}

export async function resolveFulfillment(req: Request, res: Response, next: NextFunction) {
  try {
    return success(
      res,
      await service.resolveAreaTicketFulfillment(
        req.params.venueId,
        typeof req.body?.code === 'string' ? req.body.code : '',
        deviceUid(req),
      ),
    )
  } catch (error) {
    return fail(error, req, res, next)
  }
}

export async function fulfill(req: Request, res: Response, next: NextFunction) {
  try {
    return success(
      res,
      await service.fulfillAreaTicket(req.params.venueId, req.params.ticketId, {
        idempotencyKey: idempotencyKey(req),
        deviceUid: deviceUid(req),
        staffId: staffId(req),
        method: requiredEnum(
          req.body?.method,
          Object.values(AreaTicketFulfillmentMethod),
          'method',
          'AREA_TICKET_INVALID_FULFILLMENT_METHOD',
        ),
      }),
    )
  } catch (error) {
    return fail(error, req, res, next)
  }
}
