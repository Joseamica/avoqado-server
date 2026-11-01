// Pedidos en línea fase 2 (T8): cancelar desde la caja una cuenta pagada con tarjeta en línea.
import { Prisma } from '@prisma/client'
import { assertOrderCancellableUnderLock } from '@/services/shared/orderCancelGuard'
import { prismaMock } from '../../../__helpers__/setup'

jest.mock('@/services/terminal-payment.service', () => ({
  terminalPaymentService: { findChargeBlockingOrderCancel: jest.fn().mockResolvedValue(null) },
}))

const input = { venueId: 'v1', orderId: 'o1' }
const orden = {
  id: 'o1',
  source: 'WEB',
  posRawData: null,
  paymentStatus: 'PENDING',
  status: 'PENDING',
  version: 1,
  paidAmount: new Prisma.Decimal(0),
  tipAmount: new Prisma.Decimal(0),
}
const pedido = (status: string | null, paymentMode = 'CARD_ONLINE') =>
  ({ paymentMode, charge: status ? { id: 'ch1', status, paymentIntentId: 'pi_1' } : null }) as any

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.$queryRaw.mockResolvedValue([{ id: 'o1' }])
  prismaMock.order.findUnique.mockResolvedValue(orden as any)
  prismaMock.onlineOrderCharge.updateMany.mockResolvedValue({ count: 1 })
})

describe('cancelar un pedido con tarjeta desde la caja', () => {
  it('con el cargo CAPTURING → 409 ONLINE_ORDER_CONFIRMING_PAYMENT y nada cambia', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue(pedido('CAPTURING'))
    await expect(assertOrderCancellableUnderLock(prismaMock, input)).rejects.toMatchObject({
      statusCode: 409,
      code: 'ONLINE_ORDER_CONFIRMING_PAYMENT',
      message: 'Confirmando el pago con tarjeta de este pedido. Intenta en unos segundos.',
    })
    expect(prismaMock.onlineOrderCharge.updateMany).not.toHaveBeenCalled()
  })

  it('con el cargo AUTHORIZED → se cancela y el cargo queda RELEASING en la misma transacción', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue(pedido('AUTHORIZED'))
    await expect(assertOrderCancellableUnderLock(prismaMock, input)).resolves.toMatchObject({ id: 'o1' })
    expect(prismaMock.onlineOrderCharge.updateMany).toHaveBeenCalledWith({
      where: { id: 'ch1', status: 'AUTHORIZED' },
      data: { status: 'RELEASING' },
    })
  })

  it('pagar al recoger (regresión): se cancela como hoy sin tocar cargos', async () => {
    prismaMock.onlineOrder.findFirst.mockResolvedValue(pedido(null, 'PAY_AT_PICKUP'))
    await expect(assertOrderCancellableUnderLock(prismaMock, input)).resolves.toMatchObject({ id: 'o1' })
    expect(prismaMock.onlineOrderCharge.updateMany).not.toHaveBeenCalled()
  })
})
