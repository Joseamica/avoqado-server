import { Request, Response, NextFunction } from 'express'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { BadRequestError, NotFoundError } from '../../errors/AppError'

/**
 * Terminal Controller
 *
 * REST API endpoints for managing terminal configurations and merchant assignments.
 * All endpoints require SUPERADMIN role (enforced by parent router middleware).
 */

/**
 * POST /api/v1/superadmin/terminals/:terminalId/merchants
 * Assign merchant accounts to a terminal for multi-merchant support
 *
 * **Business Use Case:**
 * Allows superadmin to configure which merchant accounts a physical terminal can process payments for.
 * Example: Restaurant terminal can process payments to "Main Account" or "Ghost Kitchen Account"
 *
 * **Request Body:**
 * ```json
 * {
 *   "merchantAccountIds": ["ma_xxxxx", "ma_yyyyy"]
 * }
 * ```
 *
 * **Response:**
 * ```json
 * {
 *   "success": true,
 *   "data": {
 *     "id": "term_xxxxx",
 *     "serialNumber": "2841548417",
 *     "assignedMerchantIds": ["ma_xxxxx", "ma_yyyyy"],
 *     "merchantAccounts": [...]
 *   }
 * }
 * ```
 *
 * **Validation:**
 * - Terminal must exist
 * - All merchant account IDs must be valid and active
 * - Merchant accounts must belong to Blumon provider (for now)
 *
 * @param req.params.terminalId - Terminal ID (e.g., "term_xxxxx")
 * @param req.body.merchantAccountIds - Array of merchant account IDs
 */
export async function assignMerchantsToTerminal(req: Request, res: Response, next: NextFunction) {
  try {
    const { terminalId } = req.params
    const { merchantAccountIds } = req.body

    logger.info('[Terminal Assignment] Starting merchant assignment', {
      terminalId,
      merchantAccountIds,
      requestedBy: (req as any).user?.uid,
    })

    // Validate required fields
    if (!merchantAccountIds || !Array.isArray(merchantAccountIds)) {
      throw new BadRequestError('merchantAccountIds must be an array')
    }

    if (merchantAccountIds.length === 0) {
      throw new BadRequestError('At least one merchant account ID is required')
    }

    // Step 1: Verify terminal exists
    const terminal = await prisma.terminal.findUnique({
      where: { id: terminalId },
      include: {
        venue: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    })

    if (!terminal) {
      throw new NotFoundError(`Terminal not found: ${terminalId}`)
    }

    logger.debug('[Terminal Assignment] Terminal found', {
      terminalId: terminal.id,
      serialNumber: terminal.serialNumber,
      venueId: terminal.venueId,
    })

    // Step 2: Verify all merchant accounts exist and are active
    const merchantAccounts = await prisma.merchantAccount.findMany({
      where: {
        id: { in: merchantAccountIds },
      },
      select: {
        id: true,
        displayName: true,
        active: true,
        providerId: true,
        blumonSerialNumber: true,
        blumonPosId: true,
        blumonEnvironment: true,
      },
    })

    // Check if all requested merchant accounts were found
    if (merchantAccounts.length !== merchantAccountIds.length) {
      const foundIds = merchantAccounts.map((ma: any) => ma.id)
      const missingIds = merchantAccountIds.filter(id => !foundIds.includes(id))
      throw new BadRequestError(`Merchant accounts not found: ${missingIds.join(', ')}`)
    }

    // Check if all merchant accounts are active
    const inactiveAccounts = merchantAccounts.filter((ma: any) => !ma.active)
    if (inactiveAccounts.length > 0) {
      const inactiveNames = inactiveAccounts.map((ma: any) => ma.displayName).join(', ')
      throw new BadRequestError(`Cannot assign inactive merchant accounts: ${inactiveNames}`)
    }

    // Check if all merchant accounts belong to Blumon (for now)
    const nonBlumonAccounts = merchantAccounts.filter((ma: any) => ma.providerId !== 'BLUMON')
    if (nonBlumonAccounts.length > 0) {
      const nonBlumonNames = nonBlumonAccounts.map((ma: any) => ma.displayName).join(', ')
      throw new BadRequestError(`Currently, only Blumon merchant accounts are supported. Invalid accounts: ${nonBlumonNames}`)
    }

    logger.debug('[Terminal Assignment] All merchant accounts validated', {
      count: merchantAccounts.length,
      accounts: merchantAccounts.map((ma: any) => ({
        id: ma.id,
        displayName: ma.displayName,
        blumonSerialNumber: ma.blumonSerialNumber,
      })),
    })

    // Step 3: Update terminal with assigned merchant IDs
    const updatedTerminal = await prisma.terminal.update({
      where: { id: terminalId },
      data: {
        assignedMerchantIds: merchantAccountIds,
        updatedAt: new Date(),
      },
      include: {
        venue: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    })

    logger.info('[Terminal Assignment] Successfully assigned merchants to terminal', {
      terminalId: updatedTerminal.id,
      serialNumber: updatedTerminal.serialNumber,
      assignedCount: merchantAccountIds.length,
    })

    res.status(200).json({
      success: true,
      data: {
        terminal: {
          id: updatedTerminal.id,
          serialNumber: updatedTerminal.serialNumber,
          name: updatedTerminal.name,
          type: updatedTerminal.type,
          venue: updatedTerminal.venue,
          assignedMerchantIds: updatedTerminal.assignedMerchantIds,
        },
        merchantAccounts: merchantAccounts.map((ma: any) => ({
          id: ma.id,
          displayName: ma.displayName,
          blumonSerialNumber: ma.blumonSerialNumber,
          blumonPosId: ma.blumonPosId,
          blumonEnvironment: ma.blumonEnvironment,
        })),
      },
      message: `Successfully assigned ${merchantAccountIds.length} merchant account(s) to terminal`,
    })
  } catch (error) {
    next(error)
  }
}
