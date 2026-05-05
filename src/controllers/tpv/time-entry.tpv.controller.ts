import { Request, Response, NextFunction } from 'express'
import * as timeEntryService from '../../services/tpv/time-entry.tpv.service'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'

/**
 * Clock in a staff member
 */
export async function clockIn(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { staffId, pin, jobRole, checkInPhotoUrl, latitude, longitude, accuracy, facadePhotoUrl } = req.body

    logger.info(
      `Clock-in request: venueId=${venueId}, staffId=${staffId}, hasPhoto=${!!checkInPhotoUrl}, hasGps=${!!(latitude && longitude)}, hasFacade=${!!facadePhotoUrl}`,
    )

    const timeEntry = await timeEntryService.clockIn({
      venueId,
      staffId,
      pin,
      jobRole,
      checkInPhotoUrl,
      latitude,
      longitude,
      accuracy,
      facadePhotoUrl,
    })

    res.status(201).json({
      success: true,
      data: timeEntry,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Clock out a staff member
 */
export async function clockOut(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { staffId, pin, checkOutPhotoUrl, latitude, longitude, accuracy, depositPhotoUrl, skipReason } = req.body

    logger.info(
      `Clock-out request: venueId=${venueId}, staffId=${staffId}, hasPhoto=${!!checkOutPhotoUrl}, hasGps=${!!(latitude && longitude)}, hasDeposit=${!!depositPhotoUrl}, skipReason=${skipReason || 'none'}`,
    )

    // Audit log — see field report 2026-05-05. Captures whether the request
    // would be rejected by the upcoming hard validation (gated by versionCode
    // >= 58). Pure logging, no behavior change. Wrapped in try/catch so a slow
    // Terminal query never breaks the clock-out path.
    try {
      const authContext = (req as any).authContext as { terminalSerialNumber?: string } | undefined
      const terminalSerialNumber = authContext?.terminalSerialNumber ?? null
      const versionHeader = req.headers['x-app-version-code']
      const appVersionCode = versionHeader ? parseInt(versionHeader as string, 10) : null

      let requireClockOutPhoto: boolean | null = null
      let requireDepositPhoto: boolean | null = null
      if (terminalSerialNumber) {
        const terminal = await prisma.terminal.findFirst({
          where: { serialNumber: terminalSerialNumber },
          select: { config: true },
        })
        const settings = (terminal?.config as any)?.settings ?? {}
        requireClockOutPhoto = typeof settings.requireClockOutPhoto === 'boolean' ? settings.requireClockOutPhoto : null
        requireDepositPhoto = typeof settings.requireDepositPhoto === 'boolean' ? settings.requireDepositPhoto : null
      }

      const hasPhoto = !!checkOutPhotoUrl
      const hasGps = !!(latitude && longitude)
      const hasDeposit = !!depositPhotoUrl
      const hasSkipReason = !!skipReason
      // Same predicate the future hard validator will apply (see ADR-clockout-audit).
      const wouldReject = ((requireClockOutPhoto === true && !hasPhoto) || (requireDepositPhoto === true && !hasDeposit)) && !hasSkipReason

      logger.info('[clockout-audit]', {
        venueId,
        staffId,
        terminalSerialNumber,
        appVersionCode,
        hasPhoto,
        hasGps,
        hasDeposit,
        hasSkipReason,
        skipReason: skipReason || null,
        requireClockOutPhoto,
        requireDepositPhoto,
        wouldReject,
      })
    } catch (auditErr) {
      logger.warn('[clockout-audit] failed (non-blocking)', { error: (auditErr as Error)?.message })
    }

    const timeEntry = await timeEntryService.clockOut({
      venueId,
      staffId,
      pin,
      checkOutPhotoUrl,
      latitude,
      longitude,
      accuracy,
      depositPhotoUrl,
      skipReason,
    })

    res.status(200).json({
      success: true,
      data: timeEntry,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Start a break
 */
export async function startBreak(req: Request, res: Response, next: NextFunction) {
  try {
    const { timeEntryId } = req.params
    const { staffId } = req.body

    logger.info(`Start break request: timeEntryId=${timeEntryId}, staffId=${staffId}`)

    const timeEntry = await timeEntryService.startBreak({
      timeEntryId,
      staffId,
    })

    res.status(200).json({
      success: true,
      data: timeEntry,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * End a break
 */
export async function endBreak(req: Request, res: Response, next: NextFunction) {
  try {
    const { timeEntryId } = req.params
    const { staffId } = req.body

    logger.info(`End break request: timeEntryId=${timeEntryId}, staffId=${staffId}`)

    const timeEntry = await timeEntryService.endBreak({
      timeEntryId,
      staffId,
    })

    res.status(200).json({
      success: true,
      data: timeEntry,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get time entries with filtering
 */
export async function getTimeEntries(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params
    const { staffId, startDate, endDate, status, limit, offset } = req.query

    logger.info(`Get time entries request: venueId=${venueId}`)

    const result = await timeEntryService.getTimeEntries({
      venueId,
      staffId: staffId as string | undefined,
      startDate: startDate as string | undefined,
      endDate: endDate as string | undefined,
      status: status as any,
      limit: limit ? parseInt(limit as string) : undefined,
      offset: offset ? parseInt(offset as string) : undefined,
    })

    res.status(200).json({
      success: true,
      data: result.timeEntries,
      meta: {
        total: result.total,
        limit: result.limit,
        offset: result.offset,
      },
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get time summary for a staff member
 */
export async function getStaffTimeSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const { staffId } = req.params
    const { startDate, endDate } = req.query

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: 'startDate and endDate are required',
      })
    }

    logger.info(`Get staff time summary: staffId=${staffId}`)

    const summary = await timeEntryService.getStaffTimeSummary({
      staffId,
      startDate: startDate as string,
      endDate: endDate as string,
    })

    res.status(200).json({
      success: true,
      data: summary,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get currently clocked in staff for a venue
 */
export async function getCurrentlyClockedInStaff(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId } = req.params

    logger.info(`Get currently clocked in staff: venueId=${venueId}`)

    const activeStaff = await timeEntryService.getCurrentlyClockedInStaff(venueId)

    res.status(200).json({
      success: true,
      data: activeStaff,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * Get MY time entries (self-service)
 *
 * This endpoint allows any authenticated staff member to view ONLY their own time entries.
 * No special permissions required - staff can always see their own clock-in/out history.
 *
 * Used by TimeclockScreen to show the current clock-in status for the logged-in user.
 */
export async function getMyTimeEntries(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueId, staffId } = req.params
    const { startDate, endDate, limit } = req.query

    logger.info(`Get MY time entries (self-service): venueId=${venueId}, staffId=${staffId}`)

    // Staff can only see their OWN entries - staffId is required in path
    const result = await timeEntryService.getTimeEntries({
      venueId,
      staffId, // Required - only their own entries
      startDate: startDate as string | undefined,
      endDate: endDate as string | undefined,
      limit: limit ? parseInt(limit as string) : 10,
    })

    res.status(200).json({
      success: true,
      data: result.timeEntries,
      meta: {
        total: result.total,
        limit: result.limit,
        offset: result.offset,
      },
    })
  } catch (error) {
    next(error)
  }
}
