import { Request, Response, NextFunction } from 'express'
import {
  getAllTerminals as getAllTerminalsService,
  getTerminalById as getTerminalByIdService,
  createTerminal as createTerminalService,
  updateTerminal as updateTerminalService,
  generateActivationCodeForTerminal as generateActivationCodeService,
  deleteTerminal as deleteTerminalService,
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
    const { venueId, serialNumber, name, type, brand, model, assignedMerchantIds, generateActivationCode } = req.body

    // Get staffId from authenticated user (assuming req.user exists)
    const staffId = (req as any).user?.userId || 'superadmin'

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
    const { name, status, assignedMerchantIds, brand, model } = req.body

    const terminal = await updateTerminalService(terminalId, {
      name,
      status,
      assignedMerchantIds,
      brand,
      model,
    })

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

    await deleteTerminalService(terminalId)

    return res.status(200).json({
      message: 'Terminal deleted successfully',
    })
  } catch (error) {
    next(error)
  }
}
