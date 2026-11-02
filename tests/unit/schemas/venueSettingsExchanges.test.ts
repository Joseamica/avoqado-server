import { UpdateVenueSettingsSchema } from '@/schemas/dashboard/venueSettings.schema'

describe('exchange setting schema', () => {
  it.each([true, false])('keeps the explicit setting %s', exchangesEnabled => {
    expect(UpdateVenueSettingsSchema.parse({ params: { venueId: 'venue' }, body: { exchangesEnabled } }).body).toEqual({ exchangesEnabled })
  })
  it('keeps unrelated updates and omits an untouched setting', () => {
    expect(UpdateVenueSettingsSchema.parse({ params: { venueId: 'venue' }, body: { enableShifts: false } }).body).toEqual({
      enableShifts: false,
    })
  })
  it.each([null, 'true', 1])('rejects a non-boolean setting %j', exchangesEnabled => {
    expect(UpdateVenueSettingsSchema.safeParse({ params: { venueId: 'venue' }, body: { exchangesEnabled } }).success).toBe(false)
  })
})

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    venueSettings: { findUnique: jest.fn(), upsert: jest.fn() },
  },
}))
jest.mock('@/services/access/basePlan.service', () => ({ venueHasFeatureAccess: jest.fn() }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { updateVenueSettings } from '@/services/dashboard/venueSettings.dashboard.service'

describe('exchange setting persistence and audit', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.mocked(prisma.venue.findUnique).mockResolvedValue({ id: 'venue' } as never)
    jest.mocked(prisma.venueSettings.upsert).mockResolvedValue({ id: 'settings' } as never)
  })
  it.each([true, false])('retains %s in both upsert branches and records the actor and before/after', async exchangesEnabled => {
    jest.mocked(prisma.venueSettings.findUnique).mockResolvedValue({ exchangesEnabled: !exchangesEnabled } as never)
    await updateVenueSettings('venue', { exchangesEnabled }, 'staff')
    expect(prisma.venueSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { venueId: 'venue' },
        create: expect.objectContaining({ exchangesEnabled }),
        update: { exchangesEnabled },
      }),
    )
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: 'staff',
        venueId: 'venue',
        action: 'SETTINGS_UPDATED',
        data: expect.objectContaining({ changes: { exchangesEnabled: { from: !exchangesEnabled, to: exchangesEnabled } } }),
      }),
    )
  })
  it('does not replace the inherited null setting when updating another field', async () => {
    await updateVenueSettings('venue', { enableShifts: false }, 'staff')
    const args = jest.mocked(prisma.venueSettings.upsert).mock.calls[0][0]
    expect(args.create).not.toHaveProperty('exchangesEnabled')
    expect(args.update).not.toHaveProperty('exchangesEnabled')
  })
})
