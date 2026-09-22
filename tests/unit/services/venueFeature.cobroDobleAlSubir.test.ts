/**
 * Hallazgo #1 del 21-sep-2026 (P1 💰): subir de plan dejaba COBRANDO la función suelta que el plan
 * ya incluye — el negocio pagaba las dos.
 *
 * La decisión del founder es «como lo hace Claude»: cancelar la suelta, acreditar los días no usados
 * y cobrar sólo la diferencia. Eso exige medir en Stripe de prueba cómo sale el crédito y auditarlo
 * antes de mover dinero. Mientras tanto, este es el PARCHE INICIAL que el plan ya preveía: no se sube
 * de plan con una suelta que siga cobrando y que el plan absorba. Se dice cuál es y qué hacer.
 */
const mockEstado = jest.fn()
jest.mock('../../../src/services/stripe.service', () => ({
  estadoDeLaSuscripcion: (...a: unknown[]) => mockEstado(...a),
  stripeAfirmaQueNoExiste: (e: any) => e?.code === 'resource_missing',
  createTrialSubscriptions: jest.fn(),
  cancelSubscription: jest.fn(),
}))

const mockFindMany = jest.fn()
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: { venueFeature: { findMany: (...a: unknown[]) => mockFindMany(...a) } },
}))
jest.mock('../../../src/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import { assertSinCobroDobleAlSubir } from '../../../src/services/dashboard/venueFeature.dashboard.service'

const inventarioSuelto = (stripeSubscriptionId: string | null) => ({
  id: 'vf-inv',
  monthlyPrice: 89,
  stripeSubscriptionId,
  feature: { code: 'INVENTORY_TRACKING', name: 'Inventario' },
})

beforeEach(() => {
  mockEstado.mockReset()
  mockFindMany.mockReset()
})

describe('assertSinCobroDobleAlSubir — no se sube de plan pagando dos veces lo mismo', () => {
  it('🔴 subir a PREMIUM con inventario suelto COBRANDO → 409 que nombra la función', async () => {
    mockFindMany.mockResolvedValue([inventarioSuelto('sub_inv')])
    mockEstado.mockResolvedValue('active')

    await expect(assertSinCobroDobleAlSubir('venue-1', 'PREMIUM')).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAN_ABSORBS_ALA_CARTE',
      details: { features: [{ code: 'INVENTORY_TRACKING', name: 'Inventario' }] },
    })
  })

  it.each(['trialing', 'past_due', 'unpaid', 'incomplete', 'paused'])('%s también cuenta como que sigue cobrando', async estado => {
    mockFindMany.mockResolvedValue([inventarioSuelto('sub_inv')])
    mockEstado.mockResolvedValue(estado)

    await expect(assertSinCobroDobleAlSubir('venue-1', 'PREMIUM')).rejects.toMatchObject({ code: 'PLAN_ABSORBS_ALA_CARTE' })
  })

  it('una suelta ya CANCELADA en Stripe (vínculo viejo en la base) no bloquea', async () => {
    mockFindMany.mockResolvedValue([inventarioSuelto('sub_inv')])
    mockEstado.mockResolvedValue('canceled')

    await expect(assertSinCobroDobleAlSubir('venue-1', 'PREMIUM')).resolves.toBeUndefined()
  })

  it('si Stripe AFIRMA que la suscripción no existe, no bloquea', async () => {
    mockFindMany.mockResolvedValue([inventarioSuelto('sub_inv')])
    mockEstado.mockRejectedValue(Object.assign(new Error('No such subscription'), { code: 'resource_missing' }))

    await expect(assertSinCobroDobleAlSubir('venue-1', 'PREMIUM')).resolves.toBeUndefined()
  })

  it('🔴 si Stripe no contesta, NO se sube a ciegas: 503 reintentable', async () => {
    mockFindMany.mockResolvedValue([inventarioSuelto('sub_inv')])
    mockEstado.mockRejectedValue(Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' }))

    await expect(assertSinCobroDobleAlSubir('venue-1', 'PREMIUM')).rejects.toMatchObject({ statusCode: 503 })
  })

  it('una suelta sin suscripción de Stripe (concedida a mano) no cobra: no bloquea', async () => {
    mockFindMany.mockResolvedValue([inventarioSuelto(null)])

    await expect(assertSinCobroDobleAlSubir('venue-1', 'PREMIUM')).resolves.toBeUndefined()
    expect(mockEstado).not.toHaveBeenCalled()
  })

  it('subir a PRO con inventario suelto NO bloquea: PRO no incluye inventario, se conserva su cobro', async () => {
    mockFindMany.mockResolvedValue([inventarioSuelto('sub_inv')])

    await expect(assertSinCobroDobleAlSubir('venue-1', 'PRO')).resolves.toBeUndefined()
    expect(mockEstado).not.toHaveBeenCalled()
  })
})
