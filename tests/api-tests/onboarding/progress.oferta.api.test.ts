/*
  Planes editables B2, Task 3: GET /api/v1/onboarding/organizations/:organizationId/progress con una versión del editor.

  🔴 Lo que fija:
  - sin versiones y con sólo la v1, `planQuote` es exactamente el de hoy (se compara contra el objeto literal, sin `oferta`);
  - una v1 cuya definición no pasa el esquema (`versionQueCobra` lanza) NO tumba la lectura: 200 y `planQuote` de hoy;
  - con la v2: `planQuote.oferta` con un comprobante por plan y periodicidad, y las llaves de siempre salen de la vigente;
  - un alta ACTIVE sin tarjeta dice `sinTarjeta` y la fecha de su prueba.
*/

process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret'
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/testdb?schema=public'
process.env.ENABLE_VENUE_BASE_SUBSCRIPTION = 'true'

const mockSubRetrieve = jest.fn()
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    subscriptions: { retrieve: (...a: unknown[]) => mockSubRetrieve(...a), list: jest.fn(), create: jest.fn() },
    prices: { list: jest.fn(), retrieve: jest.fn() },
  })),
)
jest.mock('../../../src/config/session', () => {
  const noop = (req: any, _res: any, next: any) => next()
  return { __esModule: true, default: noop }
})
jest.mock('../../../src/config/swagger', () => ({ __esModule: true, setupSwaggerUI: jest.fn() }))
jest.mock('../../../src/services/onboarding/ensureVenue.service', () => ({
  __esModule: true,
  ensureVenueForOnboarding: jest.fn().mockResolvedValue(null),
}))

import jwt from 'jsonwebtoken'
import request from 'supertest'

import logger from '../../../src/config/logger'
import { prismaMock } from '@tests/__helpers__/setup'
import { verificarCotizacion } from '@/services/billing/comprobanteDeCotizacion'
import { definicionDePrueba, idsDeLaVersion, punteroA, versionUno } from '@tests/__helpers__/planOfferFixtures'

const app = require('../../../src/app').default

const ORG = 'clorgplanoferta0000000001'
const RUTA = `/api/v1/onboarding/organizations/${ORG}/progress`
const DIA = 86_400_000

function token() {
  return jwt.sign({ sub: 'staff_dueno', orgId: ORG, venueId: 'venue-1', role: 'OWNER' }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })
}
const leer = () => request(app).get(RUTA).set('Authorization', `Bearer ${token()}`)

/** El `planQuote` de hoy, escrito a mano (no desde las constantes). */
const PLAN_QUOTE_DE_HOY = {
  currency: 'MXN',
  ivaIncluded: true,
  trialDays: 30,
  tiers: {
    PRO: {
      monthlyCents: 115884,
      annualCents: 1158840,
      monthlyNetCents: 99900,
      annualNetCents: 999000,
      intro: { monthlyCents: 69484, months: 3, interval: 'monthly', requiresPayNow: true },
    },
    PREMIUM: { monthlyCents: 197084, annualCents: 1970840, monthlyNetCents: 169900, annualNetCents: 1699000, intro: null },
  },
}

const v2 = () =>
  definicionDePrueba({
    ids: idsDeLaVersion('v2'),
    netos: { 'PRO:monthly': 79900 },
    planes: { PRO: { requiresCard: false, trialDays: 14 }, PREMIUM: { trialDays: 0 } },
  })

const progreso = (extra: object = {}) => ({
  id: 'op-1',
  organizationId: ORG,
  currentStep: 3,
  completedSteps: [],
  completedAt: null,
  startedAt: new Date('2026-11-20T00:00:00Z'),
  wizardVersion: 2,
  v2SetupData: {},
  launchCampaignId: null,
  termsVersion: null,
  planActivationStatus: 'NONE',
  planActivationAttempt: 0,
  planStripeSubscriptionId: null,
  ...extra,
})

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.staffOrganization.findFirst.mockResolvedValue({ id: 'so-1' } as never)
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.planOfferPointer.findUnique.mockReset().mockResolvedValue(null)
  prismaMock.onboardingProgress.findUnique.mockResolvedValue(progreso() as never)
  mockSubRetrieve.mockReset()
})

describe('GET /onboarding/organizations/:organizationId/progress — la cotización del alta', () => {
  it('🔴 sin versiones y con sólo la v1: planQuote es exactamente el de hoy (sin oferta)', async () => {
    const sinVersiones = await leer()
    expect(sinVersiones.status).toBe(200)
    expect(sinVersiones.body.progress.planQuote).toStrictEqual(PLAN_QUOTE_DE_HOY)

    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv1', 1, versionUno()) as never)
    const conV1 = await leer()
    expect(conV1.status).toBe(200)
    expect(conV1.body.progress.planQuote).toStrictEqual(PLAN_QUOTE_DE_HOY)
    expect(conV1.body.progress.planQuote.oferta).toBeUndefined()
  })

  it('🔴 b2-r9 #8: una v1 cuya definición no pasa el esquema (versionQueCobra lanza) → 200 y planQuote igual al de hoy, sin oferta', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv1', 1, { schemaVersion: 1, roto: true }) as never)
    const res = await leer()
    expect(res.status).toBe(200)
    expect(res.body.progress.planQuote).toStrictEqual(PLAN_QUOTE_DE_HOY)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no se pudo leer la oferta de planes'),
      expect.objectContaining({ organizationId: ORG }),
    )
  })

  it('con la v2 (Pro sin tarjeta 14 días, mensual 79900; Premium con tarjeta 0 días): publica su comprobante por plan y periodicidad', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, v2()) as never)
    const antes = Date.now()
    const res = await leer()
    expect(res.status).toBe(200)
    const { oferta } = res.body.progress.planQuote
    expect(oferta.versionNumber).toBe(2)
    expect(oferta.planes.PRO.monthly.firstChargeCents).toBe(0)
    const fin = new Date(oferta.planes.PRO.monthly.trialEndsAt).getTime()
    expect(fin).toBeGreaterThanOrEqual(antes + 14 * DIA)
    expect(fin).toBeLessThanOrEqual(Date.now() + 14 * DIA)
    expect(oferta.planes.PREMIUM.monthly.firstChargeCents).toBe(197084)
    expect(oferta.planes.PREMIUM.monthly.trialEndsAt).toBeNull()
    const c = verificarCotizacion(oferta.planes.PRO.monthly.quoteToken, `org:${ORG}`, new Date())
    expect(c).toMatchObject({ versionNumber: 2, tier: 'PRO', interval: 'monthly', precioCents: 92684 })
  })

  it('con la v2: las llaves de siempre salen de la vigente (bruto, neto, días de prueba de Pro y sin intro)', async () => {
    prismaMock.planOfferPointer.findUnique.mockResolvedValue(punteroA('cv2', 2, v2()) as never)
    const res = await leer()
    const { tiers, trialDays } = res.body.progress.planQuote
    expect(trialDays).toBe(14)
    expect(tiers.PRO).toEqual({
      monthlyCents: 92684,
      annualCents: 1158840,
      monthlyNetCents: 79900,
      annualNetCents: 999000,
      intro: null,
    })
    expect(tiers.PREMIUM.intro).toBeNull()
    expect(tiers.PREMIUM.monthlyCents).toBe(197084)
  })

  it('con el alta ACTIVE sin tarjeta: planActivation trae sinTarjeta true y la fecha de la prueba', async () => {
    prismaMock.onboardingProgress.findUnique.mockResolvedValue(
      progreso({ planActivationStatus: 'ACTIVE', planStripeSubscriptionId: 'sub_1' }) as never,
    )
    const finDePrueba = Math.floor((Date.now() + 14 * DIA) / 1000)
    mockSubRetrieve.mockResolvedValue({
      id: 'sub_1',
      status: 'trialing',
      cancel_at_period_end: false,
      trial_end: finDePrueba,
      metadata: { sinTarjeta: 'true' },
    })
    const res = await leer()
    expect(res.status).toBe(200)
    expect(res.body.progress.planActivation).toMatchObject({
      status: 'ACTIVE',
      sinTarjeta: true,
      trialEndsAt: new Date(finDePrueba * 1000).toISOString(),
    })
  })
})
