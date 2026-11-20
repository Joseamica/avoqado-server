/**
 * hz:e82938e1:D36: «Cobrar» de la TPV nueva declara al crear la venta si es para cobrarse en el momento (`payLater: false`) o un
 * «Pagar después» (`true`). Es lo que deja al SERVIDOR distinguir una cuenta abierta a propósito de una venta abandonada antes de
 * cobrar (`retirar-sin-cobro` sólo toca las `false`), y es la regla de «por cobrar» del 26-oct (`porCobrar.ts`). Una TPV vieja no lo
 * manda: queda `null`, como hoy.
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
import { createOrderWithItemsSchema } from '@/schemas/tpv.schema'

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
  prismaMock.shift.findFirst.mockResolvedValue(null)
  prismaMock.order.findUniqueOrThrow.mockResolvedValue({ id: 'order-1', orderNumber: 'ORD-1', table: null, items: [], payments: [] } as any)
})

describe('createOrderWithItems — la venta declara si es «Pagar después» (D36)', () => {
  it('«Cobrar» de la TPV nueva: payLater = false (se creó para cobrarse en el momento)', async () => {
    await createOrderWithItems(VENUE, { ...input, payLater: false })
    expect(datosDeLaOrden().payLater).toBe(false)
  })

  it('«Pagar después» de la TPV nueva: payLater = true (cuenta abierta a propósito)', async () => {
    await createOrderWithItems(VENUE, { ...input, payLater: true })
    expect(datosDeLaOrden().payLater).toBe(true)
  })

  it('TPV vieja (no lo manda): payLater = null, como hoy', async () => {
    await createOrderWithItems(VENUE, input)
    expect(datosDeLaOrden().payLater).toBeNull()
  })

  describe('reintento con la misma llave (Codex r1 #3: «Cobrar» perdió la respuesta y la cajera eligió «Pagar después»)', () => {
    beforeEach(() => {
      prismaMock.order.findUnique.mockResolvedValue({ id: 'order-1' } as any)
      prismaMock.order.updateMany.mockResolvedValue({ count: 1 } as any)
    })

    it('ahora pide «Pagar después»: la venta recuperada queda como fiado, sólo si sigue abierta, sin cobrar y declarada false', async () => {
      await createOrderWithItems(VENUE, { ...input, externalId: 'llave-1', payLater: true })
      expect(prismaMock.order.create).not.toHaveBeenCalled()
      expect(prismaMock.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'order-1', venueId: VENUE, payLater: false, status: 'PENDING', paymentStatus: 'PENDING', payments: { none: {} } },
        data: { payLater: true },
      })
    })

    it.each([[false], [undefined]])('con payLater=%s no se toca la venta recuperada', async payLater => {
      await createOrderWithItems(VENUE, { ...input, externalId: 'llave-1', payLater })
      expect(prismaMock.order.updateMany).not.toHaveBeenCalled()
    })
  })

  it('el esquema lo acepta opcional y rechaza lo que no es booleano', () => {
    const base = {
      params: { venueId: 'cmhabcdefghijklmnopqrstuv' },
      body: {
        items: [{ productId: 'cmhzyxwvutsrqponmlkjihgfe', quantity: 1 }],
        staffId: 'cmhzyxwvutsrqponmlkjihgff',
        taxAmount: 0,
        subtotal: 1,
        total: 1,
      },
    }
    expect(createOrderWithItemsSchema.safeParse(base).success).toBe(true)
    const conFalse = createOrderWithItemsSchema.safeParse({ ...base, body: { ...base.body, payLater: false } })
    expect(conFalse.success && conFalse.data.body.payLater).toBe(false)
    expect(createOrderWithItemsSchema.safeParse({ ...base, body: { ...base.body, payLater: 'sí' } }).success).toBe(false)
  })
})
