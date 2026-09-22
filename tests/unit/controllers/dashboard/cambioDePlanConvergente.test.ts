/**
 * 🔴 V5-A paso 6 (Codex, pasos 2-5, P2-4 · v5 punto 6): cambiar de plan PRO↔PREMIUM desde el panel converge en la regla
 * común y en la entrega.
 *
 * Antes: el controlador rechazaba con `FEATURE_ALREADY_SUBSCRIBED` sólo porque EXISTÍA una fila del plan destino —p. ej.
 * una cortesía PREMIUM que la compra de PRO ya había retirado—, y cuando no la había reescribía la fila él mismo sin mirar
 * lo que Stripe cobra. Ahora:
 *   - la regla (candado por negocio + lo VIVO en Stripe) decide si se puede cambiar, ANTES de tocar Stripe;
 *   - las filas las decide la entrega (`entregarSuscripcionDePlan`), después de que la regla suelta su candado.
 */
const mockUpdatePrice = jest.fn()
const mockEntregar = jest.fn()
jest.mock('../../../../src/services/stripe.service', () => ({
  updateSubscriptionPrice: (...a: unknown[]) => mockUpdatePrice(...a),
  previewSubscriptionProration: jest.fn(),
  entregarSuscripcionDePlan: (...a: unknown[]) => mockEntregar(...a),
}))
const orden: string[] = []
const mockRegistrar = jest.fn().mockResolvedValue('CREADO')
jest.mock('../../../../src/services/access/conflictosDeObligacion.service', () => ({
  registrarConflictoDeObligacion: (...a: unknown[]) => mockRegistrar(...a),
  avisarConflictoCreado: jest.fn(),
  cerrarConflictoEntregado: jest.fn(),
  cerrarConflictoTerminado: jest.fn(),
}))
const mockAutorizar = jest.fn()
jest.mock('../../../../src/services/access/autorizarObligacionNueva', () => ({
  autorizarObligacionNueva: (...a: unknown[]) => mockAutorizar(...a),
}))
jest.mock('../../../../src/services/dashboard/venueFeature.dashboard.service', () => ({
  assertSinCobroDobleAlSubir: jest.fn(),
  assertNoIncluidaEnElPlan: jest.fn(),
  ventaSueltaAbierta: () => false,
  addFeaturesToVenue: jest.fn(),
}))
const mockVfFindFirst = jest.fn()
const mockVfFindUnique = jest.fn()
const mockVfUpdate = jest.fn()
const mockFeatureFindUnique = jest.fn()
const mockVenueFindUnique = jest.fn()
jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venueFeature: {
      findFirst: (...a: unknown[]) => mockVfFindFirst(...a),
      findUnique: (...a: unknown[]) => mockVfFindUnique(...a),
      update: (...a: unknown[]) => mockVfUpdate(...a),
    },
    feature: { findUnique: (...a: unknown[]) => mockFeatureFindUnique(...a) },
    venue: { findUnique: (...a: unknown[]) => mockVenueFindUnique(...a) },
  },
}))

import { updateSubscription } from '../../../../src/controllers/dashboard/venueFeature.dashboard.controller'
import { logAction } from '../../../../src/services/dashboard/activity-log.service'

const peticion = () => {
  const req: any = {
    params: { venueId: 'venue-1', featureId: 'vf-pro' },
    body: { newFeatureCode: 'PLAN_PREMIUM' },
    authContext: { userId: 'staff-1', venueId: 'venue-1' },
  }
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }
  return { req, res, next: jest.fn() }
}

beforeEach(() => {
  jest.clearAllMocks()
  orden.length = 0
  mockVfFindFirst.mockResolvedValue({
    id: 'vf-pro',
    venueId: 'venue-1',
    stripeSubscriptionId: 'sub_1',
    feature: { id: 'f-pro', code: 'PLAN_PRO', name: 'Pro' },
  })
  mockFeatureFindUnique.mockResolvedValue({
    id: 'f-premium',
    code: 'PLAN_PREMIUM',
    name: 'Premium',
    stripePriceId: 'price_premium',
    monthlyPrice: 1999,
  })
  mockVenueFindUnique.mockResolvedValue({ stripeCustomerId: 'cus_1' })
  // 🔴 Existe la fila del destino (una cortesía PREMIUM ya retirada): antes esto era un 409 FEATURE_ALREADY_SUBSCRIBED.
  mockVfFindUnique.mockResolvedValue({ id: 'vf-premium', active: true, feature: { code: 'PLAN_PREMIUM' } })
  mockAutorizar.mockImplementation(async (_v: string, _c: string, _i: unknown, crear: () => Promise<unknown>) => {
    orden.push('regla:entra')
    const r = await crear()
    orden.push('regla:sale')
    return r
  })
  mockUpdatePrice.mockImplementation(async (_s: string, _p: string, o?: { antesDeEnviar?: () => void }) => {
    orden.push('stripe')
    await o?.antesDeEnviar?.()
    return { id: 'sub_1' }
  })
  mockEntregar.mockImplementation(async () => {
    orden.push('entrega')
    return { venueId: 'venue-1', featureId: 'f-premium', featureCode: 'PLAN_PREMIUM', subscriptionId: 'sub_1', endDate: null }
  })
})

/**
 * 🔴 Las pruebas del CAMINO DIRECTO (la regla + la entrega + el 202 + la barrera de R5) se retiraron junto con el
 * código que fijaban: el founder cerró ese botón el 22-sep tras la 3ª ronda de Codex. Fijar el comportamiento de un
 * camino que ya no existe sólo obliga a mantenerlo. Lo que queda fijado es el CIERRE, abajo. Si algún día se reabre
 * por Checkout/portal de Stripe, sus pruebas se escriben contra ESE flujo, no contra éste.
 */

/**
 * 🔴 Decisión del founder (22-sep, tras la 3ª ronda de Codex): **el cambio de plan directo se CIERRA** hasta que
 * exista el flujo de confirmación alojado en Stripe (su propia decisión del v4: «el dinero sólo se mueve en una
 * confirmación de Stripe»). No es un parche más: es cortar la raíz. Ocho de los dieciséis hallazgos abiertos —la
 * barrera que no bloqueaba, la llave que identificaba un destino y no una operación, el prorrateo, el 202, los
 * pendientes que atascaban el barrido— existían SÓLO porque este botón le cobraba al cliente desde el servidor.
 */
describe('🔴 el cambio de plan directo está CERRADO', () => {
  it('🔴 responde 409 diciendo qué hacer, y NO toca Stripe', async () => {
    const { req, res, next } = peticion()

    await updateSubscription(req, res, next)

    expect(mockUpdatePrice).not.toHaveBeenCalled()
    expect(mockAutorizar).not.toHaveBeenCalled()
    expect(mockEntregar).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409, code: 'CAMBIO_DE_PLAN_CERRADO' }))
  })

  it('🔴 y tampoco deja nada persistido: sin envío no hay barrera que conciliar', async () => {
    const { req, res, next } = peticion()

    await updateSubscription(req, res, next)

    expect(mockRegistrar).not.toHaveBeenCalled()
  })
})
