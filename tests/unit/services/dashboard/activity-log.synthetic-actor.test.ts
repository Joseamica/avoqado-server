jest.unmock('@/services/dashboard/activity-log.service')

import { logAction } from '@/services/dashboard/activity-log.service'
import { prismaMock } from '@tests/__helpers__/setup'

describe('activity-log synthetic actor normalization', () => {
  it('writes MASTER_ADMIN as a non-human actor without attempting the Staff FK', async () => {
    prismaMock.activityLog.create.mockResolvedValue({ id: 'audit-1' } as never)

    await logAction({
      staffId: 'MASTER_ADMIN',
      venueId: 'venue-1',
      action: 'MASTER_ACTION',
      entity: 'Product',
      entityId: 'product-1',
    })

    expect(prismaMock.activityLog.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ staffId: null, action: 'MASTER_ACTION', entityId: 'product-1' }),
    })
  })
})
