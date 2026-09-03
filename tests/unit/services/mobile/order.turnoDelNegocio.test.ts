/**
 * Las órdenes del POS móvil (Android/iOS) nacen atadas al turno de caja del negocio.
 *
 * 🔴 El defecto (medido el 3-sep-2026): desde la fase 1 del turno del negocio, `getActiveShifts`
 * cuenta las órdenes de un turno agrupando por `Order.shiftId`, y `createOrderWithItems` del
 * móvil no lo escribía. Un negocio que vende SÓLO desde la tablet veía el dinero correcto y
 * «0 órdenes».
 *
 * Y los dos caminos de separar cheque, que son el caso interesante: ahí el turno **se HEREDA del
 * origen**, no se resuelve. Separar una cuenta a caballo de un cambio de turno partiría una sola
 * comida entre dos cortes; heredar copia un hecho, resolver inventaría uno.
 */
jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('@/services/mobile/comp-item.mobile.service', () => ({
  __esModule: true,
  recalculateOrderTotals: jest.fn().mockResolvedValue({ total: 0 }),
}))

import { Decimal } from '@prisma/client/runtime/library'
import { createOrderWithItems, splitOrderItems, splitOrderBySeat } from '@/services/mobile/order.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'
const TURNO = { venueId: VENUE, status: 'OPEN', endTime: null }

const PRODUCTO = {
  id: 'prod-1',
  name: 'Café',
  price: new Decimal(50),
  sku: 'CAF-1',
  soldByWeight: false,
  category: { name: 'Bebidas' },
}

/** Devuelve una orden mínima válida; las aserciones leen el PAYLOAD del create. */
function ecoDeCreacion() {
  prismaMock.order.create.mockImplementation(async (args: any) => ({
    id: 'order-1',
    orderNumber: 'ORD-1',
    status: 'CONFIRMED',
    paymentStatus: 'PENDING',
    subtotal: args.data.subtotal ?? new Decimal(0),
    discountAmount: args.data.discountAmount ?? new Decimal(0),
    taxAmount: new Decimal(0),
    total: args.data.total ?? new Decimal(0),
    version: 1,
    createdAt: new Date('2026-09-03T10:00:00.000Z'),
    items: (args.data.items?.create ?? []).map((it: any, i: number) => ({
      id: `oi-${i}`,
      productId: it.productId,
      productName: it.productName,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      total: it.total,
      discountAmount: it.discountAmount ?? new Decimal(0),
      appliedDiscountId: null,
      product: it.productId ? { id: it.productId, name: it.productName } : null,
      modifiers: [],
    })),
  }))
}

const datosDeLaOrden = () => (prismaMock.order.create as jest.Mock).mock.calls[0]?.[0]?.data

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
  prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1', venueId: VENUE } as any)
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: VENUE, active: true } as any)
  prismaMock.product.findMany.mockResolvedValue([PRODUCTO] as any)
  prismaMock.modifier.findMany.mockResolvedValue([])
  prismaMock.payment.findMany.mockResolvedValue([])
  ecoDeCreacion()
})

describe('createOrderWithItems (POS móvil) — cae en el turno del NEGOCIO', () => {
  const input = { staffId: 'staff-1', items: [{ productId: 'prod-1', quantity: 1 }], source: 'POS' } as any

  it('con turno abierto, la orden nace atada a ese turno', async () => {
    prismaMock.shift.findFirst.mockResolvedValue({ id: 'turno-negocio' } as any)

    await createOrderWithItems(VENUE, input)

    expect(datosDeLaOrden().shiftId).toBe('turno-negocio')
    // Por NEGOCIO, no por quien vende: el selector «Vendedor» cambia ese staffId en cada cobro.
    expect((prismaMock.shift.findFirst as jest.Mock).mock.calls[0][0].where).toEqual(TURNO)
  })

  it('sin turno abierto la venta SIGUE ocurriendo, con la orden sin turno', async () => {
    prismaMock.shift.findFirst.mockResolvedValue(null)

    await createOrderWithItems(VENUE, input)

    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
    expect(datosDeLaOrden().shiftId ?? null).toBeNull()
  })
})

describe('separar cheque — el turno se HEREDA del origen, no se resuelve', () => {
  function cuentaOrigen(shiftId: string | null, items: any[]) {
    return {
      id: 'order-origen',
      orderNumber: 'ORD-0',
      status: 'PENDING',
      paymentStatus: 'PENDING',
      tableId: 'mesa-1',
      covers: 4,
      servedById: 'staff-1',
      type: 'DINE_IN',
      paidAmount: new Decimal(0),
      shiftId,
      items,
      orderDiscounts: [],
      serviceCharges: [],
    }
  }

  it('splitOrderItems: el cheque nuevo lleva el turno del origen', async () => {
    prismaMock.order.findFirst.mockResolvedValue(
      cuentaOrigen('turno-de-la-comida', [
        { id: 'it-1', orderPromotionId: null },
        { id: 'it-2', orderPromotionId: null },
      ]) as any,
    )
    prismaMock.orderItem.updateMany.mockResolvedValue({ count: 1 } as any)

    await splitOrderItems(VENUE, 'order-origen', ['it-1'], 'staff-1')

    expect(datosDeLaOrden().shiftId).toBe('turno-de-la-comida')
    // 🔴 Y NO se consultó el turno abierto: heredar copia un hecho del origen; resolver
    // «el turno de ahora» partiría una misma mesa entre dos cortes.
    expect(prismaMock.shift.findFirst).not.toHaveBeenCalled()
  })

  it('splitOrderItems: si el origen no tiene turno, el hijo tampoco (no se inventa uno)', async () => {
    prismaMock.order.findFirst.mockResolvedValue(
      cuentaOrigen(null, [
        { id: 'it-1', orderPromotionId: null },
        { id: 'it-2', orderPromotionId: null },
      ]) as any,
    )
    prismaMock.orderItem.updateMany.mockResolvedValue({ count: 1 } as any)

    await splitOrderItems(VENUE, 'order-origen', ['it-1'], 'staff-1')

    expect(datosDeLaOrden().shiftId ?? null).toBeNull()
    expect(prismaMock.shift.findFirst).not.toHaveBeenCalled()
  })

  it('splitOrderBySeat: cada cheque por asiento hereda el turno del origen', async () => {
    prismaMock.order.findFirst.mockResolvedValue(
      cuentaOrigen('turno-de-la-comida', [
        { id: 'it-1', seat: 1 },
        { id: 'it-2', seat: 2 },
      ]) as any,
    )
    prismaMock.orderItem.updateMany.mockResolvedValue({ count: 1 } as any)

    await splitOrderBySeat(VENUE, 'order-origen', 'staff-1')

    expect(datosDeLaOrden().shiftId).toBe('turno-de-la-comida')
    expect(prismaMock.shift.findFirst).not.toHaveBeenCalled()
  })
})
