/*
  Planes editables B2, Task 8: la conversión de demo guarda su aceptación con el CAS y el checkout sólo usa ésa, por la ruta real.

  POST /api/v1/dashboard/venues/:venueId/convert-from-demo  { ...documentos, plan? }
  POST /api/v1/dashboard/venues/:venueId/plan/checkout      { tier, interval, quoteToken?, acceptanceId? }
  GET  /api/v1/dashboard/venues/:venueId/plan

  🔴 Lo que fija:
  - sin versión del editor, `plan` se ignora (con `null` o un texto también) y la conversión es la de hoy;
  - con la v2, la conversión revisa el comprobante, convierte con el CAS y guarda la aceptación (`data.planAcceptance`), y el checkout
    con ese `acceptanceId` abre con la versión ACEPTADA (aunque ya no sea la vigente, aunque la vigente no venda ningún plan) y el
    precio de la aceptación, con `metadata.planAcceptanceId` en la sesión y en la suscripción;
  - el comprobante de la aceptación se verifica con la hora en que se validó (b2-r2 #8): una aceptación nunca nace inservible;
  - con una aceptación viva y sin usar, el checkout sin `acceptanceId` responde 409 PLAN_ACCEPTANCE_REQUIRED con lo necesario para
    retomarla, ANTES de revisar su comprobante (P8); usada (b2-r9 #5) o vencida, el checkout normal abre.

  Arranca el Express real: authenticateToken → checkPermission → validateRequest → controlador → servicio. La limpieza del demo
  (`cleanDemoData`, con su suite) y el aviso al superadmin se simulan en su borde. La regla común de compra (`autorizarObligacionNueva`,
  probada en su suite) se simula en su borde y corre su callback. La `PlanAcceptance` vive en un almacén en memoria sobre `prismaMock`.
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
const mockCleanDemoData = jest.fn()
jest.mock('../../../src/services/onboarding/demoCleanup.service', () => ({
  ...jest.requireActual('../../../src/services/onboarding/demoCleanup.service'),
  cleanDemoData: (...a: unknown[]) => mockCleanDemoData(...a),
}))
jest.mock('../../../src/services/superadmin/kycReview.service', () => ({
  ...jest.requireActual('../../../src/services/superadmin/kycReview.service'),
  notifySuperadminsNewKycSubmission: jest.fn().mockResolvedValue(undefined),
}))

import jwt from 'jsonwebtoken'
import request from 'supertest'

import { prismaMock } from '@tests/__helpers__/setup'
import { mirrorTokenRoleOnStaffVenue } from '@tests/__helpers__/venueRoleMock'
import { comprobanteDePrueba, definicionDePrueba, idsDeLaVersion, punteroA } from '@tests/__helpers__/planOfferFixtures'
import type { CotizacionFirmable } from '@/services/billing/comprobanteDeCotizacion'
import logger from '@/config/logger'

const app = require('../../../src/app').default

const venueId = 'clvenuedemooferta00000001'
const BASE = `/api/v1/dashboard/venues/${venueId}`
const MIN = 60_000
const H = 3_600_000
const PRO_M_V2 = 92684 // 79900 + IVA
const PRO_M_V3 = 104284 // 89900 + IVA
const PREMIUM_M_HOY = 197084 // 169900 + IVA

function token() {
  mirrorTokenRoleOnStaffVenue('OWNER', venueId)
  return jwt.sign({ sub: 'user_test', orgId: 'org_test', venueId, role: 'OWNER' }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })
}

const documentos = {
  entityType: 'PERSONA_FISICA',
  idDocumentUrl: 'https://example.com/id.pdf',
  rfcDocumentUrl: 'https://example.com/rfc.pdf',
  comprobanteDomicilioUrl: 'https://example.com/domicilio.pdf',
  caratulaBancariaUrl: 'https://example.com/caratula.pdf',
}
const convertir = (extra: object = {}) =>
  request(app)
    .post(`${BASE}/convert-from-demo`)
    .set('Authorization', `Bearer ${token()}`)
    .send({ ...documentos, ...extra })
const comprar = (cuerpo: object) =>
  request(app)
    .post(`${BASE}/plan/checkout`)
    .set('Authorization', `Bearer ${token()}`)
    .send({ tier: 'PRO', interval: 'monthly', ...cuerpo })
const leerPlan = () => request(app).get(`${BASE}/plan`).set('Authorization', `Bearer ${token()}`)

/** La sesión de Stripe número `i` que se abrió. */
const sesion = (i = 0) => mockSessionCreate.mock.calls[i][0]

/** Un comprobante de «Tu plan» de ESTE negocio: Pro mensual de la v2, hoy se paga el precio (sin prueba). */
const comprobante = (c: Partial<CotizacionFirmable> = {}, emitido?: Date) =>
  comprobanteDePrueba(
    { alcance: `venue:${venueId}`, versionNumber: 2, precioCents: PRO_M_V2, firstChargeCents: PRO_M_V2, trialEndsAt: null, ...c },
    emitido,
  )
const planPro = (quoteToken: string = comprobante()) => ({ plan: { tier: 'PRO', interval: 'monthly', quoteToken } })

type Planes = NonNullable<Parameters<typeof definicionDePrueba>[0]>['planes']
/** La v2 del editor: Pro mensual a $799 + IVA; lo demás como hoy. */
const v2 = () => definicionDePrueba({ ids: idsDeLaVersion('v2'), netos: { 'PRO:monthly': 79900 } })
/** La v3: Pro mensual a $899 + IVA (otro precio de Stripe). */
const v3 = (planes: Planes = {}) => definicionDePrueba({ ids: idsDeLaVersion('v3'), netos: { 'PRO:monthly': 89900 }, planes })

/** Las versiones publicadas (para `ofertaPorNumero`) y la vigente (para el puntero). */
const versiones = new Map<number, { id: string; definition: unknown }>()
function publicar(number: number, definition: unknown) {
  versiones.set(number, { id: `cv${number}`, definition })
  prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA(`cv${number}`, number, definition) as never)
}

/** Los precios de Stripe: activos y del bruto de su versión. */
const PRECIOS: Record<string, number> = {
  price_v2_pro_m: PRO_M_V2,
  price_v3_pro_m: PRO_M_V3,
  price_v2_premium_m: PREMIUM_M_HOY,
}

/** El almacén de `PlanAcceptance` (lo que la conversión crea dentro de su transacción y lo que el checkout lee). */
type Aceptacion = {
  id: string
  venueId: string
  offerVersionId: string
  tier: string
  interval: string
  quoteToken: string
  validadoAt: Date
  createdById: string
  createdAt: Date
  expiresAt: Date
}
let aceptaciones: Aceptacion[] = []

const negocio = {
  id: venueId,
  stripeCustomerId: 'cus_1',
  seatCapExempt: false,
  organization: { seatCapExempt: false, onboardingCompletedAt: new Date('2026-01-01T00:00:00Z'), onboardingProgress: null },
}
const delDemo = {
  id: venueId,
  name: 'Negocio demo de prueba',
  slug: 'negocio-demo-de-prueba',
  status: 'TRIAL',
  stripeCustomerId: 'cus_1',
  organizationId: 'org_test',
}

const sinRelojes = [
  'nextTick',
  'setImmediate',
  'clearImmediate',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'queueMicrotask',
] as const

beforeEach(() => {
  jest.clearAllMocks()
  aceptaciones = []
  versiones.clear()
  mockPriceList.mockReset()
  mockPriceRetrieve.mockReset().mockImplementation(async (id: string) => ({ id, active: true, unit_amount: PRECIOS[id] }))
  mockProductRetrieve.mockReset()
  mockSessionCreate
    .mockReset()
    .mockImplementation(async () => ({ id: `cs_${mockSessionCreate.mock.calls.length}`, url: 'https://checkout.stripe.test/cs' }))
  mockSessionList.mockReset().mockResolvedValue({ object: 'list', data: [], has_more: false })
  mockSubRetrieve.mockReset()
  mockSubList.mockReset().mockResolvedValue({ object: 'list', data: [], has_more: false })
  mockCustomerRetrieve.mockReset()
  mockCreatePreview.mockReset()
  mockCleanDemoData.mockReset().mockResolvedValue({ deletedOrders: 0, deletedPayments: 0, canalesEnLineaSinTarifa: [] })
  mockAutorizar
    .mockReset()
    .mockImplementation(async (_v: string, _c: string, _i: unknown, crear: (tx: unknown) => unknown) => crear(prismaMock))
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
  prismaMock.venue.findUnique.mockResolvedValue(negocio as never)
  prismaMock.venue.findFirst.mockResolvedValue(delDemo as never)
  prismaMock.venue.update.mockResolvedValue({ ...delDemo, status: 'PENDING_ACTIVATION', features: [] } as never)
  prismaMock.venue.updateMany.mockReset().mockResolvedValue({ count: 1 } as never)
  prismaMock.venue.findUniqueOrThrow.mockResolvedValue({ ...delDemo, status: 'PENDING_ACTIVATION', features: [] } as never)
  prismaMock.venueFeature.findMany.mockResolvedValue([])
  prismaMock.feature.findFirst.mockImplementation((async (a: { where: { code: string } }) => ({
    id: `feat-${a.where.code}`,
    code: a.where.code,
    active: true,
  })) as never)
  prismaMock.planOfferPointer.findUnique.mockReset().mockResolvedValue(null)
  prismaMock.planOfferVersion.findFirst.mockReset().mockImplementation((async (a: { where: { number: number } }) => {
    const v = versiones.get(a.where.number)
    return v ? { id: v.id, number: a.where.number, status: 'SUPERSEDED', definition: v.definition } : null
  }) as never)
  prismaMock.planAcceptance.create.mockReset().mockImplementation((async (a: { data: Omit<Aceptacion, 'id' | 'createdAt'> }) => {
    const fila = { ...a.data, id: `clacept${String(aceptaciones.length + 1).padStart(18, '0')}`, createdAt: new Date() }
    aceptaciones.push(fila)
    return fila
  }) as never)
  prismaMock.planAcceptance.findFirst.mockReset().mockImplementation((async (a: {
    where: { id?: string; venueId: string; expiresAt?: { gt: Date } }
  }) => {
    const vivas = aceptaciones.filter(
      f =>
        f.venueId === a.where.venueId &&
        (a.where.id === undefined || f.id === a.where.id) &&
        (a.where.expiresAt === undefined || f.expiresAt.getTime() > a.where.expiresAt.gt.getTime()),
    )
    const fila = vivas[vivas.length - 1]
    if (!fila) return null
    const number = [...versiones.entries()].find(([, v]) => v.id === fila.offerVersionId)?.[0] ?? null
    return { ...fila, offerVersion: { number } }
  }) as never)
})

afterEach(() => {
  jest.useRealTimers()
})

describe('POST convert-from-demo → POST plan/checkout con la aceptación (B2, Task 8)', () => {
  it('🔴 POST convert-from-demo con plan → 200 con planAcceptance; POST plan/checkout con acceptanceId → la sesión con el precio de la aceptación', async () => {
    publicar(2, v2())

    const conversion = await convertir(planPro())

    expect(conversion.status).toBe(200)
    expect(conversion.body.data.status).toBe('PENDING_ACTIVATION')
    expect(conversion.body.data.planAcceptance).toEqual({ id: aceptaciones[0].id, expiresAt: aceptaciones[0].expiresAt.toISOString() })
    expect(aceptaciones[0]).toMatchObject({ venueId, offerVersionId: 'cv2', tier: 'PRO', interval: 'monthly', createdById: 'user_test' })
    // El CAS, no el `update` de hoy.
    expect(prismaMock.venue.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: venueId, status: 'TRIAL' } }))
    expect(prismaMock.venue.update).not.toHaveBeenCalled()

    const res = await comprar({ acceptanceId: conversion.body.data.planAcceptance.id })

    expect(res.status).toBe(200)
    expect(sesion().line_items).toEqual([{ price: 'price_v2_pro_m', quantity: 1 }])
    expect(sesion().metadata).toMatchObject({
      planOfferVersion: '2',
      planOfferPrecioDe: '2',
      planAcceptanceId: aceptaciones[0].id,
      kind: 'PLAN_CHECKOUT',
      venueId,
    })
    expect(sesion().subscription_data.metadata).toMatchObject({ planOfferVersion: '2', planAcceptanceId: aceptaciones[0].id })
    expect(sesion().subscription_data.trial_end).toBeUndefined()
    expect(mockPriceRetrieve).toHaveBeenCalledWith('price_v2_pro_m', { timeout: 15_000, maxNetworkRetries: 0 })
    expect(mockPriceRetrieve.mock.invocationCallOrder[0]).toBeLessThan(mockAutorizar.mock.invocationCallOrder[0])
  })

  it('🔴 se publica la v3 entre la conversión y el checkout (dentro de 30 min) → el checkout usa la v2 de la aceptación', async () => {
    publicar(2, v2())
    const conversion = await convertir(planPro())
    expect(conversion.status).toBe(200)

    publicar(3, v3())
    const res = await comprar({ acceptanceId: conversion.body.data.planAcceptance.id })

    expect(res.status).toBe(200)
    expect(sesion().line_items).toEqual([{ price: 'price_v2_pro_m', quantity: 1 }])
    expect(sesion().metadata).toMatchObject({ planOfferVersion: '2', planOfferPrecioDe: '2', planAcceptanceId: aceptaciones[0].id })
    expect(mockPriceRetrieve).toHaveBeenCalledWith('price_v2_pro_m', expect.anything())
    expect(mockPriceRetrieve).not.toHaveBeenCalledWith('price_v3_pro_m', expect.anything())
  })

  it('🔴 b2-r2 #8: el comprobante tenía 23 h 59 min 50 s al convertir y la limpieza tarda 20 s → la aceptación nace viva y el checkout la acepta (se verifica con validadoAt)', async () => {
    const conversionEn = new Date('2026-11-26T18:00:00.000Z')
    jest.useFakeTimers({ now: conversionEn, doNotFake: [...sinRelojes] })
    publicar(2, v2())
    const emitido = new Date(conversionEn.getTime() - (24 * H - 10_000))
    mockCleanDemoData.mockImplementation(async () => {
      jest.setSystemTime(new Date(conversionEn.getTime() + 20_000))
      return { deletedOrders: 4, deletedPayments: 4, canalesEnLineaSinTarifa: [] }
    })

    const conversion = await convertir(planPro(comprobante({}, emitido)))

    expect(conversion.status).toBe(200)
    expect(aceptaciones[0].validadoAt).toEqual(conversionEn)
    expect(aceptaciones[0].expiresAt).toEqual(new Date(conversionEn.getTime() + 30 * MIN))

    // Ya pasaron 24 h y 10 s desde la emisión: con la hora de ahora el comprobante habría vencido.
    const res = await comprar({ acceptanceId: conversion.body.data.planAcceptance.id })

    expect(res.status).toBe(200)
    expect(sesion().line_items).toEqual([{ price: 'price_v2_pro_m', quantity: 1 }])
  })

  it('🔴 con una aceptación viva, el checkout sin acceptanceId → 409 PLAN_ACCEPTANCE_REQUIRED con details { acceptanceId, tier, interval }; con otro plan → 409 OFFER_CHANGED reason QUOTE_MISMATCH', async () => {
    publicar(2, v2())
    const conversion = await convertir(planPro())
    const acceptanceId = conversion.body.data.planAcceptance.id

    // P8: antes que el comprobante (aquí ni lo trae: sin la aceptación pendiente sería QUOTE_REQUIRED).
    const sinAceptacion = await comprar({})

    expect(sinAceptacion.status).toBe(409)
    expect(sinAceptacion.body).toMatchObject({
      code: 'PLAN_ACCEPTANCE_REQUIRED',
      message: 'Termina la contratación que empezaste al convertir tu negocio, o espera 30 minutos.',
      details: { acceptanceId, tier: 'PRO', interval: 'monthly' },
    })
    // Con una aceptación viva, sin usar, «¿ya se usó?» se lee de Stripe con las opciones de compra (sin el tope de las lecturas).
    expect(mockSubList).toHaveBeenCalledWith({ customer: 'cus_1', status: 'all', limit: 100 }, {})

    const otroPlan = await comprar({ tier: 'PREMIUM', acceptanceId })
    expect(otroPlan.status).toBe(409)
    expect(otroPlan.body).toMatchObject({ code: 'OFFER_CHANGED', details: { reason: 'QUOTE_MISMATCH', offerVersion: 2 } })
    const otraPeriodicidad = await comprar({ interval: 'annual', acceptanceId })
    expect(otraPeriodicidad.body).toMatchObject({ code: 'OFFER_CHANGED', details: { reason: 'QUOTE_MISMATCH', offerVersion: 2 } })

    expect(mockAutorizar).not.toHaveBeenCalled()
    expect(mockSessionCreate).not.toHaveBeenCalled()
  })

  it('🔴 b2-r7 #4 por la ruta: convert-from-demo confirma y la respuesta se pierde; POST plan/checkout con el comprobante normal → 409 con details; POST con ese acceptanceId → la sesión con el precio de la aceptación', async () => {
    publicar(2, v2())
    // La conversión confirmó en el SERVIDOR, pero su respuesta nunca llegó a la pantalla.
    await convertir(planPro())
    expect(aceptaciones).toHaveLength(1)

    const normal = await comprar({ quoteToken: comprobante() })

    expect(normal.status).toBe(409)
    expect(normal.body.code).toBe('PLAN_ACCEPTANCE_REQUIRED')
    expect(normal.body.details).toEqual({ acceptanceId: aceptaciones[0].id, tier: 'PRO', interval: 'monthly' })
    expect(mockSessionCreate).not.toHaveBeenCalled()

    const retomada = await comprar({
      tier: normal.body.details.tier,
      interval: normal.body.details.interval,
      acceptanceId: normal.body.details.acceptanceId,
    })

    expect(retomada.status).toBe(200)
    expect(mockSessionCreate).toHaveBeenCalledTimes(1)
    expect(sesion().line_items).toEqual([{ price: 'price_v2_pro_m', quantity: 1 }])
    expect(sesion().metadata).toMatchObject({ planAcceptanceId: aceptaciones[0].id })
  })

  it('🔴 b2-r8 #7: dentro de los 30 min se publica una v3 sin planes en venta; GET /plan trae aceptacionPendiente; POST plan/checkout con ese acceptanceId → abre con la versión aceptada', async () => {
    publicar(2, v2())
    const conversion = await convertir(planPro())
    publicar(3, v3({ PRO: { onSale: false }, PREMIUM: { onSale: false } }))

    const plan = await leerPlan()

    expect(plan.status).toBe(200)
    expect(plan.body.data.cotizacion.versionNumber).toBe(3)
    expect(plan.body.data.cotizacion.planes.PRO.vendible).toBe(false)
    expect(plan.body.data.cotizacion.aceptacionPendiente).toEqual({
      acceptanceId: conversion.body.data.planAcceptance.id,
      tier: 'PRO',
      interval: 'monthly',
      expiresAt: conversion.body.data.planAcceptance.expiresAt,
    })

    const res = await comprar({ acceptanceId: plan.body.data.cotizacion.aceptacionPendiente.acceptanceId })

    expect(res.status).toBe(200)
    expect(sesion().line_items).toEqual([{ price: 'price_v2_pro_m', quantity: 1 }])
    expect(sesion().metadata).toMatchObject({ planOfferVersion: '2', planAcceptanceId: conversion.body.data.planAcceptance.id })
  })

  it('🔴 b2-r9 #5 (el caso de Codex): convert-from-demo → checkout con acceptanceId (la sesión lleva metadata.planAcceptanceId) → Stripe simula el pago (la suscripción active con esa metadata y la fila del plan ligada) → GET /plan ya no trae aceptacionPendiente, y un checkout de otro plan sin acceptanceId no responde PLAN_ACCEPTANCE_REQUIRED', async () => {
    publicar(2, v2())
    const conversion = await convertir(planPro())
    const acceptanceId = conversion.body.data.planAcceptance.id

    const compra = await comprar({ acceptanceId })
    expect(compra.status).toBe(200)
    const metadata = sesion().subscription_data.metadata as Record<string, string>
    expect(metadata.planAcceptanceId).toBe(acceptanceId)

    // Stripe cobra: la suscripción queda `active` con la metadata de la sesión y el aviso liga la fila de Pro.
    const ahoraS = Math.floor(Date.now() / 1000)
    const suscripcion = {
      id: 'sub_acept',
      object: 'subscription',
      customer: 'cus_1',
      status: 'active',
      created: ahoraS,
      cancel_at_period_end: false,
      cancel_at: null,
      trial_end: null,
      default_payment_method: 'pm_1',
      metadata,
      discounts: [],
      items: {
        data: [
          {
            current_period_end: ahoraS + 30 * 86_400,
            price: { id: 'price_v2_pro_m', unit_amount: PRO_M_V2, recurring: { interval: 'month' } },
          },
        ],
      },
    }
    mockSubRetrieve.mockResolvedValue(suscripcion)
    mockSubList.mockResolvedValue({ object: 'list', data: [suscripcion], has_more: false })
    prismaMock.venueFeature.findMany.mockResolvedValue([
      {
        id: 'vf_pro',
        active: true,
        endDate: null,
        suspendedAt: null,
        gracePeriodEndsAt: null,
        monthlyPrice: null,
        stripeSubscriptionId: 'sub_acept',
        updatedAt: new Date(),
        feature: { code: 'PLAN_PRO', name: 'Plan Pro' },
      },
    ])

    const plan = await leerPlan()

    expect(plan.status).toBe(200)
    expect(plan.body.data.cotizacion).toBeDefined()
    expect(plan.body.data.cotizacion).not.toHaveProperty('aceptacionPendiente')

    const otro = await comprar({
      tier: 'PREMIUM',
      quoteToken: comprobante({ tier: 'PREMIUM', precioCents: PREMIUM_M_HOY, firstChargeCents: PREMIUM_M_HOY }),
    })

    // Lo decidió la lectura de compra («¿ya se usó?»): la suscripción del plan y la lista del cliente.
    expect(mockSubRetrieve).toHaveBeenCalledWith('sub_acept', expect.anything())
    expect(otro.body.code).not.toBe('PLAN_ACCEPTANCE_REQUIRED')
    expect(otro.status).toBe(200)
    expect(sesion(1).line_items).toEqual([{ price: 'price_v2_premium_m', quantity: 1 }])
    expect(sesion(1).metadata).not.toHaveProperty('planAcceptanceId')
  })

  it('🔴 b2-r9 #5: si Stripe no deja ver si la aceptación ya se usó, el checkout sin acceptanceId la trata como sin usar → 409 PLAN_ACCEPTANCE_REQUIRED', async () => {
    publicar(2, v2())
    const conversion = await convertir(planPro())
    mockSubList.mockRejectedValue(Object.assign(new Error('Stripe caído'), { type: 'StripeConnectionError' }))

    const res = await comprar({ quoteToken: comprobante() })

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({
      code: 'PLAN_ACCEPTANCE_REQUIRED',
      details: { acceptanceId: conversion.body.data.planAcceptance.id, tier: 'PRO', interval: 'monthly' },
    })
    expect(jest.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('se trata como sin usar'),
      expect.objectContaining({ venueId, acceptanceId: conversion.body.data.planAcceptance.id }),
    )
    expect(mockSessionCreate).not.toHaveBeenCalled()
  })

  it('aceptación de hace 31 min → 409 OFFER_CHANGED reason VERSION; después, el checkout normal con su comprobante abre', async () => {
    const conversionEn = new Date('2026-11-26T18:00:00.000Z')
    jest.useFakeTimers({ now: conversionEn, doNotFake: [...sinRelojes] })
    publicar(2, v2())
    const conversion = await convertir(planPro())
    expect(conversion.status).toBe(200)

    jest.setSystemTime(new Date(conversionEn.getTime() + 31 * MIN))
    const vencida = await comprar({ acceptanceId: conversion.body.data.planAcceptance.id })

    expect(vencida.status).toBe(409)
    expect(vencida.body).toMatchObject({ code: 'OFFER_CHANGED', details: { reason: 'VERSION', offerVersion: 2 } })
    expect(mockSessionCreate).not.toHaveBeenCalled()

    // Ya no hay aceptación viva: el checkout normal, con el comprobante de «Tu plan» de ahora, abre.
    const normal = await comprar({ quoteToken: comprobante() })

    expect(normal.status).toBe(200)
    expect(sesion().line_items).toEqual([{ price: 'price_v2_pro_m', quantity: 1 }])
    expect(sesion().metadata).not.toHaveProperty('planAcceptanceId')
  })

  it('con la v2: un acceptanceId que no existe, de otro negocio o que no es texto → 409 OFFER_CHANGED reason VERSION, sin sesión', async () => {
    publicar(2, v2())
    const conversion = await convertir(planPro())
    aceptaciones[0].venueId = 'clotronegocio00000000001'

    for (const acceptanceId of [conversion.body.data.planAcceptance.id, 'clnoexiste000000000000001', 42, '']) {
      const res = await comprar({ acceptanceId })
      expect(res.status).toBe(409)
      expect(res.body).toMatchObject({ code: 'OFFER_CHANGED', details: { reason: 'VERSION', offerVersion: 2 } })
    }
    expect(mockSessionCreate).not.toHaveBeenCalled()
  })

  it('con la v2 y plan Gratis: convierte con el CAS, sin aceptación; el checkout normal no pide ninguna', async () => {
    publicar(2, v2())

    const conversion = await convertir({ plan: { tier: 'FREE' } })

    expect(conversion.status).toBe(200)
    expect(conversion.body.data).not.toHaveProperty('planAcceptance')
    expect(aceptaciones).toEqual([])
    expect(prismaMock.venue.updateMany).toHaveBeenCalledTimes(1)

    const res = await comprar({ quoteToken: comprobante() })
    expect(res.status).toBe(200)
  })

  it('con la v2: dos conversiones del mismo demo (la segunda pierde el CAS) → la segunda 409 VENUE_ALREADY_CONVERTED y una sola aceptación', async () => {
    publicar(2, v2())
    prismaMock.venue.updateMany.mockResolvedValueOnce({ count: 1 } as never).mockResolvedValueOnce({ count: 0 } as never)

    const primera = await convertir(planPro())
    const segunda = await convertir({
      plan: {
        tier: 'PREMIUM',
        interval: 'monthly',
        quoteToken: comprobante({ tier: 'PREMIUM', precioCents: PREMIUM_M_HOY, firstChargeCents: PREMIUM_M_HOY }),
      },
    })

    expect(primera.status).toBe(200)
    expect(segunda.status).toBe(409)
    expect(segunda.body).toMatchObject({
      code: 'VENUE_ALREADY_CONVERTED',
      message: 'Este negocio ya se convirtió en otra pestaña. Recarga la página.',
    })
    expect(aceptaciones).toHaveLength(1)
    expect(aceptaciones[0].tier).toBe('PRO')
  })

  it('con la v2 y plan inválido → 400 PLAN_INVALID; sin plan → 409 QUOTE_REQUIRED; ninguno limpia', async () => {
    publicar(2, v2())

    const invalido = await convertir({ plan: { tier: 'PRO' } })
    expect(invalido.status).toBe(400)
    expect(invalido.body).toMatchObject({ code: 'PLAN_INVALID', message: 'El plan elegido no es válido. Recarga la página.' })

    const sinPlan = await convertir()
    expect(sinPlan.status).toBe(409)
    expect(sinPlan.body).toMatchObject({ code: 'OFFER_CHANGED', details: { reason: 'QUOTE_REQUIRED', offerVersion: 2 } })

    expect(mockCleanDemoData).not.toHaveBeenCalled()
    expect(prismaMock.venue.updateMany).not.toHaveBeenCalled()
  })

  it.each([
    ['plan null', { plan: null }],
    ['plan texto', { plan: 'PRO' }],
  ])('🔴 b2-r3 #8: sin versión del editor, convert-from-demo con %s → 200 como hoy (el campo se ignora)', async (_n, extra) => {
    const res = await convertir(extra)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ success: true, message: 'Demo venue converted to real successfully' })
    expect(res.body.data).not.toHaveProperty('planAcceptance')
    expect(prismaMock.venue.update).toHaveBeenCalledTimes(1)
    expect(prismaMock.venue.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.planAcceptance.create).not.toHaveBeenCalled()
    expect(mockCleanDemoData).toHaveBeenCalledTimes(1)
  })

  it('🔴 sin versión del editor, el checkout de hoy no busca aceptaciones ni pone planAcceptanceId', async () => {
    mockPriceList.mockResolvedValue({ data: [{ id: 'price_key_pro_m', unit_amount: 115884 }] })

    const res = await comprar({ acceptanceId: 'clacept000000000000000001' })

    expect(res.status).toBe(200)
    expect(sesion().line_items).toEqual([{ price: 'price_key_pro_m', quantity: 1 }])
    expect(sesion().metadata).toEqual({ kind: 'PLAN_CHECKOUT', venueId, tierCode: 'PLAN_PRO', interval: 'monthly' })
    expect(prismaMock.planAcceptance.findFirst).not.toHaveBeenCalled()
    expect(mockSubList).not.toHaveBeenCalled()
  })
})
