/**
 * Plan Básico (17-nov, Task 6): «Tu plan» sabe del Básico.
 * - `basicPlan`: un contrato del Básico se ve como «Básico», no como «Gratis».
 * - `basicOffer.canEndProNow` sale de `isLastDiscountedPeriod`, la MISMA regla del aviso «Tu Pro sube».
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
import { basicPlanActive, getPlanState } from '@/services/dashboard/planState.service'
import { isLastDiscountedPeriod } from '@/services/billing/ultimoPeriodoConDescuento'

const FIN = new Date('2026-12-05T17:00:00Z')
const BASICO = {
  slug: 'plan-basico',
  name: 'Básico',
  priceWithTax: '578.84',
  priceWithoutTax: '499.00',
  featureCodes: ['A'],
  seatCap: 2,
  trialDays: 30,
  publicationId: 'pub_b',
}
const resumen = (over: Record<string, unknown> = {}) => ({
  status: 'active',
  cancelAtPeriodEnd: false,
  currentPeriodEnd: FIN,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  hasActiveDiscount: false,
  pausedUntil: null,
  interval: 'month',
  grossAmountCents: 115884,
  descuento: null,
  ...over,
})
const repetido = (endsAt: Date) => ({ percentOff: 30, amountOffCents: null, duration: 'repeating' as const, endsAt })
const filaPro = (over: Record<string, unknown> = {}) => ({
  id: 'vf1',
  active: true,
  endDate: null,
  suspendedAt: null,
  gracePeriodEndsAt: null,
  monthlyPrice: { toNumber: () => 999 },
  stripeSubscriptionId: 'sub_1',
  updatedAt: new Date(),
  feature: { code: 'PLAN_PRO', name: 'Plan Pro' },
  ...over,
})
const contratoBasico = (grants: unknown[] = [{ id: 'g1' }]) => ({
  publication: {
    name: 'Básico',
    definition: { kind: 'FEATURES', basicPlan: true, seatCap: 2, featureCodes: ['A'], terms: { price: 578.84 } },
  },
  grants,
})

beforeEach(() => {
  mockRetrieve.mockReset()
  mockBasico.mockReset().mockResolvedValue(BASICO)
  prismaMock.venue.findUnique.mockResolvedValue({
    id: 'v1',
    stripeCustomerId: 'cus_1',
    seatCapExempt: false,
    organization: { seatCapExempt: false },
  } as never)
  prismaMock.venueFeature.findMany.mockResolvedValue([filaPro()] as never)
  prismaMock.hybridContract.findFirst.mockResolvedValue(null)
})

describe('isLastDiscountedPeriod (la regla de «Tu Pro sube» y de canEndProNow)', () => {
  const now = new Date('2026-11-20T12:00:00Z')
  it.each([
    ['sin descuento → true', null, FIN, true],
    ['repeating que termina antes del próximo cobro → true', repetido(new Date('2026-12-01T00:00:00Z')), FIN, true],
    ['repeating que termina justo en el próximo cobro → true', repetido(FIN), FIN, true],
    ['repeating que sigue después del próximo cobro → false', repetido(new Date('2027-02-05T17:00:00Z')), FIN, false],
    ['once todavía sin usar → false', { percentOff: 30, amountOffCents: null, duration: 'once' as const, endsAt: null }, FIN, false],
    ['forever → false', { percentOff: 30, amountOffCents: null, duration: 'forever' as const, endsAt: null }, FIN, false],
    ['repeating sin fin de periodo conocido → false', repetido(FIN), null, false],
  ])('%s', (_c, descuento, currentPeriodEnd, esperado) => {
    expect(isLastDiscountedPeriod({ descuento, currentPeriodEnd }, now)).toBe(esperado)
  })
})

describe('getPlanState — basicPlan (el contrato del Básico se ve como «Básico»)', () => {
  it('🔴 negocio sin fila de plan y con el Básico vigente → basicPlan activo con su nombre y precio; no se le ofrece otra vez', async () => {
    prismaMock.venueFeature.findMany.mockResolvedValue([] as never)
    prismaMock.hybridContract.findFirst.mockImplementation(((args: { where: { publication?: unknown } }) =>
      Promise.resolve(args.where.publication ? contratoBasico() : null)) as never)
    const plan = await getPlanState('v1')
    expect(plan.basicPlan).toEqual({ active: true, name: 'Básico', price: { base: 499, gross: 578.84, currency: 'MXN' } })
    expect(plan.basicOffer).toBeNull()
    // La lectura del contrato del Básico filtra por la definición y por el negocio.
    expect(prismaMock.hybridContract.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { venueId: 'v1', endedAt: null, publication: { definition: { path: ['basicPlan'], equals: true } } },
      }),
    )
  })

  it('contrato del Básico sin funciones vigentes hoy → active false', async () => {
    prismaMock.venueFeature.findMany.mockResolvedValue([] as never)
    prismaMock.hybridContract.findFirst.mockImplementation(((args: { where: { publication?: unknown } }) =>
      Promise.resolve(args.where.publication ? contratoBasico([]) : null)) as never)
    expect((await getPlanState('v1')).basicPlan).toMatchObject({ active: false, name: 'Básico' })
  })

  it('un contrato de campaña PRO NO se lee como Básico (aunque el mock lo devuelva a la consulta del Básico)', async () => {
    mockRetrieve.mockResolvedValue(resumen())
    prismaMock.hybridContract.findFirst.mockResolvedValue({
      publication: { name: 'Pro $22', definition: { kind: 'PLAN' } },
      grants: [],
    } as never)
    expect((await getPlanState('v1')).basicPlan).toBeNull()
  })
})

describe('basicPlanActive — el chip del negocio dice «Básico», no «Free» (full-testing 17-nov)', () => {
  it('🔴 Básico con funciones vigentes hoy → true', async () => {
    prismaMock.hybridContract.findFirst.mockResolvedValue(contratoBasico() as never)
    await expect(basicPlanActive('v1')).resolves.toBe(true)
  })

  it('sin contrato del Básico, o con el Básico sin funciones vigentes → false', async () => {
    await expect(basicPlanActive('v1')).resolves.toBe(false)
    prismaMock.hybridContract.findFirst.mockResolvedValue(contratoBasico([]) as never)
    await expect(basicPlanActive('v1')).resolves.toBe(false)
  })

  it('la base falla → false, nunca lanza (el chip no tumba la señal del tier que leen todos los roles)', async () => {
    prismaMock.hybridContract.findFirst.mockRejectedValue(new Error('P1001'))
    await expect(basicPlanActive('v1')).resolves.toBe(false)
  })
})

describe('getPlanState — basicOffer', () => {
  it('Gratis con Básico publicado → se ofrece ya (availableAt null), con su precio sin y con IVA', async () => {
    prismaMock.venueFeature.findMany.mockResolvedValue([] as never)
    expect((await getPlanState('v1')).basicOffer).toEqual({
      availableAt: null,
      price: { base: 499, gross: 578.84, currency: 'MXN' },
      canEndProNow: false,
      discountEndsAt: null,
    })
  })

  it('sin Básico publicado → basicOffer null', async () => {
    mockBasico.mockResolvedValue(null)
    prismaMock.venueFeature.findMany.mockResolvedValue([] as never)
    expect((await getPlanState('v1')).basicOffer).toBeNull()
  })

  it('Pro mensual sin descuento → canEndProNow true, disponible al fin del periodo', async () => {
    mockRetrieve.mockResolvedValue(resumen())
    expect((await getPlanState('v1')).basicOffer).toMatchObject({
      availableAt: FIN.toISOString(),
      canEndProNow: true,
      discountEndsAt: null,
    })
  })

  it('🔴 Pro con meses de descuento por delante → canEndProNow false y dice hasta cuándo sigue el descuento', async () => {
    const fin = new Date('2027-02-05T17:00:00Z')
    mockRetrieve.mockResolvedValue(resumen({ hasActiveDiscount: true, descuento: repetido(fin) }))
    expect((await getPlanState('v1')).basicOffer).toMatchObject({ canEndProNow: false, discountEndsAt: fin.toISOString() })
  })

  it('🔴 revisión #2: descuento vigente que no se entiende (hasActiveDiscount sin descuento) → canEndProNow false', async () => {
    mockRetrieve.mockResolvedValue(resumen({ hasActiveDiscount: true, descuento: null }))
    expect((await getPlanState('v1')).basicOffer).toMatchObject({ canEndProNow: false, discountEndsAt: null })
  })

  it('Pro en su ÚLTIMO periodo con descuento → canEndProNow true', async () => {
    mockRetrieve.mockResolvedValue(resumen({ hasActiveDiscount: true, descuento: repetido(new Date('2026-12-01T00:00:00Z')) }))
    expect((await getPlanState('v1')).basicOffer).toMatchObject({ canEndProNow: true })
  })

  it('prueba que termina sin cobrar (Básico elegido) → disponible el día que termina, sin «terminar Pro»', async () => {
    mockRetrieve.mockResolvedValue(resumen({ status: 'trialing', cancelAtPeriodEnd: true }))
    const plan = await getPlanState('v1')
    expect(plan.trialModality).toBe('ENDS_FREE')
    expect(plan.basicOffer).toMatchObject({ availableAt: FIN.toISOString(), canEndProNow: false })
  })

  it.each([
    ['Premium', { feature: { code: 'PLAN_PREMIUM', name: 'Plan Premium' } }, resumen()],
    ['anual', {}, resumen({ interval: 'year' })],
  ])('%s → sin oferta del Básico', async (_c, fila, sub) => {
    prismaMock.venueFeature.findMany.mockResolvedValue([filaPro(fila)] as never)
    mockRetrieve.mockResolvedValue(sub)
    expect((await getPlanState('v1')).basicOffer).toBeNull()
  })

  it('grandfathered → sin oferta', async () => {
    prismaMock.venue.findUnique.mockResolvedValue({
      id: 'v1',
      stripeCustomerId: 'cus_1',
      seatCapExempt: true,
      organization: { seatCapExempt: false },
    } as never)
    mockRetrieve.mockResolvedValue(resumen())
    expect((await getPlanState('v1')).basicOffer).toBeNull()
  })

  it('el catálogo híbrido falla → sin oferta, «Tu plan» sigue saliendo', async () => {
    mockBasico.mockRejectedValue(new Error('db'))
    mockRetrieve.mockResolvedValue(resumen())
    const plan = await getPlanState('v1')
    expect(plan.basicOffer).toBeNull()
    expect(plan.origin?.kind).toBe('CLASSIC')
  })

  // Regresión: lo de antes no cambia.
  it('regresión: Pro clásico sigue con su origin, trialModality y precio de siempre', async () => {
    mockRetrieve.mockResolvedValue(resumen())
    const plan = await getPlanState('v1')
    expect(plan).toMatchObject({ planTier: 'PRO', origin: { kind: 'CLASSIC', price: { gross: 1158.84 } }, trialModality: null })
  })
})
