/**
 * Planes editables B2, Task 5: la recuperación cierra con la suscripción del intento (Codex B1 #1, b2-r1 #1, b2-r2 #1, b2-r9 #3).
 *
 * Un intento anterior `IN_PROGRESS` pudo cobrar. Recuperarlo no depende del comprobante, del plan pedido ni de leer la oferta:
 * el PASO 4 difiere el rechazo (`rechazoDiferido`) y el precio, el PASO 6 busca la suscripción del intento (por su id o por su
 * llave) y, si está cobrada o en prueba, el alta cierra con ELLA (su plan, su periodicidad, su modalidad, su versión). El
 * comprobante y el precio sólo se revisan si el PASO 6 terminó en un intento nuevo.
 *
 * El servicio real; Stripe, la regla común (`autorizarObligacionNueva`, que corre su callback), la entrega y la evidencia del
 * primer cobro (probada en su suite) simulados, como en `planActivation.comprobante.test.ts`. Por default la v2 vigente trae
 * Pro de 0 días («pagar hoy»): mensual $799 + IVA (92684) y anual $7,990 + IVA (926840).
 */
const mockSubCreate = jest.fn()
const mockSubRetrieve = jest.fn()
const mockSubList = jest.fn()
const mockPriceList = jest.fn()
const mockPriceRetrieve = jest.fn()
const mockPmRetrieve = jest.fn()
const mockIpList = jest.fn()
const mockVoid = jest.fn()

jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    subscriptions: { create: mockSubCreate, retrieve: mockSubRetrieve, list: mockSubList, cancel: jest.fn(), update: jest.fn() },
    prices: { list: mockPriceList, retrieve: mockPriceRetrieve },
    paymentMethods: { retrieve: mockPmRetrieve },
    coupons: { create: jest.fn(), retrieve: jest.fn(), del: jest.fn() },
    customers: { create: jest.fn(), retrieve: jest.fn(), listBalanceTransactions: jest.fn() },
    invoices: { list: jest.fn(), voidInvoice: mockVoid },
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
const mockCubierto = jest.fn()
jest.mock('@/services/onboarding/primerCobroPagado', () => ({ primerCobroCubierto: (...a: unknown[]) => mockCubierto(...a) }))
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
    // B2 Task 6: la bienvenida de la prueba sin tarjeta (la recibe el cierre de una prueba sin tarjeta recuperada).
    sendPlanFreeTrialEndingEmail: jest.fn().mockResolvedValue(true),
  },
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
import logger from '@/config/logger'

const DIA = 86_400_000
const ORG = 'org-1'
const LLAVE_1 = `plan-activation:${ORG}:1`
const PRO_M_V2 = 92684 // 79900 + IVA
const PRO_A_V2 = 926840 // 799000 + IVA
const PREMIUM_A = 1970840 // 1699000 + IVA (lo de hoy)
const FIN = Math.floor(new Date('2027-11-25T00:00:00Z').getTime() / 1000)

type Planes = NonNullable<Parameters<typeof definicionDePrueba>[0]>['planes']
/** La v2 del editor: Pro de 0 días a $799/$7,990 + IVA. */
const v2 = (planes: Planes = {}) =>
  definicionDePrueba({
    ids: idsDeLaVersion('v2'),
    netos: { 'PRO:monthly': 79900, 'PRO:annual': 799000 },
    planes: { PRO: { trialDays: 0 }, ...planes },
  })
/** La v3 publicada después: otro mensual y otro anual de Pro, con precios que Stripe NO tiene en este escenario. */
const v3 = () =>
  definicionDePrueba({
    ids: idsDeLaVersion('v3'),
    netos: { 'PRO:monthly': 89900, 'PRO:annual': 899000 },
    planes: { PRO: { trialDays: 0 } },
  })
const conVigente = (definition: unknown, number: number) =>
  prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA(`cv${number}`, number, definition) as never)
/** Un puntero cuya vigente no pasa el esquema: `versionQueCobra()` lanza el 503 `PLAN_NOT_CONFIGURED`. */
const conPunteroIlegible = () =>
  prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, { schemaVersion: 1, PRO: 'roto' }) as never)

/** Un comprobante del alta de esta organización: por default, Pro mensual de 0 días de la v2 (paga hoy 92684). */
const comprobante = (c: Partial<CotizacionFirmable> = {}, emitido?: Date) =>
  comprobanteDePrueba(
    { alcance: `org:${ORG}`, versionNumber: 2, precioCents: PRO_M_V2, firstChargeCents: PRO_M_V2, trialEndsAt: null, ...c },
    emitido,
  )

const BASE = {
  organizationId: ORG,
  staffId: 'staff-1',
  tier: 'PRO' as const,
  interval: 'monthly' as const,
  payNow: true,
  paymentMethodId: 'pm_1',
}
const pedir = (o: Partial<ActivatePlanInput> = {}, opciones?: Parameters<typeof activatePlan>[1]) =>
  activatePlan({ ...BASE, offer: { kind: 'STANDARD', expectedFirstChargeCents: PRO_M_V2 }, ...o } as ActivatePlanInput, opciones)

const progresos = () => (prismaMock.onboardingProgress.updateMany as jest.Mock).mock.calls.map((c: unknown[]) => c[0] as any)
const conEstado = (estado: string) => progresos().filter((a: any) => a?.data?.planActivationStatus === estado)
function planDelCierre(): any {
  const fusiones = (prismaMock.$executeRaw as jest.Mock).mock.calls.filter(
    (c: any[]) => Array.isArray(c[0]) && c[0].join('').includes('"v2SetupData"'),
  )
  const ultima = fusiones.at(-1)
  return ultima ? JSON.parse(ultima[1]).plan : undefined
}

const precio = (id: string, unitAmount: number, interval: 'month' | 'year' = 'month') => ({
  id,
  active: true,
  unit_amount: unitAmount,
  currency: 'mxn',
  product: 'prod_pro',
  recurring: { interval, interval_count: 1 },
  tax_behavior: 'inclusive',
})
/** Lo que Stripe tiene: los precios de la v2 (Avoqado no archiva precios) y la llave de hoy. Los de la v3, no. */
const PRECIOS: Record<string, ReturnType<typeof precio>> = {
  price_v2_pro_m: precio('price_v2_pro_m', PRO_M_V2),
  price_v2_pro_a: precio('price_v2_pro_a', PRO_A_V2, 'year'),
  price_v2_premium_a: precio('price_v2_premium_a', PREMIUM_A, 'year'),
}

/** El alta con un intento anterior que pudo cobrar: IN_PROGRESS, lease vencido, intento 1 de la v2. */
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
    planActivationLeaseUntil: null,
    planStripeSubscriptionId: 'sub_3ds',
    planOfferVersionNumber: 2,
    ...o,
  } as never)

/** La metadata sin esas llaves (p. ej. sin la marca del reto: un cobro clásico en el primer `create`). */
const sin = (metadata: Record<string, string>, ...llaves: string[]) =>
  Object.fromEntries(Object.entries(metadata).filter(([llave]) => !llaves.includes(llave)))

/** La suscripción del intento 1, cobrada con la v2: Pro anual pagado hoy, con la marca del reto (3DS autorizado). */
function cobrada(o: Record<string, unknown> = {}, metadata: Record<string, string> = {}) {
  return {
    id: 'sub_3ds',
    status: 'active',
    default_payment_method: 'pm_1',
    customer: 'cus_1',
    current_period_end: FIN,
    trial_end: null,
    metadata: {
      organizationId: ORG,
      featureCode: 'PLAN_PRO',
      planActivationKey: LLAVE_1,
      primerCobroEsperadoCents: String(PRO_A_V2),
      planOfferVersion: '2',
      planOfferPrecioDe: '2',
      ...metadata,
    },
    latest_invoice: { id: 'in_1', status: 'paid', amount_paid: PRO_A_V2 },
    items: { data: [{ current_period_end: FIN, price: PRECIOS.price_v2_pro_a }] },
    discounts: [],
    ...o,
  }
}

/** La suscripción del intento 1 sin cobrar: incompleta, con otra tarjeta, su factura abierta y el banco sin método. */
function sinCobroDeOtraTarjeta() {
  return {
    id: 'sub_3ds',
    status: 'incomplete',
    default_payment_method: 'pm_otra',
    customer: 'cus_1',
    metadata: { organizationId: ORG, featureCode: 'PLAN_PRO', planActivationKey: LLAVE_1, planOfferVersion: '2' },
    latest_invoice: { id: 'in_1', status: 'open', confirmation_secret: { client_secret: 'pi_viejo_secret_x' } },
    items: { data: [{ price: PRECIOS.price_v2_pro_m }] },
  }
}

const pagoConEstado = (estado: string) =>
  mockIpList.mockResolvedValue({
    has_more: false,
    data: [{ is_default: true, payment: { type: 'payment_intent', payment_intent: { id: 'pi_1', status: estado } } }],
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
  mockCubierto.mockReset().mockResolvedValue(true)
  mockDestino.mockReset().mockResolvedValue({ email: null, locale: 'es', venueName: 'Negocio' })
  mockPriceList.mockReset().mockResolvedValue({ data: [{ id: 'price_llave_pro_a', unit_amount: 1158840 }] })
  mockPriceRetrieve.mockReset().mockImplementation(async (id: string) => {
    if (!PRECIOS[id]) throw Object.assign(new Error('No such price'), { code: 'resource_missing', statusCode: 404 })
    return PRECIOS[id]
  })
  mockPmRetrieve.mockReset().mockResolvedValue({ id: 'pm_1', customer: 'cus_1', card: { fingerprint: 'fp_1' } })
  mockSubCreate.mockReset()
  mockSubRetrieve.mockReset().mockResolvedValue(cobrada())
  mockSubList.mockReset()
  mockIpList.mockReset()
  mockVoid.mockReset().mockResolvedValue({ id: 'in_1', status: 'void' })
  conVigente(v2(), 2)
  alta()
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
  prismaMock.staffOrganization.findFirst.mockResolvedValue({ staffId: 'staff-1' } as never)
  prismaMock.feature.findFirst.mockResolvedValue({
    id: 'feat-pro',
    code: 'PLAN_PRO',
    monthlyPrice: 999,
    stripeProductId: 'prod_pro',
  } as never)
  prismaMock.venueFeature.findUnique.mockResolvedValue(null as never)
  prismaMock.venueFeature.upsert.mockResolvedValue({} as never)
})

describe('B2 Task 5: un intento anterior que pudo cobrar se recupera con su suscripción', () => {
  it('🔴 Codex B1 #1: 3DS de Pro anual pagado con la v2; se publica la v3 con otro anual; activatePlan({ soloRecuperar }) → ACTIVE con esa suscripción, sin PLAN_PRICE_MISMATCH y sin prices.retrieve del precio de la v3', async () => {
    conVigente(v3(), 3)

    const r = await pedir(
      { interval: 'annual', offer: { kind: 'STANDARD', expectedFirstChargeCents: PRO_A_V2 } },
      { soloRecuperar: 'sub_3ds' },
    )

    expect(r).toMatchObject({ status: 'ACTIVE', tier: 'PRO', interval: 'annual' })
    expect(mockPriceRetrieve).not.toHaveBeenCalledWith('price_v3_pro_a')
    expect(mockPriceRetrieve).not.toHaveBeenCalled()
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(mockEntregar).toHaveBeenCalledWith(expect.objectContaining({ subscriptionId: 'sub_3ds' }))
    // Con la marca del reto, la evidencia del primer cobro se sigue exigiendo contra la marca (no contra la v3).
    expect(mockCubierto).toHaveBeenCalledWith('venue-1', 'sub_3ds', PRO_A_V2)
    expect(conEstado('ACTIVE')).toHaveLength(1)
    expect(planDelCierre()).toMatchObject({ tier: 'PRO', interval: 'annual', payNow: true, offerVersion: 2 })
  })

  it('🔴 el reenvío del navegador con el comprobante de la v2 (ya no vigente, o vencido hace 1 h) → 200 ACTIVE, sin 409', async () => {
    conVigente(v3(), 3)
    const cuerpo = { interval: 'annual' as const, offer: { kind: 'STANDARD' as const, expectedFirstChargeCents: PRO_A_V2 } }
    const deLaV2 = comprobante({ interval: 'annual', precioCents: PRO_A_V2, firstChargeCents: PRO_A_V2 })

    await expect(pedir({ ...cuerpo, quoteToken: deLaV2 })).resolves.toMatchObject({ status: 'ACTIVE', interval: 'annual' })

    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (cb: unknown) => (cb as (tx: unknown) => unknown)(prismaMock))
    conVigente(v2(), 2)
    const vencido = comprobante(
      { interval: 'annual', precioCents: PRO_A_V2, firstChargeCents: PRO_A_V2 },
      new Date(Date.now() - DIA - 3_600_000),
    )
    await expect(pedir({ ...cuerpo, quoteToken: vencido })).resolves.toMatchObject({ status: 'ACTIVE', interval: 'annual' })
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(mockPriceRetrieve).not.toHaveBeenCalled()
  })

  it('🔴 b2-r1 #1: la suscripción de la v2 se creó y su id nunca se guardó; sale la v3; el reenvío → el PASO 6 la encuentra por la llave → 200 ACTIVE', async () => {
    conVigente(v3(), 3)
    alta({ planStripeSubscriptionId: null })
    // La respuesta del create se perdió: un cobro clásico (sin la marca del reto) en el primer create.
    const suya = cobrada({ metadata: sin(cobrada().metadata, 'primerCobroEsperadoCents') })
    mockSubRetrieve.mockResolvedValue(suya)
    mockSubList.mockReturnValue({
      autoPagingEach: async (cb: (s: unknown) => boolean | Promise<boolean>) => {
        for (const s of [{ id: 'sub_ajena', metadata: { planActivationKey: 'otra' } }, suya]) if ((await cb(s)) === false) return
      },
    })

    const r = await pedir({
      interval: 'annual',
      offer: { kind: 'STANDARD', expectedFirstChargeCents: PRO_A_V2 },
      quoteToken: comprobante({ interval: 'annual', precioCents: PRO_A_V2, firstChargeCents: PRO_A_V2 }),
    })

    expect(r).toMatchObject({ status: 'ACTIVE', interval: 'annual' })
    expect(mockSubList).toHaveBeenCalledWith({ customer: 'cus_1', status: 'all', limit: 100 })
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(prismaMock.onboardingProgress.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ planActivationStatus: 'ACTIVE', planStripeSubscriptionId: 'sub_3ds' }) }),
    )
    // Sin la marca, el cobro clásico no exige la evidencia del reto.
    expect(mockCubierto).not.toHaveBeenCalled()
  })

  it('🔴 b2-r1 #1: «Confirmar mi pago» pide Pro mensual sobre un Premium anual ya pagado → 200 ACTIVE como Premium anual', async () => {
    // El DASHBOARD recargó la cotización (la v3) y manda un comprobante VÁLIDO de Pro mensual; lo cobrado es Premium anual de la v2.
    conVigente(v3(), 3)
    mockDestino.mockResolvedValue({ email: 'duena@example.com', locale: 'es', venueName: 'Negocio' })
    prismaMock.feature.findFirst.mockResolvedValue({ id: 'feat-premium', code: 'PLAN_PREMIUM', stripeProductId: 'prod_pro' } as never)
    mockEntregar.mockImplementation(async ({ subscriptionId }: { subscriptionId: string }) => ({
      venueId: 'venue-1',
      featureId: 'feat-premium',
      featureCode: 'PLAN_PREMIUM',
      subscriptionId,
      endDate: null,
    }))
    mockSubRetrieve.mockResolvedValue(
      cobrada(
        {
          default_payment_method: 'pm_suyo',
          latest_invoice: { id: 'in_1', status: 'paid', amount_paid: PREMIUM_A },
          items: { data: [{ current_period_end: FIN, price: PRECIOS.price_v2_premium_a }] },
        },
        { featureCode: 'PLAN_PREMIUM', primerCobroEsperadoCents: String(PREMIUM_A) },
      ),
    )
    const PRO_M_V3 = 104284 // 89900 + IVA

    const r = await pedir({
      offer: { kind: 'STANDARD', expectedFirstChargeCents: PRO_M_V3 },
      quoteToken: comprobante({ versionNumber: 3, precioCents: PRO_M_V3, firstChargeCents: PRO_M_V3 }),
    })
    await new Promise(res => setImmediate(res))
    await new Promise(res => setImmediate(res))

    expect(r).toMatchObject({ status: 'ACTIVE', tier: 'PREMIUM', interval: 'annual' })
    // La modalidad sale de la suscripción, nunca del cuerpo ni del comprobante (b2-r7 #6, carry 2).
    expect(planDelCierre()).toMatchObject({
      tier: 'PREMIUM',
      interval: 'annual',
      payNow: true,
      sinTarjeta: false,
      paymentMethodId: 'pm_suyo',
      offerVersion: 2,
      offer: { kind: 'STANDARD', expectedFirstChargeCents: PREMIUM_A },
    })
    // Ni el comprobante ni el precio de la vigente se comparan; no se escribe la versión del comprobante.
    expect(mockPriceRetrieve).not.toHaveBeenCalled()
    expect(progresos().some((p: any) => 'planOfferVersionNumber' in (p.data ?? {}))).toBe(false)
    expect(mockSubCreate).not.toHaveBeenCalled()
    // El correo es la confirmación de pago, con el precio de SU suscripción (no el del comprobante).
    expect(emailService.sendPlanConfirmationEmail).toHaveBeenCalledTimes(1)
    const correo = (emailService.sendPlanConfirmationEmail as jest.Mock).mock.calls[0][1]
    expect(correo).toMatchObject({ planName: 'Premium', interval: 'annual', payNow: true, firstChargeAmountCents: PREMIUM_A })
  })

  it('el banco todavía espera: 409 PLAN_PAYMENT_REQUIRES_ACTION con el mismo secreto, nunca OFFER_CHANGED', async () => {
    conVigente(v3(), 3)
    mockSubRetrieve.mockResolvedValue({
      ...cobrada(),
      status: 'incomplete',
      latest_invoice: { id: 'in_1', status: 'open', confirmation_secret: { client_secret: 'pi_reto_secret_x' } },
    })
    pagoConEstado('requires_action')

    await expect(
      pedir({
        interval: 'annual',
        offer: { kind: 'STANDARD', expectedFirstChargeCents: PRO_A_V2 },
        quoteToken: comprobante({ interval: 'annual', precioCents: PRO_A_V2, firstChargeCents: PRO_A_V2 }),
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'PLAN_PAYMENT_REQUIRES_ACTION', details: { clientSecret: 'pi_reto_secret_x' } })
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(mockVoid).not.toHaveBeenCalled()
  })

  /** El reto del banco del intento 1 (Pro anual de la v2), esperando todavía; la suscripción nueva se lee por su id. */
  const retoDeLaV2 = () => ({
    ...cobrada(),
    status: 'incomplete',
    latest_invoice: { id: 'in_1', status: 'open', confirmation_secret: { client_secret: 'pi_reto_secret_x' } },
  })
  const nuevaCobrada = (price: ReturnType<typeof precio>) =>
    cobrada({
      id: 'sub_nuevo',
      metadata: {},
      latest_invoice: { id: 'in_2', status: 'paid', amount_paid: price.unit_amount },
      items: { data: [{ current_period_end: FIN, price }] },
    })

  it('🔴 Codex b2-code #2: reto de Pro anual de la v2 pendiente; sale la v3 con otro precio; la dueña recarga y manda un comprobante VÁLIDO de la v3 con la misma tarjeta → no se reanuda el reto viejo: se anula su factura y el intento nuevo cobra el precio de la v3', async () => {
    conVigente(v3(), 3)
    const PRO_A_V3 = 1042840 // 899000 + IVA
    const precioV3 = precio('price_v3_pro_a', PRO_A_V3, 'year')
    mockPriceRetrieve.mockImplementation(async (id: string) => {
      if (id === 'price_v3_pro_a') return precioV3
      throw Object.assign(new Error('No such price'), { code: 'resource_missing', statusCode: 404 })
    })
    mockSubRetrieve.mockImplementation(async (id: string) => (id === 'sub_nuevo' ? nuevaCobrada(precioV3) : retoDeLaV2()))
    pagoConEstado('requires_action')
    mockSubCreate.mockResolvedValue({ id: 'sub_nuevo', status: 'active' })

    const r = await pedir({
      interval: 'annual',
      offer: { kind: 'STANDARD', expectedFirstChargeCents: PRO_A_V3 },
      quoteToken: comprobante({ versionNumber: 3, interval: 'annual', precioCents: PRO_A_V3, firstChargeCents: PRO_A_V3 }),
    })

    expect(r.status).toBe('ACTIVE')
    expect(mockVoid).toHaveBeenCalledWith('in_1')
    expect(mockSubCreate).toHaveBeenCalledTimes(1)
    const [cuerpo] = mockSubCreate.mock.calls[0]
    expect(cuerpo.items).toEqual([{ price: 'price_v3_pro_a' }])
    expect(cuerpo.metadata).toMatchObject({ planOfferVersion: '3', planActivationKey: `plan-activation:${ORG}:2` })
  })

  it('🔴 Codex b2-code #2: reto de Pro ANUAL de la v2 pendiente; la dueña pide Pro MENSUAL con un comprobante válido de la v2 y la misma tarjeta → se anula el reto anual y el intento nuevo cobra el mensual', async () => {
    mockSubRetrieve.mockImplementation(async (id: string) => (id === 'sub_nuevo' ? nuevaCobrada(PRECIOS.price_v2_pro_m) : retoDeLaV2()))
    pagoConEstado('requires_action')
    mockSubCreate.mockResolvedValue({ id: 'sub_nuevo', status: 'active' })

    const r = await pedir({ quoteToken: comprobante() })

    expect(r).toMatchObject({ status: 'ACTIVE', interval: 'monthly' })
    expect(mockVoid).toHaveBeenCalledWith('in_1')
    expect(mockSubCreate).toHaveBeenCalledTimes(1)
    expect(mockSubCreate.mock.calls[0][0].items).toEqual([{ price: 'price_v2_pro_m' }])
  })

  it('el reenvío del navegador sin comprobante legible no reanuda el reto de una versión del editor (la versión vacía no es la suya): se anula y el intento nuevo pide su comprobante', async () => {
    mockSubRetrieve.mockResolvedValue(retoDeLaV2())
    pagoConEstado('requires_action')

    await expect(
      pedir({ interval: 'annual', offer: { kind: 'STANDARD', expectedFirstChargeCents: PRO_A_V2 }, quoteToken: 'no-es-un-comprobante' }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'QUOTE_INVALID' })
    expect(mockVoid).toHaveBeenCalledWith('in_1')
    expect(mockSubCreate).not.toHaveBeenCalled()
  })

  it('🔴 intento anterior sin cobro (otra tarjeta, se descarta) y comprobante de la v2 ya no vigente → 409 OFFER_CHANGED reason VERSION, cero subscriptions.create; queda IN_PROGRESS con el intento siguiente, sin lease ni id', async () => {
    conVigente(v3(), 3)
    mockSubRetrieve.mockResolvedValue(sinCobroDeOtraTarjeta())
    pagoConEstado('requires_payment_method')

    await expect(pedir({ quoteToken: comprobante() })).rejects.toMatchObject({
      statusCode: 409,
      code: 'OFFER_CHANGED',
      details: { reason: 'VERSION', offerVersion: 3 },
    })

    expect(mockVoid).toHaveBeenCalledWith('in_1')
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(mockAutorizar).not.toHaveBeenCalled()
    // El avance estrena el intento 2 sin el id del descartado; luego se suelta el lease de ESE intento.
    const avance = progresos().find((p: any) => p.data?.planActivationAttempt === 2)
    expect(avance).toMatchObject({
      where: { organizationId: ORG, planActivationStatus: 'IN_PROGRESS', planActivationAttempt: 1 },
      data: { planActivationAttempt: 2, planStripeSubscriptionId: null },
    })
    expect(avance.data).not.toHaveProperty('planOfferVersionNumber')
    expect(progresos().at(-1)).toMatchObject({
      where: { organizationId: ORG, planActivationStatus: 'IN_PROGRESS', planActivationAttempt: 2 },
      data: { planActivationStatus: 'IN_PROGRESS', planActivationLeaseUntil: null },
    })
  })

  it('intento anterior descartado y comprobante de la vigente → subscriptions.create con el precio de la VERSIÓN y planOfferVersionNumber escrito en el avance, antes del create', async () => {
    mockSubRetrieve.mockImplementation(async (id: string) =>
      id === 'sub_nuevo'
        ? cobrada({
            id: 'sub_nuevo',
            metadata: {},
            latest_invoice: { id: 'in_2', amount_paid: PRO_M_V2 },
            items: { data: [{ price: PRECIOS.price_v2_pro_m }] },
          })
        : sinCobroDeOtraTarjeta(),
    )
    pagoConEstado('requires_payment_method')
    mockSubCreate.mockResolvedValue({ id: 'sub_nuevo', status: 'active' })

    const r = await pedir({ quoteToken: comprobante() })

    expect(r.status).toBe('ACTIVE')
    expect(mockSubCreate).toHaveBeenCalledTimes(1)
    const [cuerpo, opciones] = mockSubCreate.mock.calls[0]
    expect(cuerpo.items).toEqual([{ price: 'price_v2_pro_m' }])
    expect(cuerpo.metadata).toMatchObject({ planOfferVersion: '2', planActivationKey: `plan-activation:${ORG}:2` })
    expect(opciones).toMatchObject({ idempotencyKey: `plan-activation:${ORG}:2` })
    // El precio se verificó contra la ranura de la VERSIÓN (después del PASO 6, antes del avance).
    expect(mockPriceRetrieve.mock.calls.map((c: unknown[]) => c[0])).toEqual(['price_v2_pro_m'])
    const llamadas = (prismaMock.onboardingProgress.updateMany as jest.Mock).mock.calls
    const i = llamadas.findIndex((c: unknown[]) => (c[0] as any).data?.planActivationAttempt === 2)
    expect(llamadas[i][0].data).toEqual({ planActivationAttempt: 2, planStripeSubscriptionId: null, planOfferVersionNumber: 2 })
    expect((prismaMock.onboardingProgress.updateMany as jest.Mock).mock.invocationCallOrder[i]).toBeLessThan(
      mockSubCreate.mock.invocationCallOrder[0],
    )
    expect(mockPriceRetrieve.mock.invocationCallOrder[0]).toBeLessThan(
      (prismaMock.onboardingProgress.updateMany as jest.Mock).mock.invocationCallOrder[i],
    )
  })

  it('🔴 intento anterior descartado, comprobante de la vigente y su precio ya no sirve → 409 PLAN_PRICE_MISMATCH, soltarLease del intento anterior y cero create', async () => {
    mockSubRetrieve.mockResolvedValue(sinCobroDeOtraTarjeta())
    pagoConEstado('requires_payment_method')
    mockPriceRetrieve.mockResolvedValue({ ...PRECIOS.price_v2_pro_m, active: false })

    await expect(pedir({ quoteToken: comprobante() })).rejects.toMatchObject({ statusCode: 409, code: 'PLAN_PRICE_MISMATCH' })

    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(progresos().some((p: any) => p.data?.planActivationAttempt === 2)).toBe(false)
    expect(progresos().at(-1)).toMatchObject({
      where: { organizationId: ORG, planActivationStatus: 'IN_PROGRESS', planActivationAttempt: 1 },
      data: { planActivationStatus: 'IN_PROGRESS', planActivationLeaseUntil: null },
    })
  })

  it('🔴 sin versión del editor, la recuperación sigue el camino de B0: verificarPrecioPorLlave con sus mismas llamadas', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(null)
    alta({ planOfferVersionNumber: null })
    const deB0 = sin(cobrada().metadata, 'planOfferVersion', 'planOfferPrecioDe', 'primerCobroEsperadoCents')
    mockSubRetrieve.mockResolvedValue(
      cobrada(
        {
          default_payment_method: 'pm_suyo',
          latest_invoice: { id: 'in_1', status: 'paid', amount_paid: 1158840 },
          items: { data: [{ price: precio('price_llave_pro_a', 1158840, 'year') }] },
          metadata: deB0,
        },
        {},
      ),
    )

    const r = await pedir({ interval: 'annual', offer: { kind: 'STANDARD', expectedFirstChargeCents: 1158840 }, quoteToken: 'x' })

    expect(r).toMatchObject({ status: 'ACTIVE', interval: 'annual' })
    expect(mockPriceList.mock.calls).toEqual([[{ lookup_keys: ['plan_pro_annual'], limit: 1 }]])
    expect(mockPriceRetrieve).not.toHaveBeenCalled()
    expect(progresos().some((p: any) => 'planOfferVersionNumber' in (p.data ?? {}))).toBe(false)
    // B0 literal: el plan guardado con la tarjeta del formulario, sin versión ni `sinTarjeta`.
    const plan = planDelCierre()
    expect(plan).toMatchObject({ tier: 'PRO', interval: 'annual', payNow: true, paymentMethodId: 'pm_1' })
    expect(plan).not.toHaveProperty('offerVersion')
    expect(plan).not.toHaveProperty('sinTarjeta')
    expect(plan.offer).toEqual({ kind: 'STANDARD', expectedFirstChargeCents: 1158840 })
  })

  it('🔴 b2-r9 #3 (el caso de Codex): Pro de 0 días de la v2 ya cobrado; versionQueCobra() lanza (puntero ilegible) en el reenvío → 200 ACTIVE con esa suscripción, sin prices.retrieve ni subscriptions.create', async () => {
    conPunteroIlegible()
    const sinMarca = sin(cobrada().metadata, 'primerCobroEsperadoCents')
    mockSubRetrieve.mockResolvedValue(
      cobrada({
        latest_invoice: { id: 'in_1', status: 'paid', amount_paid: PRO_M_V2 },
        items: { data: [{ current_period_end: FIN, price: PRECIOS.price_v2_pro_m }] },
        metadata: sinMarca,
      }),
    )

    const r = await pedir({ quoteToken: comprobante() })

    expect(r).toMatchObject({ status: 'ACTIVE', tier: 'PRO', interval: 'monthly' })
    expect(mockPriceRetrieve).not.toHaveBeenCalled()
    expect(mockPriceList).not.toHaveBeenCalled()
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(conEstado('ACTIVE')).toHaveLength(1)
    expect(planDelCierre()).toMatchObject({ tier: 'PRO', interval: 'monthly', payNow: true, offerVersion: 2 })
  })

  it('🔴 b2-r9 #3: el mismo error sin un intento anterior IN_PROGRESS → sale en el PASO 3 como hoy; con un intento anterior sin cobro (se descarta) → soltarLease y el mismo error, cero subscriptions.create', async () => {
    conPunteroIlegible()
    alta({ planActivationStatus: 'NONE', planActivationAttempt: 0, planStripeSubscriptionId: null, planOfferVersionNumber: null })

    await expect(pedir({ quoteToken: comprobante() })).rejects.toMatchObject({ statusCode: 503, code: 'PLAN_NOT_CONFIGURED' })
    expect(prismaMock.onboardingProgress.updateMany).not.toHaveBeenCalled()
    expect(mockSubRetrieve).not.toHaveBeenCalled()

    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (cb: unknown) => (cb as (tx: unknown) => unknown)(prismaMock))
    alta()
    mockSubRetrieve.mockResolvedValue(sinCobroDeOtraTarjeta())
    pagoConEstado('requires_payment_method')

    await expect(pedir({ quoteToken: comprobante() })).rejects.toMatchObject({ statusCode: 503, code: 'PLAN_NOT_CONFIGURED' })
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(mockAutorizar).not.toHaveBeenCalled()
    expect(progresos().at(-1)).toMatchObject({
      where: { organizationId: ORG, planActivationStatus: 'IN_PROGRESS', planActivationAttempt: 2 },
      data: { planActivationStatus: 'IN_PROGRESS', planActivationLeaseUntil: null },
    })
  })

  it('una suscripción de la v2 sin tarjeta (metadata sinTarjeta) en prueba: el barrido la cierra con paymentMethodId null y sinTarjeta true, sin la confirmación de pago', async () => {
    mockDestino.mockResolvedValue({ email: 'duena@example.com', locale: 'es', venueName: 'Negocio' })
    const sinMarca = sin(cobrada().metadata, 'primerCobroEsperadoCents')
    mockSubRetrieve.mockResolvedValue(
      cobrada({
        status: 'trialing',
        default_payment_method: null,
        trial_end: FIN,
        latest_invoice: { id: 'in_1', status: 'paid', amount_paid: 0, amount_due: 0 },
        items: { data: [{ current_period_end: FIN, price: PRECIOS.price_v2_pro_m }] },
        metadata: { ...sinMarca, sinTarjeta: 'true' },
      }),
    )

    await expect(cerrarAltaSinNavegador(ORG)).resolves.toBe('CERRADA')
    await new Promise(res => setImmediate(res))
    await new Promise(res => setImmediate(res))

    expect(planDelCierre()).toMatchObject({ tier: 'PRO', interval: 'monthly', payNow: false, sinTarjeta: true, paymentMethodId: null })
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(mockPmRetrieve).not.toHaveBeenCalled()
    expect(emailService.sendPlanConfirmationEmail).not.toHaveBeenCalled()
    // B2 Task 6: en su lugar, la bienvenida de la prueba sin tarjeta, una por suscripción, al precio de su suscripción.
    expect(emailService.sendPlanFreeTrialEndingEmail).toHaveBeenCalledWith(
      'duena@example.com',
      expect.objectContaining({ empezo: true, idempotencyKey: 'plan-trial-no-card-start:sub_3ds', montoAlTerminarCents: PRO_M_V2 }),
    )
    expect(logger.warn).not.toHaveBeenCalledWith(
      'activate-plan: no se pudo enviar la bienvenida de la prueba sin tarjeta',
      expect.anything(),
    )
  })

  it('el texto del cierre del barrido: sin versión del editor, el de hoy; con versión, el nuevo (cubre también el cobro sin la marca)', async () => {
    const DE_HOY = 'altas-a-medio-pago: el cliente autorizó y cerró la pestaña — el alta se cerró sin el navegador'
    const NUEVO = 'altas-a-medio-pago: el cobro del alta estaba hecho y nadie lo cerró — el alta se cerró sin el navegador'
    const textos = () => (logger.info as jest.Mock).mock.calls.map((c: unknown[]) => c[0])

    // Sin versión: B0 literal (el 3DS de Pro anual con la llave de hoy y su marca).
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(null)
    alta({ planOfferVersionNumber: null })
    mockSubRetrieve.mockResolvedValue(
      cobrada(
        {
          latest_invoice: { id: 'in_1', status: 'paid', amount_paid: 1158840 },
          items: { data: [{ current_period_end: FIN, price: precio('price_llave_pro_a', 1158840, 'year') }] },
          metadata: { ...sin(cobrada().metadata, 'planOfferVersion', 'planOfferPrecioDe'), primerCobroEsperadoCents: '1158840' },
        },
        {},
      ),
    )
    await expect(cerrarAltaSinNavegador(ORG)).resolves.toBe('CERRADA')
    expect(textos()).toContain(DE_HOY)
    expect(textos()).not.toContain(NUEVO)

    // Con versión: el texto nuevo.
    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(async (cb: unknown) => (cb as (tx: unknown) => unknown)(prismaMock))
    conVigente(v2(), 2)
    alta()
    mockSubRetrieve.mockResolvedValue(cobrada())
    await expect(cerrarAltaSinNavegador(ORG)).resolves.toBe('CERRADA')
    expect(textos()).toContain(NUEVO)
    expect(textos()).not.toContain(DE_HOY)
  })
})
