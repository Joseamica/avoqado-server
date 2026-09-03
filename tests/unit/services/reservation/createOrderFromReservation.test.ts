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
      modifiers: [{ productId: 'product-1', modifierId: 'mod-1', name: 'Esmalte de color', quantity: 1, price: new Prisma.Decimal(50) }],
    } as any)
  })

  it('lineGross del renglón == lo que se cobró (3 manicures con esmalte)', async () => {
    await createOrderFromReservation(prismaMock as any, { reservationId: 'reservation-1', venueId: 'venue-1' })

    const item = (prismaMock.orderItem.create as jest.Mock).mock.calls[0][0].data
    const mods = (prismaMock.orderItemModifier.createMany as jest.Mock).mock.calls[0][0].data
    const cobrado = (prismaMock.order.create as jest.Mock).mock.calls[0][0].data.total

    // (100 + 50) × 3 = 450. Es lo que el cliente paga.
    expect(Number(cobrado).toFixed(2)).toBe('450.00')
    expect(lineGross(item, mods).toFixed(2)).toBe(Number(cobrado).toFixed(2))
  })
})

// ── El precio de catálogo YA trae el IVA (convención mexicana) ────────────────────────
//
// 🔴 CASO REAL (Amaena, 31-ago-2026, orden RES-14508324): el paquete "Manicure +
// Pedicure Spa + Gel" cuesta $1,000 en el catálogo y la cuenta nació en $1,160,
// porque esta función sumaba `precio × taxRate` ENCIMA. La dueña confirmó que el
// precio es $1,000: a su clienta se le estaba inflando la cuenta 16%.
//
// 🔑 Por qué NINGUNA prueba lo cazó, y es la lección que importa: las suites de
// arriba siembran `taxRate: 0`, un valor que **ningún producto real tiene**. Los
// 984 productos de producción están en 0.1600 — el default de Prisma, no una
// elección del negocio (el formulario de alta ni siquiera muestra el campo, y la
// bitácora del alta de ese paquete registra sólo nombre, tipo, precio y categoría).
// Sembrar el caso cómodo dejó el camino aditivo sin ejercitar durante meses.
//
// La regla: el precio del catálogo es FINAL. El IVA va contenido, se desglosa
// sólo en el CFDI (`splitIvaIncluded`), y `Order.taxAmount` queda en 0 — que es
// lo que hacen los otros ocho caminos de venta nativos, y lo que el propio CFDI
// interpreta como "este precio ya trae IVA" (`pricesIncludeIva`).
describe('🔴 el precio de catálogo es FINAL: el IVA no se suma encima', () => {
  beforeEach(() => {
    jest.resetAllMocks()
    prismaMock.order.findFirst.mockResolvedValue(null)
    prismaMock.product.findMany.mockResolvedValue([
      {
        id: 'product-1',
        name: 'Manicure + Pedicure Spa + Gel',
        sku: 'PKG-1',
        price: new Prisma.Decimal(1000),
        // La tasa REAL de producción, no el 0 cómodo de las suites de arriba.
        taxRate: new Prisma.Decimal(0.16),
        category: { name: 'Paquetes' },
      },
    ] as any)
    prismaMock.order.create.mockResolvedValue({ id: 'order-1' } as any)
    prismaMock.orderItem.create.mockResolvedValue({ id: 'item-1' } as any)
    prismaMock.reservation.findFirst.mockResolvedValue({
      id: 'reservation-1',
      productId: 'product-1',
      productIds: [],
      partySize: 1,
      tableId: null,
      customerId: null,
      guestName: 'Regina',
      guestPhone: null,
      guestEmail: null,
      specialRequests: null,
      assignedStaffId: null,
      modifiers: [],
    } as any)
  })

  it('un paquete de $1,000 se cobra en $1,000, no en $1,160', async () => {
    await createOrderFromReservation(prismaMock as any, { reservationId: 'reservation-1', venueId: 'venue-1' })

    const order = (prismaMock.order.create as jest.Mock).mock.calls[0][0].data
    expect(Number(order.total).toFixed(2)).toBe('1000.00')
    expect(Number(order.subtotal).toFixed(2)).toBe('1000.00')
    // Lo que queda por cobrar es el total, no el total inflado.
    expect(Number(order.remainingBalance).toFixed(2)).toBe('1000.00')
  })

  it('no persiste impuesto separado ni en la orden ni en el renglón', async () => {
    await createOrderFromReservation(prismaMock as any, { reservationId: 'reservation-1', venueId: 'venue-1' })

    const order = (prismaMock.order.create as jest.Mock).mock.calls[0][0].data
    const item = (prismaMock.orderItem.create as jest.Mock).mock.calls[0][0].data

    // 🔴 `taxAmount = 0` no es cosmético: es lo que el CFDI lee para decidir que
    // el precio trae el IVA adentro y desglosarlo hacia atrás en vez de sumarlo.
    expect(Number(order.taxAmount)).toBe(0)
    expect(Number(item.taxAmount)).toBe(0)
    expect(Number(item.total).toFixed(2)).toBe('1000.00')
  })

  it('con modificadores y varios asientos, el cliente paga la suma de los precios de lista', async () => {
    prismaMock.reservation.findFirst.mockResolvedValue({
      id: 'reservation-1',
      productId: 'product-1',
      productIds: [],
      partySize: 3,
      tableId: null,
      customerId: null,
      guestName: 'Regina',
      guestPhone: null,
      guestEmail: null,
      specialRequests: null,
      assignedStaffId: null,
      modifiers: [{ productId: 'product-1', modifierId: 'mod-1', name: 'Esmalte', quantity: 1, price: new Prisma.Decimal(200) }],
    } as any)

    await createOrderFromReservation(prismaMock as any, { reservationId: 'reservation-1', venueId: 'venue-1' })

    const order = (prismaMock.order.create as jest.Mock).mock.calls[0][0].data
    // (1000 + 200) × 3 = 3600, sin un peso de impuesto encima.
    expect(Number(order.total).toFixed(2)).toBe('3600.00')
    expect(Number(order.taxAmount)).toBe(0)
  })
})
