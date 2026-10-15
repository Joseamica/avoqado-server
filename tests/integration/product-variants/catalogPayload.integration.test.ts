/** TEST_DATABASE_URL=… npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/product-variants/catalogPayload.integration.test.ts */
import { getProduct, getProducts, getProductByBarcode } from '@/services/dashboard/product.dashboard.service'
import { getMenus } from '@/services/dashboard/menu.dashboard.service'
import { listProducts } from '@/controllers/mobile/product.mobile.controller'
import { createProductWithVariants } from '@/services/product-variants/productGroup.service'
import prisma from '@/utils/prismaClient'
import { crearNegocio, NegocioDePrueba } from './fixtures'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))

const VARIANTE = {
  productGroupName: 'Playera',
  productGroupImageUrl: null,
  variantOptions: [{ name: 'Talla', value: 'M', namePosition: 0, valuePosition: 0 }],
}

/** Lo crudo de Prisma (las relaciones) nunca sale; y jamás un campo `variants` (rompe Android e iOS instalados). */
function sinCrudo(p: unknown) {
  expect(p).not.toHaveProperty('variants')
  expect(p).not.toHaveProperty('productGroup')
  expect(p).not.toHaveProperty('variantValues')
}

describe('contrato del catálogo (las dos ramas)', () => {
  let n: NegocioDePrueba
  let varianteId: string
  let sueltoId: string
  beforeAll(async () => {
    n = await crearNegocio('contrato')
    const r = await createProductWithVariants(
      n.venueId,
      {
        name: 'Playera',
        categoryId: n.categoryId,
        options: [{ name: 'Talla', values: ['M'] }],
        variants: [{ values: ['M'], price: 1, gtin: '7501234567890' }],
      },
      n.actor,
    )
    varianteId = r.productIds[0]
    sueltoId = (
      await prisma.product.create({
        data: { venueId: n.venueId, categoryId: n.categoryId, sku: `S-${Date.now()}`, name: 'Suelto', price: 1 } as any,
      })
    ).id
  })
  afterAll(async () => {
    await n?.limpiar()
  })

  it('dashboard/TPV (getProducts): variante con sus 4 campos; suelto con los 4 en null', async () => {
    const ps = await getProducts(n.venueId)
    expect(ps.find(p => p.id === varianteId)).toMatchObject({
      productGroupName: 'Playera',
      variantOptions: [{ name: 'Talla', value: 'M' }],
    })
    expect(ps.find(p => p.id === sueltoId)).toMatchObject({
      productGroupId: null,
      productGroupName: null,
      productGroupImageUrl: null,
      variantOptions: null,
    })
    expect(ps.every(p => !('variants' in p))).toBe(true)
  })

  it('el lector de la TPV resuelve el código a la VARIANTE y trae el nombre del padre', async () => {
    const p = await getProductByBarcode(n.venueId, '7501234567890')
    expect(p).toMatchObject({ id: varianteId, productGroupName: 'Playera' })
    sinCrudo(p)
  })

  it('detalle (getProduct) de la variante: los 4 campos', async () => {
    const p = await getProduct(n.venueId, varianteId)
    expect(p).toMatchObject({ id: varianteId, productGroupId: expect.any(String), ...VARIANTE })
    sinCrudo(p)
  })

  it('menús de la TPV (getMenus): cada producto del menú lleva los 4 campos', async () => {
    const menu = await prisma.menu.create({ data: { venueId: n.venueId, name: 'Menú contrato', availableDays: [] } })
    await prisma.menuCategoryAssignment.create({ data: { menuId: menu.id, categoryId: n.categoryId } })
    const menus = await getMenus(n.venueId)
    const productos = menus.flatMap(m => m.categories.flatMap(a => a.category.products)) as any[]
    expect(productos.find(p => p.id === varianteId)).toMatchObject({ productGroupId: expect.any(String), ...VARIANTE })
    expect(productos.find(p => p.id === sueltoId)).toMatchObject({
      productGroupId: null,
      productGroupName: null,
      productGroupImageUrl: null,
      variantOptions: null,
    })
    productos.forEach(sinCrudo)
  })

  it('POS móvil (listProducts): mismos campos', async () => {
    const res: any = { json: jest.fn() }
    await listProducts({ params: { venueId: n.venueId } } as any, res, jest.fn())
    const data = res.json.mock.calls[0][0].data
    expect(data.find((p: any) => p.id === varianteId)).toMatchObject({ productGroupName: 'Playera' })
    expect(data.find((p: any) => p.id === sueltoId)).toMatchObject({ productGroupName: null, variantOptions: null })
    data.forEach(sinCrudo)
  })
})
