import { prismaMock } from '@tests/__helpers__/setup'

const mockWrite = jest.fn()
jest.mock('@/services/online-ordering/order.service', () => ({
  __esModule: true,
  TX_OPTIONS: {},
  emitOnlineOrderCreated: jest.fn(),
  lockAdmission: jest.fn(),
  pickOrderNumber: jest.fn(async () => '0001'),
  writeOnlineOrderInTx: (...a: unknown[]) => mockWrite(...a),
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ __esModule: true, logAction: jest.fn() }))
jest.mock('@/services/payments/provider-registry', () => ({
  __esModule: true,
  getProvider: () => ({
    getAuthorization: async () => ({ piStatus: 'requires_capture', paymentIntentId: 'pi_1', amountCapturableCents: 25000, captureBefore: new Date() }),
  }),
}))

import { confirmCardAuthorization } from '@/services/online-ordering/card/confirm.service'

/** T8: un borrador de tarjeta creado ANTES del cambio (la tienda ya pasó a «Nadie») se confirma y nace «Mi equipo»: requiresAcceptance true. */
describe('confirmar un borrador de tarjeta anterior al cambio', () => {
  it('el pedido nace con requiresAcceptance true aunque la tienda esté hoy en «Nadie»', async () => {
    prismaMock.onlineOrderCharge.findUnique.mockResolvedValue({
      id: 'ch1',
      venueId: 'v1',
      status: 'PENDING_AUTH',
      lastError: null,
      checkoutSessionId: 'cs_1',
      ecommerceMerchantId: 'm1',
      merchantSnapshot: { connectAccountId: 'acct_1', sandboxMode: true, providerCode: 'STRIPE_CONNECT' },
      amount: '250.00',
      trackingToken: 't',
      requestHash: 'h',
      request: { externalId: 'web:k', quote: {}, customer: { name: 'A', phone: '+5255' }, note: null, whatsappConsent: false },
    } as any)
    ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prismaMock))
    prismaMock.onlineOrderCharge.updateMany.mockResolvedValue({ count: 1 } as any)
    prismaMock.onlineOrderCharge.update.mockResolvedValue({} as any)
    mockWrite.mockResolvedValue({ orderId: 'o1', onlineOrderId: 'oo1' })

    expect(await confirmCardAuthorization('ch1')).toBe('CREATED')
    expect(mockWrite).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ requiresAcceptance: true }))
  })
})
