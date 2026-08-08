/**
 * Production change that makes this suite pass: the venue-level opt-in can only transition on
 * with Feature entitlement, can always transition off, and is audited atomically with the actor.
 */

const tx = {
  venueSettings: { upsert: jest.fn() },
  activityLog: { create: jest.fn() },
}

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    venueSettings: { findUnique: jest.fn(), upsert: jest.fn() },
    $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  },
}))

jest.mock('@/services/access/basePlan.service', () => ({
  venueHasFeatureAccess: jest.fn(),
}))

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import prisma from '@/utils/prismaClient'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { updateVenueSettings } from '@/services/dashboard/venueSettings.dashboard.service'

const db = prisma as any
const hasFeature = venueHasFeatureAccess as jest.MockedFunction<typeof venueHasFeatureAccess>

describe('updateVenueSettings cashReconciliationEnabled', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    db.venue.findUnique.mockResolvedValue({ id: 'venue-1' })
    db.venueSettings.findUnique.mockResolvedValue({ id: 'settings-1', cashReconciliationEnabled: false })
    tx.venueSettings.upsert.mockResolvedValue({ id: 'settings-1', venueId: 'venue-1', cashReconciliationEnabled: true })
    tx.activityLog.create.mockResolvedValue({ id: 'audit-1' })
  })

  it('enables only after checking the exact paid Feature and audits previous/new with the authenticated actor', async () => {
    hasFeature.mockResolvedValue(true)

    await updateVenueSettings('venue-1', { cashReconciliationEnabled: true } as any, 'staff-authenticated')

    expect(hasFeature).toHaveBeenCalledWith('venue-1', 'CASH_RECONCILIATION')
    expect(tx.venueSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { venueId: 'venue-1' },
        update: expect.objectContaining({ cashReconciliationEnabled: true }),
        create: expect.objectContaining({ venueId: 'venue-1', cashReconciliationEnabled: true }),
      }),
    )
    expect(tx.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        staffId: 'staff-authenticated',
        venueId: 'venue-1',
        action: 'CASH_RECONCILIATION_SETTING_UPDATED',
        entity: 'VenueSettings',
        entityId: 'settings-1',
        data: { previousValue: false, newValue: true },
      }),
    })
  })

  it('rejects enable for a non-entitled venue without mutating settings', async () => {
    hasFeature.mockResolvedValue(false)

    await expect(updateVenueSettings('venue-1', { cashReconciliationEnabled: true } as any, 'staff-1')).rejects.toMatchObject({
      statusCode: 403,
    })
    expect(tx.venueSettings.upsert).not.toHaveBeenCalled()
  })

  it('always allows disable after downgrade and does not consult the paid gate', async () => {
    db.venueSettings.findUnique.mockResolvedValue({ id: 'settings-1', cashReconciliationEnabled: true })
    tx.venueSettings.upsert.mockResolvedValue({ id: 'settings-1', venueId: 'venue-1', cashReconciliationEnabled: false })

    await updateVenueSettings('venue-1', { cashReconciliationEnabled: false } as any, 'staff-1')

    expect(hasFeature).not.toHaveBeenCalled()
    expect(tx.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ data: { previousValue: true, newValue: false } }),
    })
  })

  it('surfaces an entitlement infrastructure error as retryable instead of pretending it is a 403', async () => {
    const failure = new Error('entitlement database unavailable')
    hasFeature.mockRejectedValue(failure)

    await expect(updateVenueSettings('venue-1', { cashReconciliationEnabled: true } as any, 'staff-1')).rejects.toBe(failure)
    expect(tx.venueSettings.upsert).not.toHaveBeenCalled()
  })

  it('defaults a missing settings row to previous=false and creates the requested raw value', async () => {
    db.venueSettings.findUnique.mockResolvedValue(null)
    hasFeature.mockResolvedValue(true)

    await updateVenueSettings('venue-1', { cashReconciliationEnabled: true } as any, 'staff-1')

    expect(tx.venueSettings.upsert.mock.calls[0][0].create.cashReconciliationEnabled).toBe(true)
    expect(tx.activityLog.create.mock.calls[0][0].data.data).toEqual({ previousValue: false, newValue: true })
  })
})
