/**
 * Terminal Payment Mobile Controller
 *
 * Handles HTTP endpoints for sending payments to TPV terminals via Socket.IO.
 * iOS app calls these endpoints; backend bridges to terminal via socket.
 */

import { Request, Response } from 'express'
import { type CancelPaymentOutcome, terminalPaymentService } from '../../services/terminal-payment.service'
import { terminalRegistry } from '../../communication/sockets/terminal-registry'
import logger from '../../config/logger'
import AppError, {
  BadRequestError,
  OrderAlreadyPaidError,
  TerminalBusyError,
  TerminalPaymentAdmissionRetryError,
  TerminalUnavailableError,
} from '../../errors/AppError'
import { validateStaffVenue } from '../../utils/staff-venue.util'
import { normalizeRequestedCustomerId } from '../../services/tpv/fastPaymentCustomer'

/** Cota del id de cliente: la misma que `/fast` (`tpv.schema.ts`). */
const MAX_CUSTOMER_ID_LENGTH = 64
/** Coincide con la cota del teclado POS Android: $1,000,000.00 por cobro. */
const MAX_TERMINAL_PAYMENT_CENTS = 100_000_000

/**
 * El cliente que el POS adjunta al cobro: se normaliza y, si no cabe o no es un string,
 * se DESCARTA — nunca se rechaza el cobro.
 *
 * 🔴 Esta ruta dispara el cobro con TARJETA. Devolver 400 por el formato de un id de
 * cliente le impediría cobrar al comercio por un dato que ni siquiera toca el dinero: el
 * peor intercambio posible. Es la misma lección que costó un incidente con
 * `terminalPaymentRequestId` (`min(1)`, no `min(8)`) y la que gobierna `customerId` en
 * `/fast` (`.catch(undefined)`).
 *
 * La cota existe por otra razón: el límite de body es 1 MB, así que sin ella un id
 * gigante acabaría en la columna y en el meta del logger de CADA cobro.
 */
function sanitizeRelayCustomerId(raw: unknown): string | null {
  const normalized = normalizeRequestedCustomerId(raw)
  if (!normalized || normalized.length > MAX_CUSTOMER_ID_LENGTH) return null
  return normalized
}

/**
 * POST /api/v1/mobile/venues/:venueId/terminal-payment
 *
 * Send a payment request to a specific terminal.
 * Long-polls until the terminal succeeds, is cancelled, or reaches the server timeout.
 */
export async function sendTerminalPayment(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const { terminalId, amountCents, tipCents, rating, skipReview, orderId, requestId, processedByStaffId, customerId } = req.body
    const userId = (req as any).authContext?.userId
    const relayCustomerId = sanitizeRelayCustomerId(customerId)

    // Esta frontera termina en columnas Int + un SDK de dinero: no se coercionan
    // strings ni decimales. Aceptarlos aquí crea diferencias silenciosas entre lo
    // que pidió el POS, lo que recibe la terminal y lo que finalmente se concilia.
    if (typeof terminalId !== 'string' || terminalId.trim().length === 0 || amountCents === undefined) {
      return res.status(400).json({
        success: false,
        message: 'terminalId y amountCents son requeridos',
      })
    }

    if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > MAX_TERMINAL_PAYMENT_CENTS) {
      return res.status(400).json({
        success: false,
        message: `El monto debe ser un entero entre 1 y ${MAX_TERMINAL_PAYMENT_CENTS} centavos`,
      })
    }

    if (tipCents !== undefined && (!Number.isSafeInteger(tipCents) || tipCents < 0 || tipCents > MAX_TERMINAL_PAYMENT_CENTS)) {
      return res.status(400).json({
        success: false,
        message: `La propina debe ser un entero entre 0 y ${MAX_TERMINAL_PAYMENT_CENTS} centavos`,
      })
    }

    if (rating !== undefined && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
      return res.status(400).json({ success: false, message: 'La calificación debe ser un entero entre 1 y 5' })
    }

    if (skipReview !== undefined && typeof skipReview !== 'boolean') {
      return res.status(400).json({ success: false, message: 'skipReview debe ser booleano' })
    }

    // 🔴 «La terminal no pertenece a este establecimiento» (403) ya NO se decide aquí: lo decide el servicio BAJO el
    // candado de la terminal y deja su lápida (H.5), igual que «no conectada» o «sin socket». Cortarlo aquí, antes de
    // la admisión, dejaba pasar una copia posterior del MISMO POST si la terminal cambiaba de estado entre las dos.

    // El POS manda al vendedor elegido. Clientes viejos (iOS publicado) no mandan
    // la llave: en ese caso se congela al usuario autenticado, no al usuario que por
    // casualidad tenga sesión abierta en la TPV.
    const validatedProcessedByStaffId = await validateStaffVenue(processedByStaffId, venueId, userId)

    logger.info(`💳 [API] Terminal payment request`, {
      venueId,
      terminalId,
      amountCents,
      tipCents,
      orderId,
      userId,
      processedByStaffId: validatedProcessedByStaffId,
      customerId: relayCustomerId,
    })

    const result = await terminalPaymentService.sendPaymentToTerminal({
      terminalId,
      amountCents,
      tipCents,
      rating,
      skipReview: skipReview ?? true,
      orderId,
      venueId,
      requestedBy: userId,
      senderDeviceName: req.headers['x-device-name'] as string | undefined,
      processedByStaffId: validatedProcessedByStaffId,
      requestId, // Client-generated for cancel tracking
      // Se guarda en la fila; NUNCA se emite a la terminal (ver terminal-payment.service.ts).
      customerId: relayCustomerId,
    })

    const httpStatus = result.status === 'success' ? 200 : result.status === 'timeout' ? 504 : result.status === 'cancelled' ? 409 : 422

    return res.status(httpStatus).json({
      success: result.status === 'success',
      ...result,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error desconocido'

    // 🔑 Todo rechazo de admisión que el servicio decide bajo el candado deja lápida y sale con `code` + `details.requestId`
    // (H.5/H.6): con eso el POS sabe que ESE cobro no se creó y que la misma solicitud repetirá el mismo rechazo. Aditivo:
    // lo que ya leían las apps publicadas (`status`, `message`, `errorMessage`, `blockingRequest`) queda igual.
    const conDetalles = (details: unknown) => (details ? { details } : {})

    // Terminal already processing another charge → 409 busy.
    // Body carries status:'failed' so OLD iOS/Desktop clients (which parse the
    // body `status` field, not the HTTP code) degrade safely; NEW clients read
    // `code`/`blockingRequest` to offer "pick another terminal".
    if (error instanceof TerminalBusyError) {
      return res.status(409).json({
        success: false,
        status: 'failed',
        code: 'TERMINAL_BUSY',
        errorMessage: message,
        message,
        blockingRequest: error.details.blockingRequest,
        details: error.details,
      })
    }

    // Orden YA saldada → 409 con code propio. Mismo contrato defensivo que TERMINAL_BUSY:
    // `status:'failed'` para que clientes VIEJOS (que leen el body, no el HTTP code) degraden
    // a un fallo normal en vez de colgarse; clientes nuevos leen `code` y muestran el mensaje.
    if (error instanceof OrderAlreadyPaidError) {
      return res.status(409).json({
        success: false,
        status: 'failed',
        code: 'ORDER_ALREADY_PAID',
        errorMessage: message,
        message,
        ...conDetalles(error.details),
      })
    }

    // La admisión no pudo decidir (tiempo agotado o conflicto de la transacción): «reintenta con la MISMA solicitud;
    // todavía no se sabe». `status:'timeout'` es el desenlace incierto que las apps publicadas ya leen como «consulta
    // antes de volver a cobrar». Nunca un 500 sin código.
    if (error instanceof TerminalPaymentAdmissionRetryError) {
      return res.status(503).json({
        success: false,
        status: 'timeout',
        code: error.code,
        errorMessage: message,
        message,
        ...conDetalles(error.details),
      })
    }

    // Terminal no conectada (404), registrada sin socket (422) o de otro establecimiento (403): mismo cuerpo de
    // siempre (`success` + `message`) más `code` y `details.requestId`.
    if (error instanceof TerminalUnavailableError) {
      return res.status(error.statusCode).json({
        success: false,
        code: error.code,
        message,
        ...conDetalles(error.details),
      })
    }

    // Terminal not online → 404
    if (message.includes('no está conectada')) {
      return res.status(404).json({
        success: false,
        message,
      })
    }

    // Terminal registered via HTTP heartbeat but no socket → 422
    if (message.includes('no tiene conexión de socket')) {
      return res.status(422).json({
        success: false,
        message,
      })
    }

    if (error instanceof BadRequestError) {
      // `ORDER_CANCELLED_NO_NEW_CHARGE` / `ORDER_NOT_FOUND` llevan código y `details.requestId` (antes se perdían aquí).
      // Un conflicto de solicitud (sin código) sale como siempre: sólo su mensaje.
      return res.status(400).json({
        success: false,
        message,
        ...(error.code ? { code: error.code } : {}),
        ...conDetalles(error.details),
      })
    }

    logger.error('Error in sendTerminalPayment', {
      error: message,
      stack: error instanceof Error ? error.stack : undefined,
      venueId: req.params.venueId,
      terminalId: req.body.terminalId,
      amountCents: req.body.amountCents,
    })

    return res.status(500).json({
      success: false,
      message: 'Error interno del servidor',
    })
  }
}

/**
 * POST /api/v1/mobile/venues/:venueId/terminals/:terminalId/print-receipt
 *
 * Send a receipt snapshot to a TPV terminal for physical printing.
 */
export async function printReceiptOnTerminal(req: Request, res: Response) {
  try {
    const { venueId, terminalId } = req.params
    const { requestId, receipt } = req.body
    const userId = (req as any).authContext?.userId

    if (!terminalId || !receipt) {
      return res.status(400).json({
        success: false,
        message: 'terminalId y receipt son requeridos',
      })
    }

    const terminal = terminalRegistry.getTerminal(terminalId)
    if (terminal && terminal.venueId !== venueId) {
      return res.status(403).json({
        success: false,
        message: 'La terminal no pertenece a este establecimiento',
      })
    }

    const result = await terminalPaymentService.printReceiptOnTerminal({
      terminalId,
      venueId,
      requestedBy: userId,
      requestId,
      receipt,
    })

    const httpStatus = result.status === 'success' ? 200 : result.status === 'timeout' ? 504 : 422
    return res.status(httpStatus).json({
      success: result.status === 'success',
      ...result,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error desconocido'

    if (message.includes('no está conectada')) {
      return res.status(404).json({ success: false, message })
    }

    if (message.includes('no tiene conexión de socket')) {
      return res.status(422).json({ success: false, message })
    }

    logger.error('Error in printReceiptOnTerminal', {
      error: message,
      stack: error instanceof Error ? error.stack : undefined,
      venueId: req.params.venueId,
      terminalId: req.params.terminalId,
    })

    return res.status(500).json({
      success: false,
      message: 'Error interno del servidor',
    })
  }
}

/**
 * POST /api/v1/mobile/venues/:venueId/terminals/:terminalId/refund-request
 *
 * Abrir en una terminal la devolución de un cobro con tarjeta.
 *
 * La respuesta contesta "¿se abrió la pantalla en la terminal?", NO "¿se
 * devolvió el dinero?": eso lo completa una persona en el aparato y se
 * registra por la ruta de reembolsos de la TPV.
 */
export async function requestRefundOnTerminal(req: Request, res: Response) {
  try {
    const { venueId, terminalId } = req.params
    const { paymentId, requestId, reason } = req.body
    const userId = (req as any).authContext?.userId

    if (!terminalId || !paymentId) {
      return res.status(400).json({
        success: false,
        message: 'terminalId y paymentId son requeridos',
      })
    }

    const result = await terminalPaymentService.requestRefundOnTerminal({
      terminalId,
      venueId,
      paymentId,
      requestedBy: userId,
      requestId,
      reason,
    })

    const httpStatus = result.status === 'opened' ? 200 : result.status === 'timeout' ? 504 : 422
    return res.status(httpStatus).json({
      success: result.status === 'opened',
      ...result,
    })
  } catch (error) {
    if (error instanceof TerminalBusyError) {
      return res.status(409).json({ success: false, message: error.message })
    }

    if (error instanceof BadRequestError) {
      return res.status(400).json({ success: false, message: error.message })
    }

    const message = error instanceof Error ? error.message : 'Error desconocido'

    if (message.includes('no está conectada')) {
      return res.status(404).json({ success: false, message })
    }

    if (message.includes('no tiene conexión de socket')) {
      return res.status(422).json({ success: false, message })
    }

    logger.error('Error in requestRefundOnTerminal', {
      error: message,
      stack: error instanceof Error ? error.stack : undefined,
      venueId: req.params.venueId,
      terminalId: req.params.terminalId,
    })

    return res.status(500).json({
      success: false,
      message: 'Error interno del servidor',
    })
  }
}

/**
 * POST /api/v1/mobile/venues/:venueId/terminal-payment/cancel
 *
 * Cancel a pending terminal payment and notify the terminal.
 * Includes requestId so TPV only cancels if it's still on THAT payment.
 */
/**
 * POST /venues/:venueId/terminal-payment/:requestId/release
 * A manager frees a terminal stuck by an UNKNOWN charge. Tenant-scoped by the venueId in the
 * URL (the service filters every query by it); money-safe (a card payment beats a release).
 */
export async function releaseTerminalPayment(req: Request, res: Response) {
  try {
    const { venueId, requestId } = req.params
    const reason =
      typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim().slice(0, 300) : 'Liberada desde el POS'
    const staffId: string | undefined = (req as any).authContext?.userId

    // La declaración viaja SÓLO si el cuerpo trae `statement`. Nunca se deriva de `reason` ni de `confirm`:
    // son campos libres que ya existían, y leerlos como una afirmación sobre dinero sería un contrato accidental.
    //
    // 🔴 P2 de la auditoría de Codex (18-sep): el `requestId` lo pone la RUTA, no el cuerpo. Antes se pasaba el
    // cuerpo intacto y el esquema lo exigía también dentro del JSON, así que el contrato documentado devolvía 409.
    // Y pedirlo dos veces abre la puerta a que se contradigan: la identidad de la solicitud es la de la URL,
    // que es la que ya gobierna el resto del endpoint.
    const declaration =
      req.body && typeof req.body === 'object' && 'statement' in req.body ? { ...req.body, requestId } : undefined

    const r = await terminalPaymentService.releaseUnknownRequest({
      requestId,
      venueId,
      actor: { staffId: staffId ?? null, source: 'MOBILE' },
      reason,
      declaration,
    })
    if (r.status === null) {
      return res.status(404).json({ success: false, message: 'No existe ese cobro en este establecimiento' })
    }
    return res.json({
      success: r.released,
      released: r.released,
      status: r.status,
      paymentId: r.paymentId ?? null,
      ...(r.resolution ? { resolution: r.resolution } : {}),
      message: r.released
        ? 'Terminal liberada. Ya puedes volver a mandarle cobros.'
        : r.status === 'COMPLETED'
          ? 'No se liberó: ese cobro SÍ se registró con tarjeta. Revisa que la cuenta no quede pagada dos veces.'
          : 'No se liberó: falta confirmar el resultado y que la terminal haya terminado. Consulta el cobro en la terminal.',
    })
  } catch (error) {
    // El error de la declaración YA trae un mensaje escrito para el cajero y su propio código HTTP: se respeta
    // tal cual en vez de taparlo con un 500 genérico. El POS pinta ESTE texto (por eso no lo hardcodea).
    const { UnchargedReconciliationError } = await import('../../services/tpv/uncharged-reconciliation.service')
    if (error instanceof UnchargedReconciliationError) {
      logger.warn('🧾 [TerminalPayment] declaración del operador rechazada', {
        code: error.code,
        requestId: req.params.requestId,
        venueId: req.params.venueId,
      })
      return res.status(error.statusCode).json({ success: false, released: false, code: error.code, message: error.message })
    }
    logger.error('Error in releaseTerminalPayment', { error: error instanceof Error ? error.message : 'Error desconocido' })
    return res.status(500).json({ success: false, message: 'Error interno del servidor' })
  }
}

/**
 * El texto por caso. Antes había DOS: «Cancelación enviada a la terminal» o «Terminal no conectada» — y el segundo
 * salía también cuando la fila ya tenía desenlace o ni existía, que es información falsa para el cajero.
 */
const MENSAJE_DE_CANCELACION: Record<CancelPaymentOutcome['cancelIntent'], (emitido: boolean) => string> = {
  RECORDED: emitido =>
    emitido
      ? 'Cancelación enviada a la terminal'
      : 'Cancelación guardada. La terminal no está conectada: confirma en el aparato antes de volver a cobrar.',
  ALREADY_FINAL: () => 'Ese cobro ya no se puede cancelar: consulta su resultado antes de volver a cobrar.',
  NOT_FOUND: () => 'No existe una solicitud de cobro con ese identificador en este establecimiento',
  MISSING_REQUEST_ID: () => 'Falta el identificador del cobro: sin él no se puede cancelar una venta en curso',
}

export async function cancelTerminalPayment(req: Request, res: Response) {
  try {
    const { venueId } = req.params
    const { terminalId, requestId, reason } = req.body

    if (!terminalId) {
      return res.status(400).json({
        success: false,
        message: 'terminalId is required',
      })
    }

    // Validate terminal belongs to this venue (registry normalizes AVQD- prefix).
    // Mirrors sendTerminalPayment: without it, any authenticated user could cancel
    // (and emit terminal:payment_cancel to) another venue's in-flight charge knowing
    // only a device serial.
    const terminal = terminalRegistry.getTerminal(terminalId)
    if (terminal && terminal.venueId !== venueId) {
      return res.status(403).json({
        success: false,
        message: 'La terminal no pertenece a este establecimiento',
      })
    }

    logger.info(`🚫 [API] Cancel terminal payment request`, {
      venueId,
      terminalId,
      requestId,
      reason,
    })

    const resultado = await terminalPaymentService.cancelPayment(terminalId, requestId, reason, venueId)

    // 🔴 ADITIVO (§8 C.2). `success` conserva EXACTAMENTE su significado de siempre —intención registrada Y emitida—
    // porque las apps publicadas lo leen; lo que se agrega es con qué distinguir los cuatro casos que ese booleano
    // mezclaba, y el estado durable del cobro (`payment`) releído tras el CAS. HTTP sigue siendo 200 en los cuatro.
    const success = resultado.cancelIntent === 'RECORDED' && resultado.cancelEmitted
    return res.json({
      success,
      message: MENSAJE_DE_CANCELACION[resultado.cancelIntent](resultado.cancelEmitted),
      ...(requestId ? { requestId } : {}),
      cancelIntent: resultado.cancelIntent,
      cancelEmitted: resultado.cancelEmitted,
      payment: resultado.payment,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error desconocido'
    logger.error('Error in cancelTerminalPayment', { error: message })

    // P2-14 (auditoría 11-sep): un error TIPADO salía como 500 genérico y el POS perdía `code`, `details` y el
    // estado HTTP — o sea, no podía distinguir «no se pudo cancelar porque X» de «el servidor se rompió».
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({
        success: false,
        message,
        ...(error.code ? { code: error.code } : {}),
        ...(error.details ? { details: error.details } : {}),
      })
    }

    return res.status(500).json({
      success: false,
      message: 'Error interno del servidor',
    })
  }
}

/**
 * GET /api/v1/mobile/venues/:venueId/terminal-payment/:requestId
 *
 * Status of a terminal payment request (recovery after a dropped long-poll /
 * timeout / network error). Trichotomy the POS relies on:
 *  - 200 + terminal status (COMPLETED/FAILED/CANCELLED/TIMED_OUT/UNKNOWN) → the
 *    real outcome; the client stops and acts on it (never blind-retries).
 *  - 200 + IN_PROGRESS → still running; client keeps polling.
 *  - 404 NOT_FOUND → not visible at this instant; an earlier POST can still be
 *    running. It is not permission to submit a new authorization.
 * Golden rule for clients: on timeout/NetworkError, GET status BEFORE retrying.
 */
export async function getTerminalPaymentStatus(req: Request, res: Response) {
  try {
    const { venueId, requestId } = req.params

    const status = await terminalPaymentService.getPaymentStatus(requestId, venueId)
    if (!status) {
      return res.status(404).json({
        success: false,
        status: 'NOT_FOUND',
        message: 'No existe una solicitud de cobro con ese identificador',
      })
    }

    const inProgress = ['PENDING', 'SENT', 'CANCEL_REQUESTED'].includes(status.status)
    return res.status(200).json({
      success: true,
      inProgress,
      ...status,
    })
  } catch (error) {
    logger.error('Error in getTerminalPaymentStatus', {
      error: error instanceof Error ? error.message : 'Error desconocido',
      venueId: req.params.venueId,
      requestId: req.params.requestId,
    })
    return res.status(500).json({
      success: false,
      message: 'Error interno del servidor',
    })
  }
}

/**
 * GET /api/v1/mobile/venues/:venueId/terminals/online
 *
 * Returns terminals currently connected via Socket.IO.
 */
export async function getOnlineTerminals(req: Request, res: Response) {
  try {
    const { venueId } = req.params

    // Only payment-capable terminals (have a live socket). A terminal known
    // only via HTTP heartbeat (socketId null) can't be charged, so hiding it
    // here prevents the POS from picking one that would 422.
    const terminals = terminalRegistry.getPaymentReadyTerminals(venueId)
    const busySet = await terminalPaymentService.getBusyTerminalIds(
      venueId,
      terminals.map(t => t.terminalId),
    )

    logger.info(`📡 [API] getOnlineTerminals for venue ${venueId}: found ${terminals.length}`, {
      venueId,
      terminalIds: terminals.map(t => t.terminalId),
    })

    return res.json({
      success: true,
      terminals: terminals.map(t => ({
        terminalId: t.terminalId,
        name: t.name || `Terminal ${t.terminalId}`,
        isOnline: true,
        hasSocket: t.socketId !== null,
        busy: busySet.has(t.terminalId),
        lastHeartbeat: t.lastHeartbeat.toISOString(),
        registeredAt: t.registeredAt.toISOString(),
      })),
    })
  } catch (error) {
    logger.error('Error in getOnlineTerminals', {
      error: error instanceof Error ? error.message : 'Error desconocido',
      venueId: req.params.venueId,
    })

    return res.status(500).json({
      success: false,
      message: 'Error interno del servidor',
    })
  }
}
