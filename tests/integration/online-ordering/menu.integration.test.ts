// tests/integration/online-ordering/menu.integration.test.ts
/**
 * Integration (REAL DB) — la carta pública (`getPublicMenu`, P1-09 de la 1b) contra Postgres de verdad.
 * Lo que los mocks no prueban: que Postgres resuelva igual los filtros de inactivos, el orden y los conteos, y que NINGUNA
 * sentencia de la carta recorra vínculos u opciones de OTRO negocio (un `COUNT` de relación de Prisma se compila como un
 * agregado de toda la tabla metido en un JOIN). Se capturan las sentencias de Prisma y se corre `EXPLAIN ANALYZE` de cada una.
 * Con `EXPLAIN_CARTA=1` imprime los planes.
 * A3: y que la consulta de los horarios de los menús sólo lea los marcados «Tienda en línea» (`Menu.appliesToOnline`).
 */
import type { PrismaClient } from '@prisma/client'

jest.mock('@/utils/prismaClient', () => {
  const { PrismaClient: Cliente } = jest.requireActual('@prisma/client')
  const cliente = new Cliente({ log: [{ emit: 'event', level: 'query' }] })
  cliente.__sentencias = []
  cliente.$on('query', (e: { query: string; params: string }) => cliente.__sentencias.push({ query: e.query, params: e.params }))
  return { __esModule: true, default: cliente }
})

import prisma from '@/utils/prismaClient'
import { clearPublicMenuCache, getPublicMenu } from '@/services/online-ordering/menu.service'
import { quoteCart } from '@/services/online-ordering/quote.service'

// El guardia global rechaza `av-db-25` y hosts remotos; esta suite exige además una base DESECHABLE por nombre.
const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(database.hostname) || !/^\/avoqado_[a-z0-9_]+_test_[a-z0-9_]+$/.test(database.pathname)) {
  throw new Error('Esta suite sólo corre contra una base desechable avoqado_<tarea>_test_<fecha> en localhost.')
}

interface Sentencia {
  query: string
  params: string
}
interface NodoDelPlan {
  'Relation Name'?: string
  'Actual Rows': number
  Plans?: NodoDelPlan[]
}

const sentencias: Sentencia[] = (prisma as unknown as { __sentencias: Sentencia[] }).__sentencias
const RUN = Date.now()

describe('Carta pública contra Postgres (integration, real DB)', () => {
  let orgId: string | undefined
  let venueId: string | undefined
  let vecinoId: string | undefined
  /** Lo que la tienda tiene sembrado, activo o no: ninguna sentencia de su carta debería leer más que esto. */
  const propias = { Modifier: 0, ProductModifierGroup: 0 }
  let ordenDeSalsas: string[] = []
  let paquete: { id: string }

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'ITEST Carta Org', slug: `itest-carta-org-${RUN}`, email: `itest-carta-${RUN}@test.com`, phone: '5550000000' },
    })
    orgId = org.id
    const negocio = (nombre: string, slug: string) =>
      prisma.venue.create({ data: { name: nombre, slug, organizationId: org.id, timezone: 'America/Mexico_City' } })
    venueId = (await negocio('ITEST Carta', `itest-carta-${RUN}`)).id
    vecinoId = (await negocio('ITEST Carta vecino', `itest-carta-vecino-${RUN}`)).id
    const v = venueId

    // Se crea primero «Bebidas»: el orden por id no es el de la carta.
    const bebidas = await prisma.menuCategory.create({ data: { venueId: v, name: 'Bebidas', slug: `bebidas-${RUN}`, displayOrder: 2 } })
    const tacos = await prisma.menuCategory.create({ data: { venueId: v, name: 'Tacos', slug: `tacos-${RUN}`, displayOrder: 1 } })
    const apagados = await prisma.menuCategory.create({ data: { venueId: v, name: 'Apagados', slug: `apagados-${RUN}`, displayOrder: 3 } })

    const grupo = (name: string, o: Record<string, unknown> = {}) =>
      prisma.modifierGroup.create({
        data: { venueId: v, name, required: true, allowMultiple: false, minSelections: 1, maxSelections: 1, ...o },
      })
    const opcion = async (groupId: string, name: string, active = true) => {
      propias.Modifier += 1
      return prisma.modifier.create({ data: { groupId, name, price: 0, active } })
    }
    const salsas = await grupo('Salsas') // compartido
    ordenDeSalsas = [await opcion(salsas.id, 'Verde'), await opcion(salsas.id, 'Roja')]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map(m => m.name)
    await opcion(salsas.id, 'Apagada', false) // opción INACTIVA
    const extras = await grupo('Extras', { active: false, required: false, minSelections: 0, allowMultiple: true, maxSelections: null }) // grupo INACTIVO
    await opcion(extras.id, 'Queso')
    const tortilla = await grupo('Tortilla') // obligatorio sin opciones activas: el platillo es imposible (M-4)
    await opcion(tortilla.id, 'Maíz', false)

    const platillo = (name: string, categoryId: string, displayOrder: number, o: Record<string, unknown> = {}) =>
      prisma.product.create({
        data: { venueId: v, name, sku: `${name}-${RUN}`, price: 30, categoryId, displayOrder, availableOnline: true, ...o },
      })
    const liga = (productId: string, groupId: string, displayOrder: number) => {
      propias.ProductModifierGroup += 1
      return prisma.productModifierGroup.create({ data: { productId, groupId, displayOrder } })
    }
    const pastor = await platillo('Pastor', tacos.id, 1)
    const suadero = await platillo('Suadero', tacos.id, 2)
    const imposible = await platillo('Imposible', tacos.id, 3)
    await platillo('Agua', bebidas.id, 1) // sin grupos
    paquete = await platillo('12 Clases Lagree', bebidas.id, 3, { type: 'SERVICE' }) // cobrarlo aquí no entrega créditos
    await platillo('Refresco', bebidas.id, 2, { availableOnline: false })
    await platillo('Apagado', apagados.id, 1, { availableOnline: false })
    await liga(pastor.id, salsas.id, 0)
    await liga(pastor.id, extras.id, 1)
    await liga(suadero.id, salsas.id, 0)
    await liga(imposible.id, tortilla.id, 0)

    // El vecino: vínculos y opciones que la carta de la tienda nunca debe recorrer.
    const suCategoria = await prisma.menuCategory.create({ data: { venueId: vecinoId, name: 'Vecino', slug: `vecino-${RUN}` } })
    const suGrupo = await prisma.modifierGroup.create({ data: { venueId: vecinoId, name: 'Del vecino', required: false } })
    await prisma.modifier.createMany({
      data: Array.from({ length: 40 }, (_, i) => ({ groupId: suGrupo.id, name: `vecino-${i}`, price: 0 })),
    })
    for (let i = 0; i < 10; i++) {
      const p = await prisma.product.create({
        data: {
          venueId: vecinoId,
          name: `Vecino ${i}`,
          sku: `vecino-${i}-${RUN}`,
          price: 1,
          categoryId: suCategoria.id,
          availableOnline: true,
        },
      })
      await prisma.productModifierGroup.create({ data: { productId: p.id, groupId: suGrupo.id } })
    }
  })

  afterAll(async () => {
    try {
      // Limpieza acotada: sin venueId NO se borra nada (una limpieza sin filtro vaciaría tablas enteras).
      if (!venueId) return
      const ids = vecinoId ? [venueId, vecinoId] : [venueId]
      const v = { venueId: { in: ids } }
      await prisma.productModifierGroup.deleteMany({ where: { product: v } })
      await prisma.product.deleteMany({ where: v })
      await prisma.modifier.deleteMany({ where: { group: v } })
      await prisma.modifierGroup.deleteMany({ where: v })
      await prisma.menuCategory.deleteMany({ where: v })
      await prisma.venue.deleteMany({ where: { id: { in: ids } } })
      if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
    } finally {
      await (prisma as unknown as PrismaClient).$disconnect()
    }
  })

  it('la carta sale de Postgres en orden, con conteos exactos y sin inactivos', async () => {
    clearPublicMenuCache()
    const menu = await getPublicMenu(venueId!)
    expect(menu.truncated).toBe(false)
    expect(
      menu.categories.map(c => ({
        name: c.name,
        productCount: c.productCount,
        products: c.products.map(p => ({ name: p.name, grupos: p.modifierGroups.map(g => [g.name, g.modifiers.map(m => m.name)]) })),
      })),
    ).toEqual([
      {
        name: 'Tacos',
        productCount: 2, // «Imposible» no se puede pedir y no cuenta
        products: [
          { name: 'Pastor', grupos: [['Salsas', ordenDeSalsas]] }, // sin «Extras» (grupo inactivo) ni «Apagada»
          { name: 'Suadero', grupos: [['Salsas', ordenDeSalsas]] },
        ],
      },
      { name: 'Bebidas', productCount: 1, products: [{ name: 'Agua', grupos: [] }] },
    ])
  })

  it('un producto SERVICE ya marcado en línea no sale en la carta y el cotizador lo rechaza como no disponible', async () => {
    clearPublicMenuCache()
    const menu = await getPublicMenu(venueId!)
    expect(menu.categories.flatMap(c => c.products.map(p => p.name))).not.toContain('12 Clases Lagree')

    const quote = await quoteCart(venueId!, [{ productId: paquete.id, quantity: 1 }])
    expect(quote.ok).toBe(false)
    expect(quote.issues).toEqual([expect.objectContaining({ code: 'PRODUCT_UNAVAILABLE', productId: paquete.id })])
  })

  it('cada sentencia de la carta lleva LIMIT o un IN, y ninguna recorre vínculos u opciones de otro negocio (EXPLAIN ANALYZE)', async () => {
    clearPublicMenuCache()
    sentencias.length = 0
    await getPublicMenu(venueId!)
    const leidas = [...sentencias]
    expect(leidas.length).toBeGreaterThan(0)
    const excesos: unknown[] = []
    for (const s of leidas) {
      const params = JSON.parse(s.params) as unknown[]
      const [fila] = await prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': Array<{ Plan: NodoDelPlan }> }>>(
        `EXPLAIN (ANALYZE, FORMAT JSON) ${s.query}`,
        ...params,
      )
      // Filas que salen de cada recorrido de la tabla (`Actual Rows` es por vuelta: el lado de adentro de un Nested Loop vuelve a
      // recorrer las MISMAS filas, no las de otro negocio). Un agregado de toda la tabla saca las filas de todos los negocios.
      const leidasPorTabla: Record<string, number> = {}
      const recorrer = (n: NodoDelPlan) => {
        if (n['Relation Name']) leidasPorTabla[n['Relation Name']] = (leidasPorTabla[n['Relation Name']] ?? 0) + n['Actual Rows']
        n.Plans?.forEach(recorrer)
      }
      recorrer(fila['QUERY PLAN'][0].Plan)
      if (process.env.EXPLAIN_CARTA === '1') {
        const texto = await prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
          `EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) ${s.query}`,
          ...params,
        )
        process.stdout.write(`\n--- ${s.query.slice(0, 140)}…\n${texto.map(t => `    ${t['QUERY PLAN']}`).join('\n')}\n`)
      }
      for (const tabla of ['Modifier', 'ProductModifierGroup'] as const) {
        const filas = leidasPorTabla[tabla] ?? 0
        if (filas > propias[tabla]) excesos.push({ sentencia: s.query.slice(0, 160), tabla, filas, propias: propias[tabla] })
      }
    }
    expect({
      sinLimitNiIn: leidas.filter(s => !/\bLIMIT\b/.test(s.query) && !/\bIN \(/.test(s.query)).map(s => s.query),
      // Un COUNT de relación de Prisma es `LEFT JOIN (SELECT … COUNT(*) … GROUP BY …)`: agrega la tabla de todos los negocios.
      agregadosEnUnJoin: leidas.filter(s => /JOIN \(SELECT/.test(s.query)).map(s => s.query.slice(0, 160)),
      excesos,
    }).toEqual({ sinLimitNiIn: [], agregadosEnUnJoin: [], excesos: [] })
  })

  /**
   * A3 («¿Dónde se usa?»): la tienda en línea sólo lee los menús con su casilla «Tienda en línea». Un menú sólo de aparatos NO
   * restringe ni abre una categoría, y una categoría que sólo está en menús de aparatos se vende como una sin menús.
   * Negocio propio (la hora de la carta importa aquí y los otros dos casos leen la hora real); el miércoles 14-oct-2026,
   * en America/Mexico_City (UTC-6 todo el año).
   */
  describe('menús «Sólo aparatos» (A3): la tienda en línea no los usa', () => {
    const A_LAS_7_30 = new Date('2026-10-14T13:30:00.000Z')
    const A_LAS_13 = new Date('2026-10-14T19:00:00.000Z') // dentro de «Comida» (12 a 18)
    const A_LAS_20 = new Date('2026-10-15T02:00:00.000Z') // fuera de «Comida»
    let tiendaId: string | undefined
    let bebidasId: string | undefined
    let cafesId: string | undefined

    /** La carta pública a esa hora. Se guarda 60 s por negocio: cada hora se lee de nuevo. */
    const cartaA = async (ahora: Date) => {
      clearPublicMenuCache(tiendaId)
      return getPublicMenu(tiendaId!, ahora)
    }

    beforeAll(async () => {
      const tienda = await prisma.venue.create({
        data: { name: 'ITEST Carta menús', slug: `itest-carta-menus-${RUN}`, organizationId: orgId!, timezone: 'America/Mexico_City' },
      })
      tiendaId = tienda.id
      const v = tienda.id
      const categoria = (name: string, slug: string, displayOrder: number) =>
        prisma.menuCategory.create({ data: { venueId: v, name, slug: `${slug}-menus-${RUN}`, displayOrder } })
      const bebidas = await categoria('Bebidas', 'bebidas', 1)
      const cafes = await categoria('Cafés', 'cafes', 2)
      const postres = await categoria('Postres', 'postres', 3) // no está en ningún menú
      bebidasId = bebidas.id
      cafesId = cafes.id
      const platillo = (name: string, categoryId: string) =>
        prisma.product.create({ data: { venueId: v, name, sku: `${name}-menus-${RUN}`, price: 30, categoryId, availableOnline: true } })
      await platillo('Agua', bebidas.id)
      await platillo('Café americano', cafes.id)
      await platillo('Flan', postres.id)

      const menu = (name: string, o: Record<string, unknown> = {}) => prisma.menu.create({ data: { venueId: v, name, ...o } })
      const comida = await menu('Comida', { availableFrom: '12:00', availableUntil: '18:00' }) // «Aparatos» y «Tienda en línea» (el default)
      const barra = await menu('Barra', { appliesToOnline: false }) // «Sólo aparatos», sin horario
      const mananas = await menu('Mañanas de aparato', { appliesToOnline: false, availableFrom: '07:00', availableUntil: '11:00' })
      await prisma.menuCategoryAssignment.createMany({
        data: [
          { menuId: comida.id, categoryId: bebidas.id },
          { menuId: barra.id, categoryId: bebidas.id },
          { menuId: mananas.id, categoryId: cafes.id },
        ],
      })
    })

    afterAll(async () => {
      // Limpieza acotada: sin id NO se borra nada (una limpieza sin filtro vaciaría tablas enteras).
      if (!tiendaId) return
      const v = { venueId: tiendaId }
      await prisma.menuCategoryAssignment.deleteMany({ where: { menu: v } })
      await prisma.menu.deleteMany({ where: v })
      await prisma.product.deleteMany({ where: v })
      await prisma.menuCategory.deleteMany({ where: v })
      await prisma.venue.deleteMany({ where: { id: tiendaId } })
    })

    it('Barra sólo de aparatos no abre el horario de Comida en la carta', async () => {
      // La premisa: «Barra» SÍ está asignada a Bebidas en la base; la tienda no la lee porque su casilla «Tienda en línea» está apagada.
      expect(
        await prisma.menuCategoryAssignment.count({ where: { categoryId: bebidasId, menu: { name: 'Barra', appliesToOnline: false } } }),
      ).toBe(1)
      expect((await cartaA(A_LAS_20)).categories.map(c => c.name)).toEqual(['Cafés', 'Postres']) // fuera de 12 a 18: Bebidas sigue fuera
      expect((await cartaA(A_LAS_13)).categories.map(c => c.name)).toEqual(['Bebidas', 'Cafés', 'Postres']) // dentro, sale como siempre
    })

    it('una categoría sólo en menús de aparatos se sigue vendiendo como hoy', async () => {
      // La premisa: «Cafés» SÍ está en un menú activo de aparatos, y su horario (7 a 11) no cubre las 13:00 ni las 20:00.
      expect(
        await prisma.menuCategoryAssignment.count({ where: { categoryId: cafesId, menu: { active: true, appliesToOnline: false } } }),
      ).toBe(1)
      for (const hora of [A_LAS_7_30, A_LAS_13, A_LAS_20]) {
        const carta = await cartaA(hora)
        expect(carta.categories.map(c => c.name)).toContain('Cafés') // igual que «Postres», que no tiene menús
        expect(carta.categories.find(c => c.name === 'Cafés')?.products.map(p => p.name)).toEqual(['Café americano'])
        expect(carta.categories.map(c => c.name)).toContain('Postres')
      }
    })
  })
})
