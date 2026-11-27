/**
 * Planes editables B4, Task 3: con una versión del editor el Básico ya no se vende, tampoco en «Tu plan» (`basicOffer`) ni en lo que
 * le dice el bot de soporte. Sin la opción, el servicio decide leyendo sólo el puntero, con tope de 1,500 ms; si falla o se vence,
 * nunca se promete un Básico (`basicOffer: null`).
 */
const mockRetrieve = jest.fn()
jest.mock('@/services/stripe.service', () => ({
  ...jest.requireActual('@/services/stripe.service'),
  retrievePlanSubscription: (...a: unknown[]) => mockRetrieve(...a),
}))
const mockBasico = jest.fn()
jest.mock('@/services/launchCampaigns/hybridCampaign.service', () => ({
  ...jest.requireActual('@/services/launchCampaigns/hybridCampaign.service'),
  getPublicBasicPlan: (...a: unknown[]) => mockBasico(...a),
}))
jest.mock('stripe')
import { prismaMock } from '../../../__helpers__/setup'
import logger from '@/config/logger'
import { getPlanState, getPlanStateYSuscripcion } from '@/services/dashboard/planState.service'
import { planStatus } from '@/services/support/data/capabilities/planStatus'
import type { DataScope } from '@/services/support/data/catalog'
import { definicionDePrueba, idsDeLaVersion, punteroA, versionUno } from '@tests/__helpers__/planOfferFixtures'

const FIN = new Date('2026-12-05T17:00:00Z')
const BASICO = { slug: 'plan-basico', name: 'Básico', priceWithTax: '578.84', priceWithoutTax: '499.00' }
const pointer = prismaMock.planOfferPointer.findUnique as jest.Mock
const v2 = () => punteroA('ver_v2', 2, definicionDePrueba({ ids: idsDeLaVersion('v2') }))
const filaPro = {
  id: 'vf1',
  active: true,
  endDate: null,
  suspendedAt: null,
  gracePeriodEndsAt: null,
  monthlyPrice: { toNumber: () => 999 },
  stripeSubscriptionId: 'sub_1',
  updatedAt: new Date(),
  feature: { code: 'PLAN_PRO', name: 'Plan Pro' },
}
const pruebaSinCobro = {
  status: 'trialing',
  cancelAtPeriodEnd: true,
  currentPeriodEnd: FIN,
  createdAt: new Date('2026-11-01T00:00:00Z'),
  hasActiveDiscount: false,
  pausedUntil: null,
  interval: 'month',
  grossAmountCents: 115884,
  descuento: null,
}
const venue = (exento = false) => ({ id: 'v1', stripeCustomerId: 'cus_1', seatCapExempt: exento, organization: { seatCapExempt: false } })

beforeEach(() => {
  jest.clearAllMocks()
  pointer.mockReset().mockResolvedValue(null)
  mockRetrieve.mockReset().mockResolvedValue(pruebaSinCobro)
  mockBasico.mockReset().mockResolvedValue(BASICO)
  prismaMock.venue.findUnique.mockResolvedValue(venue() as never)
  prismaMock.venueFeature.findMany.mockResolvedValue([filaPro] as never)
  prismaMock.hybridContract.findFirst.mockResolvedValue(null)
})

describe('B4 T3 · basicOffer con una versión del editor', () => {
  it('con la opción true → basicOffer null, sin leer el puntero ni el catálogo del Básico', async () => {
    const { planState } = await getPlanStateYSuscripcion('v1', { conVersionDelEditor: true })
    expect(planState.basicOffer).toBeNull()
    expect(pointer).not.toHaveBeenCalled()
    expect(mockBasico).not.toHaveBeenCalled()
  })

  it('con la opción false → lo de hoy, sin leer el puntero', async () => {
    const { planState } = await getPlanStateYSuscripcion('v1', { conVersionDelEditor: false })
    expect(planState.basicOffer).toMatchObject({ availableAt: FIN.toISOString() })
    expect(pointer).not.toHaveBeenCalled()
  })

  it('🔴 el bot (getPlanState sin la opción) con la v2: basicOffer null y no dice «podrás contratar el Básico»', async () => {
    pointer.mockResolvedValue(v2())
    const state = await getPlanState('v1', { skipPauseOffer: true })
    expect(state.trialModality).toBe('ENDS_FREE')
    expect(state.basicOffer).toBeNull()
    expect(mockBasico).not.toHaveBeenCalled()
    const scope = {
      venueId: 'v1',
      organizationId: 'org',
      venueName: 'Un negocio',
      timezone: 'America/Mexico_City',
      day: '2026-11-12',
      kycVerified: true,
      now: new Date('2026-11-12T20:32:00Z'),
      rows: 5,
      openOrdersDays: 7,
      depositGroups: 2000,
      depositTimeoutMs: 3000,
    } as DataScope
    const rendered = JSON.stringify(planStatus.render(scope, {} as never, state))
    expect(rendered).not.toMatch(/contratar el Básico/)
  })

  it('sin la opción y con la v1 / sin puntero → lo de hoy (se ofrece el Básico)', async () => {
    for (const p of [null, punteroA('ver_v1', 1, versionUno())]) {
      pointer.mockReset().mockResolvedValue(p)
      expect((await getPlanState('v1')).basicOffer).toMatchObject({ availableAt: FIN.toISOString() })
    }
  })

  it('el puntero lanza → basicOffer null y un aviso (nunca se promete el Básico)', async () => {
    pointer.mockRejectedValue(new Error('P1001'))
    expect((await getPlanState('v1')).basicOffer).toBeNull()
    expect(logger.warn).toHaveBeenCalled()
    expect(mockBasico).not.toHaveBeenCalled()
  })

  it('🔴 un puntero que nunca contesta: termina antes de 2 s con basicOffer null', async () => {
    pointer.mockReturnValue(new Promise(() => {}))
    const t0 = Date.now()
    const state = await getPlanState('v1')
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(state.basicOffer).toBeNull()
    expect(logger.warn).toHaveBeenCalled()
  })

  it('un negocio grandfathered no hace la lectura nueva', async () => {
    prismaMock.venue.findUnique.mockResolvedValue(venue(true) as never)
    expect((await getPlanState('v1')).basicOffer).toBeNull()
    expect(pointer).not.toHaveBeenCalled()
  })

  it('un negocio con Básico contratado tampoco la hace', async () => {
    prismaMock.venueFeature.findMany.mockResolvedValue([] as never)
    prismaMock.hybridContract.findFirst.mockImplementation(((args: { where: { publication?: unknown } }) =>
      Promise.resolve(
        args.where.publication
          ? {
              publication: {
                name: 'Básico',
                definition: { kind: 'FEATURES', basicPlan: true, seatCap: 2, featureCodes: ['A'], terms: { price: 578.84 } },
              },
              grants: [{ id: 'g1' }],
            }
          : null,
      )) as never)
    expect((await getPlanState('v1')).basicOffer).toBeNull()
    expect(pointer).not.toHaveBeenCalled()
  })
})
