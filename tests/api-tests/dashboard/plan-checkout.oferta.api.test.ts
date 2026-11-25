/*
  Planes editables B1, Task 2: el precio con el que «Tu plan» abre la sesión de Stripe, por la ruta real.

  POST /api/v1/dashboard/venues/:venueId/plan/checkout  { tier: 'PRO', interval: 'monthly' }

  🔴 Lo que fija: sin versiones y con sólo la v1 sembrada, la sesión lleva el precio de la LLAVE, exactamente como B0
  (la v1 es una foto de lo de hoy y no cambia el cobro, aunque la llave se haya movido). Sólo una versión publicada por el
  editor (la v2) cobra con su propio priceId, y entonces la llave ni se lista.

  Arranca el Express real: authenticateToken → checkPermission → validateRequest → controlador → servicio → resolver.
  La regla común de compra (`autorizarObligacionNueva`, probada en su suite) se simula en su borde y corre su callback.
*/

process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret'
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/testdb?schema=public'

const mockPriceList = jest.fn()
const mockPriceRetrieve = jest.fn()
const mockSessionCreate = jest.fn()
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    prices: { list: mockPriceList, retrieve: mockPriceRetrieve },
    checkout: { sessions: { create: mockSessionCreate, list: jest.fn(), expire: jest.fn() } },
    subscriptions: { list: jest.fn(), retrieve: jest.fn() },
    customers: { create: jest.fn(), retrieve: jest.fn() },
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

import jwt from 'jsonwebtoken'
import request from 'supertest'

import { prismaMock } from '@tests/__helpers__/setup'
import { mirrorTokenRoleOnStaffVenue } from '@tests/__helpers__/venueRoleMock'
import { definicionDePrueba, idsDeLaVersion, punteroA, versionUno } from '@tests/__helpers__/planOfferFixtures'

const app = require('../../../src/app').default

const venueId = 'clvenueplanoferta00000001'
const RUTA = `/api/v1/dashboard/venues/${venueId}/plan/checkout`

function token() {
  mirrorTokenRoleOnStaffVenue('OWNER', venueId)
  return jwt.sign({ sub: 'user_test', orgId: 'org_test', venueId, role: 'OWNER' }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })
}

const pedir = () => request(app).post(RUTA).set('Authorization', `Bearer ${token()}`).send({ tier: 'PRO', interval: 'monthly' })

/** El precio con el que se abrió la sesión de Stripe. */
const lineItems = () => mockSessionCreate.mock.calls[0][0].line_items

beforeEach(() => {
  jest.clearAllMocks()
  mockPriceList.mockReset()
  mockPriceRetrieve.mockReset()
  mockSessionCreate.mockReset().mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' })
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
    // Las rutas de compra siguen comparando contra las constantes (B2 lo cambia): la v2 conserva el monto de Pro mensual.
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, definicionDePrueba({ ids: idsDeLaVersion('v2') })) as never)
    mockPriceRetrieve.mockResolvedValue({ id: 'price_v2_pro_m', active: true, unit_amount: 115884 })

    const res = await pedir()

    expect(res.status).toBe(200)
    expect(lineItems()).toEqual([{ price: 'price_v2_pro_m', quantity: 1 }])
    expect(mockPriceList).not.toHaveBeenCalled()
    expect(mockPriceRetrieve).toHaveBeenCalledWith('price_v2_pro_m', { timeout: 15_000, maxNetworkRetries: 0 })
  })

  it('con la v2 vigente y su precio archivado → 503 PLAN_NOT_CONFIGURED y no se abre sesión', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, definicionDePrueba({ ids: idsDeLaVersion('v2') })) as never)
    mockPriceRetrieve.mockResolvedValue({ id: 'price_v2_pro_m', active: false, unit_amount: 115884 })

    const res = await pedir()

    expect(res.status).toBe(503)
    expect(res.body.code).toBe('PLAN_NOT_CONFIGURED')
    expect(mockSessionCreate).not.toHaveBeenCalled()
    expect(mockAutorizar).not.toHaveBeenCalled()
  })
})
