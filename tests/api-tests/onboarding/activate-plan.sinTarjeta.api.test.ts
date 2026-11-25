/*
  Planes editables B2, Task 6 (§16, §18): el alta SIN tarjeta por la ruta real.

  POST /api/v1/onboarding/organizations/:organizationId/v2/activate-plan
    { tier: 'PRO', interval: 'monthly', payNow: false,
      offer: { kind: 'STANDARD_SIN_TARJETA', expectedFirstChargeCents: 0, quoteToken } }

  🔴 Lo que fija:
  - `STANDARD_SIN_TARJETA` sólo lo reconoce la validación con una versión del editor: sin ella (o si leerla falla) el cuerpo recibe
    EXACTAMENTE el 400 de hoy, con su cuerpo de error (b2-r6, b2-r7 #7); un cuerpo válido de hoy ni consulta la versión;
  - con la v2, la prueba se abre en Stripe sin método de pago, al precio de su versión, y la respuesta, el reintento y `progress`
    dicen la tarjeta que Stripe cobraría y si habrá cobro (§18, b2-r8, b2-r9 #7), leídos en ese momento;
  - un cliente de Stripe borrado se cambia por uno nuevo antes de abrir la prueba (b2-r9 #4);
  - la recuperación cierra con lo que cobró el intento anterior, no con lo que pide el cuerpo (b2-r7 #6);
  - una prueba que Stripe ya canceló sin tarjeta cierra el alta en Gratis (b2-r3 #3).

  Arranca el Express real (authenticateToken → requireOnboardingOrgOwner → validarActivatePlan → controlador → servicio). La fila del
  alta es un falso con estado (`findUnique` la lee, `updateMany` aplica su CAS y la fusión de `v2SetupData` la escribe), así varias
  peticiones ven lo que dejó la anterior. Stripe, la regla común (que corre su callback), la entrega, los correos y el cierre final
  (`terminarAltaCobrada`, con su suite) simulados.
*/

process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret'
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/testdb?schema=public'
// La ruta sólo existe con el plan obligatorio encendido; se lee al cargar las rutas, así que va ANTES de `src/app`.
process.env.ENABLE_VENUE_BASE_SUBSCRIPTION = 'true'

const mockSubCreate = jest.fn()
const mockSubRetrieve = jest.fn()
const mockSubList = jest.fn()
const mockPriceList = jest.fn()
const mockPriceRetrieve = jest.fn()
const mockPmRetrieve = jest.fn()
const mockPmDetach = jest.fn()
const mockCustomerCreate = jest.fn()
const mockCustomerRetrieve = jest.fn()
const mockCustomerUpdate = jest.fn()
const mockInvList = jest.fn()
const mockIpList = jest.fn()
const mockBalTx = jest.fn()
const mockCnList = jest.fn()
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    subscriptions: { create: mockSubCreate, retrieve: mockSubRetrieve, list: mockSubList },
    prices: { list: mockPriceList, retrieve: mockPriceRetrieve },
    paymentMethods: { retrieve: mockPmRetrieve, detach: mockPmDetach },
    coupons: { create: jest.fn(), retrieve: jest.fn(), del: jest.fn() },
    customers: {
      create: (...a: unknown[]) => mockCustomerCreate(...a),
      retrieve: (...a: unknown[]) => mockCustomerRetrieve(...a),
      update: (...a: unknown[]) => mockCustomerUpdate(...a),
      retrieveSource: jest.fn(),
      listBalanceTransactions: (...a: unknown[]) => mockBalTx(...a),
    },
    invoices: { list: (...a: unknown[]) => mockInvList(...a), voidInvoice: jest.fn() },
    invoicePayments: { list: (...a: unknown[]) => mockIpList(...a) },
    creditNotes: { list: (...a: unknown[]) => mockCnList(...a) },
  })),
)
jest.mock('../../../src/config/session', () => {
  const noop = (req: any, _res: any, next: any) => next()
  return { __esModule: true, default: noop }
})
jest.mock('../../../src/config/swagger', () => ({ __esModule: true, setupSwaggerUI: jest.fn() }))
const mockAutorizar = jest.fn()
jest.mock('../../../src/services/access/autorizarObligacionNueva', () => ({
  ...jest.requireActual('../../../src/services/access/autorizarObligacionNueva'),
  autorizarObligacionNueva: (...a: unknown[]) => mockAutorizar(...a),
}))
const mockEntregar = jest.fn()
jest.mock('../../../src/services/stripe.service', () => ({
  ...jest.requireActual('../../../src/services/stripe.service'),
  entregarSuscripcionDePlan: (...a: unknown[]) => mockEntregar(...a),
}))
jest.mock('../../../src/services/onboarding/ensureVenue.service', () => ({
  __esModule: true,
  ensureVenueForOnboarding: jest.fn().mockResolvedValue({ id: 'venue-1', slug: 'negocio-de-prueba', status: 'ONBOARDING' }),
}))
jest.mock('../../../src/services/access/planNotification.service', () => ({
  __esModule: true,
  resolvePlanNotificationTarget: jest.fn().mockResolvedValue({ email: 'duena@example.com', locale: 'es', venueName: 'Negocio' }),
}))
jest.mock('../../../src/services/email.service', () => ({
  __esModule: true,
  default: {
    sendPlanConfirmationEmail: jest.fn().mockResolvedValue(true),
    sendPlanFreeTrialEndingEmail: jest.fn().mockResolvedValue(true),
  },
}))
jest.mock('../../../src/services/resend.service', () => ({
  __esModule: true,
  sendPlanActivatedNotice: jest.fn().mockResolvedValue(true),
  sendOnboardingWelcomeEmail: jest.fn().mockResolvedValue(true),
}))
const mockTerminar = jest.fn()
jest.mock('../../../src/services/onboarding/terminarAltaCobrada', () => ({
  __esModule: true,
  terminarAltaCobrada: (...a: unknown[]) => mockTerminar(...a),
  terminarAltaCobradaSinRomper: jest.fn().mockResolvedValue(undefined),
}))
// «Terminar» rehidrata el negocio provisional (con su `generateUniqueSlug`, que con la base simulada no termina): fuera de esta suite.
jest.mock('../../../src/services/onboarding/venueCreation.service', () => ({
  __esModule: true,
  applyBusinessInfoToVenue: jest.fn().mockResolvedValue(undefined),
  createVenueFromOnboarding: jest.fn(),
}))
jest.mock('../../../src/services/onboarding/sesionTrasElAlta', () => ({
  __esModule: true,
  renovarSesionConLaSucursal: jest.fn().mockResolvedValue(undefined),
}))

import jwt from 'jsonwebtoken'
import request from 'supertest'

import { prismaMock } from '@tests/__helpers__/setup'
import { comprobanteDePrueba, definicionDePrueba, idsDeLaVersion, punteroA } from '@tests/__helpers__/planOfferFixtures'
import type { CotizacionFirmable } from '@/services/billing/comprobanteDeCotizacion'
import * as planOffer from '@/services/billing/planOffer'
import * as planActivationService from '@/services/onboarding/planActivation.service'
import emailService from '@/services/email.service'
import { logAction } from '@/services/dashboard/activity-log.service'

const app = require('../../../src/app').default

const ORG = 'clorgplanoferta0000000001'
const RUTA = `/api/v1/onboarding/organizations/${ORG}/v2/activate-plan`
const DIA = 86_400_000
const PRO_M = 92684 // 79900 + IVA
const PREMIUM_A = 1970840
const FIN_S = Math.floor((Date.now() + 14 * DIA) / 1000)

function token() {
  return jwt.sign({ sub: 'staff_dueno', orgId: ORG, venueId: 'venue-1', role: 'OWNER' }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })
}
const autorizado = { Authorization: `Bearer ${token()}` }
const pedirCon = (cuerpo: object) => request(app).post(RUTA).set(autorizado).send(cuerpo)
const leerProgreso = () => request(app).get(`/api/v1/onboarding/organizations/${ORG}/progress`).set(autorizado)
const leerTarjeta = () => request(app).get(`/api/v1/onboarding/organizations/${ORG}/v2/tarjeta-de-la-prueba`).set(autorizado)
const terminar = () => request(app).post(`/api/v1/onboarding/organizations/${ORG}/v2/complete`).set(autorizado).send({})

/**
 * 🔴 Los 400 de HOY, LITERALES: el estado y el cuerpo que daba la base 94e17b8ae (su `ActivatePlanSchema` con `validateRequest` y el
 * `globalErrorHandler` real) a esos cuerpos, capturados una vez y escritos aquí a mano. No se calculan con el esquema de ahora: si
 * alguien cambia el esquema de hoy, estas pruebas lo notan (fix round 1 de Task 6: la comparación anterior era circular).
 */
/** `STANDARD_SIN_TARJETA` sin `paymentMethodId` (con `expectedFirstChargeCents` 1, o válido con su comprobante). */
const CUERPO_400_SIN_TARJETA = {
  message: 'Error de validación: Falta el dato «paymentMethodId», Tipo no válido. Opciones: LAUNCH, STANDARD',
}
/** `STANDARD` sin `paymentMethodId` (con `payNow` false y un `quoteToken` de texto). */
const CUERPO_400_SIN_METODO = { message: 'Error de validación: Falta el dato «paymentMethodId»' }

type Planes = NonNullable<Parameters<typeof definicionDePrueba>[0]>['planes']
/** La v2: Pro SIN tarjeta 14 días a $799 + IVA; Premium como hoy (con tarjeta, 30 días). */
const v2 = (planes: Planes = {}) =>
  definicionDePrueba({
    ids: idsDeLaVersion('v2'),
    netos: { 'PRO:monthly': 79900 },
    planes: { PRO: { requiresCard: false, trialDays: 14 }, ...planes },
  })
const conVigente = (definition: unknown = v2()) =>
  prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, definition) as never)

/** El comprobante de Pro mensual sin tarjeta de la v2 (14 días desde ahora, $0 hoy). */
const comprobante = (c: Partial<CotizacionFirmable> = {}) => {
  const ahora = new Date()
  return comprobanteDePrueba(
    { alcance: `org:${ORG}`, precioCents: PRO_M, firstChargeCents: 0, trialEndsAt: new Date(ahora.getTime() + 14 * DIA), ...c },
    ahora,
  )
}
const SIN_TARJETA = (quoteToken: unknown = comprobante(), extra: object = {}) => ({
  tier: 'PRO',
  interval: 'monthly',
  payNow: false,
  offer: { kind: 'STANDARD_SIN_TARJETA', expectedFirstChargeCents: 0, quoteToken },
  ...extra,
})

// ---------------------------------------------------------------------------------------------------------------------
// La fila del alta: un falso con estado
// ---------------------------------------------------------------------------------------------------------------------

type Fila = Record<string, any>
let fila: Fila

/** ¿La fila cumple este `where`? Sólo lo que usan los CAS del alta: igualdad, `null`, `not`, `gte`, `lt`, `OR`, `AND`, fechas. */
function cumple(f: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([campo, cond]) => {
    if (campo === 'OR') return (cond as Record<string, unknown>[]).some(w => cumple(f, w))
    if (campo === 'AND') return (cond as Record<string, unknown>[]).every(w => cumple(f, w))
    const valor = f[campo]
    if (cond === null) return valor === null || valor === undefined
    if (cond instanceof Date) return valor instanceof Date && valor.getTime() === cond.getTime()
    if (typeof cond === 'object') {
      const c = cond as Record<string, unknown>
      if ('not' in c) return c.not === null ? valor !== null && valor !== undefined : valor !== c.not
      if ('gte' in c) return typeof valor === 'number' && valor >= (c.gte as number)
      if ('lt' in c) return valor instanceof Date && valor.getTime() < (c.lt as Date).getTime()
      return false
    }
    return valor === cond
  })
}

const altaNueva = (o: Fila = {}): Fila => ({
  id: 'op-1',
  organizationId: ORG,
  currentStep: 9,
  completedSteps: [],
  completedAt: null,
  startedAt: new Date('2026-11-20T00:00:00Z'),
  wizardVersion: 2,
  v2SetupData: { step2: { businessName: 'Negocio de prueba' } },
  launchCampaignId: null,
  termsVersion: null,
  termsAcceptedAt: new Date('2026-11-20T00:00:00Z'),
  planActivationStatus: 'NONE',
  planActivationAttempt: 0,
  planActivationLeaseUntil: null,
  planActivatedAt: null,
  planStripeSubscriptionId: null,
  planOfferVersionNumber: null,
  ...o,
})

const precio = (id: string, unitAmount: number, interval: 'month' | 'year' = 'month') => ({
  id,
  active: true,
  unit_amount: unitAmount,
  currency: 'mxn',
  product: interval === 'year' ? 'prod_premium' : 'prod_pro',
  recurring: { interval, interval_count: 1 },
  tax_behavior: 'inclusive',
})

/** La prueba sin tarjeta que abre el alta (lo que Stripe tiene después del create). */
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
      planActivationKey: `plan-activation:${ORG}:1`,
      planOfferVersion: '2',
      planOfferPrecioDe: '2',
      sinTarjeta: 'true',
      ...metadata,
    },
    discounts: [],
    ...o,
  }
}

const VISA_PREMIUM = { id: 'pm_premium', object: 'payment_method', type: 'card', customer: 'cus_1', card: { brand: 'visa', last4: '4242' } }
const clienteSinTarjeta = () => ({
  id: 'cus_1',
  object: 'customer',
  invoice_settings: { default_payment_method: null },
  default_source: null,
})
const clienteConLaVisa = () => ({ ...clienteSinTarjeta(), invoice_settings: { default_payment_method: 'pm_premium' } })

const sinPendientes = async () => {
  for (let i = 0; i < 5; i++) await new Promise(res => setImmediate(res))
}

beforeEach(() => {
  jest.clearAllMocks()
  fila = altaNueva()
  prismaMock.onboardingProgress.findUnique.mockImplementation((async () => ({ ...fila })) as never)
  prismaMock.onboardingProgress.updateMany.mockImplementation((async ({ where, data }: { where: Fila; data: Fila }) => {
    if (!cumple(fila, where)) return { count: 0 }
    Object.assign(fila, data)
    return { count: 1 }
  }) as never)
  // La fusión de `v2SetupData` (`fusionarV2SetupData`): agrega la sección a lo que la fila ya tiene.
  prismaMock.$executeRaw.mockImplementation((async (strings: TemplateStringsArray, ...valores: unknown[]) => {
    if (strings.join('').includes('"v2SetupData"')) fila.v2SetupData = { ...(fila.v2SetupData ?? {}), ...JSON.parse(String(valores[0])) }
    return 1
  }) as never)
  prismaMock.$transaction.mockImplementation(async (cb: unknown) => (cb as (tx: unknown) => unknown)(prismaMock))
  // Dueño de la organización (el guardia del alta lo pregunta así).
  prismaMock.staffOrganization.findFirst.mockResolvedValue({ id: 'so-1', staffId: 'staff_dueno' } as never)
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.planOfferPointer.findUnique.mockReset().mockResolvedValue(null)
  prismaMock.venue.findUnique.mockResolvedValue({
    id: 'venue-1',
    name: 'Negocio',
    slug: 'negocio-de-prueba',
    email: 'negocio@example.com',
    stripeCustomerId: 'cus_1',
    organization: { email: 'org@example.com', name: 'Org' },
  } as never)
  prismaMock.venue.findFirst.mockResolvedValue({ id: 'venue-1', stripeCustomerId: 'cus_1' } as never)
  prismaMock.venue.findMany.mockResolvedValue([{ id: 'venue-1', stripeCustomerId: 'cus_1' }] as never)
  prismaMock.venue.update.mockResolvedValue({} as never)
  prismaMock.venue.updateMany.mockResolvedValue({ count: 1 } as never)
  prismaMock.hybridPurchase.findUnique.mockResolvedValue(null as never)
  prismaMock.launchCampaignRedemption.findFirst.mockResolvedValue(null as never)
  prismaMock.feature.findFirst.mockResolvedValue({
    id: 'feat-pro',
    code: 'PLAN_PRO',
    monthlyPrice: 999,
    stripeProductId: 'prod_pro',
  } as never)
  prismaMock.venueFeature.findUnique.mockResolvedValue(null as never)
  mockAutorizar.mockReset().mockImplementation(async (_v: string, _c: string, _i: unknown, crear: () => Promise<unknown>) => crear())
  mockEntregar.mockReset().mockImplementation(async ({ subscriptionId }: { subscriptionId: string }) => ({
    venueId: 'venue-1',
    featureId: 'feat-pro',
    featureCode: 'PLAN_PRO',
    subscriptionId,
    endDate: null,
  }))
  mockPriceList.mockReset().mockResolvedValue({ data: [{ id: 'price_llave_pro_m', unit_amount: 115884 }] })
  mockPriceRetrieve.mockReset().mockImplementation(async (id: string) => {
    if (id === 'price_v2_pro_m') return precio('price_v2_pro_m', PRO_M)
    throw Object.assign(new Error('No such price'), { code: 'resource_missing', statusCode: 404 })
  })
  mockPmRetrieve.mockReset().mockImplementation(async (id: string) => {
    if (id === 'pm_premium') return VISA_PREMIUM
    if (id === 'pm_1')
      return {
        id: 'pm_1',
        object: 'payment_method',
        type: 'card',
        customer: 'cus_1',
        card: { fingerprint: 'fp_1', brand: 'visa', last4: '1111' },
      }
    throw Object.assign(new Error('No such payment_method'), { code: 'resource_missing', statusCode: 404 })
  })
  mockPmDetach.mockReset()
  mockCustomerCreate.mockReset().mockResolvedValue({ id: 'cus_nuevo', object: 'customer' })
  mockCustomerRetrieve.mockReset().mockResolvedValue(clienteSinTarjeta())
  mockCustomerUpdate.mockReset().mockResolvedValue({ id: 'cus_1' })
  mockSubCreate.mockReset().mockResolvedValue({ id: 'sub_1', status: 'trialing' })
  mockSubRetrieve.mockReset().mockResolvedValue(prueba())
  mockSubList.mockReset().mockReturnValue({ autoPagingEach: async () => undefined })
  mockInvList.mockReset().mockResolvedValue({ has_more: false, data: [{ id: 'in_0', status: 'paid', total: 0, amount_paid: 0 }] })
  mockIpList.mockReset()
  mockBalTx.mockReset().mockResolvedValue({ has_more: false, data: [] })
  mockCnList.mockReset().mockResolvedValue({ has_more: false, data: [] })
  mockTerminar.mockReset().mockImplementation(async () => {
    // El cierre final (con su suite): termina el alta si el plan quedó resuelto.
    if (fila.planActivationStatus !== 'ACTIVE') return { estado: 'NADA', motivo: 'PLAN_NO_CONFIRMADO' }
    const ya = !!fila.completedAt
    fila.completedAt = fila.completedAt ?? new Date()
    return {
      estado: ya ? 'YA_TERMINADA' : 'TERMINADA',
      venue: { id: 'venue-1', slug: 'negocio-de-prueba', name: 'Negocio', status: 'ACTIVE' },
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// La validación: STANDARD_SIN_TARJETA sólo existe con una versión del editor
// ---------------------------------------------------------------------------------------------------------------------

describe('POST …/v2/activate-plan — la validación del alta sin tarjeta', () => {
  it('🔴 b2-r6, regresión (el caso de Codex): sin versión del editor, STANDARD_SIN_TARJETA con expectedFirstChargeCents 1 y sin paymentMethodId → el mismo 400 y el mismo cuerpo de error que hoy (comparado con la respuesta del esquema de hoy)', async () => {
    const cuerpo = { tier: 'PRO', interval: 'monthly', payNow: false, offer: { kind: 'STANDARD_SIN_TARJETA', expectedFirstChargeCents: 1 } }

    const res = await pedirCon(cuerpo)

    // El 400 de hoy, literal (capturado de la base 94e17b8ae): mismo estado y mismo cuerpo.
    expect(res.status).toBe(400)
    expect(res.body).toStrictEqual(CUERPO_400_SIN_TARJETA)
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(mockAutorizar).not.toHaveBeenCalled()
    // Un cuerpo VÁLIDO de la rama nueva, sin versión del editor: también el 400 de hoy.
    const valido = await pedirCon(SIN_TARJETA())
    expect(valido.status).toBe(400)
    expect(valido.body).toStrictEqual(CUERPO_400_SIN_TARJETA)
  })

  it('🔴 b2-r7 #7: versionQueCobra() lanza un error → el mismo cuerpo STANDARD_SIN_TARJETA inválido recibe el 400 de hoy, nunca un 5xx; un cuerpo válido de hoy ni siquiera consulta la versión', async () => {
    const espia = jest.spyOn(planOffer, 'versionQueCobra')
    try {
      espia.mockRejectedValue(new Error('el puntero no se pudo leer'))
      const cuerpo = SIN_TARJETA()

      const res = await pedirCon(cuerpo)

      expect(res.status).toBe(400)
      expect(res.body).toStrictEqual(CUERPO_400_SIN_TARJETA)
      expect(espia).toHaveBeenCalledTimes(1)

      // Un cuerpo válido de hoy (con tarjeta, sin versiones): la validación no consulta la versión; sólo el servicio (PASO 3).
      espia.mockReset().mockResolvedValue(null)
      const deHoy = {
        tier: 'PRO',
        interval: 'monthly',
        payNow: false,
        paymentMethodId: 'pm_1',
        offer: { kind: 'STANDARD', expectedFirstChargeCents: 0 },
      }
      const ok = await pedirCon(deHoy)
      expect(ok.status).toBe(200)
      expect(espia).toHaveBeenCalledTimes(1)
    } finally {
      espia.mockRestore()
    }
  })

  it('🔴 b2-r5 regresión: sin versión del editor, un cuerpo STANDARD sin paymentMethodId con payNow false y quoteToken de texto → el 400 de hoy; con la v2, el mismo 400', async () => {
    const cuerpo = {
      tier: 'PRO',
      interval: 'monthly',
      payNow: false,
      offer: { kind: 'STANDARD', expectedFirstChargeCents: 0, quoteToken: 'hola' },
    }
    const sinVersion = await pedirCon(cuerpo)
    conVigente()
    const conV2 = await pedirCon(cuerpo)

    expect(sinVersion.status).toBe(400)
    expect(sinVersion.body).toStrictEqual(CUERPO_400_SIN_METODO)
    expect(conV2.status).toBe(400)
    expect(conV2.body).toStrictEqual(CUERPO_400_SIN_METODO)
    expect(mockSubCreate).not.toHaveBeenCalled()
  })

  it('STANDARD_SIN_TARJETA con paymentMethodId o con payNow true → 400 y el servicio no corre', async () => {
    conVigente()
    const espia = jest.spyOn(planActivationService, 'activatePlan')
    try {
      const conMetodo = await pedirCon(SIN_TARJETA(comprobante(), { paymentMethodId: 'pm_1' }))
      const pagaHoy = await pedirCon(SIN_TARJETA(comprobante(), { payNow: true }))

      expect(conMetodo.status).toBe(400)
      expect(pagaHoy.status).toBe(400)
      expect(espia).not.toHaveBeenCalled()
      expect(mockSubCreate).not.toHaveBeenCalled()
    } finally {
      espia.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// La prueba sin tarjeta, con la v2
// ---------------------------------------------------------------------------------------------------------------------

describe('POST …/v2/activate-plan — la prueba sin tarjeta con la v2', () => {
  beforeEach(() => conVigente())

  it('🔴 con la v2, POST STANDARD_SIN_TARJETA con su quoteToken → 200 { sinTarjeta: true, tarjetaQueCobrara: null } y una sola subscriptions.create sin método de pago, al precio de la v2', async () => {
    const res = await pedirCon(SIN_TARJETA())

    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({
      status: 'ACTIVE',
      alreadyActive: false,
      tier: 'PRO',
      interval: 'monthly',
      firstChargeCents: 0,
      sinTarjeta: true,
      tarjetaQueCobrara: null,
      noHabraCobro: false,
      trialEndsAt: new Date(FIN_S * 1000).toISOString(),
    })
    expect(mockSubCreate).toHaveBeenCalledTimes(1)
    const [cuerpo] = mockSubCreate.mock.calls[0] as [Record<string, any>]
    expect('default_payment_method' in cuerpo).toBe(false)
    expect(cuerpo.items).toEqual([{ price: 'price_v2_pro_m' }])
    expect(cuerpo.metadata).toMatchObject({ sinTarjeta: 'true', planOfferVersion: '2' })
    expect(mockPmRetrieve).not.toHaveBeenCalled()
    // El alta quedó ACTIVE con su plan sin tarjeta (lo que lee `parseV2Plan`).
    expect(fila).toMatchObject({ planActivationStatus: 'ACTIVE', planStripeSubscriptionId: 'sub_1', planOfferVersionNumber: 2 })
    expect(fila.v2SetupData.plan).toMatchObject({ sinTarjeta: true, paymentMethodId: null, payNow: false, offerVersion: 2 })
  })

  it('🔴 §18: el cliente tiene la tarjeta que guardó para Premium; GET v2/tarjeta-de-la-prueba la enseña; POST → 200 con tarjetaQueCobrara ••••4242; ningún paymentMethods.detach y la predeterminada del cliente no cambia (b2-r8: customers.update sólo con la descripción de hoy, stripe.service.ts:79)', async () => {
    mockCustomerRetrieve.mockResolvedValue(clienteConLaVisa())

    const ventana = await leerTarjeta()
    expect(ventana.status).toBe(200)
    expect(ventana.body.data).toEqual({ tarjeta: { id: 'pm_premium', brand: 'visa', last4: '4242' } })

    const res = await pedirCon(SIN_TARJETA())

    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ sinTarjeta: true, tarjetaQueCobrara: { brand: 'visa', last4: '4242' } })
    expect(mockPmDetach).not.toHaveBeenCalled()
    // La única escritura sobre el cliente es la descripción de hoy (`getOrCreateStripeCustomer`): nunca su predeterminada.
    expect(mockCustomerUpdate).toHaveBeenCalledTimes(1)
    const [, cambios] = mockCustomerUpdate.mock.calls[0] as [string, Record<string, unknown>]
    expect(Object.keys(cambios).sort()).toEqual(['description', 'metadata'])
    expect('default_payment_method' in (mockSubCreate.mock.calls[0][0] as object)).toBe(false)
  })

  it('🔴 b2-r7 #1 / b2-r8: GET progress sin tarjeta; el aviso fija la tarjeta de Premium; GET v2/tarjeta-de-la-prueba (al abrir la ventana) ya la trae; el POST cobra con ella sin comparar nada', async () => {
    const progreso = await leerProgreso()
    expect(progreso.status).toBe(200)
    const opcion = progreso.body.progress.planQuote.oferta.planes.PRO.monthly
    expect(opcion).toMatchObject({ firstChargeCents: 0, precioCents: PRO_M })
    expect(progreso.body.progress.planActivation).not.toHaveProperty('tarjetaQueCobrara')
    expect((await leerTarjeta()).body.data).toEqual({ tarjeta: null })

    // `payment_method.attached` (otra pestaña, para Premium) fija la Visa como predeterminada del cliente.
    mockCustomerRetrieve.mockResolvedValue(clienteConLaVisa())
    expect((await leerTarjeta()).body.data).toEqual({ tarjeta: { id: 'pm_premium', brand: 'visa', last4: '4242' } })

    // El POST manda el MISMO comprobante, sin la tarjeta: nada se compara; la prueba se abre y Stripe cobrará la predeterminada.
    const res = await pedirCon(SIN_TARJETA(opcion.quoteToken))

    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ sinTarjeta: true, tarjetaQueCobrara: { brand: 'visa', last4: '4242' } })
    expect(mockSubCreate).toHaveBeenCalledTimes(1)
    expect('default_payment_method' in (mockSubCreate.mock.calls[0][0] as object)).toBe(false)
  })

  it('🔴 b2-r8 #9 (el caso de Codex): la prueba se abre sin método y con la tarjeta del cliente; se pierde el primer 200; el reintento (alreadyActive) y GET progress traen tarjetaQueCobrara ••••4242', async () => {
    mockCustomerRetrieve.mockResolvedValue(clienteConLaVisa())
    const primero = await pedirCon(SIN_TARJETA())
    expect(primero.status).toBe(200)

    // El navegador nunca vio ese 200: reintenta con el mismo cuerpo, y recarga.
    const reintento = await pedirCon(SIN_TARJETA())
    const progreso = await leerProgreso()

    expect(reintento.status).toBe(200)
    expect(reintento.body.data).toMatchObject({
      alreadyActive: true,
      sinTarjeta: true,
      tarjetaQueCobrara: { brand: 'visa', last4: '4242' },
      noHabraCobro: false,
    })
    expect(progreso.status).toBe(200)
    expect(progreso.body.progress.planActivation).toMatchObject({
      status: 'ACTIVE',
      sinTarjeta: true,
      tarjetaQueCobrara: { brand: 'visa', last4: '4242' },
      noHabraCobro: false,
    })
    expect(mockSubCreate).toHaveBeenCalledTimes(1)
  })

  it('🔴 b2-r9 #7 (el caso de Codex): la misma prueba con la Visa del cliente y la cancelación ya programada (cancel_at_period_end) → el reintento (alreadyActive) y GET progress traen noHabraCobro true y trialModality ENDS_FREE', async () => {
    mockCustomerRetrieve.mockResolvedValue(clienteConLaVisa())
    expect((await pedirCon(SIN_TARJETA())).status).toBe(200)
    // La dueña programó la cancelación en «Tu plan».
    mockSubRetrieve.mockResolvedValue(prueba({ cancel_at_period_end: true }))

    const reintento = await pedirCon(SIN_TARJETA())
    const progreso = await leerProgreso()

    expect(reintento.body.data).toMatchObject({ alreadyActive: true, noHabraCobro: true, trialModality: 'ENDS_FREE', sinTarjeta: true })
    expect(progreso.body.progress.planActivation).toMatchObject({ noHabraCobro: true, trialModality: 'ENDS_FREE', sinTarjeta: true })
  })

  it('🔴 b2-r9 #4 (el caso de Codex): el negocio guarda el id de un cliente que Stripe ya borró (deleted: true; y otra vez con «No such customer») → POST STANDARD_SIN_TARJETA → 200: Venue.stripeCustomerId pasa al cliente nuevo de customers.create y la suscripción se abre en ése; ningún create con el id borrado', async () => {
    for (const borrado of [
      async () => ({ id: 'cus_1', object: 'customer', deleted: true }),
      async () => {
        throw Object.assign(new Error('No such customer: cus_1'), {
          type: 'StripeInvalidRequestError',
          statusCode: 404,
          code: 'resource_missing',
        })
      },
    ]) {
      jest.clearAllMocks()
      fila = altaNueva()
      // El negocio: con el id borrado hasta que el alta lo suelta; después, sin cliente (y `getOrCreateStripeCustomer` crea otro).
      let clienteDelNegocio: string | null = 'cus_1'
      prismaMock.venue.findUnique.mockImplementation((async () => ({
        id: 'venue-1',
        name: 'Negocio',
        slug: 'negocio-de-prueba',
        email: 'negocio@example.com',
        stripeCustomerId: clienteDelNegocio,
        organization: { email: 'org@example.com', name: 'Org' },
      })) as never)
      prismaMock.venue.updateMany.mockImplementation((async ({ where, data }: { where: Fila; data: Fila }) => {
        if (where.stripeCustomerId !== clienteDelNegocio) return { count: 0 }
        clienteDelNegocio = data.stripeCustomerId
        return { count: 1 }
      }) as never)
      prismaMock.venue.update.mockImplementation((async ({ data }: { data: Fila }) => {
        if ('stripeCustomerId' in data) clienteDelNegocio = data.stripeCustomerId
        return {}
      }) as never)
      mockCustomerRetrieve.mockImplementation(async (id: string) => (id === 'cus_1' ? borrado() : { ...clienteSinTarjeta(), id }))
      mockSubRetrieve.mockResolvedValue(prueba({ customer: 'cus_nuevo' }))

      const res = await pedirCon(SIN_TARJETA())

      expect(res.status).toBe(200)
      expect(prismaMock.venue.updateMany).toHaveBeenCalledWith({
        where: { id: 'venue-1', stripeCustomerId: 'cus_1' },
        data: { stripeCustomerId: null },
      })
      expect(mockCustomerCreate).toHaveBeenCalledTimes(1)
      expect(clienteDelNegocio).toBe('cus_nuevo')
      // Queda en la bitácora del negocio: qué cliente borrado se soltó (`logAction` está simulado en las pruebas: la llamada).
      expect(jest.mocked(logAction)).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'STRIPE_CUSTOMER_RELEASED_DELETED',
          venueId: 'venue-1',
          entityId: 'venue-1',
          data: { customerId: 'cus_1' },
        }),
      )
      expect(mockSubCreate).toHaveBeenCalledTimes(1)
      expect((mockSubCreate.mock.calls[0][0] as { customer: string }).customer).toBe('cus_nuevo')
    }
  })

  it('🔴 b2-r9 #4, con tarjeta: el cliente guardado ya no existe en Stripe → se suelta y se crea otro, y la tarjeta del cliente borrado no es de éste: el 400 de hoy (PAYMENT_METHOD_MISMATCH), sin cobrar', async () => {
    // La v2 con Pro CON tarjeta (30 días): el alta de siempre, con su comprobante.
    conVigente(v2({ PRO: { requiresCard: true, trialDays: 30 } }))
    const emitido = new Date()
    const quoteToken = comprobanteDePrueba(
      { alcance: `org:${ORG}`, precioCents: PRO_M, firstChargeCents: 0, trialEndsAt: new Date(emitido.getTime() + 30 * DIA) },
      emitido,
    )
    let clienteDelNegocio: string | null = 'cus_1'
    prismaMock.venue.findUnique.mockImplementation((async () => ({
      id: 'venue-1',
      name: 'Negocio',
      slug: 'negocio-de-prueba',
      email: 'negocio@example.com',
      stripeCustomerId: clienteDelNegocio,
      organization: { email: 'org@example.com', name: 'Org' },
    })) as never)
    prismaMock.venue.updateMany.mockImplementation((async ({ where, data }: { where: Fila; data: Fila }) => {
      if (where.stripeCustomerId !== clienteDelNegocio) return { count: 0 }
      clienteDelNegocio = data.stripeCustomerId
      return { count: 1 }
    }) as never)
    mockCustomerRetrieve.mockImplementation(async (id: string) =>
      id === 'cus_1' ? { id: 'cus_1', object: 'customer', deleted: true } : { ...clienteSinTarjeta(), id },
    )

    // `pm_1` es del cliente borrado (`cus_1`), no del nuevo.
    const res = await pedirCon({
      tier: 'PRO',
      interval: 'monthly',
      payNow: false,
      paymentMethodId: 'pm_1',
      offer: { kind: 'STANDARD', expectedFirstChargeCents: 0, quoteToken },
    })

    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ code: 'PAYMENT_METHOD_MISMATCH', message: 'Ese método de pago no pertenece a este negocio' })
    expect(clienteDelNegocio).toBe('cus_nuevo')
    expect(mockPmRetrieve).toHaveBeenCalledWith('pm_1')
    // Sin cobrar: ni la regla común ni Stripe, y el alta sin lease (el 400 sale antes del PASO 5).
    expect(mockAutorizar).not.toHaveBeenCalled()
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(fila).toMatchObject({ planActivationStatus: 'NONE', planActivationLeaseUntil: null })
  })

  it('🔴 fix round 1 (Important #1): GET progress lee la suscripción UNA vez con su tope; si la tarjeta no se puede leer (tiempo agotado), progress conserva trialModality, trialEndsAt y sinTarjeta y sólo omite tarjetaQueCobrara', async () => {
    fila = altaNueva({ planActivationStatus: 'ACTIVE', planActivationAttempt: 1, planStripeSubscriptionId: 'sub_1' })
    mockCustomerRetrieve.mockRejectedValue(
      Object.assign(new Error('Request aborted due to timeout being reached (5000ms)'), { type: 'StripeConnectionError' }),
    )

    const progreso = await leerProgreso()

    expect(progreso.status).toBe(200)
    const activacion = progreso.body.progress.planActivation
    expect(activacion).toMatchObject({
      status: 'ACTIVE',
      sinTarjeta: true,
      trialModality: 'RENEWS_AS_PRO',
      trialEndsAt: new Date(FIN_S * 1000).toISOString(),
      noHabraCobro: false,
    })
    // «No se sabe qué tarjeta»: el campo no viaja (decir `null` diría «sin tarjeta», que puede ser falso).
    expect(activacion).not.toHaveProperty('tarjetaQueCobrara')
    // Una sola lectura de la suscripción, y cada lectura de Stripe con el tope de 5 s y sin reintentos.
    const TOPE = { timeout: 5_000, maxNetworkRetries: 0 }
    expect(mockSubRetrieve.mock.calls).toEqual([['sub_1', {}, TOPE]])
    expect(mockCustomerRetrieve).toHaveBeenCalledWith('cus_1', expect.anything(), TOPE)
  })

  describe('«Terminar» (POST v2/complete) ANTES de que el alta se cierre en Gratis (fix round 1, menor 7)', () => {
    /** La prueba sin tarjeta del intento 1, ya cancelada por Stripe al terminar y sin cobrar; el alta todavía IN_PROGRESS. */
    const altaConLaPruebaTerminada = (plan: object | undefined) => {
      fila = altaNueva({
        v2SetupData: { step2: { businessName: 'Negocio de prueba' }, ...(plan ? { plan } : {}) },
        planActivationStatus: 'IN_PROGRESS',
        planActivationAttempt: 1,
        planActivationLeaseUntil: new Date(Date.now() - 60_000),
        planStripeSubscriptionId: 'sub_1',
        planOfferVersionNumber: 2,
      })
      mockSubRetrieve.mockResolvedValue(prueba({ status: 'canceled', ended_at: FIN_S }))
      // Lo vivo del negocio (lo que revisa `hayCobroDelAltaSinCerrar` después de la llave): nada.
      prismaMock.venueFeature.findMany.mockResolvedValue([])
      prismaMock.billingObligationConflict.findMany.mockResolvedValue([])
      prismaMock.feature.findMany.mockResolvedValue([] as never)
    }

    it('con el plan FREE guardado en el asistente: la prueba terminada ya no cuenta como cobro abierto y «Terminar» cierra el alta en Gratis por el carril de hoy, pero deja planActivationStatus IN_PROGRESS con el id de la suscripción cancelada; nadie lo vuelve a tocar (el barrido y activate-plan lo dejan como está)', async () => {
      altaConLaPruebaTerminada({
        tier: 'FREE',
        paymentMethodId: null,
        interval: 'monthly',
        payNow: false,
        acceptedAt: '2026-11-25T00:00:00.000Z',
      })

      const fin = await terminar()

      expect(fin.status).toBe(201)
      expect(fin.body.code).not.toBe('PLAN_CHARGE_PENDING')
      // 🔴 El estado que queda (lo describe el reporte): terminada, pero con el intento «en curso» para siempre.
      expect(fila.completedAt).toBeInstanceOf(Date)
      expect(fila).toMatchObject({ planActivationStatus: 'IN_PROGRESS', planStripeSubscriptionId: 'sub_1', planActivationAttempt: 1 })
      expect(fila.v2SetupData.plan).toMatchObject({ tier: 'FREE' })
      expect(fila.v2SetupData.plan).not.toHaveProperty('pruebaSinTarjetaTerminada')
      expect(mockSubCreate).not.toHaveBeenCalled()

      // El barrido ya no la ve (terminada) y activate-plan contesta «ya terminó»: ninguno la pasa a ACTIVE ni cobra.
      await expect(planActivationService.cerrarAltaSinNavegador(ORG)).resolves.toBe('NADA')
      const otraVez = await pedirCon(SIN_TARJETA())
      expect(otraVez.status).toBe(409)
      expect(otraVez.body.code).toBe('ONBOARDING_ALREADY_COMPLETED')
      expect(fila.planActivationStatus).toBe('IN_PROGRESS')
      expect(mockSubCreate).not.toHaveBeenCalled()
    })

    it('sin plan guardado en el asistente: «Terminar» responde el 400 de hoy sin tocar nada, y el barrido después cierra el alta en Gratis', async () => {
      altaConLaPruebaTerminada(undefined)

      const fin = await terminar()

      expect(fin.status).toBe(400)
      expect(fila).toMatchObject({ completedAt: null, planActivationStatus: 'IN_PROGRESS', planStripeSubscriptionId: 'sub_1' })

      await expect(planActivationService.cerrarAltaSinNavegador(ORG)).resolves.toBe('CERRADA')
      expect(fila).toMatchObject({ planActivationStatus: 'ACTIVE', planStripeSubscriptionId: null })
      expect(fila.v2SetupData.plan).toMatchObject({ tier: 'FREE', pruebaSinTarjetaTerminada: true, subscriptionId: 'sub_1' })
      expect(mockTerminar).toHaveBeenCalledWith(ORG, expect.objectContaining({ via: 'barrido' }))
    })
  })

  it('🔴 b2-r3 #3: la persona vuelve con el alta IN_PROGRESS y su prueba sin tarjeta ya cancelada → POST → 409 PLAN_TRIAL_ENDED; GET progress → completedAt y plan FREE; POST v2/complete → el «ya terminada» de hoy, sin PLAN_CHARGE_PENDING', async () => {
    fila = altaNueva({
      planActivationStatus: 'IN_PROGRESS',
      planActivationAttempt: 1,
      planActivationLeaseUntil: new Date(Date.now() - 60_000),
      planStripeSubscriptionId: 'sub_1',
      planOfferVersionNumber: 2,
    })
    mockSubRetrieve.mockResolvedValue(prueba({ status: 'canceled', ended_at: FIN_S }))

    const res = await pedirCon(SIN_TARJETA())

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({
      code: 'PLAN_TRIAL_ENDED',
      message: 'Tu prueba terminó sin tarjeta y tu negocio quedó en Gratis. No se te cobró nada.',
    })
    expect(mockSubCreate).not.toHaveBeenCalled()

    const progreso = await leerProgreso()
    expect(progreso.status).toBe(200)
    expect(progreso.body.progress.completedAt).not.toBeNull()
    expect(progreso.body.progress.v2SetupData.plan).toMatchObject({
      tier: 'FREE',
      pruebaSinTarjetaTerminada: true,
      subscriptionId: 'sub_1',
    })
    expect(progreso.body.progress.planActivation.status).toBe('ACTIVE')

    const fin = await terminar()
    expect(fin.status).toBe(200)
    expect(fin.body).toMatchObject({ success: true, message: 'Setup already completed' })
    expect(fin.body.code).not.toBe('PLAN_CHARGE_PENDING')
  })

  it('🔴 b2-r7 #6 (el caso de Codex): un pago real de Premium anual quedó sin cerrar; vuelve con un cuerpo STANDARD_SIN_TARJETA de Pro → 200 ACTIVE como Premium anual pagado: el plan guardado dice payNow true, sinTarjeta false, su método y la versión de su metadata, y sale la confirmación de pago, no la bienvenida sin tarjeta', async () => {
    fila = altaNueva({
      planActivationStatus: 'IN_PROGRESS',
      planActivationAttempt: 1,
      planActivationLeaseUntil: new Date(Date.now() - 60_000),
      planStripeSubscriptionId: 'sub_premium',
      planOfferVersionNumber: 2,
    })
    const premiumPagado = {
      id: 'sub_premium',
      status: 'active',
      customer: 'cus_1',
      default_payment_method: 'pm_premium',
      cancel_at_period_end: false,
      current_period_end: Math.floor((Date.now() + 365 * DIA) / 1000),
      trial_end: null,
      latest_invoice: { id: 'in_1', status: 'paid', amount_paid: PREMIUM_A },
      items: { data: [{ price: precio('price_v2_premium_a', PREMIUM_A, 'year') }] },
      metadata: {
        organizationId: ORG,
        featureCode: 'PLAN_PREMIUM',
        planActivationKey: `plan-activation:${ORG}:1`,
        planOfferVersion: '2',
        planOfferPrecioDe: '2',
      },
      discounts: [],
    }
    mockSubRetrieve.mockResolvedValue(premiumPagado)
    mockEntregar.mockImplementation(async ({ subscriptionId }: { subscriptionId: string }) => ({
      venueId: 'venue-1',
      featureId: 'feat-premium',
      featureCode: 'PLAN_PREMIUM',
      subscriptionId,
      endDate: null,
    }))

    const res = await pedirCon(SIN_TARJETA())
    await sinPendientes()

    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ status: 'ACTIVE', tier: 'PREMIUM', interval: 'annual' })
    expect(res.body.data).not.toHaveProperty('sinTarjeta')
    expect(fila.v2SetupData.plan).toMatchObject({
      tier: 'PREMIUM',
      interval: 'annual',
      payNow: true,
      sinTarjeta: false,
      paymentMethodId: 'pm_premium',
      offerVersion: 2,
    })
    expect(mockSubCreate).not.toHaveBeenCalled()
    expect(emailService.sendPlanConfirmationEmail).toHaveBeenCalledTimes(1)
    expect(emailService.sendPlanFreeTrialEndingEmail).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// La nota del saldo: el monto que se firma es el precio; el saldo lo aplica Stripe en el recibo
// ---------------------------------------------------------------------------------------------------------------------

describe('POST …/v2/activate-plan — el saldo del cliente en Stripe (b2-r8)', () => {
  it('🔴 b2-r8 #1 (el caso de Codex): un cliente con $50 de saldo deudor y un alta de 0 días con 3DS: el reto espera primerCobroEsperadoCents 92684 (el precio, como hoy); Stripe cobra 976.84 (total 926.84); tras autorizar, el barrido cierra el alta ACTIVE y liga el acceso', async () => {
    // La v2 con Pro CON tarjeta y de 0 días: se paga hoy el precio de la versión.
    conVigente(v2({ PRO: { requiresCard: true, trialDays: 0 } }))
    const reto = Object.assign(new Error('Payment for this subscription requires additional user action…'), {
      type: 'StripeCardError',
      code: 'subscription_payment_intent_requires_action',
      statusCode: 402,
    })
    mockSubCreate
      .mockReset()
      .mockRejectedValueOnce(reto)
      .mockResolvedValueOnce({
        id: 'sub_3ds',
        status: 'incomplete',
        latest_invoice: { id: 'in_3ds', status: 'open', confirmation_secret: { type: 'payment_intent', client_secret: 'pi_3ds_secret_x' } },
      })

    const res = await pedirCon({
      tier: 'PRO',
      interval: 'monthly',
      payNow: true,
      paymentMethodId: 'pm_1',
      offer: { kind: 'STANDARD', expectedFirstChargeCents: PRO_M, quoteToken: comprobante({ firstChargeCents: PRO_M, trialEndsAt: null }) },
    })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PLAN_PAYMENT_REQUIRES_ACTION')
    const [segundo] = mockSubCreate.mock.calls[1] as [{ metadata: Record<string, string> }]
    expect(segundo.metadata.primerCobroEsperadoCents).toBe(String(PRO_M))

    // La dueña autoriza y cierra la pestaña. Stripe cobró el precio MÁS el saldo deudor: total 926.84, pagado 976.84.
    const pagada = {
      id: 'sub_3ds',
      status: 'active',
      customer: 'cus_1',
      default_payment_method: 'pm_1',
      current_period_end: Math.floor((Date.now() + 30 * DIA) / 1000),
      trial_end: null,
      latest_invoice: { id: 'in_3ds', status: 'paid', amount_paid: 97684 },
      items: { data: [{ price: precio('price_v2_pro_m', PRO_M) }] },
      metadata: { ...segundo.metadata },
      discounts: [],
    }
    mockSubRetrieve.mockResolvedValue(pagada)
    mockInvList.mockResolvedValue({
      has_more: false,
      data: [
        {
          id: 'in_3ds',
          customer: 'cus_1',
          currency: 'mxn',
          billing_reason: 'subscription_create',
          status: 'paid',
          total: PRO_M,
          amount_paid: 97684,
          starting_balance: 5000,
          ending_balance: 0,
          post_payment_credit_notes_amount: 0,
          total_discount_amounts: [],
        },
      ],
    })
    mockIpList.mockResolvedValue({
      has_more: false,
      data: [
        {
          status: 'paid',
          currency: 'mxn',
          amount_paid: 97684,
          payment: {
            type: 'charge',
            charge: { id: 'ch_1', paid: true, currency: 'mxn', amount: 97684, amount_refunded: 0, disputed: false },
          },
        },
      ],
    })
    fila.planActivationLeaseUntil = null

    await expect(planActivationService.cerrarAltaSinNavegador(ORG)).resolves.toBe('CERRADA')

    expect(fila).toMatchObject({ planActivationStatus: 'ACTIVE', planStripeSubscriptionId: 'sub_3ds' })
    expect(mockEntregar).toHaveBeenCalledWith(expect.objectContaining({ subscriptionId: 'sub_3ds' }))
    expect(mockSubCreate).toHaveBeenCalledTimes(2)
  })
})
