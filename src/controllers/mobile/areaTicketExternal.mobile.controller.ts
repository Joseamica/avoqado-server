import { NextFunction, Request, Response } from 'express'

import logger from '../../config/logger'
import AppError from '../../errors/AppError'
import * as service from '../../services/mobile/areaTicketExternal.mobile.service'

/**
 * Controller del cobro externo (settlementRoute EXTERNAL) — Task 11 de
 * "caja externa fase 1". Es la puerta HTTP de lo que ya construyeron las
 * Tasks 6-9 en `areaTicketExternal.mobile.service.ts`: cero lógica de
 * negocio, cero acceso a Prisma. Cada función extrae `authContext` +
 * identidad del dispositivo, llama UNA función del servicio, y responde.
 *
 * `deviceUid`/`staffId`/`idempotencyKey`/`success`/`fail` son el MISMO
 * envelope que `areaTicketV7.mobile.controller.ts` — ese archivo no los
 * exporta (son privados a su módulo), así que se repiten aquí verbatim en
 * vez de forzar un import cruzado entre controllers hermanos. Lo que le
 * importa a Android/iOS (Fase 2, que consume esto) es que el envelope
 * `{ success, data, error }` sea IDÉNTICO, campo por campo — no de dónde
 * vino el código.
 */

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
  logger.warn('[AREA TICKETS EXTERNAL] Rechazo de dominio', {
    code: error.code,
    message: error.message,
    venueId: req.params.venueId,
  })
  return res.status(error.statusCode).json({
    success: false,
    data: null,
    error: {
      code: error.code ?? 'AREA_TICKET_EXTERNAL_REQUEST_FAILED',
      message: error.message,
      retryable: error.statusCode === 429 || error.statusCode >= 500,
      ...(error.details !== undefined ? { details: error.details } : {}),
    },
  })
}

/** POST /venues/:venueId/area-tickets/:ticketId/external-settlement/handoff */
export async function handoff(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await service.markExternalHandoff(req.params.venueId, req.params.ticketId, {
      idempotencyKey: idempotencyKey(req),
      deviceUid: deviceUid(req),
      staffId: staffId(req),
    })
    return success(res, result)
  } catch (error) {
    return fail(error, req, res, next)
  }
}

/** POST /venues/:venueId/area-tickets/:ticketId/external-settlement/confirm */
export async function confirm(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await service.confirmExternalSettlement(req.params.venueId, req.params.ticketId, {
      idempotencyKey: idempotencyKey(req),
      deviceUid: deviceUid(req),
      staffId: staffId(req),
      externalAmount: req.body?.externalAmount,
      externalReference: req.body?.externalReference,
      notes: req.body?.notes,
    })
    return success(res, result)
  } catch (error) {
    return fail(error, req, res, next)
  }
}

/** POST /venues/:venueId/area-tickets/:ticketId/external-settlement/not-charged */
export async function notCharged(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await service.markExternalNotCharged(req.params.venueId, req.params.ticketId, {
      idempotencyKey: idempotencyKey(req),
      deviceUid: deviceUid(req),
      staffId: staffId(req),
      reason: req.body?.reason,
    })
    return success(res, result)
  } catch (error) {
    return fail(error, req, res, next)
  }
}

/**
 * GET /venues/:venueId/area-tickets/pending-confirmation
 * Sin Zod: mismo criterio que su hermana v7 `pendingFulfillment` — es un GET
 * de sólo lectura con dos query params opcionales, y el servicio ya normaliza
 * `cursor`/`limit` (cursor inválido → 400 vía `decodePendingCursor`; limit se
 * acota con `Math.min`/`Math.max`, nunca truena por un número raro).
 */
export async function listPendingConfirmation(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await service.listPendingExternalConfirmation(req.params.venueId, {
      deviceUid: deviceUid(req),
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : null,
      limit: typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined,
    })
    return success(res, result)
  } catch (error) {
    return fail(error, req, res, next)
  }
}
