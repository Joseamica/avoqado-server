/**
 * Planes editables B2, Task 10 (§11.2, §12.8): con una versión del editor el Básico ya no se vende, también por «Terminar mi Pro al
 * acabar el periodo» (`purpose: 'BASIC_PLAN'`, el paso que lleva al Básico): 409 `PLAN_NOT_ON_SALE` (tier `BASICO`) antes de programar
 * nada y sin tocar Stripe. «Cancelar plan» de siempre (sin `purpose`) no cambia. Sin versión del editor, la cancelación de hoy.
 */
import { prismaMock } from '../../../__helpers__/setup'
import * as stripeService from '@/services/stripe.service'
import { cancelPlan } from '@/services/dashboard/planState.service'
import { scheduleDowngradeToFree } from '@/services/dashboard/seatReconciliation.service'
import { definicionDePrueba, idsDeLaVersion, punteroA, versionUno } from '@tests/__helpers__/planOfferFixtures'

jest.mock('@/services/stripe.service')
const mockStripe = stripeService as jest.Mocked<typeof stripeService>

const DAY = 86400000
const FIN = new Date(Date.now() + 10 * DAY)
const filaPro = {
  id: 'vf_1',
  active: true,
  endDate: null,
  suspendedAt: null,
  gracePeriodEndsAt: null,
  monthlyPrice: { toNumber: () => 999 },
  stripeSubscriptionId: 'sub_123',
  updatedAt: new Date(),
  feature: { code: 'PLAN_PRO', name: 'Plan Pro' },
}
const sub = {
  status: 'active',
  cancelAtPeriodEnd: false,
  currentPeriodEnd: FIN,
  createdAt: new Date(Date.now() - 90 * DAY),
  hasActiveDiscount: false,
  pausedUntil: null,
  interval: 'month' as const,
  grossAmountCents: 115884,
  descuento: null,
}
const pointer = prismaMock.planOfferPointer.findUnique as jest.Mock
const fueraDeVenta = {
  statusCode: 409,
  code: 'PLAN_NOT_ON_SALE',
  message: 'El plan Básico ya no está a la venta. Elige otro plan. No se te cobró nada.',
  details: { tier: 'BASICO' },
}

beforeEach(() => {
  pointer.mockReset().mockResolvedValue(null)
  prismaMock.venueFeature.findMany.mockResolvedValue([filaPro] as never)
  prismaMock.venue.findUnique.mockResolvedValue({ id: 'v1', timezone: 'America/Mexico_City', stripeCustomerId: 'cus_1' } as never)
  mockStripe.retrievePlanSubscription.mockResolvedValue(sub as never)
  mockStripe.setSubscriptionCancelAtPeriodEnd.mockResolvedValue({} as never)
})

describe('B2 Task 10 · «Terminar mi Pro» para el Básico con una versión del editor', () => {
  it('con la v2, cancelPlan con purpose BASIC_PLAN → 409 PLAN_NOT_ON_SALE sin tocar Stripe; sin purpose, la cancelación de siempre', async () => {
    pointer.mockResolvedValue(punteroA('ver_v2', 2, definicionDePrueba({ ids: idsDeLaVersion('v2') })))
    await expect(cancelPlan('v1', { purpose: 'BASIC_PLAN' })).rejects.toMatchObject(fueraDeVenta)
    // Antes de programar nada: ni la lectura de Stripe del candado del descuento, ni el cambio, ni el candado de la cancelación.
    expect(mockStripe.retrievePlanSubscription).not.toHaveBeenCalled()
    expect(mockStripe.setSubscriptionCancelAtPeriodEnd).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    // El camino de «Tu plan» que baja a Gratis con su revisión de usuarios pasa por el mismo cancelPlan.
    prismaMock.staffVenue.findMany.mockResolvedValue([] as never)
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
    prismaMock.staffVenue.count.mockResolvedValue(1)
    await expect(scheduleDowngradeToFree('v1', [], { purpose: 'BASIC_PLAN' })).rejects.toMatchObject(fueraDeVenta)
    expect(mockStripe.setSubscriptionCancelAtPeriodEnd).not.toHaveBeenCalled()

    // «Cancelar plan» de siempre (sin purpose) no es una compra del Básico: cancela igual con la v2.
    await cancelPlan('v1', {})
    expect(mockStripe.setSubscriptionCancelAtPeriodEnd).toHaveBeenCalledWith('sub_123', true)
  })

  it('regresión: sin versión del editor (o con la v1), «Terminar mi Pro» del Básico cancela como hoy', async () => {
    for (const puntero of [null, punteroA('ver_v1', 1, versionUno())]) {
      pointer.mockResolvedValue(puntero)
      mockStripe.setSubscriptionCancelAtPeriodEnd.mockClear()
      await cancelPlan('v1', { purpose: 'BASIC_PLAN' })
      expect(mockStripe.setSubscriptionCancelAtPeriodEnd).toHaveBeenCalledWith('sub_123', true)
    }
  })
})
