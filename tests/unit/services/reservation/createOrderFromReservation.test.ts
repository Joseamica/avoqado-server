// El guard de ventas por sucursal (venueSalesGuard) NO es el objeto de esta suite:
// se prueba en tests/unit/services/venueSalesGuard.test.ts. Sin este mock, cada
// servicio de venta consulta venue.salesEnabled contra un prismaMock que no lo define.
jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))

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

  it('🔴 Fase 0.C (test 10): la idempotencia sólo cuenta órdenes VIVAS — mismo predicado que el índice parcial (status NOT IN CANCELLED, DELETED)', async () => {
    // Antes el findFirst no filtraba status: una orden CANCELADA bloqueaba el reemplazo para siempre.
    prismaMock.order.findFirst.mockResolvedValue(null)

    await createOrderFromReservation(prismaMock, { reservationId: 'reservation-1', venueId: 'venue-1' })

    expect(prismaMock.order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { reservationId: 'reservation-1', venueId: 'venue-1', status: { notIn: ['CANCELLED', 'DELETED'] } },
      }),
    )
  })
})

// ── La misma invariante que se cerró en Rappi y en Uber (27-ago) ──────────────────────
describe('🔴 el REPORTE no puede contradecir a la orden', () => {
  // `lineRevenue.ts` (dashboard) suma el ingreso de UNA línea así, en SQL:
  //   unitPrice × quantity + Σ(modificador.price × modificador.quantity)
  // y NO multiplica los modificadores por la cantidad del renglón. Aquí la cantidad del
  // renglón es `seatCount`, y el cobro SÍ multiplica el modificador por él
  // (`m.price × m.quantity × seatCount`). Si el par que se guarda no lleva ese seatCount
  // dentro, el reporte enseña menos dinero del que se cobró.
  const lineGross = (item: { unitPrice: unknown; quantity: number }, mods: Array<{ price: unknown; quantity: number }>) =>
    Number(item.unitPrice) * item.quantity + mods.reduce((a, m) => a + Number(m.price) * m.quantity, 0)

  beforeEach(() => {
    jest.resetAllMocks()
    prismaMock.order.findFirst.mockResolvedValue(null)
    prismaMock.product.findMany.mockResolvedValue([
      {
        id: 'product-1',
        name: 'Manicure',
        sku: 'MAN-1',
        price: new Prisma.Decimal(100),
        taxRate: new Prisma.Decimal(0),
        category: { name: 'Servicios' },
      },
    ] as any)
    prismaMock.order.create.mockResolvedValue({ id: 'order-1' } as any)
    prismaMock.orderItem.create.mockResolvedValue({ id: 'item-1' } as any)
    prismaMock.reservation.findFirst.mockResolvedValue({
      id: 'reservation-1',
      productId: 'product-1',
      productIds: [],
      // Una familia de 3: el cobro multiplica el esmalte por los 3 asientos.
      partySize: 3,
      tableId: null,
      customerId: null,
      guestName: 'Ana',
      guestPhone: null,
      guestEmail: null,
      specialRequests: null,
      assignedStaffId: null,
      modifiers: [
        { productId: 'product-1', modifierId: 'mod-1', name: 'Esmalte de color', quantity: 1, price: new Prisma.Decimal(50) },
      ],
    } as any)
  })

  it('lineGross del renglón == lo que se cobró (3 manicures con esmalte)', async () => {
    await createOrderFromReservation(prismaMock as any, 'venue-1', 'reservation-1')

    const item = (prismaMock.orderItem.create as jest.Mock).mock.calls[0][0].data
    const mods = (prismaMock.orderItemModifier.createMany as jest.Mock).mock.calls[0][0].data
    const cobrado = (prismaMock.order.create as jest.Mock).mock.calls[0][0].data.total

    // (100 + 50) × 3 = 450. Es lo que el cliente paga.
    expect(Number(cobrado).toFixed(2)).toBe('450.00')
    expect(lineGross(item, mods).toFixed(2)).toBe(Number(cobrado).toFixed(2))
  })
})
