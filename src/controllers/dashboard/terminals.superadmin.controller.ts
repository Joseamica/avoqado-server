import { tpvHealthService } from '../../services/tpv/tpv-health.service'
import { tpvCommandQueueService } from '../../services/tpv/command-queue.service'
import * as tpvSettings from '../../services/dashboard/tpv.dashboard.service'
import { logAction } from '../../services/dashboard/activity-log.service'
import { getTpvFleet as getTpvFleetService } from '../../services/dashboard/terminal-fleet.service'
import { Request, Response, NextFunction } from 'express'
import {
  getAllTerminals as getAllTerminalsService,
  getTerminalById as getTerminalByIdService,
  createTerminal as createTerminalService,
  updateTerminal as updateTerminalService,
  generateActivationCodeForTerminal as generateActivationCodeService,
  deleteTerminal as deleteTerminalService,
  sendRemoteActivation as sendRemoteActivationService,
} from '../../services/dashboard/terminals.superadmin.service'
import { terminalPaymentService } from '../../services/terminal-payment.service'

/**
 * A6 · S6: support frees the TERMINAL (not the sale) stuck BUSY by an UNKNOWN POS→terminal charge — what the watchdog does
 * on its own 20 min after the terminal is back, now. The source SUPERADMIN comes from this route (superadmin-only
 * middleware), never from the body; the staff from the authenticated token. The sale stays blocked until its outcome is known.
 *
 * @route POST /api/v1/dashboard/superadmin/terminals/payment-requests/:requestId/release
 * @body { venueId, reason }
 */
export const releaseTerminalPaymentRequest = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { requestId } = req.params
    const { venueId, reason } = req.body as { venueId: string; reason: string }
    const staffId: string | undefined = (req as any).authContext?.userId
    const r = await terminalPaymentService.releaseUnknownRequest({
      requestId,
      venueId,
      actor: { staffId: staffId ?? null, source: 'SUPERADMIN' },
      reason,
    })
    if (r.status === null) {
      return res.status(404).json({ success: false, message: 'No existe ese cobro en ese establecimiento' })
    }
    return res.json({
      success: r.released,
      released: r.released,
      status: r.status,
      paymentId: r.paymentId ?? null,
      message: mensajeDeSoporte(r),
    })
  } catch (error) {
    next(error)
  }
}

/** A6 · fix 1: el texto dice la verdad según el resultado — soltada, retenida por dinero, o una fila que soporte no suelta. */
function mensajeDeSoporte(r: { released: boolean; status: string | null; heldByMoneyEvidence?: boolean; slotHeld?: boolean }): string {
  if (r.released) return 'Terminal liberada. La venta sigue protegida: no se puede volver a cobrar hasta confirmar qué pasó con ese cobro.'
  if (r.status === 'COMPLETED') return 'No se liberó: existe un pago con tarjeta de ese cobro; se cerró como cobrado'
  if (r.heldByMoneyEvidence)
    return 'No se liberó: ese cobro dejó rastro de dinero (aviso del banco, un pago ligado o la terminal dice que cobró). Hay que conciliarlo primero.'
  if (r.status === 'UNKNOWN')
    return 'No se liberó: falta confirmar el resultado y que la terminal haya terminado. Consulta el cobro en la terminal.'
  // A4b: TIMED_OUT sin apartar = la ranura ya se soltó (el reloj, soporte o el cese acreditado), pero la VENTA sigue en duda.
  if (!r.slotHeld && r.status === 'TIMED_OUT')
    return 'No hace falta: este cobro ya no aparta la terminal (estado TIMED_OUT). Esa venta sigue pendiente de confirmar si se cobró: que el negocio lo confirme desde el POS, o concilia el cobro.'
  if (!r.slotHeld) return `No hace falta: este cobro ya no aparta la terminal (estado ${r.status}).`
  const queHacer =
    r.status === 'PENDING' || r.status === 'SENT' || r.status === 'CANCEL_REQUESTED'
      ? 'El cobro sigue en curso: espera a que la terminal conteste; si no contesta, en unos minutos queda sin resultado y entonces se puede soltar.'
      : r.status === 'TIMED_OUT'
        ? 'Hay que revisar y conciliar ese cobro antes de confirmar su resultado.'
        : 'Falta confirmar si se cobró: que el negocio declare desde el POS «Ya revisé la terminal: no se cobró», o concilia el cobro.'
  return `No se liberó: esta acción sólo suelta cobros sin resultado (UNKNOWN) y éste está en ${r.status}; la terminal sigue apartada. ${queHacer}`
}

/**
 * Get all terminals (cross-venue)
 *
 * @route GET /api/v1/dashboard/superadmin/terminals
 * @param req Request with optional query params: venueId, status, type
 * @param res Response with terminals array
 */
export const getAllTerminals = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, status, type } = req.query

    const terminals = await getAllTerminalsService({
      venueId: venueId as string | undefined,
      status: status as string | undefined,
      type: type as string | undefined,
    })

    return res.status(200).json({
      data: terminals,
      count: terminals.length,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get terminal by ID
 *
 * @route GET /api/v1/dashboard/superadmin/terminals/:terminalId
 * @param req Request with terminalId in params
 * @param res Response with terminal data
 */
export const getTerminalById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { terminalId } = req.params

    const terminal = await getTerminalByIdService(terminalId)

    return res.status(200).json({
      data: terminal,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Create terminal
 *
 * @route POST /api/v1/dashboard/superadmin/terminals
 * @param req Request with terminal data in body
 * @param res Response with created terminal
 */
export const createTerminal = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, serialNumber, name, type, brand, model, assignedMerchantIds, generateActivationCode, configOverrides } = req.body

    // Audit actor — `authContext` is set by authenticateToken middleware.
    const staffId = req.authContext!.userId

    const result = await createTerminalService({
      venueId,
      serialNumber,
      name,
      type,
      brand,
      model,
      assignedMerchantIds,
      generateActivationCode,
      staffId,
      configOverrides,
    })

    const message =
      result.autoAttachedMerchants.length > 0
        ? `Terminal created successfully. Auto-attached ${result.autoAttachedMerchants.length} merchant(s).`
        : 'Terminal created successfully'

    return res.status(201).json({
      data: result.terminal,
      activationCode: result.activationCode,
      autoAttachedMerchants: result.autoAttachedMerchants,
      message,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Update terminal
 *
 * @route PATCH /api/v1/dashboard/superadmin/terminals/:terminalId
 * @param req Request with terminalId in params and update data in body
 * @param res Response with updated terminal
 */
export const updateTerminal = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { terminalId } = req.params
    const { name, status, assignedMerchantIds, brand, model, forceUnassign, venueId } = req.body
    const authContext = (req as any).authContext

    // Task 12: when `brand` is changed and currently-assigned merchants would
    // become incompatible, the service throws `TerminalBrandChangeBlocked`
    // (HTTP 409, code `TERMINAL_BRAND_CHANGE_BLOCKED`) with the offending
    // merchants in `details.incompatibleMerchants`. The dashboard catches that
    // and prompts the operator, then re-issues with `forceUnassign: true`.
    // Task 54: `venueId` (optional) moves the terminal to another venue and
    // clears `assignedMerchantIds` atomically (cross-tenant safety).
    const terminal = await updateTerminalService(
      terminalId,
      {
        name,
        status,
        assignedMerchantIds,
        brand,
        model,
        forceUnassign,
        venueId,
      },
      {
        staffId: authContext?.userId,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      },
    )

    return res.status(200).json({
      data: terminal,
      message: 'Terminal updated successfully',
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Generate activation code for terminal
 *
 * @route POST /api/v1/dashboard/superadmin/terminals/:terminalId/generate-activation-code
 * @param req Request with terminalId in params
 * @param res Response with activation code data
 */
export const generateActivationCode = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { terminalId } = req.params

    // Get staffId from authenticated user
    const staffId = req.authContext!.userId

    const activationCodeData = await generateActivationCodeService(terminalId, staffId)

    return res.status(200).json({
      data: activationCodeData,
      message: 'Activation code generated successfully',
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Delete terminal
 *
 * @route DELETE /api/v1/dashboard/superadmin/terminals/:terminalId
 * @param req Request with terminalId in params
 * @param res Response with success message
 */
export const deleteTerminal = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { terminalId } = req.params

    const authContext = (req as any).authContext
    await deleteTerminalService(terminalId, {
      staffId: authContext?.userId,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    })

    return res.status(200).json({
      message: 'Terminal deleted successfully',
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Send remote activation command to a pre-registered terminal
 *
 * This allows SUPERADMIN to remotely activate a terminal that has been
 * pre-registered but not yet activated through the normal activation code flow.
 * The terminal must have sent at least one heartbeat (proof of physical device).
 *
 * @route POST /api/v1/dashboard/superadmin/terminals/:terminalId/remote-activate
 * @param req Request with terminalId in params
 * @param res Response with command queue result
 */
export const sendRemoteActivation = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { terminalId } = req.params

    // Get staffId from authenticated user (must be SUPERADMIN)
    const staffId = req.authContext!.userId

    const result = await sendRemoteActivationService(terminalId, staffId)

    return res.status(200).json({
      data: result,
      message: 'Remote activation command sent successfully',
    })
  } catch (error) {
    next(error)
  }
}

/** Canonical superadmin operations return the actual queue identity, never fake completion. */
export const sendCommand = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const terminal = await getTerminalByIdService(req.params.terminalId)
    const result = await tpvHealthService.sendCommand(terminal, {
      type: req.body.command,
      idempotencyKey: req.get('Idempotency-Key'),
      payload: req.body.payload,
      requestedBy: req.authContext!.userId,
    })
    await logAction({
      staffId: req.authContext!.userId,
      venueId: terminal.venueId,
      action: 'TERMINAL_COMMAND_QUEUED',
      entity: 'Terminal',
      entityId: terminal.id,
      data: { command: req.body.command, commandId: result.commandId },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    })
    res.json({ data: result })
  } catch (error) {
    next(error)
  }
}
export const commandHistory = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const terminal = await getTerminalByIdService(req.params.terminalId)
    const page = Number(req.query.page) || 1
    const result = await tpvCommandQueueService.getCommandHistory(terminal.id, terminal.venueId, { limit: 25, offset: (page - 1) * 25 })
    res.json({
      total: result.total,
      page,
      data: result.commands.map(command => ({
        id: command.id,
        commandType: command.commandType,
        status: command.status,
        createdAt: command.createdAt,
        expiresAt: command.expiresAt,
        resultMessage: command.resultMessage,
      })),
    })
  } catch (error) {
    next(error)
  }
}
export const getSettings = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const terminal = await getTerminalByIdService(req.params.terminalId)
    res.json({ data: await tpvSettings.getTpvSettings(terminal.id, { venueId: terminal.venueId }) })
  } catch (error) {
    next(error)
  }
}
export const saveSettings = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const terminal = await getTerminalByIdService(req.params.terminalId)
    res.json({
      data: await tpvSettings.updateTpvSettings(terminal.id, req.body, { venueId: terminal.venueId, staffId: req.authContext!.userId }),
    })
  } catch (error) {
    next(error)
  }
}
export const getTpvFleet = async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await getTpvFleetService(req.query as unknown as Parameters<typeof getTpvFleetService>[0]))
  } catch (error) {
    next(error)
  }
}
