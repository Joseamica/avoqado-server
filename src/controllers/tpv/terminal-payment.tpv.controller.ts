/**
 * Terminal Payment TPV Controller (S6, checkpoint 1 del webhook · declaración del cajero, plan 16-sep)
 *
 * La consulta durable POR INTENTO que hace la TERMINAL al reconectar: qué pasó con SU intento y en qué está la
 * solicitud. La identidad es la de la terminal del JWT (`terminalSerialNumber`), no el rol del cajero.
 */
import { NextFunction, Request, Response } from 'express'
import { Prisma } from '@prisma/client'
import { terminalPaymentService } from '../../services/terminal-payment.service'
import { logAction } from '../../services/dashboard/activity-log.service'
import * as reverso from '../../services/tpv/reversoDeLaTerminal.service'
import { llaveDeIntento } from '../../services/tpv/candadoDeIntento'
import AppError from '../../errors/AppError'
import { isTransientDbConnectionError } from '../../utils/retry'
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
 * GET /api/v1/tpv/venues/:venueId/terminal-payment/requests/:requestId  (pieza D, 22-sep)
 *
 * La hermana de S6, pero por SOLICITUD. Existe por un hallazgo en hardware: una terminal llevaba 25 h mostrando
 * «quedó un cobro sin confirmar» sobre una solicitud que el servidor YA había resuelto; su bandeja seguía en
 * PROCESSING y su libreta no tenía ningún intento de esa solicitud, así que nada podía alcanzarla — toda la
 * recuperación consulta por intento. Con esto la terminal puede cerrar esa fila y quitar el aviso.
 *
 *  · 403 `TERMINAL_IDENTITY_REQUIRED` si el token no es de una terminal.
 *  · 404 `REQUEST_NOT_FOUND` si la solicitud no es de esta terminal y este venue. 🔴 No acredita nada del cobro.
 *  · 200 con `request` (la proyección de siempre) y `resuelta` — si el servidor ya no la cuenta como pendiente.
 */
export const getRequestStatus = async (req: Request, res: Response) => {
  const { venueId, requestId } = req.params
  const terminalSerial = req.authContext?.terminalSerialNumber
  if (!terminalSerial) {
    return res.status(403).json({
      success: false,
      status: 'TERMINAL_IDENTITY_REQUIRED',
      message: 'Esta consulta es de la terminal: el token no lleva identidad de terminal.',
    })
  }
  try {
    const estado = await terminalPaymentService.consultarSolicitudDeTerminal({ requestId, venueId, terminalSerial })
    if (!estado) {
      return res.status(404).json({
        success: false,
        status: 'REQUEST_NOT_FOUND',
        message: 'El servidor no conoce esa solicitud para esta terminal. No acredita nada sobre el cobro.',
      })
    }
    return res.status(200).json({ success: true, requestId, ...estado })
  } catch (error) {
    logger.error('Error in getRequestStatus', {
      error: error instanceof Error ? error.message : 'Error desconocido',
      venueId,
      requestId,
    })
    return res.status(500).json({ success: false, message: 'No se pudo consultar la solicitud' })
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
      // Sólo el CÓDIGO (nunca el cuerpo: puede traer un PIN): sin esto el log decía «409» y no por qué — un «sin aviso
      // comprobado» (ronda 20) y una evidencia de dinero se veían idénticos.
      logger.warn('No-instrument resolution rejected', {
        venueId: req.params.venueId,
        attemptId: req.params.attemptId,
        code: error.code,
        statusCode: error.statusCode,
      })
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

/**
 * Lo común a los endpoints del reverso (Tareas 9 y 10): un error de dominio sale con su `code` y sus datos al mismo nivel; si la
 * base no contesta (conexión, pool agotado, no arranca), 503 `REVERSO_NO_DISPONIBLE` — la respuesta con la que la terminal sabe
 * que puede reversar igual (spec §16.3); cualquier otro error sigue al manejador global (500).
 */
export function responderErrorDelReverso(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
  mensaje503 = 'No se pudo confirmar el permiso.',
) {
  if (error instanceof AppError) {
    const datos =
      error.details && typeof error.details === 'object' && !Array.isArray(error.details) ? (error.details as Record<string, unknown>) : {}
    return res.status(error.statusCode).json({ ...datos, success: false, code: error.code, message: error.message })
  }
  if (isTransientDbConnectionError(error) || error instanceof Prisma.PrismaClientInitializationError) {
    logger.error('❌ [Blumon reverso] La base no contestó — la terminal puede reversar sin permiso', {
      venueId: req.params.venueId,
      attemptId: req.params.attemptId,
      errorName: error instanceof Error ? error.name : typeof error,
      errorCode: (error as { code?: unknown; errorCode?: unknown }).code ?? (error as { errorCode?: unknown }).errorCode,
    })
    return res.status(503).json({ success: false, code: 'REVERSO_NO_DISPONIBLE', message: mensaje503 })
  }
  return next(error)
}

/**
 * POST /api/v1/tpv/venues/:venueId/terminal-payment/attempts/:attemptId/reverso/intencion (SDK propio, Tarea 9)
 *
 * La terminal pide permiso ANTES de mandarle el reverso a Blumon. 🔴 Sólo reversa con `200` y `estado === 'reversing'`: con otro
 * estado (una lápida que ya tiene desenlace) muestra ese desenlace y no reversa otra vez (H21).
 *  · 403 `TERMINAL_IDENTITY_REQUIRED` si el token no es de una terminal.
 *  · 404 `ATTEMPT_NOT_FOUND` (sin vínculo, de otro negocio o de otra terminal) · 409 `ATTEMPT_NOT_BLUMON`.
 *  · 409 `ATTEMPT_ALREADY_RECORDED` + `payment` («Aprobado») · 409 `ATTEMPT_HAS_PENDING_EVIDENCE` + `evidencia` («En duda»).
 *  · 503 `REVERSO_NO_DISPONIBLE` si la base no contesta.
 */
export const pedirPermisoDeReverso = async (req: Request, res: Response, next: NextFunction) => {
  const terminalSerial = req.authContext?.terminalSerialNumber
  if (!terminalSerial) return res.status(403).json({ success: false, code: 'TERMINAL_IDENTITY_REQUIRED' })
  try {
    const { estado, eventLogId } = await reverso.pedirPermisoDeReverso({
      venueId: req.params.venueId,
      attemptId: req.params.attemptId,
      terminalSerial,
    })
    return res.status(200).json({ success: true, attemptId: llaveDeIntento(req.params.attemptId), estado, eventLogId })
  } catch (error) {
    return responderErrorDelReverso(error, req, res, next)
  }
}

/**
 * POST /api/v1/tpv/venues/:venueId/terminal-payment/attempts/:attemptId/reverso/resultado (SDK propio, Tarea 10)
 *
 * La terminal reporta cómo le fue al reverso con Blumon. 200 `{ estado, eventLogId, paymentId? }`: `reversed` («No se cobró»),
 * `reverse_failed` (cobrada: el aviso crea el cobro) o `contradiction` (reversó, pero el cobro ya estaba registrado: «En duda»,
 * lo resuelve una persona; trae `paymentId`). Un desenlace ya guardado no se reescribe: el mismo resultado contesta lo guardado,
 * uno distinto 409 `REVERSAL_RESULT_CONFLICT` (con el `estado` guardado). 404/409 de pertenencia como el permiso; 503
 * `REVERSO_NO_DISPONIBLE` si la base no contesta (la terminal lo reintenta desde su cola).
 */
export const registrarResultadoDelReverso = async (req: Request, res: Response, next: NextFunction) => {
  const terminalSerial = req.authContext?.terminalSerialNumber
  if (!terminalSerial) return res.status(403).json({ success: false, code: 'TERMINAL_IDENTITY_REQUIRED' })
  try {
    const { estado, eventLogId, paymentId } = await reverso.registrarResultadoDelReverso({
      venueId: req.params.venueId,
      attemptId: req.params.attemptId,
      terminalSerial,
      staffId: req.authContext?.userId,
      resultado: req.body,
    })
    return res
      .status(200)
      .json({ success: true, attemptId: llaveDeIntento(req.params.attemptId), estado, eventLogId, ...(paymentId ? { paymentId } : {}) })
  } catch (error) {
    return responderErrorDelReverso(error, req, res, next, 'No se pudo registrar el resultado del reverso.')
  }
}
