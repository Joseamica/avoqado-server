/**
 * Planes editables B2, Task 4: con una versión publicada por el editor, un intento NUEVO de `activate-plan` se cobra con su
 * comprobante firmado: el `priceId` de su versión, `trial_end` = el fin de prueba que firmó y `payNow`. La versión se relee de
 * la base justo antes de cobrar, los descuentos van explícitos y los correos dicen el precio de la suscripción. Sin versión del
 * editor, todo como hoy.
 *
 * El servicio real; Stripe, la regla común (`autorizarObligacionNueva`, que corre su callback) y la entrega simulados como en
 * `planActivation.service.test.ts`. Por default, la v2 vigente trae Pro mensual a 79900 + IVA (92684), con tarjeta y 30 días.
 */
const mockSubCreate = jest.fn()
const mockSubRetrieve = jest.fn()
const mockSubList = jest.fn()
const mockPriceList = jest.fn()
const mockPriceRetrieve = jest.fn()
const mockPmRetrieve = jest.fn()
const mockInvList = jest.fn()
const mockIpList = jest.fn()
const mockCnList = jest.fn()
const mockBalTx = jest.fn()

jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    subscriptions: { create: mockSubCreate, retrieve: mockSubRetrieve, list: mockSubList },
    prices: { list: mockPriceList, retrieve: mockPriceRetrieve },
    paymentMethods: { retrieve: mockPmRetrieve },
    coupons: { create: jest.fn(), retrieve: jest.fn(), del: jest.fn() },
    customers: { create: jest.fn(), retrieve: jest.fn(), listBalanceTransactions: mockBalTx },
    invoices: { list: mockInvList, voidInvoice: jest.fn() },
    invoicePayments: { list: mockIpList },
    creditNotes: { list: mockCnList },
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

import { activatePlan, cerrarAltaSinNavegador, type ActivatePlanInput } from '@/services/onboarding/planActivation.service'
import { prismaMock } from '@tests/__helpers__/setup'
import { comprobanteDePrueba, definicionDePrueba, idsDeLaVersion, punteroA } from '@tests/__helpers__/planOfferFixtures'
import type { CotizacionFirmable } from '@/services/billing/comprobanteDeCotizacion'
import emailService from '@/services/email.service'
import * as resendService from '@/services/resend.service'

const DIA = 86_400_000
const ORG = 'org-1'
const ALCANCE = `org:${ORG}`
const PRO_M = 92684 // 79900 + IVA
const PREMIUM_M = 197084 // 169900 + IVA

type Planes = NonNullable<Parameters<typeof definicionDePrueba>[0]>['planes']
const v2 = (planes: Planes = {}) => definicionDePrueba({ ids: idsDeLaVersion('v2'), netos: { 'PRO:monthly': 79900 }, planes })
const conVigente = (definition: unknown, number = 2) =>
  prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA(`cv${number}`, number, definition) as never)

/** Un comprobante de Pro mensual de la v2, 30 días, emitido en `emitido` (default: ahora). */
function comprobante(c: Partial<CotizacionFirmable> = {}, emitido: Date = new Date()): string {
  return comprobanteDePrueba(
    { alcance: ALCANCE, precioCents: PRO_M, firstChargeCents: 0, trialEndsAt: new Date(emitido.getTime() + 30 * DIA), ...c },
    emitido,
  )
}

/** Un comprobante de Pro mensual de 0 días (paga hoy). */
const comprobanteDeHoy = (c: Partial<CotizacionFirmable> = {}) => comprobante({ firstChargeCents: PRO_M, trialEndsAt: null, ...c })

const BASE = {
  organizationId: ORG,
  staffId: 'staff-1',
  tier: 'PRO' as const,
  interval: 'monthly' as const,
  payNow: false,
  paymentMethodId: 'pm_1',
}
const pedir = (o: Partial<ActivatePlanInput> = {}) =>
  activatePlan({ ...BASE, offer: { kind: 'STANDARD', expectedFirstChargeCents: 0 }, ...o } as ActivatePlanInput)

const progresos = () => (prismaMock.onboardingProgress.updateMany as jest.Mock).mock.calls.map((c: unknown[]) => c[0] as any)

function planDelCierre(): any {
  const fusiones = (prismaMock.$executeRaw as jest.Mock).mock.calls.filter(
    (c: any[]) => Array.isArray(c[0]) && c[0].join('').includes('"v2SetupData"'),
  )
  const ultima = fusiones.at(-1)
  return ultima ? JSON.parse(ultima[1]).plan : undefined
}

/** Lo mismo sin las horas (cada pasada estrena su lease y su `acceptedAt`). */
const sinFechas = (x: unknown) => JSON.parse(JSON.stringify(x).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, 'fecha'))

const precio = (id: string, unitAmount: number, interval: 'month' | 'year' = 'month') => ({
  id,
  active: true,
  unit_amount: unitAmount,
  currency: 'mxn',
  product: 'prod_pro',
  recurring: { interval, interval_count: 1 },
  tax_behavior: 'inclusive',
})
const PRECIOS: Record<string, ReturnType<typeof precio>> = {
  price_v2_pro_m: precio('price_v2_pro_m', PRO_M),
  price_v2_premium_m: precio('price_v2_premium_m', PREMIUM_M),
}

const errorDeAutenticacion = () =>
  Object.assign(new Error('Payment for this subscription requires additional user action…'), {
    type: 'StripeCardError',
    code: 'subscription_payment_intent_requires_action',
    statusCode: 402,
  })

/** La suscripción que lee el cierre (PASO 9): en prueba, con el precio de la v2. */
function suscripcion(o: Record<string, unknown> = {}) {
  return {
    id: 'sub_1',
    status: 'trialing',
    current_period_end: Math.floor(new Date('2026-12-25T00:00:00Z').getTime() / 1000),
    trial_end: Math.floor(new Date('2026-12-25T00:00:00Z').getTime() / 1000),
    latest_invoice: { amount_due: 0, amount_paid: 0 },
    items: { data: [{ price: precio('price_v2_pro_m', PRO_M) }] },
    discounts: [],
    ...o,
  }
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
  mockDestino.mockReset().mockResolvedValue({ email: null, locale: 'es', venueName: 'Negocio' })
  mockPriceList.mockReset().mockResolvedValue({ data: [{ id: 'price_llave_pro_m', unit_amount: 115884 }] })
  mockPriceRetrieve.mockReset().mockImplementation(async (id: string) => {
    if (!PRECIOS[id]) throw Object.assign(new Error('No such price'), { code: 'resource_missing', statusCode: 404 })
    return PRECIOS[id]
  })
  mockPmRetrieve.mockReset().mockResolvedValue({ id: 'pm_1', customer: 'cus_1', card: { fingerprint: 'fp_1' } })
  mockSubCreate.mockReset().mockResolvedValue({ id: 'sub_1', status: 'trialing' })
  mockSubRetrieve.mockReset().mockResolvedValue(suscripcion())
  mockSubList.mockReset()
  mockInvList.mockReset()
  mockIpList.mockReset()
  mockBalTx.mockReset().mockResolvedValue({ has_more: false, data: [] })
  mockCnList.mockReset().mockResolvedValue({ has_more: false, data: [] })
  prismaMock.planOfferPointer.findUnique.mockReset().mockResolvedValue(null)
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

describe('B2 Task 4: activate-plan cobra un intento nuevo con su comprobante', () => {
  it('🔴 sin versión del editor el comprobante no se lee: mismas llamadas a Stripe y subscriptions.create con trial_period_days 30, como B0', async () => {
    // Sin comprobante: la foto de hoy.
    await pedir()
    const deHoy = {
      creates: mockSubCreate.mock.calls.map((c: unknown[]) => c),
      listas: mockPriceList.mock.calls.map((c: unknown[]) => c),
      progresos: progresos(),
      plan: planDelCierre(),
    }
    const cuerpoDeHoy = deHoy.creates[0][0] as { trial_period_days?: number; metadata: Record<string, string> }
    expect(cuerpoDeHoy.trial_period_days).toBe(30)
    expect('trial_end' in cuerpoDeHoy).toBe(false)
    expect('discounts' in cuerpoDeHoy).toBe(false)
    expect(cuerpoDeHoy.metadata.planOfferVersion).toBeUndefined()

    // Con un comprobante (válido, uno largo, null o un número): exactamente lo mismo, sin leerlo.
    for (const quoteToken of [comprobante(), 'x'.repeat(3000), null, 7]) {
      jest.clearAllMocks()
      prismaMock.$transaction.mockImplementation(async (cb: unknown) => (cb as (tx: unknown) => unknown)(prismaMock))
      mockSubCreate.mockReset().mockResolvedValue({ id: 'sub_1', status: 'trialing' })
      mockPriceList.mockReset().mockResolvedValue({ data: [{ id: 'price_llave_pro_m', unit_amount: 115884 }] })

      await pedir({ quoteToken })

      expect(mockSubCreate.mock.calls).toEqual(deHoy.creates)
      expect(mockPriceList.mock.calls).toEqual(deHoy.listas)
      expect(mockPriceRetrieve).not.toHaveBeenCalled()
      // Ninguna columna nueva: las escrituras del intento son las de hoy (salvo la hora).
      expect(sinFechas(progresos())).toEqual(sinFechas(deHoy.progresos))
      expect(progresos().some((p: any) => 'planOfferVersionNumber' in (p.data ?? {}))).toBe(false)
      expect(sinFechas(planDelCierre())).toEqual(sinFechas(deHoy.plan))
      expect(planDelCierre()).not.toHaveProperty('offerVersion')
    }
  })

  it('🔴 con la v2 y sin comprobante → 409 OFFER_CHANGED reason QUOTE_REQUIRED; ni prices.retrieve ni subscriptions.create', async () => {
    conVigente(v2())

    await expect(pedir()).rejects.toMatchObject({
      statusCode: 409,
      code: 'OFFER_CHANGED',
      message: 'La oferta cambió. Revisa el precio antes de pagar. No se te cobró nada.',
      details: { reason: 'QUOTE_REQUIRED', offerVersion: 2 },
    })
    expect(mockPriceRetrieve).not.toHaveBeenCalled()
    expect(mockPriceList).not.toHaveBeenCalled()
    expect(mockSubCreate).not.toHaveBeenCalled()
    // Antes del lease: nada se apartó.
    expect(prismaMock.onboardingProgress.updateMany).not.toHaveBeenCalled()
    expect(mockAutorizar).not.toHaveBeenCalled()
  })

  it('🔴 comprobante de la v1 con la v2 vigente → 409 OFFER_CHANGED reason VERSION', async () => {
    conVigente(v2())

    await expect(pedir({ quoteToken: comprobante({ versionNumber: 1 }) })).rejects.toMatchObject({
      statusCode: 409,
      code: 'OFFER_CHANGED',
      details: { reason: 'VERSION', offerVersion: 2 },
    })
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(prismaMock.onboardingProgress.updateMany).not.toHaveBeenCalled()
  })

  it('comprobante de org:otra → 400 QUOTE_INVALID; emitido hace 24 h → 409 QUOTE_EXPIRED', async () => {
    conVigente(v2())

    await expect(pedir({ quoteToken: comprobante({ alcance: 'org:otra' }) })).rejects.toMatchObject({
      statusCode: 400,
      code: 'QUOTE_INVALID',
    })
    const hace24h = new Date(Date.now() - DIA - 1_000)
    await expect(pedir({ quoteToken: comprobante({}, hace24h) })).rejects.toMatchObject({ statusCode: 409, code: 'QUOTE_EXPIRED' })
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(mockPriceRetrieve).not.toHaveBeenCalled()
  })

  it('comprobante de Premium con tier PRO, o expectedFirstChargeCents distinto → 409 OFFER_CHANGED reason QUOTE_MISMATCH', async () => {
    conVigente(v2())
    const desajuste = { statusCode: 409, code: 'OFFER_CHANGED', details: { reason: 'QUOTE_MISMATCH', offerVersion: 2 } }

    await expect(pedir({ quoteToken: comprobante({ tier: 'PREMIUM', precioCents: PREMIUM_M }) })).rejects.toMatchObject(desajuste)
    await expect(pedir({ offer: { kind: 'STANDARD', expectedFirstChargeCents: PRO_M }, quoteToken: comprobante() })).rejects.toMatchObject(
      desajuste,
    )
    // Otro bruto que el de la vigente, u otro fin de prueba que el de sus días: tampoco.
    await expect(pedir({ quoteToken: comprobante({ precioCents: 115884 }) })).rejects.toMatchObject(desajuste)
    const emitido = new Date()
    await expect(
      pedir({ quoteToken: comprobante({ trialEndsAt: new Date(emitido.getTime() + 14 * DIA) }, emitido) }),
    ).rejects.toMatchObject(desajuste)
    expect(mockSubCreate).not.toHaveBeenCalled()
  })

  it('🔴 cobra con price_v2_pro_m y trial_end = trialEndsAt del comprobante (cotizado hace 20 h), sin trial_period_days', async () => {
    conVigente(v2())
    const emitido = new Date(Date.now() - 20 * 3_600_000)
    const finDeLaPrueba = new Date(emitido.getTime() + 30 * DIA)

    const r = await pedir({ quoteToken: comprobante({}, emitido) })

    expect(r.status).toBe('ACTIVE')
    expect(mockSubCreate).toHaveBeenCalledTimes(1)
    const [cuerpo] = mockSubCreate.mock.calls[0]
    expect(cuerpo.items).toEqual([{ price: 'price_v2_pro_m' }])
    expect(cuerpo.trial_end).toBe(Math.floor(finDeLaPrueba.getTime() / 1000))
    expect('trial_period_days' in cuerpo).toBe(false)
    expect(cuerpo.payment_behavior).toBeUndefined()
    expect(cuerpo.discounts).toBe('')
    // El precio se leyó por su id una vez (PASO 4); la llave, nunca.
    expect(mockPriceRetrieve.mock.calls.map((c: unknown[]) => c[0])).toEqual(['price_v2_pro_m'])
    expect(mockPriceList).not.toHaveBeenCalled()
  })

  it('con 0 días en la versión: payNow true, sin trial_end, payment_behavior error_if_incomplete y autenticación con primerCobroEsperadoCents 92684', async () => {
    conVigente(v2({ PRO: { trialDays: 0 } }))
    mockSubCreate
      .mockReset()
      .mockRejectedValueOnce(errorDeAutenticacion())
      .mockResolvedValueOnce({
        id: 'sub_3ds',
        status: 'incomplete',
        latest_invoice: { id: 'in_1', status: 'open', confirmation_secret: { type: 'payment_intent', client_secret: 'pi_1_secret_x' } },
      })

    await expect(
      pedir({ payNow: true, offer: { kind: 'STANDARD', expectedFirstChargeCents: PRO_M }, quoteToken: comprobanteDeHoy() }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'PLAN_PAYMENT_REQUIRES_ACTION' })

    expect(mockSubCreate).toHaveBeenCalledTimes(2)
    const [primero] = mockSubCreate.mock.calls[0]
    const [segundo] = mockSubCreate.mock.calls[1]
    expect(primero.trial_period_days).toBe(0)
    expect('trial_end' in primero).toBe(false)
    expect(primero.payment_behavior).toBe('error_if_incomplete')
    expect(primero.items).toEqual([{ price: 'price_v2_pro_m' }])
    expect(segundo.payment_behavior).toBe('default_incomplete')
    expect(segundo.metadata.primerCobroEsperadoCents).toBe(String(PRO_M))
  })

  it('payNow que no coincide con el comprobante → 409 OFFER_CHANGED reason PAGO_HOY', async () => {
    conVigente(v2())
    const pagoHoy = { statusCode: 409, code: 'OFFER_CHANGED', details: { reason: 'PAGO_HOY', offerVersion: 2 } }

    // El comprobante es de 30 días (hoy $0) y la petición dice «pagar hoy».
    await expect(pedir({ payNow: true, quoteToken: comprobante() })).rejects.toMatchObject(pagoHoy)

    // Y al revés: 0 días (paga hoy) con payNow false.
    conVigente(v2({ PRO: { trialDays: 0 } }))
    await expect(
      pedir({ payNow: false, offer: { kind: 'STANDARD', expectedFirstChargeCents: PRO_M }, quoteToken: comprobanteDeHoy() }),
    ).rejects.toMatchObject(pagoHoy)
    expect(mockSubCreate).not.toHaveBeenCalled()
  })

  it('🔴 con versión nunca va INTRO_PRO_3M: Pro mensual pagando hoy sale con discounts "" (explícito, b2-r9 #1), nunca con el cupón de la introducción', async () => {
    conVigente(v2({ PRO: { trialDays: 0 } }))
    mockSubCreate.mockReset().mockResolvedValue({ id: 'sub_1', status: 'active' })
    mockSubRetrieve.mockResolvedValue(suscripcion({ status: 'active', trial_end: null, latest_invoice: { amount_paid: PRO_M } }))

    const r = await pedir({ payNow: true, offer: { kind: 'STANDARD', expectedFirstChargeCents: PRO_M }, quoteToken: comprobanteDeHoy() })

    expect(r).toMatchObject({ status: 'ACTIVE', firstChargeCents: PRO_M })
    expect(mockSubCreate).toHaveBeenCalledTimes(1)
    expect(mockSubCreate.mock.calls[0][0].discounts).toBe('')
    expect(JSON.stringify(mockSubCreate.mock.calls)).not.toContain('INTRO_PRO_3M')
  })

  it('Pro fuera de venta en la vigente → 409 PLAN_NOT_ON_SALE; basicPlan true → 409 PLAN_NOT_ON_SALE', async () => {
    conVigente(v2({ PRO: { onSale: false } }))
    await expect(pedir({ quoteToken: comprobante() })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAN_NOT_ON_SALE',
      message: 'El plan Pro ya no está a la venta. Elige otro plan. No se te cobró nada.',
      details: { tier: 'PRO' },
    })

    conVigente(v2())
    await expect(pedir({ basicPlan: true, quoteToken: comprobante() })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PLAN_NOT_ON_SALE',
      details: { tier: 'BASICO' },
    })
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(prismaMock.onboardingProgress.updateMany).not.toHaveBeenCalled()
  })

  it('Pro que en la vigente no pide tarjeta y llega con tarjeta → 409 OFFER_CHANGED reason SIN_TARJETA', async () => {
    conVigente(v2({ PRO: { requiresCard: false, trialDays: 14 } }))
    const emitido = new Date()

    await expect(
      pedir({ quoteToken: comprobante({ trialEndsAt: new Date(emitido.getTime() + 14 * DIA) }, emitido) }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'OFFER_CHANGED', details: { reason: 'SIN_TARJETA', offerVersion: 2 } })
    expect(mockSubCreate).not.toHaveBeenCalled()
  })

  it('🔴 la v3 publicada entre el PASO 4 y la última relectura, con el MISMO priceId (sólo cambió días) → 409 OFFER_CHANGED reason VERSION, cero subscriptions.create y el lease suelto', async () => {
    // PASO 3/4 con la v2; la relectura (dentro de la regla común) ya ve la v3: mismos precios, otra prueba.
    prismaMock.planOfferPointer.findUnique
      .mockResolvedValueOnce(punteroA('cv2', 2, v2()) as never)
      .mockResolvedValue(punteroA('cv3', 3, v2({ PRO: { trialDays: 14 } })) as never)

    await expect(pedir({ quoteToken: comprobante() })).rejects.toMatchObject({
      statusCode: 409,
      code: 'OFFER_CHANGED',
      details: { reason: 'VERSION', offerVersion: 3 },
    })
    expect(mockAutorizar).toHaveBeenCalledTimes(1)
    expect(mockSubCreate).not.toHaveBeenCalled()
    // El lease vuelve a como estaba: nada quedó «confirmando tu pago».
    expect(prismaMock.onboardingProgress.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { planActivationStatus: 'NONE', planActivationLeaseUntil: null } }),
    )
  })
  // b2-r1 #3: una publicación DESPUÉS de la última relectura es residuo aceptado; ninguna prueba reclama un 409 ahí.

  it('el CAS del lease escribe planOfferVersionNumber 2 antes del create; la metadata lleva planOfferVersion "2" y planOfferPrecioDe "2"', async () => {
    conVigente(v2())

    await pedir({ quoteToken: comprobante() })

    const cas = progresos()[0]
    expect(cas.where).toMatchObject({ organizationId: ORG, planActivationStatus: 'NONE', planActivationAttempt: 0 })
    expect(cas.data).toMatchObject({ planActivationStatus: 'IN_PROGRESS', planActivationAttempt: 1, planOfferVersionNumber: 2 })
    expect((prismaMock.onboardingProgress.updateMany as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      mockSubCreate.mock.invocationCallOrder[0],
    )
    expect(mockSubCreate.mock.calls[0][0].metadata).toMatchObject({ planOfferVersion: '2', planOfferPrecioDe: '2' })
  })

  it('desde DECLINED el CAS también escribe planOfferVersionNumber (y nace sin el id del intento anterior)', async () => {
    conVigente(v2())
    prismaMock.onboardingProgress.findUnique.mockResolvedValue({
      id: 'op-1',
      organizationId: ORG,
      completedAt: null,
      v2SetupData: {},
      launchCampaignId: null,
      termsAcceptedAt: new Date('2026-11-20T00:00:00Z'),
      planActivationStatus: 'DECLINED',
      planActivationAttempt: 3,
      planActivationLeaseUntil: null,
      planStripeSubscriptionId: 'sub_viejo',
    } as never)

    await pedir({ quoteToken: comprobante() })

    expect(progresos()[0].data).toMatchObject({ planActivationAttempt: 4, planOfferVersionNumber: 2, planStripeSubscriptionId: null })
  })

  it('el cierre guarda plan.offerVersion 2 y offer sin quoteToken', async () => {
    conVigente(v2())
    const quoteToken = comprobante()

    // Aunque el llamador dejara el comprobante dentro de `offer`, nunca se guarda.
    await pedir({ offer: { kind: 'STANDARD', expectedFirstChargeCents: 0, quoteToken } as never, quoteToken })

    const plan = planDelCierre()
    expect(plan.offerVersion).toBe(2)
    expect(plan.offer).toEqual({ kind: 'STANDARD', expectedFirstChargeCents: 0 })
    expect(JSON.stringify(plan)).not.toContain(quoteToken)
  })

  it('🔴 la confirmación y el aviso al equipo dicen 92684 (el precio de la suscripción), no 115884', async () => {
    conVigente(v2())
    mockDestino.mockResolvedValue({ email: 'duena@example.com', locale: 'es', venueName: 'Negocio' })

    await pedir({ quoteToken: comprobante() })
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))

    expect(emailService.sendPlanConfirmationEmail).toHaveBeenCalledTimes(1)
    const correo = (emailService.sendPlanConfirmationEmail as jest.Mock).mock.calls[0][1]
    expect(correo).toMatchObject({ payNow: false, firstChargeAmountCents: PRO_M })
    expect(correo.introAmountCents).toBeUndefined()
    expect(resendService.sendPlanActivatedNotice).toHaveBeenCalledWith(expect.objectContaining({ payNow: false, firstChargeCents: PRO_M }))
  })

  it('el aviso y la confirmación de Pro mensual pagando hoy con la versión no anuncian la introducción legacy', async () => {
    conVigente(v2({ PRO: { trialDays: 0 } }))
    mockDestino.mockResolvedValue({ email: 'duena@example.com', locale: 'es', venueName: 'Negocio' })
    mockSubCreate.mockReset().mockResolvedValue({ id: 'sub_1', status: 'active' })
    mockSubRetrieve.mockResolvedValue(suscripcion({ status: 'active', trial_end: null, latest_invoice: { amount_paid: PRO_M } }))

    await pedir({ payNow: true, offer: { kind: 'STANDARD', expectedFirstChargeCents: PRO_M }, quoteToken: comprobanteDeHoy() })
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))

    const correo = (emailService.sendPlanConfirmationEmail as jest.Mock).mock.calls[0][1]
    expect(correo).toMatchObject({ payNow: true, firstChargeAmountCents: PRO_M })
    expect(correo.introAmountCents).toBeUndefined()
    expect(correo.nextChargeAmountCents).toBeUndefined()
  })

  it('🔴 el revisor (soloRecuperar) con la v2 no pide comprobante: nunca cobra y sólo cierra lo que Stripe ya cobró', async () => {
    conVigente(v2({ PREMIUM: { trialDays: 0 } }))
    prismaMock.feature.findFirst.mockResolvedValue({ id: 'feat-premium', code: 'PLAN_PREMIUM', stripeProductId: 'prod_pro' } as never)
    prismaMock.staffOrganization.findFirst.mockResolvedValue({ staffId: 'staff-1' } as never)
    mockEntregar.mockImplementation(async ({ subscriptionId }: { subscriptionId: string }) => ({
      venueId: 'venue-1',
      featureId: 'feat-premium',
      featureCode: 'PLAN_PREMIUM',
      subscriptionId,
      endDate: null,
    }))
    prismaMock.onboardingProgress.findUnique.mockResolvedValue({
      id: 'op-1',
      organizationId: ORG,
      completedAt: null,
      v2SetupData: {},
      launchCampaignId: null,
      termsAcceptedAt: new Date('2026-11-20T00:00:00Z'),
      planActivationStatus: 'IN_PROGRESS',
      planActivationAttempt: 1,
      planActivationLeaseUntil: null,
      planStripeSubscriptionId: 'sub_3ds',
    } as never)
    const pagada = suscripcion({
      id: 'sub_3ds',
      status: 'active',
      trial_end: null,
      default_payment_method: 'pm_1',
      metadata: {
        organizationId: ORG,
        featureCode: 'PLAN_PREMIUM',
        planActivationKey: `plan-activation:${ORG}:1`,
        primerCobroEsperadoCents: String(PREMIUM_M),
        planOfferVersion: '2',
      },
      latest_invoice: { id: 'in_1', status: 'paid', amount_paid: PREMIUM_M },
      items: { data: [{ price: precio('price_v2_premium_m', PREMIUM_M) }] },
    })
    mockSubRetrieve.mockResolvedValue(pagada)
    mockInvList.mockResolvedValue({
      has_more: false,
      data: [
        {
          id: 'in_1',
          customer: 'cus_1',
          currency: 'mxn',
          billing_reason: 'subscription_create',
          status: 'paid',
          total: PREMIUM_M,
          amount_paid: PREMIUM_M,
          starting_balance: 0,
          ending_balance: 0,
          post_payment_credit_notes_amount: 0,
        },
      ],
    })
    mockIpList.mockResolvedValue({
      has_more: false,
      data: [
        {
          status: 'paid',
          currency: 'mxn',
          amount_paid: PREMIUM_M,
          payment: {
            type: 'charge',
            charge: { id: 'ch_1', paid: true, currency: 'mxn', amount: PREMIUM_M, amount_refunded: 0, disputed: false },
          },
        },
      ],
    })

    await expect(cerrarAltaSinNavegador(ORG)).resolves.toBe('CERRADA')

    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(mockEntregar).toHaveBeenCalledWith(expect.objectContaining({ subscriptionId: 'sub_3ds' }))
    // Desde IN_PROGRESS el CAS no escribe la versión (es de la recuperación, Task 5).
    expect(progresos().some((p: any) => 'planOfferVersionNumber' in (p.data ?? {}))).toBe(false)
  })
})
