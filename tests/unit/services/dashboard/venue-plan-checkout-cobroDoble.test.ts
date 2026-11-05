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
    venueFeature: { findMany: (...a: unknown[]) => mockFilasDelPlan(...a) },
  },
}))
const mockFilasDelPlan = jest.fn()

import { createVenuePlanCheckoutSession } from '@/services/dashboard/venue.dashboard.service'

beforeEach(() => {
  mockFilasDelPlan.mockReset().mockResolvedValue([])
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

// D3 (5-nov-2026): con una prueba REGALADA del mismo plan, el checkout difiere el primer cobro al fin de la prueba.
describe('createVenuePlanCheckoutSession — quedarse con el plan de una prueba regalada (D3)', () => {
  const H = 3600000
  const prueba = (horas: number, code = 'PLAN_PRO', over: Record<string, unknown> = {}) => ({
    id: 'vf-1',
    active: true,
    endDate: new Date(Date.now() + horas * H),
    suspendedAt: null,
    gracePeriodEndsAt: null,
    stripeSubscriptionId: null,
    updatedAt: new Date(),
    feature: { code },
    ...over,
  })

  it('mismo plan con ≥ 48 h → trial_end = fin de la prueba, sin cupones, y el regreso dice «sin cobro hoy»', async () => {
    const fila = prueba(8 * 24)
    mockFilasDelPlan.mockResolvedValue([fila])
    await createVenuePlanCheckoutSession('org-1', 'venue-1', 'monthly', 'PRO', { primerCobroAnunciado: fila.endDate.toISOString() })
    expect(mockCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        trialEnd: fila.endDate,
        successUrl: expect.stringContaining('checkout=success&sinCobroHoy=1'),
      }),
    )
  })

  it('🔴 la fecha la decide el SERVIDOR: aunque el cliente no mande la marca, con la prueba vigente no cobra hoy', async () => {
    const fila = prueba(8 * 24)
    mockFilasDelPlan.mockResolvedValue([fila])
    await createVenuePlanCheckoutSession('org-1', 'venue-1', 'monthly', 'PRO')
    expect(mockCheckout).toHaveBeenCalledWith(expect.objectContaining({ trialEnd: fila.endDate }))
  })

  it('🔴 la oferta «hoy $0» caducó (quedan < 48 h): 409 y NO se abre ningún pago que cobre hoy', async () => {
    mockFilasDelPlan.mockResolvedValue([prueba(40)])
    await expect(
      createVenuePlanCheckoutSession('org-1', 'venue-1', 'monthly', 'PRO', {
        primerCobroAnunciado: new Date(Date.now() + 40 * H).toISOString(),
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'COBRO_DIFERIDO_CADUCO',
    })
    expect(mockCheckout).not.toHaveBeenCalled()
  })

  it('🔴 Codex código r1 #1: el SUPERADMIN acortó la prueba (sigue ≥ 48 h) → 409, nunca un primer cobro antes de lo anunciado', async () => {
    const anunciada = new Date(Date.now() + 8 * 24 * H).toISOString()
    mockFilasDelPlan.mockResolvedValue([prueba(5 * 24)])
    await expect(
      createVenuePlanCheckoutSession('org-1', 'venue-1', 'monthly', 'PRO', { primerCobroAnunciado: anunciada }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'COBRO_DIFERIDO_CADUCO',
    })
    expect(mockCheckout).not.toHaveBeenCalled()
  })

  it('REGRESIÓN: otro plan durante la prueba, o sin prueba, abre el checkout de siempre (sin trial_end)', async () => {
    mockFilasDelPlan.mockResolvedValue([prueba(8 * 24)])
    await createVenuePlanCheckoutSession('org-1', 'venue-1', 'monthly', 'PREMIUM')
    expect(mockCheckout.mock.calls[0][0].trialEnd).toBeUndefined()
    expect(mockCheckout.mock.calls[0][0].successUrl).not.toContain('sinCobroHoy')
    mockFilasDelPlan.mockResolvedValue([])
    await createVenuePlanCheckoutSession('org-1', 'venue-1', 'monthly', 'PRO')
    expect(mockCheckout.mock.calls[1][0].trialEnd).toBeUndefined()
  })

  it('la lectura de la prueba va DENTRO de la regla común (bajo su candado)', async () => {
    mockFilasDelPlan.mockResolvedValue([prueba(8 * 24)])
    mockAutorizar.mockImplementation(async () => 'https://sin-crear.test')
    await createVenuePlanCheckoutSession('org-1', 'venue-1', 'monthly', 'PRO')
    expect(mockFilasDelPlan).not.toHaveBeenCalled()
  })
})
