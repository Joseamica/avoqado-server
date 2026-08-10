jest.unmock('@/services/dashboard/activity-log.service')

import { logAction } from '@/services/dashboard/activity-log.service'
import { MASTER_ADMIN_PRINCIPAL_ID } from '@/lib/authPrincipals'
import { writeLegacyActivityAuditTx } from '@/services/activityAudit.service'
import { prismaMock } from '@tests/__helpers__/setup'

describe('activity-log synthetic actor normalization', () => {
  it('writes MASTER_ADMIN as a non-human actor without attempting the Staff FK', async () => {
    prismaMock.activityLog.create.mockResolvedValue({ id: 'audit-1' } as never)

    await logAction({
      staffId: MASTER_ADMIN_PRINCIPAL_ID,
      venueId: 'venue-1',
      action: 'MASTER_ACTION',
      entity: 'Product',
      entityId: 'product-1',
      data: { reason: 'break-glass' },
    })

    expect(prismaMock.activityLog.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        staffId: null,
        action: 'MASTER_ACTION',
        entityId: 'product-1',
        data: { reason: 'break-glass', unknownStaffId: MASTER_ADMIN_PRINCIPAL_ID },
      }),
    })
  })

  it('normalizes MASTER_ADMIN identically in an atomic transaction writer', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'audit-2' })

    await writeLegacyActivityAuditTx({ activityLog: { create } } as never, {
      staffId: MASTER_ADMIN_PRINCIPAL_ID,
      venueId: 'venue-1',
      action: 'SUPERADMIN_PLAN_ACTIVATED',
      entity: 'VenueFeature',
      entityId: 'venue-1',
      data: { featureCode: 'PLAN_PRO' },
    })

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        staffId: null,
        data: { featureCode: 'PLAN_PRO', unknownStaffId: MASTER_ADMIN_PRINCIPAL_ID },
      }),
    })
  })
})
