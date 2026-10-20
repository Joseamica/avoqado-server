/** TEST_DATABASE_URL=… npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/product-variants/existingWriters.integration.test.ts */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import {
  assignModifierGroupToProduct as assignProductService,
  deleteProduct,
  removeModifierGroupFromProduct as removeProductService,
  updateProduct,
} from '@/services/dashboard/product.dashboard.service'
import {
  deleteProduct as deleteMobile,
  listProducts as listMobile,
  updateProduct as updateMobile,
} from '@/controllers/mobile/product.mobile.controller'
import {
  assignModifierGroupToProduct,
  createMenuCategory,
  deleteMenuCategory,
  deleteModifierGroup,
  getMenus,
  importMenu,
  removeModifierGroupFromProduct,
  updateMenuCategory,
} from '@/services/dashboard/menu.dashboard.service'
import { assignRouting, deleteStation } from '@/services/dashboard/printStation.dashboard.service'
import {
  addVariants,
  archiveProductGroup,
  createProductWithVariants,
  ungroupProductGroup,
  updateProductGroup,
} from '@/services/product-variants/productGroup.service'
import { deleteFileFromStorage } from '@/services/storage.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { crearNegocio, NegocioDePrueba } from './fixtures'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))
jest.mock('@/services/storage.service', () => ({ deleteFileFromStorage: jest.fn().mockResolvedValue(undefined) }))

jest.setTimeout(120_000)

const t = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

describe('los escritores de hoy con una variante', () => {
  let n: NegocioDePrueba
  let v: string
  beforeAll(async () => {
    n = await crearNegocio('escritores')
    v = (
      await createProductWithVariants(
        n.venueId,
        {
          name: 'Camisa',
          categoryId: n.categoryId,
          options: [{ name: 'Talla', values: ['M'] }],
          variants: [{ values: ['M'], price: 100 }],
        },
        n.actor,
      )
    ).productIds[0]
  })
  afterAll(async () => {
    await n?.limpiar()
  })

  it('dashboard: cambiar el nombre de una variante da 409 en español; el precio sí se cambia', async () => {
    await expect(updateProduct(n.venueId, v, { name: 'Otra cosa' } as any, n.actor)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/se edita en el producto «Camisa»/),
    })
    await expect(updateProduct(n.venueId, v, { price: 120 } as any, n.actor)).resolves.toMatchObject({ id: v })
  })

  it('dashboard: el formulario completo con el mismo nombre y categoría pasa', async () => {
    await expect(
      updateProduct(n.venueId, v, { name: 'Camisa · M', categoryId: n.categoryId, price: 130 } as any, n.actor),
    ).resolves.toMatchObject({ id: v })
  })

  it('POS móvil: cambiar la categoría de una variante da 409; el precio sí', async () => {
    const res = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() })
    const next = jest.fn()
    await updateMobile(
      { params: { venueId: n.venueId, productId: v }, body: { categoryId: n.otraCategoriaId }, authContext: { userId: n.staffId } } as any,
      res() as any,
      next,
    )
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409 }))

    const ok = res()
    const next2 = jest.fn()
    await updateMobile(
      {
        params: { venueId: n.venueId, productId: v },
        body: { price: 140, categoryId: n.categoryId },
        authContext: { userId: n.staffId },
      } as any,
      ok as any,
      next2,
    )
    expect(next2).not.toHaveBeenCalled()
    expect(ok.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }))
  })

  it.each([
    ['menú: asignar', (mg: string) => assignModifierGroupToProduct(n.venueId, v, { modifierGroupId: mg } as any)],
    ['menú: quitar', (mg: string) => removeModifierGroupFromProduct(n.venueId, v, mg)],
    ['producto: asignar', (mg: string) => assignProductService(n.venueId, v, { modifierGroupId: mg })],
    ['producto: quitar', (mg: string) => removeProductService(n.venueId, v, mg)],
  ])('🔴 %s un extra a UNA variante se rechaza (los extras son del padre)', async (_n, llamar) => {
    const mg = await prisma.modifierGroup.create({ data: { venueId: n.venueId, name: `Extra ${t()}` } as any })
    await expect(llamar(mg.id)).rejects.toMatchObject({ statusCode: 409 })
    expect(await prisma.productModifierGroup.count({ where: { productId: v, groupId: mg.id } })).toBe(0)
  })

  it('mover una variante suelta a otra categoría desde «crear categoría» se rechaza sin crear la categoría', async () => {
    const antes = await prisma.menuCategory.count({ where: { venueId: n.venueId } })
    await expect(createMenuCategory(n.venueId, { name: `Nueva ${t()}`, avoqadoProducts: [{ value: v }] } as any)).rejects.toMatchObject({
      statusCode: 409,
    })
    expect(await prisma.menuCategory.count({ where: { venueId: n.venueId } })).toBe(antes)
  })

  it('«editar categoría» que se lleva una variante se rechaza sin tocar la categoría', async () => {
    await expect(
      updateMenuCategory(n.venueId, n.otraCategoriaId, { name: `Cambiada ${t()}`, avoqadoProducts: [{ value: v }] } as any),
    ).rejects.toMatchObject({ statusCode: 409 })
    const p = await prisma.product.findUniqueOrThrow({ where: { id: v }, select: { categoryId: true } })
    expect(p.categoryId).toBe(n.categoryId)
  })

  it('#7: guardar la categoría de una variante con sus productos actuales (el formulario los reenvía) y nombre nuevo pasa', async () => {
    const suelto = await prisma.product.create({
      data: { venueId: n.venueId, categoryId: n.otraCategoriaId, sku: `SUELTO-${t()}`, name: `Suelto ${t()}`, price: 5 } as any,
    })
    const nombre = `Ropa renombrada ${t()}`
    // Reenvía la variante (ya está aquí) y además se trae un suelto de otra categoría: sólo el suelto cambia de categoría.
    await expect(
      updateMenuCategory(n.venueId, n.categoryId, { name: nombre, avoqadoProducts: [{ value: v }, { value: suelto.id }] } as any),
    ).resolves.toMatchObject({ id: n.categoryId, name: nombre })
    expect((await prisma.product.findUniqueOrThrow({ where: { id: v } })).categoryId).toBe(n.categoryId)
    expect((await prisma.product.findUniqueOrThrow({ where: { id: suelto.id } })).categoryId).toBe(n.categoryId)
  })

  it('impresoras: mandar una variante a otra estación se rechaza con 409 y no mueve nada', async () => {
    const st = await prisma.printStation.create({ data: { venueId: n.venueId, name: `Barra ${t()}` } })
    await expect(assignRouting(n.venueId, { products: [{ id: v, printStationId: st.id }] } as any)).rejects.toMatchObject({
      statusCode: 409,
    })
    expect((await prisma.product.findUniqueOrThrow({ where: { id: v } })).printStationId).toBeNull()
  })

  it('la foto que comparte la familia no se borra del almacenamiento al borrar una variante', async () => {
    const r = await createProductWithVariants(
      n.venueId,
      {
        name: `Gorra ${t()}`,
        imageUrl: 'https://img/familia-gorra.png',
        categoryId: n.categoryId,
        options: [{ name: 'Color', values: ['Rojo', 'Azul'] }],
        variants: [
          { values: ['Rojo'], price: 10 },
          { values: ['Azul'], price: 10 },
        ],
      },
      n.actor,
    )
    ;(deleteFileFromStorage as jest.Mock).mockClear()
    await deleteProduct(n.venueId, r.productIds[0], n.staffId)
    expect(deleteFileFromStorage).not.toHaveBeenCalled()
  })

  it('3c: archivar la última variante viva archiva también al padre; mientras quede una, el padre sigue', async () => {
    const r = await createProductWithVariants(
      n.venueId,
      {
        name: `Sudadera ${t()}`,
        categoryId: n.categoryId,
        options: [{ name: 'Talla', values: ['S', 'M'] }],
        variants: [
          { values: ['S'], price: 10 },
          { values: ['M'], price: 10 },
        ],
      },
      n.actor,
    )
    ;(logAction as jest.Mock).mockClear()
    await deleteProduct(n.venueId, r.productIds[0], n.staffId)
    expect((await prisma.productGroup.findUniqueOrThrow({ where: { id: r.groupId } })).deletedAt).toBeNull()
    expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'PRODUCT_GROUP_ARCHIVED' }))
    await deleteProduct(n.venueId, r.productIds[1], n.staffId)
    expect(await prisma.productGroup.findUniqueOrThrow({ where: { id: r.groupId } })).toMatchObject({
      deletedAt: expect.any(Date),
      deletedBy: n.staffId,
    })
    // Ronda 1 (N2): el padre archivado deja su propio renglón de bitácora.
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PRODUCT_GROUP_ARCHIVED',
        entity: 'ProductGroup',
        entityId: r.groupId,
        venueId: n.venueId,
        staffId: n.staffId,
      }),
    )
  })

  it('N2: borrar desde el POS móvil la última variante archiva al padre y lo registra', async () => {
    const r = await createProductWithVariants(
      n.venueId,
      {
        name: `Bufanda ${t()}`,
        categoryId: n.categoryId,
        options: [{ name: 'Talla', values: ['U'] }],
        variants: [{ values: ['U'], price: 10 }],
      },
      n.actor,
    )
    ;(logAction as jest.Mock).mockClear()
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    await deleteMobile(
      { params: { venueId: n.venueId, productId: r.productIds[0] }, authContext: { userId: n.staffId } } as any,
      res as any,
      jest.fn(),
    )
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { id: r.productIds[0] } })
    expect((await prisma.productGroup.findUniqueOrThrow({ where: { id: r.groupId } })).deletedAt).not.toBeNull()
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PRODUCT_GROUP_ARCHIVED', entityId: r.groupId, staffId: n.staffId }),
    )
  })

  it('N3: los mismos extras en otro orden no son un cambio: 200, sin reescribir uniones ni su orden', async () => {
    const s = t()
    const a = await prisma.modifierGroup.create({ data: { venueId: n.venueId, name: `Bolsa ${s}` } as any })
    const b = await prisma.modifierGroup.create({ data: { venueId: n.venueId, name: `Envoltura ${s}` } as any })
    const r = await createProductWithVariants(
      n.venueId,
      {
        name: `Mochila ${s}`,
        categoryId: n.categoryId,
        modifierGroupIds: [a.id, b.id],
        options: [{ name: 'Color', values: ['Negro'] }],
        variants: [{ values: ['Negro'], price: 10 }],
      },
      n.actor,
    )
    const uniones = () =>
      prisma.productModifierGroup.findMany({ where: { productId: r.productIds[0] }, orderBy: { groupId: 'asc' }, take: 10 })
    const antes = await uniones()
    await expect(
      updateProduct(n.venueId, r.productIds[0], { modifierGroupIds: [b.id, a.id], price: 12 } as any, n.actor),
    ).resolves.toMatchObject({
      id: r.productIds[0],
    })
    expect(await uniones()).toEqual(antes)
    await expect(updateProduct(n.venueId, r.productIds[0], { modifierGroupIds: [a.id] } as any, n.actor)).rejects.toMatchObject({
      statusCode: 409,
    })
  })
})

/**
 * Las apps publicadas mandan el formulario ENTERO en cada guardado (PUT /mobile/venues/:venueId/products/:productId), con lo
 * que leyeron de GET /mobile/venues/:venueId/products. Los cuerpos se arman igual que las apps, campo por campo.
 */
const ANDROID_KNOWN_TYPES = ['REGULAR', 'FOOD_AND_BEV', 'APPOINTMENTS_SERVICE', 'OTHER']
/** avoqado-android ArticlesViewModel.updateProduct (~L255-291) + ProductDetailView.onSave (~L131) + ArticlesModels.productType. */
function cuerpoAndroid(p: any, cambios: Record<string, unknown> = {}) {
  const description = (p.description ?? '').trim() ? p.description : null // description.ifBlank { null }
  return {
    name: p.name,
    ...(description !== null ? { description } : {}),
    type: ANDROID_KNOWN_TYPES.includes(p.type) ? p.type : 'REGULAR', // todo tipo que no conoce → REGULAR, y lo manda siempre
    ...(p.categoryId != null ? { categoryId: p.categoryId } : {}),
    ...(p.sku ? { sku: p.sku } : {}),
    ...(p.gtin ? { gtin: p.gtin } : {}),
    priceType: p.priceType === 'VARIABLE' ? 'VARIABLE' : 'FIXED',
    ...(p.price != null ? { price: Number(p.price) } : {}),
    ...(p.cost != null ? { cost: Number(p.cost) } : {}),
    taxRate: p.taxRate != null ? Number(p.taxRate) : 0.16, // Double; product?.taxRate ?: 0.16
    active: p.active ?? true,
    trackInventory: p.trackInventory ?? false,
    ...cambios,
  }
}
/** avoqado-ios ProductDetailView.populateFields + save (~L600-655): conoce FOOD/BEVERAGE/ALCOHOL/RETAIL, manda `isActive`. */
function cuerpoIos(p: any, cambios: Record<string, unknown> = {}) {
  const descripcion = (p.description ?? '').trim()
  return {
    name: String(p.name).trim(),
    isActive: p.isActive ?? true,
    priceType: p.priceType ?? 'FIXED',
    taxRate: p.taxRate != null ? Number(p.taxRate) : 0.16, // String o número → Double; effectiveTaxRate = taxRate ?? 0.16
    type: p.type ?? 'FOOD_AND_BEV',
    trackInventory: p.trackInventory ?? false,
    ...(descripcion ? { description: descripcion } : {}),
    ...(p.categoryId ? { categoryId: p.categoryId } : {}),
    ...(p.sku ? { sku: p.sku } : {}),
    ...(p.gtin ? { gtin: p.gtin } : {}),
    ...(p.price != null && p.priceType !== 'VARIABLE' ? { price: Number(p.price) } : {}),
    ...(p.cost != null ? { cost: Number(p.cost) } : {}),
    ...cambios,
  }
}

describe('🔴 las apps publicadas guardan el precio de una variante (formulario completo)', () => {
  let n: NegocioDePrueba
  let comida: string
  let regular: string
  beforeAll(async () => {
    n = await crearNegocio('apps-publicadas')
    comida = (
      await createProductWithVariants(
        n.venueId,
        {
          name: 'Pastel',
          type: 'FOOD',
          description: 'De chocolate',
          categoryId: n.categoryId,
          options: [{ name: 'Tamaño', values: ['Chico'] }],
          variants: [{ values: ['Chico'], price: 100 }],
        } as any,
        n.actor,
      )
    ).productIds[0]
    regular = (
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
  })
  afterAll(async () => {
    await n?.limpiar()
  })

  /** Lo que la app tiene en memoria: el GET de productos del POS, ya serializado como JSON. */
  async function comoLoLeeLaApp(productId: string) {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    await listMobile({ params: { venueId: n.venueId } } as any, res as any, jest.fn())
    const data = JSON.parse(JSON.stringify(res.json.mock.calls[0][0].data))
    return data.find((p: any) => p.id === productId)
  }
  async function guardar(productId: string, body: Record<string, unknown>) {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    const next = jest.fn()
    await updateMobile({ params: { venueId: n.venueId, productId }, body, authContext: { userId: n.staffId } } as any, res as any, next)
    return { res, next }
  }
  const precio = async (id: string) => Number((await prisma.product.findUniqueOrThrow({ where: { id } })).price)

  it.each([
    ['Android', 'comida (FOOD)', cuerpoAndroid, () => comida, 150],
    ['iOS', 'comida (FOOD)', cuerpoIos, () => comida, 160],
    ['Android', 'REGULAR', cuerpoAndroid, () => regular, 170],
    ['iOS', 'REGULAR', cuerpoIos, () => regular, 180],
  ])('%s cambia sólo el precio de una variante %s → 200 y el precio cambia', async (_app, _tipo, cuerpo, id, nuevo) => {
    const p = await comoLoLeeLaApp(id())
    const { res, next } = await guardar(id(), cuerpo(p, { price: nuevo }))
    expect(next).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }))
    expect(await precio(id())).toBe(nuevo)
    // El tipo heredado no se pisa con el REGULAR que manda Android.
    expect((await prisma.product.findUniqueOrThrow({ where: { id: id() } })).type).toBe(p.type)
  })

  it('Android cambia el nombre de la talla → 409 y nada cambia', async () => {
    const p = await comoLoLeeLaApp(comida)
    const antes = await precio(comida)
    const { next } = await guardar(comida, cuerpoAndroid(p, { name: 'Pastel · Grande', price: antes + 1 }))
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409 }))
    expect(await precio(comida)).toBe(antes)
  })

  it('un cambio REAL de tipo en la variante sigue dando 409 (FOOD → FOOD_AND_BEV)', async () => {
    const p = await comoLoLeeLaApp(comida)
    const { next } = await guardar(comida, cuerpoAndroid(p, { type: 'FOOD_AND_BEV' }))
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409 }))
    expect((await prisma.product.findUniqueOrThrow({ where: { id: comida } })).type).toBe('FOOD')
  })
})

/** Una familia deshecha conserva su categoría (ProductGroup.categoryId es RESTRICT) aunque sus productos se vayan a otra. */
async function familiaDeshechaEnCategoriaVacia(n: NegocioDePrueba) {
  const s = t()
  const cat = await prisma.menuCategory.create({ data: { venueId: n.venueId, name: `Vieja ${s}`, slug: `vieja-${s}` } as any })
  const r = await createProductWithVariants(
    n.venueId,
    { name: `Pantalón ${s}`, categoryId: cat.id, options: [{ name: 'Talla', values: ['S'] }], variants: [{ values: ['S'], price: 10 }] },
    n.actor,
  )
  await ungroupProductGroup(n.venueId, r.groupId, n.actor)
  // Destino propio: un reemplazo anterior del mismo negocio pudo borrar las categorías vacías del fixture.
  const destino = await prisma.menuCategory.create({ data: { venueId: n.venueId, name: `Destino ${s}`, slug: `destino-${s}` } as any })
  await prisma.product.updateMany({ where: { id: { in: r.productIds } }, data: { categoryId: destino.id } })
  return cat
}

describe('3a: borrar una categoría que todavía referencia una familia', () => {
  let n: NegocioDePrueba
  beforeAll(async () => {
    n = await crearNegocio('borrar-cat')
  })
  afterAll(async () => {
    await n?.limpiar()
  })

  it('se APAGA (como con archivados), nunca un 500 por la llave', async () => {
    const cat = await familiaDeshechaEnCategoriaVacia(n)
    await expect(deleteMenuCategory(n.venueId, cat.id)).resolves.toMatchObject({ id: cat.id, active: false })
    expect(await prisma.menuCategory.findUnique({ where: { id: cat.id } })).toMatchObject({ active: false })
  })
})

describe('importMenu con variantes', () => {
  let n: NegocioDePrueba
  beforeAll(async () => {
    n = await crearNegocio('importar')
  })
  afterAll(async () => {
    await n?.limpiar()
  })

  const categoria = async (id: string) => prisma.menuCategory.findUniqueOrThrow({ where: { id } })

  it('fusión: la variante conserva nombre, categoría y extras del padre; el precio sí cambia; se cuenta', async () => {
    const s = t()
    const mg = await prisma.modifierGroup.create({ data: { venueId: n.venueId, name: `Bordado ${s}` } as any })
    const r = await createProductWithVariants(
      n.venueId,
      {
        name: `Polo ${s}`,
        categoryId: n.categoryId,
        modifierGroupIds: [mg.id],
        options: [{ name: 'Talla', values: ['M'] }],
        variants: [{ values: ['M'], price: 100, sku: `POLO-M-${s}` }],
      },
      n.actor,
    )
    const otra = await categoria(n.otraCategoriaId)
    const res = await importMenu(
      n.venueId,
      {
        mode: 'merge',
        categories: [
          {
            name: otra.name,
            slug: otra.slug,
            products: [
              {
                name: 'Nombre del archivo',
                sku: `POLO-M-${s}`,
                price: 150,
                modifierGroups: [
                  { name: `Otro extra ${s}`, required: false, allowMultiple: false, minSelections: 0, maxSelections: 1, modifiers: [] },
                ],
              } as any,
            ],
          },
        ],
      },
      n.actor,
    )
    expect(res.stats).toMatchObject({ variantesConservadas: 1 })
    const p = await prisma.product.findUniqueOrThrow({ where: { id: r.productIds[0] }, include: { modifierGroups: true } })
    expect(p).toMatchObject({ name: `Polo ${s} · M`, categoryId: n.categoryId })
    expect(Number(p.price)).toBe(150)
    expect(p.modifierGroups.map(m => m.groupId)).toEqual([mg.id])
  })

  it('fusión: una variante archivada que vuelve en el archivo revive, y su padre archivado también', async () => {
    const s = t()
    const r = await createProductWithVariants(
      n.venueId,
      {
        name: `Short ${s}`,
        categoryId: n.categoryId,
        options: [{ name: 'Talla', values: ['M'] }],
        variants: [{ values: ['M'], price: 10, sku: `SHORT-M-${s}` }],
      },
      n.actor,
    )
    await archiveProductGroup(n.venueId, r.groupId, n.staffId)
    const cat = await categoria(n.categoryId)
    const res = await importMenu(
      n.venueId,
      { mode: 'merge', categories: [{ name: cat.name, slug: cat.slug, products: [{ name: 'x', sku: `SHORT-M-${s}`, price: 12 } as any] }] },
      n.actor,
    )
    expect(res.stats).toMatchObject({ productsRestored: 1 })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PRODUCT_GROUP_RESTORED', entity: 'ProductGroup', entityId: r.groupId, staffId: n.staffId }),
    )
    expect(await prisma.product.findUniqueOrThrow({ where: { id: r.productIds[0] } })).toMatchObject({ deletedAt: null, active: true })
    expect(await prisma.productGroup.findUniqueOrThrow({ where: { id: r.groupId } })).toMatchObject({ deletedAt: null, deletedBy: null })
  })

  it('fusión: un padre con 250 vivas no revive una variante archivada (conserva su tope) y se cuenta', async () => {
    const s = t()
    const letras = Array.from({ length: 25 }, (_, i) => `L${i}`)
    const colores = Array.from({ length: 10 }, (_, i) => `C${i}`)
    const r = await createProductWithVariants(
      n.venueId,
      {
        name: `Calcetín ${s}`,
        categoryId: n.categoryId,
        options: [
          { name: 'Talla', values: letras },
          { name: 'Color', values: [...colores, 'C10'] },
        ],
        variants: letras.flatMap(l => colores.map(c => ({ values: [l, c], price: 1 }))),
      },
      n.actor,
    )
    const archivada = r.productIds[0]
    await deleteProduct(n.venueId, archivada, n.staffId)
    await addVariants(n.venueId, r.groupId, { variants: [{ values: ['L0', 'C10'], price: 1 }] }, n.actor)
    const sku = (await prisma.product.findUniqueOrThrow({ where: { id: archivada } })).sku!
    const cat = await categoria(n.categoryId)
    const res = await importMenu(
      n.venueId,
      { mode: 'merge', categories: [{ name: cat.name, slug: cat.slug, products: [{ name: 'x', sku, price: 2 } as any] }] },
      n.actor,
    )
    expect(res.stats).toMatchObject({ productsRestored: 0, variantesSinCupo: 1 })
    expect((await prisma.product.findUniqueOrThrow({ where: { id: archivada } })).deletedAt).not.toBeNull()
    expect(await prisma.product.count({ where: { productGroupId: r.groupId, deletedAt: null } })).toBe(250)
  })
})

describe('importMenu en modo reemplazo con variantes', () => {
  let n: NegocioDePrueba
  beforeAll(async () => {
    n = await crearNegocio('reemplazo')
  })
  afterAll(async () => {
    await n?.limpiar()
  })

  it('🔴 un extra que sólo usa una familia sobrevive: su enlace al padre, las uniones de sus variantes y el extra, activos', async () => {
    const s = t()
    const mg = await prisma.modifierGroup.create({ data: { venueId: n.venueId, name: `Estampado ${s}` } as any })
    const mod = await prisma.modifier.create({ data: { groupId: mg.id, name: 'Logo', price: 20 } as any })
    const r = await createProductWithVariants(
      n.venueId,
      {
        name: `Chamarra ${s}`,
        categoryId: n.categoryId,
        modifierGroupIds: [mg.id],
        options: [{ name: 'Talla', values: ['M'] }],
        variants: [{ values: ['M'], price: 500, sku: `CHAM-M-${s}` }],
      },
      n.actor,
    )
    const cat = await prisma.menuCategory.findUniqueOrThrow({ where: { id: n.categoryId } })
    await importMenu(
      n.venueId,
      {
        mode: 'replace',
        categories: [
          {
            name: cat.name,
            slug: cat.slug,
            products: [{ name: 'x', sku: `CHAM-M-${s}`, price: 500 } as any, { name: 'Suelto', sku: `SUELTO-${s}`, price: 5 } as any],
          },
        ],
      },
      n.actor,
    )
    expect(await prisma.productGroupModifierGroup.count({ where: { groupId: r.groupId, modifierGroupId: mg.id } })).toBe(1)
    expect(await prisma.productModifierGroup.count({ where: { productId: r.productIds[0], groupId: mg.id } })).toBe(1)
    expect(await prisma.modifierGroup.findUniqueOrThrow({ where: { id: mg.id } })).toMatchObject({ active: true })
    expect(await prisma.modifier.findUniqueOrThrow({ where: { id: mod.id } })).toMatchObject({ active: true })
  })

  it('N1: la categoría de una familia viva sigue prendida y en el menú aunque el archivo no la traiga; la familia se ve', async () => {
    const s = t()
    const cat = await prisma.menuCategory.create({ data: { venueId: n.venueId, name: `Playeras ${s}`, slug: `playeras-${s}` } as any })
    const viva = await createProductWithVariants(
      n.venueId,
      {
        name: `Polo ${s}`,
        categoryId: cat.id,
        options: [{ name: 'Talla', values: ['M'] }],
        variants: [{ values: ['M'], price: 10, sku: `VIVA-M-${s}` }],
      },
      n.actor,
    )
    const fuera = await createProductWithVariants(
      n.venueId,
      {
        name: `Gorro ${s}`,
        categoryId: cat.id,
        options: [{ name: 'Talla', values: ['U'] }],
        variants: [{ values: ['U'], price: 10, sku: `FUERA-U-${s}` }],
      },
      n.actor,
    )
    ;(logAction as jest.Mock).mockClear()
    await importMenu(
      n.venueId,
      {
        mode: 'replace',
        categories: [{ name: `Otra ${s}`, slug: `otra-${s}`, products: [{ name: 'x', sku: `VIVA-M-${s}`, price: 11 } as any] }],
      },
      n.actor,
    )
    expect(await prisma.menuCategory.findUniqueOrThrow({ where: { id: cat.id } })).toMatchObject({ active: true })
    const menus = await getMenus(n.venueId)
    const enMenu = menus.flatMap(m => m.categories).find(a => a.category.id === cat.id)
    expect(enMenu?.category.products.map(p => p.id)).toEqual([viva.productIds[0]])
    // N2: la familia que el archivo no trae se archiva (3c) y deja su renglón; la viva no.
    expect(await prisma.productGroup.findUniqueOrThrow({ where: { id: fuera.groupId } })).toMatchObject({ deletedAt: expect.any(Date) })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PRODUCT_GROUP_ARCHIVED', entity: 'ProductGroup', entityId: fuera.groupId, staffId: n.staffId }),
    )
    expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'PRODUCT_GROUP_ARCHIVED', entityId: viva.groupId }))
  })

  it('#1 + #8: una familia archivada que el archivo revive (bajo OTRA categoría) conserva sus extras y su categoría se ve', async () => {
    const s = t()
    const catC = await prisma.menuCategory.create({ data: { venueId: n.venueId, name: `Sudaderas ${s}`, slug: `sudaderas-${s}` } as any })
    const mg = await prisma.modifierGroup.create({ data: { venueId: n.venueId, name: `Bordado ${s}` } as any })
    const mod = await prisma.modifier.create({ data: { groupId: mg.id, name: 'Nombre', price: 30 } as any })
    const r = await createProductWithVariants(
      n.venueId,
      {
        name: `Sudadera ${s}`,
        categoryId: catC.id,
        modifierGroupIds: [mg.id],
        options: [{ name: 'Talla', values: ['M', 'L'] }],
        variants: [
          { values: ['M'], price: 400, sku: `SUD-M-${s}` },
          { values: ['L'], price: 400, sku: `SUD-L-${s}` },
        ],
      },
      n.actor,
    )
    await archiveProductGroup(n.venueId, r.groupId, n.staffId)
    const res = await importMenu(
      n.venueId,
      {
        mode: 'replace',
        categories: [{ name: `Catálogo D ${s}`, slug: `catalogo-d-${s}`, products: [{ name: 'x', sku: `SUD-M-${s}`, price: 450 } as any] }],
      },
      n.actor,
    )
    expect(res.stats).toMatchObject({ productsRestored: 1 })
    expect(await prisma.productGroup.findUniqueOrThrow({ where: { id: r.groupId } })).toMatchObject({ deletedAt: null })
    // #1: el extra exclusivo de la familia no se borró; vuelve con ella, ligado al padre y a la variante, y prendido.
    expect(await prisma.productGroupModifierGroup.count({ where: { groupId: r.groupId, modifierGroupId: mg.id } })).toBe(1)
    expect(await prisma.productModifierGroup.count({ where: { productId: r.productIds[0], groupId: mg.id } })).toBe(1)
    expect(await prisma.modifierGroup.findUniqueOrThrow({ where: { id: mg.id } })).toMatchObject({ active: true })
    expect(await prisma.modifier.findUniqueOrThrow({ where: { id: mod.id } })).toMatchObject({ active: true })
    // #8: la variante conserva la categoría C (es del padre); C sigue prendida y en el menú, así que el POS la ve.
    expect(await prisma.product.findUniqueOrThrow({ where: { id: r.productIds[0] } })).toMatchObject({
      categoryId: catC.id,
      deletedAt: null,
    })
    expect(await prisma.menuCategory.findUniqueOrThrow({ where: { id: catC.id } })).toMatchObject({ active: true })
    const enMenu = (await getMenus(n.venueId)).flatMap(m => m.categories).find(a => a.category.id === catC.id)
    expect(enMenu?.category.products.map(p => p.id)).toEqual([r.productIds[0]])
  })

  it('🔴 #1 (ronda 2): reemplazo A sin la familia archivada deja sus extras como estaban; reemplazo B la revive con su extra activo y ligado', async () => {
    const s = t()
    const mg = await prisma.modifierGroup.create({ data: { venueId: n.venueId, name: `Forro ${s}` } as any })
    const mod = await prisma.modifier.create({ data: { groupId: mg.id, name: 'Térmico', price: 50 } as any })
    const r = await createProductWithVariants(
      n.venueId,
      {
        name: `Abrigo ${s}`,
        categoryId: n.categoryId,
        modifierGroupIds: [mg.id],
        options: [{ name: 'Talla', values: ['M'] }],
        variants: [{ values: ['M'], price: 900, sku: `ABR-M-${s}` }],
      },
      n.actor,
    )
    await archiveProductGroup(n.venueId, r.groupId, n.staffId)
    const extrasIntactos = async () => {
      expect(await prisma.modifierGroup.findUniqueOrThrow({ where: { id: mg.id } })).toMatchObject({ active: true })
      expect(await prisma.modifier.findUniqueOrThrow({ where: { id: mod.id } })).toMatchObject({ active: true })
      expect(await prisma.productGroupModifierGroup.count({ where: { groupId: r.groupId, modifierGroupId: mg.id } })).toBe(1)
      expect(await prisma.productModifierGroup.count({ where: { productId: r.productIds[0], groupId: mg.id } })).toBe(1)
    }
    // A: el archivo no trae a la familia (sigue archivada) → su extra ni se borra ni se apaga.
    await importMenu(
      n.venueId,
      {
        mode: 'replace',
        categories: [{ name: `A ${s}`, slug: `a-${s}`, products: [{ name: 'Suelto', sku: `SUE-A-${s}`, price: 5 } as any] }],
      },
      n.actor,
    )
    expect(await prisma.productGroup.findUniqueOrThrow({ where: { id: r.groupId } })).toMatchObject({ deletedAt: expect.any(Date) })
    await extrasIntactos()
    // B: el archivo trae su SKU → la familia revive con el extra activo y ligado.
    await importMenu(
      n.venueId,
      {
        mode: 'replace',
        categories: [{ name: `B ${s}`, slug: `b-${s}`, products: [{ name: 'x', sku: `ABR-M-${s}`, price: 900 } as any] }],
      },
      n.actor,
    )
    expect(await prisma.productGroup.findUniqueOrThrow({ where: { id: r.groupId } })).toMatchObject({ deletedAt: null })
    await extrasIntactos()
  })

  it('#1 (ronda 2): un extra de una familia apagado a mano sigue apagado tras reemplazar (y su grupo, igual)', async () => {
    const s = t()
    const mg = await prisma.modifierGroup.create({ data: { venueId: n.venueId, name: `Bordado ${s}` } as any })
    const prendido = await prisma.modifier.create({ data: { groupId: mg.id, name: 'Nombre', price: 30 } as any })
    const apagado = await prisma.modifier.create({ data: { groupId: mg.id, name: 'Logo', price: 40, active: false } as any })
    const mgApagado = await prisma.modifierGroup.create({ data: { venueId: n.venueId, name: `Empaque ${s}`, active: false } as any })
    const r = await createProductWithVariants(
      n.venueId,
      {
        name: `Gorro ${s}`,
        categoryId: n.categoryId,
        modifierGroupIds: [mg.id, mgApagado.id],
        options: [{ name: 'Talla', values: ['U'] }],
        variants: [{ values: ['U'], price: 100, sku: `GOR2-U-${s}` }],
      },
      n.actor,
    )
    await archiveProductGroup(n.venueId, r.groupId, n.staffId)
    for (const sku of [`SUE-C-${s}`, `GOR2-U-${s}`]) {
      await importMenu(
        n.venueId,
        { mode: 'replace', categories: [{ name: `C ${s}`, slug: `c-${s}`, products: [{ name: 'x', sku, price: 10 } as any] }] },
        n.actor,
      )
    }
    expect(await prisma.productGroup.findUniqueOrThrow({ where: { id: r.groupId } })).toMatchObject({ deletedAt: null })
    expect(await prisma.modifier.findUniqueOrThrow({ where: { id: prendido.id } })).toMatchObject({ active: true })
    expect(await prisma.modifier.findUniqueOrThrow({ where: { id: apagado.id } })).toMatchObject({ active: false })
    expect(await prisma.modifierGroup.findUniqueOrThrow({ where: { id: mgApagado.id } })).toMatchObject({ active: false })
  })

  it('#8: una categoría apagada a mano antes de la importación sigue apagada (familia que revive y familia viva)', async () => {
    const s = t()
    const apagadaRevive = await prisma.menuCategory.create({
      data: { venueId: n.venueId, name: `Gorras ${s}`, slug: `gorras-${s}` } as any,
    })
    const apagadaViva = await prisma.menuCategory.create({
      data: { venueId: n.venueId, name: `Bufandas ${s}`, slug: `bufandas-${s}` } as any,
    })
    const revive = await createProductWithVariants(
      n.venueId,
      {
        name: `Gorra ${s}`,
        categoryId: apagadaRevive.id,
        options: [{ name: 'Talla', values: ['U'] }],
        variants: [{ values: ['U'], price: 10, sku: `GOR-U-${s}` }],
      },
      n.actor,
    )
    await createProductWithVariants(
      n.venueId,
      {
        name: `Bufanda ${s}`,
        categoryId: apagadaViva.id,
        options: [{ name: 'Talla', values: ['U'] }],
        variants: [{ values: ['U'], price: 10, sku: `BUF-U-${s}` }],
      },
      n.actor,
    )
    await archiveProductGroup(n.venueId, revive.groupId, n.staffId)
    await prisma.menuCategory.updateMany({ where: { id: { in: [apagadaRevive.id, apagadaViva.id] } }, data: { active: false } })
    await importMenu(
      n.venueId,
      {
        mode: 'replace',
        categories: [
          {
            name: `Accesorios ${s}`,
            slug: `accesorios-${s}`,
            products: [{ name: 'x', sku: `GOR-U-${s}`, price: 12 } as any, { name: 'y', sku: `BUF-U-${s}`, price: 12 } as any],
          },
        ],
      },
      n.actor,
    )
    expect(await prisma.productGroup.findUniqueOrThrow({ where: { id: revive.groupId } })).toMatchObject({ deletedAt: null })
    for (const id of [apagadaRevive.id, apagadaViva.id]) {
      expect(await prisma.menuCategory.findUniqueOrThrow({ where: { id } })).toMatchObject({ active: false })
      expect(await prisma.menuCategoryAssignment.count({ where: { categoryId: id } })).toBe(0)
    }
  })

  it('3b: una categoría que sólo referencia una familia deshecha se apaga, no truena por la llave', async () => {
    const cat = await familiaDeshechaEnCategoriaVacia(n)
    const s = t()
    await importMenu(
      n.venueId,
      {
        mode: 'replace',
        categories: [{ name: `Nueva ${s}`, slug: `nueva-${s}`, products: [{ name: 'Suelto', sku: `OTRO-${s}`, price: 5 } as any] }],
      },
      n.actor,
    )
    expect(await prisma.menuCategory.findUnique({ where: { id: cat.id } })).toMatchObject({ active: false })
  })
})

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

/** Espera (sin dormir a ciegas) a que una sesión quede detenida por un candado de `pid`; devuelve el pid de esa sesión. */
async function bloqueadaPor(pid: number): Promise<number> {
  for (let i = 0; i < 500; i++) {
    const [fila] = await prisma.$queryRaw<Array<{ pid: number }>>`
      SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND ${pid}::int = ANY(pg_blocking_pids(pid)) LIMIT 1`
    if (fila) return fila.pid
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error(`Nadie quedó esperando a la sesión ${pid}`)
}

describe('Codex #3/#4: borrar una estación o un grupo de extras toma el negocio primero (sin deadlock con el motor)', () => {
  let n: NegocioDePrueba
  beforeAll(async () => {
    n = await crearNegocio('candados')
  })
  afterAll(async () => {
    await n?.limpiar()
  })

  it('#4: agregar una variante (padre ya bloqueado) mientras se borra su estación: el borrado espera, nadie truena', async () => {
    const s = t()
    const st = await prisma.printStation.create({ data: { venueId: n.venueId, name: `Barra ${s}` } })
    const r = await createProductWithVariants(
      n.venueId,
      {
        name: `Taza ${s}`,
        categoryId: n.categoryId,
        printStationId: st.id,
        options: [{ name: 'Tamaño', values: ['Chica'] }],
        variants: [{ values: ['Chica'], price: 50 }],
      },
      n.actor,
    )
    const opcion = await prisma.productGroupOption.findFirstOrThrow({ where: { groupId: r.groupId } })
    // La barrera detiene a addVariants DESPUÉS de lockGroup: el valor nuevo necesita la fila de su opción.
    const barrera = await retener(Prisma.sql`SELECT id FROM "ProductGroupOption" WHERE id = ${opcion.id} FOR UPDATE`)
    const alta = addVariants(
      n.venueId,
      r.groupId,
      { newValues: [{ optionName: 'Tamaño', values: ['Grande'] }], variants: [{ values: ['Grande'], price: 70 }] },
      n.actor,
    )
    const pidAlta = await bloqueadaPor(barrera.pid)
    const borrado = deleteStation(n.venueId, st.id)
    await bloqueadaPor(pidAlta) // el borrado ya espera al alta, que todavía no inserta su variante (con FK a la estación)
    barrera.soltar()
    const [a, b] = await Promise.allSettled([alta, borrado])
    await barrera.fin
    expect([a, b].map(x => (x.status === 'rejected' ? String((x.reason as Error)?.message ?? x.reason) : 'ok'))).toEqual(['ok', 'ok'])
    expect(await prisma.printStation.findUnique({ where: { id: st.id } })).toBeNull()
    expect(await prisma.product.count({ where: { productGroupId: r.groupId, deletedAt: null, printStationId: null } })).toBe(2)
  })

  it('#3: editar los extras de una familia mientras se borra uno de ellos: el borrado espera, nadie truena', async () => {
    const s = t()
    const salsa = await prisma.modifierGroup.create({ data: { venueId: n.venueId, name: `Salsa ${s}` } as any })
    const queso = await prisma.modifierGroup.create({ data: { venueId: n.venueId, name: `Queso ${s}` } as any })
    const r = await createProductWithVariants(
      n.venueId,
      {
        name: `Taco ${s}`,
        categoryId: n.categoryId,
        modifierGroupIds: [salsa.id],
        options: [{ name: 'Tamaño', values: ['Chico'] }],
        variants: [{ values: ['Chico'], price: 30 }],
      },
      n.actor,
    )
    // La barrera detiene la edición DESPUÉS de borrar sus enlaces y ANTES de recrearlos (el primero que recrea es «queso»).
    const barrera = await retener(Prisma.sql`SELECT id FROM "ModifierGroup" WHERE id = ${queso.id} FOR UPDATE`)
    const edicion = updateProductGroup(n.venueId, r.groupId, { modifierGroupIds: [queso.id, salsa.id] }, n.actor)
    const pidEdicion = await bloqueadaPor(barrera.pid)
    const borrado = deleteModifierGroup(n.venueId, salsa.id)
    await bloqueadaPor(pidEdicion)
    barrera.soltar()
    const [a, b] = await Promise.allSettled([edicion, borrado])
    await barrera.fin
    expect([a, b].map(x => (x.status === 'rejected' ? String((x.reason as Error)?.message ?? x.reason) : 'ok'))).toEqual(['ok', 'ok'])
    expect(await prisma.modifierGroup.findUnique({ where: { id: salsa.id } })).toBeNull()
    const enlaces = await prisma.productGroupModifierGroup.findMany({ where: { groupId: r.groupId }, take: 5 })
    expect(enlaces.map(e => e.modifierGroupId)).toEqual([queso.id])
  })
})
