import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/online-ordering/presence.service', () => ({ __esModule: true, getAcceptingStatus: jest.fn() }))

import { getInfo } from '@/controllers/public/onlineOrdering.public.controller'
import { getAcceptingStatus } from '@/services/online-ordering/presence.service'

/** T8: el comercio de verdad (no un mock de `findCardMerchant`): la regla única `cardOnlineAvailable` lo consulta por `ecommerceMerchant`. */
const STRIPE = {
  id: 'em1',
  chargesEnabled: true,
  providerCredentials: { connectAccountId: 'acct_1' },
  provider: { code: 'STRIPE_CONNECT' },
}
const comercio = (cobra: boolean) => prismaMock.ecommerceMerchant.findMany.mockResolvedValue((cobra ? [STRIPE] : []) as any)

const res = () => {
  const r: any = {}
  r.status = jest.fn(() => r)
  r.json = jest.fn(() => r)
  return r
}
const state = (config: Record<string, unknown>, status = 'OPEN', reason: string | null = null) => ({
  status,
  reason,
  config: {
    acceptsPayAtPickup: true,
    acceptsCardOnline: false,
    requiresAcceptance: true,
    minOrderAmount: 0,
    defaultPrepMinutes: 15,
    hours: null,
    ...config,
  },
})
const call = async () => {
  const r = res()
  await getInfo({ publicVenue: { id: 'v1', slug: 'flautas' } } as any, r)
  return r.json.mock.calls[0][0].data
}

beforeEach(() => prismaMock.venue.findUnique.mockResolvedValue({ name: 'Flautas', timezone: 'America/Mexico_City' } as any))

describe('GET /info paymentModes', () => {
  it('switch apagado: cardOnline false y ni siquiera consulta el comercio', async () => {
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue(state({ acceptsCardOnline: false }))
    expect((await call()).paymentModes).toEqual({ payAtPickup: true, cardOnline: false })
    expect(prismaMock.ecommerceMerchant.findMany).not.toHaveBeenCalled()
  })

  it('switch prendido y comercio cobrable: cardOnline true', async () => {
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue(state({ acceptsCardOnline: true }))
    comercio(true)
    expect((await call()).paymentModes).toEqual({ payAtPickup: true, cardOnline: true })
  })

  it('switch prendido pero el comercio dejó de poder cobrar: cardOnline false', async () => {
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue(state({ acceptsCardOnline: true }))
    comercio(false)
    expect((await call()).paymentModes).toEqual({ payAtPickup: true, cardOnline: false })
  })
})

describe('GET /info sin ningún medio de pago vivo', () => {
  it('pickup apagado, tarjeta prendida y el comercio ya no cobra: la tienda NO está OPEN (PAUSED / NO_PAYMENT_MODE)', async () => {
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue(state({ acceptsPayAtPickup: false, acceptsCardOnline: true }))
    comercio(false)
    const d = await call()
    expect(d.paymentModes).toEqual({ payAtPickup: false, cardOnline: false })
    expect(d.status).toBe('PAUSED')
    expect(d.reason).toBe('NO_PAYMENT_MODE')
    expect(d.pausedUntil).toBeNull()
  })

  it('pickup apagado y tarjeta cobrando: sigue OPEN', async () => {
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue(state({ acceptsPayAtPickup: false, acceptsCardOnline: true }))
    comercio(true)
    const d = await call()
    expect(d.status).toBe('OPEN')
    expect(d.reason).toBeNull()
  })

  it('con pagar al recoger prendido, aunque la tarjeta no cobre, sigue OPEN', async () => {
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue(state({ acceptsPayAtPickup: true, acceptsCardOnline: true }))
    comercio(false)
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

describe('GET /info en «Nadie» (T8)', () => {
  it('anuncia cardOnline false (aunque el switch y Stripe estén listos), requiresAcceptance false y closesAt', async () => {
    comercio(true)
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue(state({ acceptsCardOnline: true, requiresAcceptance: false, hours: null }))
    const d = await call()
    expect(d.paymentModes).toEqual({ payAtPickup: true, cardOnline: false })
    expect(d.requiresAcceptance).toBe(false)
    expect(d.closesAt).toBeNull()
    expect(prismaMock.ecommerceMerchant.findMany).not.toHaveBeenCalled()
  })

  it('con horario vigente, closesAt es el cierre de la franja en ISO (zona del negocio)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-04T18:00:00Z')) // miércoles 12:00 en CDMX (UTC-6)
    try {
      const day = { enabled: true, ranges: [{ open: '09:00', close: '20:00' }] }
      const hours = { monday: day, tuesday: day, wednesday: day, thursday: day, friday: day, saturday: day, sunday: day }
      ;(getAcceptingStatus as jest.Mock).mockResolvedValue(state({ requiresAcceptance: false, hours }))
      expect((await call()).closesAt).toBe('2026-11-05T02:00:00.000Z')
    } finally {
      jest.useRealTimers()
    }
  })

  it('R56: a las 20:55 en «Nadie» con cierre a las 21:00 dice cerrado (último pedido para pagar en caja) y anuncia el cierre REAL', async () => {
    const real = jest.requireActual(
      '@/services/online-ordering/presence.service',
    ) as typeof import('@/services/online-ordering/presence.service')
    ;(getAcceptingStatus as jest.Mock).mockImplementation(real.getAcceptingStatus)
    const ahora = new Date('2026-11-05T02:55:00Z') // miércoles 20:55 en CDMX (UTC-6)
    jest.useFakeTimers({ now: ahora, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'] })
    try {
      const day = { enabled: true, ranges: [{ open: '09:00', close: '21:00' }] }
      const hours = { monday: day, tuesday: day, wednesday: day, thursday: day, friday: day, saturday: day, sunday: day }
      prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue({
        venueId: 'v1',
        enabled: true,
        requiresAcceptance: false,
        acceptsPayAtPickup: true,
        acceptsCardOnline: false,
        manualPause: false,
        pausedUntil: null,
        minOrderAmount: 0,
        defaultPrepMinutes: 15,
        hours,
        lastToPayPollAt: new Date(ahora.getTime() - 30_000),
        lastInboxPollAt: null,
      } as any)
      prismaMock.onlineOrder.count.mockResolvedValue(0)
      prismaMock.onlineOrderCharge.count.mockResolvedValue(0)
      const d = await call()
      expect(d).toMatchObject({ status: 'CLOSED', reason: 'OUTSIDE_HOURS', requiresAcceptance: false })
      // La tienda puede decir «Ya no recibimos pedidos para pagar en caja hoy · cerramos a las 21:00».
      expect(d.closesAt).toBe('2026-11-05T03:00:00.000Z')
    } finally {
      jest.useRealTimers()
    }
  })

  it('«Mi equipo» anuncia requiresAcceptance true', async () => {
    ;(getAcceptingStatus as jest.Mock).mockResolvedValue(state({}))
    expect((await call()).requiresAcceptance).toBe(true)
  })
})
