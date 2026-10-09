// tests/integration/shopify/conteo-consultas.integration.test.ts
/**
 * §12.1 (Codex A ronda 4): el refresco del conteo pregunta por lo bloqueado con UNA consulta agrupada por tanda, no una
 * por producto. Cliente de Prisma con eventos de consulta: el singleton de la app no los emite.
 */
jest.mock('@/utils/prismaClient', () => {
  const { PrismaClient } = jest.requireActual('@prisma/client')
  return { __esModule: true, default: new PrismaClient({ log: [{ emit: 'event', level: 'query' }] }) }
})

import prisma from '@/utils/prismaClient'
import { refrescarEspejoParaConteo } from '@/services/commerce-channels/shopify/shopify.count.service'
import { agregarProductoShopify, assertTestDatabase, crearEscenarioShopify, EscenarioShopify, limpiarEscenarioShopify } from './fixtures'
import { conPlan, falla } from './fixturesB'

jest.setTimeout(120_000)
const consultas: string[] = []
;(prisma as unknown as { $on(evento: 'query', cb: (e: { query: string }) => void): void }).$on('query', q => {
  consultas.push(q.query)
})

let e: EscenarioShopify
beforeAll(async () => {
  assertTestDatabase()
  e = await crearEscenarioShopify()
})
afterAll(async () => {
  await limpiarEscenarioShopify(e)
  await prisma.$disconnect()
})

it('§12.1: lo bloqueado se pregunta con UNA consulta por tanda: la tanda cuesta lo mismo con 2 productos que con 10', async () => {
  const ids = [e.productId]
  for (let i = 0; i < 9; i++) ids.push((await agregarProductoShopify(e)).productId)
  // El producto del escenario tiene un envío en vuelo.
  await prisma.shopifyStockOutbox.create({
    data: {
      venueId: e.venueId,
      locationLinkId: e.locationLinkId,
      generation: 1,
      productId: e.productId,
      delta: -1,
      status: 'IN_PROGRESS',
      claimToken: 'm',
      leaseUntil: new Date(Date.now() + 60_000),
    },
  })
  const sinRespuesta = { fetchLevels: jest.fn(async () => falla('HTTP_5XX', true, false)) as never, hasAccess: conPlan }
  const medir = async (productIds: string[]) => {
    const antes = consultas.length
    const r = await refrescarEspejoParaConteo(e.venueId, productIds, sinRespuesta)
    const hechas = consultas.slice(antes)
    return { r, total: hechas.length, alBuzon: hechas.filter(q => q.includes('"ShopifyStockOutbox"')).length }
  }
  const dos = await medir(ids.slice(0, 2))
  const diez = await medir(ids)
  expect(dos.alBuzon).toBe(1)
  expect(diez.alBuzon).toBe(1) // con `productBlocked` por pareja eran 10
  expect(diez.total).toBe(dos.total) // constante por tanda, no por producto
  expect([...diez.r.bloqueados]).toEqual([e.productId])
  expect(sinRespuesta.fetchLevels).toHaveBeenCalledTimes(2) // lo libre sí se pidió (y Shopify no contestó)
})
