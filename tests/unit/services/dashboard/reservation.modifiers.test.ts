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
    ;(prismaMock as any).$executeRaw = jest.fn().mockResolvedValue(0)
    prismaMock.$queryRaw.mockResolvedValue([])
    prismaMock.reservationSettings.findUnique.mockResolvedValue(null)
    prismaMock.product.findFirst.mockResolvedValue(baseProduct)
    prismaMock.product.findMany.mockResolvedValue([baseProduct] as any)
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
      totalDurationDelta: 0,
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
      totalDurationDelta: 0,
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

  it('uses the canonical base window and modifier resolution exactly once', async () => {
    ;(resolveModifierSelections as jest.Mock).mockResolvedValue({
      persistRows: [{ productId, modifierId: 'cmod1', name: 'Esmalte', quantity: 1, price: new Prisma.Decimal('150') }],
      totalDelta: new Prisma.Decimal('150'),
      totalDurationDelta: 15,
    })
    prismaMock.product.findMany.mockResolvedValue([
      {
        id: productId,
        duration: 60,
        durationMinutes: null,
        type: 'APPOINTMENTS_SERVICE',
        price: new Prisma.Decimal('500'),
        eventCapacity: 20,
      },
    ] as any)
    prismaMock.table.findFirst.mockResolvedValue({ id: 'table-1' } as any)
    prismaMock.staffVenue.findFirst.mockResolvedValue({
      id: 'staff-venue-1',
      staffId: 'staff-1',
      startDate: new Date('2026-01-01T00:00:00.000Z'),
      venue: { organizationId: 'organization-1', timezone: 'UTC' },
    } as any)
    prismaMock.staffVenue.findMany.mockResolvedValue([{ venueId }] as any)
    prismaMock.productStaff.findMany.mockResolvedValue([{ productId }] as any)
    prismaMock.staffSchedule.findFirst.mockResolvedValue(null)
    prismaMock.staffScheduleException.findMany.mockResolvedValue([])
    prismaMock.reservationSettings.findUnique.mockResolvedValue({ showStaffPicker: true } as any)
    prismaMock.reservation.create.mockImplementation(async ({ data }: any) => ({ ...mockReservation, ...data }) as any)

    await createReservation(
      venueId,
      {
        startsAt: new Date('2026-06-01T10:00:00Z'),
        endsAt: new Date('2026-06-01T11:00:00Z'),
        duration: 5,
        productId,
        productIds: [productId],
        tableId: 'table-1',
        assignedStaffId: 'staff-1',
        modifierSelections: [{ productId, modifierId: 'cmod1', quantity: 1 }],
      },
      {
        writeOrigin: 'PUBLIC',
        windowSemantics: 'base',
        paymentPolicyOverride: {
          deposits: {
            enabled: true,
            mode: 'deposit',
            percentageOfTotal: 10,
            fixedAmount: null,
            requiredForPartySizeGte: null,
            paymentWindowHrs: 24,
          },
        },
      },
    )

    expect(resolveModifierSelections).toHaveBeenCalledTimes(1)
    expect(prismaMock.reservation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          productId,
          productIds: [productId],
          endsAt: new Date('2026-06-01T11:15:00Z'),
          duration: 75,
          depositAmount: new Prisma.Decimal('65'),
        }),
      }),
    )
    expect(prismaMock.externalBusyBlock.findFirst).toHaveBeenCalledWith({
      where: {
        OR: [{ venueId }, { staffId: 'staff-1' }],
        startsAt: { lt: new Date('2026-06-01T11:15:00Z') },
        endsAt: { gt: new Date('2026-06-01T10:00:00Z') },
      },
    })
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(3)
    for (const call of prismaMock.$queryRaw.mock.calls) {
      expect(call).toContainEqual(new Date('2026-06-01T11:15:00Z'))
    }
  })

  it('allows legacy modifiers to reach 1440 minutes but rejects 1441 before writing', async () => {
    ;(resolveModifierSelections as jest.Mock).mockResolvedValue({
      persistRows: [],
      totalDelta: new Prisma.Decimal('0'),
      totalDurationDelta: 960,
    })

    await createReservation(
      venueId,
      {
        startsAt: new Date('2026-06-01T00:00:00Z'),
        endsAt: new Date('2026-06-01T08:00:00Z'),
        duration: 480,
        productId,
      },
      { writeOrigin: 'DASHBOARD' },
    )
    expect(prismaMock.reservation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ duration: 1440, endsAt: new Date('2026-06-02T00:00:00Z') }),
      }),
    )

    jest.clearAllMocks()
    ;(resolveModifierSelections as jest.Mock).mockResolvedValue({
      persistRows: [],
      totalDelta: new Prisma.Decimal('0'),
      totalDurationDelta: 961,
    })
    await expect(
      createReservation(
        venueId,
        {
          startsAt: new Date('2026-06-01T00:00:00Z'),
          endsAt: new Date('2026-06-01T08:00:00Z'),
          duration: 480,
          productId,
        },
        { writeOrigin: 'DASHBOARD' },
      ),
    ).rejects.toThrow(/1440/)
    expect(prismaMock.reservation.create).not.toHaveBeenCalled()
  })

  it('does not write a reservation when modifier validation fails', async () => {
    ;(resolveModifierSelections as jest.Mock).mockRejectedValue(new Error('invalid modifier'))

    await expect(
      createReservation(
        venueId,
        {
          startsAt: new Date('2026-06-01T10:00:00Z'),
          endsAt: new Date('2026-06-01T11:00:00Z'),
          duration: 60,
          productId,
          modifierSelections: [{ productId, modifierId: 'invalid' }],
        },
        { writeOrigin: 'DASHBOARD' },
      ),
    ).rejects.toThrow('invalid modifier')
    expect(prismaMock.reservation.create).not.toHaveBeenCalled()
    expect(prismaMock.reservationModifier.createMany).not.toHaveBeenCalled()
    expect(prismaMock.calendarSyncOutbox.create).not.toHaveBeenCalled()
  })
})
