/**
 * Categoría eliminada (encargo de la nube bc1dcc, 19-nov-2026; Flautas Coyoacán, «EVENTO»): «Eliminar» una categoría que sólo
 * guarda productos ARCHIVADOS no puede borrar la fila (`Product.categoryId` es RESTRICT) y antes sólo la apagaba: el dueño la
 * seguía viendo en Menú → Categorías, apagada y con 0. Ahora, además de apagarla, se ESCONDE (`deletedAt`).
 *
 * Contra Postgres REAL (base desechable): los dos triggers (prendida ⇒ se ve; algo vivo dentro ⇒ se ve, apagada), la carrera con
 * un «Eliminar» en curso, la importación (F5-1), la migración de los datos viejos y el caso `hz:nube0000:na33c25b` (una
 * subcategoría eliminada ya no bloquea a su padre). Negocio NUEVO por caso.
 */
import {
  createMenuCategory,
  deleteMenuCategory,
  createMenu,
  getMenuCategoryById,
  getMenus,
  importMenu,
  listMenuCategoriesForVenue,
  updateMenu,
  updateMenuCategory,
} from '@/services/dashboard/menu.dashboard.service'
import { categoriaParaProductoSinCategoria } from '@/services/mobile/categoriaGeneral.service'
import { deleteProduct } from '@/services/dashboard/product.dashboard.service'
import { assertLegacyProductReferencesForVenue } from '@/services/master-catalog/catalogGovernance.service'
import { padreEsDelNegocio } from '@/services/menus/padreDeCategoria'
import prisma from '@/utils/prismaClient'
import { limpiarNegocios, nuevoNegocio, type Negocio } from '../fiscal/exclusionContable.fixtures'

jest.setTimeout(120_000)

const SERVICIO = { type: 'SERVICE' as const, servicePrincipalId: 'CATEGORIA_ELIMINADA_PRUEBA' }
const negocio = () => nuevoNegocio({ contabilidad: false })

afterAll(async () => {
  await limpiarNegocios()
  await prisma.$disconnect()
})

/** «EVENTO» con un producto, como la dejó el dueño de Flautas: luego archiva el producto. Devuelve los ids. */
async function eventoConArchivado(x: Negocio, nombre = 'EVENTO') {
  const sku = `${nombre}-${x.rfc}`
  await importMenu(
    x.venueId,
    {
      mode: 'merge',
      categories: [{ name: nombre, slug: nombre.toLowerCase(), products: [{ name: `Paquete ${nombre}`, sku, price: 500 }] }],
    },
    SERVICIO,
  )
  const p = await prisma.product.findFirstOrThrow({ where: { venueId: x.venueId, sku }, select: { id: true, categoryId: true } })
  await deleteProduct(x.venueId, p.id, 'staff-categoria-eliminada')
  return { productId: p.id, categoryId: p.categoryId, sku }
}

const categoria = (id: string) =>
  prisma.menuCategory.findUniqueOrThrow({ where: { id }, select: { active: true, deletedAt: true, slug: true, parentId: true } })
const nombresEnLaLista = async (venueId: string) =>
  (await listMenuCategoriesForVenue(venueId)).flatMap(c => [
    c.name,
    ...((c as { children?: { name: string }[] }).children ?? []).map(h => h.name),
  ])

describe('eliminar una categoría que sólo guarda archivados', () => {
  it('queda apagada, fuera de los menús y ESCONDIDA: ya no sale en la lista, el detalle ni los menús', async () => {
    const x = await negocio()
    const { categoryId, productId } = await eventoConArchivado(x)
    expect(await nombresEnLaLista(x.venueId)).toContain('EVENTO')

    const respuesta = await deleteMenuCategory(x.venueId, categoryId)

    expect(respuesta).toMatchObject({ id: categoryId, active: false })
    const fila = await categoria(categoryId)
    expect(fila.active).toBe(false)
    expect(fila.deletedAt).toBeInstanceOf(Date)
    expect(fila.slug).toBe('evento') // el slug no cambia
    expect(await prisma.menuCategoryAssignment.count({ where: { categoryId } })).toBe(0)
    // RESTRICT intacto: el archivado sigue en su categoría (su historia no cambia).
    expect(await prisma.product.findUniqueOrThrow({ where: { id: productId }, select: { categoryId: true } })).toEqual({ categoryId })
    expect(await nombresEnLaLista(x.venueId)).not.toContain('EVENTO')
    await expect(getMenuCategoryById(x.venueId, categoryId)).rejects.toMatchObject({ statusCode: 404 })
    await expect(updateMenuCategory(x.venueId, categoryId, { active: true } as never)).rejects.toMatchObject({ statusCode: 404 })
    expect((await categoria(categoryId)).deletedAt).toBeInstanceOf(Date)
    // Eliminarla otra vez: ya no existe para el dueño.
    await expect(deleteMenuCategory(x.venueId, categoryId)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('crear otra «EVENTO» después REUSA la eliminada, limpia (como prenderla hoy): nunca hay dos, y una tercera se rechaza', async () => {
    const x = await negocio()
    const { categoryId, productId } = await eventoConArchivado(x)
    await prisma.menuCategory.update({ where: { id: categoryId }, data: { defaultSatProductKey: '90101501', color: '#ff0000' } })
    await deleteMenuCategory(x.venueId, categoryId)

    // Como lo manda el formulario del panel: los campos que el dueño no tocó llegan vacíos (Codex r7).
    const nueva = await createMenuCategory(x.venueId, {
      name: 'Evento',
      color: '#00ff00',
      defaultSatProductKey: null,
      defaultSatUnitKey: null,
      availableFrom: null,
      availableUntil: null,
      availableDays: [],
      printStationId: null,
    } as never)

    // Como prenderla hoy: misma fila, mismo nombre (sólo cambiaban mayúsculas), su clave SAT se queda y el color que mandó, sí.
    expect(nueva).toMatchObject({ id: categoryId, name: 'EVENTO', active: true, deletedAt: null, color: '#00ff00' })
    expect(nueva.defaultSatProductKey).toBe('90101501')
    expect(await nombresEnLaLista(x.venueId)).toEqual(['EVENTO'])
    expect(await prisma.menuCategory.count({ where: { venueId: x.venueId } })).toBe(1)
    // Su producto borrado sigue borrado: la categoría sale vacía.
    expect(await prisma.product.findUniqueOrThrow({ where: { id: productId }, select: { deletedAt: true } })).toEqual({
      deletedAt: expect.any(Date),
    })
    // Otra visible con ese nombre sigue rechazándose, como antes (también con un espacio de más).
    await expect(createMenuCategory(x.venueId, { name: 'EVENTO' } as never)).rejects.toMatchObject({ statusCode: 400 })
    await expect(createMenuCategory(x.venueId, { name: 'evento ' } as never)).rejects.toMatchObject({ statusCode: 400 })
    expect(await prisma.menuCategory.count({ where: { venueId: x.venueId } })).toBe(1)
  })

  it('REGRESIÓN: otro nombre con el mismo slug que una eliminada («21» y «2+1») se rechaza como hoy y no la toca', async () => {
    const x = await negocio()
    // «2+1» con el slug que le daría el panel («21»), con un producto borrado.
    await importMenu(
      x.venueId,
      { mode: 'merge', categories: [{ name: '2+1', slug: '21', products: [{ name: 'Promo', sku: `PROMO-${x.rfc}`, price: 50 }] }] },
      SERVICIO,
    )
    const p = await prisma.product.findFirstOrThrow({ where: { venueId: x.venueId, sku: `PROMO-${x.rfc}` } })
    await deleteProduct(x.venueId, p.id, 'staff-categoria-eliminada')
    const categoryId = p.categoryId
    await deleteMenuCategory(x.venueId, categoryId)

    await expect(createMenuCategory(x.venueId, { name: '21' } as never)).rejects.toMatchObject({ statusCode: 400 })
    expect(await prisma.menuCategory.findUniqueOrThrow({ where: { id: categoryId }, select: { name: true, deletedAt: true } })).toEqual({
      name: '2+1',
      deletedAt: expect.any(Date),
    })
  })

  it('un formulario de menú abierto antes del «Eliminar» no la vuelve a meter al menú (Codex r3 B3)', async () => {
    const x = await negocio()
    const { categoryId } = await eventoConArchivado(x)
    const otra = await createMenuCategory(x.venueId, { name: 'Bebidas' } as never)
    await deleteMenuCategory(x.venueId, categoryId)

    const menu = await createMenu(x.venueId, { name: 'Noche', categoryIds: [categoryId, otra.id], appliesToDevices: true } as never)
    expect(await prisma.menuCategoryAssignment.findMany({ where: { menuId: menu.id }, select: { categoryId: true } })).toEqual([
      { categoryId: otra.id },
    ])
    await updateMenu(x.venueId, menu.id, { categoryIds: [otra.id, categoryId] } as never)
    expect(await prisma.menuCategoryAssignment.count({ where: { menuId: menu.id, categoryId } })).toBe(0)
  })

  it('una asignación vieja a un menú no la enseña en el menú', async () => {
    const x = await negocio()
    const { categoryId } = await eventoConArchivado(x)
    await deleteMenuCategory(x.venueId, categoryId)
    const menu = await prisma.menu.findFirstOrThrow({ where: { venueId: x.venueId }, select: { id: true } })
    // Como si un formulario viejo la hubiera vuelto a asignar en la carrera con el «Eliminar».
    await prisma.menuCategoryAssignment.create({ data: { menuId: menu.id, categoryId } })

    const menus = await getMenus(x.venueId)
    expect(menus.flatMap(m => m.categories.map(c => c.categoryId))).not.toContain(categoryId)
  })

  it('REGRESIÓN: una categoría apagada a propósito por el dueño se sigue viendo apagada', async () => {
    const x = await negocio()
    const c = await createMenuCategory(x.venueId, { name: 'Temporada' } as never)
    await updateMenuCategory(x.venueId, c.id, { active: false } as never)

    const lista = await listMenuCategoriesForVenue(x.venueId)
    expect(lista.map(l => ({ name: l.name, active: l.active }))).toEqual([{ name: 'Temporada', active: false }])
  })

  it('REGRESIÓN: vacía se borra de verdad (sin fila)', async () => {
    const x = await negocio()
    const c = await createMenuCategory(x.venueId, { name: 'Vacía' } as never)
    await deleteMenuCategory(x.venueId, c.id)
    expect(await prisma.menuCategory.findUnique({ where: { id: c.id } })).toBeNull()
  })

  it('REGRESIÓN: con un producto vivo se rechaza con el porqué, y no cambia nada', async () => {
    const x = await negocio()
    await importMenu(
      x.venueId,
      { mode: 'merge', categories: [{ name: 'Tacos', slug: 'tacos', products: [{ name: 'Pastor', sku: `P-${x.rfc}`, price: 20 }] }] },
      SERVICIO,
    )
    const c = await prisma.menuCategory.findFirstOrThrow({ where: { venueId: x.venueId, name: 'Tacos' } })
    const asignaciones = await prisma.menuCategoryAssignment.count({ where: { categoryId: c.id } })

    await expect(deleteMenuCategory(x.venueId, c.id)).rejects.toMatchObject({ code: 'CATEGORY_HAS_PRODUCTS' })
    expect(await categoria(c.id)).toMatchObject({ active: true, deletedAt: null })
    expect(await prisma.menuCategoryAssignment.count({ where: { categoryId: c.id } })).toBe(asignaciones)
  })

  it('no recibe productos nuevos por el panel ni sirve de padre', async () => {
    const x = await negocio()
    const { categoryId } = await eventoConArchivado(x)
    await deleteMenuCategory(x.venueId, categoryId)

    await expect(
      prisma.$transaction(tx => assertLegacyProductReferencesForVenue(tx, { venueId: x.venueId, categoryId })),
    ).rejects.toMatchObject({ statusCode: 404 })
    expect(await padreEsDelNegocio(x.venueId, categoryId)).toBe(false)
  })

  it('la «General» eliminada vuelve a verse cuando la app da de alta un producto sin categoría (Codex r3 B7)', async () => {
    const x = await negocio()
    const { categoryId } = await eventoConArchivado(x, 'General')
    await deleteMenuCategory(x.venueId, categoryId)

    const general = await prisma.$transaction(tx => categoriaParaProductoSinCategoria(tx, x.venueId))

    expect(general).toEqual({ id: categoryId, creada: false })
    expect((await categoria(categoryId)).deletedAt).toBeNull()
    // Y el alta pasa el validador (antes de esto rebotaba con 404).
    await expect(
      prisma.$transaction(tx => assertLegacyProductReferencesForVenue(tx, { venueId: x.venueId, categoryId })),
    ).resolves.not.toThrow()
  })
})

describe('la base: nunca algo vivo ni prendido donde el dueño no lo ve', () => {
  it('prenderla por cualquier camino (SQL) la vuelve a mostrar', async () => {
    const x = await negocio()
    const { categoryId } = await eventoConArchivado(x)
    await deleteMenuCategory(x.venueId, categoryId)

    await prisma.$executeRaw`UPDATE "MenuCategory" SET active = true WHERE id = ${categoryId}`

    expect(await categoria(categoryId)).toMatchObject({ active: true, deletedAt: null })
  })

  it('restaurar el archivado (como Shopify) la vuelve a mostrar APAGADA, como antes del cambio', async () => {
    const x = await negocio()
    const { categoryId, productId } = await eventoConArchivado(x)
    await deleteMenuCategory(x.venueId, categoryId)

    await prisma.product.update({ where: { id: productId }, data: { deletedAt: null, deletedBy: null, active: true } })

    expect(await categoria(categoryId)).toMatchObject({ active: false, deletedAt: null })
    expect(await nombresEnLaLista(x.venueId)).toContain('EVENTO')
  })

  it('un producto vivo que entra por otro camino también la vuelve a mostrar', async () => {
    const x = await negocio()
    const { categoryId } = await eventoConArchivado(x)
    await deleteMenuCategory(x.venueId, categoryId)

    await prisma.product.create({ data: { venueId: x.venueId, categoryId, sku: `TARDE-${x.rfc}`, name: 'Llegó tarde', price: 10 } })

    expect((await categoria(categoryId)).deletedAt).toBeNull()
  })

  it('CARRERA: una restauración que llega mientras el «Eliminar» tiene la categoría la vuelve a mostrar al terminar', async () => {
    const x = await negocio()
    const { categoryId, productId } = await eventoConArchivado(x)

    // El «Eliminar» por SQL, lento: bloquea, espera y marca. La restauración entra DESPUÉS del candado (otra conexión) y tiene
    // que esperarlo: si no esperara, vería la categoría sin marcar y la dejaría escondida con el producto vivo dentro.
    let avisar: () => void = () => undefined
    const yaBloqueo = new Promise<void>(r => (avisar = r))
    const eliminar = prisma.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT id FROM "MenuCategory" WHERE id = ${categoryId} FOR UPDATE`
        avisar()
        await tx.$queryRaw`SELECT pg_sleep(1.5)::text`
        await tx.$executeRaw`UPDATE "MenuCategory" SET active = false, "deletedAt" = now() WHERE id = ${categoryId}`
      },
      { timeout: 20_000 },
    )
    await yaBloqueo
    // El cronómetro mide SÓLO la restauración: sin el candado del trigger tardaría milisegundos (Codex r4 R6).
    const inicio = Date.now()
    await prisma.product.update({ where: { id: productId }, data: { deletedAt: null, deletedBy: null } })
    const espero = Date.now() - inicio
    await eliminar

    expect(espero).toBeGreaterThanOrEqual(1000) // de verdad esperó al «Eliminar» en curso
    expect((await categoria(categoryId)).deletedAt).toBeNull()
  })

  it('REGRESIÓN: archivar otro producto no toca la categoría', async () => {
    const x = await negocio()
    const { categoryId } = await eventoConArchivado(x)
    const antes = await categoria(categoryId)
    await prisma.product.updateMany({ where: { categoryId }, data: { deletedAt: new Date() } })
    expect(await categoria(categoryId)).toEqual(antes)
  })
})

describe('la importación (F5-1) con una categoría eliminada', () => {
  it('el archivo que trae «EVENTO» y su SKU la vuelve a mostrar PRENDIDA con su producto (sin crear otra) y en el menú', async () => {
    const x = await negocio()
    const { categoryId, productId, sku } = await eventoConArchivado(x)
    await deleteMenuCategory(x.venueId, categoryId)

    await importMenu(
      x.venueId,
      { mode: 'merge', categories: [{ name: 'EVENTO', slug: 'evento', products: [{ name: 'Paquete EVENTO', sku, price: 500 }] }] },
      SERVICIO,
    )

    expect(await categoria(categoryId)).toMatchObject({ active: true, deletedAt: null, slug: 'evento' })
    expect(await prisma.menuCategory.count({ where: { venueId: x.venueId } })).toBe(1)
    expect(await prisma.product.findUniqueOrThrow({ where: { id: productId }, select: { deletedAt: true, categoryId: true } })).toEqual({
      deletedAt: null,
      categoryId,
    })
    expect(await prisma.menuCategoryAssignment.count({ where: { categoryId } })).toBe(1)
  })

  it('tras volver a crear «EVENTO» (la misma fila), el archivo con el SKU borrado lo regresa a ESA categoría', async () => {
    const x = await negocio()
    const { categoryId, productId, sku } = await eventoConArchivado(x)
    await deleteMenuCategory(x.venueId, categoryId)
    await createMenuCategory(x.venueId, { name: 'EVENTO' } as never)

    await importMenu(
      x.venueId,
      { mode: 'merge', categories: [{ name: 'EVENTO', slug: 'evento', products: [{ name: 'Paquete EVENTO', sku, price: 500 }] }] },
      SERVICIO,
    )

    expect(await prisma.product.findUniqueOrThrow({ where: { id: productId }, select: { deletedAt: true, categoryId: true } })).toEqual({
      deletedAt: null,
      categoryId,
    })
    expect(await prisma.menuCategory.count({ where: { venueId: x.venueId } })).toBe(1)
    expect(await nombresEnLaLista(x.venueId)).toEqual(['EVENTO'])
  })
})

describe('subcategorías (hz:nube0000:na33c25b)', () => {
  it('una subcategoría eliminada (con archivados) ya no bloquea a su padre: el padre también se esconde', async () => {
    const x = await negocio()
    const padre = await createMenuCategory(x.venueId, { name: 'Bebidas' } as never)
    const { categoryId: hija } = await eventoConArchivado(x, 'Calientes')
    await prisma.menuCategory.update({ where: { id: hija }, data: { parentId: padre.id } })
    await deleteMenuCategory(x.venueId, hija)

    await deleteMenuCategory(x.venueId, padre.id)

    // Se esconde en vez de borrarse: borrarla escribiría en la hija (SET NULL) y se podría cruzar con una importación (Codex r3 R2).
    expect((await categoria(padre.id)).deletedAt).toBeInstanceOf(Date)
    expect(await nombresEnLaLista(x.venueId)).toEqual([])
  })

  it('una hija que vuelve a mostrarse con su padre eliminado sale arriba en la lista', async () => {
    const x = await negocio()
    const { categoryId: padre } = await eventoConArchivado(x, 'Bebidas')
    const { categoryId: hija, productId } = await eventoConArchivado(x, 'Calientes')
    await prisma.menuCategory.update({ where: { id: hija }, data: { parentId: padre } })
    await deleteMenuCategory(x.venueId, hija)
    await deleteMenuCategory(x.venueId, padre)

    await prisma.product.update({ where: { id: productId }, data: { deletedAt: null, deletedBy: null } })

    expect(await nombresEnLaLista(x.venueId)).toEqual(['Calientes'])
  })

  it('REGRESIÓN: una subcategoría visible (aunque apagada) sigue bloqueando', async () => {
    const x = await negocio()
    const padre = await createMenuCategory(x.venueId, { name: 'Postres' } as never)
    const hija = await createMenuCategory(x.venueId, { name: 'Pays', parentId: padre.id } as never)
    await updateMenuCategory(x.venueId, hija.id, { active: false } as never)

    await expect(deleteMenuCategory(x.venueId, padre.id)).rejects.toMatchObject({ code: 'CATEGORY_HAS_SUBCATEGORIES' })
    expect(await prisma.menuCategory.findUnique({ where: { id: padre.id } })).not.toBeNull()
  })
})
