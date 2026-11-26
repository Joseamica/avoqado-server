/*
  Planes editables B2, Task 7 (§17): «Poner mi tarjeta» abre el portal de Stripe en el flujo de la tarjeta, por la ruta real.

  POST /api/v1/dashboard/venues/:venueId/billing-portal  { returnUrl, flujo? }

  🔴 Lo que fija:
  - sólo con una versión del editor y `flujo: 'PONER_TARJETA'` el portal se abre en `payment_method_update`, con la configuración del
    portal de siempre y el regreso a la misma página;
  - sin versión del editor, cualquier `flujo` (o `null`, o un texto) deja el cuerpo de hoy, sin `flow_data`;
  - si Stripe rechaza el flujo, 503 PORTAL_NOT_CONFIGURED: nunca se abre el portal genérico en su lugar.

  Arranca el Express real: authenticateToken → checkPermission → validateRequest → controlador → servicio → Stripe (simulado).
*/

process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret'
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/testdb?schema=public'

const mockPortalCreate = jest.fn()
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    billingPortal: { sessions: { create: mockPortalCreate } },
    customers: { create: jest.fn(), retrieve: jest.fn() },
  })),
)
jest.mock('../../../src/config/session', () => {
  const noop = (req: any, _res: any, next: any) => next()
  return { __esModule: true, default: noop }
})
jest.mock('../../../src/config/swagger', () => ({ __esModule: true, setupSwaggerUI: jest.fn() }))

import jwt from 'jsonwebtoken'
import request from 'supertest'

import { prismaMock } from '@tests/__helpers__/setup'
import { mirrorTokenRoleOnStaffVenue } from '@tests/__helpers__/venueRoleMock'
import { definicionDePrueba, idsDeLaVersion, punteroA, versionUno } from '@tests/__helpers__/planOfferFixtures'

const app = require('../../../src/app').default

const venueId = 'clvenueportaltarjeta00001'
const RUTA = `/api/v1/dashboard/venues/${venueId}/billing-portal`
const REGRESO = 'https://dashboard.avoqado.test/venues/negocio/settings/billing/subscriptions?portal=tarjeta'
const CONFIGURACION_ORIGINAL = process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID

function token() {
  mirrorTokenRoleOnStaffVenue('OWNER', venueId)
  return jwt.sign({ sub: 'user_test', orgId: 'org_test', venueId, role: 'OWNER' }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })
}
const abrir = (cuerpo: object) =>
  request(app)
    .post(RUTA)
    .set('Authorization', `Bearer ${token()}`)
    .send({ returnUrl: REGRESO, ...cuerpo })

const conLaV2 = () =>
  prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, definicionDePrueba({ ids: idsDeLaVersion('v2') })) as never)

/** El cuerpo de hoy del portal: el cliente, el regreso y la configuración restringida. */
const CUERPO_DE_HOY = { customer: 'cus_1', return_url: REGRESO, configuration: 'bpc_restringida' }

beforeAll(() => {
  process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID = 'bpc_restringida'
})
afterAll(() => {
  if (CONFIGURACION_ORIGINAL === undefined) delete process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID
  else process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID = CONFIGURACION_ORIGINAL
})

beforeEach(() => {
  jest.clearAllMocks()
  mockPortalCreate.mockReset().mockResolvedValue({ id: 'bps_1', url: 'https://billing.stripe.test/p/session_1' })
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
  prismaMock.venue.findFirst.mockResolvedValue({
    id: venueId,
    name: 'Negocio de prueba',
    slug: 'negocio',
    stripeCustomerId: 'cus_1',
    organizationId: 'org_test',
  } as never)
  prismaMock.planOfferPointer.findUnique.mockReset().mockResolvedValue(null)
})

describe('POST /dashboard/venues/:venueId/billing-portal — el flujo de la tarjeta (B2, Task 7)', () => {
  it('🔴 con la v2 y flujo PONER_TARJETA: billingPortal.sessions.create con flow_data { type: "payment_method_update", after_completion: { type: "redirect", redirect: { return_url } } } y la configuración del portal', async () => {
    conLaV2()

    const res = await abrir({ flujo: 'PONER_TARJETA' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, url: 'https://billing.stripe.test/p/session_1' })
    expect(mockPortalCreate).toHaveBeenCalledTimes(1)
    expect(mockPortalCreate.mock.calls[0]).toEqual([
      {
        ...CUERPO_DE_HOY,
        flow_data: {
          type: 'payment_method_update',
          after_completion: { type: 'redirect', redirect: { return_url: REGRESO } },
        },
      },
    ])
  })

  it('🔴 sin versión del editor, con flujo PONER_TARJETA (o null, o "x"): el cuerpo de hoy, sin flow_data', async () => {
    for (const flujo of ['PONER_TARJETA', null, 'x']) {
      mockPortalCreate.mockClear()
      const res = await abrir({ flujo })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ success: true, url: 'https://billing.stripe.test/p/session_1' })
      expect(mockPortalCreate.mock.calls).toEqual([[CUERPO_DE_HOY]])
    }
    // Con sólo la v1 sembrada (una foto de lo de hoy), también el de hoy.
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv1', 1, versionUno()) as never)
    mockPortalCreate.mockClear()
    expect((await abrir({ flujo: 'PONER_TARJETA' })).status).toBe(200)
    expect(mockPortalCreate.mock.calls).toEqual([[CUERPO_DE_HOY]])
    // Y sin `flujo`, como siempre.
    mockPortalCreate.mockClear()
    expect((await abrir({})).status).toBe(200)
    expect(mockPortalCreate.mock.calls).toEqual([[CUERPO_DE_HOY]])

    // Con la v2, un flujo que no es el de la tarjeta tampoco lo pide.
    conLaV2()
    mockPortalCreate.mockClear()
    expect((await abrir({ flujo: 'x' })).status).toBe(200)
    expect(mockPortalCreate.mock.calls).toEqual([[CUERPO_DE_HOY]])
  })

  it('Stripe rechaza el flujo → 503 PORTAL_NOT_CONFIGURED y no abre el portal genérico', async () => {
    conLaV2()
    mockPortalCreate.mockRejectedValue(
      Object.assign(new Error('The payment_method_update flow is not enabled for this configuration.'), {
        type: 'StripeInvalidRequestError',
        statusCode: 400,
      }),
    )

    const res = await abrir({ flujo: 'PONER_TARJETA' })

    expect(res.status).toBe(503)
    expect(res.body).toMatchObject({
      code: 'PORTAL_NOT_CONFIGURED',
      message: 'No pudimos abrir la página para poner tu tarjeta. Intenta en unos minutos.',
    })
    // Una sola llamada, la del flujo: nunca un segundo intento con el portal genérico.
    expect(mockPortalCreate).toHaveBeenCalledTimes(1)
    expect(mockPortalCreate.mock.calls[0][0]).toHaveProperty('flow_data')
  })
})
