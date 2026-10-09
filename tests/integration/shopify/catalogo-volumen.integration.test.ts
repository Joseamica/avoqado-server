// tests/integration/shopify/catalogo-volumen.integration.test.ts
/**
 * #41 / N25: 5,000 variantes de punta a punta, sin atajos: importar (reanudando tras un fallo), aplicar POR TANDAS hasta
 * ACTIVE con números que cambian y ventas de caja pendientes, y una vuelta completa del cuadre con barrido real, cambios
 * de Shopify, DEAD_LETTER y diferencias con offset. Se mide lo que cuesta cada página y cada tanda (sin N+1): las
 * LECTURAS (SELECT sin candado) aparte de lo inevitable por fila (candados, escrituras, control de tx), con un tope
 * explícito por tanda, y que la foto de una tanda son pocas lecturas fijas. Cliente de Prisma con eventos de consulta: el
 * singleton de la app no los emite.
 */
jest.mock('@/utils/prismaClient', () => {
  const { PrismaClient } = jest.requireActual('@prisma/client')
  return { __esModule: true, default: new PrismaClient({ log: [{ emit: 'event', level: 'query' }] }) }
})

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { importCatalogPage } from '@/services/commerce-channels/shopify/shopify.catalog.service'
import { applyConnectPage, requestApplyShopifyConnect } from '@/services/commerce-channels/shopify/shopify.connect.service'
import { leerTandaCuadre, reconcileVenue } from '@/services/commerce-channels/shopify/shopify.reconcile.service'
import { marcarOrigenShopify } from '@/services/commerce-channels/shopify/shopify.mirror.service'
import { pedirCuadre } from '@/services/commerce-channels/shopify/shopify.store.service'
import {
  assertTestDatabase,
  crearEscenarioShopify,
  EscenarioShopify,
  graphqlFalso,
  huecoDelInvariante,
  limpiarEscenarioShopify,
} from './fixtures'
import { conPlan, falla, graphqlDelCatalogo, nivel, nivelesFalsos, paginaDeVariantes, variante, variantesDeLaSucursal } from './fixturesB'

jest.setTimeout(1_800_000)

let consultas = 0
let lecturas = 0
;(prisma as unknown as { $on(evento: 'query', cb: (e: { query: string }) => void): void }).$on('query', e => {
  consultas += 1
  // Lectura = SELECT sin candado. Los candados (FOR UPDATE/SHARE), las escrituras y BEGIN/COMMIT son inevitables por fila.
  if (/^\s*SELECT\b/i.test(e.query) && !/\bFOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b/i.test(e.query)) lecturas += 1
})

const TOTAL = 5_000
const POR_PAGINA = 50
const PAGINAS = TOTAL / POR_PAGINA
const pagina = (i: number) =>
  paginaDeVariantes(
    Array.from({ length: POR_PAGINA }, (_, j) => {
      const n = i * POR_PAGINA + j + 1
      return variante(n, { producto: `gid://shopify/Product/${Math.ceil(n / 5)}`, tipo: 'Volumen' })
    }),
    i + 1 < PAGINAS ? `c${i + 1}` : null,
    TOTAL,
  )
const sucursal = () => prisma.shopifyLocationLink.findUniqueOrThrow({ where: { id: e.locationLinkId } })

let e: EscenarioShopify
beforeAll(async () => {
  assertTestDatabase()
  e = await crearEscenarioShopify({ linkStatus: 'CONNECTING', initialized: false })
})
afterAll(async () => {
  await limpiarEscenarioShopify(e)
  await prisma.$disconnect()
})

it('importa 5,000 variantes: reanuda tras el fallo de la página 51 y cada página cuesta lo mismo (sin crecer con lo ya importado)', async () => {
  let yaFallo = false
  const graphql = graphqlFalso((_q, vars) => {
    const i = vars.after ? Number(String(vars.after).slice(1)) : 0
    if (i === 50 && !yaFallo) {
      yaFallo = true
      return falla('HTTP_5XX', true, true)
    }
    return pagina(i)
  })
  const porPagina: number[] = []
  const lecturasPorPagina: number[] = []
  for (let vuelta = 0; vuelta < PAGINAS + 5; vuelta++) {
    const antes = consultas
    const leidas = lecturas
    // Con el plan inyectado (§9.7, R3): sin él el traductor mira el plan real, y el escenario no lo trae.
    const r = await importCatalogPage(e.locationLinkId, { graphql, hasAccess: conPlan })
    if ('error' in r) {
      expect(r).toEqual({ error: 'HTTP_5XX', retry: true })
      expect(await sucursal()).toMatchObject({ importCursor: 'c50', importAttempts: 1 })
      continue
    }
    porPagina.push(consultas - antes)
    lecturasPorPagina.push(lecturas - leidas)
    if (r.done) break
  }
  expect(graphql).toHaveBeenCalledTimes(PAGINAS + 1)
  expect(porPagina).toHaveLength(PAGINAS)
  expect(Math.max(...porPagina)).toBeLessThanOrEqual(POR_PAGINA * 30) // una transacción corta por variante
  expect(Math.max(...lecturasPorPagina)).toBeLessThanOrEqual(POR_PAGINA * 15 + 20) // tope de LECTURAS por página
  expect(porPagina[PAGINAS - 1]).toBeLessThanOrEqual(porPagina[1] * 1.2 + 20) // la página 100 cuesta lo que la 2
  expect(await sucursal()).toMatchObject({ status: 'REVIEWING', importAttempts: 0, importCursor: null })
  expect(await prisma.product.count({ where: { venueId: e.venueId, originSystem: 'SHOPIFY' } })).toBe(TOTAL)
  expect(await prisma.shopifyVariantLink.count({ where: { locationLinkId: e.locationLinkId } })).toBe(TOTAL + 1) // + la del escenario
})

it('aplica las 5,001 parejas POR TANDAS con la función real hasta ACTIVE; cada tanda cuesta lo mismo y el stock queda S + pendientes', async () => {
  if ((await sucursal()).status !== 'REVIEWING') throw new Error('precondición: la prueba anterior debió importar las 5,000 variantes')
  // Diez ventas de caja durante la importación: el guardia las encoló aunque todavía no hubiera pareja iniciada.
  const vendidos = await prisma.product.findMany({
    where: { venueId: e.venueId, originSystem: 'SHOPIFY' },
    select: { id: true, inventory: { select: { id: true } } },
    orderBy: { id: 'asc' },
    take: 10,
  })
  for (const p of vendidos)
    await prisma.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" - 1 WHERE id = ${p.inventory!.id}`
  await requestApplyShopifyConnect({ venueId: e.venueId, staffId: e.staffId }, { hasAccess: conPlan })
  const fetchLevels = nivelesFalsos(item => nivel(4 + (Number(item.slice(-1)) || 0)))
  const porTanda: number[] = []
  const lecturasPorTanda: number[] = []
  for (let i = 0; i < PAGINAS + 5; i++) {
    const antes = consultas
    const leidas = lecturas
    const r = await applyConnectPage(e.locationLinkId, { fetchLevels, hasAccess: conPlan })
    porTanda.push(consultas - antes)
    lecturasPorTanda.push(lecturas - leidas)
    if (r.done) break
  }
  expect(Math.max(...lecturasPorTanda)).toBeLessThanOrEqual(POR_PAGINA * 8 + 20) // tope de LECTURAS por tanda de aplicar
  expect((await sucursal()).status).toBe('ACTIVE')
  expect(fetchLevels).toHaveBeenCalledTimes(PAGINAS + 1) // 5,001 parejas = 101 tandas de lectura
  expect(Math.max(...porTanda)).toBeLessThanOrEqual(POR_PAGINA * 25)
  const llenas = porTanda.slice(0, PAGINAS) // las 100 tandas de 50
  expect(Math.max(...llenas)).toBeLessThanOrEqual(Math.min(...llenas) * 1.2 + 20) // no crece con lo ya aplicado
  for (const p of vendidos) {
    expect(await huecoDelInvariante(p.id)).toBe('0') // Avoqado = S + la venta pendiente
    expect(await prisma.shopifyStockOutbox.count({ where: { productId: p.id, status: 'PENDING' } })).toBe(1)
  }
})

it('una vuelta del cuadre con barrido real: 20 cambios, 10 atorados y 10 diferencias; cada foto de tanda son lecturas fijas y nada se archiva', async () => {
  const l = await sucursal()
  if (l.status !== 'ACTIVE') throw new Error('precondición: la prueba anterior debió dejar la sucursal ACTIVE')
  const parejas = await prisma.shopifyVariantLink.findMany({
    where: { locationLinkId: e.locationLinkId },
    include: { product: { select: { inventory: { select: { id: true } } } } },
    orderBy: { id: 'asc' },
    take: 60,
  })
  const cambian = new Set(parejas.slice(0, 20).map(p => p.inventoryItemId))
  for (const p of parejas.slice(20, 30)) {
    await prisma.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" - 1 WHERE id = ${p.product.inventory!.id}`
    await prisma.shopifyStockOutbox.updateMany({
      where: { productId: p.productId, status: 'PENDING' },
      data: { status: 'DEAD_LETTER', processedAt: new Date() },
    })
  }
  for (const p of parejas.slice(30, 40)) {
    await prisma.$transaction(async tx => {
      await marcarOrigenShopify(tx)
      await tx.inventory.update({ where: { id: p.product.inventory!.id }, data: { currentStock: { increment: new Prisma.Decimal(2) } } })
    })
  }
  const catalogo = await variantesDeLaSucursal(e.locationLinkId)
  const espejo = new Map(
    catalogo.map(v => [v.inventoryItem.id, v.inventoryItem.inventoryLevel!.quantities.find(q => q.name === 'available')!.quantity]),
  )
  const fetchLevels = nivelesFalsos(item => nivel((espejo.get(item) ?? 0) + (cambian.has(item) ? 1 : 0)))
  const graphql = graphqlDelCatalogo(catalogo)

  for (const cursor of ['', parejas[49].id]) {
    const antes = consultas
    const t = await leerTandaCuadre(e.locationLinkId, l.generation, cursor)
    expect(t.parejas).toHaveLength(50)
    expect(consultas - antes).toBeLessThanOrEqual(10) // apertura, lecturas de la foto y COMMIT: no crece con la tanda
  }

  await pedirCuadre(e.locationLinkId)
  let aplicados = 0
  let porRevisar = 0
  let terminado = false
  const porTandaDeStock: number[] = []
  const lecturasDeStock: number[] = []
  for (let unidades = 0; !terminado && unidades < 400; unidades++) {
    const antes = consultas
    const leidas = lecturas
    const r = await reconcileVenue(e.venueId, { fetchLevels, graphql, hasAccess: conPlan })
    if (r.etapa === 'STOCK') {
      porTandaDeStock.push(consultas - antes)
      lecturasDeStock.push(lecturas - leidas)
    }
    aplicados += r.aplicados
    porRevisar = r.porRevisar
    terminado = r.terminado
  }
  expect(terminado).toBe(true)
  expect(aplicados).toBe(20)
  expect(porRevisar).toBe(20)
  expect(await prisma.shopifyReviewItem.count({ where: { venueId: e.venueId, status: 'OPEN', reason: 'ATORADO' } })).toBe(10)
  expect(await prisma.shopifyReviewItem.count({ where: { venueId: e.venueId, status: 'OPEN', reason: 'DIFERENCIA' } })).toBe(10)
  expect(Math.max(...porTandaDeStock)).toBeLessThanOrEqual(POR_PAGINA * 12)
  expect(Math.max(...lecturasDeStock)).toBeLessThanOrEqual(POR_PAGINA * 8 + 20) // tope de LECTURAS por tanda de stock
  for (const p of parejas.slice(0, 40)) expect(await huecoDelInvariante(p.productId)).toBe('0')
  expect(await prisma.product.count({ where: { venueId: e.venueId, deletedBy: 'SHOPIFY_SYNC' } })).toBe(0) // el barrido completo vio todo
})
