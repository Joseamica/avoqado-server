/**
 * D6: la versión del catálogo del POS (`versionDelCatalogoMovil`) contra un Postgres de verdad. La caché sólo es correcta si
 * TODA escritura que cambia la respuesta de `GET /mobile/venues/:venueId/products` cambia la versión —por Prisma, por SQL a
 * mano sin `updatedAt` o por borrado— y si lo de otro negocio no la toca.
 *
 * TEST_DATABASE_URL=… npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/mobile/catalogoMovil.version.integration.test.ts
 */
import prisma from '@/utils/prismaClient'
import { listProducts } from '@/controllers/mobile/product.mobile.controller'
import { vaciarCacheDelCatalogoMovil, versionDelCatalogoMovil } from '@/services/mobile/catalogoMovil.cache'
import { createProductWithVariants } from '@/services/product-variants/productGroup.service'
import { crearNegocio, NegocioDePrueba } from '../product-variants/fixtures'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))

jest.setTimeout(120_000)

const t = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

async function listar(venueId: string) {
  const res: any = { json: jest.fn(), send: jest.fn(), type: jest.fn() }
  res.type.mockReturnValue(res)
  const next = jest.fn()
  await listProducts({ params: { venueId } } as any, res, next)
  expect(next).not.toHaveBeenCalled()
  return res.json.mock.calls.length ? JSON.parse(JSON.stringify(res.json.mock.calls[0][0])) : JSON.parse(res.send.mock.calls[0][0])
}

describe('D6 — versión del catálogo del POS', () => {
  let n: NegocioDePrueba
  let otro: NegocioDePrueba
  let productoId: string
  let otroProductoId: string
  let grupoId: string
  let materiaId: string
  let recetaId: string
  let varianteId: string

  beforeAll(async () => {
    n = await crearNegocio('d6-version')
    otro = await crearNegocio('d6-otro')
    const s = t()
    const p = await prisma.product.create({
      data: {
        venueId: n.venueId,
        categoryId: n.categoryId,
        sku: `D6-${s}`,
        name: 'Pan de muerto',
        price: 45,
        trackInventory: true,
        inventoryMethod: 'RECIPE',
      } as any,
    })
    productoId = p.id
    await prisma.inventory.create({ data: { productId: productoId, venueId: n.venueId, currentStock: 10 } as any })
    const g = await prisma.modifierGroup.create({
      data: {
        venueId: n.venueId,
        name: `Leche ${s}`,
        modifiers: {
          create: [
            { name: 'Entera', price: 0 },
            { name: 'Avena', price: 12 },
          ],
        },
      },
    })
    grupoId = g.id
    await prisma.productModifierGroup.create({ data: { productId: productoId, groupId: grupoId, displayOrder: 0 } as any })
    const m = await prisma.rawMaterial.create({
      data: {
        venueId: n.venueId,
        name: `Harina ${s}`,
        sku: `HAR-${s}`,
        currentStock: 100,
        unit: 'KILOGRAM',
        unitType: 'WEIGHT',
        minimumStock: 1,
        reorderPoint: 2,
        costPerUnit: 20,
        avgCostPerUnit: 20,
      } as any,
    })
    materiaId = m.id
    const r = await prisma.recipe.create({ data: { productId: productoId, totalCost: 10, portionYield: 1 } as any })
    recetaId = r.id
    await prisma.recipeLine.create({ data: { recipeId: recetaId, rawMaterialId: materiaId, quantity: 0.5, unit: 'KILOGRAM' } as any })
    varianteId = (
      await createProductWithVariants(
        n.venueId,
        {
          name: 'Playera',
          categoryId: n.categoryId,
          options: [{ name: 'Talla', values: ['M'] }],
          variants: [{ values: ['M'], price: 100 }],
        },
        n.actor,
      )
    ).productIds[0]
    otroProductoId = (
      await prisma.product.create({
        data: { venueId: otro.venueId, categoryId: otro.categoryId, sku: `D6O-${s}`, name: 'Ajeno', price: 1 } as any,
      })
    ).id
  })

  afterAll(async () => {
    await prisma.recipeLine.deleteMany({ where: { recipeId: recetaId } })
    await prisma.recipe.deleteMany({ where: { id: recetaId } })
    await prisma.rawMaterial.deleteMany({ where: { id: materiaId } })
    await prisma.productModifierGroup.deleteMany({ where: { productId: productoId } })
    await n?.limpiar()
    await otro?.limpiar()
  })

  beforeEach(() => vaciarCacheDelCatalogoMovil())

  /** Corre la escritura y exige que la versión cambie. */
  async function cambia(escritura: () => Promise<unknown>) {
    const antes = await versionDelCatalogoMovil(n.venueId)
    expect(antes).toEqual(expect.any(String))
    await escritura()
    const despues = await versionDelCatalogoMovil(n.venueId)
    expect(despues).not.toBe(antes)
  }

  it('sin escrituras, la versión no se mueve', async () => {
    const a = await versionDelCatalogoMovil(n.venueId)
    expect(await versionDelCatalogoMovil(n.venueId)).toBe(a)
  })

  it.each([
    ['precio del producto (Prisma)', () => prisma.product.update({ where: { id: productoId }, data: { price: 50 } })],
    [
      'SQL a mano SIN updatedAt (como deliveryReconciliation)',
      () => prisma.$executeRaw`UPDATE "Product" SET "ajusteDeliveryAlgunaVez" = NOT "ajusteDeliveryAlgunaVez" WHERE id = ${productoId}`,
    ],
    ['existencia del inventario', () => prisma.inventory.update({ where: { productId: productoId }, data: { currentStock: 9 } })],
    ['nombre de la categoría', () => prisma.menuCategory.update({ where: { id: n.categoryId }, data: { name: `Panes ${t()}` } })],
    [
      'modificador nuevo en un grupo ligado',
      () => prisma.modifier.create({ data: { groupId: grupoId, name: `Deslactosada ${t()}`, price: 5 } }),
    ],
    ['modificador desactivado', () => prisma.modifier.updateMany({ where: { groupId: grupoId, name: 'Entera' }, data: { active: false } })],
    ['nombre del grupo de modificadores', () => prisma.modifierGroup.update({ where: { id: grupoId }, data: { name: `Leches ${t()}` } })],
    ['existencia del insumo de la receta', () => prisma.rawMaterial.update({ where: { id: materiaId }, data: { currentStock: 99 } })],
    ['cantidad de la línea de receta', () => prisma.recipeLine.updateMany({ where: { recipeId: recetaId }, data: { quantity: 0.6 } })],
    [
      'nombre de la opción de la familia',
      async () => {
        const o = await prisma.productVariantValue.findFirstOrThrow({ where: { productId: varianteId } })
        await prisma.productGroupOption.update({ where: { id: o.optionId }, data: { name: `Tamaño ${t()}` } })
      },
    ],
    [
      'valor de la opción de la familia',
      async () => {
        const o = await prisma.productVariantValue.findFirstOrThrow({ where: { productId: varianteId } })
        await prisma.productGroupOptionValue.update({ where: { id: o.optionValueId }, data: { value: `G-${t()}` } })
      },
    ],
    ['producto desactivado', () => prisma.product.update({ where: { id: varianteId }, data: { active: false } })],
    ['producto reactivado', () => prisma.product.update({ where: { id: varianteId }, data: { active: true } })],
  ])('cambia con: %s', async (_nombre, escritura) => {
    await cambia(escritura as () => Promise<unknown>)
  })

  it('cambia al desligar el grupo de modificadores (borrado) y al volver a ligarlo', async () => {
    await cambia(() => prisma.productModifierGroup.deleteMany({ where: { productId: productoId, groupId: grupoId } }))
    await cambia(() => prisma.productModifierGroup.create({ data: { productId: productoId, groupId: grupoId, displayOrder: 0 } as any }))
  })

  it('lo de OTRO negocio no la toca', async () => {
    const antes = await versionDelCatalogoMovil(n.venueId)
    await prisma.product.update({ where: { id: otroProductoId }, data: { price: 2 } })
    await prisma.menuCategory.update({ where: { id: otro.categoryId }, data: { name: `Otra ${t()}` } })
    expect(await versionDelCatalogoMovil(n.venueId)).toBe(antes)
  })

  it('Codex r1 P1: una transacción VIEJA que confirma DESPUÉS de otra más nueva no deja la misma versión', async () => {
    // A tiene xmin a0. T1 (xid x1) abre y espera. T2 (xid x2 = 2·x1 − a0) cambia B y confirma: el POS baja A=a0, B=x2.
    // Luego T1 cambia A y B y confirma: A=x1, B=x1. Una «suma de xmin» empata (a0 + x2 = 2·x1) y serviría precios viejos.
    const M = 4_294_967_296 // xmin es de 32 bits; txid_current trae la época encima
    const xid = async (c: any = prisma) => Number((await c.$queryRaw`SELECT (txid_current() % ${M})::bigint AS x`)[0].x)
    const rastro: unknown[] = []
    for (let intento = 0; intento < 5; intento++) {
      await prisma.product.update({ where: { id: productoId }, data: { price: 70 + intento } })
      const a0 = Number(
        (await prisma.$queryRaw<Array<{ x: bigint }>>`SELECT xmin::text::bigint AS x FROM "Product" WHERE id = ${productoId}`)[0].x,
      )
      let soltarT1!: () => void
      const puedeSeguir = new Promise<void>(r => (soltarT1 = r))
      let avisarX1!: (x: number) => void
      const x1Listo = new Promise<number>(r => (avisarX1 = r))
      const t1 = prisma.$transaction(
        async tx => {
          avisarX1(await xid(tx))
          await puedeSeguir
          await tx.product.update({ where: { id: productoId }, data: { price: 80 + intento } })
          await tx.product.update({ where: { id: varianteId }, data: { price: 180 + intento } })
        },
        { timeout: 60_000 },
      )
      const x1 = await x1Listo
      const x2 = 2 * x1 - a0
      let ultimo = x1 // gasta xids hasta que el siguiente que se asigne sea x2
      while (ultimo < x2 - 1) ultimo = await xid()
      const empata = await prisma.$transaction(async tx => {
        const propio = await xid(tx)
        rastro.push({ a0, x1, x2, propio })
        if (propio !== x2) return false
        await tx.product.update({ where: { id: varianteId }, data: { price: 150 + intento } })
        return true
      })
      const antes = await versionDelCatalogoMovil(n.venueId)
      soltarT1()
      await t1
      if (!empata) continue
      expect(await versionDelCatalogoMovil(n.venueId)).not.toBe(antes)
      return
    }
    throw new Error(`no se logró armar el empate de xid en 5 intentos: ${JSON.stringify(rastro)}`)
  })

  it('de punta a punta: sin cambios la segunda bajada es idéntica; tras un cambio de precio sale el precio nuevo', async () => {
    const primera = await listar(n.venueId)
    const segunda = await listar(n.venueId)
    const sinHora = (b: any) => JSON.stringify({ ...b, catalogAt: undefined })
    expect(sinHora(segunda)).toBe(sinHora(primera))

    await prisma.product.update({ where: { id: productoId }, data: { price: 61.5 } })
    const tercera = await listar(n.venueId)
    expect(Number(tercera.data.find((p: any) => p.id === productoId).price)).toBe(61.5)

    await prisma.inventory.update({ where: { productId: productoId }, data: { currentStock: 3 } })
    await prisma.rawMaterial.update({ where: { id: materiaId }, data: { currentStock: 1 } })
    await prisma.recipeLine.updateMany({ where: { recipeId: recetaId }, data: { quantity: 0.6 } })
    const cuarta = await listar(n.venueId)
    // 1 kg de harina / 0.6 kg por pieza = 1 pieza disponible: la receta se recalculó con el insumo nuevo.
    expect(cuarta.data.find((p: any) => p.id === productoId).availableQuantity).toBe(1)
  })
})
