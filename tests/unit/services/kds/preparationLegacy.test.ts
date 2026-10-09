import { prismaMock } from '../../../__helpers__/setup'
import { bumpKdsOrder, updateKdsOrderStatus, recallKdsOrder, bumpKdsOrdersBatch } from '@/services/mobile/kds.mobile.service'
import { markKitchenTicket } from '@/services/kds/kitchenTicketAuthoring.service'

describe('legacy clients cannot close new preparation tickets', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.kdsOrder.findFirst.mockResolvedValue({ id: 'ticket', preparationVersion: 1 })
    prismaMock.kdsOrder.findMany.mockResolvedValue([{ id: 'ticket', preparationVersion: 1 }])
    prismaMock.kdsOrder.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.kdsOrder.createMany.mockResolvedValue({ count: 0 })
  })
  it.each(['bump', 'status', 'recall', 'batch'])('rejects the legacy %s path with an actionable conflict', async path => {
    const promise =
      path === 'bump'
        ? bumpKdsOrder('venue', 'ticket')
        : path === 'status'
          ? updateKdsOrderStatus('venue', 'ticket', 'COMPLETED')
          : path === 'recall'
            ? recallKdsOrder('venue', 'ticket')
            : bumpKdsOrdersBatch('venue', ['ticket'])
    await expect(promise).rejects.toMatchObject({ code: 'PREPARATION_VERSION_REQUIRED', statusCode: 409 })
    expect(prismaMock.kdsOrder.update).not.toHaveBeenCalled()
    expect(prismaMock.kdsOrder.updateMany).not.toHaveBeenCalled()
  })
  it('scopes legacy offline marks to legacy tickets only', async () => {
    await markKitchenTicket({
      venueId: 'venue',
      sourceKey: 'round:rk:station',
      stationId: null,
      action: 'BUMP',
      label: null,
      at: new Date(),
    })
    expect(prismaMock.kdsOrder.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ venueId: 'venue', sourceKey: 'round:rk:station', preparationVersion: 0 }),
      }),
    )
  })
})
