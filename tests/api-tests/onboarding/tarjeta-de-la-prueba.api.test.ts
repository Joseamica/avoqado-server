/*
  Planes editables B2, Task 6 (§18, b2-r8, b2-r9 #4): la tarjeta que Stripe cobraría al terminar la prueba sin tarjeta, al abrir
  la ventana del alta.

  GET /api/v1/onboarding/organizations/:organizationId/v2/tarjeta-de-la-prueba → { success, data: { tarjeta: { id, brand, last4 } | null } }

  🔴 Lo que fija:
  - con una versión del editor, la tarjeta sale de `tarjetaQueCobraria` en ESE momento (la jerarquía de Stripe);
  - sin cliente de Stripe, o con uno que Stripe ya borró, `null` («sin tarjeta»); sin id, sin llamar a Stripe;
  - si Stripe no deja leer el cliente o la tarjeta (error o tiempo agotado), 503 TARJETA_NO_LEIDA: nunca «sin tarjeta» (Codex b2-code #5);
  - sólo informa: no escribe nada (un cliente borrado lo cambia el alta, no esta lectura);
  - sin versión del editor, 409 OFFER_CHANGED reason VERSION con offerVersion 1 (Ruling P4), sin llamar a Stripe.

  Arranca el Express real: authenticateToken → requireOnboardingOrgOwner → validateRequest → controlador. Stripe simulado.
*/

process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret'
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/testdb?schema=public'
process.env.ENABLE_VENUE_BASE_SUBSCRIPTION = 'true'

const mockCustomerRetrieve = jest.fn()
const mockPmRetrieve = jest.fn()
const mockRetrieveSource = jest.fn()
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    subscriptions: { create: jest.fn(), retrieve: jest.fn(), list: jest.fn() },
    prices: { list: jest.fn(), retrieve: jest.fn() },
    paymentMethods: { retrieve: (...a: unknown[]) => mockPmRetrieve(...a) },
    customers: {
      create: jest.fn(),
      update: jest.fn(),
      retrieve: (...a: unknown[]) => mockCustomerRetrieve(...a),
      retrieveSource: (...a: unknown[]) => mockRetrieveSource(...a),
    },
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
import { definicionDePrueba, idsDeLaVersion, punteroA, versionUno } from '@tests/__helpers__/planOfferFixtures'
import { MENSAJE_PLAN_NO_CONFIGURADO } from '@/services/billing/planOffer'
import logger from '@/config/logger'

const app = require('../../../src/app').default

const ORG = 'clorgplanoferta0000000001'
const RUTA = `/api/v1/onboarding/organizations/${ORG}/v2/tarjeta-de-la-prueba`

function token() {
  return jwt.sign({ sub: 'staff_dueno', orgId: ORG, venueId: 'venue-1', role: 'OWNER' }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })
}
const leer = () => request(app).get(RUTA).set('Authorization', `Bearer ${token()}`)

const v2 = () =>
  definicionDePrueba({
    ids: idsDeLaVersion('v2'),
    netos: { 'PRO:monthly': 79900 },
    planes: { PRO: { requiresCard: false, trialDays: 14 } },
  })
const conVigente = () => prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, v2()) as never)
const negocio = (stripeCustomerId: string | null) =>
  prismaMock.venue.findFirst.mockResolvedValue({ id: 'venue-1', stripeCustomerId } as never)
const sinLlamarAStripe = () => {
  expect(mockCustomerRetrieve).not.toHaveBeenCalled()
  expect(mockPmRetrieve).not.toHaveBeenCalled()
  expect(mockRetrieveSource).not.toHaveBeenCalled()
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.staffOrganization.findFirst.mockResolvedValue({ id: 'so-1' } as never)
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.planOfferPointer.findUnique.mockReset().mockResolvedValue(null)
  negocio('cus_1')
  mockCustomerRetrieve
    .mockReset()
    .mockResolvedValue({ id: 'cus_1', object: 'customer', invoice_settings: { default_payment_method: null } })
  mockPmRetrieve.mockReset().mockResolvedValue({
    id: 'pm_premium',
    object: 'payment_method',
    type: 'card',
    card: { brand: 'visa', last4: '4242' },
  })
  mockRetrieveSource.mockReset()
})

describe('GET …/v2/tarjeta-de-la-prueba', () => {
  it('🔴 con la v2: responde { tarjeta } de tarjetaQueCobraria en ese momento; sin cliente de Stripe → null sin llamar a Stripe; sin versión del editor → 409 sin llamar a Stripe', async () => {
    conVigente()

    // Sin tarjeta guardada.
    const sinTarjeta = await leer()
    expect(sinTarjeta.status).toBe(200)
    expect(sinTarjeta.body).toEqual({ success: true, data: { tarjeta: null } })

    // En ese momento ya la tiene (otra pestaña la guardó): la misma lectura la trae, sin caché.
    mockCustomerRetrieve.mockResolvedValue({ id: 'cus_1', object: 'customer', invoice_settings: { default_payment_method: 'pm_premium' } })
    const conTarjeta = await leer()
    expect(conTarjeta.status).toBe(200)
    expect(conTarjeta.body.data).toEqual({ tarjeta: { id: 'pm_premium', brand: 'visa', last4: '4242' } })

    // Sin cliente de Stripe: null, sin llamar a Stripe.
    jest.clearAllMocks()
    negocio(null)
    const sinCliente = await leer()
    expect(sinCliente.status).toBe(200)
    expect(sinCliente.body.data).toEqual({ tarjeta: null })
    sinLlamarAStripe()

    // Sin versión del editor (sin versiones, o sólo la v1): 409, sin llamar a Stripe.
    for (const puntero of [null, punteroA('cv1', 1, versionUno())]) {
      jest.clearAllMocks()
      negocio('cus_1')
      prismaMock.planOfferPointer.findUnique.mockResolvedValue(puntero as never)
      const sinVersion = await leer()
      expect(sinVersion.status).toBe(409)
      expect(sinVersion.body).toMatchObject({ code: 'OFFER_CHANGED', details: { reason: 'VERSION', offerVersion: 1 } })
      sinLlamarAStripe()
    }
  })

  it('🔴 b2-r9 #4: con un cliente borrado en Stripe → { tarjeta: null } y no escribe nada (Venue.stripeCustomerId sigue igual hasta el alta)', async () => {
    conVigente()
    for (const respuesta of [
      () => Promise.resolve({ id: 'cus_1', object: 'customer', deleted: true }),
      () =>
        Promise.reject(
          Object.assign(new Error('No such customer: cus_1'), {
            type: 'StripeInvalidRequestError',
            statusCode: 404,
            code: 'resource_missing',
          }),
        ),
    ]) {
      jest.clearAllMocks()
      mockCustomerRetrieve.mockImplementation(respuesta)

      const res = await leer()

      expect(res.status).toBe(200)
      expect(res.body.data).toEqual({ tarjeta: null })
      expect(prismaMock.venue.update).not.toHaveBeenCalled()
      expect(prismaMock.venue.updateMany).not.toHaveBeenCalled()
      expect(mockPmRetrieve).not.toHaveBeenCalled()
    }
  })

  it('🔴 fix round 1: si leer la oferta falla (la base no contesta, o una vigente que no pasa el esquema) → el 503 PLAN_NOT_CONFIGURED de las compras, nunca un 500, y sin llamar a Stripe', async () => {
    for (const leerFalla of [
      () => prismaMock.planOfferPointer.findUnique.mockRejectedValue(new Error('la base no contesta')),
      () => prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, { schemaVersion: 1, PRO: 'roto' }) as never),
    ]) {
      jest.clearAllMocks()
      leerFalla()

      const res = await leer()

      expect(res.status).toBe(503)
      expect(res.body).toMatchObject({ code: 'PLAN_NOT_CONFIGURED', message: MENSAJE_PLAN_NO_CONFIGURADO })
      sinLlamarAStripe()
    }
  })

  it('🔴 Codex b2-code #5 (corrige el fix round 2): si Stripe no deja leer el cliente o su tarjeta (tiempo agotado, un 500) → 503 TARJETA_NO_LEIDA con un aviso en el log, nunca «sin tarjeta» ni un 500; sin escribir nada', async () => {
    conVigente()
    for (const falla of [
      () =>
        mockCustomerRetrieve.mockRejectedValue(
          Object.assign(new Error('Request aborted due to timeout being reached (5000ms)'), { type: 'StripeConnectionError' }),
        ),
      () => {
        mockCustomerRetrieve.mockResolvedValue({
          id: 'cus_1',
          object: 'customer',
          invoice_settings: { default_payment_method: 'pm_premium' },
        })
        mockPmRetrieve.mockRejectedValue(Object.assign(new Error('Stripe caído'), { type: 'StripeAPIError', statusCode: 500 }))
      },
    ]) {
      jest.clearAllMocks()
      falla()

      const res = await leer()

      // «No pude ver» nunca es «sin tarjeta»: el cliente puede tener una guardada que Stripe cobrará al terminar la prueba.
      expect(res.status).toBe(503)
      expect(res.body).toMatchObject({
        code: 'TARJETA_NO_LEIDA',
        message: 'No pudimos revisar tu cuenta de Stripe. Intenta en unos minutos.',
      })
      expect(res.body).not.toHaveProperty('data')
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('tarjeta-de-la-prueba: no se pudo leer en Stripe'),
        expect.objectContaining({ organizationId: ORG }),
      )
      expect(prismaMock.venue.update).not.toHaveBeenCalled()
      expect(prismaMock.venue.updateMany).not.toHaveBeenCalled()
    }
  })
})
