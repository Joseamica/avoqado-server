/**
 * Planes editables B2, Task 6 (§16, §18): el alta SIN tarjeta es su propio tipo de oferta (`STANDARD_SIN_TARJETA`), con el
 * mismo lease, la misma llave, la misma recuperación y la misma regla común que el alta con tarjeta. Abre su suscripción en
 * Stripe en prueba, sin método de pago, al precio de su versión, y dice qué tarjeta cobraría Stripe al terminar. Si Stripe ya
 * la canceló sin tarjeta antes de cerrar el alta, el alta se cierra en Gratis (b2-r3 #3).
 *
 * El servicio real; Stripe, la regla común (`autorizarObligacionNueva`, que corre su callback), la entrega, los correos y el
 * cierre final simulados como en `planActivation.comprobante.test.ts`. La v2 vigente: Pro SIN tarjeta, 14 días, mensual
 * $799 + IVA (92684).
 */
const mockSubCreate = jest.fn()
const mockSubRetrieve = jest.fn()
const mockSubList = jest.fn()
const mockPriceList = jest.fn()
const mockPriceRetrieve = jest.fn()
const mockPmRetrieve = jest.fn()
const mockCustomerRetrieve = jest.fn()
const mockCustomerUpdate = jest.fn()
const mockInvList = jest.fn()
const mockIpList = jest.fn()

jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    subscriptions: { create: mockSubCreate, retrieve: mockSubRetrieve, list: mockSubList },
    prices: { list: mockPriceList, retrieve: mockPriceRetrieve },
    paymentMethods: { retrieve: mockPmRetrieve },
    coupons: { create: jest.fn(), retrieve: jest.fn(), del: jest.fn() },
    customers: {
      create: jest.fn(),
      retrieve: mockCustomerRetrieve,
      update: mockCustomerUpdate,
      retrieveSource: jest.fn(),
      listBalanceTransactions: jest.fn(),
    },
    invoices: { list: mockInvList, voidInvoice: jest.fn() },
    invoicePayments: { list: mockIpList },
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
  ensureVenueForOnboarding: jest.fn().mockResolvedValue({ id: 'venue-1', slug: 'negocio-test', status: 'ONBOARDING' }),
}))
const mockDestino = jest.fn()
jest.mock('@/services/access/planNotification.service', () => ({
  __esModule: true,
  resolvePlanNotificationTarget: (...a: unknown[]) => mockDestino(...a),
}))
jest.mock('@/services/email.service', () => ({
  __esModule: true,
  default: {
    sendPlanConfirmationEmail: jest.fn().mockResolvedValue(true),
    sendPlanFreeTrialEndingEmail: jest.fn().mockResolvedValue(true),
  },
}))
jest.mock('@/services/resend.service', () => ({
  __esModule: true,
  sendPlanActivatedNotice: jest.fn().mockResolvedValue(true),
  sendOnboardingWelcomeEmail: jest.fn().mockResolvedValue(true),
}))
const mockTerminar = jest.fn()
jest.mock('@/services/onboarding/terminarAltaCobrada', () => ({
  __esModule: true,
  terminarAltaCobrada: (...a: unknown[]) => mockTerminar(...a),
  terminarAltaCobradaSinRomper: jest.fn().mockResolvedValue(undefined),
}))

import { activatePlan, hayCobroDelAltaSinCerrar, type ActivatePlanInput } from '@/services/onboarding/planActivation.service'
import { prismaMock } from '@tests/__helpers__/setup'
import { comprobanteDePrueba, definicionDePrueba, idsDeLaVersion, punteroA } from '@tests/__helpers__/planOfferFixtures'
import type { CotizacionFirmable } from '@/services/billing/comprobanteDeCotizacion'
import emailService from '@/services/email.service'
import * as resendService from '@/services/resend.service'

const DIA = 86_400_000
const ORG = 'org-1'
const PRO_M = 92684 // 79900 + IVA
const LLAVE_1 = `plan-activation:${ORG}:1`

type Planes = NonNullable<Parameters<typeof definicionDePrueba>[0]>['planes']
/** La v2: Pro sin tarjeta 14 días a $799 + IVA. */
const v2 = (planes: Planes = {}) =>
  definicionDePrueba({
    ids: idsDeLaVersion('v2'),
    netos: { 'PRO:monthly': 79900 },
    planes: { PRO: { requiresCard: false, trialDays: 14 }, ...planes },
  })
const conVigente = (definition: unknown, number = 2) =>
  prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA(`cv${number}`, number, definition) as never)

/** El comprobante de Pro mensual sin tarjeta de la v2: 14 días desde `emitido`, primer cobro $0. */
function comprobante(c: Partial<CotizacionFirmable> = {}, emitido: Date = new Date()): string {
  return comprobanteDePrueba(
    { alcance: `org:${ORG}`, precioCents: PRO_M, firstChargeCents: 0, trialEndsAt: new Date(emitido.getTime() + 14 * DIA), ...c },
    emitido,
  )
}

/** El cuerpo de la prueba sin tarjeta: sin método de pago y sin pagar hoy. */
const SIN_TARJETA = {
  organizationId: ORG,
  staffId: 'staff-1',
  tier: 'PRO' as const,
  interval: 'monthly' as const,
  payNow: false,
  offer: { kind: 'STANDARD_SIN_TARJETA', expectedFirstChargeCents: 0 },
}
const pedir = (o: Record<string, unknown> = {}) => activatePlan({ ...SIN_TARJETA, ...o } as unknown as ActivatePlanInput)

const progresos = () => (prismaMock.onboardingProgress.updateMany as jest.Mock).mock.calls.map((c: unknown[]) => c[0] as any)
function planDelCierre(): any {
  const fusiones = (prismaMock.$executeRaw as jest.Mock).mock.calls.filter(
    (c: any[]) => Array.isArray(c[0]) && c[0].join('').includes('"v2SetupData"'),
  )
  const ultima = fusiones.at(-1)
  return ultima ? JSON.parse(ultima[1]).plan : undefined
}
/** Los correos salen sin esperarse: se deja correr lo pendiente. */
const sinPendientes = async () => {
  for (let i = 0; i < 5; i++) await new Promise(res => setImmediate(res))
}

const precio = (id: string, unitAmount: number) => ({
  id,
  active: true,
  unit_amount: unitAmount,
  currency: 'mxn',
  product: 'prod_pro',
  recurring: { interval: 'month', interval_count: 1 },
  tax_behavior: 'inclusive',
})

const FIN_S = Math.floor(new Date('2026-12-09T16:00:00Z').getTime() / 1000)
/** La suscripción de la prueba sin tarjeta (lo que lee el cierre): en prueba, sin método, con la metadata del alta. */
function prueba(o: Record<string, unknown> = {}, metadata: Record<string, string> = {}) {
  return {
    id: 'sub_1',
    status: 'trialing',
    customer: 'cus_1',
    default_payment_method: null,
    default_source: null,
    cancel_at_period_end: false,
    cancel_at: null,
    current_period_end: FIN_S,
    trial_end: FIN_S,
    latest_invoice: { id: 'in_0', status: 'paid', amount_due: 0, amount_paid: 0 },
    items: { data: [{ current_period_end: FIN_S, price: precio('price_v2_pro_m', PRO_M) }] },
    metadata: {
      organizationId: ORG,
      featureCode: 'PLAN_PRO',
      planActivationKey: LLAVE_1,
      planOfferVersion: '2',
      planOfferPrecioDe: '2',
      sinTarjeta: 'true',
      ...metadata,
    },
    discounts: [],
    ...o,
  }
}

/** Un alta con un intento anterior IN_PROGRESS de la v2 (lease vencido). */
const alta = (o: Record<string, unknown> = {}) =>
  prismaMock.onboardingProgress.findUnique.mockResolvedValue({
    id: 'op-1',
    organizationId: ORG,
    completedAt: null,
    v2SetupData: {},
    launchCampaignId: null,
    termsAcceptedAt: new Date('2026-11-20T00:00:00Z'),
    planActivationStatus: 'IN_PROGRESS',
    planActivationAttempt: 1,
    planActivationLeaseUntil: new Date(Date.now() - 60_000),
    planStripeSubscriptionId: null,
    planOfferVersionNumber: 2,
    ...o,
  } as never)

const lista = (subs: unknown[]) =>
  mockSubList.mockReturnValue({
    autoPagingEach: async (cb: (s: unknown) => boolean | Promise<boolean>) => {
      for (const s of subs) if ((await cb(s)) === false) return
    },
  })

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
  mockDestino.mockReset().mockResolvedValue({ email: 'duena@example.com', locale: 'es', venueName: 'Negocio' })
  mockPriceList.mockReset().mockResolvedValue({ data: [{ id: 'price_llave_pro_m', unit_amount: 115884 }] })
  mockPriceRetrieve.mockReset().mockImplementation(async (id: string) => {
    if (id !== 'price_v2_pro_m') throw Object.assign(new Error('No such price'), { code: 'resource_missing', statusCode: 404 })
    return precio('price_v2_pro_m', PRO_M)
  })
  mockPmRetrieve.mockReset().mockImplementation(async (id: string) => {
    if (id === 'pm_premium') return { id: 'pm_premium', object: 'payment_method', type: 'card', card: { brand: 'visa', last4: '4242' } }
    throw Object.assign(new Error('No such payment_method'), { code: 'resource_missing', statusCode: 404 })
  })
  // El cliente de Stripe del negocio, vivo y sin tarjeta guardada.
  mockCustomerRetrieve
    .mockReset()
    .mockResolvedValue({ id: 'cus_1', object: 'customer', invoice_settings: { default_payment_method: null } })
  mockCustomerUpdate.mockReset().mockResolvedValue({ id: 'cus_1' })
  mockSubCreate.mockReset().mockResolvedValue({ id: 'sub_1', status: 'trialing' })
  mockSubRetrieve.mockReset().mockResolvedValue(prueba())
  mockSubList.mockReset()
  mockInvList.mockReset().mockResolvedValue({ has_more: false, data: [{ id: 'in_0', status: 'paid', total: 0, amount_paid: 0 }] })
  mockIpList.mockReset()
  mockTerminar.mockReset().mockResolvedValue({ estado: 'TERMINADA', venue: { id: 'venue-1' } })
  conVigente(v2())
  prismaMock.onboardingProgress.findUnique.mockResolvedValue({
    id: 'op-1',
    organizationId: ORG,
    completedAt: null,
    v2SetupData: {},
    launchCampaignId: null,
    termsAcceptedAt: new Date('2026-11-20T00:00:00Z'),
    planActivationStatus: 'NONE',
    planActivationAttempt: 0,
    planActivationLeaseUntil: null,
    planStripeSubscriptionId: null,
  } as never)
  prismaMock.onboardingProgress.updateMany.mockResolvedValue({ count: 1 } as never)
  prismaMock.venue.findUnique.mockResolvedValue({
    id: 'venue-1',
    name: 'Negocio',
    slug: 'negocio-test',
    email: 'negocio@example.com',
    stripeCustomerId: 'cus_1',
    organization: { email: 'org@example.com', name: 'Org' },
  } as never)
  prismaMock.venue.update.mockResolvedValue({} as never)
  prismaMock.hybridPurchase.findUnique.mockResolvedValue(null as never)
  prismaMock.launchCampaignRedemption.findFirst.mockResolvedValue(null as never)
  prismaMock.feature.findFirst.mockResolvedValue({
    id: 'feat-pro',
    code: 'PLAN_PRO',
    monthlyPrice: 999,
    stripeProductId: 'prod_pro',
  } as never)
  prismaMock.venueFeature.findUnique.mockResolvedValue(null as never)
  prismaMock.venueFeature.upsert.mockResolvedValue({} as never)
})

describe('B2 Task 6: el alta sin tarjeta abre su prueba en Stripe', () => {
  it('🔴 abre la suscripción en prueba sin método de pago: subscriptions.create sin default_payment_method, con trial_end = trialEndsAt del comprobante (cotizado 10:00, aceptado 16:00), trial_settings.end_behavior.missing_payment_method "cancel", price_v2_pro_m y metadata { planActivationKey, planOfferVersion: "2", sinTarjeta: "true" }', async () => {
    // Cotizado hace 6 h (10:00) y aceptado ahora (16:00): la prueba termina cuando dice el comprobante, no 14 días desde ahora.
    const cotizado = new Date(Date.now() - 6 * 3_600_000)
    const finDeLaPrueba = new Date(cotizado.getTime() + 14 * DIA)

    const r = await pedir({ quoteToken: comprobante({}, cotizado) })

    expect(r).toMatchObject({ status: 'ACTIVE', alreadyActive: false, firstChargeCents: 0, sinTarjeta: true, tarjetaQueCobrara: null })
    expect(mockSubCreate).toHaveBeenCalledTimes(1)
    const [cuerpo, opciones] = mockSubCreate.mock.calls[0] as [Record<string, any>, { idempotencyKey?: string }]
    expect('default_payment_method' in cuerpo).toBe(false)
    expect(cuerpo.trial_end).toBe(Math.floor(finDeLaPrueba.getTime() / 1000))
    expect('trial_period_days' in cuerpo).toBe(false)
    expect(cuerpo.trial_settings).toEqual({ end_behavior: { missing_payment_method: 'cancel' } })
    expect(cuerpo.items).toEqual([{ price: 'price_v2_pro_m' }])
    expect(cuerpo.metadata).toMatchObject({ planActivationKey: LLAVE_1, planOfferVersion: '2', sinTarjeta: 'true' })
    expect(opciones.idempotencyKey).toBe(LLAVE_1)
    // Sin tarjeta no hay método que comprobar.
    expect(mockPmRetrieve).not.toHaveBeenCalled()
  })

  it('escribe planOfferVersionNumber en el CAS del lease antes del create y cierra ACTIVE con plan raíz { sinTarjeta: true, paymentMethodId: null, offerVersion: 2, offer: { kind: "STANDARD", expectedFirstChargeCents: 0 } }', async () => {
    await pedir({ quoteToken: comprobante() })

    const cas = progresos()[0]
    expect(cas.where).toMatchObject({ organizationId: ORG, completedAt: null, planActivationStatus: 'NONE', planActivationAttempt: 0 })
    expect(cas.data).toMatchObject({ planActivationStatus: 'IN_PROGRESS', planActivationAttempt: 1, planOfferVersionNumber: 2 })
    expect((prismaMock.onboardingProgress.updateMany as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      mockSubCreate.mock.invocationCallOrder[0],
    )
    expect(progresos().at(-1)).toMatchObject({
      data: { planActivationStatus: 'ACTIVE', planActivationLeaseUntil: null, planStripeSubscriptionId: 'sub_1' },
    })
    expect(planDelCierre()).toEqual({
      tier: 'PRO',
      paymentMethodId: null,
      interval: 'monthly',
      payNow: false,
      acceptedAt: expect.any(String),
      sinTarjeta: true,
      offer: { kind: 'STANDARD', expectedFirstChargeCents: 0 },
      offerVersion: 2,
    })
  })

  it('🔴 §18 + b2-r8: la bienvenida dice el precio de la versión (926.84) con la nota del saldo y, con tarjeta guardada, su ••••last4; sin tarjeta, «pon tu tarjeta…»; nunca sendPlanConfirmationEmail', async () => {
    // El cliente ya guardó una tarjeta (para Premium): Stripe la cobrará al terminar. Se dice, no se impide.
    mockCustomerRetrieve.mockResolvedValue({ id: 'cus_1', object: 'customer', invoice_settings: { default_payment_method: 'pm_premium' } })

    const conTarjeta = await pedir({ quoteToken: comprobante() })
    await sinPendientes()

    expect(conTarjeta).toMatchObject({ sinTarjeta: true, tarjetaQueCobrara: { brand: 'visa', last4: '4242' }, noHabraCobro: false })
    const bienvenida = emailService.sendPlanFreeTrialEndingEmail as jest.Mock
    expect(bienvenida).toHaveBeenCalledTimes(1)
    const [para, datos] = bienvenida.mock.calls[0] as [string, Record<string, unknown>]
    expect(para).toBe('duena@example.com')
    expect(datos).toMatchObject({
      empezo: true,
      planName: 'Pro',
      montoAlTerminarCents: PRO_M,
      tarjeta: { brand: 'visa', last4: '4242' },
      endDate: new Date(FIN_S * 1000),
      idempotencyKey: 'plan-trial-no-card-start:sub_1',
    })
    expect(emailService.sendPlanConfirmationEmail).not.toHaveBeenCalled()
    // El aviso al equipo dice que es una prueba sin tarjeta.
    expect(resendService.sendPlanActivatedNotice).toHaveBeenCalledWith(expect.objectContaining({ sinTarjeta: true, payNow: false }))

    // Sin tarjeta guardada: la bienvenida pide la tarjeta («tarjeta: null»).
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (cb: unknown) => (cb as (tx: unknown) => unknown)(prismaMock))
    mockCustomerRetrieve.mockResolvedValue({ id: 'cus_1', object: 'customer', invoice_settings: { default_payment_method: null } })
    const sinTarjeta = await pedir({ quoteToken: comprobante() })
    await sinPendientes()

    expect(sinTarjeta).toMatchObject({ sinTarjeta: true, tarjetaQueCobrara: null })
    expect((emailService.sendPlanFreeTrialEndingEmail as jest.Mock).mock.calls[0][1]).toMatchObject({
      empezo: true,
      montoAlTerminarCents: PRO_M,
      tarjeta: null,
    })
    expect(emailService.sendPlanConfirmationEmail).not.toHaveBeenCalled()
  })

  it('un plan que en la vigente pide tarjeta → 409 OFFER_CHANGED reason CON_TARJETA', async () => {
    conVigente(v2({ PRO: { requiresCard: true, trialDays: 30 } }))
    const emitido = new Date()

    await expect(
      pedir({ quoteToken: comprobante({ trialEndsAt: new Date(emitido.getTime() + 30 * DIA) }, emitido) }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'OFFER_CHANGED',
      details: { reason: 'CON_TARJETA', offerVersion: 2 },
    })
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(prismaMock.onboardingProgress.updateMany).not.toHaveBeenCalled()
  })

  it('sin versión del editor (o sin comprobante) nunca abre una prueba sin tarjeta: 409 OFFER_CHANGED, cero create', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(null)
    await expect(pedir({ quoteToken: comprobante() })).rejects.toMatchObject({
      statusCode: 409,
      code: 'OFFER_CHANGED',
      details: { reason: 'VERSION', offerVersion: 1 },
    })
    conVigente(v2())
    await expect(pedir()).rejects.toMatchObject({ statusCode: 409, code: 'OFFER_CHANGED', details: { reason: 'QUOTE_REQUIRED' } })
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(mockPriceList).not.toHaveBeenCalled()
  })

  it('🔴 b2-r2 #2 y #3: un intento con tarjeta IN_PROGRESS vencido se descarta y la prueba abre como intento nuevo; con completedAt puesto por «Terminar», el CAS no la toma (409) y ningún create', async () => {
    // El intento 1 (con tarjeta) nunca llegó a Stripe: ni id ni suscripción con su llave.
    alta()
    lista([{ id: 'sub_ajena', status: 'active', metadata: { planActivationKey: 'otra' } }])

    const r = await pedir({ quoteToken: comprobante() })

    expect(r).toMatchObject({ status: 'ACTIVE', sinTarjeta: true })
    expect(mockSubCreate).toHaveBeenCalledTimes(1)
    expect((mockSubCreate.mock.calls[0] as [unknown, { idempotencyKey: string }])[1].idempotencyKey).toBe(`plan-activation:${ORG}:2`)
    // El avance al intento 2 escribe la versión de su comprobante, antes del create.
    expect(progresos()).toContainEqual(
      expect.objectContaining({
        data: { planActivationAttempt: 2, planStripeSubscriptionId: null, planOfferVersionNumber: 2 },
      }),
    )
    expect(mockPmRetrieve).not.toHaveBeenCalled()

    // «Terminar» puso completedAt entre la lectura y el CAS del lease: el CAS no la toma.
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (cb: unknown) => (cb as (tx: unknown) => unknown)(prismaMock))
    prismaMock.onboardingProgress.findUnique.mockResolvedValue({
      id: 'op-1',
      organizationId: ORG,
      completedAt: null,
      v2SetupData: {},
      launchCampaignId: null,
      termsAcceptedAt: new Date('2026-11-20T00:00:00Z'),
      planActivationStatus: 'NONE',
      planActivationAttempt: 0,
      planActivationLeaseUntil: null,
      planStripeSubscriptionId: null,
    } as never)
    prismaMock.onboardingProgress.updateMany.mockResolvedValue({ count: 0 } as never)

    await expect(pedir({ quoteToken: comprobante() })).rejects.toMatchObject({ statusCode: 409, code: 'PLAN_ACTIVATION_IN_PROGRESS' })
    expect(progresos()[0].where).toMatchObject({ completedAt: null })
    expect(mockSubCreate).not.toHaveBeenCalled()
  })

  it('🔴 respuesta perdida del create sin tarjeta: el reintento recupera la suscripción por la llave y cierra sin crear otra', async () => {
    alta()
    lista([prueba()])

    const r = await pedir({ quoteToken: comprobante() })
    await sinPendientes()

    expect(r).toMatchObject({ status: 'ACTIVE', sinTarjeta: true, tarjetaQueCobrara: null })
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(planDelCierre()).toMatchObject({ tier: 'PRO', payNow: false, paymentMethodId: null, sinTarjeta: true, offerVersion: 2 })
    expect(progresos().at(-1)).toMatchObject({ data: { planActivationStatus: 'ACTIVE', planStripeSubscriptionId: 'sub_1' } })
    // La bienvenida sin tarjeta (con su llave, así un reintento no la repite) y nunca la confirmación de pago.
    expect((emailService.sendPlanFreeTrialEndingEmail as jest.Mock).mock.calls[0][1]).toMatchObject({
      empezo: true,
      idempotencyKey: 'plan-trial-no-card-start:sub_1',
    })
    expect(emailService.sendPlanConfirmationEmail).not.toHaveBeenCalled()
  })

  it('🔴 b2-r3 #3: la suscripción del intento canceled con ended_at = trial_end, sinTarjeta y sin facturas pagadas → 409 PLAN_TRIAL_ENDED y el alta terminada en Gratis; una cancelada antes de su trial_end, o con una factura pagada en cualquier página, → el 503 de hoy', async () => {
    alta({ planStripeSubscriptionId: 'sub_1' })
    mockSubRetrieve.mockResolvedValue(prueba({ status: 'canceled', ended_at: FIN_S }))

    await expect(pedir({ quoteToken: comprobante() })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAN_TRIAL_ENDED',
      message: 'Tu prueba terminó sin tarjeta y tu negocio quedó en Gratis. No se te cobró nada.',
    })
    expect(mockInvList).toHaveBeenCalledWith({ subscription: 'sub_1', status: 'paid', limit: 100 })
    expect(progresos()).toContainEqual(
      expect.objectContaining({
        where: expect.objectContaining({ planActivationStatus: 'IN_PROGRESS', planActivationAttempt: 1 }),
        data: { planActivationStatus: 'ACTIVE', planActivationLeaseUntil: null, planStripeSubscriptionId: null },
      }),
    )
    expect(planDelCierre()).toMatchObject({ tier: 'FREE', pruebaSinTarjetaTerminada: true, subscriptionId: 'sub_1', offerVersion: 2 })
    expect(mockTerminar).toHaveBeenCalledWith(ORG, expect.objectContaining({ via: 'navegador' }))
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(mockEntregar).not.toHaveBeenCalled()

    // Cancelada ANTES de su trial_end (alguien la canceló): no es «terminó sin tarjeta» → el 503 de hoy.
    const caso503 = async () => {
      await expect(pedir({ quoteToken: comprobante() })).rejects.toMatchObject({ statusCode: 503, code: 'PLAN_ACTIVATION_PENDING' })
      expect(mockTerminar).not.toHaveBeenCalled()
      expect(mockSubCreate).not.toHaveBeenCalled()
    }
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (cb: unknown) => (cb as (tx: unknown) => unknown)(prismaMock))
    mockSubRetrieve.mockResolvedValue(prueba({ status: 'canceled', ended_at: FIN_S - 3_600 }))
    await caso503()

    // Con una factura pagada mayor que $0 (o con más páginas, que no se vieron): tampoco.
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (cb: unknown) => (cb as (tx: unknown) => unknown)(prismaMock))
    mockSubRetrieve.mockResolvedValue(prueba({ status: 'canceled', ended_at: FIN_S }))
    mockInvList.mockResolvedValue({ has_more: false, data: [{ id: 'in_9', status: 'paid', total: PRO_M, amount_paid: PRO_M }] })
    await caso503()
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (cb: unknown) => (cb as (tx: unknown) => unknown)(prismaMock))
    mockInvList.mockResolvedValue({ has_more: true, data: [{ id: 'in_0', status: 'paid', total: 0, amount_paid: 0 }] })
    await caso503()
  })

  it('el reintento después del 200 perdido (alreadyActive) dice la tarjeta y si habrá cobro, leídos de Stripe en ese momento', async () => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue({
      id: 'op-1',
      organizationId: ORG,
      completedAt: null,
      v2SetupData: { plan: { tier: 'PRO', interval: 'monthly', payNow: false, paymentMethodId: null, sinTarjeta: true } },
      launchCampaignId: null,
      termsAcceptedAt: new Date('2026-11-20T00:00:00Z'),
      planActivationStatus: 'ACTIVE',
      planActivationAttempt: 1,
      planActivationLeaseUntil: null,
      planStripeSubscriptionId: 'sub_1',
    } as never)
    mockCustomerRetrieve.mockResolvedValue({ id: 'cus_1', object: 'customer', invoice_settings: { default_payment_method: 'pm_premium' } })
    mockSubRetrieve.mockResolvedValue(prueba({ cancel_at_period_end: true }))

    const r = await pedir({ quoteToken: comprobante() })

    expect(r).toMatchObject({
      alreadyActive: true,
      sinTarjeta: true,
      trialModality: 'ENDS_FREE',
      tarjetaQueCobrara: { brand: 'visa', last4: '4242' },
      noHabraCobro: true,
    })
    expect(mockSubCreate).not.toHaveBeenCalled()
  })
})

describe('B2 Task 6: hayCobroDelAltaSinCerrar no cuenta la prueba sin tarjeta que ya terminó', () => {
  const base = { organizationId: ORG, planActivationStatus: 'IN_PROGRESS', planActivationAttempt: 1, planStripeSubscriptionId: null }
  const terminada = () => prueba({ status: 'canceled', ended_at: FIN_S })

  beforeEach(() => {
    prismaMock.venue.findMany.mockResolvedValue([{ id: 'venue-1', stripeCustomerId: 'cus_1' }] as never)
    prismaMock.venueFeature.findMany.mockResolvedValue([])
    prismaMock.billingObligationConflict.findMany.mockResolvedValue([])
    prismaMock.feature.findMany.mockResolvedValue([] as never)
  })

  it('con su id y una versión del editor: la prueba terminada no cuenta; sin versión, el id basta como hoy (sin leer Stripe)', async () => {
    mockSubRetrieve.mockResolvedValue(terminada())
    lista([terminada()])

    expect(await hayCobroDelAltaSinCerrar({ ...base, planStripeSubscriptionId: 'sub_1', planOfferVersionNumber: 2 })).toBe(false)
    expect(mockSubRetrieve).toHaveBeenCalledWith('sub_1')

    mockSubRetrieve.mockClear()
    expect(await hayCobroDelAltaSinCerrar({ ...base, planStripeSubscriptionId: 'sub_1', planOfferVersionNumber: null })).toBe(true)
    expect(await hayCobroDelAltaSinCerrar({ ...base, planStripeSubscriptionId: 'sub_1' })).toBe(true)
    expect(mockSubRetrieve).not.toHaveBeenCalled()
  })

  it('sin id, encontrada por la llave: la terminada no cuenta; en prueba, o si Stripe no deja revisar, sí', async () => {
    lista([terminada()])
    expect(await hayCobroDelAltaSinCerrar(base)).toBe(false)

    lista([prueba()])
    expect(await hayCobroDelAltaSinCerrar(base)).toBe(true)

    lista([terminada()])
    mockInvList.mockRejectedValueOnce(new Error('Stripe caído'))
    expect(await hayCobroDelAltaSinCerrar(base)).toBe(true)
  })
})
