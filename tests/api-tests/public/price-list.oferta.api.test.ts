/*
  Planes editables B2, Task 10: la lista de precios y las ofertas públicas con la versión del editor, por la app real.

  GET  /api/v1/public/hybrid-offers?includeBasic=true   («Ver ofertas» del DASHBOARD)
  GET  /api/v1/public/hybrid-offers/:slug               (el detalle por enlace)
  POST /api/v1/public/price-list/selection              (lo que elige el prospecto en /presentacion/precios)

  🔴 Lo que fija:
  - con la v2, una pestaña vieja de la lista de precios (sin `offerVersion`) → 409 PRICE_LIST_CHANGED y no sale el correo;
  - sin versión del editor, `offerVersion` se ignora (con un texto o `null` también): el esquema lo declara `z.unknown()` (b2-r3 #8);
  - con la v2 el Básico ya no sale en «Ver ofertas» (b2-r7 #5) y su enlace dice `purchaseAvailable: false` (b2-r8 #8), aunque su lista
    `PLAN:BASICO` siga ACTIVE; sin versión del editor, como hoy;
  - si leer la oferta falla (una v1 dañada), «Ver ofertas» responde la lista de hoy con 200, nunca un 503 (b2-r8 #10).

  Arranca el Express real (`src/app`). La base es `prismaMock`; el tablero de «Precios» se simula en su borde y el correo con un espía.
*/

process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret'
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/testdb?schema=public'

jest.mock('stripe', () => jest.fn().mockImplementation(() => ({})))
jest.mock('../../../src/config/session', () => {
  const noop = (req: any, _res: any, next: any) => next()
  return { __esModule: true, default: noop }
})
jest.mock('../../../src/config/swagger', () => ({ __esModule: true, setupSwaggerUI: jest.fn() }))
const mockBoard = jest.fn()
jest.mock('../../../src/services/launchCampaigns/hybridListPrice.service', () => ({
  ...jest.requireActual('../../../src/services/launchCampaigns/hybridListPrice.service'),
  listPriceBoard: (...a: unknown[]) => mockBoard(...a),
}))

import request from 'supertest'

import { prismaMock } from '@tests/__helpers__/setup'
import { definicionDePrueba, idsDeLaVersion, punteroA } from '@tests/__helpers__/planOfferFixtures'
import emailService from '@/services/email.service'
import logger from '@/config/logger'

const app = require('../../../src/app').default

const pointer = prismaMock.planOfferPointer.findUnique as jest.Mock
const v2 = () => punteroA('ver_v2', 2, definicionDePrueba({ ids: idsDeLaVersion('v2') }))
let ip = 0
// Cada caso desde su propio visitante: el tope de escritura (5 por minuto) es por IP.
const elegir = (body: object) =>
  request(app).post('/api/v1/public/price-list/selection').set('CF-Connecting-IP', `10.9.0.${++ip}`).send(body)

const now = Date.now()
const terms = (price: number) => ({
  currency: 'MXN',
  interval: 'MONTHLY',
  price,
  taxIncluded: true,
  promotionCycles: null,
  renewal: { kind: 'SAME_PRICE' },
})
const BASIC_CODES = ['ADVANCED_REPORTS', 'CFDI', 'LOYALTY_PROGRAM', 'PROMOTIONS', 'RESERVATIONS']
const basicPublication = {
  id: 'cm300000000000000000000001',
  campaignId: 'cm300000000000000000000002',
  name: 'Plan Básico',
  version: 1,
  definitionHash: 'b'.repeat(64),
  includedFeatureCodes: BASIC_CODES,
  definition: { schemaVersion: 1, kind: 'FEATURES', basicPlan: true, seatCap: 3, featureCodes: BASIC_CODES, terms: terms(578.84) },
}
const basicCampaign = {
  id: 'cm300000000000000000000002',
  code: 'L_PLAN_BASICO',
  slug: 'plan-basico',
  purpose: 'LIST',
  listProductKey: 'PLAN:BASICO',
  status: 'ACTIVE',
  revision: 1,
  startsAt: new Date(now - 10_000),
  endsAt: null,
  capacity: null,
  reservedCount: 0,
  redeemedCount: 0,
  audience: 'ALL',
  eligibleOrganizationIds: [],
  currentPublicationId: basicPublication.id,
  promotionGroupId: null,
}
const promo = (n: number) => ({
  code: `P${n}`,
  slug: `promo-${n}`,
  startsAt: new Date(now - 1000),
  endsAt: new Date(now + 86_400_000),
  audience: 'ALL',
  capacity: 10,
  reservedCount: 0,
  redeemedCount: 0,
  currentPublicationId: `cm40000000000000000000000${n}`,
  promotionGroupId: null,
})
const cfdi = (id: string) => ({
  id,
  name: 'CFDI suelto',
  version: 1,
  definitionHash: 'c'.repeat(64),
  includedFeatureCodes: ['CFDI'],
  definition: { schemaVersion: 1, kind: 'FEATURES', featureCodes: ['CFDI'], terms: terms(229) },
})

let send: jest.SpyInstance
beforeEach(() => {
  process.env.HYBRID_BILLING_ENABLED = 'true'
  pointer.mockReset().mockResolvedValue(null)
  send = jest.spyOn(emailService, 'sendPriceSelectionEmail').mockResolvedValue(true)
  // El tablero de «Precios»: CFDI suelto y los dos planes en venta.
  mockBoard.mockReset().mockResolvedValue([
    { productKey: 'FEATURE:CFDI', price: 229, status: 'ACTIVE', campaignId: 'c', revision: 1, pendingPrice: null, activeGroups: [] },
    { productKey: 'PLAN:PRO', price: 1158.84, status: 'ACTIVE', campaignId: 'c', revision: 1, pendingPrice: null, activeGroups: [] },
    { productKey: 'PLAN:PREMIUM', price: 1970.84, status: 'ACTIVE', campaignId: 'c', revision: 1, pendingPrice: null, activeGroups: [] },
  ])
  prismaMock.planOfferVersion.findUnique.mockResolvedValue({
    hybridPublicationIds: { PRO: 'cm500000000000000000000001', PREMIUM: 'cm500000000000000000000002' },
  })
  // Las ofertas públicas: 2 promociones y, si se pide, el Básico.
  prismaMock.hybridCampaign.findFirst.mockResolvedValue({ slug: 'plan-basico' })
  prismaMock.hybridCampaign.findUnique.mockImplementation(async ({ where }: any) => (where.slug === 'plan-basico' ? basicCampaign : null))
  prismaMock.hybridOfferPublication.findUnique.mockResolvedValue(basicPublication)
  prismaMock.hybridCampaign.count.mockResolvedValue(2)
  prismaMock.hybridCampaign.findMany.mockImplementation(async ({ where, take, skip }: any) =>
    where?.purpose === 'PROMOTION'
      ? [promo(0), promo(1)].slice(skip ?? 0, (skip ?? 0) + take)
      : [
          { listProductKey: 'PLAN:PRO', currentPublicationId: 'cm600000000000000000000001' },
          { listProductKey: 'PLAN:PREMIUM', currentPublicationId: 'cm600000000000000000000002' },
        ],
  )
  prismaMock.hybridOfferPublication.findMany.mockImplementation(async ({ where }: any) =>
    (where.id.in as string[]).map(id => (id.startsWith('cm4') ? cfdi(id) : { id, includedFeatureCodes: ['CFDI'] })),
  )
})
afterEach(() => {
  send.mockRestore()
  delete process.env.HYBRID_BILLING_ENABLED
})

describe('B2 Task 10 · lista de precios y ofertas públicas con la versión del editor (app real)', () => {
  it('🔴 POST /api/v1/public/price-list/selection de una pestaña vieja (sin offerVersion) con la v2 → 409 PRICE_LIST_CHANGED y no manda el correo', async () => {
    pointer.mockResolvedValue(v2())
    const lista = await request(app).get('/api/v1/public/price-list').expect(200)
    expect(lista.body.data.offerVersion).toBe(2)

    const vieja = await elegir({ nombre: 'Prospecto', ids: ['CFDI'] })
    expect(vieja.status).toBe(409)
    expect(vieja.body).toMatchObject({
      code: 'PRICE_LIST_CHANGED',
      message: 'Un módulo cambió o ya no está disponible. Recarga la página.',
    })
    expect(send).not.toHaveBeenCalled()
    // Con otra versión también; con la que se leyó, la cuenta de siempre (el POST recalcula con la misma fuente).
    expect((await elegir({ nombre: 'Prospecto', ids: ['CFDI'], offerVersion: 1 })).status).toBe(409)
    expect(send).not.toHaveBeenCalled()
    const buena = await elegir({ nombre: 'Prospecto', ids: ['CFDI'], offerVersion: 2 })
    expect(buena.status).toBe(200)
    expect(buena.body.data).toEqual({ best: { kind: 'SUELTO', totalCents: 22900, extras: [] }, savingsCents: 0, chosen: ['CFDI'] })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('🔴 b2-r7 #5 (el caso de Codex): con la v2 y la lista PLAN:BASICO ACTIVE, GET /api/v1/public/hybrid-offers?includeBasic=true no trae el Básico; sin versión del editor lo trae primero, como hoy', async () => {
    const hoy = await request(app).get('/api/v1/public/hybrid-offers?includeBasic=true').expect(200)
    expect(hoy.body.data.items.map((i: { slug: string }) => i.slug)).toEqual(['plan-basico', 'promo-0', 'promo-1'])
    expect(hoy.body.data.total).toBe(3)

    pointer.mockResolvedValue(v2())
    const conV2 = await request(app).get('/api/v1/public/hybrid-offers?includeBasic=true').expect(200)
    expect(conV2.body.data.items.map((i: { slug: string }) => i.slug)).toEqual(['promo-0', 'promo-1'])
    expect(conV2.body.data.total).toBe(2)
    // La lista del Básico sigue ACTIVE: se cierra en el código, no pausándola.
    expect(basicCampaign.status).toBe('ACTIVE')
  })

  it('🔴 b2-r8 #10 (el caso de Codex): sin versión del editor, una v1 con la definición dañada y el Básico activo → GET hybrid-offers?includeBasic=true responde 200 con la lista de hoy, no 503', async () => {
    pointer.mockResolvedValue(punteroA('ver_v1', 1, { schemaVersion: 1, roto: true }))
    const res = await request(app).get('/api/v1/public/hybrid-offers?includeBasic=true')
    expect(res.status).toBe(200)
    expect(res.body.data.items.map((i: { slug: string }) => i.slug)).toEqual(['plan-basico', 'promo-0', 'promo-1'])
    expect(res.body.data.items[0].purchaseAvailable).toBe(true)
    expect(logger.warn).toHaveBeenCalledWith(
      'Ofertas públicas: no se pudo leer la oferta de los planes; el Básico sale como hoy',
      expect.anything(),
    )
  })

  it('🔴 b2-r8 #8 (el caso de Codex): con la v2, GET /api/v1/public/hybrid-offers/<slug del Básico> → purchaseAvailable false; sin versión del editor, true como hoy', async () => {
    const hoy = await request(app).get('/api/v1/public/hybrid-offers/plan-basico').expect(200)
    expect(hoy.body.data).toMatchObject({ slug: 'plan-basico', purchaseAvailable: true })

    pointer.mockResolvedValue(v2())
    const conV2 = await request(app).get('/api/v1/public/hybrid-offers/plan-basico').expect(200)
    // La misma forma de hoy (nada se agrega ni se quita); sólo no se puede comprar.
    expect(Object.keys(conV2.body.data).sort()).toEqual(Object.keys(hoy.body.data).sort())
    expect(conV2.body.data).toMatchObject({ slug: 'plan-basico', purchaseAvailable: false })
  })

  it('🔴 b2-r3 #8: sin versión del editor, la selección con offerVersion "x" o null → como hoy (el campo se ignora)', async () => {
    for (const offerVersion of ['x', null, 7]) {
      const res = await elegir({ nombre: 'Prospecto', ids: ['CFDI'], offerVersion })
      expect(res.status).toBe(200)
      expect(res.body.data).toEqual({ best: { kind: 'SUELTO', totalCents: 22900, extras: [] }, savingsCents: 0, chosen: ['CFDI'] })
    }
    expect(send).toHaveBeenCalledTimes(3)
    const lista = await request(app).get('/api/v1/public/price-list').expect(200)
    expect(lista.body.data).not.toHaveProperty('offerVersion')
  })
})
