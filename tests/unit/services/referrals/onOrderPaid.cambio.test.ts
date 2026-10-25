/**
 * La venta nueva de un cambio no es una compra nueva: no califica un referido (spec §7.6). `onOrderPaid` es la función que
 * comparten el efecto durable y los llamadores directos (la terminal, el cobro en efectivo del POS, la liga tardía del cliente),
 * así que la guarda vive aquí. Sólo se salta el premio; lo demás corre como siempre.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { onOrderPaid } from '@/services/referrals/referralQualification.service'

describe('onOrderPaid · the new sale of an exchange', () => {
  beforeEach(() => {
    prismaMock.order.findUnique.mockResolvedValue({ status: 'COMPLETED', paymentStatus: 'PAID', total: 100, tipAmount: 0 })
    // Sin devoluciones y sin referido que reclamar: así la prueba llega al reclamo (`referral.updateMany`).
    prismaMock.payment.findMany.mockResolvedValue([])
    prismaMock.referral.updateMany.mockResolvedValue({ count: 0 })
  })

  it('does not grant the referral for the new order of an exchange', async () => {
    prismaMock.exchange.findUnique.mockResolvedValue({ id: 'exch-1' })
    await onOrderPaid({ orderId: 'o-new', venueId: 'v1' })
    expect(prismaMock.exchange.findUnique).toHaveBeenCalledWith({ where: { newOrderId: 'o-new' }, select: { id: true } })
    expect(prismaMock.referral.updateMany).not.toHaveBeenCalled()
  })

  it('still grants the referral for an ordinary order', async () => {
    prismaMock.exchange.findUnique.mockResolvedValue(null)
    await onOrderPaid({ orderId: 'o-1', venueId: 'v1' })
    expect(prismaMock.referral.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { qualifyingOrderId: 'o-1', status: 'PENDING' } }),
    )
  })

  it('control: a fully refunded ordinary order is voided instead of qualifying', async () => {
    prismaMock.exchange.findUnique.mockResolvedValue(null)
    prismaMock.payment.findMany.mockResolvedValue([{ amount: -100 }])
    await onOrderPaid({ orderId: 'o-1', venueId: 'v1' })
    expect(prismaMock.referral.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'VOID', voidReason: 'ORDER_REFUNDED' }),
      }),
    )
  })
})
