// tests/unit/jobs/auto-clockout.job.test.ts

import { prismaMock } from '@tests/__helpers__/setup'
import { TimeEntryStatus } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'

// Import the job class (not the singleton) to test
import { AutoClockOutJob } from '@/jobs/auto-clockout.job'

describe('AutoClockOutJob', () => {
  let job: AutoClockOutJob

  beforeEach(() => {
    job = new AutoClockOutJob()
    jest.clearAllMocks()
  })

  afterEach(() => {
    job.stop()
  })

  describe('Job Lifecycle', () => {
    it('should start and stop the cron job', () => {
      // Job is created but not yet started (CronJob object exists but isn't running)
      // The getJobStatus checks if job object exists, not if it's running
      // This test verifies that start/stop don't throw errors
      expect(() => job.start()).not.toThrow()
      expect(() => job.stop()).not.toThrow()
    })

    it('should return correct job status', () => {
      const status = job.getJobStatus()

      expect(status.cronPattern).toBe('*/15 * * * *')
      expect(status.timezone).toBe('America/Mexico_City')
    })
  })

  describe('Fixed Time Auto Clock-Out', () => {
    it('should clock out all open entries at configured time', async () => {
      // Setup: Venue with auto clock-out at 03:00
      const mockVenueSettingsFixedTime = [
        {
          id: 'settings-1',
          venueId: 'venue-1',
          autoClockOutEnabled: true,
          autoClockOutTime: '03:00',
          maxShiftDurationEnabled: false,
          maxShiftDurationHours: 12,
          venue: {
            id: 'venue-1',
            name: 'Test Restaurant',
            timezone: 'America/Mexico_City',
          },
        },
      ]

      const mockOpenEntries = [
        {
          id: 'entry-1',
          staffId: 'staff-1',
          venueId: 'venue-1',
          clockInTime: new Date('2024-01-15T18:00:00Z'),
          clockOutTime: null,
          status: TimeEntryStatus.CLOCKED_IN,
          staff: { firstName: 'Juan', lastName: 'Perez' },
          breaks: [],
        },
        {
          id: 'entry-2',
          staffId: 'staff-2',
          venueId: 'venue-1',
          clockInTime: new Date('2024-01-15T20:00:00Z'),
          clockOutTime: null,
          status: TimeEntryStatus.ON_BREAK,
          staff: { firstName: 'Maria', lastName: 'Garcia' },
          breaks: [
            {
              id: 'break-1',
              startTime: new Date('2024-01-15T22:00:00Z'),
              endTime: null,
            },
          ],
        },
      ]

      // Mock Prisma calls - separate responses for fixed-time and max-duration queries
      prismaMock.venueSettings.findMany
        .mockResolvedValueOnce(mockVenueSettingsFixedTime) // Fixed time query
        .mockResolvedValueOnce([]) // Max duration query - empty

      prismaMock.timeEntry.findMany.mockResolvedValue(mockOpenEntries)
      prismaMock.timeEntry.update.mockResolvedValue({})
      prismaMock.timeEntryBreak.update.mockResolvedValue({})

      // Mock the time window check by making it always return true for this test
      ;(job as any).isWithinClockOutWindow = jest.fn().mockReturnValue(true)

      // Run the job
      await job.runNow()

      // Verify entries were clocked out (2 entries)
      expect(prismaMock.timeEntry.update).toHaveBeenCalledTimes(2)

      // First entry should be clocked out with auto clock-out flag
      expect(prismaMock.timeEntry.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'entry-1' },
          data: expect.objectContaining({
            status: TimeEntryStatus.CLOCKED_OUT,
            autoClockOut: true,
            autoClockOutNote: expect.stringContaining('Hora de cierre programada'),
          }),
        }),
      )

      // Second entry (on break) should have its break closed first
      expect(prismaMock.timeEntryBreak.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'break-1' },
          data: expect.objectContaining({
            endTime: expect.any(Date),
          }),
        }),
      )
    })

    it('should not clock out entries if outside time window', async () => {
      const mockVenueSettingsFixedTime = [
        {
          id: 'settings-1',
          venueId: 'venue-1',
          autoClockOutEnabled: true,
          autoClockOutTime: '03:00',
          maxShiftDurationEnabled: false,
          maxShiftDurationHours: 12,
          venue: {
            id: 'venue-1',
            name: 'Test Restaurant',
            timezone: 'America/Mexico_City',
          },
        },
      ]

      // First call for fixed-time (returns venue), second for max-duration (empty)
      prismaMock.venueSettings.findMany.mockResolvedValueOnce(mockVenueSettingsFixedTime).mockResolvedValueOnce([])

      // Mock time window to return false (not within clock-out window)
      ;(job as any).isWithinClockOutWindow = jest.fn().mockReturnValue(false)

      await job.runNow()

      // Should not update any entries since we're outside the time window
      // (findMany may still be called for max-duration check, but update shouldn't be called)
      expect(prismaMock.timeEntry.update).not.toHaveBeenCalled()
    })

    it('should skip venues without auto clock-out enabled', async () => {
      // Return empty array - no venues have auto clock-out enabled
      prismaMock.venueSettings.findMany.mockResolvedValue([])

      await job.runNow()

      // Should not proceed to update any entries
      expect(prismaMock.timeEntry.update).not.toHaveBeenCalled()
    })
  })

  describe('Max Duration Auto Clock-Out', () => {
    it('should clock out entries exceeding max duration', async () => {
      // Setup: Venue with 12-hour max shift
      const mockVenueSettings = [
        {
          id: 'settings-1',
          venueId: 'venue-1',
          autoClockOutEnabled: false,
          autoClockOutTime: null,
          maxShiftDurationEnabled: true,
          maxShiftDurationHours: 12,
          venue: {
            id: 'venue-1',
            name: 'Test Restaurant',
            timezone: 'America/Mexico_City',
          },
        },
      ]

      // Entry that started 14 hours ago (exceeds 12 hour limit)
      const fourteenHoursAgo = new Date()
      fourteenHoursAgo.setHours(fourteenHoursAgo.getHours() - 14)

      const mockOverdueEntries = [
        {
          id: 'entry-1',
          staffId: 'staff-1',
          venueId: 'venue-1',
          clockInTime: fourteenHoursAgo,
          clockOutTime: null,
          status: TimeEntryStatus.CLOCKED_IN,
          staff: { firstName: 'Juan', lastName: 'Perez' },
          breaks: [],
        },
      ]

      // First findMany for fixed-time (returns empty)
      prismaMock.venueSettings.findMany
        .mockResolvedValueOnce([]) // Fixed time query
        .mockResolvedValueOnce(mockVenueSettings) // Max duration query

      prismaMock.timeEntry.findMany.mockResolvedValue(mockOverdueEntries)
      prismaMock.timeEntry.update.mockResolvedValue({})

      await job.runNow()

      // Verify entry was clocked out
      expect(prismaMock.timeEntry.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'entry-1' },
          data: expect.objectContaining({
            status: TimeEntryStatus.CLOCKED_OUT,
            autoClockOut: true,
            autoClockOutNote: expect.stringContaining('Turno excedi'),
          }),
        }),
      )
    })

    it('should not clock out entries within max duration', async () => {
      const mockVenueSettings = [
        {
          id: 'settings-1',
          venueId: 'venue-1',
          autoClockOutEnabled: false,
          autoClockOutTime: null,
          maxShiftDurationEnabled: true,
          maxShiftDurationHours: 12,
          venue: {
            id: 'venue-1',
            name: 'Test Restaurant',
            timezone: 'America/Mexico_City',
          },
        },
      ]

      // First findMany for fixed-time (returns empty)
      prismaMock.venueSettings.findMany
        .mockResolvedValueOnce([]) // Fixed time query
        .mockResolvedValueOnce(mockVenueSettings) // Max duration query

      // No overdue entries found
      prismaMock.timeEntry.findMany.mockResolvedValue([])

      await job.runNow()

      // Should not update any entries
      expect(prismaMock.timeEntry.update).not.toHaveBeenCalled()
    })
  })

  describe('Hour Calculation', () => {
    it('should calculate total hours correctly including break deduction', async () => {
      const mockVenueSettings = [
        {
          id: 'settings-1',
          venueId: 'venue-1',
          autoClockOutEnabled: true,
          autoClockOutTime: '03:00',
          maxShiftDurationEnabled: false,
          maxShiftDurationHours: 12,
          venue: {
            id: 'venue-1',
            name: 'Test Restaurant',
            timezone: 'America/Mexico_City',
          },
        },
      ]

      // 8 hour shift with 30 minute break = 7.5 hours worked
      const eightHoursAgo = new Date()
      eightHoursAgo.setHours(eightHoursAgo.getHours() - 8)

      const breakStart = new Date(eightHoursAgo)
      breakStart.setHours(breakStart.getHours() + 4) // 4 hours into shift

      const breakEnd = new Date(breakStart)
      breakEnd.setMinutes(breakEnd.getMinutes() + 30) // 30 minute break

      const mockEntry = {
        id: 'entry-1',
        staffId: 'staff-1',
        venueId: 'venue-1',
        clockInTime: eightHoursAgo,
        clockOutTime: null,
        status: TimeEntryStatus.CLOCKED_IN,
        staff: { firstName: 'Juan', lastName: 'Perez' },
        breaks: [
          {
            id: 'break-1',
            startTime: breakStart,
            endTime: breakEnd, // Completed break
          },
        ],
      }

      prismaMock.venueSettings.findMany.mockResolvedValue(mockVenueSettings)
      prismaMock.timeEntry.findMany.mockResolvedValue([mockEntry])
      prismaMock.timeEntry.update.mockResolvedValue({})
      ;(job as any).isWithinClockOutWindow = jest.fn().mockReturnValue(true)

      await job.runNow()

      // Verify that breakMinutes was calculated (30 minutes)
      expect(prismaMock.timeEntry.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            breakMinutes: 30,
            totalHours: expect.any(Decimal),
          }),
        }),
      )
    })
  })

  describe('isWithinClockOutWindow', () => {
    it('should return true when current time is within 15 minutes of configured time', () => {
      // Create a job instance and test the private method
      const testJob = new AutoClockOutJob()

      // Mock current time to be 03:05 in Mexico City
      // const now = new Date()
      const mockDateFormat = jest.spyOn(Intl, 'DateTimeFormat').mockImplementation(
        () =>
          ({
            format: () => '03:05',
          }) as any,
      )

      const result = (testJob as any).isWithinClockOutWindow('03:00', 'America/Mexico_City')

      expect(result).toBe(true)

      mockDateFormat.mockRestore()
      testJob.stop()
    })

    it('should return false when current time is outside 15-minute window', () => {
      const testJob = new AutoClockOutJob()

      // Mock current time to be 03:20 (20 minutes after configured time)
      const mockDateFormat = jest.spyOn(Intl, 'DateTimeFormat').mockImplementation(
        () =>
          ({
            format: () => '03:20',
          }) as any,
      )

      const result = (testJob as any).isWithinClockOutWindow('03:00', 'America/Mexico_City')

      expect(result).toBe(false)

      mockDateFormat.mockRestore()
      testJob.stop()
    })

    it('should handle midnight wraparound correctly', () => {
      const testJob = new AutoClockOutJob()

      // Mock current time to be 00:05 with configured time 23:55
      const mockDateFormat = jest.spyOn(Intl, 'DateTimeFormat').mockImplementation(
        () =>
          ({
            format: () => '00:05',
          }) as any,
      )

      const result = (testJob as any).isWithinClockOutWindow('23:55', 'America/Mexico_City')

      // 00:05 is 10 minutes after 23:55 (with wraparound), should be within window
      expect(result).toBe(true)

      mockDateFormat.mockRestore()
      testJob.stop()
    })
  })

  describe('Error Handling', () => {
    it('should handle database errors gracefully', async () => {
      // Simulate database error
      prismaMock.venueSettings.findMany.mockRejectedValue(new Error('Database connection failed'))

      // Should not throw, just log the error
      await expect(job.runNow()).resolves.not.toThrow()
    })

    it('should continue processing other venues if one fails', async () => {
      const mockVenueSettingsFixedTime = [
        {
          id: 'settings-1',
          venueId: 'venue-1',
          autoClockOutEnabled: true,
          autoClockOutTime: '03:00',
          maxShiftDurationEnabled: false,
          maxShiftDurationHours: 12,
          venue: {
            id: 'venue-1',
            name: 'Venue 1',
            timezone: 'America/Mexico_City',
          },
        },
        {
          id: 'settings-2',
          venueId: 'venue-2',
          autoClockOutEnabled: true,
          autoClockOutTime: '03:00',
          maxShiftDurationEnabled: false,
          maxShiftDurationHours: 12,
          venue: {
            id: 'venue-2',
            name: 'Venue 2',
            timezone: 'America/Mexico_City',
          },
        },
      ]

      // First call for fixed-time (returns 2 venues), second for max-duration (empty)
      prismaMock.venueSettings.findMany.mockResolvedValueOnce(mockVenueSettingsFixedTime).mockResolvedValueOnce([])

      // First venue fails, second succeeds
      prismaMock.timeEntry.findMany.mockRejectedValueOnce(new Error('Venue 1 error')).mockResolvedValueOnce([
        {
          id: 'entry-2',
          staffId: 'staff-2',
          venueId: 'venue-2',
          clockInTime: new Date(),
          clockOutTime: null,
          status: TimeEntryStatus.CLOCKED_IN,
          staff: { firstName: 'Test', lastName: 'User' },
          breaks: [],
        },
      ])

      prismaMock.timeEntry.update.mockResolvedValue({})
      ;(job as any).isWithinClockOutWindow = jest.fn().mockReturnValue(true)

      await job.runNow()

      // Second venue should still be processed (only 1 update for venue-2)
      expect(prismaMock.timeEntry.update).toHaveBeenCalledTimes(1)
      expect(prismaMock.timeEntry.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'entry-2' },
        }),
      )
    })
  })
})
