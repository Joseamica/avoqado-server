/**
 * Terminal Payment TPV Controller (S6, checkpoint 1 del webhook · declaración del cajero, plan 16-sep)
 *
 * La consulta durable POR INTENTO que hace la TERMINAL al reconectar: qué pasó con SU intento y en qué está la
 * solicitud. La identidad es la de la terminal del JWT (`terminalSerialNumber`), no el rol del cajero.
 */
import { Request, Response } from 'express'
import { Prisma } from '@prisma/client'
import { terminalPaymentService } from '../../services/terminal-payment.service'
import { logAction } from '../../services/dashboard/activity-log.service'
import logger from '../../config/logger'

/**
 * GET /api/v1/tpv/venues/:venueId/terminal-payment/attempts/:attemptId
 *
 *  · 403 `TERMINAL_IDENTITY_REQUIRED` si el token no es de una terminal.
 *  · 404 `ATTEMPT_NOT_FOUND` + `outcome: NO_EVIDENCE` si el servidor no conoce el intento PARA ESTA TERMINAL (un intento
 *    de otra terminal o de otro venue se ve igual). 🔴 No acredita ausencia de cobro: la terminal conserva su libreta.
 *  · 200 con `attempt` (el Payment de ESTE intento, nunca el de otro) y `request` (la proyección de siempre).
 */
export const getAttemptStatus = async (req: Request, res: Response) => {
  const { venueId, attemptId } = req.params
  const terminalSerial = req.authContext?.terminalSerialNumber
  if (!terminalSerial) {
    return res.status(403).json({
      success: false,
      status: 'TERMINAL_IDENTITY_REQUIRED',
      message: 'Esta consulta es de la terminal: el token no lleva identidad de terminal.',
    })
  }
  try {
    const estado = await terminalPaymentService.consultarIntentoDeTerminal({ attemptId, venueId, terminalSerial })
    if (!estado) {
      return res.status(404).json({
        success: false,
        status: 'ATTEMPT_NOT_FOUND',
        outcome: 'NO_EVIDENCE',
        message:
          'El servidor no tiene evidencia de ese intento para esta terminal. No acredita que el cobro no haya ocurrido: conserva tu libreta.',
      })
    }
    return res.status(200).json({ success: true, ...estado })
  } catch (error) {
    logger.error('Error in getAttemptStatus', {
      error: error instanceof Error ? error.message : 'Error desconocido',
      venueId,
      attemptId,
    })
    return res.status(500).json({ success: false, message: 'No se pudo consultar el intento' })
  }
}

/**
 * POST /api/v1/tpv/venues/:venueId/terminal-payment/attempts/:attemptId/no-instrument-resolution
 *
 * La declaración del cajero «no se presentó tarjeta» (plan 16-sep, Task 4), en UN paso. La identidad es la de la
 * terminal (`terminalSerialNumber`) y la de la SESIÓN (`authContext.userId`: el PIN con el que entró) — nunca la del
 * cuerpo. Sin PIN si la sesión tiene `payments:resolve-no-instrument`; el `supervisorPin` sólo eleva a un miembro
 * válido del venue que no lo tiene.
 *
 *  · 403 `TERMINAL_IDENTITY_REQUIRED` si el token no es de una terminal (dashboard / POS móvil).
 *  · 403 `SUPERVISOR_AUTHORIZATION_REQUIRED` / `SESSION_NOT_IN_VENUE` (con rastro `TERMINAL_PAYMENT_NO_INSTRUMENT_AUTH_DENIED`).
 *  · 404 `ATTEMPT_NOT_FOUND` (intento desconocido, de otra terminal o de otro venue: indistinguibles).
 *  · 409 `ATTEMPT_NOT_ELIGIBLE` / `POSITIVE_EVIDENCE_EXISTS` / `RESOLUTION_CONFLICT` / `OTHER_ATTEMPT_UNRESOLVED`.
 *  · 503 `RESOLUTION_UNAVAILABLE`: la terminal conserva el intento pendiente. 🔴 Nunca se serializa el error de Prisma
 *    aquí — podría llevar el PIN.
 *  · 200 `{ success, …S6, resolution: { id, acceptedAt, by } }`: la fila quedó FAILED/OPERATOR_RECONCILED_NO_CHARGE.
 */
export const resolveNoInstrument = async (req: Request, res: Response) => {
  const terminalSerial = req.authContext?.terminalSerialNumber
  if (!terminalSerial) return res.status(403).json({ success: false, code: 'TERMINAL_IDENTITY_REQUIRED' })
  const service = await import('../../services/tpv/no-instrument-resolution.service')
  try {
    const result = await service.resolveNoInstrument(
      { venueId: req.params.venueId, attemptId: req.params.attemptId, terminalSerial, actorStaffId: req.authContext?.userId ?? null },
      req.body,
    )
    return res.status(200).json({ success: true, ...result })
  } catch (error) {
    if (error instanceof service.NoInstrumentResolutionError) {
      if (error.statusCode === 403) {
        void logAction({
          staffId: req.authContext?.userId ?? null,
          venueId: req.params.venueId,
          action: 'TERMINAL_PAYMENT_NO_INSTRUMENT_AUTH_DENIED',
          entity: 'TerminalPaymentAttemptLink',
          entityId: req.params.attemptId,
          data: { attemptId: req.params.attemptId, terminalSerial, code: error.code },
        })
      }
      return res.status(error.statusCode).json({ success: false, code: error.code, message: error.message })
    }
    // Nunca el mensaje ni el stack (podrían llevar el PIN): sólo el nombre del error y, si es de Prisma, su código.
    logger.error('No-instrument resolution unavailable', {
      venueId: req.params.venueId,
      attemptId: req.params.attemptId,
      errorName: error instanceof Error ? error.name : typeof error,
      ...(error instanceof Prisma.PrismaClientKnownRequestError ? { errorCode: error.code } : {}),
    })
    return res
      .status(503)
      .json({ success: false, code: 'RESOLUTION_UNAVAILABLE', message: 'No se pudo confirmar el cierre. Conserva el intento pendiente.' })
  }
}
