/**
 * Terminal Payment TPV Controller (S6, checkpoint 1 del webhook)
 *
 * La consulta durable POR INTENTO que hace la TERMINAL al reconectar: qué pasó con SU intento y en qué está la
 * solicitud. La identidad es la de la terminal del JWT (`terminalSerialNumber`), no el rol del cajero.
 */
import { Request, Response } from 'express'
import { terminalPaymentService } from '../../services/terminal-payment.service'
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
