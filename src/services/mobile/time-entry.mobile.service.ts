/**
 * Mobile Time Entry Service
 *
 * Time clock operations for mobile apps (iOS, Android).
 * PIN-based identification flow:
 * 1. User enters PIN
 * 2. PIN identifies staff and returns their current status
 * 3. User can then clock in/out/break based on status
 */

import prisma from '../../utils/prismaClient'
import { TimeEntryStatus } from '@prisma/client'
import { BadRequestError, UnauthorizedError } from '../../errors/AppError'
import logger from '../../config/logger'

// MARK: - Types

interface ClockInParams {
  venueId: string
  pin: string
  jobRole?: string
  checkInPhotoUrl?: string
  latitude?: number
  longitude?: number
  accuracy?: number
}

interface ClockOutParams {
  venueId: string
  pin: string
  checkOutPhotoUrl?: string
  latitude?: number
  longitude?: number
  accuracy?: number
}

// MARK: - Identify by PIN

/**
 * Identify staff by PIN and return their current time entry status
 * Used by time clock to show the correct screen (clock in vs clock out)
 */
export async function identifyByPin(venueId: string, pin: string) {
  logger.info(`📱 [TIME-ENTRY.MOBILE] Identify by PIN | venue=${venueId}`)

  // Find staff by PIN in this venue
  const staffVenue = await prisma.staffVenue.findFirst({
    where: {
      venueId,
      pin,
      active: true,
      staff: {
        active: true,
      },
    },
    include: {
      staff: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          photoUrl: true,
        },
      },
    },
  })

  if (!staffVenue) {
    throw new UnauthorizedError('PIN inválido')
  }

  // Find active time entry for this staff
  const activeEntry = await prisma.timeEntry.findFirst({
    where: {
      staffId: staffVenue.staffId,
      venueId,
      status: {
        in: [TimeEntryStatus.CLOCKED_IN, TimeEntryStatus.ON_BREAK],
      },
    },
    include: {
      breaks: {
        where: {
          endTime: null, // Active break
        },
        orderBy: {
          startTime: 'desc',
        },
        take: 1,
      },
    },
  })

  logger.info(
    `✅ [TIME-ENTRY.MOBILE] Identified: ${staffVenue.staff.firstName} ${staffVenue.staff.lastName} | hasActiveEntry=${!!activeEntry}`,
  )

  return {
    staff: {
      id: staffVenue.staffId,
      firstName: staffVenue.staff.firstName,
      lastName: staffVenue.staff.lastName,
      email: staffVenue.staff.email,
      photoUrl: staffVenue.staff.photoUrl,
      role: staffVenue.role,
    },
    currentEntry: activeEntry
      ? {
          id: activeEntry.id,
          status: activeEntry.status,
          clockInTime: activeEntry.clockInTime,
          jobRole: activeEntry.jobRole,
          isOnBreak: activeEntry.status === TimeEntryStatus.ON_BREAK,
          activeBreak: activeEntry.breaks[0] || null,
        }
      : null,
  }
}

// MARK: - Clock In

/**
 * Clock in a staff member (identified by PIN)
 */
export async function clockIn(params: ClockInParams) {
  const { venueId, pin, jobRole, checkInPhotoUrl, latitude, longitude, accuracy } = params

  logger.info(`📱 [TIME-ENTRY.MOBILE] Clock-in request | venue=${venueId}`)

  // Find staff by PIN
  const staffVenue = await prisma.staffVenue.findFirst({
    where: {
      venueId,
      pin,
      active: true,
      staff: { active: true },
    },
    include: {
      staff: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  })

  if (!staffVenue) {
    throw new UnauthorizedError('PIN inválido')
  }

  const staffId = staffVenue.staffId

  // Check if already clocked in
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
    throw new BadRequestError('Ya tienes entrada registrada. Primero marca la salida.')
  }

  // Create time entry
  const timeEntry = await prisma.timeEntry.create({
    data: {
      staffId,
      venueId,
      clockInTime: new Date(),
      jobRole,
      checkInPhotoUrl,
      clockInLatitude: latitude,
      clockInLongitude: longitude,
      clockInAccuracy: accuracy,
      status: TimeEntryStatus.CLOCKED_IN,
    },
    include: {
      staff: {
        select: {
          firstName: true,
          lastName: true,
        },
      },
    },
  })

  logger.info(
    `✅ [TIME-ENTRY.MOBILE] Clock-in success | staff=${staffVenue.staff.firstName} ${staffVenue.staff.lastName} | entryId=${timeEntry.id}`,
  )

  return timeEntry
}

// MARK: - Clock Out

/**
 * Clock out a staff member (identified by PIN)
 */
export async function clockOut(params: ClockOutParams) {
  const { venueId, pin, checkOutPhotoUrl, latitude, longitude, accuracy } = params

  logger.info(`📱 [TIME-ENTRY.MOBILE] Clock-out request | venue=${venueId}`)

  // Find staff by PIN
  const staffVenue = await prisma.staffVenue.findFirst({
    where: {
      venueId,
      pin,
      active: true,
      staff: { active: true },
    },
    include: {
      staff: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  })

  if (!staffVenue) {
    throw new UnauthorizedError('PIN inválido')
  }

  const staffId = staffVenue.staffId

  // Find active time entry
  const activeEntry = await prisma.timeEntry.findFirst({
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

  if (!activeEntry) {
    throw new BadRequestError('No tienes entrada registrada')
  }

  // End any active break
  if (activeEntry.status === TimeEntryStatus.ON_BREAK) {
    await prisma.timeEntryBreak.updateMany({
      where: {
        timeEntryId: activeEntry.id,
        endTime: null,
      },
      data: {
        endTime: new Date(),
      },
    })
  }

  // Calculate total break minutes
  const breaks = await prisma.timeEntryBreak.findMany({
    where: { timeEntryId: activeEntry.id },
  })

  const breakMinutes = breaks.reduce((total: number, brk: { startTime: Date; endTime: Date | null }) => {
    if (brk.endTime) {
      const minutes = (brk.endTime.getTime() - brk.startTime.getTime()) / (1000 * 60)
      return total + minutes
    }
    return total
  }, 0)

  // Calculate total hours
  const clockOutTime = new Date()
  const totalMinutes = (clockOutTime.getTime() - activeEntry.clockInTime.getTime()) / (1000 * 60)
  const workMinutes = totalMinutes - breakMinutes
  const totalHours = Number((workMinutes / 60).toFixed(2))

  // Update time entry
  const updatedEntry = await prisma.timeEntry.update({
    where: { id: activeEntry.id },
    data: {
      clockOutTime,
      status: TimeEntryStatus.CLOCKED_OUT,
      totalHours,
      breakMinutes: Math.round(breakMinutes),
      checkOutPhotoUrl,
      clockOutLatitude: latitude,
      clockOutLongitude: longitude,
      clockOutAccuracy: accuracy,
    },
    include: {
      staff: {
        select: {
          firstName: true,
          lastName: true,
        },
      },
    },
  })

  logger.info(
    `✅ [TIME-ENTRY.MOBILE] Clock-out success | staff=${staffVenue.staff.firstName} ${staffVenue.staff.lastName} | hours=${totalHours}`,
  )

  return updatedEntry
}

// MARK: - Breaks

/**
 * Start a break for a staff member (identified by PIN)
 */
export async function startBreak(venueId: string, pin: string, breakType?: string) {
  logger.info(`📱 [TIME-ENTRY.MOBILE] Start break request | venue=${venueId}`)

  // Find staff by PIN
  const staffVenue = await prisma.staffVenue.findFirst({
    where: {
      venueId,
      pin,
      active: true,
      staff: { active: true },
    },
  })

  if (!staffVenue) {
    throw new UnauthorizedError('PIN inválido')
  }

  // Find active time entry
  const activeEntry = await prisma.timeEntry.findFirst({
    where: {
      staffId: staffVenue.staffId,
      venueId,
      status: TimeEntryStatus.CLOCKED_IN,
    },
  })

  if (!activeEntry) {
    throw new BadRequestError('No tienes entrada registrada o ya estás en descanso')
  }

  // Create break and update entry status
  const [breakRecord] = await prisma.$transaction([
    prisma.timeEntryBreak.create({
      data: {
        timeEntryId: activeEntry.id,
        startTime: new Date(),
      },
    }),
    prisma.timeEntry.update({
      where: { id: activeEntry.id },
      data: { status: TimeEntryStatus.ON_BREAK },
    }),
  ])

  logger.info(`✅ [TIME-ENTRY.MOBILE] Break started | entryId=${activeEntry.id}`)

  return {
    ...activeEntry,
    status: TimeEntryStatus.ON_BREAK,
    activeBreak: breakRecord,
  }
}

/**
 * End a break for a staff member (identified by PIN)
 */
export async function endBreak(venueId: string, pin: string) {
  logger.info(`📱 [TIME-ENTRY.MOBILE] End break request | venue=${venueId}`)

  // Find staff by PIN
  const staffVenue = await prisma.staffVenue.findFirst({
    where: {
      venueId,
      pin,
      active: true,
      staff: { active: true },
    },
  })

  if (!staffVenue) {
    throw new UnauthorizedError('PIN inválido')
  }

  // Find entry on break
  const activeEntry = await prisma.timeEntry.findFirst({
    where: {
      staffId: staffVenue.staffId,
      venueId,
      status: TimeEntryStatus.ON_BREAK,
    },
  })

  if (!activeEntry) {
    throw new BadRequestError('No estás en descanso')
  }

  // End break and update entry status
  await prisma.$transaction([
    prisma.timeEntryBreak.updateMany({
      where: {
        timeEntryId: activeEntry.id,
        endTime: null,
      },
      data: {
        endTime: new Date(),
      },
    }),
    prisma.timeEntry.update({
      where: { id: activeEntry.id },
      data: { status: TimeEntryStatus.CLOCKED_IN },
    }),
  ])

  logger.info(`✅ [TIME-ENTRY.MOBILE] Break ended | entryId=${activeEntry.id}`)

  return {
    ...activeEntry,
    status: TimeEntryStatus.CLOCKED_IN,
  }
}
