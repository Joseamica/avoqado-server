/**
 * Hallazgo #1 (21-sep-2026) en la puerta del CHECKOUT: un negocio sin plan pudo haber comprado
 * funciones sueltas; abrir el checkout del plan que las incluye mientras siguen cobrando le haría
 * pagarlas dos veces. El candado corre ANTES de crear la sesión de Stripe.
 */
const mockAssert = jest.fn()
const mockCheckout = jest.fn()
jest.mock('@/services/dashboard/venueFeature.dashboard.service', () => ({
  assertSinCobroDobleAlSubir: (...a: unknown[]) => mockAssert(...a),
}))
jest.mock('@/services/stripe.service', () => ({
  createPlanCheckoutSession: (...a: unknown[]) => mockCheckout(...a),
  getOrCreateStripeCustomer: jest.fn(),
}))
jest.mock('@/services/access/basePlan.service', () => ({ getVenueBaseTier: jest.fn().mockResolvedValue(null) }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: {
      findFirst: jest.fn().mockResolvedValue({ id: 'venue-1', name: 'Cafe', slug: 'cafe', stripeCustomerId: 'cus_1', organizationId: 'org-1' }),
    },
  },
}))

import { createVenuePlanCheckoutSession } from '@/services/dashboard/venue.dashboard.service'

beforeEach(() => {
  mockAssert.mockReset().mockResolvedValue(undefined)
  mockCheckout.mockReset().mockResolvedValue('https://checkout.stripe.test/x')
})

describe('createVenuePlanCheckoutSession — no se abre el checkout de un plan que ya se paga suelto', () => {
  it('🔴 con una suelta cobrando que PREMIUM incluye: rechaza y NO crea la sesión de Stripe', async () => {
    mockAssert.mockRejectedValue(Object.assign(new Error('Ya pagas Inventario por separado'), { code: 'PLAN_ABSORBS_ALA_CARTE' }))

    await expect(createVenuePlanCheckoutSession('org-1', 'venue-1', 'monthly', 'PREMIUM')).rejects.toMatchObject({
      code: 'PLAN_ABSORBS_ALA_CARTE',
    })
    expect(mockAssert).toHaveBeenCalledWith('venue-1', 'PREMIUM')
    expect(mockCheckout).not.toHaveBeenCalled()
  })

  it('sin solape, abre el checkout del tier pedido', async () => {
    await expect(createVenuePlanCheckoutSession('org-1', 'venue-1', 'monthly', 'PRO')).resolves.toBe('https://checkout.stripe.test/x')
    expect(mockAssert).toHaveBeenCalledWith('venue-1', 'PRO')
  })
})
