/**
 * IVA por producto, plan 5 (D6): un producto archivado se queda en su categoría. Las lecturas del menú que hoy no filtran
 * nada (menús del dashboard y de /tpv, detalle de menú y de categoría, lista de categorías) lo mostrarían: piden sólo los
 * vigentes. Las lecturas de historia, reportes y por id NO se tocan. Y borrar una categoría cuyo único contenido son
 * archivados la APAGA: `Product.categoryId` es RESTRICT (Ruling P5-R7).
 */
import { isDeepStrictEqual } from 'util'

import { prismaMock } from '@tests/__helpers__/setup'

// El borrado de la foto busca la carpeta del negocio por su nombre.
beforeEach(() => prismaMock.venue.findUnique.mockResolvedValue({ slug: 'mi-negocio' } as never))
import * as menuService from '@/services/dashboard/menu.dashboard.service'
import { deleteFileFromStorage } from '@/services/storage.service'
import { productGroupInclude } from '@/services/product-variants/variantPayload'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn().mockReturnValue(null) } }))
jest.mock('@/services/storage.service', () => ({
  deleteFileFromStorage: jest.fn().mockResolvedValue(undefined),
  // La foto es de la carpeta de este negocio (la regla de la carpeta la prueba storage.carpetaDelNegocio.test.ts).
  estaEnLaCarpetaDelNegocio: jest.fn().mockReturnValue(true),
}))

const V = 'venue-1'
const VIGENTES = { deletedAt: null }
type ConMenu = { include: { categories: { include: { category: { include: { products: unknown } } } } } }
/** Los productos que pide una lectura de menú: `include.categories.include.category.include.products`. */
const productosDelMenu = (arg: unknown) => (arg as ConMenu).include.categories.include.category.include.products

describe('plan 5 · las lecturas del menú sólo traen productos vigentes', () => {
  it('getMenus (dashboard y /tpv/venues/:id/menus)', async () => {
    prismaMock.menu.findMany.mockResolvedValue([])
    await menuService.getMenus(V)
    // Variantes (2026-10-14): también los 4 campos del contrato (`productGroupInclude`); sigue pidiendo sólo los vigentes.
    expect(productosDelMenu(prismaMock.menu.findMany.mock.calls[0][0])).toEqual({ where: VIGENTES, include: productGroupInclude })
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
  const CUENTA_VIGENTES = { where: { categoryId: 'c1', deletedAt: null } }
  const CUENTA_TODOS = { where: { categoryId: 'c1' } }
  /**
   * `product.count` responde por su `where`, no por el orden de las llamadas: `jest.clearAllMocks()` no vacía las colas de
   * `mockResolvedValueOnce`, y una cola sobrante arrastraba a las pruebas siguientes. Un `where` distinto de los dos truena.
   */
  const CUENTA_PAUSADOS = { where: { categoryId: 'c1', deletedAt: null, active: false } }
  const contar = (vigentes: number, todos: number, pausados = 0) =>
    prismaMock.product.count.mockImplementation(async (arg: unknown) => {
      if (isDeepStrictEqual(arg, CUENTA_VIGENTES)) return vigentes
      if (isDeepStrictEqual(arg, CUENTA_TODOS)) return todos
      if (isDeepStrictEqual(arg, CUENTA_PAUSADOS)) return pausados
      throw new Error(`product.count con un where inesperado: ${JSON.stringify(arg)}`)
    })

  beforeEach(() => {
    prismaMock.$transaction.mockReset()
    prismaMock.product.count.mockReset()
    prismaMock.menuCategory.findUnique.mockResolvedValue(categoria as never)
    prismaMock.product.findMany.mockResolvedValue([] as never)
  })

  it('sólo archivados: se APAGA (no se borra, conserva su imagen) y responde con la categoría', async () => {
    contar(0, 3)
    prismaMock.menuCategory.update.mockResolvedValue({ ...categoria, active: false } as never)

    await expect(menuService.deleteMenuCategory(V, 'c1')).resolves.toMatchObject({ id: 'c1', active: false })

    expect(prismaMock.product.count).toHaveBeenCalledWith(CUENTA_VIGENTES)
    expect(prismaMock.product.count).toHaveBeenCalledWith(CUENTA_TODOS)
    expect(prismaMock.menuCategory.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { active: false } })
    // F5-1: apagada y FUERA de los menús (getMenus no filtra `active`); las restauraciones la vuelven a asignar con upsert.
    expect(prismaMock.menuCategoryAssignment.deleteMany).toHaveBeenCalledWith({ where: { categoryId: 'c1' } })
    expect(prismaMock.menuCategory.delete).not.toHaveBeenCalled()
    expect(deleteFileFromStorage).not.toHaveBeenCalled()
  })

  it('REGRESIÓN: sin ningún producto se borra de verdad, con su imagen', async () => {
    contar(0, 0)
    prismaMock.menuCategory.delete.mockResolvedValue(categoria as never)

    await menuService.deleteMenuCategory(V, 'c1')

    expect(prismaMock.menuCategory.delete).toHaveBeenCalledWith({ where: { id: 'c1' } })
    expect(deleteFileFromStorage).toHaveBeenCalledWith('https://img/postres.png')
  })

  it('REGRESIÓN: con productos vigentes sigue siendo 400', async () => {
    contar(2, 2)

    await expect(menuService.deleteMenuCategory(V, 'c1')).rejects.toMatchObject({ statusCode: 400 })
    expect(prismaMock.menuCategory.delete).not.toHaveBeenCalled()
    expect(prismaMock.menuCategory.update).not.toHaveBeenCalled()
    expect(prismaMock.menuCategoryAssignment.deleteMany).not.toHaveBeenCalled()
  })

  // Encargo 08cc59 (15-nov): el rechazo salía en inglés y el panel lo cerraba sin decir nada. Ahora dice POR QUÉ, en español,
  // con cuántos productos quedan, cuántos están pausados (los pausados también cuentan) y cuáles, más un código para el panel.
  describe('el rechazo dice por qué, en español', () => {
    it('con productos: cuántos, cuántos pausados y cuáles (5 como ejemplo, sin tope de la base abierto)', async () => {
      contar(7, 7, 2)
      prismaMock.product.findMany.mockResolvedValue(['Brownie', 'Flan', 'Gelatina', 'Pay', 'Pastel'].map(name => ({ name })) as never)

      const error = await menuService.deleteMenuCategory(V, 'c1').catch(e => e)

      expect(error).toMatchObject({
        statusCode: 400,
        code: 'CATEGORY_HAS_PRODUCTS',
        details: { productos: 7, pausados: 2, ejemplos: ['Brownie', 'Flan', 'Gelatina', 'Pay', 'Pastel'] },
      })
      expect(error.message).toBe(
        'No se puede eliminar «Postres»: todavía tiene 7 productos (2 pausados): Brownie, Flan, Gelatina, Pay, Pastel y 2 más. ' +
          'Los pausados también cuentan. Muévelos a otra categoría o elimínalos y vuelve a intentarlo.',
      )
      expect(prismaMock.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { categoryId: 'c1', deletedAt: null }, select: { name: true }, take: 5 }),
      )
    })

    it('un solo producto, pausado: lo nombra y dice que está pausado', async () => {
      contar(1, 1, 1)
      prismaMock.product.findMany.mockResolvedValue([{ name: 'Flan' }] as never)

      const error = await menuService.deleteMenuCategory(V, 'c1').catch(e => e)

      expect(error.message).toBe(
        'No se puede eliminar «Postres»: todavía tiene 1 producto (pausado): Flan. ' +
          'Los pausados también cuentan. Muévelo a otra categoría o elimínalo y vuelve a intentarlo.',
      )
      expect(error.details).toEqual({ productos: 1, pausados: 1, ejemplos: ['Flan'] })
    })

    it('cualquier subcategoría bloquea (activa o apagada) y el rechazo las nombra; no se apaga ni se borra nada', async () => {
      contar(0, 0)
      prismaMock.menuCategory.findUnique.mockResolvedValue({
        ...categoria,
        children: [
          { id: 'h1', name: 'Pays', active: true, venueId: V },
          { id: 'h2', name: 'Vieja', active: false, venueId: V },
        ],
      } as never)

      const error = await menuService.deleteMenuCategory(V, 'c1').catch(e => e)

      expect(error).toMatchObject({ statusCode: 400, code: 'CATEGORY_HAS_SUBCATEGORIES', details: { subcategorias: ['Pays', 'Vieja'] } })
      expect(error.message).toBe(
        'No se puede eliminar «Postres»: tiene 2 subcategorías: Pays, Vieja. Elimínalas primero y vuelve a intentarlo.',
      )
      expect(prismaMock.menuCategory.delete).not.toHaveBeenCalled()
      expect(prismaMock.menuCategory.update).not.toHaveBeenCalled()
      expect(prismaMock.menuCategoryAssignment.deleteMany).not.toHaveBeenCalled()
      // Codex r1-r2: sin lecturas ni transacciones nuevas (nada de carreras con quien reactiva, restaura o reordena).
      expect(prismaMock.$transaction).not.toHaveBeenCalled()
    })

    it('una hija de OTRO negocio bloquea, pero su nombre no se enseña', async () => {
      contar(0, 0)
      prismaMock.menuCategory.findUnique.mockResolvedValue({
        ...categoria,
        children: [{ id: 'x1', name: 'Secreta de otro', active: false, venueId: 'otro-venue' }],
      } as never)

      const error = await menuService.deleteMenuCategory(V, 'c1').catch(e => e)

      expect(error).toMatchObject({ code: 'CATEGORY_HAS_SUBCATEGORIES', details: { subcategorias: ['una subcategoría de otro negocio'] } })
      expect(error.message).not.toContain('Secreta de otro')
    })
  })
})
