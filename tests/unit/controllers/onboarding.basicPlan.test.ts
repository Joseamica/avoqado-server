/**
 * Plan Básico, Task 4 — el alta LARGA (`completeV2Onboarding`), el paso del plan, el esquema de `activate-plan` y
 * `GET /progress`.
 *
 * 🔴 La modalidad la fija la PRIMERA creación y se lee de Stripe; ningún camino del alta la escribe ni la quita. Cada
 * respuesta de éxito describe la modalidad REAL (aquí `suscripcionConTopeCorto`, la lectura acotada del SERVIDOR, y la
 * `modalidadDePrueba` real).
 */
import { Request, Response } from 'express'

jest.mock('../../../src/services/onboarding/onboardingProgress.service', () => ({
  __esModule: true,
  ...jest.requireActual('../../../src/services/onboarding/onboardingProgress.service'),
  getV2SetupDataForCompletion: jest.fn(),
  saveV2StepData: jest.fn(),
  getOnboardingProgress: jest.fn(),
  getOnboardingCompletionPercentage: jest.fn().mockResolvedValue(90),
  parseV2Step8: jest.fn().mockReturnValue(null),
  resolveTpvPurchaseForOnboarding: jest.fn(),
}))
jest.mock('../../../src/services/onboarding/venueCreation.service', () => ({
  __esModule: true,
  createVenueFromOnboarding: jest.fn(),
  applyBusinessInfoToVenue: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('../../../src/services/resend.service', () => ({
  __esModule: true,
  sendOnboardingWelcomeEmail: jest.fn().mockResolvedValue(true),
}))
jest.mock('../../../src/services/onboarding/ensureVenue.service', () => ({
  __esModule: true,
  ensureVenueForOnboarding: jest.fn().mockResolvedValue(null),
}))
jest.mock('../../../src/services/onboarding/signup.service', () => ({ __esModule: true }))
jest.mock('../../../src/services/onboarding/testPaymentLink.service', () => ({ __esModule: true }))
jest.mock('../../../src/services/onboarding/sesionTrasElAlta', () => ({
  __esModule: true,
  renovarSesionConLaSucursal: jest.fn().mockResolvedValue(undefined),
}))
const mockTerminar = jest.fn()
jest.mock('../../../src/services/onboarding/terminarAltaCobrada', () => ({
  __esModule: true,
  terminarAltaCobrada: (...a: unknown[]) => mockTerminar(...a),
}))
jest.mock('../../../src/services/billing/precioDelPlan', () => ({
  resolverPrecioDelPlan: jest.fn().mockResolvedValue({ priceId: 'price_x', unitAmount: 0 }),
  // Codex b2-code r5 A: el `catch` del alta larga pregunta `instanceof LecturaDeLaOfertaFallida`; aquí ninguna lectura falla.
  LecturaDeLaOfertaFallida: class LecturaDeLaOfertaFallida extends Error {},
}))
jest.mock('../../../src/services/stripe.service', () => ({
  __esModule: true,
  createOnboardingSetupIntent: jest.fn(),
  createPlanSetupIntent: jest.fn(),
  createPlanSubscription: jest.fn(),
  retrievePlanSubscription: jest.fn(),
  entregarSuscripcionDePlan: jest.fn(),
  getOrCreateStripeCustomer: jest.fn().mockResolvedValue('cus_1'),
  // B2 Task 6 (fix round 1): la modalidad sale de UNA lectura acotada de la suscripción (`suscripcionConTopeCorto`).
  suscripcionConTopeCorto: jest.fn(),
}))
const mockAutorizar = jest.fn()
jest.mock('../../../src/services/access/autorizarObligacionNueva', () => ({
  autorizarObligacionNueva: (...a: unknown[]) => mockAutorizar(...a),
}))
jest.mock('../../../src/services/access/planNotification.service', () => ({
  __esModule: true,
  resolvePlanNotificationTarget: jest.fn().mockResolvedValue({ email: 'dueno@x.com', locale: 'es', venueName: 'Bar', ownerName: null }),
}))
jest.mock('../../../src/services/email.service', () => ({
  __esModule: true,
  default: { sendPlanConfirmationEmail: jest.fn().mockResolvedValue(true) },
}))
jest.mock('../../../src/services/launchCampaigns/hybridCampaign.service', () => ({
  __esModule: true,
  getPublicBasicPlan: jest.fn().mockResolvedValue({ priceWithoutTax: '499.00' }),
}))
jest.mock('../../../src/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}))
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
    hybridPurchase: { findFirst: jest.fn() },
    onboardingProgress: { updateMany: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
    venue: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    organization: { update: jest.fn(), findUnique: jest.fn() },
    launchCampaign: { findUnique: jest.fn() },
    planOfferPointer: { findUnique: jest.fn().mockResolvedValue(null) },
  },
}))

import { ActivatePlanSchema, completeV2Onboarding, getOnboardingProgress, saveV2Step } from '../../../src/controllers/onboarding.controller'
import * as onboardingProgressService from '../../../src/services/onboarding/onboardingProgress.service'
import * as stripeService from '../../../src/services/stripe.service'
import * as venueCreationService from '../../../src/services/onboarding/venueCreation.service'
import emailService from '../../../src/services/email.service'
import prisma from '../../../src/utils/prismaClient'

const VENUE = { id: 'venue_1', slug: 'bar-test', name: 'Bar Test', status: 'ACTIVE' }
const FIN = '2026-12-17T18:00:00.000Z'
const ENDS_FREE = { trialModality: 'ENDS_FREE' as const, trialEndsAt: FIN }
const RENEWS = { trialModality: 'RENEWS_AS_PRO' as const, trialEndsAt: FIN }
/** La suscripción en prueba que da esa modalidad (lo que lee `suscripcionConTopeCorto`). */
const enPrueba = (m: typeof ENDS_FREE | typeof RENEWS) => ({
  id: 'sub_x',
  status: 'trialing',
  cancel_at_period_end: m.trialModality === 'ENDS_FREE',
  trial_end: Math.floor(Date.parse(m.trialEndsAt) / 1000),
  metadata: {},
})

const req = (body: Record<string, unknown> = {}, params: Record<string, string> = {}) =>
  ({
    params: { organizationId: 'org_1', ...params },
    body,
    authContext: { userId: 'user_1', orgId: 'org_1', venueId: 'pending', role: 'OWNER' },
  }) as unknown as Request
const res = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(), cookie: jest.fn().mockReturnThis() })
const vaciar = async () => {
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r))
}
const cuerpo = (r: ReturnType<typeof res>) => r.json.mock.calls[0][0]

/** El alta larga lista para cobrar, con el plan guardado como lo guarda el asistente. */
function alta(plan: Record<string, unknown>, progreso: Record<string, unknown> = {}) {
  ;(onboardingProgressService.getV2SetupDataForCompletion as jest.Mock).mockResolvedValue({
    progress: {
      v2SetupData: { step10: { plan: { tier: 'PRO', paymentMethodId: 'pm_1', interval: 'monthly', payNow: false, ...plan } } },
      termsAcceptedAt: new Date('2026-11-17T00:00:00Z'),
      planActivationStatus: 'NONE',
      ...progreso,
    },
    businessInfo: { name: 'Bar Test' },
    bankInfo: null,
    identityInfo: null,
    entityInfo: null,
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  process.env.ENABLE_VENUE_BASE_SUBSCRIPTION = 'true'
  ;(prisma.$transaction as jest.Mock).mockImplementation(async fn => fn(prisma))
  ;(prisma.$queryRaw as jest.Mock).mockResolvedValue([])
  ;(prisma.hybridPurchase.findFirst as jest.Mock).mockResolvedValue(null)
  ;(prisma.onboardingProgress.updateMany as jest.Mock).mockResolvedValue({ count: 1 })
  // Tras el cobro, el progreso apunta a la suscripción cobrada (lo escribe `marcarPlanCobrado`).
  ;(prisma.onboardingProgress.findUnique as jest.Mock).mockResolvedValue({
    planActivationStatus: 'ACTIVE',
    planStripeSubscriptionId: 'sub_1',
    completedAt: new Date(),
    organization: { onboardingCompletedAt: new Date() },
  })
  ;(prisma.venue.findFirst as jest.Mock).mockResolvedValue(null)
  ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ ...VENUE, email: 'b@x.com', timezone: 'America/Mexico_City' })
  ;(prisma.venue.update as jest.Mock).mockResolvedValue(VENUE)
  ;(prisma.organization.update as jest.Mock).mockResolvedValue({})
  ;(venueCreationService.createVenueFromOnboarding as jest.Mock).mockResolvedValue({ venue: VENUE, kycStatus: 'NOT_SUBMITTED' })
  mockAutorizar.mockImplementation(async (_v: string, _c: string, _i: unknown, crear: () => Promise<unknown>) => crear())
  ;(stripeService.createPlanSubscription as jest.Mock).mockResolvedValue({ subscriptionId: 'sub_1', reused: false })
  ;(stripeService.entregarSuscripcionDePlan as jest.Mock).mockResolvedValue({ featureCode: 'PLAN_PRO', subscriptionId: 'sub_1' })
  ;(stripeService.retrievePlanSubscription as jest.Mock).mockResolvedValue({
    currentPeriodEnd: new Date(FIN),
    status: 'trialing',
    cancelAtPeriodEnd: true,
  })
  ;(stripeService.suscripcionConTopeCorto as jest.Mock).mockResolvedValue(enPrueba(ENDS_FREE))
})

describe('alta larga (completeV2) con Básico', () => {
  it('🔴 crea con trial 30 y cancelAtTrialEnd, y la respuesta dice la modalidad REAL', async () => {
    alta({ basicPlan: true })
    const r = res()
    await completeV2Onboarding(req(), r as unknown as Response, jest.fn())

    expect(stripeService.createPlanSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ trialPeriodDays: 30, cancelAtTrialEnd: true, idempotencyKey: 'onboarding-complete:org_1' }),
    )
    expect(r.status).toHaveBeenCalledWith(201)
    expect(cuerpo(r)).toMatchObject({ success: true, ...ENDS_FREE })
    expect(stripeService.suscripcionConTopeCorto).toHaveBeenCalledWith('sub_1')
  })

  it('🔴 el correo dice Básico porque la suscripción REAL termina sin cobrar', async () => {
    alta({ basicPlan: true })
    await completeV2Onboarding(req(), res() as unknown as Response, jest.fn())
    await vaciar()
    const [, datos] = (emailService.sendPlanConfirmationEmail as jest.Mock).mock.calls[0]
    expect(datos).toMatchObject({ payNow: false, trialEndsFree: true, basicPlanPriceWithoutTaxCents: 49900 })
  })

  it('si lo cobrado renueva como Pro (p. ej. se reusó una suscripción vieja), correo y respuesta dicen Pro', async () => {
    alta({ basicPlan: true })
    ;(stripeService.retrievePlanSubscription as jest.Mock).mockResolvedValue({
      currentPeriodEnd: new Date(FIN),
      status: 'trialing',
      cancelAtPeriodEnd: false,
    })
    ;(stripeService.suscripcionConTopeCorto as jest.Mock).mockResolvedValue(enPrueba(RENEWS))
    const r = res()
    await completeV2Onboarding(req(), r as unknown as Response, jest.fn())
    await vaciar()
    expect(cuerpo(r)).toMatchObject(RENEWS)
    const [, datos] = (emailService.sendPlanConfirmationEmail as jest.Mock).mock.calls[0]
    expect(datos.trialEndsFree).toBeUndefined()
    expect(datos.firstChargeAmountCents).toBe(115884)
  })

  it('🔴 la corta seguida de la larga no crea otro: el retorno anticipado responde la modalidad real', async () => {
    alta({ basicPlan: true }, { planActivationStatus: 'ACTIVE' })
    mockTerminar.mockResolvedValue({ estado: 'TERMINADA', venue: VENUE })
    const r = res()
    await completeV2Onboarding(req(), r as unknown as Response, jest.fn())
    expect(stripeService.createPlanSubscription).not.toHaveBeenCalled()
    expect(r.status).toHaveBeenCalledWith(201)
    expect(cuerpo(r)).toMatchObject(ENDS_FREE)
  })

  it('otra petición ya terminó el alta (candado perdido): la respuesta también dice la modalidad', async () => {
    alta({ basicPlan: true })
    ;(prisma.onboardingProgress.updateMany as jest.Mock).mockResolvedValueOnce({ count: 0 })
    ;(prisma.venue.findFirst as jest.Mock).mockResolvedValue(VENUE)
    const r = res()
    await completeV2Onboarding(req(), r as unknown as Response, jest.fn())
    expect(stripeService.createPlanSubscription).not.toHaveBeenCalled()
    expect(r.status).toHaveBeenCalledWith(200)
    expect(cuerpo(r)).toMatchObject(ENDS_FREE)
  })

  it('PLAN_YA_CONTRATADO: entrega la que ya cobraba sin crear y responde SU modalidad', async () => {
    alta({ basicPlan: true })
    // `AppError` real: la rama exige la clase.
    const AppError = jest.requireActual('../../../src/errors/AppError').default
    mockAutorizar.mockRejectedValue(Object.assign(new AppError('ya', 409, true, 'PLAN_YA_CONTRATADO'), { suscripciones: ['sub_vivo'] }))
    ;(prisma.onboardingProgress.findUnique as jest.Mock).mockResolvedValue({
      planActivationStatus: 'ACTIVE',
      planStripeSubscriptionId: 'sub_vivo',
    })
    ;(stripeService.suscripcionConTopeCorto as jest.Mock).mockResolvedValue(enPrueba(RENEWS))
    const r = res()
    await completeV2Onboarding(req(), r as unknown as Response, jest.fn())
    expect(stripeService.createPlanSubscription).not.toHaveBeenCalled()
    expect(stripeService.entregarSuscripcionDePlan).toHaveBeenCalledWith(expect.objectContaining({ subscriptionId: 'sub_vivo' }))
    expect(cuerpo(r)).toMatchObject(RENEWS)
    expect(stripeService.suscripcionConTopeCorto).toHaveBeenCalledWith('sub_vivo')
  })

  it('si Stripe no contesta la modalidad, el alta termina igual y el campo no viaja', async () => {
    alta({ basicPlan: true })
    ;(stripeService.suscripcionConTopeCorto as jest.Mock).mockRejectedValue(new Error('Stripe caído'))
    const r = res()
    await completeV2Onboarding(req(), r as unknown as Response, jest.fn())
    expect(r.status).toHaveBeenCalledWith(201)
    expect(cuerpo(r).trialModality).toBeUndefined()
  })

  it.each([
    ['pagando hoy', { payNow: true }],
    ['con Premium', { tier: 'PREMIUM' }],
    ['anual', { interval: 'annual' }],
  ])('🔴 basicPlan %s → 400 y no cobra', async (_caso, cambios) => {
    alta({ basicPlan: true, ...cambios })
    const next = jest.fn()
    await completeV2Onboarding(req(), res() as unknown as Response, next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400, code: 'BASIC_PLAN_INVALID' }))
    expect(stripeService.createPlanSubscription).not.toHaveBeenCalled()
  })

  it('regresión: Pro normal por la larga crea como hoy, sin cancelAtTrialEnd', async () => {
    alta({})
    ;(stripeService.suscripcionConTopeCorto as jest.Mock).mockResolvedValue(enPrueba(RENEWS))
    const r = res()
    await completeV2Onboarding(req(), r as unknown as Response, jest.fn())
    const [entrada] = (stripeService.createPlanSubscription as jest.Mock).mock.calls[0]
    expect(entrada.trialPeriodDays).toBe(30)
    expect(entrada).not.toHaveProperty('cancelAtTrialEnd')
    expect(cuerpo(r)).toMatchObject(RENEWS)
  })
})

describe('paso del plan (saveV2Step)', () => {
  it.each([
    ['pagando hoy', { tier: 'PRO', payNow: true }],
    ['con Premium', { tier: 'PREMIUM', payNow: false }],
    ['anual', { tier: 'PRO', interval: 'annual', payNow: false }],
  ])('🔴 basicPlan %s → 400 en español y no se guarda', async (_caso, plan) => {
    const next = jest.fn()
    await saveV2Step(req({ plan: { ...plan, basicPlan: true } }, { stepNumber: '10' }), res() as unknown as Response, next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400, code: 'BASIC_PLAN_INVALID' }))
    expect(next.mock.calls[0][0].message).toMatch(/Plan Básico/)
    expect(onboardingProgressService.saveV2StepData).not.toHaveBeenCalled()
  })

  it('basicPlan con la prueba de Pro mensual se guarda tal cual', async () => {
    ;(onboardingProgressService.saveV2StepData as jest.Mock).mockResolvedValue({ currentStep: 11 })
    const plan = { tier: 'PRO', interval: 'monthly', payNow: false, paymentMethodId: 'pm_1', basicPlan: true }
    const r = res()
    await saveV2Step(req({ plan }, { stepNumber: '10' }), r as unknown as Response, jest.fn())
    expect(onboardingProgressService.saveV2StepData).toHaveBeenCalledWith('org_1', 10, { plan })
    expect(r.status).toHaveBeenCalledWith(200)
  })
})

describe('esquema de activate-plan', () => {
  const base = {
    tier: 'PRO',
    interval: 'monthly',
    payNow: false,
    paymentMethodId: 'pm_1',
    offer: { kind: 'STANDARD', expectedFirstChargeCents: 0 },
  }
  const parse = (body: Record<string, unknown>) =>
    ActivatePlanSchema.safeParse({ params: { organizationId: 'cjld2cjxh0000qzrmn831i7rn' }, body })

  it('acepta basicPlan con Pro mensual sin pagar hoy, y lo conserva', () => {
    const r = parse({ ...base, basicPlan: true })
    expect(r.success).toBe(true)
    expect(r.success && r.data.body.basicPlan).toBe(true)
  })
  it('regresión: sin basicPlan sigue igual', () => expect(parse(base).success).toBe(true))
  it.each([
    ['pagando hoy', { payNow: true }],
    ['con Premium', { tier: 'PREMIUM' }],
    ['anual', { interval: 'annual' }],
  ])('🔴 basicPlan %s → rechazo con código y mensaje en español', (_caso, cambios) => {
    const r = parse({ ...base, ...cambios, basicPlan: true })
    expect(r.success).toBe(false)
    const issue = !r.success ? r.error.issues.find(i => i.code === 'custom') : undefined
    expect(issue).toMatchObject({ message: expect.stringMatching(/Plan Básico/), params: { code: 'BASIC_PLAN_INVALID' } })
  })
})

describe('GET /progress (recarga y «Volver a comprobar»)', () => {
  const progreso = {
    id: 'op_1',
    currentStep: 10,
    planActivationStatus: 'ACTIVE',
    planActivationAttempt: 1,
    planActivatedAt: new Date(),
    planStripeSubscriptionId: 'sub_1',
    launchCampaignId: null,
    v2SetupData: {},
    acquisitionSource: null,
  }

  it('🔴 respuesta perdida → recarga: trae la modalidad REAL de la suscripción', async () => {
    ;(onboardingProgressService.getOnboardingProgress as jest.Mock).mockResolvedValue(progreso)
    const r = res()
    await getOnboardingProgress(req(), r as unknown as Response, jest.fn())
    expect(r.status).toHaveBeenCalledWith(200)
    expect(cuerpo(r).progress.planActivation).toMatchObject({ status: 'ACTIVE', ...ENDS_FREE })
    expect(stripeService.suscripcionConTopeCorto).toHaveBeenCalledWith('sub_1')
  })

  it('si Stripe falla, se omite el campo y nunca es 500', async () => {
    ;(onboardingProgressService.getOnboardingProgress as jest.Mock).mockResolvedValue(progreso)
    ;(stripeService.suscripcionConTopeCorto as jest.Mock).mockRejectedValue(new Error('Stripe caído'))
    const r = res()
    const next = jest.fn()
    await getOnboardingProgress(req(), r as unknown as Response, next)
    expect(next).not.toHaveBeenCalled()
    expect(r.status).toHaveBeenCalledWith(200)
    expect(cuerpo(r).progress.planActivation).not.toHaveProperty('trialModality')
  })

  it('sin plan cobrado no consulta a Stripe', async () => {
    ;(onboardingProgressService.getOnboardingProgress as jest.Mock).mockResolvedValue({
      ...progreso,
      planActivationStatus: 'NONE',
      planStripeSubscriptionId: null,
    })
    const r = res()
    await getOnboardingProgress(req(), r as unknown as Response, jest.fn())
    expect(stripeService.suscripcionConTopeCorto).not.toHaveBeenCalled()
    expect(cuerpo(r).progress.planActivation).not.toHaveProperty('trialModality')
  })
})
