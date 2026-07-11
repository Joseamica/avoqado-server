import { prismaMock } from '../../__helpers__/setup'
import { organizationDashboardService } from '@/services/organization-dashboard/organizationDashboard.service'
import { BadRequestError, NotFoundError } from '@/errors/AppError'

describe('org promoter-location settings (configurable capture window)', () => {
  const orgId = 'org1'
  const venueId = 'venue1'

  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ── upsertOrgAttendanceConfig: window cascades to all org venues ──────────
  describe('upsertOrgAttendanceConfig — window cascade', () => {
    it('cascades promoterLocationStartHour/EndHour to every venue via venueSettings.updateMany', async () => {
      prismaMock.organizationAttendanceConfig.findUnique.mockResolvedValue(null)
      prismaMock.organizationAttendanceConfig.upsert.mockResolvedValue({ id: 'cfg1' } as any)
      prismaMock.venue.findMany.mockResolvedValue([{ id: 'v1' }, { id: 'v2' }] as any)
      prismaMock.venueSettings.updateMany.mockResolvedValue({ count: 2 } as any)
      prismaMock.venueSettings.findMany.mockResolvedValue([{ venueId: 'v1' }, { venueId: 'v2' }] as any)

      await organizationDashboardService.upsertOrgAttendanceConfig(orgId, {
        promoterLocationStartHour: 0,
        promoterLocationEndHour: 24,
      })

      expect(prismaMock.venueSettings.updateMany).toHaveBeenCalledWith({
        where: { venueId: { in: ['v1', 'v2'] } },
        data: { promoterLocationStartHour: 0, promoterLocationEndHour: 24 },
      })
      // No missing venues → createMany should not run
      expect(prismaMock.venueSettings.createMany).not.toHaveBeenCalled()
    })

    it('createMany backfills venues with no existing VenueSettings row', async () => {
      prismaMock.organizationAttendanceConfig.findUnique.mockResolvedValue(null)
      prismaMock.organizationAttendanceConfig.upsert.mockResolvedValue({ id: 'cfg1' } as any)
      prismaMock.venue.findMany.mockResolvedValue([{ id: 'v1' }, { id: 'v2' }] as any)
      prismaMock.venueSettings.updateMany.mockResolvedValue({ count: 1 } as any)
      // Only v1 has a VenueSettings row → v2 is missing
      prismaMock.venueSettings.findMany.mockResolvedValue([{ venueId: 'v1' }] as any)
      prismaMock.venueSettings.createMany.mockResolvedValue({ count: 1 } as any)

      await organizationDashboardService.upsertOrgAttendanceConfig(orgId, {
        promoterLocationStartHour: 9,
        promoterLocationEndHour: 20,
      })

      expect(prismaMock.venueSettings.createMany).toHaveBeenCalledWith({
        data: [{ venueId: 'v2', promoterLocationStartHour: 9, promoterLocationEndHour: 20 }],
      })
    })

    it('rejects an invalid window (start >= end) with BadRequestError and performs no writes', async () => {
      await expect(
        organizationDashboardService.upsertOrgAttendanceConfig(orgId, {
          promoterLocationStartHour: 18,
          promoterLocationEndHour: 11,
        }),
      ).rejects.toThrow(BadRequestError)

      expect(prismaMock.organizationAttendanceConfig.upsert).not.toHaveBeenCalled()
      expect(prismaMock.venueSettings.updateMany).not.toHaveBeenCalled()
      expect(prismaMock.venueSettings.createMany).not.toHaveBeenCalled()
    })

    it('rejects an out-of-range start hour with BadRequestError', async () => {
      await expect(
        organizationDashboardService.upsertOrgAttendanceConfig(orgId, {
          promoterLocationStartHour: 24,
        }),
      ).rejects.toThrow(BadRequestError)
      expect(prismaMock.organizationAttendanceConfig.upsert).not.toHaveBeenCalled()
    })

    it('rejects an out-of-range end hour with BadRequestError', async () => {
      await expect(
        organizationDashboardService.upsertOrgAttendanceConfig(orgId, {
          promoterLocationEndHour: 0,
        }),
      ).rejects.toThrow(BadRequestError)
      expect(prismaMock.organizationAttendanceConfig.upsert).not.toHaveBeenCalled()
    })
  })

  // ── getOrgPromoterLocationSettings ────────────────────────────────────────
  describe('getOrgPromoterLocationSettings', () => {
    it('reports schema defaults for venues without a VenueSettings row (LEFT JOIN semantics)', async () => {
      prismaMock.venue.findMany.mockResolvedValue([
        { id: 'v1', name: 'BAE 1', settings: { trackPromoterLocation: true, promoterLocationStartHour: 9, promoterLocationEndHour: 20 } },
        { id: 'v2', name: 'BAE 2', settings: null },
      ] as any)

      const result = await organizationDashboardService.getOrgPromoterLocationSettings(orgId)

      expect(result.venues).toEqual([
        { venueId: 'v1', name: 'BAE 1', trackPromoterLocation: true, promoterLocationStartHour: 9, promoterLocationEndHour: 20 },
        { venueId: 'v2', name: 'BAE 2', trackPromoterLocation: false, promoterLocationStartHour: 11, promoterLocationEndHour: 18 },
      ])
    })
  })

  // ── updateVenuePromoterLocationSettings ───────────────────────────────────
  describe('updateVenuePromoterLocationSettings', () => {
    it('rejects a venue that does not belong to the org with NotFoundError', async () => {
      prismaMock.venue.findFirst.mockResolvedValue(null)

      await expect(
        organizationDashboardService.updateVenuePromoterLocationSettings(orgId, venueId, { trackPromoterLocation: true }),
      ).rejects.toThrow(NotFoundError)

      expect(prismaMock.venueSettings.upsert).not.toHaveBeenCalled()
    })

    it('happy path: upserts only the provided fields', async () => {
      prismaMock.venue.findFirst.mockResolvedValue({ id: venueId } as any)
      prismaMock.venueSettings.upsert.mockResolvedValue({
        venueId,
        trackPromoterLocation: true,
        promoterLocationStartHour: 11,
        promoterLocationEndHour: 18,
      } as any)

      const result = await organizationDashboardService.updateVenuePromoterLocationSettings(orgId, venueId, {
        trackPromoterLocation: true,
      })

      expect(prismaMock.venueSettings.upsert).toHaveBeenCalledWith({
        where: { venueId },
        create: { venueId, trackPromoterLocation: true },
        update: { trackPromoterLocation: true },
        select: { venueId: true, trackPromoterLocation: true, promoterLocationStartHour: true, promoterLocationEndHour: true },
      })
      expect(result.trackPromoterLocation).toBe(true)
    })

    it('rejects an invalid window on the per-venue override', async () => {
      prismaMock.venue.findFirst.mockResolvedValue({ id: venueId } as any)

      await expect(
        organizationDashboardService.updateVenuePromoterLocationSettings(orgId, venueId, {
          promoterLocationStartHour: 20,
          promoterLocationEndHour: 10,
        }),
      ).rejects.toThrow(BadRequestError)

      expect(prismaMock.venueSettings.upsert).not.toHaveBeenCalled()
    })
  })
})
