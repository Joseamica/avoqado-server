/**
 * El GET del panel (`getVenueById`) trae, junto a `exchangesEnabledEffective`, `storeCreditOnly` (el ajuste del negocio) y
 * `storeCreditAvailable` (¿el SERVIDOR sabe dar saldo a favor?: las dos llaves de las tarjetas de regalo). Spec 2026-10-30 §5.1.
 */
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { venue: { findFirst: jest.fn() } },
}))
jest.mock('@/services/stripe.service', () => ({
  __esModule: true,
  getOrCreateStripeCustomer: jest.fn(),
  createTrialSubscriptions: jest.fn(),
  cancelStripeSubscription: jest.fn(),
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import prisma from '@/utils/prismaClient'
import { getVenueById } from '@/services/dashboard/venue.dashboard.service'

const db = prisma as any
const LLAVE = 'b'.repeat(64)

describe('getVenueById — saldo a favor', () => {
  const guardadas = { code: process.env.GIFT_CARD_CODE_KEY, hmac: process.env.GIFT_CARD_HMAC_KEY }
  afterEach(() => {
    if (guardadas.code === undefined) delete process.env.GIFT_CARD_CODE_KEY
    else process.env.GIFT_CARD_CODE_KEY = guardadas.code
    if (guardadas.hmac === undefined) delete process.env.GIFT_CARD_HMAC_KEY
    else process.env.GIFT_CARD_HMAC_KEY = guardadas.hmac
  })

  it('el GET del panel trae storeCreditAvailable (verdadero con las dos llaves) y storeCreditOnly del ajuste', async () => {
    process.env.GIFT_CARD_CODE_KEY = LLAVE
    process.env.GIFT_CARD_HMAC_KEY = LLAVE
    db.venue.findFirst.mockResolvedValue({ id: 'venue-1', type: 'CLOTHING', settings: { storeCreditOnly: true } })

    await expect(getVenueById('org-1', 'venue-1')).resolves.toMatchObject({
      storeCreditAvailable: true,
      storeCreditOnly: true,
    })
  })

  it('storeCreditAvailable es falso sin las llaves, y un negocio sin fila de ajustes tiene storeCreditOnly false', async () => {
    delete process.env.GIFT_CARD_CODE_KEY
    delete process.env.GIFT_CARD_HMAC_KEY
    db.venue.findFirst.mockResolvedValue({ id: 'venue-1', type: 'CLOTHING', settings: null })

    const venue = await getVenueById('org-1', 'venue-1')
    expect(venue.storeCreditAvailable).toBe(false)
    expect(venue.storeCreditOnly).toBe(false)
    expect(venue).toHaveProperty('exchangesEnabledEffective') // lo de siempre sigue ahí
  })
})
