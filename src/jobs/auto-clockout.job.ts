// src/jobs/auto-clockout.job.ts

import { CronJob } from 'cron'
import prisma from '../utils/prismaClient'
import logger from '../config/logger'
import { TimeEntryStatus } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'

/**
 * Auto Clock-Out Job
 *
 * Runs every 15 minutes to automatically clock out employees based on venue settings:
 * 1. Fixed time clock-out - Close all open entries at a specific time (e.g., 3:00 AM)
 * 2. Max duration clock-out - Close entries that exceed X hours
 *
 * This is a Square-style HR automation feature for preventing forgotten clock-outs.
 */
export class AutoClockOutJob {
  private job: CronJob | null = null

  constructor() {
    // Run every 15 minutes
    // Cron pattern: minute hour day month dayOfWeek
    // '*/15 * * * *' = Every 15 minutes
    this.job = new CronJob(
      '*/15 * * * *',
      this.processAutoClockOuts.bind(this),
      null, // onComplete callback
      false, // Don't start immediately
      'America/Mexico_City', // Default timezone (overridden per-venue)
    )
  }

  /**
   * Start the auto clock-out job
   */
  start(): void {
    if (this.job) {
      this.job.start()
      logger.info('Auto Clock-Out Job started - running every 15 minutes')
    }
  }

  /**
   * Stop the job
   */
  stop(): void {
    if (this.job) {
      this.job.stop()
      logger.info('Auto Clock-Out Job stopped')
    }
  }

  /**
   * Run manually (useful for testing)
   */
  async runNow(): Promise<void> {
    await this.processAutoClockOuts()
  }

  /**
   * Main processing function - checks all venues and auto-clocks out where needed
   */
  private async processAutoClockOuts(): Promise<void> {
    try {
      logger.debug('Running auto clock-out check...')

      const stats = {
        fixedTimeClockOuts: 0,
        maxDurationClockOuts: 0,
        errors: 0,
      }

      // Process fixed-time auto clock-outs
      const fixedTimeResult = await this.processFixedTimeClockOuts()
      stats.fixedTimeClockOuts = fixedTimeResult.count
      stats.errors += fixedTimeResult.errors

      // Process max-duration auto clock-outs
      const maxDurationResult = await this.processMaxDurationClockOuts()
      stats.maxDurationClockOuts = maxDurationResult.count
      stats.errors += maxDurationResult.errors

      const totalClockOuts = stats.fixedTimeClockOuts + stats.maxDurationClockOuts

      if (totalClockOuts > 0) {
        logger.info(`Auto clock-out completed: ${totalClockOuts} entries closed`, {
          fixedTime: stats.fixedTimeClockOuts,
          maxDuration: stats.maxDurationClockOuts,
          errors: stats.errors,
        })
      } else {
        logger.debug('Auto clock-out check completed - no entries to close')
      }
    } catch (error) {
      logger.error('Error during auto clock-out processing:', error)
    }
  }

  /**
   * Process venues with fixed-time auto clock-out enabled
   * Closes all open entries at the configured time
   */
  private async processFixedTimeClockOuts(): Promise<{ count: number; errors: number }> {
    let count = 0
    let errors = 0

    try {
      // Get all venues with fixed-time auto clock-out enabled
      const venuesWithFixedTime = await prisma.venueSettings.findMany({
        where: {
          autoClockOutEnabled: true,
          autoClockOutTime: { not: null },
        },
        include: {
          venue: {
            select: {
              id: true,
              name: true,
              timezone: true,
            },
          },
        },
      })

      for (const settings of venuesWithFixedTime) {
        try {
          const timezone = settings.venue.timezone || 'America/Mexico_City'
          const configuredTime = settings.autoClockOutTime!

          // Check if we're within the 15-minute window of the configured time
          if (!this.isWithinClockOutWindow(configuredTime, timezone)) {
            continue
          }

          // Find all open entries for this venue
          const openEntries = await prisma.timeEntry.findMany({
            where: {
              venueId: settings.venue.id,
              status: {
                in: [TimeEntryStatus.CLOCKED_IN, TimeEntryStatus.ON_BREAK],
              },
            },
            include: {
              staff: {
                select: { firstName: true, lastName: true },
              },
              breaks: true,
            },
          })

          for (const entry of openEntries) {
            try {
              await this.clockOutEntry(entry, `Hora de cierre programada (${configuredTime})`, timezone)
              count++

              logger.info(`Auto clock-out (fixed time): ${entry.staff.firstName} ${entry.staff.lastName}`, {
                entryId: entry.id,
                venueId: settings.venue.id,
                venueName: settings.venue.name,
                configuredTime,
              })
            } catch (entryError) {
              errors++
              logger.error(`Failed to auto clock-out entry ${entry.id}:`, entryError)
            }
          }
        } catch (venueError) {
          errors++
          logger.error(`Failed to process venue ${settings.venue.id}:`, venueError)
        }
      }
    } catch (error) {
      errors++
      logger.error('Error in processFixedTimeClockOuts:', error)
    }

    return { count, errors }
  }

  /**
   * Process venues with max-duration auto clock-out enabled
   * Closes entries that have exceeded the maximum shift duration
   */
  private async processMaxDurationClockOuts(): Promise<{ count: number; errors: number }> {
    let count = 0
    let errors = 0

    try {
      // Get all venues with max-duration auto clock-out enabled
      const venuesWithMaxDuration = await prisma.venueSettings.findMany({
        where: {
          maxShiftDurationEnabled: true,
          maxShiftDurationHours: { gt: 0 },
        },
        include: {
          venue: {
            select: {
              id: true,
              name: true,
              timezone: true,
            },
          },
        },
      })

      for (const settings of venuesWithMaxDuration) {
        try {
          const timezone = settings.venue.timezone || 'America/Mexico_City'
          const maxHours = settings.maxShiftDurationHours

          // Calculate the cutoff time (now - maxHours)
          const cutoffTime = new Date()
          cutoffTime.setHours(cutoffTime.getHours() - maxHours)

          // Find entries that started before the cutoff time
          const overdueEntries = await prisma.timeEntry.findMany({
            where: {
              venueId: settings.venue.id,
              status: {
                in: [TimeEntryStatus.CLOCKED_IN, TimeEntryStatus.ON_BREAK],
              },
              clockInTime: {
                lt: cutoffTime,
              },
            },
            include: {
              staff: {
                select: { firstName: true, lastName: true },
              },
              breaks: true,
            },
          })

          for (const entry of overdueEntries) {
            try {
              await this.clockOutEntry(entry, `Turno excedió ${maxHours} horas`, timezone)
              count++

              logger.info(`Auto clock-out (max duration): ${entry.staff.firstName} ${entry.staff.lastName}`, {
                entryId: entry.id,
                venueId: settings.venue.id,
                venueName: settings.venue.name,
                maxHours,
                clockInTime: entry.clockInTime,
              })
            } catch (entryError) {
              errors++
              logger.error(`Failed to auto clock-out entry ${entry.id}:`, entryError)
            }
          }
        } catch (venueError) {
          errors++
          logger.error(`Failed to process venue ${settings.venue.id}:`, venueError)
        }
      }
    } catch (error) {
      errors++
      logger.error('Error in processMaxDurationClockOuts:', error)
    }

    return { count, errors }
  }

  /**
   * Check if current time is within the 15-minute window of the configured clock-out time
   */
  private isWithinClockOutWindow(configuredTime: string, timezone: string): boolean {
    try {
      // Parse the configured time (HH:mm format)
      const [hours, minutes] = configuredTime.split(':').map(Number)

      // Get current time in the venue's timezone
      const now = new Date()
      const venueTime = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
      }).format(now)

      const [currentHours, currentMinutes] = venueTime.split(':').map(Number)

      // Convert to minutes since midnight for easier comparison
      const configuredMinutes = hours * 60 + minutes
      const currentTotalMinutes = currentHours * 60 + currentMinutes

      // Check if we're within a 15-minute window (0 to +14 minutes after configured time)
      // This ensures we only trigger once per 15-minute cron cycle
      const diff = currentTotalMinutes - configuredMinutes

      // Handle midnight wraparound (e.g., configured time is 23:55, current is 00:05)
      const normalizedDiff = diff < -720 ? diff + 1440 : diff > 720 ? diff - 1440 : diff

      return normalizedDiff >= 0 && normalizedDiff < 15
    } catch (error) {
      logger.error(`Error parsing clock-out time: ${configuredTime}`, error)
      return false
    }
  }

  /**
   * Clock out a time entry and calculate hours worked
   */
  private async clockOutEntry(
    entry: {
      id: string
      clockInTime: Date
      breaks: { id: string; startTime: Date; endTime: Date | null }[]
    },
    reason: string,
    _timezone?: string, // Reserved for future timezone-aware calculations
  ): Promise<void> {
    const now = new Date()

    // Calculate break minutes (only completed breaks)
    const breakMinutes = entry.breaks.reduce((total, b) => {
      if (b.endTime) {
        const breakDuration = (b.endTime.getTime() - b.startTime.getTime()) / (1000 * 60)
        return total + breakDuration
      }
      return total
    }, 0)

    // Close any open breaks first
    const openBreak = entry.breaks.find(b => !b.endTime)
    if (openBreak) {
      await prisma.timeEntryBreak.update({
        where: { id: openBreak.id },
        data: { endTime: now },
      })
    }

    // Calculate total hours worked (clock out - clock in - breaks)
    const totalMinutes = (now.getTime() - entry.clockInTime.getTime()) / (1000 * 60) - breakMinutes
    const totalHours = new Decimal(Math.max(0, totalMinutes / 60)).toDecimalPlaces(2)

    // Update the time entry
    await prisma.timeEntry.update({
      where: { id: entry.id },
      data: {
        clockOutTime: now,
        status: TimeEntryStatus.CLOCKED_OUT,
        totalHours,
        breakMinutes: Math.round(breakMinutes),
        autoClockOut: true,
        autoClockOutNote: `[Sistema] Salida automática: ${reason}`,
      },
    })
  }

  /**
   * Get job status information
   */
  getJobStatus(): {
    isRunning: boolean
    cronPattern: string
    timezone: string
  } {
    return {
      isRunning: !!this.job,
      cronPattern: '*/15 * * * *',
      timezone: 'America/Mexico_City',
    }
  }
}

// Export singleton instance
export const autoClockOutJob = new AutoClockOutJob()
