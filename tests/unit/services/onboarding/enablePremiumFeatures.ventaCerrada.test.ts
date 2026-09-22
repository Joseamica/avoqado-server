/**
 * Venta suelta CERRADA (founder, 21-sep-2026, opción A). El onboarding V1 (`/onboarding`, que sigue
 * vivo: `SignupForm` y `wizardVersion != 2` mandan ahí) vendía funciones sueltas con 2 días gratis
 * sin pasar por el candado de la compra. Y su respaldo, cuando Stripe falla, crea las funciones SIN
 * cobro por 5 días: con la venta cerrada eso las regalaría. Por eso no basta con que Stripe se niegue:
 * el alta V1 tiene que SALTAR las funciones antes de intentarlo.
 */
const mockVentaAbierta = jest.fn()
jest.mock('../../../../src/services/access/ventaSuelta', () => ({ ventaSueltaAbierta: () => mockVentaAbierta() }))

const mockCreateTrial = jest.fn()
const mockCustomer = jest.fn()
jest.mock('../../../../src/services/stripe.service', () => ({
  __esModule: true,
  createTrialSubscriptions: (...a: unknown[]) => mockCreateTrial(...a),
  getOrCreateStripeCustomer: (...a: unknown[]) => mockCustomer(...a),
  updatePaymentMethod: jest.fn(),
  syncFeaturesToStripe: jest.fn(),
}))
const mockVfCreate = jest.fn()
jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    feature: { findMany: jest.fn().mockResolvedValue([{ id: 'f1', code: 'INVENTORY_TRACKING', monthlyPrice: 89 }]) },
    venueFeature: { create: (...a: unknown[]) => mockVfCreate(...a) },
  },
}))
jest.mock('../../../../src/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() } }))
jest.mock('../../../../src/services/superadmin/kycReview.service', () => ({ __esModule: true }))
jest.mock('../../../../src/services/email.service', () => ({ __esModule: true, default: {} }))
jest.mock('../../../../src/services/resend.service', () => ({ __esModule: true }))
jest.mock('../../../../src/services/onboarding/demoSeed.service', () => ({ __esModule: true, seedDemoVenue: jest.fn() }))

import { enablePremiumFeatures } from '../../../../src/services/onboarding/venueCreation.service'

beforeEach(() => {
  jest.clearAllMocks()
  mockCustomer.mockResolvedValue('cus_1')
  mockCreateTrial.mockResolvedValue(['sub_1'])
})

describe('alta V1 con la venta suelta cerrada', () => {
  it('🔴 no crea suscripciones ni regala funciones sin cobro', async () => {
    mockVentaAbierta.mockReturnValue(false)

    await enablePremiumFeatures('venue-1', 'a@b.mx', 'Cafe', ['INVENTORY_TRACKING'])

    expect(mockCreateTrial).not.toHaveBeenCalled()
    expect(mockCustomer).not.toHaveBeenCalled()
    expect(mockVfCreate).not.toHaveBeenCalled()
  })

  it('con la venta abierta sigue funcionando como antes', async () => {
    mockVentaAbierta.mockReturnValue(true)

    await enablePremiumFeatures('venue-1', 'a@b.mx', 'Cafe', ['INVENTORY_TRACKING'])

    expect(mockCreateTrial).toHaveBeenCalled()
  })
})
