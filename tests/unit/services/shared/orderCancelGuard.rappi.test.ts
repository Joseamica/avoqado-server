import { Prisma } from '@prisma/client'
import { assertOrderCancellableUnderLock } from '@/services/shared/orderCancelGuard'
import { prismaMock } from '../../../__helpers__/setup'

jest.mock('@/services/terminal-payment.service', () => ({
  terminalPaymentService: { findChargeBlockingOrderCancel: jest.fn().mockResolvedValue(null) },
}))

describe('cancelación genérica: Rappi conserva la autoridad sobre su pedido', () => {
  const input = { venueId: 'v1', orderId: 'o1' }
  const orden = (source = 'RAPPI', paymentStatus = 'PENDING', raw: unknown = null) => ({
    id: 'o1',
    source,
    posRawData: raw,
    paymentStatus,
    status: 'CONFIRMED',
    version: 1,
    paidAmount: new Prisma.Decimal(0),
    tipAmount: new Prisma.Decimal(0),
  })

  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'o1' }])
  })

  // Sin la guarda, estas llamadas regresan una orden cancelable o el texto genérico de reembolso.
  it.each([
    ['marketplace', 'PENDING', /app de Rappi para aliados/],
    [' PICKUP ', 'PENDING', /app de Rappi para aliados/],
    ['full_service', 'PENDING', /soporte de Rappi/],
    ['desconocido', 'PARTIAL', /soporte de Rappi/],
    ['marketplace', 'PAID', /app de Rappi para aliados/],
  ])('%s/%s: rechaza con una salida real y sin tocar datos', async (metodo, pago, mensaje) => {
    prismaMock.order.findUnique.mockResolvedValue(orden('RAPPI', pago as string, { order_detail: { delivery_method: metodo } }))
    await expect(assertOrderCancellableUnderLock(prismaMock, input)).rejects.toMatchObject({
      statusCode: 400,
      code: 'RAPPI_CANCEL_IN_PROVIDER',
      message: expect.stringMatching(mensaje as RegExp),
    })
    expect(prismaMock.order.update).not.toHaveBeenCalled()
  })

  it('un pedido Rappi antiguo sin raw sigue mandando al soporte, sin inventar quién entrega', async () => {
    prismaMock.order.findUnique.mockResolvedValue(orden())
    await expect(assertOrderCancellableUnderLock(prismaMock, input)).rejects.toMatchObject({
      code: 'RAPPI_CANCEL_IN_PROVIDER',
      message: expect.stringContaining('soporte de Rappi'),
    })
  })

  it.each(['TPV', 'AVOQADO_ANDROID', 'UBER_EATS'])('control: %s sin dinero conserva su cancelación genérica', async source => {
    prismaMock.order.findUnique.mockResolvedValue(orden(source))
    await expect(assertOrderCancellableUnderLock(prismaMock, input)).resolves.toMatchObject({ id: 'o1' })
  })

  it('control: una cuenta normal con dinero conserva el rechazo de reembolso', async () => {
    prismaMock.order.findUnique.mockResolvedValue(orden('TPV', 'PARTIAL'))
    await expect(assertOrderCancellableUnderLock(prismaMock, input)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('Reembólsalos'),
    })
  })
})
