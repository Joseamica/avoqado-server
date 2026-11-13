/**
 * `releaseScheduledOrder` — la comanda de un programado nace IGUAL que la de la ingesta inmediata: con `productId` y
 * `categoryId` (sin ellos el POS no rutea a su estación ni reconoce «Sin comanda») y con la nota y los modificadores
 * del renglón («sin cebolla» no se pierde).
 */
import prisma from '@/utils/prismaClient'
import { releaseScheduledOrder } from '@/services/delivery-channels/core/releaseScheduledOrder.service'

jest.mock('@/services/kds/kitchenDisplayStations', () => ({ estacionDePantallaParaReparto: jest.fn().mockResolvedValue('est1') }))
jest.mock('@/services/shared/paymentShiftClaim', () => ({ lockExistingOrderForPayment: jest.fn().mockResolvedValue(true) }))
jest.mock('@/services/delivery-channels/core/lineRemoval.service', () => ({ marcarRetirosEnComandas: jest.fn() }))

describe('releaseScheduledOrder · renglones de la comanda', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prisma))
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValue([])
    ;(prisma.order.findFirst as jest.Mock).mockResolvedValue({
      id: 'o1',
      venueId: 'v1',
      orderNumber: 'A1',
      scheduledFor: new Date(),
      customerName: null,
      customerPhone: null,
      customerPhonePin: null,
    })
    ;(prisma.order.findUnique as jest.Mock).mockResolvedValue({ status: 'CONFIRMED' })
    ;(prisma.kdsOrder.count as jest.Mock).mockResolvedValue(0)
    ;(prisma.orderItem.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'i1',
        productName: 'Taco',
        quantity: 2,
        externalLineId: 'L1',
        productId: 'p1',
        notes: 'sin cebolla',
        modifiers: [{ name: 'Extra queso', quantity: 2 }],
      },
      { id: 'i2', productName: 'Cerveza', quantity: 1, externalLineId: null, productId: 'p2', notes: null, modifiers: [] },
    ])
    ;(prisma.product.findMany as jest.Mock).mockResolvedValue([
      { id: 'p1', categoryId: 'c1' },
      { id: 'p2', categoryId: 'c2' },
    ])
  })

  it('cada renglón lleva productId, categoryId, nota y modificadores, con UNA sola consulta de categorías', async () => {
    const r = await releaseScheduledOrder('ext1')
    expect(r.outcome).toBe('RELEASED')

    const filas = (prisma.kdsOrder.create as jest.Mock).mock.calls[0][0].data.items.create
    expect(filas).toEqual([
      expect.objectContaining({ orderItemId: 'i1', productId: 'p1', categoryId: 'c1', notes: 'sin cebolla', modifiers: '["2x Extra queso"]' }),
      expect.objectContaining({ orderItemId: 'i2', productId: 'p2', categoryId: 'c2', notes: null, modifiers: null }),
    ])
    expect(prisma.product.findMany).toHaveBeenCalledTimes(1)
  })
})
