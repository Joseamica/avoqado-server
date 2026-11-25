/**
 * Planes editables B2, Task 5: el alta cita su versión y la recuperación cierra con la suscripción del intento, contra Postgres
 * REAL.
 *
 * La app real por HTTP (`GET …/progress` y `POST …/v2/activate-plan`) con el JWT real de una dueña sembrada (organización,
 * persona, `StaffOrganization` OWNER y `OnboardingProgress` con los términos aceptados). El cierre sin navegador corre con el
 * código real (`cerrarAltaSinNavegador` y la entrada real del job `altas-a-medio-pago`). Lo que se comprueba se lee en Postgres
 * (el intento, su versión, el plan guardado, el `VenueFeature`) y en el almacén de Stripe.
 *
 * Stripe se simula entero (`jest.mock('stripe')`) con un almacén en memoria: clientes, métodos de pago, precios, suscripciones
 * con metadata, estado y prueba (`list` por cliente, paginable con `autoPagingEach`), facturas, `invoicePayments` (el
 * PaymentIntent y el cobro) y lo que leen `autorizarObligacionNueva` e `inventarioDeObligaciones` (sesiones de checkout,
 * saldo, notas de crédito). Respeta la llave de idempotencia, puede pedir el reto del banco al primer cobro y puede «perder»
 * la respuesta de un `subscriptions.create` DESPUÉS de crearla. La v1, la v2 y la v3 se escriben directo en Postgres como
 * `PUBLISHED` con su puntero, y sus precios en el almacén.
 *
 * Simulados además (fuera de lo que esta suite prueba): los correos y avisos, y el cierre final del alta
 * (`terminarAltaCobrada`, que tiene su suite). `logAction` está simulado en toda la integración (`integration-setup.ts`).
 *
 * Higiene (como `plan-offer.http`): guardia `preparada` antes de tocar nada; cada caso siembra su negocio y lo borra al terminar
 * (primero los negocios, después `PlanOfferPointer`, `PlanOfferVersion` y el interruptor `PLANES_EDITABLES`); las listas
 * `PLAN:*` de otras suites se aparcan y se restauran; las Features de los planes vuelven a como estaban.
 */
process.env.ENABLE_VENUE_BASE_SUBSCRIPTION = 'true'

// ---------------------------------------------------------------------------------------------------------------------
// El almacén de Stripe
// ---------------------------------------------------------------------------------------------------------------------

const mockNoExiste = (que: string) =>
  Object.assign(new Error(`No such ${que}`), { type: 'StripeInvalidRequestError', statusCode: 404, code: 'resource_missing' })
const mockCopia = <T>(x: T): T => JSON.parse(JSON.stringify(x))
const mockAhoraS = () => Math.floor(Date.now() / 1000)

const mockAlmacen = {
  clientes: {} as Record<string, any>,
  metodos: {} as Record<string, any>,
  precios: {} as Record<string, any>,
  subs: {} as Record<string, any>,
  facturas: {} as Record<string, any>,
  porLlave: {} as Record<string, { subId?: string; error?: unknown }>,
  /** El primer cobro (`error_if_incomplete`) pide el reto del banco: el 2.º create queda `incomplete` esperándolo. */
  pideAutenticar: false,
  /** El siguiente `subscriptions.create` crea la suscripción y después «pierde» la respuesta (un error que no se reintenta). */
  pierdeLaRespuesta: false,
  n: 0,
  creates: [] as unknown[][],
  /** Toda escritura que el alta nunca debe hacer en Stripe: cambiar, cancelar o anular. */
  escrituras: [] as string[],
  reset() {
    this.clientes = {}
    this.metodos = {}
    this.precios = {}
    this.subs = {}
    this.facturas = {}
    this.porLlave = {}
    this.pideAutenticar = false
    this.pierdeLaRespuesta = false
    this.n = 0
    this.creates = []
    this.escrituras = []
  },
  /** La suscripción como la devuelve Stripe: con su factura expandida sólo si se pidió. */
  vista(sub: any, expand?: string[]) {
    const s = mockCopia(sub)
    const precio = this.precios[s.precioId]
    s.items = {
      object: 'list',
      has_more: false,
      data: [{ id: `si_${s.id}`, quantity: 1, current_period_end: s.current_period_end, price: mockCopia(precio) }],
    }
    delete s.precioId
    const factura = this.facturas[s.latest_invoice]
    const expandida = (expand ?? []).some(e => e === 'latest_invoice' || e.startsWith('latest_invoice.'))
    if (expandida && factura) {
      const f = mockCopia(factura)
      delete f.pi
      s.latest_invoice = f
    }
    return s
  },
  /** El banco autorizó: la factura queda pagada y la suscripción activa. */
  pagar(subId: string) {
    const sub = this.subs[subId]
    const factura = this.facturas[sub.latest_invoice]
    Object.assign(factura, { status: 'paid', amount_paid: factura.total, pi: 'succeeded', confirmation_secret: null })
    sub.status = 'active'
  },
}

const mockCliente = {
  customers: {
    create: async (params: any) => {
      const id = `cus_alta_${++mockAlmacen.n}`
      mockAlmacen.clientes[id] = { id, object: 'customer', balance: 0, deleted: false, ...params }
      return mockCopia(mockAlmacen.clientes[id])
    },
    retrieve: async (id: string) => {
      if (!mockAlmacen.clientes[id]) throw mockNoExiste('customer')
      return mockCopia(mockAlmacen.clientes[id])
    },
    update: async (id: string, params: any) => {
      if (!mockAlmacen.clientes[id]) throw mockNoExiste('customer')
      Object.assign(mockAlmacen.clientes[id], params)
      return mockCopia(mockAlmacen.clientes[id])
    },
    del: async (id: string) => ({ id, deleted: true }),
    listBalanceTransactions: async () => ({ object: 'list', data: [], has_more: false }),
  },
  paymentMethods: {
    retrieve: async (id: string) => {
      if (!mockAlmacen.metodos[id]) throw mockNoExiste('payment_method')
      return mockCopia(mockAlmacen.metodos[id])
    },
  },
  prices: {
    retrieve: async (id: string) => {
      if (!mockAlmacen.precios[id]) throw mockNoExiste('price')
      return mockCopia(mockAlmacen.precios[id])
    },
    list: async (params: { lookup_keys?: string[] }) => ({
      object: 'list',
      has_more: false,
      data: Object.values(mockAlmacen.precios)
        .filter((p: any) => (params.lookup_keys ?? []).includes(p.lookup_key))
        .map(p => mockCopia(p)),
    }),
  },
  subscriptions: {
    create: async (params: any, opciones?: { idempotencyKey?: string }) => {
      mockAlmacen.creates.push([params, opciones])
      const llave = opciones?.idempotencyKey
      const previa = llave ? mockAlmacen.porLlave[llave] : undefined
      if (previa?.error) throw previa.error
      if (previa?.subId) return mockAlmacen.vista(mockAlmacen.subs[previa.subId], params.expand)
      const precio = mockAlmacen.precios[params.items?.[0]?.price]
      if (!precio) throw mockNoExiste('price')
      if (params.payment_behavior === 'error_if_incomplete' && mockAlmacen.pideAutenticar) {
        const error = Object.assign(
          new Error('Payment for this subscription requires additional user action before it can be completed.'),
          {
            type: 'StripeCardError',
            code: 'subscription_payment_intent_requires_action',
            statusCode: 402,
          },
        )
        if (llave) mockAlmacen.porLlave[llave] = { error }
        throw error
      }
      const n = ++mockAlmacen.n
      const id = `sub_alta_${n}`
      const enPrueba = Boolean(params.trial_end) || (params.trial_period_days ?? 0) > 0
      const incompleta = params.payment_behavior === 'default_incomplete'
      const total = enPrueba ? 0 : precio.unit_amount
      const finDePrueba = params.trial_end ?? (params.trial_period_days ? mockAhoraS() + params.trial_period_days * 86_400 : null)
      const periodo = precio.recurring?.interval === 'year' ? 365 * 86_400 : 30 * 86_400
      mockAlmacen.facturas[`in_alta_${n}`] = {
        id: `in_alta_${n}`,
        object: 'invoice',
        customer: params.customer,
        subscription: id,
        currency: 'mxn',
        billing_reason: 'subscription_create',
        status: incompleta ? 'open' : 'paid',
        total,
        subtotal: total,
        amount_due: total,
        amount_paid: incompleta ? 0 : total,
        total_discount_amounts: [],
        starting_balance: 0,
        ending_balance: 0,
        post_payment_credit_notes_amount: 0,
        confirmation_secret: incompleta ? { type: 'payment_intent', client_secret: `pi_alta_${n}_secret_reto` } : null,
        pi: incompleta ? 'requires_action' : 'succeeded',
      }
      mockAlmacen.subs[id] = {
        id,
        object: 'subscription',
        customer: params.customer,
        status: incompleta ? 'incomplete' : enPrueba ? 'trialing' : 'active',
        metadata: { ...(params.metadata ?? {}) },
        default_payment_method: params.default_payment_method ?? null,
        trial_end: finDePrueba,
        trial_settings: params.trial_settings ?? null,
        current_period_end: finDePrueba ?? mockAhoraS() + periodo,
        cancel_at_period_end: Boolean(params.cancel_at_period_end),
        pending_update: null,
        schedule: null,
        discounts: [],
        latest_invoice: `in_alta_${n}`,
        precioId: precio.id,
      }
      if (llave) mockAlmacen.porLlave[llave] = { subId: id }
      if (mockAlmacen.pierdeLaRespuesta) {
        mockAlmacen.pierdeLaRespuesta = false
        // Sin `type`, `code` ni `statusCode`: `retry` no lo reintenta y el alta lo trata como resultado desconocido (503).
        const error = new Error('Se cortó la conexión con Stripe después de crear la suscripción')
        if (llave) mockAlmacen.porLlave[llave] = { error }
        throw error
      }
      return mockAlmacen.vista(mockAlmacen.subs[id], params.expand)
    },
    retrieve: async (id: string, params?: { expand?: string[] }) => {
      if (!mockAlmacen.subs[id]) throw mockNoExiste('subscription')
      return mockAlmacen.vista(mockAlmacen.subs[id], params?.expand)
    },
    list: (params: { customer?: string }) => {
      const data = Object.values(mockAlmacen.subs)
        .filter((s: any) => s.customer === params.customer)
        .map((s: any) => mockAlmacen.vista(s))
      return Object.assign(Promise.resolve({ object: 'list', data, has_more: false }), {
        autoPagingEach: async (cb: (s: unknown) => boolean | void | Promise<boolean | void>) => {
          for (const s of data) if ((await cb(s)) === false) return
        },
      })
    },
    update: async (id: string) => {
      mockAlmacen.escrituras.push(`subscriptions.update ${id}`)
      throw new Error('el alta no cambia suscripciones')
    },
    cancel: async (id: string) => {
      mockAlmacen.escrituras.push(`subscriptions.cancel ${id}`)
      throw new Error('el alta no cancela suscripciones')
    },
  },
  invoices: {
    list: async (params: { subscription?: string }) => ({
      object: 'list',
      has_more: false,
      data: Object.values(mockAlmacen.facturas)
        .filter((f: any) => f.subscription === params.subscription)
        .reverse()
        .map((f: any) => {
          const c = mockCopia(f)
          delete c.pi
          return c
        }),
    }),
    retrieve: async (id: string) => {
      if (!mockAlmacen.facturas[id]) throw mockNoExiste('invoice')
      const c = mockCopia(mockAlmacen.facturas[id])
      delete c.pi
      return c
    },
    voidInvoice: async (id: string) => {
      mockAlmacen.escrituras.push(`invoices.voidInvoice ${id}`)
      throw new Error('el alta de esta suite no anula facturas')
    },
  },
  invoicePayments: {
    list: async (params: { invoice: string; status?: string }) => {
      const f = mockAlmacen.facturas[params.invoice]
      if (!f) return { object: 'list', data: [], has_more: false }
      if (params.status === 'paid') {
        const data =
          f.status === 'paid' && f.amount_paid > 0
            ? [
                {
                  id: `inpay_${f.id}`,
                  status: 'paid',
                  currency: 'mxn',
                  amount_paid: f.amount_paid,
                  is_default: true,
                  payment: {
                    type: 'charge',
                    charge: { id: `ch_${f.id}`, paid: true, currency: 'mxn', amount: f.amount_paid, amount_refunded: 0, disputed: false },
                  },
                },
              ]
            : []
        return { object: 'list', data, has_more: false }
      }
      return {
        object: 'list',
        has_more: false,
        data: [
          {
            id: `inpay_${f.id}`,
            status: f.status === 'paid' ? 'paid' : 'open',
            is_default: true,
            payment: { type: 'payment_intent', payment_intent: { id: `pi_${f.id}`, status: f.pi } },
          },
        ],
      }
    },
  },
  creditNotes: { list: async () => ({ object: 'list', data: [], has_more: false }) },
  checkout: {
    sessions: {
      list: async () => ({ object: 'list', data: [], has_more: false }),
      expire: async () => {
        throw new Error('no hay sesiones abiertas en esta suite')
      },
      retrieve: async () => {
        throw mockNoExiste('checkout.session')
      },
    },
  },
  subscriptionSchedules: {
    retrieve: async () => {
      throw mockNoExiste('subscription_schedule')
    },
  },
  disputes: { list: async () => ({ object: 'list', data: [], has_more: false }) },
}
jest.mock('stripe', () => jest.fn().mockImplementation(() => mockCliente))

// Los correos y avisos no salen; el cierre final del alta tiene su suite (aquí sólo importa que el plan quede ACTIVE).
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
  terminarAltaCobrada: jest.fn().mockResolvedValue({ estado: 'NADA', motivo: 'CIERRE_EN_CURSO' }),
  terminarAltaCobradaSinRomper: jest.fn().mockResolvedValue(undefined),
}))

import jwt from 'jsonwebtoken'
import request from 'supertest'
import prisma from '@/utils/prismaClient'
import { AltasAMedioPagoJob } from '@/jobs/altas-a-medio-pago.job'
import { cerrarAltaSinNavegador } from '@/services/onboarding/planActivation.service'
import { ofertaDeRespaldo } from '@/services/billing/planOffer'
import { definicionDePrueba, idsDeLaVersion } from '@tests/__helpers__/planOfferFixtures'
import { logAction } from '@/services/dashboard/activity-log.service'

const app = require('../../../src/app').default

jest.setTimeout(120_000)

const stamp = `${Date.now().toString(36)}${process.pid}`.toLowerCase()
const KEYS = ['PLAN:PRO', 'PLAN:PREMIUM']
const productos = { PRO: `prod_alta_pro_${stamp}`, PREMIUM: `prod_alta_premium_${stamp}` }
const PRO_M_V2 = Math.round((79900 * 116) / 100) // 92684
const TOPE_DE_APARCADOS = 100

let preparada = false
const featuresOriginales: Array<{ code: string; existia: boolean; stripeProductId: string | null; active: boolean }> = []
const listasAparcadas: { id: string; listProductKey: string | null; code: string; slug: string }[] = []
/** El negocio del caso en curso (lo borra `afterEach`). */
let alta: { orgId: string; staffId: string; venueId: string; customerId: string; pm: string; token: string } | null = null
/** Un número por negocio sembrado: los correos y nombres de la suite no se repiten aunque una limpieza falle. */
let sembrados = 0

// ---------------------------------------------------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------------------------------------------------

type Def = ReturnType<typeof definicionDePrueba>
/** Una versión: Pro mensual a `netoProM` + IVA y `trialDays` días de prueba en los dos planes, con sus cuatro precios. */
const version = (prefijo: string, netoProM: number, trialDays: number): Def =>
  definicionDePrueba({
    ids: idsDeLaVersion(prefijo),
    netos: { 'PRO:monthly': netoProM },
    planes: { PRO: { trialDays }, PREMIUM: { trialDays } },
  })

/** Los cuatro precios de una versión en el almacén de Stripe (activos, del producto de su plan, con el IVA incluido). */
function registrarPrecios(d: Def) {
  for (const tier of ['PRO', 'PREMIUM'] as const)
    for (const interval of ['monthly', 'annual'] as const) {
      const ranura = d[tier][interval]
      if (!ranura.stripePriceId) continue
      mockAlmacen.precios[ranura.stripePriceId] = {
        id: ranura.stripePriceId,
        object: 'price',
        active: true,
        currency: 'mxn',
        unit_amount: ranura.grossCents,
        product: productos[tier],
        lookup_key: null,
        tax_behavior: 'inclusive',
        recurring: { interval: interval === 'annual' ? 'year' : 'month', interval_count: 1 },
      }
    }
}

/** Publica `d` con ese número directo en Postgres: la anterior queda SUPERSEDED y el puntero pasa a ésta. */
async function publicar(number: number, d: unknown) {
  if (!alta) throw new Error('sin negocio sembrado')
  const v = await prisma.planOfferVersion.create({
    data: {
      status: 'PUBLISHED',
      number,
      definition: d as never,
      createdById: alta.staffId,
      publishedById: alta.staffId,
      publishedAt: new Date(),
    },
  })
  const antes = await prisma.planOfferPointer.findUnique({ where: { id: 'vigente' } })
  await prisma.planOfferPointer.upsert({
    where: { id: 'vigente' },
    create: { id: 'vigente', currentVersionId: v.id, revision: number },
    update: { currentVersionId: v.id, revision: number },
  })
  if (antes?.currentVersionId)
    await prisma.planOfferVersion.update({ where: { id: antes.currentVersionId }, data: { status: 'SUPERSEDED' } })
  registrarPrecios(d as Def)
}

/** La v1 (lo de hoy) y la v2 del editor con Pro mensual a $799 + IVA y `trialDays` días; la vigente queda la v2. */
async function conLaV2(trialDays: number) {
  await publicar(1, ofertaDeRespaldo())
  await publicar(2, version('v2', 79900, trialDays))
}
/** El editor publica la v3: otro mensual de Pro ($899 + IVA), mismos días. */
const publicarLaV3 = (trialDays: number) => publicar(3, version('v3', 89900, trialDays))

const borrarLaOferta = async () => {
  await prisma.planOfferPointer.deleteMany({})
  await prisma.planOfferVersion.deleteMany({})
  await prisma.interruptorDePlataforma.deleteMany({ where: { clave: 'PLANES_EDITABLES' } })
}

/** Una dueña con su organización, su negocio (con cliente de Stripe y tarjeta) y su alta con los términos aceptados. */
async function sembrarAlta() {
  const n = ++sembrados
  const org = await prisma.organization.create({
    data: { name: `Alta B2 ${stamp} ${n}`, email: `alta-b2-${stamp}-${n}@example.com`, phone: '5555555555' },
  })
  const staff = await prisma.staff.create({
    data: { email: `duena-alta-b2-${stamp}-${n}@example.com`, firstName: 'Dueña', lastName: 'Prueba' },
  })
  await prisma.staffOrganization.create({ data: { staffId: staff.id, organizationId: org.id, role: 'OWNER', isPrimary: true } })
  const customerId = `cus_alta_${stamp}_${n}`
  // `activate-plan` exige `^pm_[A-Za-z0-9]+$`: sin más guiones bajos después de `pm_`.
  const pm = `pm_alta${stamp}n${n}`
  mockAlmacen.clientes[customerId] = { id: customerId, object: 'customer', balance: 0, deleted: false }
  mockAlmacen.metodos[pm] = { id: pm, object: 'payment_method', customer: customerId, card: { fingerprint: `fp_${stamp}` } }
  const venue = await prisma.venue.create({
    data: {
      organizationId: org.id,
      name: `Negocio alta B2 ${stamp} ${n}`,
      slug: `negocio-alta-b2-${stamp}-${n}`.toLowerCase(),
      status: 'ONBOARDING',
      stripeCustomerId: customerId,
    },
  })
  await prisma.onboardingProgress.create({
    data: { organizationId: org.id, completedSteps: [], wizardVersion: 2, v2SetupData: {}, termsAcceptedAt: new Date() },
  })
  const token = jwt.sign({ sub: staff.id, orgId: org.id, venueId: venue.id, role: 'OWNER' }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '1h',
  })
  alta = { orgId: org.id, staffId: staff.id, venueId: venue.id, customerId, pm, token }
  return alta
}

async function borrarElAlta() {
  const a = alta
  alta = null
  if (!a) return
  await prisma.billingObligationConflict.deleteMany({ where: { venueId: a.venueId } })
  // El negocio arrastra sus `VenueFeature` (y una aceptación, si la hubiera).
  await prisma.venue.deleteMany({ where: { id: a.venueId } })
  await prisma.onboardingProgress.deleteMany({ where: { organizationId: a.orgId } })
  await prisma.staffOrganization.deleteMany({ where: { organizationId: a.orgId } })
  await prisma.organization.deleteMany({ where: { id: a.orgId } })
  await prisma.staff.deleteMany({ where: { id: a.staffId } })
}

/** El negocio del caso en curso (siempre sembrado por `beforeEach`). */
function negocio() {
  if (!alta) throw new Error('sin negocio sembrado')
  return alta
}
const autorizado = () => ({ Authorization: `Bearer ${negocio().token}` })
const leerProgreso = () => request(app).get(`/api/v1/onboarding/organizations/${negocio().orgId}/progress`).set(autorizado())
const activar = (cuerpo: object) =>
  request(app).post(`/api/v1/onboarding/organizations/${negocio().orgId}/v2/activate-plan`).set(autorizado()).send(cuerpo)
const elAlta = () => prisma.onboardingProgress.findUniqueOrThrow({ where: { organizationId: negocio().orgId } })
const planGuardado = async () => ((await elAlta()).v2SetupData as unknown as { plan?: Record<string, unknown> } | null)?.plan
const filaDePro = () =>
  prisma.venueFeature.findFirst({
    where: { venueId: negocio().venueId, feature: { code: 'PLAN_PRO' } },
    select: { active: true, stripeSubscriptionId: true },
  })

/**
 * El cierre del alta quedó en la bitácora: `logAction` con la acción del alta estándar, a nombre de la dueña, sobre su
 * `OnboardingProgress` y con lo que se cobró. (Simulado en la integración: se revisa la LLAMADA, nunca una fila.)
 */
const seAuditoElCierre = (subscriptionId: string, payNow: boolean) =>
  expect(jest.mocked(logAction)).toHaveBeenCalledWith(
    expect.objectContaining({
      action: 'PLAN_ACTIVATED_ONBOARDING',
      staffId: negocio().staffId,
      organizationId: negocio().orgId,
      entity: 'OnboardingProgress',
      data: expect.objectContaining({ tier: 'PRO', interval: 'monthly', subscriptionId, firstChargeCents: payNow ? PRO_M_V2 : 0 }),
    }),
  )

/** La opción de Pro mensual que el alta publica en `progress` (con su comprobante). */
async function opcionDeProMensual() {
  const r = await leerProgreso()
  expect(r.status).toBe(200)
  const opcion = r.body.progress.planQuote.oferta?.planes?.PRO?.monthly
  expect(opcion).toEqual(expect.objectContaining({ quoteToken: expect.any(String), precioCents: PRO_M_V2 }))
  return opcion as { quoteToken: string; precioCents: number; firstChargeCents: number; trialEndsAt: string | null }
}
const cuerpoDe = (opcion: { quoteToken: string; firstChargeCents: number; trialEndsAt: string | null }) => ({
  tier: 'PRO',
  interval: 'monthly',
  payNow: opcion.trialEndsAt === null,
  paymentMethodId: negocio().pm,
  offer: { kind: 'STANDARD', expectedFirstChargeCents: opcion.firstChargeCents, quoteToken: opcion.quoteToken },
})

/** Deja el alta como la encuentra el barrido: el lease vencido y quieta más de 15 min (sin enlazar fechas: hora UTC de la base). */
const dejarQuieta = (organizationId: string) =>
  prisma.$executeRaw`
    UPDATE "OnboardingProgress"
    SET "planActivationLeaseUntil" = (NOW() AT TIME ZONE 'UTC') - INTERVAL '1 hour',
        "updatedAt" = (NOW() AT TIME ZONE 'UTC') - INTERVAL '1 hour'
    WHERE "organizationId" = ${organizationId}`

// ---------------------------------------------------------------------------------------------------------------------
// Antes y después
// ---------------------------------------------------------------------------------------------------------------------

beforeAll(async () => {
  if (!/test|hybrid/i.test(new URL(process.env.TEST_DATABASE_URL!).pathname)) throw new Error('Disposable DB required')
  preparada = true
  await borrarLaOferta()
  // Los productos de Stripe de los planes (con ellos la entrega reconoce lo que se cobró), sin perder lo que había.
  for (const [code, product] of [
    ['PLAN_PRO', productos.PRO],
    ['PLAN_PREMIUM', productos.PREMIUM],
  ] as const) {
    const antes = await prisma.feature.findUnique({ where: { code } })
    featuresOriginales.push({ code, existia: !!antes, stripeProductId: antes?.stripeProductId ?? null, active: antes?.active ?? true })
    await prisma.feature.upsert({
      where: { code },
      create: {
        code,
        name: code === 'PLAN_PRO' ? 'Plan Pro' : 'Plan Premium',
        category: 'OPERATIONS',
        monthlyPrice: 999,
        stripeProductId: product,
      },
      update: { stripeProductId: product, active: true },
    })
  }
  // Las listas de los planes que dejaron otras suites: aparcadas durante la corrida (se guardan ANTES de cambiarlas).
  const listas = await prisma.hybridCampaign.findMany({
    where: { purpose: 'LIST', listProductKey: { in: KEYS } },
    select: { id: true, listProductKey: true, code: true, slug: true },
    orderBy: { id: 'asc' },
    take: TOPE_DE_APARCADOS + 1,
  })
  if (listas.length > TOPE_DE_APARCADOS) throw new Error('Hay demasiadas listas de planes que aparcar: la suite se detiene sin tocarlas')
  for (const lista of listas) {
    await prisma.hybridCampaign.update({
      where: { id: lista.id },
      data: { listProductKey: `FEATURE:PARKED_${lista.id}`, code: `PARKED_${lista.id}`, slug: `parked-${lista.id}` },
    })
    listasAparcadas.push(lista)
  }
})

afterAll(async () => {
  if (!preparada) return
  // Paso por paso: si uno falla, los demás igual corren; al final se lanza un solo error con todos.
  const errores: string[] = []
  const paso = async (que: string, fn: () => Promise<unknown>) => {
    try {
      await fn()
    } catch (error) {
      errores.push(`${que}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  await paso('borrar el negocio que quedó', borrarElAlta)
  await paso('borrar la oferta', borrarLaOferta)
  for (const { id, listProductKey, code, slug } of listasAparcadas)
    await paso(`devolver la lista aparcada ${id}`, () =>
      prisma.hybridCampaign.update({ where: { id }, data: { listProductKey, code, slug } }),
    )
  for (const f of featuresOriginales)
    await paso(`devolver la función ${f.code}`, () =>
      f.existia
        ? prisma.feature.update({ where: { code: f.code }, data: { stripeProductId: f.stripeProductId, active: f.active } })
        : prisma.feature.deleteMany({ where: { code: f.code } }),
    )
  if (errores.length) throw new Error(`La limpieza de plan-offer.alta no quedó completa:\n- ${errores.join('\n- ')}`)
})

beforeEach(async () => {
  if (!preparada) return
  mockAlmacen.reset()
  // `logAction` está simulado en toda la integración (`integration-setup.ts`): cada caso revisa SUS llamadas, no filas.
  jest.mocked(logAction).mockClear()
  try {
    await borrarLaOferta()
  } finally {
    await sembrarAlta()
  }
})

afterEach(async () => {
  if (!preparada) return
  // Primero el negocio (arrastra lo que cite una versión), después la oferta.
  try {
    await borrarElAlta()
  } finally {
    await borrarLaOferta()
  }
})

// ---------------------------------------------------------------------------------------------------------------------
// Los casos
// ---------------------------------------------------------------------------------------------------------------------

describe('el alta cita su versión y la recuperación cierra con su suscripción (Postgres real)', () => {
  it('🔴 GET progress → POST activate-plan con el comprobante de la v2 → 200; el almacén tiene la suscripción con price_v2_pro_m y trial_end = trialEndsAt; en Postgres planOfferVersionNumber 2 y plan.offerVersion 2', async () => {
    await conLaV2(30)
    const opcion = await opcionDeProMensual()
    expect(opcion).toMatchObject({ firstChargeCents: 0, trialEndsAt: expect.any(String) })

    const r = await activar(cuerpoDe(opcion))

    expect(r.status).toBe(200)
    expect(r.body.data).toMatchObject({ status: 'ACTIVE', tier: 'PRO', interval: 'monthly' })
    const subs = Object.values(mockAlmacen.subs) as Array<{
      id: string
      precioId: string
      trial_end: number
      metadata: Record<string, string>
    }>
    expect(subs).toHaveLength(1)
    expect(subs[0].precioId).toBe('price_v2_pro_m')
    expect(subs[0].trial_end).toBe(Math.floor(Date.parse(opcion.trialEndsAt as string) / 1000))
    expect(subs[0].metadata).toMatchObject({ planOfferVersion: '2', planActivationKey: `plan-activation:${negocio().orgId}:1` })
    expect(mockAlmacen.creates[0][0]).not.toHaveProperty('trial_period_days')

    const progreso = await elAlta()
    expect(progreso).toMatchObject({ planActivationStatus: 'ACTIVE', planOfferVersionNumber: 2, planStripeSubscriptionId: subs[0].id })
    expect(await planGuardado()).toMatchObject({ tier: 'PRO', interval: 'monthly', payNow: false, offerVersion: 2 })
    expect(await filaDePro()).toEqual({ active: true, stripeSubscriptionId: subs[0].id })
    seAuditoElCierre(subs[0].id, false)
  })

  it('🔴 GET progress con la v2, el puntero pasa a la v3, POST con el comprobante de la v2 → 409 OFFER_CHANGED y el almacén sin suscripciones', async () => {
    await conLaV2(30)
    const opcion = await opcionDeProMensual()
    await publicarLaV3(30)

    const r = await activar(cuerpoDe(opcion))

    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ code: 'OFFER_CHANGED', details: { reason: 'VERSION', offerVersion: 3 } })
    expect(Object.keys(mockAlmacen.subs)).toHaveLength(0)
    expect(mockAlmacen.creates).toHaveLength(0)
    expect(await elAlta()).toMatchObject({ planActivationStatus: 'NONE', planStripeSubscriptionId: null })
  })

  it('🔴 Codex B1 #1: Pro de 0 días con la v2 → 409 PLAN_PAYMENT_REQUIRES_ACTION; el puntero pasa a la v3; el almacén paga la factura; cerrarAltaSinNavegador → CERRADA; el alta ACTIVE y el VenueFeature ligado', async () => {
    await conLaV2(0)
    mockAlmacen.pideAutenticar = true
    const opcion = await opcionDeProMensual()
    expect(opcion).toMatchObject({ firstChargeCents: PRO_M_V2, trialEndsAt: null })

    const reto = await activar(cuerpoDe(opcion))

    expect(reto.status).toBe(409)
    expect(reto.body.code).toBe('PLAN_PAYMENT_REQUIRES_ACTION')
    const [sub] = Object.values(mockAlmacen.subs) as Array<{
      id: string
      status: string
      latest_invoice: string
      metadata: Record<string, string>
    }>
    expect(sub).toMatchObject({ status: 'incomplete', metadata: { primerCobroEsperadoCents: String(PRO_M_V2), planOfferVersion: '2' } })
    expect(reto.body.details.clientSecret).toBe(mockAlmacen.facturas[sub.latest_invoice].confirmation_secret.client_secret)
    const creadas = mockAlmacen.creates.length

    // El editor publica la v3 mientras el banco espera; la persona autoriza y cierra la pestaña.
    await publicarLaV3(0)
    mockAlmacen.pagar(sub.id)

    await expect(cerrarAltaSinNavegador(negocio().orgId)).resolves.toBe('CERRADA')

    expect(await elAlta()).toMatchObject({ planActivationStatus: 'ACTIVE', planStripeSubscriptionId: sub.id, planOfferVersionNumber: 2 })
    expect(await filaDePro()).toEqual({ active: true, stripeSubscriptionId: sub.id })
    // La versión es la de la suscripción (la v2), no la vigente; y nada se cobró ni se tocó de nuevo en Stripe.
    expect(await planGuardado()).toMatchObject({ tier: 'PRO', interval: 'monthly', payNow: true, offerVersion: 2 })
    expect(mockAlmacen.creates).toHaveLength(creadas)
    expect(mockAlmacen.escrituras).toEqual([])
    seAuditoElCierre(sub.id, true)
  })

  it('🔴 b2-r2 #1: Pro de 0 días cobrado en el primer create y la respuesta perdida (503, sin id); el puntero pasa a la v3; la entrada real del job → CERRADA con el id registrado y el alta ACTIVE', async () => {
    await conLaV2(0)
    mockAlmacen.pierdeLaRespuesta = true
    const opcion = await opcionDeProMensual()

    const perdida = await activar(cuerpoDe(opcion))

    expect(perdida.status).toBe(503)
    expect(perdida.body.code).toBe('PLAN_ACTIVATION_PENDING')
    const [sub] = Object.values(mockAlmacen.subs) as Array<{ id: string; status: string; metadata: Record<string, string> }>
    // Stripe sí cobró (en el PRIMER create, sin la marca del reto), pero el alta nunca supo su id.
    expect(sub.status).toBe('active')
    expect(sub.metadata).not.toHaveProperty('primerCobroEsperadoCents')
    expect(await elAlta()).toMatchObject({ planActivationStatus: 'IN_PROGRESS', planStripeSubscriptionId: null, planOfferVersionNumber: 2 })
    const creadas = mockAlmacen.creates.length

    await publicarLaV3(0)
    await dejarQuieta(negocio().orgId)

    // La entrada real del job, con su resolver real. El cursor rota: se corre hasta que ESTA alta se cierre (otras suites
    // pueden haber dejado altas a medio pago en la base desechable).
    const job = new AltasAMedioPagoJob({ cron: { start: jest.fn(), stop: jest.fn() } })
    let cerradas = 0
    for (let i = 0; i < 5 && (await elAlta()).planActivationStatus !== 'ACTIVE'; i++) cerradas += (await job.runNow()).cerradas
    expect(cerradas).toBeGreaterThanOrEqual(1)

    expect(await elAlta()).toMatchObject({ planActivationStatus: 'ACTIVE', planStripeSubscriptionId: sub.id })
    expect(await filaDePro()).toEqual({ active: true, stripeSubscriptionId: sub.id })
    expect(await planGuardado()).toMatchObject({ tier: 'PRO', interval: 'monthly', payNow: true, offerVersion: 2 })
    expect(mockAlmacen.creates).toHaveLength(creadas)
    expect(mockAlmacen.escrituras).toEqual([])
    seAuditoElCierre(sub.id, true)
  })

  it('🔴 b2-r4 regresión, sin versiones: POST activate-plan con tarjeta y offer.quoteToken null → 200; en Postgres v2SetupData.plan.offer no tiene la llave quoteToken y GET progress tampoco la devuelve', async () => {
    // Sin versiones: el precio es el de la llave de hoy.
    mockAlmacen.precios.price_llave_pro_m = {
      id: 'price_llave_pro_m',
      object: 'price',
      active: true,
      currency: 'mxn',
      unit_amount: 115884,
      product: productos.PRO,
      lookup_key: 'plan_pro_monthly',
      tax_behavior: 'inclusive',
      recurring: { interval: 'month', interval_count: 1 },
    }

    const r = await activar({
      tier: 'PRO',
      interval: 'monthly',
      payNow: false,
      paymentMethodId: negocio().pm,
      offer: { kind: 'STANDARD', expectedFirstChargeCents: 0, quoteToken: null },
    })

    expect(r.status).toBe(200)
    expect(r.body.data).toMatchObject({ status: 'ACTIVE', tier: 'PRO', interval: 'monthly' })
    const [sub] = Object.values(mockAlmacen.subs) as Array<{ precioId: string; metadata: Record<string, string> }>
    expect(sub.precioId).toBe('price_llave_pro_m')
    expect(sub.metadata).not.toHaveProperty('planOfferVersion')
    expect(mockAlmacen.creates[0][0]).toMatchObject({ trial_period_days: 30 })

    const progreso = await elAlta()
    expect(progreso.planOfferVersionNumber).toBeNull()
    const plan = await planGuardado()
    expect(plan?.offer).toEqual({ kind: 'STANDARD', expectedFirstChargeCents: 0 })
    expect(plan?.offer).not.toHaveProperty('quoteToken')
    expect(plan).not.toHaveProperty('offerVersion')

    const leido = await leerProgreso()
    expect(leido.status).toBe(200)
    expect(leido.body.progress.v2SetupData.plan.offer).toEqual({ kind: 'STANDARD', expectedFirstChargeCents: 0 })
    expect(JSON.stringify(leido.body.progress.v2SetupData)).not.toContain('quoteToken')
  })
})
