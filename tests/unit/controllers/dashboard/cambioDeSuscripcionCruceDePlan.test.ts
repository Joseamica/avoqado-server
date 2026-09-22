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
  entregarSuscripcionDePlan: jest.fn().mockResolvedValue(null),
}))
// V5-A paso 6: plan → plan pasa por la regla común (sus casos viven en `cambioDePlanConvergente.test.ts`); aquí se deja pasar
// o se hace rechazar, para seguir probando lo de este archivo: el cruce plan↔suelta y los candados de la suelta.
const mockAutorizar = jest.fn()
jest.mock('../../../../src/services/access/autorizarObligacionNueva', () => ({
  autorizarObligacionNueva: (...a: unknown[]) => mockAutorizar(...a),
}))
const mockAssertSinCobroDoble = jest.fn()
const mockAssertNoIncluida = jest.fn()
const mockVentaAbierta = jest.fn()
const mockAddFeatures = jest.fn()
jest.mock('../../../../src/services/dashboard/venueFeature.dashboard.service', () => ({
  assertSinCobroDobleAlSubir: (...a: unknown[]) => mockAssertSinCobroDoble(...a),
  assertNoIncluidaEnElPlan: (...a: unknown[]) => mockAssertNoIncluida(...a),
  ventaSueltaAbierta: () => mockVentaAbierta(),
  addFeaturesToVenue: (...a: unknown[]) => mockAddFeatures(...a),
}))

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
    venue: { findUnique: jest.fn().mockResolvedValue({ stripeCustomerId: 'cus_1' }) },
    activityLog: { create: jest.fn().mockResolvedValue({}) },
  },
}))

import { cruzaPlanYSuelta } from '../../../../src/services/access/basePlan.service'
import {
  addVenueFeatures,
  previewSubscriptionChange,
  updateSubscription,
} from '../../../../src/controllers/dashboard/venueFeature.dashboard.controller'

function peticion(origen: string, destino: string) {
  mockVfFindFirst.mockResolvedValue({
    id: 'vf-1',
    venueId: 'venue-1',
    stripeSubscriptionId: 'sub_1',
    feature: { id: `f-${origen}`, code: origen, name: origen },
  })
  mockFeatureFindUnique.mockResolvedValue({
    id: `f-${destino}`,
    code: destino,
    name: destino,
    stripePriceId: `price_${destino}`,
    monthlyPrice: 1,
  })
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
  mockAssertSinCobroDoble.mockReset().mockResolvedValue(undefined)
  mockAssertNoIncluida.mockReset().mockResolvedValue(undefined)
  mockVentaAbierta.mockReset().mockReturnValue(true)
  mockAddFeatures.mockReset().mockResolvedValue([])
  mockAutorizar.mockReset().mockImplementation(async (_v: string, _c: string, _i: unknown, crear: () => Promise<unknown>) => crear())
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

})

/**
 * 🔴 Actualizado el 22-sep: el CAMBIO plan → plan quedó cerrado (el dinero sólo se mueve en una confirmación de
 * Stripe). La COTIZACIÓN no: es de sólo lectura, no mueve un peso, y el negocio puede seguir viendo cuánto le
 * costaría antes de escribirnos. Antes una sola prueba cubría los dos caminos; ahora dicen cosas distintas.
 */
describe('plan → plan tras cerrar el cambio', () => {
  it('🔴 CAMBIAR no toca Stripe: está cerrado', async () => {
    const { req, res, next } = peticion('PLAN_PRO', 'PLAN_PREMIUM')
    await updateSubscription(req, res, next)

    expect(mockUpdatePrice).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'CAMBIO_DE_PLAN_CERRADO' }))
  })

  it('COTIZAR sigue disponible: no mueve dinero', async () => {
    const { req, res, next } = peticion('PLAN_PRO', 'PLAN_PREMIUM')
    await previewSubscriptionChange(req, res, next)

    expect(mockPreview).toHaveBeenCalled()
  })
})

describe('hallazgo #1 · subir de plan con una suelta que el plan incluye y sigue cobrando', () => {
  const solape = () => Object.assign(new Error('Ya pagas Inventario por separado'), { statusCode: 409, code: 'PLAN_ABSORBS_ALA_CARTE' })

  it('🔴 cotizar PRO → PREMIUM con solape: 409 y NO toca Stripe', async () => {
    mockAssertSinCobroDoble.mockRejectedValue(solape())
    const { req, res, next } = peticion('PLAN_PRO', 'PLAN_PREMIUM')

    await previewSubscriptionChange(req, res, next)

    expect(mockAssertSinCobroDoble).toHaveBeenCalledWith('venue-1', 'PREMIUM')
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'PLAN_ABSORBS_ALA_CARTE' }))
    expect(mockPreview).not.toHaveBeenCalled()
  })

  // 🔴 Actualizada el 22-sep: con el cambio de plan CERRADO, el solape ya no lo decide la regla — no se llega a ella.
  it('🔴 cambiar PRO → PREMIUM está cerrado: ni regla ni Stripe', async () => {
    const { req, res, next } = peticion('PLAN_PRO', 'PLAN_PREMIUM')

    await updateSubscription(req, res, next)

    expect(mockAutorizar).not.toHaveBeenCalled()
    expect(mockUpdatePrice).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'CAMBIO_DE_PLAN_CERRADO' }))
  })

  it.each([
    ['cotizar', previewSubscriptionChange],
    ['cambiar', updateSubscription],
  ])('🔴 ronda 5 P1-3 · %s suelta → suelta que el plan YA incluye: 409 y NO toca Stripe', async (_n, handler) => {
    mockAssertNoIncluida.mockRejectedValue(
      Object.assign(new Error('Tu plan ya incluye LOYALTY_PROGRAM'), { statusCode: 409, code: 'FEATURE_INCLUDED_IN_PLAN' }),
    )
    const { req, res, next } = peticion('INVENTORY_TRACKING', 'LOYALTY_PROGRAM')

    await (handler as any)(req, res, next)

    expect(mockAssertNoIncluida).toHaveBeenCalledWith('venue-1', ['LOYALTY_PROGRAM'])
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'FEATURE_INCLUDED_IN_PLAN' }))
    expect(mockUpdatePrice).not.toHaveBeenCalled()
    expect(mockPreview).not.toHaveBeenCalled()
  })

  it('subir de plan no pregunta «ya incluida» (lo cubre el candado de solapes)', async () => {
    const { req, res, next } = peticion('PLAN_PRO', 'PLAN_PREMIUM')

    await updateSubscription(req, res, next)

    expect(mockAssertNoIncluida).not.toHaveBeenCalled()
  })

  it('un cambio entre sueltas no pregunta por solapes de plan', async () => {
    const { req, res, next } = peticion('LOYALTY_PROGRAM', 'REFERRAL_PROGRAM')

    await updateSubscription(req, res, next)

    expect(mockAssertSinCobroDoble).not.toHaveBeenCalled()
  })
})

/**
 * Decisión del founder (21-sep-2026, opción A): la venta de funciones sueltas queda CERRADA hasta que
 * la compra se rediseñe con una operación de contratación persistida (Codex, ronda 5: cuatro caminos
 * de cobro doble que no se cierran con parches). Cerrada en el SERVIDOR, no sólo en la pantalla: la
 * API se podía llamar directo.
 */
describe('venta suelta CERRADA', () => {
  beforeEach(() => mockVentaAbierta.mockReturnValue(false))

  it('🔴 comprar una suelta: 409 ALA_CARTE_SALES_CLOSED y NO llega al servicio', async () => {
    const req: any = { params: { venueId: 'venue-1' }, body: { featureCodes: ['INVENTORY_TRACKING'] } }
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }
    const next = jest.fn()

    await addVenueFeatures(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409, code: 'ALA_CARTE_SALES_CLOSED' }))
    expect(mockAddFeatures).not.toHaveBeenCalled()
  })

  it.each([
    ['cotizar', previewSubscriptionChange],
    ['cambiar', updateSubscription],
  ])('🔴 %s suelta → suelta: 409 y NO toca Stripe', async (_n, handler) => {
    const { req, res, next } = peticion('INVENTORY_TRACKING', 'LOYALTY_PROGRAM')

    await (handler as any)(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'ALA_CARTE_SALES_CLOSED' }))
    expect(mockUpdatePrice).not.toHaveBeenCalled()
    expect(mockPreview).not.toHaveBeenCalled()
  })

  // 🔴 Actualizada el 22-sep: los planes se siguen VENDIENDO (alta y checkout), pero CAMBIAR de plan desde el panel
  // quedó cerrado — era el único camino que movía dinero desde el servidor.
  it('🔴 cambiar de plan desde el panel: cerrado, con su propio mensaje', async () => {
    const { req, res, next } = peticion('PLAN_PRO', 'PLAN_PREMIUM')

    await updateSubscription(req, res, next)

    expect(mockUpdatePrice).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'CAMBIO_DE_PLAN_CERRADO' }))
  })

  it('el mensaje dice qué hacer: escribirnos', async () => {
    const req: any = { params: { venueId: 'venue-1' }, body: { featureCodes: ['INVENTORY_TRACKING'] } }
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }
    const next = jest.fn()

    await addVenueFeatures(req, res, next)

    expect(next.mock.calls[0][0].message).toMatch(/hola@avoqado\.io/)
  })
})
