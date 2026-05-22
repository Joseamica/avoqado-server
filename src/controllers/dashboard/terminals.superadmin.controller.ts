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
    const staffId = (req as any).authContext?.userId || (req as any).user?.userId || 'superadmin'

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
    const staffId = (req as any).user?.userId || 'superadmin'

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
    const staffId = (req as any).user?.userId || 'superadmin'

    const result = await sendRemoteActivationService(terminalId, staffId)

    return res.status(200).json({
      data: result,
      message: 'Remote activation command sent successfully',
    })
  } catch (error) {
    next(error)
  }
}
