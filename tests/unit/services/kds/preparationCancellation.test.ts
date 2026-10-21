import { prismaMock } from '../../../__helpers__/setup'
import { retirarComandasDeVentaAnulada } from '@/services/kds/kitchenTicketAuthoring.service'

describe('cancelled account preserves preparation history', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$queryRaw.mockResolvedValue([])
    prismaMock.kdsOrder.findMany.mockResolvedValue([])
    prismaMock.kdsOrderItem.findMany.mockImplementation(async (args: any) =>
      args.where?.kdsOrder?.preparationVersion === 1
        ? [
            {
              id: 'prepared-line',
              kdsOrderId: 'ticket-new',
              quantity: 5,
              preparationRevision: 4,
              preparation: { HELD: 1, PENDING: 1, PREPARING: 1, READY: 1, DELIVERED: 1, CANCELLED: 0 },
            },
          ]
        : [],
    )
    prismaMock.kdsOrderItem.updateMany.mockResolvedValue({ count: 1 })
  })
  it('cancels outstanding quantities, keeps delivered quantities and records the actor', async () => {
    await retirarComandasDeVentaAnulada(prismaMock as any, 'venue-a', 'order-a', { staffId: 'staff-a', reason: 'Cuenta anulada' })
    expect(prismaMock.kdsOrderItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'prepared-line', preparationRevision: 4 }),
        data: {
          preparationRevision: { increment: 1 },
          preparation: { HELD: 0, PENDING: 0, PREPARING: 0, READY: 0, DELIVERED: 1, CANCELLED: 4 },
        },
      }),
    )
    expect(prismaMock.kdsOrderItem.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { kdsOrder: expect.objectContaining({ venueId: 'venue-a', orderId: 'order-a', preparationVersion: 0 }) },
      }),
    )
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ staffId: 'staff-a', action: 'KITCHEN_ORDER_CANCEL' }),
      }),
    )
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })
})
