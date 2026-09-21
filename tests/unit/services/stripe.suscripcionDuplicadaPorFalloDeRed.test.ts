/**
 * 🔴 AUDITORÍA 11ª (Codex gpt-6-astra xhigh, 19-sep) — P1 PREEXISTENTE: un fallo de RED podía
 * crear una SEGUNDA suscripción capaz de cobrar.
 *
 * `createTrialSubscriptions` consulta la suscripción que ya tiene guardada y, si la consulta
 * falla, el `catch` —que no capturaba el error ni lo miraba— asumía «no existe en Stripe» y
 * creaba otra. Después el `upsert` sustituía el `stripeSubscriptionId` local por el nuevo: la
 * anterior quedaba viva en Stripe, cobrando, y sin que nada local la apuntara.
 *
 * Un `StripeConnectionError` o un 500 son exactamente eso: «no pude consultarla», NO «no existe».
 * Sólo `resource_missing` (404) afirma que la suscripción no está.
 */
const mockSubRetrieve = jest.fn()
const mockSubCreate = jest.fn()
jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    subscriptions: { retrieve: mockSubRetrieve, create: mockSubCreate },
    invoices: { pay: jest.fn() },
  }))
})
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    feature: { findMany: jest.fn() },
    venueFeature: { findUnique: jest.fn(), upsert: jest.fn().mockResolvedValue({}), update: jest.fn().mockResolvedValue({}) },
  },
}))
jest.mock('../../../src/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import { createTrialSubscriptions } from '../../../src/services/stripe.service'
import prisma from '../../../src/utils/prismaClient'

const errorDeRed = () => Object.assign(new Error('Connection to Stripe failed'), { type: 'StripeConnectionError' })
const noExiste = () =>
  Object.assign(new Error('No such subscription: sub_vieja'), {
    type: 'StripeInvalidRequestError',
    code: 'resource_missing',
    statusCode: 404,
  })

beforeEach(() => {
  jest.clearAllMocks()
  process.env.STRIPE_SECRET_KEY = 'sk_test_x'
  ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ name: 'Cafe', slug: 'cafe' })
  ;(prisma.feature.findMany as jest.Mock).mockResolvedValue([
    { id: 'feat-pro', code: 'PLAN_PRO', name: 'Pro', stripePriceId: 'price_pro', monthlyPrice: 999 },
  ])
  // El venue YA tiene una suscripción guardada: es el escenario del defecto.
  ;(prisma.venueFeature.findUnique as jest.Mock).mockResolvedValue({ id: 'vf1', stripeSubscriptionId: 'sub_vieja' })
  mockSubCreate.mockResolvedValue({ id: 'sub_nueva', status: 'trialing', items: { data: [{ price: { id: 'price_pro' } }] } })
})

describe('🔴 11ª auditoría: «no pude consultarla» NO es «no existe»', () => {
  it('con un fallo de RED al consultar la suscripción existente, NO crea otra', async () => {
    mockSubRetrieve.mockRejectedValue(errorDeRed())

    // El fallo se REPORTA a quien llamó (el feature queda sin suscripción y alguien reintenta),
    // en vez de resolverse en silencio creando otra.
    await expect(createTrialSubscriptions('cus_1', 'v1', ['PLAN_PRO'])).rejects.toThrow(/Failed to create 1 subscription/)

    // Crear otra dejaría DOS suscripciones vivas en Stripe cobrándole al mismo negocio,
    // y el registro local apuntando sólo a la nueva.
    expect(mockSubCreate).not.toHaveBeenCalled()
  })

  it('con un 500 de Stripe tampoco crea otra', async () => {
    mockSubRetrieve.mockRejectedValue(Object.assign(new Error('boom'), { type: 'StripeAPIError', statusCode: 500 }))

    await expect(createTrialSubscriptions('cus_1', 'v1', ['PLAN_PRO'])).rejects.toThrow(/Failed to create 1 subscription/)

    expect(mockSubCreate).not.toHaveBeenCalled()
  })

  it('con `resource_missing` SÍ crea una nueva: ahí la suscripción de verdad no está', async () => {
    mockSubRetrieve.mockRejectedValue(noExiste())

    await createTrialSubscriptions('cus_1', 'v1', ['PLAN_PRO'])

    expect(mockSubCreate).toHaveBeenCalledTimes(1)
  })
})
