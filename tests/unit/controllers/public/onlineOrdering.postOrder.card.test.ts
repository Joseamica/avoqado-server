// tests/unit/controllers/public/onlineOrdering.postOrder.card.test.ts
jest.mock('@/services/online-ordering/order.service', () => ({
  __esModule: true,
  createOnlineOrder: jest.fn(async () => ({ trackingToken: 'T'.repeat(32), replay: false })),
  getTrackingByToken: jest.fn(),
}))
jest.mock('@/services/online-ordering/card/draft.service', () => ({
  __esModule: true,
  createCardOnlineDraft: jest.fn(async () => ({
    trackingToken: 'T'.repeat(32),
    checkoutUrl: 'https://checkout.stripe.test/cs_1',
    status: 'AWAITING_PAYMENT',
    total: '250.00',
    replay: false,
  })),
}))

import AppError from '@/errors/AppError'
import { postOrder } from '@/controllers/public/onlineOrdering.public.controller'
import { createOnlineOrder } from '@/services/online-ordering/order.service'
import { createCardOnlineDraft } from '@/services/online-ordering/card/draft.service'

const KEY = 'c'.repeat(32)
const res = () => {
  const r: any = {}
  r.status = jest.fn(() => r)
  r.json = jest.fn(() => r)
  return r
}
const req = (paymentMode: string, customerAuth: unknown = null) =>
  ({
    publicVenue: { id: 'v1', slug: 'flautas' },
    header: (n: string) => (n === 'Idempotency-Key' ? KEY : undefined),
    customerAuth,
    body: {
      items: [{ productId: 'p1', quantity: 1 }],
      paymentMode,
      expectedTotal: '250.00',
      customer: { name: 'María', phone: '5543453965' },
      whatsappConsent: true,
    },
  }) as any

describe('POST /orders despacha por paymentMode', () => {
  it('CARD_ONLINE no exige OTP: sin customerAuth crea el borrador y responde 201', async () => {
    const r = res()
    await postOrder(req('CARD_ONLINE'), r)
    expect(createCardOnlineDraft).toHaveBeenCalledWith(
      {
        venueId: 'v1',
        venueSlug: 'flautas',
        idempotencyKey: KEY,
        items: [{ productId: 'p1', quantity: 1 }],
        expectedTotal: '250.00',
        customer: { name: 'María', phone: '5543453965', email: null },
        note: null,
        whatsappConsent: true,
      },
      { assertCanCreate: expect.any(Function) },
    )
    expect(createOnlineOrder).not.toHaveBeenCalled()
    expect(r.status).toHaveBeenCalledWith(201)
    expect(r.json).toHaveBeenCalledWith({
      success: true,
      data: expect.objectContaining({ checkoutUrl: 'https://checkout.stripe.test/cs_1' }),
    })
  })

  it('PAY_AT_PICKUP sigue en createOnlineOrder', async () => {
    ;(createCardOnlineDraft as jest.Mock).mockClear()
    await postOrder(req('PAY_AT_PICKUP'), res())
    expect(createOnlineOrder).toHaveBeenCalled()
    expect(createCardOnlineDraft).not.toHaveBeenCalled()
  })

  it('T7: PAY_AT_PICKUP pasa el canal (QR o liga) y acepta el pedido sin teléfono («Nadie»)', async () => {
    ;(createOnlineOrder as jest.Mock).mockClear()
    const r = req('PAY_AT_PICKUP')
    r.body.channel = 'QR'
    r.body.customer = { name: 'María' }
    await postOrder(r, res())
    expect(createOnlineOrder).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'QR', customer: { name: 'María', phone: null, email: null }, customerId: null }),
      { assertCanCreate: expect.any(Function) },
    )
  })

  it('502 CARD_PROVIDER_UNAVAILABLE conserva su código: la tienda sabe que puede reintentar', async () => {
    ;(createCardOnlineDraft as jest.Mock).mockRejectedValueOnce(
      new AppError('No pudimos abrir la página de pago.', 502, true, 'CARD_PROVIDER_UNAVAILABLE'),
    )
    const r = res()
    await postOrder(req('CARD_ONLINE'), r)
    expect(r.status).toHaveBeenCalledWith(502)
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CARD_PROVIDER_UNAVAILABLE' }))
  })
})
