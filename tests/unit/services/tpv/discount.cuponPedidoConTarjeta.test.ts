// Pedidos en línea fase 2 (T8, fix r1): el cupón de la TPV toma su propio candado de la Order y reescribe el total; un pedido de
// tarjeta sin cobrar tiene un total fijo, así que ni lo lee ni lo escribe.
import { Prisma } from '@prisma/client'
import { prismaMock } from '../../../__helpers__/setup'
import { applyCouponCode } from '@/services/tpv/discount.tpv.service'

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.$queryRaw.mockResolvedValue([{ id: 'o-web' }])
  prismaMock.order.findUnique.mockResolvedValue({
    id: 'o-web',
    venueId: 'v1',
    paymentStatus: 'PENDING',
    subtotal: new Prisma.Decimal(250),
    total: new Prisma.Decimal(250),
    orderDiscounts: [],
  } as any)
})

it('aplicar un cupón a un pedido de tarjeta sin cobrar → 409 ONLINE_ORDER_PAID_BY_CARD y nada se escribe', async () => {
  prismaMock.onlineOrder.findFirst.mockResolvedValue({
    paymentMode: 'CARD_ONLINE',
    charge: { id: 'ch1', status: 'AUTHORIZED', paymentIntentId: 'pi_1' },
  } as any)
  await expect(applyCouponCode('v1', 'o-web', 'DIEZ', 'sv1')).rejects.toMatchObject({
    statusCode: 409,
    code: 'ONLINE_ORDER_PAID_BY_CARD',
  })
  expect(prismaMock.order.findUnique).not.toHaveBeenCalled()
  expect(prismaMock.order.update).not.toHaveBeenCalled()
  expect(prismaMock.orderDiscount.create).not.toHaveBeenCalled()
})
