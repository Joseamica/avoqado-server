/**
 * D20: el catálogo de la TPV (`GET /tpv/venues/:venueId/products`) reutiliza lo ya armado si la versión no cambió. Contra un
 * Postgres de verdad: la huella ve el precio especial (`PricingPolicy`, lo único que la TPV lee y el POS no), y de punta a punta
 * la respuesta sale idéntica byte por byte a la de antes, con objetos reales de Prisma (Decimal, Date), y con lo nuevo tras
 * cada cambio de precio, precio especial, existencia, modificador o receta.
 *
 * TEST_DATABASE_URL=… npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/tpv/catalogoTpv.version.integration.test.ts
 */
import prisma from '@/utils/prismaClient'
import { getProducts } from '@/controllers/tpv/menu.tpv.controller'
import { buildProductsListResponse } from '@/controllers/dashboard/product.dashboard.controller'
import { vaciarCacheDelCatalogoMovil, versionDelCatalogoMovil } from '@/services/mobile/catalogoMovil.cache'
import { crearNegocio, NegocioDePrueba } from '../product-variants/fixtures'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))

jest.setTimeout(120_000)

const t = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
const replacer = (key: string, value: unknown) => (key === 'angelpayWebhookSecret' ? undefined : value)
const conApp = (req: any) => ({ ...req, app: { get: (k: string) => (k === 'json replacer' ? replacer : undefined) } })

/** El texto EXACTO que sale por la red con el handler de hoy (`res.json` → JSON.stringify con el replacer de la app). */
async function bajar(venueId: string, query: Record<string, string> = {}) {
  const res: any = { status: jest.fn(), json: jest.fn(), send: jest.fn(), type: jest.fn() }
  res.status.mockReturnValue(res)
  res.type.mockReturnValue(res)
  const next = jest.fn()
  await getProducts(conApp({ params: { venueId }, query, correlationId: 'corr-d20' }), res, next)
  expect(next).not.toHaveBeenCalled()
  expect(res.status).toHaveBeenCalledWith(200)
  if (res.json.mock.calls.length) return JSON.stringify(res.json.mock.calls[0][0], replacer)
  expect(res.type).toHaveBeenCalledWith('json')
  return res.send.mock.calls[0][0] as string
}

/** Cómo lo armaba el handler ANTES de D20, con la misma hora. */
async function deAntes(venueId: string, catalogAt: string, query: Record<string, string> = {}) {
  const body = await buildProductsListResponse({ params: { venueId }, query, correlationId: 'corr-d20' } as any)
  return JSON.stringify({ ...body, catalogAt }, replacer)
}

describe('D20 — catálogo de la TPV contra Postgres', () => {
  let n: NegocioDePrueba
  let otro: NegocioDePrueba
  let productId: string
  let otroProductoId: string
  let grupoId: string
  let materiaId: string
  let recetaId: string

  beforeAll(async () => {
    n = await crearNegocio('d20-tpv')
    otro = await crearNegocio('d20-otro')
    const s = t()
    productId = (
      await prisma.product.create({
        data: {
          venueId: n.venueId,
          categoryId: n.categoryId,
          sku: `D20-${s}`,
          name: 'Concha',
          price: 18,
          trackInventory: true,
          inventoryMethod: 'RECIPE',
        } as any,
      })
    ).id
    await prisma.inventory.create({ data: { productId, venueId: n.venueId, currentStock: 10 } as any })
    grupoId = (
      await prisma.modifierGroup.create({
        data: { venueId: n.venueId, name: `Relleno ${s}`, modifiers: { create: [{ name: 'Nata', price: 8 }] } },
      })
    ).id
    await prisma.productModifierGroup.create({ data: { productId, groupId: grupoId, displayOrder: 0 } as any })
    materiaId = (
      await prisma.rawMaterial.create({
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
    ).id
    recetaId = (await prisma.recipe.create({ data: { productId, totalCost: 10, portionYield: 1 } as any })).id
    await prisma.recipeLine.create({ data: { recipeId: recetaId, rawMaterialId: materiaId, quantity: 0.5, unit: 'KILOGRAM' } as any })
    otroProductoId = (
      await prisma.product.create({
        data: { venueId: otro.venueId, categoryId: otro.categoryId, sku: `D20O-${s}`, name: 'Ajeno', price: 1 } as any,
      })
    ).id
  })

  afterAll(async () => {
    await prisma.pricingPolicy.deleteMany({ where: { productId: { in: [productId, otroProductoId] } } })
    await prisma.recipeLine.deleteMany({ where: { recipeId: recetaId } })
    await prisma.recipe.deleteMany({ where: { id: recetaId } })
    await prisma.rawMaterial.deleteMany({ where: { id: materiaId } })
    await prisma.productModifierGroup.deleteMany({ where: { productId } })
    await n?.limpiar()
    await otro?.limpiar()
  })

  beforeEach(() => vaciarCacheDelCatalogoMovil())

  async function cambia(escritura: () => Promise<unknown>) {
    const antes = await versionDelCatalogoMovil(n.venueId)
    expect(antes).toEqual(expect.any(String))
    await escritura()
    expect(await versionDelCatalogoMovil(n.venueId)).not.toBe(antes)
  }

  const politica = (venueId: string, productId: string, currentPrice: number) =>
    prisma.pricingPolicy.create({ data: { venueId, productId, calculatedCost: 5, currentPrice } as any })

  it('el precio especial (PricingPolicy) mueve la versión: al crearlo, al cambiarlo y al borrarlo', async () => {
    await cambia(() => politica(n.venueId, productId, 17))
    await cambia(() => prisma.pricingPolicy.update({ where: { productId }, data: { currentPrice: 16.5 } }))
    await cambia(
      () => prisma.$executeRaw`UPDATE "PricingPolicy" SET "pricingStrategy" = "pricingStrategy" WHERE "productId" = ${productId}`,
    )
    await cambia(() => prisma.pricingPolicy.delete({ where: { productId } }))
  })

  it('el precio especial de OTRO negocio no la toca', async () => {
    await politica(otro.venueId, otroProductoId, 1)
    const antes = await versionDelCatalogoMovil(n.venueId)
    await prisma.pricingPolicy.update({ where: { productId: otroProductoId }, data: { currentPrice: 2 } })
    expect(await versionDelCatalogoMovil(n.venueId)).toBe(antes)
  })

  it('de punta a punta: idéntica byte por byte a la de antes, y con lo nuevo tras cada cambio', async () => {
    await politica(n.venueId, productId, 17)
    const conPolitica = { includePricingPolicy: 'true' }
    const iguales = async (query: Record<string, string>) => {
      const texto = await bajar(n.venueId, query)
      expect(texto).toBe(await deAntes(n.venueId, JSON.parse(texto).catalogAt, query))
      return JSON.parse(texto)
    }
    const delProducto = (b: any) => b.data.find((p: any) => p.id === productId)

    // Primera (arma y guarda) y segunda (reutiliza): las dos como antes, para la query de la TPV y con precio especial.
    for (const query of [{}, conPolitica, { categoryId: n.categoryId }] as Record<string, string>[]) {
      await iguales(query)
      await iguales(query)
    }

    await prisma.product.update({ where: { id: productId }, data: { price: 19.5 } })
    expect(Number(delProducto(await iguales({})).price)).toBe(19.5)

    await prisma.pricingPolicy.update({ where: { productId }, data: { currentPrice: 15.25 } })
    expect(Number(delProducto(await iguales(conPolitica)).pricingPolicy.currentPrice)).toBe(15.25)

    await prisma.modifier.updateMany({ where: { groupId: grupoId }, data: { price: 9 } })
    expect(Number(delProducto(await iguales({})).modifierGroups[0].group.modifiers[0].price)).toBe(9)

    await prisma.inventory.update({ where: { productId }, data: { currentStock: 3 } })
    expect(Number(delProducto(await iguales({})).inventory.currentStock)).toBe(3)

    // 1 kg de harina / 0.5 kg por pieza = 2 piezas: la receta se recalculó con el insumo nuevo.
    await prisma.rawMaterial.update({ where: { id: materiaId }, data: { currentStock: 1 } })
    expect(delProducto(await iguales({})).availableQuantity).toBe(2)
    await prisma.recipeLine.updateMany({ where: { recipeId: recetaId }, data: { quantity: 0.25 } })
    expect(delProducto(await iguales({})).availableQuantity).toBe(4)
  })
})
