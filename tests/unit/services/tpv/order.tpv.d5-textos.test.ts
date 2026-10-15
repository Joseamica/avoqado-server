/**
 * D5 v3 (Codex P3, 15-oct): el tope de 500 es SÓLO para `OrderItem.notes`. La nota general de la orden
 * (`specialRequests`) y el motivo de la cortesía (`cortesiaReason`) vuelven a sólo `trim`: la cortesía tiene que decir
 * lo mismo en `OrderItem`, `OrderDiscount.compReason` y la bitácora `OrderAction`, que guardan el motivo completo.
 */
import { prismaMock } from '../../../__helpers__/setup'

jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn().mockReturnValue(null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ __esModule: true, logAction: jest.fn() }))
jest.mock('@/services/kds/kitchenDisplayStations', () => ({ debeMarcarCocina: jest.fn().mockResolvedValue(false) }))
jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({ armarComandasTrasCommit: jest.fn().mockResolvedValue(undefined) }))

import { createOrderWithItems } from '@/services/tpv/order.tpv.service'
import { capItemNote } from '@/services/shared/inputCaps'

beforeEach(() => {
  jest.clearAllMocks()
  ;(prismaMock as any).orderAction ??= { create: jest.fn() }
  prismaMock.order.findUnique.mockResolvedValue(null)
  prismaMock.order.create.mockResolvedValue({ id: 'order-1', orderNumber: 'ORD-1', table: null, items: [], payments: [] } as any)
  prismaMock.staffVenue.findUnique.mockResolvedValue({ active: true, staff: { id: 'staff-1', active: true } } as any)
  prismaMock.product.findMany.mockResolvedValue([{ id: 'p1', name: 'Café', price: 100, category: { name: 'Bebidas' } }] as any)
  prismaMock.modifier.findMany.mockResolvedValue([])
  prismaMock.discount.findMany.mockResolvedValue([])
  prismaMock.orderItem.create.mockResolvedValue({ id: 'oi-1' } as any)
  prismaMock.payment.create.mockResolvedValue({ id: 'payment-free' } as any)
  prismaMock.paymentAllocation.create.mockResolvedValue({ id: 'allocation-free' } as any)
  ;(prismaMock as any).orderAction.create.mockResolvedValue({ id: 'action-free' } as any)
  prismaMock.shift.findFirst.mockResolvedValue(null)
  prismaMock.order.findUniqueOrThrow.mockResolvedValue({ id: 'order-1', orderNumber: 'ORD-1', table: null, items: [], payments: [] } as any)
})

describe('createOrderWithItems (TPV) — D5 v3: sólo la nota del artículo lleva tope', () => {
  it('🔴 specialRequests y cortesiaReason largos se guardan COMPLETOS (sólo trim); la nota del artículo, recortada', async () => {
    const notaDeOrden = 'x'.repeat(800)
    const motivo = 'r'.repeat(800)
    const notaDeArticulo = 'n'.repeat(800)

    await createOrderWithItems('venue-1', {
      items: [{ productId: 'p1', quantity: 1, unitPrice: 100, isCortesia: true, cortesiaReason: `  ${motivo} `, notes: notaDeArticulo }],
      staffId: 'staff-1',
      taxAmount: 0,
      subtotal: 100,
      total: 0,
      tip: 0,
      note: `  ${notaDeOrden}  `,
    } as any)

    expect((prismaMock.order.create as jest.Mock).mock.calls[0][0].data.specialRequests).toBe(notaDeOrden)
    const renglon = (prismaMock.orderItem.create as jest.Mock).mock.calls[0][0].data
    expect(renglon.cortesiaReason).toBe(motivo)
    expect(renglon.notes).toBe(capItemNote(notaDeArticulo))
    expect(renglon.notes).toMatch(/…[0-9a-f]{8}$/)
  })
})
