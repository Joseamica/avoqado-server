// tests/integration/online-ordering/menu.integration.test.ts
/**
 * Integration (REAL DB) — la carta pública (`getPublicMenu`, P1-09 de la 1b) contra Postgres de verdad.
 * Lo que los mocks no prueban: que Postgres resuelva igual los filtros de inactivos, el orden y los conteos, y que NINGUNA
 * sentencia de la carta recorra vínculos u opciones de OTRO negocio (un `COUNT` de relación de Prisma se compila como un
 * agregado de toda la tabla metido en un JOIN). Se capturan las sentencias de Prisma y se corre `EXPLAIN ANALYZE` de cada una.
 * Con `EXPLAIN_CARTA=1` imprime los planes.
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
})
