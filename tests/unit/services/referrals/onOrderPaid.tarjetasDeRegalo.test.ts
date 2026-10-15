import { prismaMock } from '@tests/__helpers__/setup'
import { onOrderPaid } from '@/services/referrals/referralQualification.service'

describe('onOrderPaid · tarjetas de regalo (R1)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.order.findUnique.mockResolvedValue({ paymentStatus: 'PAID' })
    // Sin devoluciones y sin referido que reclamar: así, sin la guardia, la prueba llega al reclamo (`referral.updateMany`) y
    // falla por la razón correcta, no por un doble incompleto.
    prismaMock.payment.findMany.mockResolvedValue([])
    prismaMock.referral.updateMany.mockResolvedValue({ count: 0 })
  })

  it('🔴 la venta de tarjetas no califica un referido (queda PENDING para la primera compra real)', async () => {
    prismaMock.orderItem.findFirst.mockResolvedValueOnce({ id: 'oi-gc' }).mockResolvedValueOnce(null)
    await onOrderPaid({ orderId: 'o-gc', venueId: 'v1' })
    expect(prismaMock.referral.updateMany).not.toHaveBeenCalled()
  })
})
