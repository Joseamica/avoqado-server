import { Request, Response, NextFunction } from 'express'
import { migratePreflight, migrateExecute, migrateStatus, migrateCancel } from '@/services/dashboard/terminal-migration.service'

/**
 * Preflight a terminal venue migration
 *
 * Runs the read-only safety checks (blockers + warnings) without mutating
 * anything. The dashboard calls this before showing the confirm dialog.
 *
 * @route POST /api/v1/dashboard/superadmin/terminals/:terminalId/migrate-preflight
 * @param req Request with terminalId in params and toVenueId in body
 * @param res Response with the PreflightResult
 */
export const preflight = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { terminalId } = req.params
    const { toVenueId } = req.body
    const data = await migratePreflight(terminalId, toVenueId)
    return res.status(200).json({ data, message: 'Preflight complete' })
  } catch (error) {
    next(error)
  }
}

/**
 * Execute a terminal venue migration
 *
 * Re-parents the terminal to the destination venue and queues the
 * FACTORY_RESET. `authContext` (set by authenticateToken middleware) exposes
 * ONLY { userId, orgId, venueId, role } — there is no `name`.
 *
 * @route POST /api/v1/dashboard/superadmin/terminals/:terminalId/migrate-execute
 * @param req Request with terminalId in params and toVenueId in body
 * @param res Response with the MigrateExecuteResult
 */
export const execute = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { terminalId } = req.params
    const { toVenueId, assignedMerchantIds } = req.body
    const authContext = (req as any).authContext
    const data = await migrateExecute(
      terminalId,
      toVenueId,
      {
        staffId: authContext?.userId,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      },
      assignedMerchantIds,
    )
    return res.status(200).json({ data, message: 'Migration started' })
  } catch (error) {
    next(error)
  }
}

/**
 * Poll the status of an in-flight terminal migration
 *
 * @route GET /api/v1/dashboard/superadmin/terminals/:terminalId/migrate-status
 * @param req Request with terminalId in params and commandId in query
 * @param res Response with the MigrateStatusResult
 */
export const status = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { terminalId } = req.params
    const { commandId } = req.query as { commandId: string }
    const data = await migrateStatus(terminalId, commandId)
    return res.status(200).json({ data, message: 'OK' })
  } catch (error) {
    next(error)
  }
}

/**
 * Cancel an in-flight terminal migration
 *
 * Undoes the move while the device hasn't wiped yet: cancels the queued
 * FACTORY_RESET (only if still PENDING/QUEUED) and reverts the terminal to its
 * origin venue + merchant assignments. `authContext` exposes only
 * { userId, orgId, venueId, role } — there is no `name`.
 *
 * @route POST /api/v1/dashboard/superadmin/terminals/:terminalId/migrate-cancel
 * @param req Request with terminalId in params
 * @param res Response with the MigrateCancelResult
 */
export const cancel = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { terminalId } = req.params
    const authContext = (req as any).authContext
    const data = await migrateCancel(terminalId, {
      staffId: authContext?.userId,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    })
    return res.status(200).json({ data, message: 'Migration cancelled' })
  } catch (error) {
    next(error)
  }
}
