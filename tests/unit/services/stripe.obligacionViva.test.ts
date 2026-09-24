/**
 * R0 del rediseño de la compra (Codex, 21-sep-2026): varios escritores de superadmin y del dashboard
 * borraban o apagaban el vínculo a una suscripción que SEGUÍA COBRANDO — el negocio pagaba sin acceso,
 * o la suscripción quedaba sin representación local. La pregunta «¿esta suscripción puede cobrar?» tiene
 * TRES respuestas, no dos: si Stripe no contesta, no se sabe, y no saber no autoriza nada.
 */
const mockRetrieve = jest.fn()
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    subscriptions: { retrieve: mockRetrieve },
  })),
)
jest.mock('../../../src/utils/prismaClient', () => ({ __esModule: true, default: {} }))
jest.mock('../../../src/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))

import { exigirSinObligacionViva, suscripcionPuedeCobrar } from '../../../src/services/stripe.service'

beforeEach(() => {
  mockRetrieve.mockReset()
  process.env.STRIPE_SECRET_KEY = 'sk_test_x'
})

describe('suscripcionPuedeCobrar', () => {
  it('sin vínculo: NO', async () => {
    await expect(suscripcionPuedeCobrar(null)).resolves.toBe('NO')
    expect(mockRetrieve).not.toHaveBeenCalled()
  })

  it.each(['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused'])('%s: SI (puede cobrar o recuperarse)', async status => {
    mockRetrieve.mockResolvedValue({ id: 'sub_1', status })
    await expect(suscripcionPuedeCobrar('sub_1')).resolves.toBe('SI')
  })

  it.each(['canceled', 'incomplete_expired'])('%s: NO', async status => {
    mockRetrieve.mockResolvedValue({ id: 'sub_1', status })
    await expect(suscripcionPuedeCobrar('sub_1')).resolves.toBe('NO')
  })

  it('Stripe AFIRMA que no existe: NO', async () => {
    mockRetrieve.mockRejectedValue(Object.assign(new Error('No such subscription'), { code: 'resource_missing' }))
    await expect(suscripcionPuedeCobrar('sub_1')).resolves.toBe('NO')
  })

  it('🔴 Stripe no contesta: INCIERTO (no «no»)', async () => {
    mockRetrieve.mockRejectedValue(Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' }))
    await expect(suscripcionPuedeCobrar('sub_1')).resolves.toBe('INCIERTO')
  })
})

describe('exigirSinObligacionViva', () => {
  it('🔴 si puede cobrar: 409 LIVE_SUBSCRIPTION_LINKED que dice qué no se pudo hacer', async () => {
    mockRetrieve.mockResolvedValue({ id: 'sub_1', status: 'active' })
    await expect(exigirSinObligacionViva('sub_1', 'conceder una prueba')).rejects.toMatchObject({
      statusCode: 409,
      code: 'LIVE_SUBSCRIPTION_LINKED',
      message: expect.stringContaining('conceder una prueba'),
    })
  })

  it('🔴 si no se sabe: 503, reintentable', async () => {
    mockRetrieve.mockRejectedValue(Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' }))
    await expect(exigirSinObligacionViva('sub_1', 'conceder una prueba')).rejects.toMatchObject({ statusCode: 503 })
  })

  it('si ya no cobra, deja pasar', async () => {
    mockRetrieve.mockResolvedValue({ id: 'sub_1', status: 'canceled' })
    await expect(exigirSinObligacionViva('sub_1', 'conceder una prueba')).resolves.toBeUndefined()
  })
})
