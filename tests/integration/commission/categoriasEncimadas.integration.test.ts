// tests/integration/commission/categoriasEncimadas.integration.test.ts
/**
 * Fase 3 de Pago al personal, FT-GRAVES S-SOLAPE (dinero), contra Postgres REAL y por el camino de la terminal (efecto congelado
 * con el cobro + worker).
 *
 * Medido en la QA de FT-GRAVES (D1): dos esquemas activos que comparten una categoría PAGABAN LOS DOS. Una Coca de $25 dejó
 * 12 % $2.59 + 10 % $2.16. La pantalla promete «se pagará una sola vez, con el de mayor prioridad», y eso es lo que se cumple
 * ahora: cada categoría tiene UN dueño, el esquema de mayor prioridad que la reclama. En un empate de prioridad gana el mismo
 * orden de la lista de esquemas: el más nuevo. Cada esquema cobra sólo las categorías de las que es dueño, y el general sigue
 * cobrando el sobrante.
 *
 * Correr: TZ=UTC TEST_DATABASE_URL="<base de prueba>" npx jest --selectProjects=integration \
 *   --runTestsByPath tests/integration/commission/categoriasEncimadas.integration.test.ts --ci --runInBand
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import {
  asegurarBaseDePrueba,
  borrarMundoComisiones,
  categoria,
  cobro,
  crearMundoComisiones,
  devolver,
  MundoComisiones,
  netoVivo,
  orden,
  planear,
  procesarEfectos,
} from './_mundoComisiones'

const D = (n: number) => new Prisma.Decimal(n)
let m: MundoComisiones
let bebidas: string
let comida: string
beforeAll(asegurarBaseDePrueba)
beforeEach(async () => {
  m = await crearMundoComisiones('categorias-encimadas')
  bebidas = await categoria(m)
  comida = await categoria(m)
})
afterEach(() => borrarMundoComisiones(m))

/** Un esquema por categorías de la sede, con su tasa y prioridad. `creado` fija el desempate por antigüedad. */
async function esquemaPorCategorias(nombre: string, tasa: number, prioridad: number, categorias: string[], creado: Date) {
  const c = await prisma.commissionConfig.create({
    data: {
      venueId: m.venueId,
      name: nombre,
      createdById: m.owner,
      recipient: 'PROCESSOR',
      defaultRate: D(tasa),
      includeTax: true,
      priority: prioridad,
      filterByCategories: true,
      categoryIds: categorias,
      effectiveFrom: new Date('2020-01-01T00:00:00Z'),
      createdAt: creado,
    },
  })
  return c.id
}

/** Vende los renglones (categoría, precio), los cobra por la terminal y devuelve { esquema: neto } de ese cobro. */
async function vender(renglones: Array<[string, number]>) {
  const total = renglones.reduce((s, [, p]) => s + p, 0)
  const orderId = await orden(m, { subtotal: total, renglones: renglones.map(([categoryId, precio]) => ({ categoryId, precio })) })
  const pago = await cobro(m, orderId, total)
  await planear(pago)
  await procesarEfectos(m)
  const filas = await prisma.commissionCalculation.findMany({ where: { venueId: m.venueId, paymentId: pago }, take: 20 })
  return { orderId, pago, porEsquema: Object.fromEntries(filas.map(f => [f.configId, f.netCommission.toFixed(2)])) }
}

describe('S-SOLAPE · una categoría en dos esquemas se paga UNA vez, con el de mayor prioridad', () => {
  it('🔴 la misma categoría en dos esquemas: sólo paga el de mayor prioridad (la Coca de la QA)', async () => {
    const doce = await esquemaPorCategorias('Bebidas 12 %', 0.12, 2, [bebidas], new Date('2026-01-01T00:00:00Z'))
    await esquemaPorCategorias('Bebidas 10 %', 0.1, 1, [bebidas], new Date('2026-02-01T00:00:00Z'))
    const { porEsquema } = await vender([[bebidas, 25]])
    expect(porEsquema).toEqual({ [doce]: '3.00' })
  })

  it('🔴 solape PARCIAL: el de menor prioridad cobra sólo lo que no es del otro', async () => {
    const doce = await esquemaPorCategorias('Bebidas 12 %', 0.12, 2, [bebidas], new Date('2026-01-01T00:00:00Z'))
    const diez = await esquemaPorCategorias('Bebidas y comida 10 %', 0.1, 1, [bebidas, comida], new Date('2026-02-01T00:00:00Z'))
    const { porEsquema } = await vender([
      [bebidas, 25],
      [comida, 50],
    ])
    expect(porEsquema).toEqual({ [doce]: '3.00', [diez]: '5.00' })
  })

  it('🔴 empate de prioridad: gana el más nuevo, el mismo orden de la lista de esquemas, siempre', async () => {
    await esquemaPorCategorias('Viejo 12 %', 0.12, 1, [bebidas], new Date('2026-01-01T00:00:00Z'))
    const nuevo = await esquemaPorCategorias('Nuevo 10 %', 0.1, 1, [bebidas], new Date('2026-03-01T00:00:00Z'))
    for (let i = 0; i < 3; i++) expect((await vender([[bebidas, 25]])).porEsquema).toEqual({ [nuevo]: '2.50' })
  })

  it('🔴 dos GENERALES empatados: paga el más nuevo, no el que devuelva Postgres', async () => {
    await prisma.commissionConfig.update({ where: { id: m.configId }, data: { createdAt: new Date('2026-01-01T00:00:00Z') } })
    const nuevo = await prisma.commissionConfig.create({
      data: {
        venueId: m.venueId,
        name: 'General nuevo 5 %',
        createdById: m.owner,
        recipient: 'PROCESSOR',
        defaultRate: D(0.05),
        includeTax: true,
        categoryIds: [],
        effectiveFrom: new Date('2020-01-01T00:00:00Z'),
        createdAt: new Date('2026-03-01T00:00:00Z'),
      },
    })
    for (let i = 0; i < 3; i++) expect((await vender([[comida, 100]])).porEsquema).toEqual({ [nuevo.id]: '5.00' })
  })

  // ── Regresión: lo que no se encima no cambia ──
  it('categorías disjuntas: cada esquema cobra la suya', async () => {
    const doce = await esquemaPorCategorias('Bebidas 12 %', 0.12, 2, [bebidas], new Date('2026-01-01T00:00:00Z'))
    const diez = await esquemaPorCategorias('Comida 10 %', 0.1, 1, [comida], new Date('2026-02-01T00:00:00Z'))
    const { porEsquema } = await vender([
      [bebidas, 25],
      [comida, 50],
    ])
    expect(porEsquema).toEqual({ [doce]: '3.00', [diez]: '5.00' })
  })

  it('el general sigue cobrando el sobrante, y la devolución revierte en proporción', async () => {
    const doce = await esquemaPorCategorias('Bebidas 12 %', 0.12, 2, [bebidas], new Date('2026-01-01T00:00:00Z'))
    const { orderId, pago, porEsquema } = await vender([
      [bebidas, 25],
      [comida, 75],
    ])
    expect(porEsquema).toEqual({ [doce]: '3.00', [m.configId]: '7.50' })
    await devolver(m, pago, 50) // la mitad de la venta
    await procesarEfectos(m)
    expect(await netoVivo({ venueId: m.venueId, orderId, configId: doce })).toBe('1.50')
    expect(await netoVivo({ venueId: m.venueId, orderId, configId: m.configId })).toBe('3.75')
  })
})
