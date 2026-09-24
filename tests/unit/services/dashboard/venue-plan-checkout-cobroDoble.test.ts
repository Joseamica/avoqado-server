/**
 * V5-A (diseño v5.1): el checkout del plan pasa por la REGLA COMÚN de compra antes de abrir la sesión de Stripe.
 *
 * Lo que cierra, y pasaba HOY: dos pestañas pagadas (la segunda expira la primera) y un plan suspendido que Stripe sigue
 * cobrando (la compatibilidad lee Stripe, no el acceso local). La sesión sólo se crea DENTRO de la autorización.
 */
const mockCheckout = jest.fn()
const mockAutorizar = jest.fn()
jest.mock('@/services/stripe.service', () => ({
  createPlanCheckoutSession: (...a: unknown[]) => mockCheckout(...a),
  getOrCreateStripeCustomer: jest.fn(),
}))
jest.mock('@/services/access/autorizarObligacionNueva', () => ({
  autorizarObligacionNueva: (...a: unknown[]) => mockAutorizar(...a),
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: 'venue-1', name: 'Cafe', slug: 'cafe', stripeCustomerId: 'cus_1', organizationId: 'org-1' }),
    },
  },
}))

import { createVenuePlanCheckoutSession } from '@/services/dashboard/venue.dashboard.service'

beforeEach(() => {
  mockCheckout.mockReset().mockResolvedValue('https://checkout.stripe.test/x')
  // Por defecto la regla común autoriza y ejecuta lo que se le pide crear.
  mockAutorizar.mockReset().mockImplementation(async (_v: string, _c: string, _i: unknown, crear: () => Promise<unknown>) => crear())
})

describe('createVenuePlanCheckoutSession — pasa por la regla común de compra', () => {
  it('pide autorización para UN plan del tier pedido, con el cliente del negocio, y crea la sesión DENTRO', async () => {
    await expect(createVenuePlanCheckoutSession('org-1', 'venue-1', 'monthly', 'PREMIUM')).resolves.toBe('https://checkout.stripe.test/x')

    expect(mockAutorizar).toHaveBeenCalledWith('venue-1', 'cus_1', { tipo: 'PLAN', tier: 'PREMIUM' }, expect.any(Function))
    expect(mockCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ venueId: 'venue-1', customerId: 'cus_1', tierCode: 'PLAN_PREMIUM' }),
    )
  })

  it('🔴 si la regla común rechaza (plan vivo, suelta absorbida, compra abierta…): no se crea ninguna sesión', async () => {
    mockAutorizar.mockRejectedValue(Object.assign(new Error('Ya hay un plan cobrando'), { statusCode: 409, code: 'PLAN_YA_CONTRATADO' }))

    await expect(createVenuePlanCheckoutSession('org-1', 'venue-1', 'monthly', 'PRO')).rejects.toMatchObject({ code: 'PLAN_YA_CONTRATADO' })
    expect(mockCheckout).not.toHaveBeenCalled()
  })
})
