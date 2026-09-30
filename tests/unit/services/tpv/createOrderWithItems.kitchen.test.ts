/**
 * Etapa 3 del KDS: un carrito GRATIS de «Cobrar» nace pagado en su propia transacción, así que es ahí donde se
 * marca y, tras el commit, se arma su comanda de pantalla. Un carrito con precio espera a su cobro.
 */
import { prismaMock } from '../../../__helpers__/setup'

jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn().mockReturnValue(null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ __esModule: true, logAction: jest.fn() }))
const debeMarcarCocinaMock = jest.fn()
jest.mock('@/services/kds/kitchenDisplayStations', () => ({ debeMarcarCocina: (...a: unknown[]) => debeMarcarCocinaMock(...a) }))
const armarMock = jest.fn().mockResolvedValue(undefined)
jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({ armarComandasTrasCommit: (...a: unknown[]) => armarMock(...a) }))

import { createOrderWithItems } from '@/services/tpv/order.tpv.service'

const VENUE = 'venue-1'
const datosDeLaOrden = () => (prismaMock.order.create as jest.Mock).mock.calls[0]?.[0]?.data
const input = {
  items: [{ productId: 'p1', quantity: 1, unitPrice: 100 }],
  staffId: 'staff-1',
  taxAmount: 0,
  subtotal: 100,
  total: 100,
  tip: 0,
} as any
const gratis = {
  ...input,
  items: [{ productId: 'p1', quantity: 1, unitPrice: 100, isCortesia: true, cortesiaReason: 'Invitación' }],
  total: 0,
} as any

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

describe('createOrderWithItems — comanda de pantalla del carrito gratis', () => {
  it('carrito gratis con pantalla: la orden nace marcada y la comanda se arma tras el commit', async () => {
    debeMarcarCocinaMock.mockResolvedValue(true)
    await createOrderWithItems(VENUE, gratis)
    expect(datosDeLaOrden().kitchenPendingAt).toBeInstanceOf(Date)
    expect(armarMock).toHaveBeenCalledWith(VENUE, 'order-1', 'PAID')
  })

  it('carrito con precio: ni se pregunta — la comanda espera a su cobro', async () => {
    debeMarcarCocinaMock.mockResolvedValue(true)
    await createOrderWithItems(VENUE, input)
    expect(debeMarcarCocinaMock).not.toHaveBeenCalled()
    expect(datosDeLaOrden().kitchenPendingAt).toBeUndefined()
    expect(armarMock).not.toHaveBeenCalled()
  })
})
