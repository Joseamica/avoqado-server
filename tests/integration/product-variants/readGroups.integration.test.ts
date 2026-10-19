/** TEST_DATABASE_URL=… npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/product-variants/readGroups.integration.test.ts */
import prisma from '@/utils/prismaClient'
import {
  createProductWithVariants,
  detachVariant,
  getProductGroup,
  listArchivedVariants,
  listProductGroups,
  listProductOptionsPage,
} from '@/services/product-variants/productGroup.service'
import { updateProductOption } from '@/services/mobile/product-option.mobile.service'
import { crearNegocio, NegocioDePrueba } from './fixtures'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))

describe('lecturas de productos con variantes', () => {
  let n: NegocioDePrueba
  beforeAll(async () => {
    n = await crearNegocio('leer')
  })
  afterAll(async () => {
    if (n) await prisma.productOption.deleteMany({ where: { venueId: n.venueId } })
    await n?.limpiar()
  })

  it('detalle trae opciones en orden y cada variante con sus valores; la lista pagina con total y rango de precio', async () => {
    const r = await createProductWithVariants(
      n.venueId,
      {
        name: 'Pijama',
        categoryId: n.categoryId,
        satProductKey: '53101600',
        satUnitKey: 'H87',
        trackInventory: true,
        options: [{ name: 'Talla', values: ['S', 'M'] }],
        variants: [
          { values: ['S'], price: 300, initialStock: 5 },
          { values: ['M'], price: 350 },
        ],
      },
      n.actor,
    )
    // M deja de llevar inventario pero conserva su fila de Inventory: su existencia no se muestra.
    await prisma.product.update({ where: { id: r.productIds[1] }, data: { trackInventory: false, inventoryMethod: null } })
    expect(await prisma.inventory.count({ where: { productId: r.productIds[1] } })).toBe(1)
    const d = await getProductGroup(n.venueId, r.groupId)
    // Un formulario que reenvía los campos del padre los borraría si no los ve.
    expect(d).toMatchObject({ satProductKey: '53101600', satUnitKey: 'H87' })
    expect(d.variants.map(v => v.stock)).toEqual([5, null])
    expect(d.options[0]).toMatchObject({ name: 'Talla', values: [{ value: 'S' }, { value: 'M' }] })
    expect(d.variants.map(v => [v.name, v.values, v.price])).toEqual([
      ['Pijama · S', ['S'], 300],
      ['Pijama · M', ['M'], 350],
    ])
    const l = await listProductGroups(n.venueId, { search: 'pija', page: 1, pageSize: 10 })
    expect(l.total).toBe(1)
    expect(l.items[0]).toMatchObject({ name: 'Pijama', variantCount: 2, minPrice: 300, maxPrice: 350 })
  })

  it('el detalle de un padre de otro negocio da 404', async () => {
    const ajeno = await crearNegocio('leer-ajeno')
    try {
      const r = await createProductWithVariants(
        ajeno.venueId,
        { name: 'Ajeno', categoryId: ajeno.categoryId, options: [{ name: 'T', values: ['U'] }], variants: [{ values: ['U'], price: 1 }] },
        ajeno.actor,
      )
      await expect(getProductGroup(n.venueId, r.groupId)).rejects.toMatchObject({ statusCode: 404 })
    } finally {
      await ajeno.limpiar()
    }
  })

  it('las archivadas no se listan en el detalle: van a su propia lista paginada con total', async () => {
    const r = await createProductWithVariants(
      n.venueId,
      {
        name: 'Calceta',
        categoryId: n.categoryId,
        options: [{ name: 'Talla', values: ['S', 'M', 'L'] }],
        variants: [
          { values: ['S'], price: 50 },
          { values: ['M'], price: 50 },
          { values: ['L'], price: 50 },
        ],
      },
      n.actor,
    )
    await prisma.product.updateMany({ where: { id: { in: r.productIds.slice(0, 2) } }, data: { deletedAt: new Date(), active: false } })
    const d = await getProductGroup(n.venueId, r.groupId)
    expect(d.variants).toHaveLength(1)
    expect(d.archivedCount).toBe(2)
    expect(d).toMatchObject({ archived: false, archivedAt: null }) // la familia sigue viva (I-8)
    const p1 = await listArchivedVariants(n.venueId, r.groupId, { page: 1, pageSize: 1 })
    const p2 = await listArchivedVariants(n.venueId, r.groupId, { page: 2, pageSize: 1 })
    expect([p1.total, p1.items.length, p2.items.length]).toEqual([2, 1, 1])
    expect(new Set([p1.items[0].id, p2.items[0].id]).size).toBe(2)
    // Otro negocio no ve las archivadas de este padre.
    expect((await listArchivedVariants('otro-negocio', r.groupId, { page: 1, pageSize: 10 })).total).toBe(0)
    // Separar la última viva archiva el padre: deja de salir en la lista.
    await detachVariant(n.venueId, r.groupId, r.productIds[2], n.actor)
    expect((await listProductGroups(n.venueId, { search: 'calceta', page: 1, pageSize: 10 })).total).toBe(0)
    // 🔴 I-8: su detalle sigue respondiendo, pero dice que está archivada (no se confunde con una familia vacía).
    expect(await getProductGroup(n.venueId, r.groupId)).toMatchObject({ archived: true, archivedAt: expect.any(Date), variants: [] })
  })

  it('biblioteca del dashboard: pagina con total, tope de 100 y orden estable', async () => {
    for (const name of ['Color', 'Talla', 'Material'])
      await prisma.productOption.create({
        data: {
          venueId: n.venueId,
          name,
          values: {
            create: [
              { value: 'A', sortOrder: 1 },
              { value: 'B', sortOrder: 0 },
            ],
          },
        },
      })
    const p = await listProductOptionsPage(n.venueId, { page: 1, pageSize: 2 })
    expect(p).toMatchObject({ total: 3, page: 1, pageSize: 2 })
    expect(p.items.map(o => o.name)).toEqual(['Color', 'Material'])
    expect(p.items[0]).toMatchObject({ values: [{ value: 'B' }, { value: 'A' }], valuesTotal: 2, valuesTruncated: false })
    expect((await listProductOptionsPage(n.venueId, { page: 2, pageSize: 2 })).items.map(o => o.name)).toEqual(['Talla'])
    expect((await listProductOptionsPage(n.venueId, { page: 1, pageSize: 5000 })).pageSize).toBe(100)
  })

  it('🔴 biblioteca: dos ediciones simultáneas de la misma opción dejan UN solo juego de valores', async () => {
    const o = await prisma.productOption.create({
      data: { venueId: n.venueId, name: 'Largo', values: { create: [{ value: 'Corto', sortOrder: 0 }] } },
    })
    const editar = (values: string[]) =>
      updateProductOption({ venueId: n.venueId, staffId: n.staffId, optionId: o.id, values: values as any })
    await Promise.all([editar(['A', 'B']), editar(['C', 'D'])])
    const quedan = await prisma.productOptionValue.findMany({ where: { optionId: o.id }, select: { value: true }, take: 10 })
    expect([
      ['A', 'B'],
      ['C', 'D'],
    ]).toContainEqual(quedan.map(v => v.value).sort())
  })
})
