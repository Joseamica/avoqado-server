/*
  Planes editables B1, Task 2: el precio con el que «Tu plan» abre la sesión de Stripe, por la ruta real.
  Task 8: y el nombre — mientras Stripe muestre otro nombre del que publicó la oferta, 503 PLAN_RENAME_PENDING ANTES de la regla común.
  B2, Task 7: «Tu plan» cotiza con la versión (GET /plan → `cotizacion`) y la compra cita su comprobante (POST /plan/checkout).

  GET  /api/v1/dashboard/venues/:venueId/plan
  POST /api/v1/dashboard/venues/:venueId/plan/checkout  { tier: 'PRO', interval: 'monthly', quoteToken? }

  🔴 Lo que fija:
  - sin versiones y con sólo la v1 sembrada, la sesión lleva el precio de la LLAVE, exactamente como B0 (la v1 es una foto de lo de hoy y
    no cambia el cobro, aunque la llave se haya movido), `GET /plan` responde exactamente `getPlanState` y los campos nuevos del cuerpo
    (`quoteToken`, `acceptanceId`) se ignoran;
  - con una versión del editor la compra se abre con el comprobante de «Tu plan» (alcance `venue:<id>`): su priceId, su fin de prueba y
    la metadata de su versión; sin comprobante, 409 QUOTE_REQUIRED;
  - leer la oferta nunca tumba «Tu plan» (b2-r9 #8);
  - una prueba sin tarjeta viva la sigue negando la regla común (PLAN_YA_CONTRATADO); ya cancelada en Stripe, se compra normal (b2-r6 #4).

  Arranca el Express real: authenticateToken → checkPermission → validateRequest → controlador → servicio → resolver. La regla común de
  compra (`autorizarObligacionNueva`, probada en su suite) se simula en su borde y corre su callback; en los casos de la prueba sin tarjeta
  corre la REAL, con su inventario de Stripe simulado.
*/

process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret'
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/testdb?schema=public'

const mockPriceList = jest.fn()
const mockPriceRetrieve = jest.fn()
const mockSessionCreate = jest.fn()
const mockSessionList = jest.fn()
const mockProductRetrieve = jest.fn()
const mockSubRetrieve = jest.fn()
const mockSubList = jest.fn()
const mockCustomerRetrieve = jest.fn()
const mockCreatePreview = jest.fn()
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    prices: { list: mockPriceList, retrieve: mockPriceRetrieve },
    products: { retrieve: mockProductRetrieve },
    checkout: { sessions: { create: mockSessionCreate, list: mockSessionList, expire: jest.fn() } },
    subscriptions: { list: mockSubList, retrieve: mockSubRetrieve },
    customers: { create: jest.fn(), retrieve: mockCustomerRetrieve, retrieveSource: jest.fn() },
    paymentMethods: { retrieve: jest.fn() },
    invoices: { createPreview: mockCreatePreview },
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
// Lo que la regla común REAL lee de Stripe (sólo en los casos que la corren): lo vivo del negocio.
const mockInventario = jest.fn()
jest.mock('../../../src/services/access/inventarioDeObligaciones', () => ({
  ...jest.requireActual('../../../src/services/access/inventarioDeObligaciones'),
  inventarioDeObligaciones: (...a: unknown[]) => mockInventario(...a),
}))

import jwt from 'jsonwebtoken'
import request from 'supertest'

import { prismaMock } from '@tests/__helpers__/setup'
import { mirrorTokenRoleOnStaffVenue } from '@tests/__helpers__/venueRoleMock'
import { comprobanteDePrueba, definicionDePrueba, idsDeLaVersion, punteroA, versionUno } from '@tests/__helpers__/planOfferFixtures'
import type { CotizacionFirmable } from '@/services/billing/comprobanteDeCotizacion'
import { getPlanState } from '@/services/dashboard/planState.service'
import * as stripeService from '@/services/stripe.service'
import logger from '@/config/logger'

const app = require('../../../src/app').default
const { autorizarObligacionNueva: reglaComunReal } = jest.requireActual<
  typeof import('../../../src/services/access/autorizarObligacionNueva')
>('../../../src/services/access/autorizarObligacionNueva')

const venueId = 'clvenueplanoferta00000001'
const RUTA = `/api/v1/dashboard/venues/${venueId}/plan/checkout`
const DIA = 86_400_000
const H = 3_600_000
const PRO_M_HOY = 115884
const PRO_M_V2 = 92684 // 79900 + IVA

function token() {
  mirrorTokenRoleOnStaffVenue('OWNER', venueId)
  return jwt.sign({ sub: 'user_test', orgId: 'org_test', venueId, role: 'OWNER' }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })
}

const pedir = () => request(app).post(RUTA).set('Authorization', `Bearer ${token()}`).send({ tier: 'PRO', interval: 'monthly' })
const comprar = (cuerpo: object) =>
  request(app)
    .post(RUTA)
    .set('Authorization', `Bearer ${token()}`)
    .send({ tier: 'PRO', interval: 'monthly', ...cuerpo })
const leerPlan = () => request(app).get(`/api/v1/dashboard/venues/${venueId}/plan`).set('Authorization', `Bearer ${token()}`)

/** El precio con el que se abrió la sesión de Stripe. */
const lineItems = () => mockSessionCreate.mock.calls[0][0].line_items
/** El cuerpo de la sesión de Stripe que se abrió. */
const sesion = () => mockSessionCreate.mock.calls[0][0]

/** Un comprobante de «Tu plan» firmado para ESTE negocio: Pro mensual, hoy se paga el precio (sin prueba). */
const comprobanteDeTuPlan = (c: Partial<CotizacionFirmable> = {}) =>
  comprobanteDePrueba({
    alcance: `venue:${venueId}`,
    precioCents: PRO_M_V2,
    firstChargeCents: PRO_M_V2,
    trialEndsAt: null,
    ...c,
  })

type Planes = NonNullable<Parameters<typeof definicionDePrueba>[0]>['planes']
/** La v2 del editor: Pro mensual a $799 + IVA, lo demás como hoy. */
const v2 = (planes: Planes = {}) => definicionDePrueba({ ids: idsDeLaVersion('v2'), netos: { 'PRO:monthly': 79900 }, planes })
const conVigente = (number: number, definition: unknown) =>
  prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA(`cv${number}`, number, definition) as never)
/** El precio de Stripe de la v2 para Pro mensual, activo y del bruto de la versión. */
const precioV2 = () => mockPriceRetrieve.mockResolvedValue({ id: 'price_v2_pro_m', active: true, unit_amount: PRO_M_V2 })

/** Lo que `getPlanState` y la regla común leen del negocio (el alta ya terminó). */
const negocio = {
  id: venueId,
  stripeCustomerId: 'cus_1',
  seatCapExempt: false,
  organization: { seatCapExempt: false, onboardingCompletedAt: new Date('2026-01-01T00:00:00Z'), onboardingProgress: null },
}
/** La fila de una prueba regalada de Pro (sin Stripe) que termina en `horas` horas. */
const pruebaRegalada = (horas: number) => ({
  id: 'vf_regalada',
  active: true,
  endDate: new Date(Date.now() + horas * H),
  suspendedAt: null,
  gracePeriodEndsAt: null,
  monthlyPrice: null,
  stripeSubscriptionId: null,
  updatedAt: new Date(),
  feature: { code: 'PLAN_PRO', name: 'Plan Pro' },
})

beforeEach(() => {
  jest.clearAllMocks()
  mockPriceList.mockReset()
  mockPriceRetrieve.mockReset()
  mockProductRetrieve.mockReset()
  mockSessionCreate.mockReset().mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' })
  mockSessionList.mockReset().mockResolvedValue({ object: 'list', data: [], has_more: false })
  mockSubRetrieve.mockReset()
  mockSubList.mockReset().mockResolvedValue({ object: 'list', data: [], has_more: false })
  mockCustomerRetrieve.mockReset()
  mockCreatePreview.mockReset()
  mockInventario.mockReset().mockResolvedValue({ vivas: [], detalle: {}, conCambiosProgramados: [] })
  mockAutorizar
    .mockReset()
    .mockImplementation(async (_v: string, _c: string, _i: unknown, crear: (tx: unknown) => unknown) => crear(prismaMock))
  // checkPermission determinista: sin bypass de SUPERADMIN ni permisos propios.
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
  prismaMock.venue.findUnique.mockResolvedValue(null)
  prismaMock.venue.findFirst.mockResolvedValue({
    id: venueId,
    name: 'Negocio de prueba',
    slug: 'negocio-de-prueba',
    stripeCustomerId: 'cus_1',
    organizationId: 'org_test',
  } as never)
  prismaMock.venueFeature.findMany.mockResolvedValue([])
  prismaMock.feature.findFirst.mockResolvedValue({ id: 'feat-pro', code: 'PLAN_PRO', active: true } as never)
  prismaMock.planOfferPointer.findUnique.mockReset().mockResolvedValue(null)
  prismaMock.planAcceptance.findFirst.mockReset().mockResolvedValue(null)
})

afterEach(() => {
  jest.useRealTimers()
})

describe('POST /dashboard/venues/:venueId/plan/checkout — el precio de la sesión', () => {
  it('sin versiones, la sesión lleva el precio de la llave como hoy', async () => {
    mockPriceList.mockResolvedValue({ data: [{ id: 'price_key_pro_m', unit_amount: 115884 }] })

    const res = await pedir()

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ success: true, url: 'https://checkout.stripe.test/cs_1' })
    expect(lineItems()).toEqual([{ price: 'price_key_pro_m', quantity: 1 }])
    expect(mockPriceList.mock.calls[0][0]).toEqual({ lookup_keys: ['plan_pro_monthly'], limit: 1 })
    expect(mockPriceRetrieve).not.toHaveBeenCalled()
  })

  it('🔴 con sólo la v1 y la llave movida a price_llave_b (la foto archivada), la sesión abre con price_llave_b, como B0', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv1', 1, versionUno()) as never)
    mockPriceList.mockResolvedValue({ data: [{ id: 'price_llave_b', unit_amount: 115884 }] })
    mockPriceRetrieve.mockResolvedValue({ id: 'price_v1_pro_m', active: false, unit_amount: 115884 })

    const res = await pedir()

    expect(res.status).toBe(200)
    expect(lineItems()).toEqual([{ price: 'price_llave_b', quantity: 1 }])
    expect(mockPriceRetrieve).not.toHaveBeenCalled()
  })

  it('con la v2 vigente, la sesión lleva el priceId de la v2 y no lista la llave', async () => {
    // B2: con la v2 la compra cita el comprobante de «Tu plan» (la v2 conserva el monto de hoy de Pro mensual).
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, definicionDePrueba({ ids: idsDeLaVersion('v2') })) as never)
    mockPriceRetrieve.mockResolvedValue({ id: 'price_v2_pro_m', active: true, unit_amount: 115884 })

    const res = await comprar({ quoteToken: comprobanteDeTuPlan({ precioCents: PRO_M_HOY, firstChargeCents: PRO_M_HOY }) })

    expect(res.status).toBe(200)
    expect(lineItems()).toEqual([{ price: 'price_v2_pro_m', quantity: 1 }])
    expect(mockPriceList).not.toHaveBeenCalled()
    expect(mockPriceRetrieve).toHaveBeenCalledWith('price_v2_pro_m', { timeout: 15_000, maxNetworkRetries: 0 })
  })

  it('🔴 Codex b2-code #1: sin versión al entrar y la v2 publicada antes de resolver el precio (con el monto de hoy) → 409 OFFER_CHANGED reason VERSION, sin regla común ni sesión de Stripe', async () => {
    // La 1.ª lectura (la compuerta) no ve versión del editor; la relectura del precio ya ve la v2, que conserva el monto de hoy.
    prismaMock.planOfferPointer.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValue(punteroA('cv2', 2, definicionDePrueba({ ids: idsDeLaVersion('v2') })) as never)
    mockPriceRetrieve.mockResolvedValue({ id: 'price_v2_pro_m', active: true, unit_amount: PRO_M_HOY })
    mockPriceList.mockResolvedValue({ data: [{ id: 'price_key_pro_m', unit_amount: PRO_M_HOY }] })

    const res = await pedir()

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({
      code: 'OFFER_CHANGED',
      message: 'La oferta cambió. Revisa el precio antes de pagar. No se te cobró nada.',
      details: { reason: 'VERSION', offerVersion: 2 },
    })
    expect(mockAutorizar).not.toHaveBeenCalled()
    expect(mockSessionCreate).not.toHaveBeenCalled()
    expect(mockPriceRetrieve).not.toHaveBeenCalled()
    expect(mockPriceList).not.toHaveBeenCalled()
  })

  it('con la v2 vigente y su precio archivado → 503 PLAN_NOT_CONFIGURED y no se abre sesión', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, definicionDePrueba({ ids: idsDeLaVersion('v2') })) as never)
    mockPriceRetrieve.mockResolvedValue({ id: 'price_v2_pro_m', active: false, unit_amount: 115884 })

    const res = await comprar({ quoteToken: comprobanteDeTuPlan({ precioCents: PRO_M_HOY, firstChargeCents: PRO_M_HOY }) })

    expect(res.status).toBe(503)
    expect(res.body.code).toBe('PLAN_NOT_CONFIGURED')
    expect(mockSessionCreate).not.toHaveBeenCalled()
    expect(mockAutorizar).not.toHaveBeenCalled()
  })
})

describe('POST /dashboard/venues/:venueId/plan/checkout — el nombre del plan en Stripe (Task 8)', () => {
  beforeEach(() => {
    // El producto de Stripe de Pro (lo que la puerta lee para saber qué producto revisar).
    prismaMock.feature.findUnique.mockReset().mockResolvedValue({ stripeProductId: 'prod_pro' })
  })

  /** La v2 del editor: Pro se llama «Pro Plus» (con el mismo monto de hoy) y su producto de Stripe debe decir «Plan Avoqado Pro Plus». */
  const conProPlus = () => {
    const v2 = definicionDePrueba({ ids: idsDeLaVersion('v2'), nombres: { PRO: 'Pro Plus' }, productos: { PRO: 'Plan Avoqado Pro Plus' } })
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, v2) as never)
    mockPriceRetrieve.mockResolvedValue({ id: 'price_v2_pro_m', active: true, unit_amount: 115884 })
  }
  const conSuComprobante = () => comprar({ quoteToken: comprobanteDeTuPlan({ precioCents: PRO_M_HOY, firstChargeCents: PRO_M_HOY }) })

  it('🔴 con el renombre pendiente → 503 PLAN_RENAME_PENDING, sin checkout.sessions.create y sin vencer la sesión abierta de otra pestaña', async () => {
    conProPlus()
    mockProductRetrieve.mockResolvedValue({ id: 'prod_pro', name: 'Plan Avoqado Pro' })

    const res = await conSuComprobante()

    expect(res.status).toBe(503)
    expect(res.body).toMatchObject({
      code: 'PLAN_RENAME_PENDING',
      message: 'Estamos actualizando el nombre de tu plan. Intenta en un minuto. No se te cobró nada.',
    })
    expect(mockProductRetrieve).toHaveBeenCalledWith('prod_pro', { timeout: 15_000, maxNetworkRetries: 0 })
    // La puerta está ANTES de la regla común (la única que vence las sesiones abiertas): la de otra pestaña sigue viva.
    expect(mockAutorizar).not.toHaveBeenCalled()
    expect(mockSessionCreate).not.toHaveBeenCalled()
  })

  it('con el nombre al día abre la sesión como siempre', async () => {
    conProPlus()
    mockProductRetrieve.mockResolvedValue({ id: 'prod_pro', name: 'Plan Avoqado Pro Plus' })

    const res = await conSuComprobante()

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ success: true, url: 'https://checkout.stripe.test/cs_1' })
    expect(lineItems()).toEqual([{ price: 'price_v2_pro_m', quantity: 1 }])
    expect(mockProductRetrieve).toHaveBeenCalledTimes(1)
    expect(mockAutorizar).toHaveBeenCalledTimes(1)
  })

  it('🔴 con la v1 sembrada y products.retrieve fallando, la sesión abre igual (la puerta no lee Stripe)', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv1', 1, versionUno()) as never)
    mockPriceList.mockResolvedValue({ data: [{ id: 'price_key_pro_m', unit_amount: 115884 }] })
    mockProductRetrieve.mockRejectedValue(Object.assign(new Error('Stripe caído'), { type: 'StripeConnectionError' }))

    const res = await pedir()

    expect(res.status).toBe(200)
    expect(lineItems()).toEqual([{ price: 'price_key_pro_m', quantity: 1 }])
    expect(mockProductRetrieve).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// B2, Task 7: «Tu plan» cotiza con la versión y la compra cita su comprobante
// ---------------------------------------------------------------------------------------------------------------------

describe('GET /plan → POST /plan/checkout con la versión del editor (B2, Task 7)', () => {
  beforeEach(() => {
    prismaMock.venue.findUnique.mockResolvedValue(negocio as never)
  })

  it('🔴 GET /plan sin versión del editor: data es exactamente getPlanState, sin cotizacion', async () => {
    for (const filas of [[], [pruebaRegalada(10 * 24)]]) {
      prismaMock.venueFeature.findMany.mockResolvedValue(filas)

      const res = await leerPlan()

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data).not.toHaveProperty('cotizacion')
      expect(res.body.data).toEqual(JSON.parse(JSON.stringify(await getPlanState(venueId))))
    }
    // Ninguna llamada nueva a Stripe.
    expect(mockSubRetrieve).not.toHaveBeenCalled()
    expect(mockCreatePreview).not.toHaveBeenCalled()
    expect(mockSubList).not.toHaveBeenCalled()
  })

  it('🔴 fix round 2: GET /plan sin versión del editor (o con la oferta ilegible) lee la suscripción como hoy, retrievePlanSubscription(id) sin segundo argumento; con la v2, { conTarjeta: true, timeoutMs: 5000 } (Codex b2-code #7)', async () => {
    // Un negocio con Pro en Stripe, de HOY (con tarjeta, sin `sinTarjeta`).
    prismaMock.venueFeature.findMany.mockResolvedValue([
      { ...pruebaRegalada(-24), id: 'vf_pro', stripeSubscriptionId: 'sub_hoy', endDate: null },
    ])
    const periodo = Math.floor((Date.now() + 20 * DIA) / 1000)
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_hoy',
      object: 'subscription',
      customer: 'cus_1',
      status: 'active',
      created: periodo - 60 * 86_400,
      cancel_at_period_end: false,
      cancel_at: null,
      trial_end: null,
      default_payment_method: 'pm_de_hoy',
      metadata: {},
      discounts: [],
      items: {
        data: [{ current_period_end: periodo, price: { id: 'price_key_pro_m', unit_amount: PRO_M_HOY, recurring: { interval: 'month' } } }],
      },
    })
    const lecturas = jest.spyOn(stripeService, 'retrievePlanSubscription')
    try {
      for (const puntero of [null, punteroA('cv1', 1, versionUno()), punteroA('cv1', 1, { schemaVersion: 1, rota: true })]) {
        prismaMock.planOfferPointer.findUnique.mockResolvedValue(puntero as never)
        lecturas.mockClear()

        const res = await leerPlan()

        expect(res.status).toBe(200)
        expect(lecturas.mock.calls).toEqual([['sub_hoy']])
        expect(res.body.data).not.toHaveProperty('cotizacion')
        expect(res.body.data.origin).toMatchObject({ kind: 'CLASSIC', tier: 'PRO', subscriptionId: 'sub_hoy' })
        lecturas.mockClear()
        expect(res.body.data).toEqual(JSON.parse(JSON.stringify(await getPlanState(venueId))))
      }
      // Ninguna lectura de la tarjeta ni de la vista previa: sólo la suscripción, como hoy.
      expect(mockCustomerRetrieve).not.toHaveBeenCalled()
      expect(mockCreatePreview).not.toHaveBeenCalled()

      // Con la versión del editor, «Tu plan» pide la tarjeta de la prueba (una suscripción de hoy no lee nada más) y cotiza. 🔴 Codex
      // b2-code #7: la suscripción se lee con el tope corto (5 s, sin reintentos), como las demás lecturas informativas de la pantalla.
      conVigente(2, v2())
      lecturas.mockClear()
      mockSubRetrieve.mockClear()
      const conEditor = await leerPlan()
      expect(conEditor.status).toBe(200)
      expect(lecturas.mock.calls).toEqual([['sub_hoy', { conTarjeta: true, timeoutMs: 5_000 }]])
      expect(mockSubRetrieve.mock.calls).toEqual([
        ['sub_hoy', { expand: ['discounts.source.coupon.applies_to'] }, { timeout: 5_000, maxNetworkRetries: 0 }],
      ])
      expect(conEditor.body.data.cotizacion).toMatchObject({ versionNumber: 2 })
      expect(mockCustomerRetrieve).not.toHaveBeenCalled()
    } finally {
      lecturas.mockRestore()
    }
  })

  it('🔴 Codex b2-code #7: con la v2 y una prueba sin tarjeta viva, GET /plan lee la suscripción con el tope corto Y la tarjeta (Stripe no la tiene: SIN_TARJETA); si la suscripción no contesta, 200 degradado como hoy', async () => {
    conVigente(2, v2())
    const fin = Math.floor((Date.now() + 10 * DIA) / 1000)
    prismaMock.venueFeature.findMany.mockResolvedValue([
      { ...pruebaRegalada(10 * 24), id: 'vf_pro', stripeSubscriptionId: 'sub_prueba', endDate: new Date(fin * 1000) },
    ])
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_prueba',
      object: 'subscription',
      customer: 'cus_1',
      status: 'trialing',
      created: fin - 14 * 86_400,
      cancel_at_period_end: false,
      cancel_at: null,
      trial_end: fin,
      trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
      default_payment_method: null,
      default_source: null,
      metadata: { sinTarjeta: 'true', planOfferVersion: '2' },
      discounts: [],
      items: {
        data: [{ current_period_end: fin, price: { id: 'price_v2_pro_m', unit_amount: PRO_M_V2, recurring: { interval: 'month' } } }],
      },
    })
    // El cliente de Stripe vivo y sin tarjeta guardada; la vista previa del cobro al terminar.
    mockCustomerRetrieve.mockResolvedValue({ id: 'cus_1', object: 'customer', invoice_settings: { default_payment_method: null } })
    mockCreatePreview.mockResolvedValue({ amount_due: PRO_M_V2 })

    const plan = await leerPlan()

    expect(plan.status).toBe(200)
    expect(mockSubRetrieve.mock.calls).toEqual([
      ['sub_prueba', { expand: ['discounts.source.coupon.applies_to'] }, { timeout: 5_000, maxNetworkRetries: 0 }],
    ])
    expect(mockCustomerRetrieve).toHaveBeenCalledTimes(1)
    expect(plan.body.data.cotizacion.estadoDeLaPrueba).toMatchObject({ estado: 'SIN_TARJETA', tier: 'PRO', tarjeta: null })

    // La suscripción no contesta en 5 s: «Tu plan» sale igual, como hoy (sin las fechas ni el precio de Stripe, sin estado de la prueba).
    mockSubRetrieve
      .mockReset()
      .mockRejectedValue(
        Object.assign(new Error('Request aborted due to timeout being reached (5000ms)'), { type: 'StripeConnectionError' }),
      )
    mockCustomerRetrieve.mockClear()
    const degradado = await leerPlan()

    expect(degradado.status).toBe(200)
    expect(mockSubRetrieve).toHaveBeenCalledTimes(1)
    expect(degradado.body.data).toMatchObject({ currentPeriodEnd: null, interval: null })
    expect(degradado.body.data.cotizacion).not.toHaveProperty('estadoDeLaPrueba')
    expect(mockCustomerRetrieve).not.toHaveBeenCalled()
  })

  it('🔴 Codex b2-code r2 #7 + r3 R3-2: sólo con el puntero LEÍDO en una versión ≥ 2 de definición ilegible, GET /plan lee la suscripción con el tope corto y sin cotizacion (con Stripe lento, 200 degradado tras UNA llamada); con el puntero ilegible o una v1 dañada, la llamada de hoy', async () => {
    prismaMock.venueFeature.findMany.mockResolvedValue([
      { ...pruebaRegalada(-24), id: 'vf_pro', stripeSubscriptionId: 'sub_hoy', endDate: null },
    ])
    const periodo = Math.floor((Date.now() + 20 * DIA) / 1000)
    const deHoy = {
      id: 'sub_hoy',
      object: 'subscription',
      customer: 'cus_1',
      status: 'active',
      created: periodo - 60 * 86_400,
      cancel_at_period_end: false,
      cancel_at: null,
      trial_end: null,
      default_payment_method: 'pm_de_hoy',
      metadata: {},
      discounts: [],
      items: {
        data: [{ current_period_end: periodo, price: { id: 'price_key_pro_m', unit_amount: PRO_M_HOY, recurring: { interval: 'month' } } }],
      },
    }
    const lecturas = jest.spyOn(stripeService, 'retrievePlanSubscription')
    const tiempoAgotado = () =>
      Object.assign(new Error('Request aborted due to timeout being reached (5000ms)'), { type: 'StripeConnectionError' })
    try {
      for (const ilegible of [
        () => prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, { schemaVersion: 1, rota: true }) as never),
      ]) {
        ilegible()
        mockSubRetrieve.mockReset().mockResolvedValue(deHoy)
        lecturas.mockClear()
        jest.mocked(logger.warn).mockClear()

        const res = await leerPlan()

        expect(res.status).toBe(200)
        expect(res.body.data).not.toHaveProperty('cotizacion')
        expect(lecturas.mock.calls).toEqual([['sub_hoy', { timeoutMs: 5_000 }]])
        expect(mockSubRetrieve.mock.calls).toEqual([
          ['sub_hoy', { expand: ['discounts.source.coupon.applies_to'] }, { timeout: 5_000, maxNetworkRetries: 0 }],
        ])
        expect(res.body.data.origin).toMatchObject({ kind: 'CLASSIC', tier: 'PRO', subscriptionId: 'sub_hoy' })
        expect(jest.mocked(logger.warn)).toHaveBeenCalledWith(expect.stringContaining('«Tu plan»'), expect.objectContaining({ venueId }))

        // Stripe lento: UNA llamada con su tope y «Tu plan» sale igual, sin las fechas de Stripe.
        mockSubRetrieve.mockReset().mockRejectedValue(tiempoAgotado())
        const lento = await leerPlan()
        expect(lento.status).toBe(200)
        expect(mockSubRetrieve).toHaveBeenCalledTimes(1)
        expect(lento.body.data).toMatchObject({ currentPeriodEnd: null, interval: null })
        expect(lento.body.data).not.toHaveProperty('cotizacion')
      }

      // Con una v1 dañada, o con el puntero que no se puede leer (r3 R3-2: una lectura no se trata como un cobro), la llamada de hoy,
      // sin segundo argumento y sin cotizacion: el editor apagado no cambia ni en un estado anómalo.
      for (const deHoyIgual of [
        () =>
          prismaMock.planOfferPointer.findUnique
            .mockReset()
            .mockResolvedValue(punteroA('cv1', 1, { schemaVersion: 1, rota: true }) as never),
        () => prismaMock.planOfferPointer.findUnique.mockReset().mockRejectedValue(new Error('la base no contesta')),
      ]) {
        deHoyIgual()
        mockSubRetrieve.mockReset().mockResolvedValue(deHoy)
        lecturas.mockClear()
        const res = await leerPlan()
        expect(res.status).toBe(200)
        expect(res.body.data).not.toHaveProperty('cotizacion')
        expect(lecturas.mock.calls).toEqual([['sub_hoy']])
        expect(res.body.data).toMatchObject({ interval: 'month' })
      }
    } finally {
      lecturas.mockRestore()
    }
  })

  it('🔴 b2-r9 #8: GET /plan con una v1 dañada (versionQueCobra lanza) → 200 con getPlanState, sin cotizacion', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv1', 1, { schemaVersion: 1, rota: true }) as never)

    const res = await leerPlan()

    expect(res.status).toBe(200)
    expect(res.body.data).not.toHaveProperty('cotizacion')
    expect(res.body.data).toEqual(JSON.parse(JSON.stringify(await getPlanState(venueId))))
    expect(jest.mocked(logger.warn)).toHaveBeenCalledWith(expect.stringContaining('«Tu plan»'), expect.objectContaining({ venueId }))
  })

  it('B4: con la v2 «Plus», la descripción de la suscripción en la sesión dice «Plan Avoqado Plus - <negocio>»', async () => {
    conVigente(2, definicionDePrueba({ ids: idsDeLaVersion('v2'), netos: { 'PRO:monthly': 79900 }, nombres: { PRO: 'Plus' } }))
    precioV2()
    const plan = await leerPlan()
    const res = await comprar({ quoteToken: plan.body.data.cotizacion.planes.PRO.monthly.quoteToken })
    expect(res.status).toBe(200)
    expect(sesion().subscription_data.description).toMatch(/^Plan Avoqado Plus - /)
  })

  it('🔴 GET /plan de un negocio en Gratis → POST /plan/checkout con su quoteToken: line_items [{ price: "price_v2_pro_m" }], metadata { planOfferVersion: "2", planOfferPrecioDe: "2" }', async () => {
    conVigente(2, v2())
    precioV2()

    const plan = await leerPlan()

    expect(plan.status).toBe(200)
    const opcion = plan.body.data.cotizacion.planes.PRO.monthly
    expect(opcion).toMatchObject({ precioCents: PRO_M_V2, firstChargeCents: PRO_M_V2, trialEndsAt: null, quoteToken: expect.any(String) })

    const res = await comprar({ quoteToken: opcion.quoteToken })

    expect(res.status).toBe(200)
    expect(lineItems()).toEqual([{ price: 'price_v2_pro_m', quantity: 1 }])
    expect(sesion().metadata).toMatchObject({ planOfferVersion: '2', planOfferPrecioDe: '2', kind: 'PLAN_CHECKOUT', venueId })
    expect(sesion().subscription_data.metadata).toMatchObject({ planOfferVersion: '2', planOfferPrecioDe: '2', kind: 'PLAN_CHECKOUT' })
    expect(sesion().subscription_data.trial_end).toBeUndefined()
    // El precio es el de la versión (no las constantes de hoy), verificado en Stripe ANTES de la regla común.
    expect(mockPriceRetrieve).toHaveBeenCalledWith('price_v2_pro_m', { timeout: 15_000, maxNetworkRetries: 0 })
    expect(mockPriceRetrieve.mock.invocationCallOrder[0]).toBeLessThan(mockAutorizar.mock.invocationCallOrder[0])
    expect(mockPriceList).not.toHaveBeenCalled()
  })

  it('prueba regalada de Pro a 73 h: GET ofrece «$0 hoy»; POST a 47 h con ese comprobante → 409 QUOTE_EXPIRED; con un GET fresco el POST abre sin trial_end', async () => {
    const inicio = new Date()
    jest.useFakeTimers({
      now: inicio,
      doNotFake: [
        'nextTick',
        'setImmediate',
        'clearImmediate',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'queueMicrotask',
      ],
    })
    conVigente(2, v2())
    precioV2()
    const fila = pruebaRegalada(73)
    prismaMock.venueFeature.findMany.mockResolvedValue([fila])

    const hoyCero = (await leerPlan()).body.data.cotizacion.planes.PRO.monthly
    expect(hoyCero).toMatchObject({ firstChargeCents: 0, trialEndsAt: fila.endDate.toISOString() })

    // 26 h después (le quedan 47 h a la prueba): ese comprobante ya venció.
    jest.setSystemTime(new Date(inicio.getTime() + 26 * H))
    const vencido = await comprar({ quoteToken: hoyCero.quoteToken })
    expect(vencido.status).toBe(409)
    expect(vencido.body.code).toBe('QUOTE_EXPIRED')
    expect(mockSessionCreate).not.toHaveBeenCalled()

    // Con menos de 72 h ya no se ofrece «$0 hoy»: el GET fresco cobra hoy, y el checkout (menos de 48 h) abre sin prueba.
    const fresco = (await leerPlan()).body.data.cotizacion.planes.PRO.monthly
    expect(fresco).toMatchObject({ firstChargeCents: PRO_M_V2, trialEndsAt: null })
    const res = await comprar({ quoteToken: fresco.quoteToken })
    expect(res.status).toBe(200)
    expect(sesion().subscription_data.trial_end).toBeUndefined()
    expect(sesion().allow_promotion_codes).toBe(true)
    expect(sesion().success_url).not.toContain('sinCobroHoy')
  })

  it('🔴 con una prueba de Pro sin tarjeta viva, POST /plan/checkout de Pro con un comprobante de compra firmado para ese negocio → el 409 PLAN_YA_CONTRATADO de la regla común', async () => {
    conVigente(2, v2())
    precioV2()
    prismaMock.$queryRaw.mockResolvedValue([{ tomado: true }])
    prismaMock.venueFeature.findMany.mockResolvedValue([{ ...pruebaRegalada(14 * 24), id: 'vf_pro', stripeSubscriptionId: 'sub_prueba' }])
    // La regla común REAL: Stripe tiene viva la prueba sin tarjeta de Pro.
    mockAutorizar.mockImplementation(reglaComunReal)
    mockInventario.mockResolvedValue({
      vivas: [{ subscriptionId: 'sub_prueba', proyecciones: [{ tipo: 'PLAN', tier: 'PRO' }] }],
      detalle: {},
      conCambiosProgramados: [],
    })

    const res = await comprar({ quoteToken: comprobanteDeTuPlan() })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PLAN_YA_CONTRATADO')
    expect(mockInventario).toHaveBeenCalledWith(venueId, expect.anything())
    expect(mockSessionCreate).not.toHaveBeenCalled()
  })

  it('🔴 b2-r6 #4: con esa prueba ya canceled en Stripe y la fila activa, GET /plan TERMINADA → POST /plan/checkout con su quoteToken abre la compra normal', async () => {
    conVigente(2, v2())
    precioV2()
    prismaMock.$queryRaw.mockResolvedValue([{ tomado: true }])
    const fin = Math.floor((Date.now() - DIA) / 1000)
    prismaMock.venueFeature.findMany.mockResolvedValue([
      { ...pruebaRegalada(14 * 24), id: 'vf_pro', stripeSubscriptionId: 'sub_prueba', endDate: new Date(Date.now() + 14 * DIA) },
    ])
    // Stripe ya la canceló (terminó sin tarjeta) y la baja todavía no llegó: la fila sigue activa.
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_prueba',
      object: 'subscription',
      customer: 'cus_1',
      status: 'canceled',
      created: fin - 14 * 86_400,
      ended_at: fin,
      cancel_at_period_end: false,
      cancel_at: null,
      trial_end: fin,
      trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
      default_payment_method: null,
      metadata: { sinTarjeta: 'true', planOfferVersion: '2' },
      discounts: [],
      items: {
        data: [{ current_period_end: fin, price: { id: 'price_v2_pro_m', unit_amount: PRO_M_V2, recurring: { interval: 'month' } } }],
      },
    })

    const plan = await leerPlan()

    expect(plan.status).toBe(200)
    expect(plan.body.data.origin).toMatchObject({ kind: 'CLASSIC', tier: 'PRO' })
    expect(plan.body.data.cotizacion.estadoDeLaPrueba).toMatchObject({ estado: 'TERMINADA', tier: 'PRO', tarjeta: null })
    const opcion = plan.body.data.cotizacion.planes.PRO.monthly
    expect(opcion).toMatchObject({ precioCents: PRO_M_V2, firstChargeCents: PRO_M_V2, trialEndsAt: null })

    // La regla común REAL ya no cuenta la cancelada: el checkout abre.
    mockAutorizar.mockImplementation(reglaComunReal)
    const res = await comprar({ quoteToken: opcion.quoteToken })

    expect(res.status).toBe(200)
    expect(lineItems()).toEqual([{ price: 'price_v2_pro_m', quantity: 1 }])
    expect(sesion().metadata).toMatchObject({ planOfferVersion: '2', planOfferPrecioDe: '2' })
    expect(mockCreatePreview).not.toHaveBeenCalled()
  })

  it('con la v2 y sin quoteToken → 409 OFFER_CHANGED reason QUOTE_REQUIRED; sin versión del editor el cuerpo viejo abre como hoy', async () => {
    conVigente(2, v2())
    precioV2()

    const sinComprobante = await pedir()

    expect(sinComprobante.status).toBe(409)
    expect(sinComprobante.body).toMatchObject({
      code: 'OFFER_CHANGED',
      message: 'La oferta cambió. Revisa el precio antes de pagar. No se te cobró nada.',
      details: { reason: 'QUOTE_REQUIRED', offerVersion: 2 },
    })
    expect(mockAutorizar).not.toHaveBeenCalled()
    expect(mockSessionCreate).not.toHaveBeenCalled()

    prismaMock.planOfferPointer.findUnique.mockResolvedValue(null)
    mockPriceList.mockResolvedValue({ data: [{ id: 'price_key_pro_m', unit_amount: PRO_M_HOY }] })
    const deHoy = await pedir()
    expect(deHoy.status).toBe(200)
    expect(lineItems()).toEqual([{ price: 'price_key_pro_m', quantity: 1 }])
  })

  it.each([
    ['quoteToken null', { quoteToken: null }],
    ['quoteToken texto', { quoteToken: 'hola' }],
    ['acceptanceId que no es cuid', { acceptanceId: 'x' }],
  ])('🔴 sin versión del editor, el checkout con %s abre como hoy (el campo se ignora)', async (_n, extra) => {
    mockPriceList.mockResolvedValue({ data: [{ id: 'price_key_pro_m', unit_amount: PRO_M_HOY }] })

    const res = await comprar(extra)

    expect(res.status).toBe(200)
    expect(lineItems()).toEqual([{ price: 'price_key_pro_m', quantity: 1 }])
    expect(sesion().metadata).toEqual({ kind: 'PLAN_CHECKOUT', venueId, tierCode: 'PLAN_PRO', interval: 'monthly' })
    expect(mockPriceRetrieve).not.toHaveBeenCalled()
  })

  it('🔴 Pro fuera de venta y sin prueba → 409 PLAN_NOT_ON_SALE; con una prueba regalada vigente de Pro → abre (§11 F)', async () => {
    conVigente(2, v2({ PRO: { onSale: false } }))
    precioV2()

    const fueraDeVenta = await comprar({ quoteToken: comprobanteDeTuPlan() })

    expect(fueraDeVenta.status).toBe(409)
    expect(fueraDeVenta.body).toMatchObject({
      code: 'PLAN_NOT_ON_SALE',
      message: 'El plan Pro ya no está a la venta. Elige otro plan. No se te cobró nada.',
      details: { tier: 'PRO' },
    })
    expect(mockSessionCreate).not.toHaveBeenCalled()

    // Con una prueba regalada vigente de Pro, quedarse con Pro se puede: «$0 hoy» y el primer cobro al fin de la prueba.
    const fila = pruebaRegalada(10 * 24)
    prismaMock.venueFeature.findMany.mockResolvedValue([fila])
    const opcion = (await leerPlan()).body.data.cotizacion.planes.PRO.monthly
    expect(opcion).toMatchObject({ firstChargeCents: 0, trialEndsAt: fila.endDate.toISOString() })

    const res = await comprar({ quoteToken: opcion.quoteToken })

    expect(res.status).toBe(200)
    expect(sesion().subscription_data.trial_end).toBe(Math.floor(fila.endDate.getTime() / 1000))
    expect(sesion().allow_promotion_codes).toBe(false)
    expect(sesion().success_url).toContain('sinCobroHoy=1')
  })

  it('🔴 fix round 1, paso 5: el editor publica la v3 entre el comprobante y la regla común → dentro del candado 409 OFFER_CHANGED reason VERSION con offerVersion 3 y ninguna sesión de Stripe; la prueba regalada acortada dentro del candado → 409 PRUEBA_CERCA', async () => {
    conVigente(2, v2())
    precioV2()
    // La regla común (simulada) toma su candado y ENTONCES corre lo de dentro: es justo ahí cuando la v3 ya está publicada.
    mockAutorizar.mockImplementation(async (_v: string, _c: string, _i: unknown, crear: (tx: unknown) => unknown) => {
      conVigente(3, definicionDePrueba({ ids: idsDeLaVersion('v3'), netos: { 'PRO:monthly': 79900 } }))
      return crear(prismaMock)
    })

    const res = await comprar({ quoteToken: comprobanteDeTuPlan() })

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ code: 'OFFER_CHANGED', details: { reason: 'VERSION', offerVersion: 3 } })
    // Los pasos 1-4 sí pasaron con la v2 (el comprobante, la opción, el precio de Stripe): lo detuvo la relectura bajo el candado.
    expect(mockPriceRetrieve).toHaveBeenCalledWith('price_v2_pro_m', { timeout: 15_000, maxNetworkRetries: 0 })
    expect(mockAutorizar).toHaveBeenCalledTimes(1)
    expect(mockSessionCreate).not.toHaveBeenCalled()

    // La misma versión, pero dentro del candado la prueba regalada ya no deja diferir (el SUPERADMIN la acortó a 30 h).
    conVigente(2, v2())
    const fila = pruebaRegalada(10 * 24)
    prismaMock.venueFeature.findMany.mockResolvedValue([fila])
    const opcion = (await leerPlan()).body.data.cotizacion.planes.PRO.monthly as { quoteToken: string; trialEndsAt: string }
    expect(opcion.trialEndsAt).toBe(fila.endDate.toISOString())
    mockAutorizar.mockImplementation(async (_v: string, _c: string, _i: unknown, crear: (tx: unknown) => unknown) => {
      prismaMock.venueFeature.findMany.mockResolvedValue([{ ...fila, endDate: new Date(Date.now() + 30 * H) }])
      return crear(prismaMock)
    })

    const acortada = await comprar({ quoteToken: opcion.quoteToken })

    expect(acortada.status).toBe(409)
    expect(acortada.body).toMatchObject({ code: 'OFFER_CHANGED', details: { reason: 'PRUEBA_CERCA', offerVersion: 2 } })
    expect(mockSessionCreate).not.toHaveBeenCalled()
  })

  it('🔴 Codex b2-code #3: el paso 0 no ve aceptación; la conversión de la demo guarda la suya antes del candado → dentro del candado, la relectura de la base da 409 PLAN_ACCEPTANCE_REQUIRED con sus datos, sin sesión de Stripe', async () => {
    conVigente(2, v2())
    precioV2()
    const aceptacion = { id: 'clacepta0000000000000001', tier: 'PREMIUM', interval: 'monthly' }
    // La regla común (simulada) toma su candado y ENTONCES corre lo de dentro: para entonces la conversión ya guardó su aceptación.
    mockAutorizar.mockImplementation(async (_v: string, _c: string, _i: unknown, crear: (tx: unknown) => unknown) => {
      prismaMock.planAcceptance.findFirst.mockResolvedValue(aceptacion as never)
      return crear(prismaMock)
    })

    const res = await comprar({ quoteToken: comprobanteDeTuPlan() })

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({
      code: 'PLAN_ACCEPTANCE_REQUIRED',
      message: 'Termina la contratación que empezaste al convertir tu negocio, o espera 30 minutos.',
      details: { acceptanceId: aceptacion.id, tier: 'PREMIUM', interval: 'monthly' },
    })
    expect(mockAutorizar).toHaveBeenCalledTimes(1)
    expect(mockSessionCreate).not.toHaveBeenCalled()
    // La relectura es sólo de la base: Stripe no se consulta dentro del candado para saber si ya se usó.
    expect(mockSubList).not.toHaveBeenCalled()
    expect(prismaMock.planAcceptance.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { venueId, expiresAt: { gt: expect.any(Date) } } }),
    )
  })

  it('comprobante de otra versión → 409 OFFER_CHANGED reason VERSION; de otro negocio → 400 QUOTE_INVALID; con el renombre pendiente, 503 PLAN_RENAME_PENDING', async () => {
    conVigente(3, definicionDePrueba({ ids: idsDeLaVersion('v3'), netos: { 'PRO:monthly': 79900 } }))
    mockPriceRetrieve.mockResolvedValue({ id: 'price_v3_pro_m', active: true, unit_amount: PRO_M_V2 })

    const deOtraVersion = await comprar({ quoteToken: comprobanteDeTuPlan({ versionNumber: 2 }) })
    expect(deOtraVersion.status).toBe(409)
    expect(deOtraVersion.body).toMatchObject({ code: 'OFFER_CHANGED', details: { reason: 'VERSION', offerVersion: 3 } })

    const deOtroNegocio = await comprar({
      quoteToken: comprobanteDeTuPlan({ versionNumber: 3, alcance: 'venue:clotronegocio00000000001' }),
    })
    expect(deOtroNegocio.status).toBe(400)
    expect(deOtroNegocio.body.code).toBe('QUOTE_INVALID')
    expect(mockSessionCreate).not.toHaveBeenCalled()

    // La v3 renombra Pro y Stripe todavía dice el nombre viejo: 503 ANTES de la regla común.
    conVigente(
      3,
      definicionDePrueba({
        ids: idsDeLaVersion('v3'),
        netos: { 'PRO:monthly': 79900 },
        nombres: { PRO: 'Pro Plus' },
        productos: { PRO: 'Plan Avoqado Pro Plus' },
      }),
    )
    prismaMock.feature.findUnique.mockReset().mockResolvedValue({ stripeProductId: 'prod_pro' })
    mockProductRetrieve.mockResolvedValue({ id: 'prod_pro', name: 'Plan Avoqado Pro' })
    const renombre = await comprar({ quoteToken: comprobanteDeTuPlan({ versionNumber: 3 }) })
    expect(renombre.status).toBe(503)
    expect(renombre.body.code).toBe('PLAN_RENAME_PENDING')
    expect(mockAutorizar).not.toHaveBeenCalled()
    expect(mockSessionCreate).not.toHaveBeenCalled()
  })
})
