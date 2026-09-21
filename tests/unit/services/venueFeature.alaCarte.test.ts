/**
 * La puerta à-la-carte (`addFeaturesToVenue`) — dos P1 de la auditoría del 21-sep-2026.
 *
 * #3: por esta ruta se podía contratar `PLAN_PREMIUM` como si fuera una función suelta,
 *     saltándose el guard del checkout de planes (que sí rechaza un segundo plan activo).
 * #8: los días de prueba venían en el body del cliente (`0..365`), así que quien pudiera
 *     comprar podía regalarse un año.
 */
const mockCreateTrialSubscriptions = jest.fn()
const mockCancelSubscription = jest.fn()

jest.mock('../../../src/services/stripe.service', () => ({
  createTrialSubscriptions: (...args: unknown[]) => mockCreateTrialSubscriptions(...args),
  cancelSubscription: (...args: unknown[]) => mockCancelSubscription(...args),
}))

const mockVenueFindUnique = jest.fn()
const mockVenueFeatureFindMany = jest.fn()
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: (...a: unknown[]) => mockVenueFindUnique(...a) },
    venueFeature: { findMany: (...a: unknown[]) => mockVenueFeatureFindMany(...a) },
  },
}))

jest.mock('../../../src/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import { addFeaturesToVenue } from '../../../src/services/dashboard/venueFeature.dashboard.service'

const venueListo = {
  id: 'venue-1',
  name: 'Testarudo',
  stripeCustomerId: 'cus_1',
  stripePaymentMethodId: 'pm_1',
  seatCapExempt: false,
  organization: { seatCapExempt: false },
  features: [],
}

beforeEach(() => {
  jest.clearAllMocks()
  mockVenueFindUnique.mockResolvedValue(venueListo)
  mockVenueFeatureFindMany.mockResolvedValue([])
  mockCreateTrialSubscriptions.mockResolvedValue([])
})

describe('addFeaturesToVenue — un PLAN no se contrata por la puerta de las funciones sueltas', () => {
  it('rechaza PLAN_PREMIUM', async () => {
    await expect(addFeaturesToVenue('venue-1', ['PLAN_PREMIUM'])).rejects.toThrow(/plan/i)
    expect(mockCreateTrialSubscriptions).not.toHaveBeenCalled()
  })

  it('rechaza PLAN_PRO aunque venga mezclado con una suelta legítima', async () => {
    await expect(addFeaturesToVenue('venue-1', ['CHATBOT', 'PLAN_PRO'])).rejects.toThrow(/plan/i)
    // 🔴 todo-o-nada: no puede colarse la suelta y perderse el rechazo del plan
    expect(mockCreateTrialSubscriptions).not.toHaveBeenCalled()
  })

  it('rechaza ANTES de tocar la base o Stripe', async () => {
    await expect(addFeaturesToVenue('venue-1', ['PLAN_PRO'])).rejects.toThrow()
    expect(mockVenueFindUnique).not.toHaveBeenCalled()
  })

  it('deja pasar una función suelta de verdad', async () => {
    await expect(addFeaturesToVenue('venue-1', ['CHATBOT'])).resolves.toBeDefined()
  })
})

describe('addFeaturesToVenue — los días de prueba los decide el SERVIDOR', () => {
  it('usa la política del servidor, no un número que mande quien compra', async () => {
    await addFeaturesToVenue('venue-1', ['CHATBOT'])
    const diasQueViajaronAStripe = mockCreateTrialSubscriptions.mock.calls[0]?.[3]
    expect(diasQueViajaronAStripe).toBe(5)
  })

  it('la firma ya no acepta un trial del cliente', () => {
    // 4 parámetros del cliente sería la firma vieja (venueId, codes, trialDays, paymentMethodId).
    expect(addFeaturesToVenue.length).toBeLessThanOrEqual(3)
  })
})
