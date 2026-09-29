/**
 * IVA por producto, plan 5 (D6): un producto archivado se queda en su categoría. Las lecturas del menú que hoy no filtran
 * nada (menús del dashboard y de /tpv, detalle de menú y de categoría, lista de categorías) lo mostrarían: piden sólo los
 * vigentes. Las lecturas de historia, reportes y por id NO se tocan. Y borrar una categoría cuyo único contenido son
 * archivados la APAGA: `Product.categoryId` es RESTRICT (Ruling P5-R7).
 */
import { prismaMock } from '@tests/__helpers__/setup'
import * as menuService from '@/services/dashboard/menu.dashboard.service'
import { deleteFileFromStorage } from '@/services/storage.service'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn().mockReturnValue(null) } }))
jest.mock('@/services/storage.service', () => ({ deleteFileFromStorage: jest.fn().mockResolvedValue(undefined) }))

const V = 'venue-1'
const VIGENTES = { deletedAt: null }
type ConMenu = { include: { categories: { include: { category: { include: { products: unknown } } } } } }
/** Los productos que pide una lectura de menú: `include.categories.include.category.include.products`. */
const productosDelMenu = (arg: unknown) => (arg as ConMenu).include.categories.include.category.include.products

describe('plan 5 · las lecturas del menú sólo traen productos vigentes', () => {
  it('getMenus (dashboard y /tpv/venues/:id/menus)', async () => {
    prismaMock.menu.findMany.mockResolvedValue([])
    await menuService.getMenus(V)
    expect(productosDelMenu(prismaMock.menu.findMany.mock.calls[0][0])).toEqual({ where: VIGENTES })
  })

  it('getMenuById conserva su orden y sus modificadores', async () => {
    prismaMock.menu.findUnique.mockResolvedValue({ id: 'm1' } as never)
    await menuService.getMenuById(V, 'm1')
    expect(productosDelMenu(prismaMock.menu.findUnique.mock.calls[0][0])).toMatchObject({
      where: VIGENTES,
      orderBy: { displayOrder: 'asc' },
    })
  })

  it('createMenu y updateMenu (las dos ramas) devuelven el menú con los vigentes', async () => {
    prismaMock.menu.create.mockResolvedValue({ id: 'm1', name: 'Comida' } as never)
    await menuService.createMenu(V, { name: 'Comida' } as never)
    expect(productosDelMenu(prismaMock.menu.create.mock.calls[0][0])).toEqual({ where: VIGENTES })

    prismaMock.menu.findUnique.mockResolvedValue({ id: 'm1' } as never)
    prismaMock.menu.update.mockResolvedValue({ id: 'm1', name: 'Comida' } as never)
    await menuService.updateMenu(V, 'm1', { name: 'Comida 2' } as never)
    expect(productosDelMenu(prismaMock.menu.update.mock.calls[0][0])).toEqual({ where: VIGENTES })

    prismaMock.$transaction.mockImplementation((async (cb: (tx: typeof prismaMock) => unknown) => cb(prismaMock)) as never)
    prismaMock.menu.findUniqueOrThrow.mockResolvedValue({ id: 'm1', name: 'Comida' } as never)
    await menuService.updateMenu(V, 'm1', { categoryIds: ['c1'] } as never)
    expect(productosDelMenu(prismaMock.menu.findUniqueOrThrow.mock.calls[0][0])).toEqual({ where: VIGENTES })
  })

  it('detalle y lista de categorías', async () => {
    prismaMock.menuCategory.findUnique.mockResolvedValue({ id: 'c1' } as never)
    await menuService.getMenuCategoryById(V, 'c1')
    expect(prismaMock.menuCategory.findUnique.mock.calls[0][0]).toMatchObject({ include: { products: { where: VIGENTES } } })

    prismaMock.menuCategory.findMany.mockResolvedValue([])
    await menuService.listMenuCategoriesForVenue(V)
    expect(prismaMock.menuCategory.findMany.mock.calls[0][0]).toMatchObject({
      include: { products: { where: VIGENTES, orderBy: { displayOrder: 'asc' } } },
    })
  })
})

describe('plan 5 · borrar una categoría: los archivados no cuentan, pero la llave RESTRICT no deja borrarla ⇒ se apaga', () => {
  const categoria = {
    id: 'c1',
    venueId: V,
    name: 'Postres',
    imageUrl: 'https://img/postres.png',
    children: [],
    displayOrder: 1,
    active: true,
    parentId: null,
  }
  beforeEach(() => {
    prismaMock.menuCategory.findUnique.mockResolvedValue(categoria as never)
  })

  it('sólo archivados: se APAGA (no se borra, conserva su imagen) y responde con la categoría', async () => {
    prismaMock.product.count.mockResolvedValueOnce(0).mockResolvedValueOnce(3)
    prismaMock.menuCategory.update.mockResolvedValue({ ...categoria, active: false } as never)

    await expect(menuService.deleteMenuCategory(V, 'c1')).resolves.toMatchObject({ id: 'c1', active: false })

    expect(prismaMock.product.count).toHaveBeenNthCalledWith(1, { where: { categoryId: 'c1', deletedAt: null } })
    expect(prismaMock.menuCategory.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { active: false } })
    expect(prismaMock.menuCategory.delete).not.toHaveBeenCalled()
    expect(deleteFileFromStorage).not.toHaveBeenCalled()
  })

  it('REGRESIÓN: sin ningún producto se borra de verdad, con su imagen', async () => {
    prismaMock.product.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0)
    prismaMock.menuCategory.delete.mockResolvedValue(categoria as never)

    await menuService.deleteMenuCategory(V, 'c1')

    expect(prismaMock.menuCategory.delete).toHaveBeenCalledWith({ where: { id: 'c1' } })
    expect(deleteFileFromStorage).toHaveBeenCalledWith('https://img/postres.png')
  })

  it('REGRESIÓN: con productos vigentes sigue siendo 400', async () => {
    prismaMock.product.count.mockResolvedValueOnce(2)

    await expect(menuService.deleteMenuCategory(V, 'c1')).rejects.toMatchObject({ statusCode: 400 })
    expect(prismaMock.menuCategory.delete).not.toHaveBeenCalled()
    expect(prismaMock.menuCategory.update).not.toHaveBeenCalled()
  })
})
