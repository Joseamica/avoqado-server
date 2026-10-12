// tests/integration/shopify/app-del-comercio.integration.test.ts
/**
 * 5a, «la app es del comercio» (spec docs/superpowers/specs/2026-10-11-conector-shopify-app-del-comercio-design.md del workspace):
 * el candado propio, conectar y cambiar las llaves con la app que el comercio creó, el cambio de método y los avisos firmados con
 * el secret de cada tienda. Postgres real; Shopify por deps o por `global.fetch`.
 */
jest.mock('@/config/env', () => {
  const real = jest.requireActual('@/config/env')
  return { ...real, env: { ...real.env, BASE_URL: 'https://api.test', FRONTEND_URL: 'https://dash.test' } }
})

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { puedeConectarConAppPropia, startShopifyConnect } from '@/services/commerce-channels/shopify/shopify.connect.service'
import { assertTestDatabase, crearEscenarioShopify, EscenarioShopify, limpiarEscenarioShopify } from './fixtures'

jest.setTimeout(120_000)
const SECRETO = 'secreto-app-piloto'
const D = (v: number) => new Prisma.Decimal(v)

let escenarios: EscenarioShopify[] = []
async function escenario(o?: Parameters<typeof crearEscenarioShopify>[0]): Promise<EscenarioShopify> {
  const e = await crearEscenarioShopify(o)
  escenarios.push(e)
  return e
}
beforeAll(() => {
  assertTestDatabase()
  Object.assign(process.env, {
    SHOPIFY_PILOTO_CLIENT_ID: 'cliente',
    SHOPIFY_PILOTO_CLIENT_SECRET: SECRETO,
    OAUTH_STATE_SECRET: 'estado-de-prueba',
  })
})
beforeEach(() => {
  process.env.SHOPIFY_PILOTO_SHOPS = ''
  ;(logAction as jest.Mock).mockClear()
})
afterEach(async () => {
  for (const e of escenarios) await limpiarEscenarioShopify(e)
  escenarios = []
})

/** Una función concedida al negocio con su fila `VenueFeature` (la cortesía de superadmin, o un plan). */
async function conFuncion(venueId: string, code: string, o: { endDate?: Date | null } = {}) {
  const feature = await prisma.feature.upsert({
    where: { code },
    create: { code, name: code, category: 'INTEGRATIONS', monthlyPrice: D(0) },
    update: {},
  })
  return prisma.venueFeature.create({
    data: { venueId, featureId: feature.id, active: true, monthlyPrice: D(0), endDate: o.endDate ?? null },
  })
}
/** La invitación a la app propia: la cortesía explícita y vigente de SHOPIFY_INTEGRATION. */
const conCortesia = (e: EscenarioShopify) => conFuncion(e.venueId, 'SHOPIFY_INTEGRATION')

describe('5a · el candado propio (riesgo 4)', () => {
  it('🔴 deja pasar SÓLO con la fila de cortesía explícita y vigente; el trato preferente, el Premium, una capability grant sola, la fila vencida o suspendida y la demo con su fila automática, no', async () => {
    const e = await escenario()
    const puede = () => puedeConectarConAppPropia(e.venueId)
    expect(await puede()).toBe(false) // nada
    await prisma.venue.update({ where: { id: e.venueId }, data: { seatCapExempt: true } })
    expect(await puede()).toBe(false) // trato preferente sin fila
    await prisma.venue.update({ where: { id: e.venueId }, data: { seatCapExempt: false } })
    await conFuncion(e.venueId, 'PLAN_PREMIUM')
    expect(await puede()).toBe(false) // Premium sin fila
    await prisma.capabilityGrant.create({
      data: {
        venueId: e.venueId,
        featureCode: 'SHOPIFY_INTEGRATION',
        sourceId: 'grant-sola',
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 86_400_000),
      },
    })
    expect(await puede()).toBe(false) // una capability grant sola no es la cortesía
    const vf = await conFuncion(e.venueId, 'SHOPIFY_INTEGRATION', { endDate: new Date(Date.now() - 86_400_000) })
    expect(await puede()).toBe(false) // fila vencida
    await prisma.venueFeature.update({ where: { id: vf.id }, data: { endDate: null } })
    expect(await puede()).toBe(true) // la cortesía: fila vigente
    await prisma.venueFeature.update({ where: { id: vf.id }, data: { suspendedAt: new Date() } })
    expect(await puede()).toBe(false) // suspendida
    await prisma.venueFeature.update({ where: { id: vf.id }, data: { suspendedAt: null } })
    for (const status of ['LIVE_DEMO', 'TRIAL'] as const) {
      await prisma.venue.update({ where: { id: e.venueId }, data: { status } })
      expect(await puede()).toBe(false) // una demo trae su fila sola: no cuenta
    }
  })

  it('🔴 el piloto no cambia: fuera de SHOPIFY_PILOTO_SHOPS y con la cortesía ⇒ 409 SHOPIFY_USA_APP_PROPIA; sin ella ⇒ SHOPIFY_SOLO_PILOTO; una del piloto sigue a OAuth', async () => {
    const e = await escenario()
    const i = { venueId: e.venueId, authUserId: e.staffId, purpose: 'CONNECT' as const }
    await expect(startShopifyConnect({ ...i, shopDomain: 'otra.myshopify.com' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'SHOPIFY_SOLO_PILOTO',
    })
    await conCortesia(e)
    await expect(startShopifyConnect({ ...i, shopDomain: 'otra.myshopify.com' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'SHOPIFY_USA_APP_PROPIA',
    })
    process.env.SHOPIFY_PILOTO_SHOPS = 'otra.myshopify.com'
    expect((await startShopifyConnect({ ...i, shopDomain: 'otra.myshopify.com' })).url).toContain(
      'https://otra.myshopify.com/admin/oauth/authorize',
    )
  })
})
