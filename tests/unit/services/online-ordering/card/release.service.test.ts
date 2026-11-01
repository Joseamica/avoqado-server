// tests/unit/services/online-ordering/card/release.service.test.ts
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'

const voidAuthorization = jest.fn()
const getAuthorization = jest.fn()
jest.mock('@/services/payments/provider-registry', () => ({
  __esModule: true,
  getProvider: jest.fn(() => ({ voidAuthorization, getAuthorization })),
}))

import { logAction } from '@/services/dashboard/activity-log.service'
import { releaseCharge } from '@/services/online-ordering/card/release.service'

const CHARGE = {
  id: 'ch1',
  venueId: 'v1',
  onlineOrderId: 'oo1',
  onlineOrder: { orderId: 'ord1' },
  ecommerceMerchantId: 'em1',
  paymentIntentId: 'pi_1',
  amount: new Prisma.Decimal('250.00'),
  status: 'RELEASING',
  merchantSnapshot: { connectAccountId: 'acct_A', sandboxMode: true, providerCode: 'STRIPE_CONNECT' },
}

beforeEach(() => {
  voidAuthorization.mockReset()
  voidAuthorization.mockResolvedValue({ piStatus: 'canceled' })
  // r2 R1: si Stripe no la suelta, se relee el PaymentIntent; por omisión sigue apartado (no se cobró a mano).
  getAuthorization.mockReset()
  getAuthorization.mockResolvedValue({ piStatus: 'requires_capture' })
  prismaMock.onlineOrderCharge.findUnique.mockReset()
  prismaMock.onlineOrderCharge.findUnique.mockResolvedValue(CHARGE as any)
  prismaMock.onlineOrderCharge.updateMany.mockReset()
  prismaMock.onlineOrderCharge.updateMany.mockResolvedValue({ count: 1 })
})

describe('releaseCharge', () => {
  it('con pedido: clave online-order:<orderId>:release, cuenta de la foto, CAS RELEASING → RELEASED y bitácora', async () => {
    await expect(releaseCharge('ch1')).resolves.toBe('RELEASED')
    expect(voidAuthorization).toHaveBeenCalledWith(expect.objectContaining({ providerCredentials: { connectAccountId: 'acct_A' } }), {
      paymentIntentId: 'pi_1',
      idempotencyKey: 'online-order:ord1:release',
    })
    expect(prismaMock.onlineOrderCharge.updateMany).toHaveBeenCalledWith({
      where: { id: 'ch1', status: 'RELEASING' },
      data: { status: 'RELEASED', releasedAt: expect.any(Date), lastError: null },
    })
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'ONLINE_ORDER_CARD_RELEASED', venueId: 'v1' }))
  })

  it('sin pedido (liberación tardía): clave online-order-charge:<chargeId>:release', async () => {
    prismaMock.onlineOrderCharge.findUnique.mockResolvedValue({ ...CHARGE, onlineOrderId: null, onlineOrder: null } as any)
    await expect(releaseCharge('ch1')).resolves.toBe('RELEASED')
    expect(voidAuthorization.mock.calls[0][1].idempotencyKey).toBe('online-order-charge:ch1:release')
  })

  it('Stripe falla → STUCK con lastError, nunca lanza', async () => {
    voidAuthorization.mockRejectedValue(new Error('stripe caído'))
    await expect(releaseCharge('ch1')).resolves.toBe('STUCK')
    expect(prismaMock.onlineOrderCharge.updateMany).toHaveBeenCalledWith({
      where: { id: 'ch1', status: 'RELEASING' },
      data: { lastError: 'stripe caído' },
    })
  })

  it('ya RELEASED (el aviso de Stripe llegó antes) → RELEASED sin llamar a Stripe', async () => {
    prismaMock.onlineOrderCharge.findUnique.mockResolvedValue({ ...CHARGE, status: 'RELEASED' } as any)
    await expect(releaseCharge('ch1')).resolves.toBe('RELEASED')
    expect(voidAuthorization).not.toHaveBeenCalled()
  })
})
