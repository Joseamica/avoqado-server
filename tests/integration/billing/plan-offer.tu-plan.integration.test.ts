/**
 * Planes editables B2, Task 7 (§17, §18, Review Focus 4): «Tu plan» dice la tarjeta y el monto de la prueba SIN tarjeta y lleva al
 * portal de Stripe a poner la tarjeta, contra Postgres REAL.
 *
 * La app real por HTTP con el JWT real de una dueña sembrada (organización, persona, `StaffOrganization` OWNER y `OnboardingProgress`
 * con los términos aceptados): el alta sin tarjeta (`GET …/progress` → `POST …/v2/activate-plan`), «Tu plan» (`GET …/plan`) y el
 * portal (`POST …/billing-portal` con `flujo: 'PONER_TARJETA'`). La regla común y la entrega son las reales.
 *
 * Stripe se simula entero (`jest.mock('stripe')`) con un almacén en memoria, el de `plan-offer.alta` más lo que esta suite lee:
 * clientes (`invoice_settings`, `default_source`), métodos de pago (tarjetas), precios, suscripciones con `trial_settings` y su
 * lista por cliente, facturas y su vista previa (`invoices.createPreview`), `billingPortal.sessions.create`, las sesiones de checkout
 * y lo que leen `autorizarObligacionNueva` e `inventarioDeObligaciones`. El almacén «hace de portal» (la tarjeta queda como la
 * predeterminada del cliente) y «hace de Stripe» al terminar la prueba (la cancela). La v1 y la v2 se escriben directo en Postgres
 * como `PUBLISHED` con su puntero, y sus precios en el almacén.
 *
 * Simulados además (fuera de lo que esta suite prueba): los correos y avisos, y el cierre final del alta (`terminarAltaCobrada`, que
 * tiene su suite). `logAction` está simulado en toda la integración (`integration-setup.ts`).
 *
 * Higiene (como `plan-offer.alta`): guardia `preparada` antes de tocar nada; cada caso siembra su negocio y lo borra al terminar
 * (primero los negocios, que arrastran sus `VenueFeature` y `PlanAcceptance`, después `PlanOfferPointer`, `PlanOfferVersion` y el
 * interruptor `PLANES_EDITABLES`); las listas `PLAN:*` de otras suites se aparcan y se restauran; las Features de los planes vuelven a
 * como estaban.
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
  /** B2 Task 6: el siguiente `subscriptions.create` no contesta y NO crea nada (un error que no se reintenta). */
  noContesta: false,
  n: 0,
  creates: [] as unknown[][],
  /** Toda escritura que el alta nunca debe hacer en Stripe: cambiar, cancelar o anular. */
  escrituras: [] as string[],
  /** Las sesiones del portal de Stripe que se abrieron (B2 Task 7: «Poner mi tarjeta»). */
  portales: [] as any[],
  reset() {
    this.clientes = {}
    this.metodos = {}
    this.precios = {}
    this.subs = {}
    this.facturas = {}
    this.porLlave = {}
    this.pideAutenticar = false
    this.pierdeLaRespuesta = false
    this.noContesta = false
    this.n = 0
    this.creates = []
    this.escrituras = []
    this.portales = []
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
  /**
   * Lo que hace el portal de Stripe en `payment_method_update` (§17): la tarjeta nueva queda como la predeterminada del cliente, que
   * es la que cobra una prueba sin método propio. La suscripción no se toca.
   */
  simularPortal(customerId: string, pm: string, last4 = '4242') {
    this.metodos[pm] = { id: pm, object: 'payment_method', type: 'card', customer: customerId, card: { brand: 'visa', last4 } }
    this.clientes[customerId].invoice_settings = { default_payment_method: pm }
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
      const id = `cus_tuplan_${++mockAlmacen.n}`
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
    retrieveSource: async () => {
      throw mockNoExiste('source')
    },
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
      if (mockAlmacen.noContesta) {
        mockAlmacen.noContesta = false
        // Sin `type`, `code` ni `statusCode`: `retry` no lo reintenta; el alta lo trata como resultado desconocido (503).
        throw new Error('Stripe no contestó y no creó la suscripción')
      }
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
      const id = `sub_tuplan_${n}`
      const enPrueba = Boolean(params.trial_end) || (params.trial_period_days ?? 0) > 0
      const incompleta = params.payment_behavior === 'default_incomplete'
      const total = enPrueba ? 0 : precio.unit_amount
      const finDePrueba = params.trial_end ?? (params.trial_period_days ? mockAhoraS() + params.trial_period_days * 86_400 : null)
      const periodo = precio.recurring?.interval === 'year' ? 365 * 86_400 : 30 * 86_400
      mockAlmacen.facturas[`in_tuplan_${n}`] = {
        id: `in_tuplan_${n}`,
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
        confirmation_secret: incompleta ? { type: 'payment_intent', client_secret: `pi_tuplan_${n}_secret_reto` } : null,
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
        latest_invoice: `in_tuplan_${n}`,
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
    /** La vista previa de la siguiente factura: lo que Stripe cobrará al terminar la prueba (su precio; sin saldo en esta suite). */
    createPreview: async (params: { subscription: string }) => {
      const sub = mockAlmacen.subs[params.subscription]
      if (!sub) throw mockNoExiste('subscription')
      if (sub.status === 'canceled')
        throw Object.assign(new Error('No upcoming invoices'), { type: 'StripeInvalidRequestError', statusCode: 400 })
      const monto = mockAlmacen.precios[sub.precioId].unit_amount
      return { object: 'invoice', subscription: sub.id, total: monto, amount_due: monto }
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
  billingPortal: {
    sessions: {
      create: async (params: any) => {
        mockAlmacen.portales.push(mockCopia(params))
        return {
          id: `bps_tuplan_${mockAlmacen.portales.length}`,
          object: 'billing_portal.session',
          url: 'https://billing.stripe.test/p/tuplan',
        }
      },
    },
  },
}

jest.mock('stripe', () => jest.fn().mockImplementation(() => mockCliente))

// Los correos y avisos no salen; el cierre final del alta tiene su suite (aquí sólo importa que el plan quede ACTIVE).
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
jest.mock('@/services/onboarding/terminarAltaCobrada', () => ({
  __esModule: true,
  terminarAltaCobrada: jest.fn().mockResolvedValue({ estado: 'NADA', motivo: 'CIERRE_EN_CURSO' }),
  terminarAltaCobradaSinRomper: jest.fn().mockResolvedValue(undefined),
}))

import jwt from 'jsonwebtoken'
import request from 'supertest'
import prisma from '@/utils/prismaClient'
import { ofertaDeRespaldo } from '@/services/billing/planOffer'
import { definicionDePrueba, idsDeLaVersion } from '@tests/__helpers__/planOfferFixtures'
import { logAction } from '@/services/dashboard/activity-log.service'

const app = require('../../../src/app').default

jest.setTimeout(120_000)

const stamp = `${Date.now().toString(36)}${process.pid}`.toLowerCase()
const KEYS = ['PLAN:PRO', 'PLAN:PREMIUM']
const productos = { PRO: `prod_tuplan_pro_${stamp}`, PREMIUM: `prod_tuplan_premium_${stamp}` }
const PRO_M_V2 = Math.round((79900 * 116) / 100) // 92684
const TOPE_DE_APARCADOS = 100
const REGRESO = 'https://dashboard.avoqado.test/venues/negocio/settings/billing/subscriptions?portal=tarjeta'

let preparada = false
const featuresOriginales: Array<{ code: string; existia: boolean; stripeProductId: string | null; active: boolean }> = []
const listasAparcadas: { id: string; listProductKey: string | null; code: string; slug: string }[] = []
/** El negocio del caso en curso (lo borra `afterEach`). */
let alta: { orgId: string; staffId: string; venueId: string; customerId: string; token: string } | null = null
/** Un número por negocio sembrado: los correos y nombres de la suite no se repiten aunque una limpieza falle. */
let sembrados = 0

// ---------------------------------------------------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------------------------------------------------

type Def = ReturnType<typeof definicionDePrueba>
/** Una versión con Pro SIN tarjeta: mensual a `netoProM` + IVA y `trialDays` días; Premium con tarjeta, los mismos días. */
const versionSinTarjeta = (prefijo: string, netoProM: number, trialDays: number): Def =>
  definicionDePrueba({
    ids: idsDeLaVersion(prefijo),
    netos: { 'PRO:monthly': netoProM },
    planes: { PRO: { requiresCard: false, trialDays }, PREMIUM: { trialDays } },
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

const borrarLaOferta = async () => {
  await prisma.planOfferPointer.deleteMany({})
  await prisma.planOfferVersion.deleteMany({})
  await prisma.interruptorDePlataforma.deleteMany({ where: { clave: 'PLANES_EDITABLES' } })
}

/** Una dueña con su organización, su negocio (con cliente de Stripe, sin tarjeta) y su alta con los términos aceptados. */
async function sembrarAlta() {
  const n = ++sembrados
  const org = await prisma.organization.create({
    data: { name: `Tu plan B2 ${stamp} ${n}`, email: `tuplan-b2-${stamp}-${n}@example.com`, phone: '5555555555' },
  })
  const staff = await prisma.staff.create({
    data: { email: `duena-tuplan-b2-${stamp}-${n}@example.com`, firstName: 'Dueña', lastName: 'Prueba' },
  })
  await prisma.staffOrganization.create({ data: { staffId: staff.id, organizationId: org.id, role: 'OWNER', isPrimary: true } })
  const customerId = `cus_tuplan_${stamp}_${n}`
  mockAlmacen.clientes[customerId] = { id: customerId, object: 'customer', balance: 0, deleted: false }
  const venue = await prisma.venue.create({
    data: {
      organizationId: org.id,
      name: `Negocio tu plan B2 ${stamp} ${n}`,
      slug: `negocio-tuplan-b2-${stamp}-${n}`.toLowerCase(),
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
  alta = { orgId: org.id, staffId: staff.id, venueId: venue.id, customerId, token }
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
const leerPlan = () => request(app).get(`/api/v1/dashboard/venues/${negocio().venueId}/plan`).set(autorizado())
const ponerMiTarjeta = () =>
  request(app)
    .post(`/api/v1/dashboard/venues/${negocio().venueId}/billing-portal`)
    .set(autorizado())
    .send({ returnUrl: REGRESO, flujo: 'PONER_TARJETA' })
const filaDePro = () =>
  prisma.venueFeature.findFirst({
    where: { venueId: negocio().venueId, feature: { code: 'PLAN_PRO' } },
    select: { active: true, stripeSubscriptionId: true },
  })

type SubDelAlmacen = {
  id: string
  status: string
  precioId: string
  trial_end: number
  ended_at?: number
  default_payment_method: string | null
  metadata: Record<string, string>
}

/**
 * El alta SIN tarjeta por HTTP (la de Task 6): con la v2 publicada, `GET progress` → `POST activate-plan` con
 * `STANDARD_SIN_TARJETA` y su comprobante. Deja UNA suscripción `trialing` sin método en el almacén y la fila de Pro ligada.
 */
async function altaSinTarjeta(): Promise<SubDelAlmacen> {
  await publicar(1, ofertaDeRespaldo())
  await publicar(2, versionSinTarjeta('v2', 79900, 14))
  const progreso = await leerProgreso()
  expect(progreso.status).toBe(200)
  const opcion = progreso.body.progress.planQuote.oferta?.planes?.PRO?.monthly
  expect(opcion).toEqual(expect.objectContaining({ quoteToken: expect.any(String), precioCents: PRO_M_V2, firstChargeCents: 0 }))

  const r = await activar({
    tier: 'PRO',
    interval: 'monthly',
    payNow: false,
    offer: { kind: 'STANDARD_SIN_TARJETA', expectedFirstChargeCents: 0, quoteToken: opcion.quoteToken },
  })

  expect(r.status).toBe(200)
  expect(r.body.data).toMatchObject({ status: 'ACTIVE', sinTarjeta: true, tarjetaQueCobrara: null })
  const subs = Object.values(mockAlmacen.subs) as SubDelAlmacen[]
  expect(subs).toHaveLength(1)
  expect(subs[0]).toMatchObject({ status: 'trialing', default_payment_method: null, metadata: { sinTarjeta: 'true' } })
  expect(await filaDePro()).toEqual({ active: true, stripeSubscriptionId: subs[0].id })
  return subs[0]
}

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
  if (errores.length) throw new Error(`La limpieza de plan-offer.tu-plan no quedó completa:\n- ${errores.join('\n- ')}`)
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

describe('«Tu plan» con la prueba sin tarjeta, por HTTP (Postgres real)', () => {
  it('🔴 Review Focus 4: alta sin tarjeta → GET /plan SIN_TARJETA con su monto → POST billing-portal con flujo → el almacén simula al portal (predeterminada del cliente) → GET /plan CON_TARJETA ••••4242; el almacén tiene UNA sola suscripción', async () => {
    const sub = await altaSinTarjeta()
    const trialEndsAt = new Date(sub.trial_end * 1000).toISOString()

    const sinTarjeta = await leerPlan()

    expect(sinTarjeta.status).toBe(200)
    expect(sinTarjeta.body.data.origin).toMatchObject({ kind: 'CLASSIC', tier: 'PRO', subscriptionId: sub.id, faltaTarjeta: true })
    expect(sinTarjeta.body.data.cotizacion.versionNumber).toBe(2)
    expect(sinTarjeta.body.data.cotizacion.estadoDeLaPrueba).toEqual({
      estado: 'SIN_TARJETA',
      tier: 'PRO',
      interval: 'monthly',
      trialEndsAt,
      tarjeta: null,
      montoAlTerminarCents: PRO_M_V2,
    })
    // Comprar otro plan encima lo niega la regla común: «Tu plan» no ofrece ninguna compra, sólo «Poner mi tarjeta».
    expect(sinTarjeta.body.data.cotizacion.planes.PRO).toEqual({ displayName: 'Pro', vendible: false, monthly: null, annual: null })
    expect(sinTarjeta.body.data.cotizacion.planes.PREMIUM).toEqual({ displayName: 'Premium', vendible: false, monthly: null, annual: null })

    const portal = await ponerMiTarjeta()

    expect(portal.status).toBe(200)
    expect(portal.body).toEqual({ success: true, url: 'https://billing.stripe.test/p/tuplan' })
    expect(mockAlmacen.portales).toHaveLength(1)
    expect(mockAlmacen.portales[0]).toMatchObject({
      customer: negocio().customerId,
      return_url: REGRESO,
      flow_data: { type: 'payment_method_update', after_completion: { type: 'redirect', redirect: { return_url: REGRESO } } },
    })

    // La persona pone su tarjeta en la página de Stripe y vuelve.
    mockAlmacen.simularPortal(negocio().customerId, `pm_portal${stamp}`)

    const conTarjeta = await leerPlan()

    expect(conTarjeta.status).toBe(200)
    expect(conTarjeta.body.data.origin).toMatchObject({ kind: 'CLASSIC', tier: 'PRO', subscriptionId: sub.id })
    expect(conTarjeta.body.data.origin).not.toHaveProperty('faltaTarjeta')
    expect(conTarjeta.body.data.cotizacion.estadoDeLaPrueba).toEqual({
      estado: 'CON_TARJETA',
      tier: 'PRO',
      interval: 'monthly',
      trialEndsAt,
      tarjeta: { brand: 'visa', last4: '4242' },
      montoAlTerminarCents: PRO_M_V2,
    })
    // Una sola suscripción: el portal no abrió otra compra, y nadie escribió en la prueba (la tarjeta es la del cliente).
    expect(Object.keys(mockAlmacen.subs)).toHaveLength(1)
    expect(mockAlmacen.subs[sub.id]).toMatchObject({ status: 'trialing', default_payment_method: null })
    expect(mockAlmacen.escrituras).toEqual([])
    expect(await filaDePro()).toEqual({ active: true, stripeSubscriptionId: sub.id })
  })

  it('🔴 b2-r6 #4 por HTTP: el almacén cancela la prueba al vencer y después simula el portal → GET /plan TERMINADA, nunca CON_TARJETA', async () => {
    const sub = await altaSinTarjeta()

    // Terminó la prueba sin tarjeta: Stripe la cancela (`missing_payment_method: 'cancel'`) y la baja todavía no llega a la fila.
    Object.assign(mockAlmacen.subs[sub.id], { status: 'canceled', ended_at: sub.trial_end })
    // Después la persona pone una tarjeta en el portal: ya no hay prueba que la use.
    mockAlmacen.simularPortal(negocio().customerId, `pm_tarde${stamp}`)

    const plan = await leerPlan()

    expect(plan.status).toBe(200)
    expect(await filaDePro()).toEqual({ active: true, stripeSubscriptionId: sub.id })
    expect(plan.body.data.origin).toMatchObject({ kind: 'CLASSIC', tier: 'PRO' })
    expect(plan.body.data.origin).not.toHaveProperty('faltaTarjeta')
    expect(plan.body.data.cotizacion.estadoDeLaPrueba).toEqual({
      estado: 'TERMINADA',
      tier: 'PRO',
      interval: 'monthly',
      trialEndsAt: new Date(sub.trial_end * 1000).toISOString(),
      tarjeta: null,
      montoAlTerminarCents: null,
    })
    // Como Gratis: la compra normal de la vigente (hoy se paga el precio de la v2).
    expect(plan.body.data.cotizacion.planes.PRO.vendible).toBe(true)
    expect(plan.body.data.cotizacion.planes.PRO.monthly).toMatchObject({
      quoteToken: expect.any(String),
      precioCents: PRO_M_V2,
      firstChargeCents: PRO_M_V2,
      trialEndsAt: null,
    })
    expect(Object.keys(mockAlmacen.subs)).toHaveLength(1)
    expect(mockAlmacen.escrituras).toEqual([])
  })
})
