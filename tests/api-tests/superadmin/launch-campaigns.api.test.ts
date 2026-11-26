/*
  S4 — la capa HTTP de las campañas de lanzamiento (spec 2026-09-17 § 3.4, § 9.1).

  🔴 Por qué hace falta ADEMÁS de las pruebas del servicio: una prueba unitaria del servicio y
  del controlador pasa perfectamente aunque NADIE haya montado la subruta, y aunque el guardia
  de SUPERADMIN no esté puesto. Esto arranca el Express real y ejercita
  authenticateTokenMiddleware → authorizeRole([SUPERADMIN]) → controlador.
*/

process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret'
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/testdb?schema=public'

jest.mock('../../../src/config/session', () => {
  const noop = (req: any, _res: any, next: any) => next()
  return { __esModule: true, default: noop }
})
jest.mock('../../../src/config/swagger', () => ({ __esModule: true, setupSwaggerUI: jest.fn() }))
// Planes editables B1 (Task 7): activar lee el precio de lista y el cupón en Stripe, simulado entero.
const mockPriceList = jest.fn()
const mockPriceRetrieve = jest.fn()
const mockCouponRetrieve = jest.fn()
const mockCouponCreate = jest.fn()
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    prices: { list: mockPriceList, retrieve: mockPriceRetrieve },
    coupons: { retrieve: mockCouponRetrieve, create: mockCouponCreate, del: jest.fn() },
    subscriptions: { create: jest.fn(), retrieve: jest.fn(), list: jest.fn() },
    paymentMethods: { retrieve: jest.fn() },
  })),
)
jest.mock('../../../src/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))

import request from 'supertest'
import jwt from 'jsonwebtoken'
import { prismaMock } from '@tests/__helpers__/setup'
import { simularSuperadminReal } from '@tests/__helpers__/venueRoleMock'
import { definicionDePrueba, idsDeLaVersion, punteroA } from '@tests/__helpers__/planOfferFixtures'

const app = require('../../../src/app').default

const PATH = '/api/v1/superadmin/launch-campaigns'

function token(role: string) {
  // El SUPERADMIN del token sólo vale si la base lo confirma (Codex H6/S5).
  simularSuperadminReal(role === 'SUPERADMIN')
  return jwt.sign({ sub: 'user_test', orgId: 'org_test', venueId: 'venue_test', role }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(prismaMock.launchCampaign.count as jest.Mock).mockResolvedValue(0)
  ;(prismaMock.launchCampaign.findMany as jest.Mock).mockResolvedValue([])
})

describe('GET /superadmin/launch-campaigns — capa HTTP', () => {
  it('401 sin token', async () => {
    expect((await request(app).get(PATH)).status).toBe(401)
  })

  it.each(['OWNER', 'ADMIN', 'MANAGER', 'CASHIER', 'WAITER', 'VIEWER'])('🔴 403 para %s: es SOLO de Avoqado', async role => {
    const res = await request(app)
      .get(PATH)
      .set('Authorization', `Bearer ${token(role)}`)
    expect(res.status).toBe(403)
    // Y no llega a consultar nada: el guardia corta antes del controlador.
    expect(prismaMock.launchCampaign.findMany).not.toHaveBeenCalled()
  })

  it('200 para SUPERADMIN — y esto es lo que prueba que la subruta está MONTADA', async () => {
    const res = await request(app)
      .get(PATH)
      .set('Authorization', `Bearer ${token('SUPERADMIN')}`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ success: true, data: [], meta: { total: 0, page: 1, pageSize: 25 } })
  })

  it('un `pageSize` por encima del tope se rechaza con un 400 legible', async () => {
    const res = await request(app)
      .get(`${PATH}?pageSize=5000`)
      .set('Authorization', `Bearer ${token('SUPERADMIN')}`)
    expect(res.status).toBe(400)
    expect(String(res.body.message)).toMatch(/cupo|pageSize|Revisa|:/i)
  })
})

describe('POST /superadmin/launch-campaigns — validación', () => {
  it('🔴 403 para un OWNER, aunque el cuerpo sea válido', async () => {
    const res = await request(app)
      .post(PATH)
      .set('Authorization', `Bearer ${token('OWNER')}`)
      .send({ code: 'POS22', name: 'POS $22', landingSlug: 'pos-22', planTier: 'PRO', advertisedPriceCents: 2200, discountMonths: 3 })
    expect(res.status).toBe(403)
    expect(prismaMock.launchCampaign.create).not.toHaveBeenCalled()
  })

  it('un cuerpo inválido da 400 LEGIBLE, no un 500 con el JSON crudo de Zod', async () => {
    const res = await request(app)
      .post(PATH)
      .set('Authorization', `Bearer ${token('SUPERADMIN')}`)
      .send({ code: 'no', name: 'x', landingSlug: 'MAYUSCULAS', planTier: 'GRATIS', advertisedPriceCents: 10, discountMonths: 99 })
    expect(res.status).toBe(400)
    expect(typeof res.body.message).toBe('string')
    expect(res.body.message).not.toContain('too_small')
    expect(prismaMock.launchCampaign.create).not.toHaveBeenCalled()
  })

  it('🔴 un precio por debajo del mínimo de Stripe se rechaza ANTES de tocar la base', async () => {
    const res = await request(app)
      .post(PATH)
      .set('Authorization', `Bearer ${token('SUPERADMIN')}`)
      .send({
        code: 'POS5',
        name: 'Cinco pesos',
        landingSlug: 'pos-5',
        planTier: 'PRO',
        advertisedPriceCents: 500,
        discountMonths: 3,
        redemptionCap: 10,
        validFrom: '2026-09-01T00:00:00Z',
        validUntil: '2026-12-01T00:00:00Z',
      })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/\$10\.00|Stripe/)
    expect(prismaMock.launchCampaign.create).not.toHaveBeenCalled()
  })
})

/**
 * Planes editables B1 (Task 7): activar una campaña con la oferta de los planes en versiones, por la ruta real.
 * La publicación misma (su ruta llega en Task 9) se representa con el estado que deja el publicador: el puntero en la v2.
 */
describe('POST /superadmin/launch-campaigns/:id/activate — con la oferta de los planes', () => {
  const LISTA = 115884
  const ANUNCIADO = 2200
  const precio = (id: string, unitAmount: number) => ({
    id,
    active: true,
    product: 'prod_plan_pro',
    currency: 'mxn',
    recurring: { interval: 'month', interval_count: 1 },
    tax_behavior: 'inclusive',
    unit_amount: unitAmount,
  })
  /** La fila de la campaña: la leen y la escriben el servicio de transiciones y la activación. */
  let campana: Record<string, unknown>
  const fila = (o: Record<string, unknown> = {}) => ({
    id: 'lc-1',
    code: 'POS22',
    name: 'POS $22',
    landingSlug: 'pos-22',
    vertical: 'ALL',
    channel: null,
    featuredForVertical: false,
    planTier: 'PRO',
    billingInterval: 'MONTHLY',
    advertisedPriceCents: ANUNCIADO,
    discountMonths: 3,
    currency: 'MXN',
    offerVersion: 1,
    listPriceCentsSnapshot: null,
    discountAmountCents: null,
    stripePriceId: null,
    stripeCouponId: null,
    validFrom: new Date('2026-09-01T00:00:00Z'),
    validUntil: new Date('2099-01-01T00:00:00Z'),
    redemptionCap: 100,
    redemptionCount: 0,
    headline: null,
    subheadline: null,
    bullets: [],
    status: 'DRAFT',
    statusReason: null,
    activatedAt: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...o,
  })
  const pedir = (ruta: string, cuerpo: Record<string, unknown> = {}) =>
    request(app)
      .post(`${PATH}/lc-1/${ruta}`)
      .set('Authorization', `Bearer ${token('SUPERADMIN')}`)
      .send(cuerpo)

  beforeEach(() => {
    campana = fila()
    prismaMock.launchCampaign.findUnique.mockImplementation((async () => ({ ...campana })) as never)
    prismaMock.launchCampaign.findUniqueOrThrow.mockImplementation((async () => ({ ...campana })) as never)
    prismaMock.launchCampaign.updateMany.mockImplementation((async ({ data }: { data: Record<string, unknown> }) => {
      campana = { ...campana, ...data, updatedAt: new Date() }
      return { count: 1 }
    }) as never)
    prismaMock.$transaction.mockImplementation(async (cb: unknown) => (cb as (tx: unknown) => unknown)(prismaMock))
    prismaMock.planOfferPointer.findUnique.mockReset().mockResolvedValue(null)
    mockPriceList.mockReset().mockResolvedValue({ data: [precio('price_key_pro_m', LISTA)] })
    mockPriceRetrieve.mockReset()
    mockCouponRetrieve.mockReset().mockRejectedValue(Object.assign(new Error('No such coupon'), { code: 'resource_missing' }))
    mockCouponCreate.mockReset().mockImplementation(async (b: Record<string, unknown>) => b)
  })

  it('POST /api/v1/superadmin/launch-campaigns/:id/activate con publicación pendiente → 409 PLAN_OFFER_PENDING', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue({
      ...punteroA('cv1', 1, definicionDePrueba({ ids: idsDeLaVersion('v1') })),
      pendingVersionId: 'cvpendiente',
    } as never)

    const res = await pedir('activate')

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PLAN_OFFER_PENDING')
    expect(mockPriceList).not.toHaveBeenCalled()
    expect(mockPriceRetrieve).not.toHaveBeenCalled()
    expect(mockCouponRetrieve).not.toHaveBeenCalled()
    expect(mockCouponCreate).not.toHaveBeenCalled()
    expect(campana.status).toBe('DRAFT')
  })

  it('🔴 por la ruta: pausar, publicar sólo el anual y reactivar → 200 y la campaña guarda el mismo stripeCouponId que tenía', async () => {
    // Activa con la v1 (la llave): nace LC_POS22_V1.
    expect((await pedir('activate')).status).toBe(200)
    expect(campana).toMatchObject({ status: 'ACTIVE', stripeCouponId: 'LC_POS22_V1', listPriceCentsSnapshot: LISTA })
    mockCouponRetrieve.mockReset().mockResolvedValue({ id: 'LC_POS22_V1', valid: true, amount_off: LISTA - ANUNCIADO })

    expect((await pedir('pause', { reason: 'se publica el anual nuevo' })).status).toBe(200)
    expect(campana.status).toBe('PAUSED')

    // Se publica la v2: sólo cambió el anual; el mensual hereda el precio de la v1.
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(
      punteroA(
        'cv2',
        2,
        definicionDePrueba({ ids: { ...idsDeLaVersion('v2'), 'PRO:monthly': 'price_v1_pro_m' }, netos: { 'PRO:annual': 1099000 } }),
      ) as never,
    )
    mockPriceRetrieve.mockResolvedValue(precio('price_v1_pro_m', LISTA))

    const res = await pedir('activate')

    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ status: 'ACTIVE', stripeCouponId: 'LC_POS22_V1' })
    expect(campana.stripeCouponId).toBe('LC_POS22_V1')
    // Comprobó SU cupón y no creó ni buscó el de la v2.
    expect(mockCouponRetrieve.mock.calls.map(c => c[0])).toEqual(['LC_POS22_V1'])
    expect(mockCouponCreate).toHaveBeenCalledTimes(1)
    expect(mockPriceRetrieve).toHaveBeenCalledWith('price_v1_pro_m')
  })
})
