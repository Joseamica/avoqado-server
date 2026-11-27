/**
 * Plan Básico, Task 4 — el alta con Básico: la prueba de 30 días de Pro que TERMINA SOLA SIN COBRAR.
 *
 * 🔴 Camino de dinero. La regla que cerró las rondas 7–10 de Codex: la modalidad la fija la PRIMERA creación en Stripe
 * (`cancel_at_period_end: true` en el MISMO create), se lee de Stripe en el momento, y NINGÚN camino del alta escribe ni
 * quita `cancel_at_period_end` sobre una suscripción que ya existe. El éxito describe SIEMPRE la modalidad real.
 */
const mockSubCreate = jest.fn()
const mockSubRetrieve = jest.fn()
const mockSubList = jest.fn()
const mockSubUpdate = jest.fn()
const mockPriceList = jest.fn()
const mockPmRetrieve = jest.fn()
const mockCustUpdate = jest.fn()

jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    subscriptions: { create: mockSubCreate, retrieve: mockSubRetrieve, list: mockSubList, update: mockSubUpdate },
    prices: { list: mockPriceList },
    paymentMethods: { retrieve: mockPmRetrieve },
    coupons: { create: jest.fn(), retrieve: jest.fn(), del: jest.fn() },
    customers: { create: jest.fn(), retrieve: jest.fn(), update: mockCustUpdate, listBalanceTransactions: jest.fn() },
    invoices: { list: jest.fn(), voidInvoice: jest.fn() },
    invoicePayments: { list: jest.fn() },
    creditNotes: { list: jest.fn() },
  })),
)

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))
const mockAutorizar = jest.fn()
jest.mock('@/services/access/autorizarObligacionNueva', () => ({
  ...jest.requireActual('@/services/access/autorizarObligacionNueva'),
  autorizarObligacionNueva: (...a: unknown[]) => mockAutorizar(...a),
}))
const mockEntregar = jest.fn()
jest.mock('@/services/stripe.service', () => ({
  ...jest.requireActual('@/services/stripe.service'),
  entregarSuscripcionDePlan: (...a: unknown[]) => mockEntregar(...a),
}))
jest.mock('@/services/onboarding/ensureVenue.service', () => ({
  __esModule: true,
  ensureVenueForOnboarding: jest.fn().mockResolvedValue({ id: 'venue-1', slug: 'bar-test', status: 'ONBOARDING' }),
}))
jest.mock('@/services/access/planNotification.service', () => ({
  __esModule: true,
  resolvePlanNotificationTarget: jest.fn().mockResolvedValue({ email: 'dueno@x.com', locale: 'es', venueName: 'Bar' }),
}))
jest.mock('@/services/email.service', () => ({
  __esModule: true,
  default: { sendPlanConfirmationEmail: jest.fn().mockResolvedValue(true) },
}))
jest.mock('@/services/resend.service', () => ({
  __esModule: true,
  sendPlanActivatedNotice: jest.fn().mockResolvedValue(true),
  sendOnboardingWelcomeEmail: jest.fn().mockResolvedValue(true),
}))
jest.mock('@/services/onboarding/terminarAltaCobrada', () => ({
  __esModule: true,
  terminarAltaCobradaSinRomper: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/launchCampaigns/hybridCampaign.service', () => ({
  __esModule: true,
  getPublicBasicPlan: jest.fn().mockResolvedValue({ priceWithoutTax: '499.00', priceWithTax: '578.84' }),
}))

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { activatePlan } from '@/services/onboarding/planActivation.service'
import { parseV2Plan } from '@/services/onboarding/onboardingProgress.service'
import { createPlanSubscription } from '@/services/stripe.service'
import { prismaMock } from '@tests/__helpers__/setup'
import emailService from '@/services/email.service'
import { sendPlanActivatedNotice } from '@/services/resend.service'

const FIN_DE_PRUEBA = Math.floor(new Date('2026-12-17T18:00:00Z').getTime() / 1000)
const BASE = {
  organizationId: 'org-1',
  staffId: 'staff-1',
  tier: 'PRO' as const,
  interval: 'monthly' as const,
  payNow: false,
  paymentMethodId: 'pm_1',
  offer: { kind: 'STANDARD' as const, expectedFirstChargeCents: 0 },
}

function progreso(overrides: Record<string, unknown> = {}) {
  return {
    id: 'op-1',
    organizationId: 'org-1',
    completedAt: null,
    v2SetupData: {},
    launchCampaignId: null,
    termsAcceptedAt: new Date('2026-11-17T00:00:00Z'),
    planActivationStatus: 'NONE',
    planActivationAttempt: 0,
    planActivationLeaseUntil: null,
    planStripeSubscriptionId: null,
    ...overrides,
  }
}

/** La suscripción como la tiene Stripe: en prueba, y con o sin «termina sin cobrar». */
function enPrueba(terminaSinCobro: boolean, id = 'sub_1') {
  return {
    id,
    status: 'trialing',
    cancel_at_period_end: terminaSinCobro,
    trial_end: FIN_DE_PRUEBA,
    current_period_end: FIN_DE_PRUEBA,
    latest_invoice: { amount_paid: 0, amount_due: 0 },
    metadata: terminaSinCobro ? { basicPlanChosen: 'true' } : {},
    items: { data: [{ price: { recurring: { interval: 'month' } } }] },
  }
}

/** El plan que el cierre agregó al formulario (`fusionarV2SetupData`). */
function planDelCierre(): any {
  const fusiones = (prismaMock.$executeRaw as jest.Mock).mock.calls.filter(
    (c: any[]) => Array.isArray(c[0]) && c[0].join('').includes('"v2SetupData"'),
  )
  const ultima = fusiones.at(-1)
  return ultima ? JSON.parse(ultima[1]).plan : undefined
}

/** 🔴 Lo que ningún camino del alta puede hacer: tocar `cancel_at_period_end` de una suscripción que ya existe. */
function nadieTocoLaModalidad() {
  const tocadas = mockSubUpdate.mock.calls.filter(([, cuerpo]) => cuerpo && 'cancel_at_period_end' in cuerpo)
  expect(tocadas).toEqual([])
  expect(mockSubUpdate).not.toHaveBeenCalled()
}

/** Las veces que se fijó la tarjeta del cliente (`getOrCreateStripeCustomer` también actualiza su descripción). */
const tarjetaFijada = () => mockCustUpdate.mock.calls.filter(([, cuerpo]) => cuerpo?.invoice_settings)

const vaciar = async () => {
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r))
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.$transaction.mockImplementation(async (cb: unknown) => (cb as (tx: unknown) => unknown)(prismaMock))
  mockAutorizar.mockReset().mockImplementation(async (_v: string, _c: string, _i: unknown, crear: () => Promise<unknown>) => crear())
  mockEntregar.mockReset().mockImplementation(async ({ subscriptionId }: { subscriptionId: string }) => ({
    venueId: 'venue-1',
    featureId: 'feat-pro',
    featureCode: 'PLAN_PRO',
    subscriptionId,
    endDate: null,
  }))
  mockPriceList.mockReset().mockResolvedValue({
    data: [{ id: 'price_x', unit_amount: 115884, currency: 'mxn', recurring: { interval: 'month' }, tax_behavior: 'inclusive' }],
  })
  mockPmRetrieve.mockReset().mockResolvedValue({ id: 'pm_1', customer: 'cus_1', card: { fingerprint: 'fp_1' } })
  mockSubCreate.mockReset().mockResolvedValue({ id: 'sub_1', status: 'trialing' })
  mockSubUpdate.mockReset()
  mockCustUpdate.mockReset().mockResolvedValue({ id: 'cus_1' })
  mockSubRetrieve.mockReset().mockResolvedValue(enPrueba(true))
  prismaMock.hybridPurchase.findUnique.mockResolvedValue(null as never)
  prismaMock.venue.findUnique.mockResolvedValue({
    id: 'venue-1',
    name: 'Bar',
    slug: 'bar-test',
    email: 'b@x.com',
    timezone: 'America/Mexico_City',
    stripeCustomerId: 'cus_1',
    organization: { email: 'o@x.com', name: 'Org' },
  } as never)
  prismaMock.venue.update.mockResolvedValue({} as never)
  prismaMock.onboardingProgress.updateMany.mockResolvedValue({ count: 1 } as never)
  prismaMock.launchCampaignRedemption.findFirst.mockResolvedValue(null as never)
  prismaMock.feature.findFirst.mockResolvedValue({ id: 'feat-pro', code: 'PLAN_PRO', monthlyPrice: 999 } as never)
  prismaMock.venueFeature.findUnique.mockResolvedValue(null as never)
  prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso() as never)
})

describe('parseV2Plan conserva basicPlan (Codex r4 #1)', () => {
  it('un plan guardado con basicPlan:true lo devuelve', () => {
    expect(parseV2Plan({ plan: { tier: 'PRO', interval: 'monthly', payNow: false, basicPlan: true } })).toMatchObject({
      tier: 'PRO',
      basicPlan: true,
    })
  })
  it('sin basicPlan (o con otra cosa) no lo inventa', () => {
    expect(parseV2Plan({ plan: { tier: 'PRO' } })?.basicPlan).toBeUndefined()
    expect(parseV2Plan({ step10: { plan: { tier: 'PRO', basicPlan: 'si' } } })?.basicPlan).toBeUndefined()
  })
})

describe('alta corta (activate-plan) con Básico', () => {
  it('🔴 Stripe recibe trial 30, cancel_at_period_end y la metadata en el MISMO create; responde ENDS_FREE', async () => {
    const r = await activatePlan({ ...BASE, basicPlan: true })

    expect(mockSubCreate).toHaveBeenCalledTimes(1)
    const [cuerpo] = mockSubCreate.mock.calls[0]
    expect(cuerpo.trial_period_days).toBe(30)
    expect(cuerpo.cancel_at_period_end).toBe(true)
    expect(cuerpo.metadata).toMatchObject({ basicPlanChosen: 'true' })
    expect(cuerpo.payment_behavior).toBeUndefined()
    expect(r).toMatchObject({
      status: 'ACTIVE',
      alreadyActive: false,
      trialModality: 'ENDS_FREE',
      trialEndsAt: new Date(FIN_DE_PRUEBA * 1000).toISOString(),
    })
    nadieTocoLaModalidad()
  })

  it('fija la tarjeta del alta como predeterminada del cliente (para el clic del día 30)', async () => {
    await activatePlan({ ...BASE, basicPlan: true })
    expect(mockCustUpdate).toHaveBeenCalledWith(
      'cus_1',
      { invoice_settings: { default_payment_method: 'pm_1' } },
      expect.objectContaining({ timeout: expect.any(Number) }),
    )
  })

  it('🔴 si fijar la tarjeta falla, el alta termina igual (es comodidad, no garantía)', async () => {
    mockCustUpdate.mockRejectedValue(new Error('Stripe caído'))
    const r = await activatePlan({ ...BASE, basicPlan: true })
    expect(r).toMatchObject({ status: 'ACTIVE', trialModality: 'ENDS_FREE' })
  })

  it('el plan guardado conserva basicPlan sólo porque la suscripción REAL termina sin cobrar', async () => {
    await activatePlan({ ...BASE, basicPlan: true })
    expect(planDelCierre()).toMatchObject({ tier: 'PRO', payNow: false, basicPlan: true })
  })

  it('🔴 el correo dice Básico: termina sin cobro y nunca anuncia el cobro de Pro', async () => {
    await activatePlan({ ...BASE, basicPlan: true })
    await vaciar()
    expect(emailService.sendPlanConfirmationEmail).toHaveBeenCalledWith(
      'dueno@x.com',
      expect.objectContaining({ payNow: false, trialEndsFree: true, basicPlanPriceWithoutTaxCents: 49900 }),
    )
  })

  it('🔴 el aviso interno al equipo dice «prueba sin cobro» y no calcula un primer cobro de Pro (revisión final #6)', async () => {
    await activatePlan({ ...BASE, basicPlan: true })
    await vaciar()
    expect(sendPlanActivatedNotice).toHaveBeenCalledWith(expect.objectContaining({ trialEndsFree: true, firstChargeCents: 0 }))
  })
})

describe('alta de Pro normal: igual que hoy', () => {
  it('sin cancel_at_period_end ni metadata del Básico, sin tocar la tarjeta del cliente; responde RENEWS_AS_PRO', async () => {
    mockSubRetrieve.mockResolvedValue(enPrueba(false))
    const r = await activatePlan(BASE)

    const [cuerpo] = mockSubCreate.mock.calls[0]
    expect(cuerpo.trial_period_days).toBe(30)
    expect(cuerpo).not.toHaveProperty('cancel_at_period_end')
    expect(cuerpo.metadata).not.toHaveProperty('basicPlanChosen')
    expect(tarjetaFijada()).toEqual([])
    expect(r).toMatchObject({ trialModality: 'RENEWS_AS_PRO' })
    expect(planDelCierre()).not.toHaveProperty('basicPlan')
    await vaciar()
    const [, datos] = (emailService.sendPlanConfirmationEmail as jest.Mock).mock.calls[0]
    expect(datos.trialEndsFree).toBeFalsy()
    expect(datos.firstChargeAmountCents).toBe(115884)
    const [aviso] = (sendPlanActivatedNotice as jest.Mock).mock.calls[0]
    expect(aviso).not.toHaveProperty('trialEndsFree')
    expect(aviso.firstChargeCents).toBe(115884)
  })

  it('pagando hoy no hay prueba: sin trialModality', async () => {
    mockSubRetrieve.mockResolvedValue({ ...enPrueba(false), status: 'active', latest_invoice: { amount_paid: 69484 } })
    const r = await activatePlan({ ...BASE, payNow: true, offer: { kind: 'STANDARD', expectedFirstChargeCents: 69484 } })
    expect(r.trialModality).toBeUndefined()
    expect(r.trialEndsAt).toBeUndefined()
  })
})

describe('🔴 ningún camino que REUTILIZA cambia la modalidad; el éxito dice la real', () => {
  const activo = (terminaSinCobro: boolean, plan: Record<string, unknown> = {}) => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(
      progreso({
        planActivationStatus: 'ACTIVE',
        planStripeSubscriptionId: 'sub_1',
        v2SetupData: { plan: { tier: 'PRO', interval: 'monthly', payNow: false, ...plan } },
      }) as never,
    )
    mockSubRetrieve.mockResolvedValue(enPrueba(terminaSinCobro))
  }

  it('Pro normal ya activo + alta con Básico → éxito RENEWS_AS_PRO, sin tocar Stripe (alreadyActive)', async () => {
    activo(false)
    const r = await activatePlan({ ...BASE, basicPlan: true })
    expect(r).toMatchObject({ alreadyActive: true, trialModality: 'RENEWS_AS_PRO' })
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(tarjetaFijada()).toEqual([])
    nadieTocoLaModalidad()
  })

  it('Básico ya activo + alta con Pro normal → ENDS_FREE, sin tocar Stripe', async () => {
    activo(true, { basicPlan: true })
    const r = await activatePlan(BASE)
    expect(r).toMatchObject({ alreadyActive: true, trialModality: 'ENDS_FREE' })
    expect(mockSubCreate).not.toHaveBeenCalled()
    nadieTocoLaModalidad()
  })

  it('«Quedarme en Pro» y luego un reintento viejo del alta con basicPlan → Pro sigue renovando', async () => {
    // Tras «Reactivar plan», Stripe ya no trae cancel_at_period_end; el reintento viejo no lo vuelve a poner.
    activo(false, { basicPlan: true })
    const r = await activatePlan({ ...BASE, basicPlan: true })
    expect(r).toMatchObject({ trialModality: 'RENEWS_AS_PRO' })
    nadieTocoLaModalidad()
  })

  it('IN_PROGRESS recuperado por su id: no crea, no cambia, responde la modalidad de lo que existe', async () => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(
      progreso({
        planActivationStatus: 'IN_PROGRESS',
        planActivationAttempt: 1,
        planActivationLeaseUntil: new Date(Date.now() - 60_000),
        planStripeSubscriptionId: 'sub_1',
      }) as never,
    )
    mockSubRetrieve.mockResolvedValue(enPrueba(false))
    const r = await activatePlan({ ...BASE, basicPlan: true })
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(r).toMatchObject({ trialModality: 'RENEWS_AS_PRO' })
    expect(planDelCierre()).not.toHaveProperty('basicPlan')
    nadieTocoLaModalidad()
  })

  it('IN_PROGRESS de un Básico recuperado con un reintento de Pro normal → ENDS_FREE', async () => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(
      progreso({
        planActivationStatus: 'IN_PROGRESS',
        planActivationAttempt: 1,
        planActivationLeaseUntil: new Date(Date.now() - 60_000),
        planStripeSubscriptionId: 'sub_1',
      }) as never,
    )
    const r = await activatePlan(BASE)
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(r).toMatchObject({ trialModality: 'ENDS_FREE' })
    nadieTocoLaModalidad()
  })

  it('el revisor de altas a medio pago (`soloRecuperar`) cierra sin tocar la modalidad', async () => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(
      progreso({
        planActivationStatus: 'IN_PROGRESS',
        planActivationAttempt: 1,
        planActivationLeaseUntil: new Date(Date.now() - 60_000),
        planStripeSubscriptionId: 'sub_1',
      }) as never,
    )
    const r = await activatePlan(BASE, { soloRecuperar: 'sub_1', via: 'barrido' })
    expect(r).toMatchObject({ trialModality: 'ENDS_FREE' })
    expect(mockSubCreate).not.toHaveBeenCalled()
    nadieTocoLaModalidad()
  })

  it('`createPlanSubscription` reusa (`reused: true`) sin tocar cancel_at_period_end; el alta dice la real', async () => {
    // El negocio ya tiene su suscripción de Pro normal ligada (p. ej. por el dashboard); el alta con Básico la reusa.
    prismaMock.venueFeature.findUnique.mockResolvedValue({ stripeSubscriptionId: 'sub_viejo' } as never)
    mockSubRetrieve.mockResolvedValue(enPrueba(false, 'sub_viejo'))
    const r = await activatePlan({ ...BASE, basicPlan: true })
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(tarjetaFijada()).toEqual([])
    expect(r).toMatchObject({ trialModality: 'RENEWS_AS_PRO' })
    nadieTocoLaModalidad()
  })
})

describe('validación de basicPlan en el servicio', () => {
  it.each([
    ['pagando hoy', { payNow: true, offer: { kind: 'STANDARD' as const, expectedFirstChargeCents: 69484 } }],
    ['con Premium', { tier: 'PREMIUM' as const }],
    ['anual', { interval: 'annual' as const }],
  ])('🔴 basicPlan %s → 400 y cero llamadas a Stripe', async (_caso, cambios) => {
    await expect(activatePlan({ ...BASE, ...cambios, basicPlan: true })).rejects.toMatchObject({ statusCode: 400 })
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(mockPriceList).not.toHaveBeenCalled()
  })
})

describe('createPlanSubscription', () => {
  it('🔴 cancelAtTrialEnd sin prueba (pagar hoy) lanza: no hay prueba que pueda terminar sola', async () => {
    await expect(
      createPlanSubscription({
        venueId: 'venue-1',
        customerId: 'cus_1',
        paymentMethodId: 'pm_1',
        priceId: 'price_cotizado',
        tierCode: 'PLAN_PRO',
        interval: 'monthly',
        trialPeriodDays: 0,
        cancelAtTrialEnd: true,
      }),
    ).rejects.toThrow()
    expect(mockSubCreate).not.toHaveBeenCalled()
  })

  it('🔴 en su código, cancel_at_period_end sólo vive en el create y nunca hay subscriptions.update', () => {
    const fuente = readFileSync(join(__dirname, '../../../../src/services/stripe.service.ts'), 'utf8')
    const inicio = fuente.indexOf('export async function createPlanSubscription(')
    const fin = fuente.indexOf('\nexport ', inicio + 10)
    const cuerpo = fuente.slice(inicio, fin)
    expect(cuerpo).not.toMatch(/subscriptions\.update/)
    expect(cuerpo.match(/cancel_at_period_end/g)?.length).toBe(1)
  })
})

describe('🔴 cerca: los caminos del alta que reutilizan no tienen con qué cambiar la modalidad', () => {
  // La lista medida (Codex r9): crear, reusar, alreadyActive, IN_PROGRESS, resolverIntentoIncompleto, PLAN_YA_CONTRATADO,
  // retorno anticipado, job y webhook de altas a medio pago, terminarAltaCobrada. Ninguno puede llamar a quien escribe
  // `cancel_at_period_end`: sólo «Tu plan» (`setSubscriptionCancelAtPeriodEnd`, `cancelPlan`, `reactivatePlan`).
  it.each([
    'src/services/onboarding/planActivation.service.ts',
    'src/controllers/onboarding.controller.ts',
    'src/jobs/altas-a-medio-pago.job.ts',
    'src/services/onboarding/altaPorAvisoDeStripe.ts',
    'src/services/onboarding/terminarAltaCobrada.ts',
  ])('%s', archivo => {
    const fuente = readFileSync(join(__dirname, '../../../../', archivo), 'utf8')
    expect(fuente).not.toMatch(/subscriptions\.update\(/)
    expect(fuente).not.toMatch(/setSubscriptionCancelAtPeriodEnd|cancelPlan\(|reactivatePlan\(/)
    expect(fuente).not.toMatch(/cancel_at_period_end\s*:/)
  })
})
