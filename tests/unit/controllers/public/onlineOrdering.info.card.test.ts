import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/online-ordering/presence.service', () => ({ __esModule: true, getAcceptingStatus: jest.fn() }))
jest.mock('@/services/online-ordering/card/merchant', () => ({ __esModule: true, findCardMerchant: jest.fn() }))

import { getInfo } from '@/controllers/public/onlineOrdering.public.controller'
import { getAcceptingStatus } from '@/services/online-ordering/presence.service'
import { findCardMerchant } from '@/services/online-ordering/card/merchant'

const res = () => {
  const r: any = {}
  r.status = jest.fn(() => r)
  r.json = jest.fn(() => r)
  return r
}
const state = (config: Record<string, unknown>, status = 'OPEN', reason: string | null = null) => ({
  status,
  reason,
  config: { acceptsPayAtPickup: true, acceptsCardOnline: false, minOrderAmount: 0, defaultPrepMinutes: 15, hours: null, ...config },
})
const call = async () => {
  const r = res()
  await getInfo({ publicVenue: { id: 'v1', slug: 'flautas' } } as any, r)
  return r.json.mock.calls[0][0].data
}

beforeEach(() => prismaMock.venue.findUnique.mockResolvedValue({ name: 'Flautas' } as any))

describe('GET /info paymentModes', () => {
  it('switch apagado: cardOnline false y ni siquiera consulta el comercio', async () => {
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue(state({ acceptsCardOnline: false }))
    expect((await call()).paymentModes).toEqual({ payAtPickup: true, cardOnline: false })
    expect(findCardMerchant).not.toHaveBeenCalled()
  })

  it('switch prendido y comercio cobrable: cardOnline true', async () => {
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue(state({ acceptsCardOnline: true }))
    ;(findCardMerchant as jest.Mock).mockResolvedValue({ id: 'em1' })
    expect((await call()).paymentModes).toEqual({ payAtPickup: true, cardOnline: true })
  })

  it('switch prendido pero el comercio dejó de poder cobrar: cardOnline false', async () => {
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue(state({ acceptsCardOnline: true }))
    ;(findCardMerchant as jest.Mock).mockResolvedValue(null)
    expect((await call()).paymentModes).toEqual({ payAtPickup: true, cardOnline: false })
  })
})

describe('GET /info sin ningún medio de pago vivo', () => {
  it('pickup apagado, tarjeta prendida y el comercio ya no cobra: la tienda NO está OPEN (PAUSED / NO_PAYMENT_MODE)', async () => {
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue(state({ acceptsPayAtPickup: false, acceptsCardOnline: true }))
    ;(findCardMerchant as jest.Mock).mockResolvedValue(null)
    const d = await call()
    expect(d.paymentModes).toEqual({ payAtPickup: false, cardOnline: false })
    expect(d.status).toBe('PAUSED')
    expect(d.reason).toBe('NO_PAYMENT_MODE')
    expect(d.pausedUntil).toBeNull()
  })

  it('pickup apagado y tarjeta cobrando: sigue OPEN', async () => {
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue(state({ acceptsPayAtPickup: false, acceptsCardOnline: true }))
    ;(findCardMerchant as jest.Mock).mockResolvedValue({ id: 'em1' })
    const d = await call()
    expect(d.status).toBe('OPEN')
    expect(d.reason).toBeNull()
  })

  it('con pagar al recoger prendido, aunque la tarjeta no cobre, sigue OPEN', async () => {
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue(state({ acceptsPayAtPickup: true, acceptsCardOnline: true }))
    ;(findCardMerchant as jest.Mock).mockResolvedValue(null)
    expect((await call()).status).toBe('OPEN')
  })

  it('un estado que ya no era OPEN conserva su motivo (no lo pisa)', async () => {
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue(
      state({ acceptsPayAtPickup: false, acceptsCardOnline: false }, 'CLOSED', 'OUTSIDE_HOURS'),
    )
    const d = await call()
    expect(d.status).toBe('CLOSED')
    expect(d.reason).toBe('OUTSIDE_HOURS')
  })
})
