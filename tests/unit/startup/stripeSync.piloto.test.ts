/**
 * D5 · bloque P (11-nov-2026): la Feature `MESAS_SIN_RED` ($0, sin precio en Stripe a propósito) no se vende. Si el arranque la
 * contara como «falta en Stripe», cada reinicio llamaría a `syncFeaturesToStripe` (que actualiza el producto de TODAS) y le crearía
 * producto y precio. El conteo deja fuera los códigos de piloto, igual que la sincronización.
 */
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: { feature: { count: jest.fn() } } }))
jest.mock('@/services/stripe.service', () => ({ syncFeaturesToStripe: jest.fn().mockResolvedValue([]) }))
jest.mock('@/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))

import prisma from '@/utils/prismaClient'
import { syncFeaturesToStripe } from '@/services/stripe.service'
import { ensureFeaturesAreSyncedToStripe } from '@/startup/stripe-sync.startup'

const count = prisma.feature.count as jest.Mock

describe('ensureFeaturesAreSyncedToStripe con un código de piloto sin precio', () => {
  const antes = process.env.STRIPE_SECRET_KEY
  beforeAll(() => (process.env.STRIPE_SECRET_KEY = 'sk_test_x'))
  afterAll(() => (process.env.STRIPE_SECRET_KEY = antes))

  it('🔴 no cuenta el piloto como «falta en Stripe»: con lo demás sincronizado, no sincroniza', async () => {
    // La base: 10 funciones vendibles con precio + MESAS_SIN_RED sin precio. El conteo, filtrado, ve 10 de 10.
    count.mockImplementation(async ({ where }: any) => {
      if (where.stripePriceId) return 10 // con precio: sólo las vendibles (el piloto nunca tiene)
      return where.code?.notIn?.includes('MESAS_SIN_RED') ? 10 : 11 // activas: 11 con el piloto
    })

    await expect(ensureFeaturesAreSyncedToStripe()).resolves.toBe(false)

    expect(syncFeaturesToStripe).not.toHaveBeenCalled()
    for (const [{ where }] of count.mock.calls) expect(where.code).toEqual({ notIn: ['MESAS_SIN_RED'] })
  })
})
