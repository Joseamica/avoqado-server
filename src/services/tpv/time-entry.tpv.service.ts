import prisma from '../../utils/prismaClient'
import { TimeEntryStatus } from '@prisma/client'
import { BadRequestError, UnauthorizedError } from '../../errors/AppError'

interface ClockInParams {
  venueId: string
  staffId: string
  pin: string
  jobRole?: string
  checkInPhotoUrl?: string // Firebase Storage URL of check-in photo (anti-fraud)
}

interface ClockOutParams {
  venueId: string
  staffId: string
  pin: string
}

interface BreakParams {
  timeEntryId: string
  staffId: string
}

interface TimeEntriesQueryParams {
  venueId: string
  staffId?: string
  startDate?: string // ISO date string
  endDate?: string // ISO date string
  status?: TimeEntryStatus
  limit?: number
  offset?: number
}

interface TimeSummaryParams {
  staffId: string
  startDate: string // ISO date string
  endDate: string // ISO date string
}

/**
 * Verify staff PIN for clock-in/out operations
 */
async function verifyStaffPin(venueId: string, staffId: string, pin: string): Promise<boolean> {
  const staffVenue = await prisma.staffVenue.findFirst({
    where: {
      staffId,
      venueId,
      active: true,
      pin: pin,
    },
  })

  return !!staffVenue
}

/**
 * Calculate total hours and break minutes for a time entry
 */
function calculateHours(clockInTime: Date, clockOutTime: Date, breakMinutes: number): number {
  const totalMinutes = (clockOutTime.getTime() - clockInTime.getTime()) / (1000 * 60)
  const workMinutes = totalMinutes - breakMinutes
  return Number((workMinutes / 60).toFixed(2))
}

/**
 * Calculate total break minutes from break records
 */
function calculateTotalBreakMinutes(breaks: Array<{ startTime: Date; endTime: Date | null }>): number {
  return breaks.reduce((total, brk) => {
    if (brk.endTime) {
      const minutes = (brk.endTime.getTime() - brk.startTime.getTime()) / (1000 * 60)
      return total + minutes
    }
    return total
  }, 0)
}

/**
 * Clock in a staff member
 */
export async function clockIn(params: ClockInParams) {
  const { venueId, staffId, pin, jobRole, checkInPhotoUrl } = params

  // Verify PIN
  const isValidPin = await verifyStaffPin(venueId, staffId, pin)
  if (!isValidPin) {
    throw new UnauthorizedError('Invalid PIN for this venue')
  }

  // Check if staff member is already clocked in
  const existingEntry = await prisma.timeEntry.findFirst({
    where: {
      staffId,
      venueId,
      status: {
        in: [TimeEntryStatus.CLOCKED_IN, TimeEntryStatus.ON_BREAK],
      },
    },
  })

  if (existingEntry) {
    throw new BadRequestError('Staff member is already clocked in. Please clock out first.')
  }

  // Create new time entry
  const timeEntry = await prisma.timeEntry.create({
    data: {
      staffId,
      venueId,
      clockInTime: new Date(),
      jobRole,
      checkInPhotoUrl, // Store anti-fraud photo URL if provided
      status: TimeEntryStatus.CLOCKED_IN,
      breakMinutes: 0,
    },
    include: {
      staff: {
        select: {
          firstName: true,
          lastName: true,
          employeeCode: true,
        },
      },
      breaks: true,
    },
  })

  return timeEntry
}

/**
 * Clock out a staff member
 */
export async function clockOut(params: ClockOutParams) {
  const { venueId, staffId, pin } = params

  // Verify PIN
  const isValidPin = await verifyStaffPin(venueId, staffId, pin)
  if (!isValidPin) {
    throw new UnauthorizedError('Invalid PIN for this venue')
  }

  // Find active time entry
  const timeEntry = await prisma.timeEntry.findFirst({
    where: {
      staffId,
      venueId,
      status: {
        in: [TimeEntryStatus.CLOCKED_IN, TimeEntryStatus.ON_BREAK],
      },
    },
    include: {
      breaks: true,
    },
  })

  if (!timeEntry) {
    throw new BadRequestError('Staff member is not currently clocked in')
  }

  // End any active break
  const activeBreak = timeEntry.breaks.find(brk => brk.endTime === null)
  if (activeBreak) {
    await prisma.timeEntryBreak.update({
      where: { id: activeBreak.id },
      data: { endTime: new Date() },
    })
  }

  // Refresh breaks to get updated data
  const updatedBreaks = await prisma.timeEntryBreak.findMany({
    where: { timeEntryId: timeEntry.id },
  })

  const totalBreakMinutes = calculateTotalBreakMinutes(updatedBreaks)
  const clockOutTime = new Date()
  const totalHours = calculateHours(timeEntry.clockInTime, clockOutTime, totalBreakMinutes)

  // Update time entry
  const updatedTimeEntry = await prisma.timeEntry.update({
    where: { id: timeEntry.id },
    data: {
      clockOutTime,
      totalHours,
      breakMinutes: Math.round(totalBreakMinutes),
      status: TimeEntryStatus.CLOCKED_OUT,
    },
    include: {
      staff: {
        select: {
          firstName: true,
          lastName: true,
          employeeCode: true,
        },
      },
      breaks: true,
    },
  })

  return updatedTimeEntry
}

/**
 * Start a break
 */
export async function startBreak(params: BreakParams) {
  const { timeEntryId, staffId } = params

  // Find time entry and verify ownership
  const timeEntry = await prisma.timeEntry.findFirst({
    where: {
      id: timeEntryId,
      staffId,
      status: TimeEntryStatus.CLOCKED_IN,
    },
    include: {
      breaks: true,
    },
  })

  if (!timeEntry) {
    throw new BadRequestError('Time entry not found or not in valid state for break')
  }

  // Check if there's already an active break
  const activeBreak = timeEntry.breaks.find(brk => brk.endTime === null)
  if (activeBreak) {
    throw new BadRequestError('A break is already in progress')
  }

  // Create break and update time entry status
  const [_newBreak, updatedTimeEntry] = await prisma.$transaction([
    prisma.timeEntryBreak.create({
      data: {
        timeEntryId,
        startTime: new Date(),
      },
    }),
    prisma.timeEntry.update({
      where: { id: timeEntryId },
      data: { status: TimeEntryStatus.ON_BREAK },
      include: {
        staff: {
          select: {
            firstName: true,
            lastName: true,
            employeeCode: true,
          },
        },
        breaks: true,
      },
    }),
  ])

  return updatedTimeEntry
}

/**
 * End a break
 */
export async function endBreak(params: BreakParams) {
  const { timeEntryId, staffId } = params

  // Find time entry and verify ownership
  const timeEntry = await prisma.timeEntry.findFirst({
    where: {
      id: timeEntryId,
      staffId,
      status: TimeEntryStatus.ON_BREAK,
    },
    include: {
      breaks: true,
    },
  })

  if (!timeEntry) {
    throw new BadRequestError('Time entry not found or not on break')
  }

  // Find active break
  const activeBreak = timeEntry.breaks.find(brk => brk.endTime === null)
  if (!activeBreak) {
    throw new BadRequestError('No active break found')
  }

  // End break and update time entry status
  const [_updatedBreak, updatedTimeEntry] = await prisma.$transaction([
    prisma.timeEntryBreak.update({
      where: { id: activeBreak.id },
      data: { endTime: new Date() },
    }),
    prisma.timeEntry.update({
      where: { id: timeEntryId },
      data: { status: TimeEntryStatus.CLOCKED_IN },
      include: {
        staff: {
          select: {
            firstName: true,
            lastName: true,
            employeeCode: true,
          },
        },
        breaks: true,
      },
    }),
  ])

  return updatedTimeEntry
}

/**
 * Get time entries with filtering
 */
export async function getTimeEntries(params: TimeEntriesQueryParams) {
  const { venueId, staffId, startDate, endDate, status, limit = 50, offset = 0 } = params

  const where: any = { venueId }

  if (staffId) {
    where.staffId = staffId
  }

  if (status) {
    where.status = status
  }

  if (startDate || endDate) {
    where.clockInTime = {}
    if (startDate) {
      where.clockInTime.gte = new Date(startDate)
    }
    if (endDate) {
      where.clockInTime.lte = new Date(endDate)
    }
  }

  const [timeEntries, total] = await prisma.$transaction([
    prisma.timeEntry.findMany({
      where,
      include: {
        staff: {
          select: {
            firstName: true,
            lastName: true,
            employeeCode: true,
            photoUrl: true,
          },
        },
        breaks: {
          orderBy: { startTime: 'asc' },
        },
      },
      orderBy: { clockInTime: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.timeEntry.count({ where }),
  ])

  return {
    timeEntries,
    total,
    limit,
    offset,
  }
}

/**
 * Get time summary for a staff member
 */
export async function getStaffTimeSummary(params: TimeSummaryParams) {
  const { staffId, startDate, endDate } = params

  const timeEntries = await prisma.timeEntry.findMany({
    where: {
      staffId,
      clockInTime: {
        gte: new Date(startDate),
        lte: new Date(endDate),
      },
      status: TimeEntryStatus.CLOCKED_OUT, // Only count completed entries
    },
    include: {
      breaks: true,
    },
    orderBy: { clockInTime: 'desc' },
  })

  const totalHours = timeEntries.reduce((sum, entry) => {
    return sum + Number(entry.totalHours || 0)
  }, 0)

  const totalBreakMinutes = timeEntries.reduce((sum, entry) => {
    return sum + (entry.breakMinutes || 0)
  }, 0)

  const totalShifts = timeEntries.length

  const averageHoursPerShift = totalShifts > 0 ? totalHours / totalShifts : 0

  return {
    staffId,
    startDate,
    endDate,
    totalHours: Number(totalHours.toFixed(2)),
    totalBreakMinutes,
    totalShifts,
    averageHoursPerShift: Number(averageHoursPerShift.toFixed(2)),
    timeEntries,
  }
}

/**
 * Get currently clocked in staff for a venue
 */
export async function getCurrentlyClockedInStaff(venueId: string) {
  const activeEntries = await prisma.timeEntry.findMany({
    where: {
      venueId,
      status: {
        in: [TimeEntryStatus.CLOCKED_IN, TimeEntryStatus.ON_BREAK],
      },
    },
    include: {
      staff: {
        select: {
          firstName: true,
          lastName: true,
          employeeCode: true,
          photoUrl: true,
        },
      },
      breaks: {
        where: { endTime: null },
      },
    },
    orderBy: { clockInTime: 'desc' },
  })

  return activeEntries
}
