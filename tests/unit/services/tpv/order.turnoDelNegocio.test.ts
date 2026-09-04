/**
 * Las órdenes que la TPV abre en el MOSTRADOR nacen atadas al turno de caja del negocio.
 *
 * 🔴 El defecto (medido el 3-sep-2026): desde la fase 1 del turno del negocio, `getActiveShifts`
 * (`dashboard/shared-query.service.ts`) cuenta las órdenes de un turno agrupando por
 * `Order.shiftId` — y de los 22 sitios que crean órdenes, sólo la venta rápida lo escribía. El
 * caso más caro era `createOrderWithItems`: **ya resolvía el turno** (lo usa para el `Payment`
 * del carrito gratis) y aun así no lo estampaba en la orden. Un turno enseñaba el dinero correcto
 * y «0 órdenes».
 *
 * Aquí se cubren los tres sitios de `order.tpv.service.ts` y el de `table.tpv.service.ts`. En los
 * cuatro el turno es OPCIONAL: un negocio que no abrió caja tiene que poder vender igual.
 */
import { prismaMock } from '../../../__helpers__/setup'

const assertVenueSalesEnabledMock = jest.fn()
jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: (...args: unknown[]) => assertVenueSalesEnabledMock(...args),
}))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn().mockReturnValue(null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({
  __esModule: true,
  logAction: jest.fn(),
}))

import { createOrder, createOrderWithItems } from '@/services/tpv/order.tpv.service'
import { assignTable } from '@/services/tpv/table.tpv.service'

const VENUE = 'venue-1'
const TURNO = { venueId: VENUE, status: 'OPEN', endTime: null }

/** Lo que de verdad se persistió en la orden (el primer `order.create` de la corrida). */
const datosDeLaOrden = () => (prismaMock.order.create as jest.Mock).mock.calls[0]?.[0]?.data

beforeEach(() => {
  jest.clearAllMocks()
  assertVenueSalesEnabledMock.mockResolvedValue(undefined)
  prismaMock.order.findUnique.mockResolvedValue(null)
  prismaMock.order.create.mockResolvedValue({ id: 'order-1', orderNumber: 'ORD-1', table: null, items: [], payments: [] } as any)
})

describe('createOrder (orden de mostrador) — cae en el turno del NEGOCIO', () => {
  it('con turno abierto, la orden nace atada a ese turno', async () => {
    prismaMock.shift.findFirst.mockResolvedValue({ id: 'turno-negocio' } as any)

    await createOrder(VENUE, { orderType: 'TAKEOUT' } as any)

    expect(datosDeLaOrden().shiftId).toBe('turno-negocio')
    // Por NEGOCIO, no por quien la abre: el selector «Vendedor» cambia ese staffId en cada cobro.
    expect((prismaMock.shift.findFirst as jest.Mock).mock.calls[0][0].where).toEqual(TURNO)
  })

  it('sin turno abierto la orden SE CREA igual, sin turno', async () => {
    prismaMock.shift.findFirst.mockResolvedValue(null)

    await createOrder(VENUE, { orderType: 'TAKEOUT' } as any)

    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
    expect(datosDeLaOrden().shiftId ?? null).toBeNull()
  })
})

describe('createOrderWithItems (TPV Cobrar) — la orden y su cobro comparten turno', () => {
  const input = {
    items: [{ productId: 'p1', quantity: 1, unitPrice: 100 }],
    staffId: 'staff-1',
    taxAmount: 0,
    subtotal: 100,
    total: 100,
    tip: 0,
  } as any

  beforeEach(() => {
    // `prismaMock` enumera modelos; este flujo de cortesía usa OrderAction pero el helper global
    // todavía no lo declara. Se añade sólo para esta prueba, sin ampliar el mock compartido.
    ;(prismaMock as any).orderAction ??= { create: jest.fn() }
    prismaMock.staffVenue.findUnique.mockResolvedValue({ active: true, staff: { id: 'staff-1', active: true } } as any)
    prismaMock.product.findMany.mockResolvedValue([{ id: 'p1', name: 'Café', price: 100, category: { name: 'Bebidas' } }] as any)
    prismaMock.modifier.findMany.mockResolvedValue([])
    prismaMock.discount.findMany.mockResolvedValue([])
    prismaMock.orderItem.create.mockResolvedValue({ id: 'oi-1' } as any)
    prismaMock.payment.create.mockResolvedValue({ id: 'payment-free' } as any)
    prismaMock.paymentAllocation.create.mockResolvedValue({ id: 'allocation-free' } as any)
    ;(prismaMock as any).orderAction.create.mockResolvedValue({ id: 'action-free' } as any)
    prismaMock.order.findUniqueOrThrow.mockResolvedValue({
      id: 'order-1',
      orderNumber: 'ORD-1',
      table: null,
      items: [],
      payments: [],
    } as any)
  })

  it('con turno abierto, la orden lo lleva — y el turno se leyó UNA sola vez', async () => {
    prismaMock.shift.findFirst.mockResolvedValue({ id: 'turno-negocio' } as any)

    await createOrderWithItems(VENUE, input)

    expect(datosDeLaOrden().shiftId).toBe('turno-negocio')
    // 🔴 Se REUSA el turno ya resuelto en esa transacción (el mismo que estampa el `Payment` del
    // carrito gratis). Una segunda consulta podría devolver otro turno si alguien cierra caja en
    // medio, y entonces la orden y su cobro caerían en turnos distintos.
    expect(prismaMock.shift.findFirst).toHaveBeenCalledTimes(1)
    expect((prismaMock.shift.findFirst as jest.Mock).mock.calls[0][0].where).toEqual(TURNO)
  })

  it('sin turno abierto la venta SIGUE ocurriendo, con la orden sin turno', async () => {
    prismaMock.shift.findFirst.mockResolvedValue(null)

    await createOrderWithItems(VENUE, input)

    expect(prismaMock.order.create).toHaveBeenCalledTimes(1)
    expect(datosDeLaOrden().shiftId ?? null).toBeNull()
  })

  describe('carrito gratis — el claim de pertenencia no mueve un CLOSING', () => {
    const gratis = {
      ...input,
      items: [{ productId: 'p1', quantity: 1, unitPrice: 100, isCortesia: true, cortesiaReason: 'Invitación' }],
      total: 0,
    } as any

    it('si pierde el CAS contra CLOSING, crea Order y Payment sin turno y no toca updatedAt', async () => {
      const claimedAt = new Date('2026-09-03T22:00:00.000Z')
      const shift = { id: 'turno-negocio', status: 'OPEN', endTime: null, updatedAt: claimedAt }
      prismaMock.shift.findFirst.mockResolvedValue(shift as any)
      prismaMock.shift.updateMany.mockImplementation(async () => {
        // Estado que ya dejó el cierre mientras esta transacción preparaba el carrito.
        shift.status = 'CLOSING'
        return { count: 0 } as any
      })

      await createOrderWithItems(VENUE, gratis)

      expect(prismaMock.shift.updateMany).toHaveBeenCalledWith({
        where: { id: 'turno-negocio', venueId: VENUE, status: 'OPEN', endTime: null },
        data: { totalOrders: { increment: 1 } },
      })
      expect(datosDeLaOrden().shiftId ?? null).toBeNull()
      expect(prismaMock.payment.create.mock.calls[0][0].data.shiftId ?? null).toBeNull()
      expect(prismaMock.shift.update).not.toHaveBeenCalled()
      expect(shift.updatedAt).toBe(claimedAt)
    })

    it('si gana el CAS, estampa el mismo turno en Order/Payment e incrementa una sola vez', async () => {
      prismaMock.shift.findFirst.mockResolvedValue({ id: 'turno-negocio' } as any)
      prismaMock.shift.updateMany.mockResolvedValue({ count: 1 } as any)

      await createOrderWithItems(VENUE, gratis)

      expect(datosDeLaOrden().shiftId).toBe('turno-negocio')
      expect(prismaMock.payment.create.mock.calls[0][0].data.shiftId).toBe('turno-negocio')
      expect(prismaMock.shift.updateMany).toHaveBeenCalledTimes(1)
      expect(prismaMock.shift.update).not.toHaveBeenCalled()
    })
  })
})

describe('assignTable (abrir mesa) — cae en el turno del NEGOCIO', () => {
  beforeEach(() => {
    prismaMock.table.findFirst.mockResolvedValue({ id: 'mesa-1', number: 4, status: 'AVAILABLE', currentOrder: null } as any)
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staff: { id: 'staff-1' } } as any)
    prismaMock.order.updateMany.mockResolvedValue({ count: 0 } as any)
    prismaMock.table.update.mockResolvedValue({ id: 'mesa-1' } as any)
  })

  it('con turno abierto, la cuenta de la mesa nace atada a ese turno', async () => {
    prismaMock.shift.findFirst.mockResolvedValue({ id: 'turno-negocio' } as any)

    await assignTable(VENUE, 'mesa-1', 'staff-1', 2, null)

    expect(datosDeLaOrden().shiftId).toBe('turno-negocio')
    expect((prismaMock.shift.findFirst as jest.Mock).mock.calls[0][0].where).toEqual(TURNO)
  })

  it('sin turno abierto la mesa SE ABRE igual, sin turno', async () => {
    prismaMock.shift.findFirst.mockResolvedValue(null)

    const { isNewOrder } = await assignTable(VENUE, 'mesa-1', 'staff-1', 2, null)

    expect(isNewOrder).toBe(true)
    expect(datosDeLaOrden().shiftId ?? null).toBeNull()
  })
})
