/*
  Planes editables B2, Task 5 (b2-r9 #2): «Confirmar mi pago» retoma el reto del banco aunque la oferta vigente ya no tenga
  opciones.

  POST /api/v1/onboarding/organizations/:organizationId/v2/retomar-pago   (sin cuerpo)
    → { data: { estado: 'RETO', clientSecret } | { estado: 'CERRADA' } | { estado: 'NADA' } }

  🔴 Lo que fija:
  - el intento IN_PROGRESS sin lease vivo y su suscripción (por su id o, si falta y el intento es de una versión del editor, por
    su llave) deciden; nunca el comprobante ni la oferta vigente;
  - con el pago esperando al banco devuelve EL MISMO reto (el secreto de su factura), sin pedir otra tarjeta;
  - cobrada o en prueba, cierra el alta como el barrido; cualquier otra cosa es NADA;
  - nunca cobra, nunca anula ni crea nada en Stripe, y el secreto no va a ningún log;
  - sólo la dueña de la organización (como `activate-plan`).

  Arranca el Express real: authenticateToken → requireOnboardingOrgOwner → controlador → servicio. Stripe, la entrega del
  acceso, la evidencia del primer cobro (probada en su suite) y los avisos se simulan como en `activate-plan.oferta.api.test.ts`.
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
const mockSubCancel = jest.fn()
const mockSubUpdate = jest.fn()
const mockPriceList = jest.fn()
const mockPriceRetrieve = jest.fn()
const mockIpList = jest.fn()
const mockVoid = jest.fn()
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    subscriptions: { create: mockSubCreate, retrieve: mockSubRetrieve, list: mockSubList, cancel: mockSubCancel, update: mockSubUpdate },
    prices: { list: mockPriceList, retrieve: mockPriceRetrieve },
    paymentMethods: { retrieve: jest.fn() },
    coupons: { create: jest.fn(), retrieve: jest.fn(), del: jest.fn() },
    customers: { create: jest.fn(), retrieve: jest.fn(), listBalanceTransactions: jest.fn() },
    invoices: { list: jest.fn(), voidInvoice: mockVoid },
    invoicePayments: { list: (...a: unknown[]) => mockIpList(...a) },
    creditNotes: { list: jest.fn() },
  })),
)
jest.mock('../../../src/config/session', () => {
  const noop = (req: any, _res: any, next: any) => next()
  return { __esModule: true, default: noop }
})
jest.mock('../../../src/config/swagger', () => ({ __esModule: true, setupSwaggerUI: jest.fn() }))
const mockEntregar = jest.fn()
jest.mock('../../../src/services/stripe.service', () => ({
  ...jest.requireActual('../../../src/services/stripe.service'),
  entregarSuscripcionDePlan: (...a: unknown[]) => mockEntregar(...a),
}))
jest.mock('../../../src/services/onboarding/primerCobroPagado', () => ({ primerCobroCubierto: jest.fn().mockResolvedValue(true) }))
jest.mock('../../../src/services/onboarding/ensureVenue.service', () => ({
  __esModule: true,
  ensureVenueForOnboarding: jest.fn().mockResolvedValue({ id: 'venue-1', slug: 'negocio-de-prueba', status: 'ONBOARDING' }),
}))
jest.mock('../../../src/services/access/planNotification.service', () => ({
  __esModule: true,
  resolvePlanNotificationTarget: jest.fn().mockResolvedValue({ email: null, locale: 'es', venueName: 'Negocio' }),
}))
jest.mock('../../../src/services/email.service', () => ({
  __esModule: true,
  default: { sendPlanConfirmationEmail: jest.fn().mockResolvedValue(true) },
}))
jest.mock('../../../src/services/resend.service', () => ({
  __esModule: true,
  sendPlanActivatedNotice: jest.fn().mockResolvedValue(true),
  sendOnboardingWelcomeEmail: jest.fn().mockResolvedValue(true),
}))
jest.mock('../../../src/services/onboarding/terminarAltaCobrada', () => ({
  __esModule: true,
  terminarAltaCobradaSinRomper: jest.fn().mockResolvedValue(undefined),
}))

import { inspect } from 'util'
import jwt from 'jsonwebtoken'
import request from 'supertest'

import logger from '@/config/logger'
import { prismaMock } from '@tests/__helpers__/setup'
import { definicionDePrueba, idsDeLaVersion, punteroA } from '@tests/__helpers__/planOfferFixtures'

const app = require('../../../src/app').default

const ORG = 'clorgretomarpago000000001'
const RUTA = `/api/v1/onboarding/organizations/${ORG}/v2/retomar-pago`
const LLAVE = `plan-activation:${ORG}:1`
const PREMIUM_M = 197084
const SECRETO = 'pi_reto_secret_premium'
const FIN = Math.floor(new Date('2026-12-25T00:00:00Z').getTime() / 1000)

function token() {
  return jwt.sign({ sub: 'staff_dueno', orgId: ORG, venueId: 'venue-1', role: 'OWNER' }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })
}
const retomar = () => request(app).post(RUTA).set('Authorization', `Bearer ${token()}`).send()

/** El alta con el intento 1 de la v2 a medio pago (lease suelto, su suscripción guardada). */
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

/** Premium mensual de 0 días: el 2.º create quedó esperando al banco con el reto abierto. */
const conElRetoAbierto = (o: Record<string, unknown> = {}) => ({
  id: 'sub_3ds',
  status: 'incomplete',
  customer: 'cus_1',
  default_payment_method: 'pm_1',
  metadata: {
    organizationId: ORG,
    featureCode: 'PLAN_PREMIUM',
    planActivationKey: LLAVE,
    primerCobroEsperadoCents: String(PREMIUM_M),
    planOfferVersion: '2',
    planOfferPrecioDe: '2',
  },
  latest_invoice: { id: 'in_1', status: 'open', confirmation_secret: { type: 'payment_intent', client_secret: SECRETO } },
  items: { data: [{ price: { id: 'price_v2_premium_m', unit_amount: PREMIUM_M, recurring: { interval: 'month' } } }] },
  ...o,
})
const pagoConEstado = (estado: string) =>
  mockIpList.mockResolvedValue({
    has_more: false,
    data: [{ is_default: true, payment: { type: 'payment_intent', payment_intent: { id: 'pi_1', status: estado } } }],
  })

/** Nada se escribió en Stripe: ni cobro, ni anulación, ni cancelación, ni cambio. */
function nadaEnStripe() {
  expect(mockSubCreate).not.toHaveBeenCalled()
  expect(mockSubCancel).not.toHaveBeenCalled()
  expect(mockSubUpdate).not.toHaveBeenCalled()
  expect(mockVoid).not.toHaveBeenCalled()
}

beforeEach(() => {
  jest.clearAllMocks()
  // Dueña de la organización (el guardia del alta lo pregunta así) y su staffId (el cierre lo usa como autora).
  prismaMock.staffOrganization.findFirst.mockResolvedValue({ id: 'so-1', staffId: 'staff_dueno' } as never)
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.$transaction.mockImplementation(async (cb: unknown) => (cb as (tx: unknown) => unknown)(prismaMock))
  mockEntregar.mockReset().mockImplementation(async ({ subscriptionId }: { subscriptionId: string }) => ({
    venueId: 'venue-1',
    featureId: 'feat-premium',
    featureCode: 'PLAN_PREMIUM',
    subscriptionId,
    endDate: null,
  }))
  mockSubCreate.mockReset()
  mockSubList.mockReset()
  mockSubRetrieve.mockReset().mockResolvedValue(conElRetoAbierto())
  mockPriceList.mockReset()
  mockPriceRetrieve.mockReset()
  mockIpList.mockReset()
  pagoConEstado('requires_action')
  // La v3 retiró los DOS planes: la oferta vigente no tiene ninguna opción que mostrar.
  prismaMock.planOfferPointer.findUnique
    .mockReset()
    .mockResolvedValue(
      punteroA(
        'cv3',
        3,
        definicionDePrueba({ ids: idsDeLaVersion('v3'), planes: { PRO: { onSale: false }, PREMIUM: { onSale: false, trialDays: 0 } } }),
      ) as never,
    )
  alta()
  prismaMock.onboardingProgress.updateMany.mockResolvedValue({ count: 1 } as never)
  prismaMock.venue.findUnique.mockResolvedValue({
    id: 'venue-1',
    name: 'Negocio',
    slug: 'negocio-de-prueba',
    email: 'negocio@example.com',
    stripeCustomerId: 'cus_1',
    organization: { email: 'org@example.com', name: 'Org' },
  } as never)
  prismaMock.venue.findMany.mockResolvedValue([{ id: 'venue-1', stripeCustomerId: 'cus_1' }] as never)
  prismaMock.venue.update.mockResolvedValue({} as never)
  prismaMock.launchCampaignRedemption.findFirst.mockResolvedValue(null as never)
  prismaMock.feature.findFirst.mockResolvedValue({
    id: 'feat-premium',
    code: 'PLAN_PREMIUM',
    monthlyPrice: 1699,
    stripeProductId: 'prod_premium',
  } as never)
})

describe('POST /onboarding/organizations/:organizationId/v2/retomar-pago — «Confirmar mi pago» retoma su reto', () => {
  it('🔴 el caso de Codex: Premium de 0 días con su reto abierto (incomplete, requires_action) y el 409 perdido; se publica una v3 que retira los dos planes; POST v2/retomar-pago → { estado: "RETO", clientSecret: <el secreto de su factura> }, sin subscriptions.create, sin cancel ni update', async () => {
    const res = await retomar()

    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ estado: 'RETO', clientSecret: SECRETO })
    expect(mockSubRetrieve).toHaveBeenCalledWith('sub_3ds', { expand: ['latest_invoice.confirmation_secret'] })
    expect(mockIpList).toHaveBeenCalledWith({ invoice: 'in_1', expand: ['data.payment.payment_intent'] })
    nadaEnStripe()
    // Sólo lee: ni el lease ni el intento se tocan, y la oferta vigente no se consulta.
    expect(prismaMock.onboardingProgress.updateMany).not.toHaveBeenCalled()
    expect(mockPriceRetrieve).not.toHaveBeenCalled()
    // El secreto sólo va a la dueña: nunca a un log.
    const todo = (['info', 'warn', 'error', 'debug'] as const).flatMap(nivel => ((logger as any)[nivel] as jest.Mock).mock.calls)
    expect(inspect(todo, { depth: 10 })).not.toContain(SECRETO)
  })

  it('la suscripción del intento ya cobrada → { estado: "CERRADA" } y el alta ACTIVE; sin intento IN_PROGRESS, con lease vivo o con la suscripción de otra llave → { estado: "NADA" }', async () => {
    mockSubRetrieve.mockResolvedValue(
      conElRetoAbierto({
        status: 'active',
        latest_invoice: { id: 'in_1', status: 'paid', amount_paid: PREMIUM_M },
        current_period_end: FIN,
        items: {
          data: [
            { current_period_end: FIN, price: { id: 'price_v2_premium_m', unit_amount: PREMIUM_M, recurring: { interval: 'month' } } },
          ],
        },
        discounts: [],
      }),
    )

    const cerrada = await retomar()

    expect(cerrada.status).toBe(200)
    expect(cerrada.body.data).toEqual({ estado: 'CERRADA' })
    expect(prismaMock.onboardingProgress.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ planActivationStatus: 'ACTIVE', planStripeSubscriptionId: 'sub_3ds' }) }),
    )
    expect(mockEntregar).toHaveBeenCalledWith(expect.objectContaining({ subscriptionId: 'sub_3ds' }))
    nadaEnStripe()

    for (const preparar of [
      () => alta({ planActivationStatus: 'NONE' }),
      () => alta({ planActivationStatus: 'ACTIVE' }),
      () => alta({ planActivationLeaseUntil: new Date(Date.now() + 60_000) }),
      () => mockSubRetrieve.mockResolvedValue(conElRetoAbierto({ metadata: { planActivationKey: `plan-activation:${ORG}:7` } })),
    ]) {
      jest.clearAllMocks()
      alta()
      mockSubRetrieve.mockResolvedValue(conElRetoAbierto())
      preparar()

      const nada = await retomar()

      expect(nada.status).toBe(200)
      expect(nada.body.data).toEqual({ estado: 'NADA' })
      expect(prismaMock.onboardingProgress.updateMany).not.toHaveBeenCalled()
      nadaEnStripe()
    }
  })

  it('sin id guardado y planOfferVersionNumber 2 → la encuentra por la llave; sin id y sin versión → NADA (como hoy)', async () => {
    alta({ planStripeSubscriptionId: null })
    mockSubList.mockReturnValue({
      autoPagingEach: async (cb: (s: unknown) => boolean | Promise<boolean>) => {
        for (const s of [{ id: 'sub_ajena', metadata: { planActivationKey: 'otra' } }, conElRetoAbierto()])
          if ((await cb(s)) === false) return
      },
    })

    const porLaLlave = await retomar()

    expect(porLaLlave.status).toBe(200)
    expect(porLaLlave.body.data).toEqual({ estado: 'RETO', clientSecret: SECRETO })
    expect(mockSubList).toHaveBeenCalledWith({ customer: 'cus_1', status: 'all', limit: 100 })
    nadaEnStripe()

    jest.clearAllMocks()
    alta({ planStripeSubscriptionId: null, planOfferVersionNumber: null })

    const sinVersion = await retomar()

    expect(sinVersion.status).toBe(200)
    expect(sinVersion.body.data).toEqual({ estado: 'NADA' })
    expect(mockSubList).not.toHaveBeenCalled()
    expect(mockSubRetrieve).not.toHaveBeenCalled()
  })

  it('cualquier otro estado del pago (ya pagado sin activarse, rechazado) → NADA, sin anular ni cobrar', async () => {
    for (const estado of ['requires_payment_method', 'succeeded', 'canceled']) {
      jest.clearAllMocks()
      pagoConEstado(estado)

      const res = await retomar()

      expect(res.status).toBe(200)
      expect(res.body.data).toEqual({ estado: 'NADA' })
      nadaEnStripe()
    }
  })

  it('otra persona que no es dueña de la organización → 403, sin leer Stripe', async () => {
    prismaMock.staffOrganization.findFirst.mockResolvedValue(null)

    const res = await retomar()

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('ORG_OWNER_REQUIRED')
    expect(mockSubRetrieve).not.toHaveBeenCalled()
    expect(mockSubList).not.toHaveBeenCalled()
    expect(prismaMock.onboardingProgress.findUnique).not.toHaveBeenCalled()
  })
})
