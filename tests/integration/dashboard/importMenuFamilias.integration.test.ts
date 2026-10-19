/**
 * Variantes, bloque 5 — Tarea 5 (spec §0 V8, B10): con PRODUCT_VARIANTS, las filas del import que traen `family` crean la familia
 * MANUAL o le suman tallas; sin la función entran sueltas como hoy. Contra Postgres REAL (base desechable).
 *
 * TEST_DATABASE_URL=… DATABASE_URL=… npx jest --selectProjects=integration --runInBand --runTestsByPath <este archivo> --ci
 */
import type { Server } from 'http'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { importMenu, type ImportMenuData } from '@/services/dashboard/menu.dashboard.service'
import {
  archiveProductGroup,
  createProductWithVariants,
  createVariantRows,
  updateProductGroup,
} from '@/services/product-variants/productGroup.service'
import { createGroupTx, loadGroupContextTx } from '@/services/product-variants/groupWriterTx'
import { deductInventoryForProduct } from '@/services/dashboard/productInventoryIntegration.service'
import { encenderIvaPorProducto } from '@tests/__helpers__/iva-por-producto'
import { assertTestDatabase } from '../shopify/fixtures'
import { crearNegocio, familiaAl8, NegocioDePrueba } from '../product-variants/fixtures'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: () => ({ broadcastMenuUpdated: jest.fn() }) },
}))

jest.setTimeout(180_000)

type Fila = ImportMenuData['categories'][number]['products'][number]

let negocios: NegocioDePrueba[] = []
async function negocio(conVariantes = true): Promise<NegocioDePrueba & { cat: string }> {
  const n = await crearNegocio('import-familias')
  negocios.push(n)
  if (!conVariantes) await prisma.venue.update({ where: { id: n.venueId }, data: { seatCapExempt: false } })
  await prisma.staffVenue.create({ data: { staffId: n.staffId, venueId: n.venueId, role: 'ADMIN', active: true } })
  const cat = (await prisma.menuCategory.findUniqueOrThrow({ where: { id: n.categoryId } })).name
  return { ...n, cat }
}
beforeAll(() => assertTestDatabase())
afterEach(async () => {
  for (const n of negocios) {
    await prisma.catalogVenueBinding.deleteMany({ where: { venueId: n.venueId } })
    await prisma.productModifierGroup.deleteMany({ where: { product: { venueId: n.venueId } } })
    await prisma.staffVenue.deleteMany({ where: { venueId: n.venueId } })
    await prisma.menuCategoryAssignment.deleteMany({ where: { menu: { venueId: n.venueId } } })
    await prisma.menu.deleteMany({ where: { venueId: n.venueId } })
    await n.limpiar()
  }
  negocios = []
})

const archivo = (n: { cat: string }, products: Fila[], mode: 'merge' | 'replace' = 'merge'): ImportMenuData => ({
  mode,
  categories: [{ name: n.cat, slug: n.cat.toLowerCase().replace(/[^a-z0-9]+/g, '-'), products }],
})
/** Una fila de la familia `nombre` con un solo eje «Talla». */
const talla = (sku: string, valor: string, extra: Partial<Fila> = {}, nombre = 'Playera', key?: string): Fila => ({
  name: `${nombre} · ${valor}`,
  sku,
  price: 100,
  family: { ...(key ? { key } : {}), name: nombre, options: [{ name: 'Talla', value: valor }] },
  ...extra,
})
const suelto = (sku: string, extra: Partial<Fila> = {}): Fila => ({ name: `Suelto ${sku}`, sku, price: 50, ...extra })
const porSku = (n: NegocioDePrueba, sku: string) =>
  prisma.product.findFirstOrThrow({ where: { venueId: n.venueId, sku }, include: { inventory: { include: { movements: true } } } })
const familias = (n: NegocioDePrueba) =>
  prisma.productGroup.findMany({
    where: { venueId: n.venueId },
    include: { options: { include: { values: { orderBy: { position: 'asc' } } } }, products: { orderBy: { sku: 'asc' } } },
    orderBy: { createdAt: 'asc' },
  })

/** Una familia SHOPIFY (como la deja «Desde Shopify») con una talla por SKU. */
async function familiaShopify(n: NegocioDePrueba, name: string, externalId: string, skus: string[]): Promise<string> {
  return prisma.$transaction(async tx => {
    const { groupId } = await createGroupTx(tx, n.venueId, {
      name,
      categoryId: n.categoryId,
      type: 'REGULAR',
      imageUrl: null,
      ivaTratamiento: 'IVA_16',
      source: 'SHOPIFY',
      externalId,
      options: [{ name: 'Talla', values: skus.map((_, i) => `T${i}`) }],
    })
    const ctx = await loadGroupContextTx(tx, groupId, { trackInventory: false, createdById: null })
    await createVariantRows(
      tx,
      ctx,
      skus.map((sku, i) => ({ values: [`T${i}`], price: 10, sku })),
      0,
      n.actor,
    )
    return groupId
  })
}

/** Liga el negocio al catálogo maestro con lo mínimo que acepta la base (igual que updateProductGroup.integration). */
async function ligarAlCatalogoMaestro(neg: NegocioDePrueba): Promise<void> {
  const { organizationId, staffId, venueId } = neg
  const s = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase()
  const ref = { organizationId, status: 'ACTIVE' as const, createdById: staffId, updatedById: staffId }
  const catalogItemId = await prisma.$transaction(async tx => {
    const brand = await tx.catalogBrand.create({ data: { ...ref, name: `MARCA-${s}`, normalizedName: `MARCA-${s}` } })
    const manufacturer = await tx.catalogManufacturer.create({ data: { ...ref, name: `FAB-${s}`, normalizedName: `FAB-${s}` } })
    const family = await tx.catalogFamily.create({ data: { ...ref, name: `FAM-${s}`, normalizedName: `FAM-${s}` } })
    const item = await tx.catalogItem.create({
      data: {
        ...ref,
        sku: `CORP-${s}`,
        normalizedSku: `CORP-${s}`,
        kind: 'RETAIL_PRODUCT',
        name: `Artículo ${s}`,
        description: 'Artículo de prueba',
        imageUrl: 'https://img/item.png',
        brandId: brand.id,
        manufacturerId: manufacturer.id,
        familyId: family.id,
        presentationLabel: '1 pieza',
        unit: 'PIECE',
        taxRate: 0.16,
        satProductKey: '50161500',
        satUnitKey: 'H87',
        objetoImp: '02',
        productType: 'REGULAR',
        iepsMode: 'NONE',
      },
    })
    await tx.catalogIdentifier.create({
      data: {
        organizationId,
        catalogItemId: item.id,
        code: `CORP-${s}`,
        normalizedCode: `CORP-${s}`,
        type: 'CORPORATE_SKU',
        status: 'ACTIVE',
        createdById: staffId,
      },
    })
    await tx.catalogItemBusinessType.create({ data: { organizationId, catalogItemId: item.id, businessType: 'RETAIL_STORE' } })
    for (const kind of ['SALE_PRICE', 'PURCHASE_COST'] as const)
      await tx.catalogItemPrice.create({
        data: {
          organizationId,
          catalogItemId: item.id,
          kind,
          amount: 10,
          currency: 'MXN',
          active: true,
          createdById: staffId,
          updatedById: staffId,
        },
      })
    return item.id
  })
  await prisma.catalogVenueBinding.create({
    data: { organizationId, catalogItemId, venueId, status: 'PENDING', createdById: staffId, updatedById: staffId },
  })
  // Antes que el negocio: su organización no se borra con el catálogo vivo.
  negocios.unshift({
    ...neg,
    limpiar: async () => {
      await prisma.catalogVenueBinding.deleteMany({ where: { venueId } })
      await prisma.catalogItem.deleteMany({ where: { organizationId } })
      await prisma.catalogFamily.deleteMany({ where: { organizationId } })
      await prisma.catalogManufacturer.deleteMany({ where: { organizationId } })
      await prisma.catalogBrand.deleteMany({ where: { organizationId } })
    },
  })
}

/** Una transacción que retiene un candado (`sql`) hasta `soltar()`; da su pid para reconocer quién la espera. */
async function retener(sql: Prisma.Sql) {
  let soltar!: () => void
  let listo!: (pid: number) => void
  const pid = new Promise<number>(r => (listo = r))
  const suelta = new Promise<void>(r => (soltar = r))
  const fin = prisma.$transaction(
    async tx => {
      const [fila] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
      await tx.$queryRaw(sql)
      listo(fila.pid)
      await suelta
    },
    { timeout: 60_000 },
  )
  return { pid: await pid, soltar, fin }
}
async function bloqueadaPor(pid: number): Promise<number> {
  for (let i = 0; i < 500; i++) {
    const [fila] = await prisma.$queryRaw<Array<{ pid: number }>>`
      SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND ${pid}::int = ANY(pg_blocking_pids(pid)) LIMIT 1`
    if (fila) return fila.pid
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error(`Nadie quedó esperando a la sesión ${pid}`)
}
const desenlace = (x: PromiseSettledResult<unknown>) => (x.status === 'rejected' ? String((x.reason as Error)?.message ?? x.reason) : 'ok')

describe('importMenu arma familias (V8)', () => {
  it('3 filas Playera/Talla ⇒ familia MANUAL de 3', async () => {
    const n = await negocio()
    const r = await importMenu(n.venueId, archivo(n, [talla('PL-S', 'S'), talla('PL-M', 'M'), talla('PL-L', 'L')]), n.actor)
    expect(r.stats).toMatchObject({
      familiasCreadas: 1,
      tallasEnFamilias: 3,
      products: 3,
      filasDeFamiliaRechazadas: { total: 0, ejemplos: [] },
    })
    const [g] = await familias(n)
    expect(g).toMatchObject({ name: 'Playera', source: 'MANUAL', externalId: null, categoryId: n.categoryId, ivaTratamiento: 'IVA_16' })
    expect(g.options.map(o => [o.name, o.values.map(v => v.value)])).toEqual([['Talla', ['S', 'M', 'L']]])
    expect(g.products.map(p => [p.sku, p.name])).toEqual([
      ['PL-L', 'Playera · L'],
      ['PL-M', 'Playera · M'],
      ['PL-S', 'Playera · S'],
    ])
  })

  it('sin la función quedan sueltas', async () => {
    const n = await negocio(false)
    const r = await importMenu(n.venueId, archivo(n, [talla('PL-S', 'S'), talla('PL-M', 'M')]), n.actor)
    expect(r.stats).toMatchObject({ familiasCreadas: 0, filasConFamiliaSinPlan: 2, products: 2 })
    expect(await familias(n)).toHaveLength(0)
    expect((await porSku(n, 'PL-S')).productGroupId).toBeNull()
  })

  it('re-importar no crea nada', async () => {
    const n = await negocio()
    const filas = [talla('RE-S', 'S'), talla('RE-M', 'M')]
    await importMenu(n.venueId, archivo(n, filas), n.actor)
    const antes = await familias(n)
    const r = await importMenu(n.venueId, archivo(n, filas), n.actor)
    expect(r.stats).toMatchObject({ familiasCreadas: 0, tallasEnFamilias: 0, variantesConservadas: 2, sueltosQueYaExistian: 0 })
    const despues = await familias(n)
    expect(despues).toHaveLength(1)
    expect(despues[0].products.map(p => p.id)).toEqual(antes[0].products.map(p => p.id))
    expect(despues[0].options[0].values).toHaveLength(2)
  })

  it('fila nueva de una familia existente ⇒ talla nueva con valor nuevo', async () => {
    const n = await negocio()
    await importMenu(n.venueId, archivo(n, [talla('EX-S', 'S')]), n.actor)
    const r = await importMenu(n.venueId, archivo(n, [talla('EX-XL', 'XL', { price: 130 })]), n.actor)
    expect(r.stats).toMatchObject({ familiasCreadas: 0, tallasEnFamilias: 1 })
    const [g] = await familias(n)
    expect(g.options[0].values.map(v => v.value)).toEqual(['S', 'XL'])
    expect(g.products.map(p => [p.sku, p.name, p.price.toString()])).toEqual([
      ['EX-S', 'Playera · S', '100'],
      ['EX-XL', 'Playera · XL', '130'],
    ])
  })

  it('SKU que ya era suelto ⇒ se actualiza y cuenta', async () => {
    const n = await negocio()
    await prisma.product.create({ data: { venueId: n.venueId, categoryId: n.categoryId, name: 'Vieja', sku: 'SU-M', price: 10 } })
    const r = await importMenu(n.venueId, archivo(n, [talla('SU-S', 'S'), talla('SU-M', 'M', { price: 77 })]), n.actor)
    expect(r.stats).toMatchObject({ sueltosQueYaExistian: 1, familiasCreadas: 1, tallasEnFamilias: 1 })
    const viejo = await porSku(n, 'SU-M')
    expect(viejo.productGroupId).toBeNull()
    expect(viejo.price.toString()).toBe('77')
  })

  it('fila con código ocupado se rechaza y la familia no gana su valor', async () => {
    const n = await negocio()
    await prisma.product.create({
      data: { venueId: n.venueId, categoryId: n.categoryId, name: 'Dueño', sku: 'OCUPA', price: 10, gtin: '7501' },
    })
    const r = await importMenu(n.venueId, archivo(n, [talla('CO-S', 'S'), talla('CO-M', 'M', { gtin: '7501' })]), n.actor)
    expect(r.stats.filasDeFamiliaRechazadas).toEqual({
      total: 1,
      ejemplos: [{ sku: 'CO-M', name: 'Playera · M', motivo: 'El código 7501 ya lo tiene «Dueño».' }],
    })
    const [g] = await familias(n)
    expect(g.options[0].values.map(v => v.value)).toEqual(['S'])
    expect(await prisma.product.count({ where: { venueId: n.venueId, sku: 'CO-M' } })).toBe(0)
  })

  it('fila con costo 0 junto a una buena: la primera se reporta, la segunda entra', async () => {
    const n = await negocio()
    const r = await importMenu(n.venueId, archivo(n, [talla('C0-S', 'S', { cost: 0 }), talla('C0-M', 'M', { cost: 40 })]), n.actor)
    expect(r.stats.filasDeFamiliaRechazadas.ejemplos).toEqual([
      { sku: 'C0-S', name: 'Playera · S', motivo: 'El costo de «S» debe ser mayor a 0 y hasta 10,000,000.' },
    ])
    const [g] = await familias(n)
    expect(g.products.map(p => p.sku)).toEqual(['C0-M'])
    expect(g.options[0].values.map(v => v.value)).toEqual(['M'])
  })

  it('fila con Familia y un valor vacío se rechaza y no entra suelta', async () => {
    const n = await negocio()
    const r = await importMenu(n.venueId, archivo(n, [talla('VA-S', '  ')]), n.actor)
    expect(r.stats.filasDeFamiliaRechazadas.total).toBe(1)
    expect(r.stats.filasDeFamiliaRechazadas.ejemplos[0]).toMatchObject({ sku: 'VA-S', motivo: 'Falta el valor de «Talla».' })
    expect(await prisma.product.count({ where: { venueId: n.venueId } })).toBe(0)
    expect(await familias(n)).toHaveLength(0)
  })

  it('fila de familia con extras se rechaza', async () => {
    const n = await negocio()
    const extras = [{ name: 'Grabado', required: false, allowMultiple: false, minSelections: 0, maxSelections: 1, modifiers: [] }]
    const r = await importMenu(n.venueId, archivo(n, [talla('MX-S', 'S', { modifierGroups: extras }), talla('MX-M', 'M')]), n.actor)
    expect(r.stats.filasDeFamiliaRechazadas.ejemplos).toEqual([
      { sku: 'MX-S', name: 'Playera · S', motivo: 'Los extras de una familia se ponen en el panel' },
    ])
    expect((await familias(n))[0].products.map(p => p.sku)).toEqual(['MX-M'])
    expect(await prisma.modifierGroup.count({ where: { venueId: n.venueId } })).toBe(0)
  })

  it('dos llaves con el mismo nombre ⇒ la segunda rechazada', async () => {
    const n = await negocio()
    const r = await importMenu(
      n.venueId,
      archivo(n, [talla('K1-S', 'S', {}, 'Playera', 'h1'), talla('K2-S', 'S', {}, ' playera ', 'h2')]),
      n.actor,
    )
    expect(r.stats.filasDeFamiliaRechazadas.ejemplos).toEqual([
      { sku: 'K2-S', name: ' playera  · S', motivo: 'Otra familia del archivo ya se llama así' },
    ])
    const gs = await familias(n)
    expect(gs.map(g => [g.name, g.externalId, g.products.length])).toEqual([['Playera', 'h1', 1]])
  })

  it('familia SHOPIFY homónima no se usa', async () => {
    const n = await negocio()
    const shopify = await familiaShopify(n, 'Playera', 'gid://shopify/Product/1', ['SH-S'])
    const r = await importMenu(n.venueId, archivo(n, [talla('MA-S', 'S'), talla('MA-M', 'M')]), n.actor)
    expect(r.stats).toMatchObject({ familiasCreadas: 1, tallasEnFamilias: 2 })
    const gs = await familias(n)
    expect(gs.map(g => [g.source, g.products.length])).toEqual([
      ['SHOPIFY', 1],
      ['MANUAL', 2],
    ])
    expect(gs.find(g => g.id === shopify)!.products.map(p => p.sku)).toEqual(['SH-S'])
  })

  it('S sin inventario y M con inventario en la misma familia descuentan como pidió su fila', async () => {
    const n = await negocio()
    await importMenu(n.venueId, archivo(n, [talla('IN-S', 'S'), talla('IN-M', 'M', { trackInventory: true, currentStock: 4 })]), n.actor)
    const s = await porSku(n, 'IN-S')
    const m = await porSku(n, 'IN-M')
    expect(s).toMatchObject({ trackInventory: false, inventory: null })
    expect(m).toMatchObject({ trackInventory: true, inventoryMethod: 'QUANTITY' })
    expect(m.inventory?.currentStock.toString()).toBe('4')
    expect(m.inventory?.movements.map(x => x.reason)).toEqual(['Saldo inicial (importación de menú)'])
    // Y venden de verdad (el camino de la venta: TPV, POS y ligas descuentan por aquí): S no descuenta nada, M baja 1.
    await deductInventoryForProduct(n.venueId, s.id, 1, `orden-${Date.now()}-s`)
    await deductInventoryForProduct(n.venueId, m.id, 1, `orden-${Date.now()}-m`)
    expect((await porSku(n, 'IN-S')).inventory).toBeNull()
    const vendida = await porSku(n, 'IN-M')
    expect(vendida.inventory?.currentStock.toString()).toBe('3')
    expect(vendida.inventory?.movements).toHaveLength(2)
  })

  it('C: un valor de opción de 45 caracteres ⇒ esa fila se rechaza con su motivo (el panel no deja editar más de 40) y el resto entra', async () => {
    const n = await negocio()
    const largo = 'x'.repeat(45)
    const r = await importMenu(n.venueId, archivo(n, [talla('LG-S', 'S'), talla('LG-L', largo)]), n.actor)
    expect(r.stats.filasDeFamiliaRechazadas.total).toBe(1)
    expect(r.stats.filasDeFamiliaRechazadas.ejemplos).toEqual([
      expect.objectContaining({ sku: 'LG-L', motivo: `El valor «${largo}» de Talla puede tener hasta 40 caracteres.` }),
    ])
    const [g] = await familias(n)
    expect(g.products.map(p => p.sku)).toEqual(['LG-S'])
    expect(await prisma.product.count({ where: { venueId: n.venueId, sku: 'LG-L' } })).toBe(0)
  })

  it('fila de familia con trackInventory, minStock 5, currentStock 3, etiquetas y alérgenos ⇒ la talla nueva los tiene y re-importar no los cambia', async () => {
    const n = await negocio()
    const fila = talla('H6-S', 'S', {
      trackInventory: true,
      minStock: 5,
      currentStock: 3,
      tags: ['verano'],
      allergens: ['algodón'],
      duration: 30,
      gtin: '7509',
      cost: 20,
      inventoryByQuantity: { unit: 'PIECE' },
    })
    await importMenu(n.venueId, archivo(n, [fila]), n.actor)
    const leer = async () => {
      const p = await porSku(n, 'H6-S')
      return {
        grupo: Boolean(p.productGroupId),
        tags: p.tags,
        allergens: p.allergens,
        duration: p.duration,
        gtin: p.gtin,
        cost: p.cost?.toString(),
        unit: p.unit,
        track: [p.trackInventory, p.inventoryMethod],
        stock: p.inventory?.currentStock.toString(),
        min: p.inventory?.minimumStock.toString(),
        movimientos: p.inventory?.movements.length,
      }
    }
    const primero = await leer()
    expect(primero).toEqual({
      grupo: true,
      tags: ['verano'],
      allergens: ['algodón'],
      duration: 30,
      gtin: '7509',
      cost: '20',
      unit: 'PIECE',
      track: [true, 'QUANTITY'],
      stock: '3',
      min: '5',
      movimientos: 1,
    })
    await importMenu(n.venueId, archivo(n, [fila]), n.actor)
    expect(await leer()).toEqual(primero)
  })

  it('modo replace con familias', async () => {
    const n = await negocio()
    await prisma.product.create({ data: { venueId: n.venueId, categoryId: n.categoryId, name: 'Se va', sku: 'VIEJO', price: 10 } })
    const r = await importMenu(n.venueId, archivo(n, [talla('RP-S', 'S'), talla('RP-M', 'M'), suelto('RP-X')], 'replace'), n.actor)
    expect(r.stats).toMatchObject({ familiasCreadas: 1, tallasEnFamilias: 2, productsArchived: 1 })
    expect((await porSku(n, 'VIEJO')).deletedAt).not.toBeNull()
    const [g] = await familias(n)
    expect(g.products.map(p => p.sku)).toEqual(['RP-M', 'RP-S'])
    const asignada = await prisma.menuCategoryAssignment.count({ where: { categoryId: n.categoryId, menu: { venueId: n.venueId } } })
    expect(asignada).toBe(1)
  })

  it('re-importar una familia con SKUs con espacios ⇒ actualiza, no choca', async () => {
    const n = await negocio()
    const filas = [talla(' ES-S ', 'S'), talla('ES-M  ', 'M')]
    await importMenu(n.venueId, archivo(n, filas), n.actor)
    // Se guarda recortado; el segundo archivo trae el mismo texto con espacios y debe encontrarlo, no chocar con «ya lo usa otro».
    expect((await familias(n))[0].products.map(p => p.sku)).toEqual(['ES-M', 'ES-S'])
    const r = await importMenu(n.venueId, archivo(n, [talla(' ES-S ', 'S', { price: 130 }), talla('ES-M  ', 'M')]), n.actor)
    expect(r.stats).toMatchObject({ familiasCreadas: 0, tallasEnFamilias: 0, variantesConservadas: 2 })
    expect(r.stats.filasDeFamiliaRechazadas).toEqual({ total: 0, ejemplos: [] })
    expect(await familias(n)).toHaveLength(1)
    expect(await prisma.product.count({ where: { venueId: n.venueId } })).toBe(2)
  })

  it('replace: familia cuyas tallas viejas no vienen en el archivo ⇒ se archiva y nace otra con la misma llave (IVA 16 %, sin extras)', async () => {
    // Documenta el comportamiento de hoy; no lo cambia.
    const n = await negocio()
    await importMenu(
      n.venueId,
      archivo(n, [talla('RF-S', 'S', {}, 'Playera', 'playera'), talla('RF-M', 'M', {}, 'Playera', 'playera')]),
      n.actor,
    )
    const [vieja] = await familias(n)
    const extras = await prisma.modifierGroup.create({ data: { venueId: n.venueId, name: 'Bordado' } as any })
    await prisma.productGroupModifierGroup.create({ data: { groupId: vieja.id, modifierGroupId: extras.id } })

    const r = await importMenu(
      n.venueId,
      archivo(n, [talla('RF-L', 'L', {}, 'Playera', 'playera'), talla('RF-XL', 'XL', {}, 'Playera', 'playera')], 'replace'),
      n.actor,
    )
    expect(r.stats).toMatchObject({ familiasCreadas: 1, tallasEnFamilias: 2, productsArchived: 2 })
    expect(r.stats.filasDeFamiliaRechazadas.total).toBe(0)

    const todas = await prisma.productGroup.findMany({
      where: { venueId: n.venueId },
      include: { modifierGroups: true, products: { orderBy: { sku: 'asc' } } },
    })
    expect(todas).toHaveLength(2)
    const archivada = todas.find(g => g.id === vieja.id)!
    const nueva = todas.find(g => g.id !== vieja.id)!
    expect(archivada.deletedAt).not.toBeNull()
    expect(archivada.products.every(p => p.deletedAt !== null)).toBe(true)
    expect(nueva).toMatchObject({ externalId: 'playera', source: 'MANUAL', ivaTratamiento: 'IVA_16', deletedAt: null })
    expect(nueva.modifierGroups).toHaveLength(0)
    expect(nueva.products.map(p => p.sku)).toEqual(['RF-L', 'RF-XL'])
  })

  it('replace con una fila de familia mala ⇒ 400 con la lista y el producto, sus extras y sus vínculos intactos', async () => {
    const n = await negocio()
    const mg = await prisma.modifierGroup.create({ data: { venueId: n.venueId, name: 'Salsas' } as any })
    const p = await prisma.product.create({
      data: { venueId: n.venueId, categoryId: n.categoryId, name: 'Queda', sku: 'QUEDA', price: 10 },
    })
    await prisma.productModifierGroup.create({ data: { productId: p.id, groupId: mg.id, displayOrder: 0 } })
    const e = await importMenu(n.venueId, archivo(n, [talla('MA-S', 'S'), talla('MA-M', 'M', { price: 0 })], 'replace'), n.actor).catch(
      x => x,
    )
    expect(e).toMatchObject({
      statusCode: 400,
      code: 'MENU_IMPORT_FAMILY_ROWS_REJECTED',
      details: {
        filasDeFamiliaRechazadas: {
          total: 1,
          ejemplos: [{ sku: 'MA-M', name: 'Playera · M', motivo: 'El precio de «M» debe ser mayor a 0 y de hasta 10,000,000.' }],
        },
      },
    })
    expect(await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ deletedAt: null, active: true })
    expect(await prisma.modifierGroup.findUniqueOrThrow({ where: { id: mg.id } })).toMatchObject({ active: true })
    expect(await prisma.productModifierGroup.count({ where: { productId: p.id } })).toBe(1)
    expect(await familias(n)).toHaveLength(0)
  })

  it('SKU existente con Familia incompleta o con extras ⇒ rechazado y su precio NO cambia', async () => {
    const n = await negocio()
    await prisma.product.create({ data: { venueId: n.venueId, categoryId: n.categoryId, name: 'A', sku: 'EXA', price: 10 } })
    await prisma.product.create({ data: { venueId: n.venueId, categoryId: n.categoryId, name: 'B', sku: 'EXB', price: 10 } })
    const extras = [{ name: 'Grabado', required: false, allowMultiple: false, minSelections: 0, maxSelections: 1, modifiers: [] }]
    const r = await importMenu(
      n.venueId,
      archivo(n, [
        { ...suelto('EXA', { price: 99 }), family: { name: 'Playera' } },
        talla('EXB', 'S', { price: 99, modifierGroups: extras }),
      ]),
      n.actor,
    )
    expect(r.stats.filasDeFamiliaRechazadas.ejemplos.map(x => [x.sku, x.motivo])).toEqual([
      ['EXA', 'La familia necesita de 1 a 3 opciones (por ejemplo Talla).'],
      ['EXB', 'Los extras de una familia se ponen en el panel'],
    ])
    expect((await porSku(n, 'EXA')).price.toString()).toBe('10')
    expect((await porSku(n, 'EXB')).price.toString()).toBe('10')
  })

  it('re-importar un SKU de una familia SHOPIFY archivada y reemplazada no aborta', async () => {
    const n = await negocio()
    const vieja = await familiaShopify(n, 'Gorra', 'gid://shopify/Product/9', ['GO-OLD'])
    await archiveProductGroup(n.venueId, vieja, n.staffId)
    await familiaShopify(n, 'Gorra', 'gid://shopify/Product/9', ['GO-NEW'])
    const r = await importMenu(n.venueId, archivo(n, [suelto('GO-OLD', { price: 60 }), suelto('OTRO')]), n.actor)
    expect(r.stats).toMatchObject({ variantesDeFamiliaReemplazada: 1, productsRestored: 0 })
    expect((await porSku(n, 'GO-OLD')).deletedAt).not.toBeNull()
    expect((await prisma.productGroup.findUniqueOrThrow({ where: { id: vieja } })).deletedAt).not.toBeNull()
    expect((await porSku(n, 'OTRO')).deletedAt).toBeNull()
  })

  it('Handle importado → familia archivada → mismo Handle con SKU nuevo → reimportar el SKU viejo ⇒ no aborta y la otra fila buena entra', async () => {
    const n = await negocio()
    await importMenu(n.venueId, archivo(n, [talla('HA-OLD', 'S', {}, 'Playera', 'h-1')]), n.actor)
    const [primera] = await familias(n)
    await archiveProductGroup(n.venueId, primera.id, n.staffId)
    await importMenu(n.venueId, archivo(n, [talla('HA-NEW', 'M', {}, 'Playera', 'h-1')]), n.actor)
    const r = await importMenu(
      n.venueId,
      archivo(n, [talla('HA-OLD', 'S', {}, 'Playera', 'h-1'), talla('HA-NEW2', 'L', {}, 'Playera', 'h-1')]),
      n.actor,
    )
    expect(r.stats).toMatchObject({ variantesDeFamiliaReemplazada: 1, tallasEnFamilias: 1, productsRestored: 0 })
    expect((await porSku(n, 'HA-OLD')).deletedAt).not.toBeNull()
    const viva = (await familias(n)).find(g => !g.deletedAt)!
    expect(viva.products.map(p => p.sku)).toEqual(['HA-NEW', 'HA-NEW2'])
  })

  it('restaurar una talla archivada cuya familia MANUAL tiene el nombre ocupado por otra viva ⇒ no se restaura y no aborta', async () => {
    const n = await negocio()
    const una = await createProductWithVariants(
      n.venueId,
      {
        name: 'Gorra',
        categoryId: n.categoryId,
        options: [{ name: 'Talla', values: ['U'] }],
        variants: [{ values: ['U'], price: 1, sku: 'GA-1' }],
      },
      n.actor,
    )
    await archiveProductGroup(n.venueId, una.groupId, n.staffId)
    await createProductWithVariants(
      n.venueId,
      {
        name: 'Gorra',
        categoryId: n.categoryId,
        options: [{ name: 'Talla', values: ['U'] }],
        variants: [{ values: ['U'], price: 1, sku: 'GA-2' }],
      },
      n.actor,
    )
    const r = await importMenu(n.venueId, archivo(n, [suelto('GA-1'), suelto('GA-X')]), n.actor)
    expect(r.stats).toMatchObject({ variantesDeFamiliaReemplazada: 1 })
    expect((await porSku(n, 'GA-1')).deletedAt).not.toBeNull()
    expect((await porSku(n, 'GA-X')).deletedAt).toBeNull()
  })

  it('dos archivos convertidos con Handles distintos y el mismo título, en dos llamadas a importMenu ⇒ la segunda se rechaza por nombre, no se une', async () => {
    const n = await negocio()
    await importMenu(n.venueId, archivo(n, [talla('T1-S', 'S', {}, 'Playera', 'handle-a')]), n.actor)
    const r = await importMenu(n.venueId, archivo(n, [talla('T2-S', 'S', {}, 'Playera', 'handle-b')]), n.actor)
    expect(r.stats.filasDeFamiliaRechazadas.ejemplos).toEqual([
      { sku: 'T2-S', name: 'Playera · S', motivo: 'Ya existe otra familia «Playera»: renómbrala o usa el mismo identificador' },
    ])
    const gs = await familias(n)
    expect(gs.map(g => [g.externalId, g.products.map(p => p.sku)])).toEqual([['handle-a', ['T1-S']]])
  })

  it('familia APPOINTMENTS_SERVICE, IVA heredado de 8 % y negocio con catálogo maestro ⇒ filas rechazadas con su motivo y el resto entra', async () => {
    const n = await negocio()
    await familiaAl8(n, 'Blusa')
    const r = await importMenu(
      n.venueId,
      archivo(n, [talla('SV-1', 'Corto', { type: 'APPOINTMENTS_SERVICE' }, 'Corte'), talla('BL-L', 'L', {}, 'Blusa'), suelto('RESTO-1')]),
      n.actor,
    )
    expect(r.stats.filasDeFamiliaRechazadas.ejemplos.map(x => [x.sku, x.motivo])).toEqual([
      ['SV-1', 'Las variantes todavía no están disponibles para servicios, clases ni eventos.'],
      ['BL-L', 'Esta familia tiene IVA «8 %», que ya no se ofrece; cámbialo a 16 %, tasa 0 % o exento antes de agregar variantes.'],
    ])
    expect((await porSku(n, 'RESTO-1')).deletedAt).toBeNull()

    const m = await negocio()
    await prisma.product.create({ data: { venueId: m.venueId, categoryId: m.categoryId, name: 'Resto', sku: 'RESTO-2', price: 10 } })
    await ligarAlCatalogoMaestro(m)
    const rm = await importMenu(m.venueId, archivo(m, [talla('MC-S', 'S'), suelto('RESTO-2', { price: 33 })]), m.actor)
    expect(rm.stats.filasDeFamiliaRechazadas.ejemplos.map(x => [x.sku, x.motivo])).toEqual([
      ['MC-S', 'Este negocio usa el catálogo maestro; las variantes no están disponibles aquí.'],
    ])
    expect((await porSku(m, 'RESTO-2')).price.toString()).toBe('33')
    expect(await familias(m)).toHaveLength(0)
  })

  it('import con familias y un cambio de IVA de la organización a la vez ⇒ ninguno aborta', async () => {
    const n = await negocio()
    await encenderIvaPorProducto(n.venueId)
    await createProductWithVariants(
      n.venueId,
      {
        name: 'Short',
        categoryId: n.categoryId,
        ivaTratamiento: 'IVA_0',
        options: [{ name: 'Talla', values: ['S'] }],
        variants: [{ values: ['S'], price: 10, sku: 'SH-S' }],
      },
      n.actor,
    )
    const otra = await createProductWithVariants(
      n.venueId,
      { name: 'Otra', categoryId: n.categoryId, options: [{ name: 'Talla', values: ['U'] }], variants: [{ values: ['U'], price: 10 }] },
      n.actor,
    )
    // La barrera detiene el import en el cerco del negocio; el cambio de IVA llega mientras.
    const barrera = await retener(Prisma.sql`SELECT id FROM "Venue" WHERE id = ${n.venueId} FOR SHARE`)
    const imp = importMenu(n.venueId, archivo(n, [talla('SH-M', 'M', {}, 'Short')]), n.actor)
    let iva: Promise<unknown> = Promise.resolve()
    let esperaAlImport = 'sí'
    try {
      const pidImport = await bloqueadaPor(barrera.pid)
      iva = updateProductGroup(n.venueId, otra.groupId, { ivaTratamiento: 'IVA_0' }, n.actor)
      // El cambio de IVA ya espera al import: la organización va primero.
      await bloqueadaPor(pidImport).catch(() => (esperaAlImport = 'no'))
    } finally {
      barrera.soltar() // aunque algo falle arriba: sin esto la prueba se cuelga en vez de fallar
    }
    const [a, b] = await Promise.allSettled([imp, iva])
    await barrera.fin
    expect(esperaAlImport).toBe('sí')
    expect([a, b].map(desenlace)).toEqual(['ok', 'ok'])
    expect((await porSku(n, 'SH-M')).ivaTratamiento).toBe('IVA_0')
    expect((await prisma.productGroup.findUniqueOrThrow({ where: { id: otra.groupId } })).ivaTratamiento).toBe('IVA_0')
  })
})

describe('por HTTP', () => {
  let server: Server
  beforeAll(async () => {
    const app = (await import('@/app')).default
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(listo => server.once('listening', () => listo()))
  })
  afterAll(async () => {
    await new Promise<void>(listo => server.close(() => listo()))
  })
  const importar = (n: NegocioDePrueba, body: ImportMenuData) =>
    request(server)
      .post(`/api/v1/dashboard/venues/${n.venueId}/menu/import`)
      .set({
        Authorization: `Bearer ${jwt.sign(
          { sub: n.staffId, orgId: n.organizationId, venueId: n.venueId, role: 'ADMIN' },
          process.env.ACCESS_TOKEN_SECRET as string,
          { expiresIn: '15m' },
        )}`,
      })
      .send(body)

  it('una fila buena y otra con Familia sin opciones ⇒ 200, la buena entra y la otra se reporta; en Gratis las dos entran sueltas', async () => {
    const filas = (n: { cat: string }) => archivo(n, [talla('HT-S', 'S'), { ...suelto('HT-X'), family: { name: 'Playera' } }])
    const pro = await negocio()
    const r = await importar(pro, filas(pro))
    expect(r.status).toBe(200)
    expect(r.body.stats.filasDeFamiliaRechazadas).toEqual({
      total: 1,
      ejemplos: [{ sku: 'HT-X', name: 'Suelto HT-X', motivo: 'La familia necesita de 1 a 3 opciones (por ejemplo Talla).' }],
    })
    expect((await porSku(pro, 'HT-S')).productGroupId).not.toBeNull()
    expect(await prisma.product.count({ where: { venueId: pro.venueId, sku: 'HT-X' } })).toBe(0)

    const gratis = await negocio(false)
    const g = await importar(gratis, filas(gratis))
    expect(g.status).toBe(200)
    expect(g.body.stats).toMatchObject({ filasConFamiliaSinPlan: 2, filasDeFamiliaRechazadas: { total: 0 } })
    expect((await porSku(gratis, 'HT-S')).productGroupId).toBeNull()
    expect((await porSku(gratis, 'HT-X')).productGroupId).toBeNull()
  })

  it('el servicio devuelve 60 rechazadas y el HTTP sólo 50 ejemplos con total 60', async () => {
    const n = await negocio()
    const malas = Array.from({ length: 60 }, (_, i) => ({ ...suelto(`MAL-${i}`), family: { name: 'Sin opciones' } }))
    const s = await importMenu(n.venueId, archivo(n, malas), n.actor)
    expect(s.stats.filasDeFamiliaRechazadas.total).toBe(60)
    expect(s.stats.filasDeFamiliaRechazadas.ejemplos).toHaveLength(60)
    const h = await importar(n, archivo(n, malas))
    expect(h.status).toBe(200)
    expect(h.body.stats.filasDeFamiliaRechazadas.total).toBe(60)
    expect(h.body.stats.filasDeFamiliaRechazadas.ejemplos).toHaveLength(50)
  })
})
