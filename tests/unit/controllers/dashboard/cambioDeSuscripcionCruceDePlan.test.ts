/**
 * Auditoría de Codex del 21-sep-2026 (P1, las dos pasadas, reproducido con 200 y llamada a Stripe).
 *
 * El cierre del hallazgo #3 cubrió sólo la puerta de ALTA: ya no se contrata un plan como función
 * suelta. Pero la de CAMBIAR suscripción seguía convirtiendo una en la otra —`PLAN_PRO →
 * LOYALTY_PROGRAM` y `LOYALTY_PROGRAM → PLAN_PREMIUM`—, saltándose las validaciones del checkout
 * de planes. Plan↔plan (subir de Pro a Premium) y suelta↔suelta sí son legítimos.
 */
const mockUpdatePrice = jest.fn()
const mockPreview = jest.fn()
jest.mock('../../../../src/services/stripe.service', () => ({
  updateSubscriptionPrice: (...a: unknown[]) => mockUpdatePrice(...a),
  previewSubscriptionProration: (...a: unknown[]) => mockPreview(...a),
}))
jest.mock('../../../../src/services/dashboard/venueFeature.dashboard.service', () => ({}))

const mockVfFindFirst = jest.fn()
const mockVfFindUnique = jest.fn()
const mockVfUpdate = jest.fn()
const mockFeatureFindUnique = jest.fn()
jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venueFeature: {
      findFirst: (...a: unknown[]) => mockVfFindFirst(...a),
      findUnique: (...a: unknown[]) => mockVfFindUnique(...a),
      update: (...a: unknown[]) => mockVfUpdate(...a),
    },
    feature: { findUnique: (...a: unknown[]) => mockFeatureFindUnique(...a) },
    activityLog: { create: jest.fn().mockResolvedValue({}) },
  },
}))

import { cruzaPlanYSuelta } from '../../../../src/services/access/basePlan.service'
import { previewSubscriptionChange, updateSubscription } from '../../../../src/controllers/dashboard/venueFeature.dashboard.controller'

function peticion(origen: string, destino: string) {
  mockVfFindFirst.mockResolvedValue({
    id: 'vf-1',
    venueId: 'venue-1',
    stripeSubscriptionId: 'sub_1',
    feature: { id: `f-${origen}`, code: origen, name: origen },
  })
  mockFeatureFindUnique.mockResolvedValue({ id: `f-${destino}`, code: destino, name: destino, stripePriceId: `price_${destino}`, monthlyPrice: 1 })
  mockVfFindUnique.mockResolvedValue(null)
  const req: any = { params: { venueId: 'venue-1', featureId: 'vf-1' }, body: { newFeatureCode: destino } }
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }
  return { req, res, next: jest.fn() }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockUpdatePrice.mockResolvedValue({ id: 'sub_1' })
  mockPreview.mockResolvedValue({ prorationAmount: 0 })
  mockVfUpdate.mockResolvedValue({})
})

describe('cruzaPlanYSuelta', () => {
  it.each([
    ['PLAN_PRO', 'LOYALTY_PROGRAM', true],
    ['LOYALTY_PROGRAM', 'PLAN_PREMIUM', true],
    ['PLAN_PRO', 'PLAN_PREMIUM', false],
    ['CHATBOT', 'LOYALTY_PROGRAM', false],
  ])('%s → %s ⇒ %s', (origen, destino, esperado) => {
    expect(cruzaPlanYSuelta(origen, destino)).toBe(esperado)
  })
})

describe.each([
  ['cambiar', updateSubscription, mockUpdatePrice],
  ['cotizar', previewSubscriptionChange, mockPreview],
])('al %s una suscripción', (_accion, handler, llamadaAStripe) => {
  it.each([
    ['PLAN_PRO', 'LOYALTY_PROGRAM'],
    ['LOYALTY_PROGRAM', 'PLAN_PREMIUM'],
  ])('🔴 %s → %s se rechaza con 400 y Stripe NO se toca', async (origen, destino) => {
    const { req, res, next } = peticion(origen, destino)
    await (handler as any)(req, res, next)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PLAN_CROSSING_NOT_ALLOWED' }))
    expect(llamadaAStripe).not.toHaveBeenCalled()
  })

  it('plan → plan (subir de Pro a Premium) sigue permitido', async () => {
    const { req, res, next } = peticion('PLAN_PRO', 'PLAN_PREMIUM')
    await (handler as any)(req, res, next)

    expect(llamadaAStripe).toHaveBeenCalled()
  })
})
