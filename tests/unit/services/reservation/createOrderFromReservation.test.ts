import { Prisma } from '@prisma/client'
import { createOrderFromReservation } from '@/services/reservation/createOrderFromReservation'
import { prismaMock } from '@tests/__helpers__/setup'

function reservation(assignedStaffId: string | null) {
  return {
    id: 'reservation-1',
    productId: 'product-1',
    productIds: [],
    partySize: 1,
    tableId: null,
    customerId: null,
    guestName: 'Ana',
    guestPhone: null,
    guestEmail: null,
    specialRequests: null,
    assignedStaffId,
    modifiers: [],
  }
}

describe('createOrderFromReservation staff prefill', () => {
  beforeEach(() => {
    jest.resetAllMocks()
    prismaMock.order.findFirst.mockResolvedValue(null)
    prismaMock.product.findMany.mockResolvedValue([
      {
        id: 'product-1',
        name: 'Corte',
        sku: 'CUT-1',
        price: new Prisma.Decimal(100),
        taxRate: new Prisma.Decimal(0),
        category: { name: 'Servicios' },
      },
    ] as any)
    prismaMock.order.create.mockResolvedValue({ id: 'order-1' } as any)
    prismaMock.orderItem.create.mockResolvedValue({ id: 'item-1' } as any)
  })

  it('prefills servedById from assignedStaffId only on a newly created order', async () => {
    prismaMock.reservation.findFirst.mockResolvedValue(reservation('staff-professional') as any)

    await createOrderFromReservation(prismaMock, {
      reservationId: 'reservation-1',
      venueId: 'venue-1',
      createdByStaffId: 'staff-checkin',
    })

    expect(prismaMock.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ createdById: 'staff-checkin', servedById: 'staff-professional' }),
      }),
    )
  })

  it('omits servedById when the reservation has no assigned professional', async () => {
    prismaMock.reservation.findFirst.mockResolvedValue(reservation(null) as any)

    await createOrderFromReservation(prismaMock, { reservationId: 'reservation-1', venueId: 'venue-1' })

    expect(prismaMock.order.create.mock.calls[0][0].data).not.toHaveProperty('servedById')
  })

  it('keeps the idempotent existing-order branch read-only', async () => {
    prismaMock.order.findFirst.mockResolvedValue({ id: 'order-existing' } as any)

    await expect(createOrderFromReservation(prismaMock, { reservationId: 'reservation-1', venueId: 'venue-1' })).resolves.toEqual({
      orderId: 'order-existing',
      created: false,
    })
    expect(prismaMock.reservation.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })
})
