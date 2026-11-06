/**
 * D1 (5-nov-2026): las CUATRO puertas por las que el SUPERADMIN regala el plan sacan del alta a quien se quedó en la
 * pantalla de la tarjeta. Antes el plan quedaba vivo y el negocio en ONBOARDING (Taqueria El Patio): el DASHBOARD lo
 * regresaba a /setup y el POS le decía «Termina de crear tu cuenta».
 *
 *   SUPERADMIN «Dar días de prueba»   → extendPlanTrial      (dashboard/superadmin.service)
 *   SUPERADMIN «Asignar plan comp»    → assignCompPlan       (dashboard/superadmin.service)
 *   Suscripciones «Dar prueba»        → grantVenuePlanTrial  (superadmin/subscription.service)
 *   Suscripciones «Activar»           → activateVenuePlan    (superadmin/subscription.service)
 *
 * Qué negocio cuenta como «atorado» lo decide `terminarAltaPorPlanRegalado` (probado aparte): aquí sólo que se llama
 * DESPUÉS de conceder, con quien lo hizo, y nunca si el regalo falló o fue «Gratis».
 */
import { prismaMock } from '../../../__helpers__/setup'

const mockExigir = jest.fn()
const mockSacar = jest.fn()
jest.mock('@/services/stripe.service', () => ({
  ...jest.requireActual('@/services/stripe.service'),
  exigirSinObligacionViva: (...a: unknown[]) => mockExigir(...a),
}))
jest.mock('@/services/onboarding/terminarAltaCobrada', () => ({
  __esModule: true,
  terminarAltaPorPlanRegalado: (...a: unknown[]) => mockSacar(...a),
}))
jest.mock('@/services/dashboard/planState.service', () => ({
  __esModule: true,
  getPlanState: jest.fn().mockResolvedValue({ hasPlan: true }),
}))
jest.mock('stripe')

import { activateVenuePlan, grantVenuePlanTrial } from '@/services/superadmin/subscription.service'
import { assignCompPlan, enableFeatureForVenue, extendPlanTrial, grantTrialForVenue } from '@/services/dashboard/superadmin.service'

const PRO = { id: 'feature-pro', code: 'PLAN_PRO', monthlyPrice: 1158.84 }
const PREMIUM = { id: 'feature-premium', code: 'PLAN_PREMIUM', monthlyPrice: 2318.84 }

beforeEach(() => {
  mockExigir.mockReset().mockResolvedValue(undefined)
  mockSacar.mockReset().mockResolvedValue(true)
  prismaMock.$queryRaw.mockReset().mockResolvedValue([{ id: 'cven1' }] as never)
  prismaMock.$executeRaw.mockReset().mockResolvedValue(0 as never)
  prismaMock.$transaction.mockImplementation(async (cb: (tx: never) => Promise<unknown>) => cb(prismaMock as never))
  prismaMock.venue.findUnique.mockResolvedValue({ id: 'cven1' } as never)
  prismaMock.venue.findFirst.mockResolvedValue({
    id: 'cven1',
    name: 'Taqueria',
    slug: 'taqueria',
    planTier: null,
    features: [],
    staff: [],
  } as never)
  prismaMock.feature.findUnique.mockResolvedValue(PRO as never)
  prismaMock.feature.findMany.mockResolvedValue([PRO, PREMIUM] as never)
  prismaMock.venueFeature.findFirst.mockResolvedValue(null as never)
  prismaMock.venueFeature.findUnique.mockResolvedValue(null as never)
  prismaMock.venueFeature.findMany.mockReset().mockResolvedValue([] as never)
  prismaMock.venueFeature.updateMany.mockReset().mockResolvedValue({ count: 0 } as never)
  prismaMock.venueFeature.create.mockReset().mockResolvedValue({ id: 'vf-nueva' } as never)
})

describe('el plan regalado saca del alta', () => {
  it.each([
    ['«Dar días de prueba» (panel)', () => extendPlanTrial('cven1', 'PRO', 30, 'sa-1')],
    ['«Asignar plan comp» Pro', () => assignCompPlan('cven1', 'PRO', 'sa-1')],
    ['«Asignar plan comp» Premium', () => assignCompPlan('cven1', 'PREMIUM', 'sa-1')],
    ['prueba desde Suscripciones', () => grantVenuePlanTrial('cven1', 30, 'sa-1')],
    ['«Activar» desde Suscripciones', () => activateVenuePlan('cven1', 'sa-1')],
    ['prueba genérica de funciones con PLAN_PRO', () => grantTrialForVenue('cven1', 'PLAN_PRO', 30, 'sa-1')],
    ['encender PLAN_PRO por la ruta genérica (Codex D1 r1 #3: con actor)', () => enableFeatureForVenue('cven1', 'PLAN_PRO', 'sa-1')],
  ])('%s → concede y DESPUÉS saca del alta, con quien lo hizo', async (_puerta, regalar) => {
    await regalar()

    expect(prismaMock.venueFeature.create).toHaveBeenCalled()
    expect(mockSacar).toHaveBeenCalledWith('cven1', 'sa-1')
    // Después de escribir el plan, no antes: si concederlo truena, el alta no se toca (prueba de abajo).
    expect(mockSacar.mock.invocationCallOrder[0]).toBeGreaterThan(prismaMock.venueFeature.create.mock.invocationCallOrder[0])
  })

  it('una prueba de una función que NO es plan no saca del alta', async () => {
    prismaMock.feature.findUnique.mockResolvedValue({ id: 'f-loyal', code: 'LOYALTY_PROGRAM', monthlyPrice: 99 } as never)
    await grantTrialForVenue('cven1', 'LOYALTY_PROGRAM', 30, 'sa-1')
    expect(mockSacar).not.toHaveBeenCalled()
  })

  it('«Asignar plan comp» Gratis NO regala plan → no saca del alta', async () => {
    await assignCompPlan('cven1', 'FREE', 'sa-1')
    expect(mockSacar).not.toHaveBeenCalled()
  })

  it.each([
    ['«Dar días de prueba» (panel)', () => extendPlanTrial('cven1', 'PRO', 30, 'sa-1')],
    ['«Asignar plan comp»', () => assignCompPlan('cven1', 'PRO', 'sa-1')],
    ['prueba desde Suscripciones', () => grantVenuePlanTrial('cven1', 30, 'sa-1')],
  ])('🔴 %s sobre una suscripción que cobra (409) → no regala ni saca del alta', async (_puerta, regalar) => {
    prismaMock.venueFeature.findFirst.mockResolvedValue({ id: 'vf1', endDate: null, stripeSubscriptionId: 'sub_viva' } as never)
    prismaMock.venueFeature.findUnique.mockResolvedValue({ id: 'vf1', stripeSubscriptionId: 'sub_viva' } as never)
    prismaMock.venueFeature.findMany.mockResolvedValue([
      { id: 'vf1', featureId: 'feature-pro', active: true, stripeSubscriptionId: 'sub_viva' },
    ] as never)
    mockExigir.mockRejectedValue(Object.assign(new Error('cobra'), { statusCode: 409 }))

    await expect(regalar()).rejects.toBeDefined()
    expect(mockSacar).not.toHaveBeenCalled()
  })
})
