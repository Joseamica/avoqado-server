import { createReservation } from '@/services/dashboard/reservation.dashboard.service'
import { prismaMock } from '@tests/__helpers__/setup'
import { Prisma } from '@prisma/client'

jest.mock('@/services/reservation/resolveModifierSelections', () => ({
  resolveModifierSelections: jest.fn(),
}))
import { resolveModifierSelections } from '@/services/reservation/resolveModifierSelections'

describe('createReservation with modifiers', () => {
  const venueId = 'cven0000000000000000000001'
  const productId = 'cprod00000000000000000001'

  const baseProduct = {
    id: productId,
    name: 'Service',
    price: new Prisma.Decimal('500'),
    type: 'APPOINTMENTS_SERVICE',
    duration: 60,
    active: true,
    venueId,
    eventCapacity: null,
  }

  const mockReservation = {
    id: 'cres000000000000000000001',
    venueId,
    productId,
    confirmationCode: 'RES-XXXX',
    cancelSecret: 'secret-uuid',
    status: 'CONFIRMED',
    startsAt: new Date('2026-06-01T10:00:00Z'),
    endsAt: new Date('2026-06-01T11:00:00Z'),
    channel: 'DASHBOARD',
    duration: 60,
    customerId: null,
    guestName: 'Test',
    guestPhone: '5555555555',
    guestEmail: null,
    partySize: 1,
    tableId: null,
    assignedStaffId: null,
    depositAmount: null,
    depositStatus: null,
    depositExpiresAt: null,
    depositPaidAt: null,
    depositPaymentRef: null,
    createdById: null,
    confirmedAt: new Date('2026-06-01T10:00:00Z'),
    checkedInAt: null,
    completedAt: null,
    cancelledAt: null,
    noShowAt: null,
    cancelledBy: null,
    cancellationReason: null,
    specialRequests: null,
    internalNotes: null,
    tags: [],
    statusLog: [],
    idempotencyKey: null,
    createdAt: new Date('2026-06-01T10:00:00Z'),
    updatedAt: new Date('2026-06-01T10:00:00Z'),
    customer: null,
    table: null,
    product: { id: productId, name: 'Service', price: new Prisma.Decimal('500') },
    assignedStaff: null,
    createdBy: null,
  }

  beforeEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
    jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-05-01T00:00:00.000Z').getTime())
    prismaMock.$transaction.mockImplementation(async (fn: any) => {
      if (typeof fn === 'function') return fn(prismaMock)
      return fn
    })
    prismaMock.$queryRaw.mockResolvedValue([])
    prismaMock.product.findFirst.mockResolvedValue(baseProduct)
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
    prismaMock.table.findFirst.mockResolvedValue(null)
    prismaMock.reservation.findUnique.mockResolvedValue(null)
    prismaMock.reservation.create.mockResolvedValue(mockReservation as any)
    prismaMock.reservation.updateMany.mockResolvedValue({ count: 1 } as any)
    prismaMock.reservationModifier.createMany.mockResolvedValue({ count: 1 } as any)
    prismaMock.externalBusyBlock.findFirst.mockResolvedValue(null)
    ;(resolveModifierSelections as jest.Mock).mockResolvedValue({
      persistRows: [{ productId, modifierId: 'cmod1', name: 'Esmalte', quantity: 1, price: new Prisma.Decimal('150') }],
      totalDelta: new Prisma.Decimal('150'),
    })
  })

  it('persists ReservationModifier rows when selections are provided', async () => {
    await createReservation(
      venueId,
      {
        startsAt: new Date('2026-06-01T10:00:00Z'),
        endsAt: new Date('2026-06-01T11:00:00Z'),
        duration: 60,
        productId,
        productIds: [productId],
        guestName: 'Test',
        guestPhone: '5555555555',
        modifierSelections: [{ productId, modifierId: 'cmod1', quantity: 1 }],
      } as any,
      { writeOrigin: 'DASHBOARD' },
    )

    expect(resolveModifierSelections).toHaveBeenCalledWith(
      expect.anything(),
      [productId],
      [{ productId, modifierId: 'cmod1', quantity: 1 }],
    )
    expect(prismaMock.reservationModifier.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ productId, modifierId: 'cmod1', name: 'Esmalte', quantity: 1 })],
    })
  })

  it('does not call createMany when persistRows is empty', async () => {
    ;(resolveModifierSelections as jest.Mock).mockResolvedValue({
      persistRows: [],
      totalDelta: new Prisma.Decimal('0'),
    })

    await createReservation(
      venueId,
      {
        startsAt: new Date('2026-06-01T10:00:00Z'),
        endsAt: new Date('2026-06-01T11:00:00Z'),
        duration: 60,
        productId,
        guestName: 'Test',
        guestPhone: '5555555555',
      } as any,
      { writeOrigin: 'DASHBOARD' },
    )

    expect(prismaMock.reservationModifier.createMany).not.toHaveBeenCalled()
  })
})
