/**
 * La selección del canal al ESCRIBIR (D1, 16-nov-2026): la lista y los precios se guardan por PRODUCTO (id), y la copia por
 * código se rehace con los códigos vigentes. Se prueba sobre la config ya mezclada, como la llama el PATCH.
 */
import type { Prisma } from '@prisma/client'

import { ValidationError } from '@/errors/AppError'
import { aplicarSeleccion } from '@/services/delivery-channels/core/productosDelCanal'
import { normalizarSeleccion, sumarRevisados } from '@/services/delivery-channels/core/seleccionDelCanal.service'
import type { MenuSnapshot } from '@/services/delivery-channels/core/menuSnapshot.service'

/** Los productos del negocio (archivados incluidos): la base de mentira filtra como el `findMany` real. */
const CATALOGO = [
  { id: 'p1', sku: 'LATTE' },
  { id: 'pA', sku: 'A' },
  { id: 'p2', sku: 'CAP' },
]

function baseDe(catalogo = CATALOGO) {
  const findMany = jest.fn(
    async ({ where }: { where: { venueId: string; OR: Array<{ id?: { in: string[] }; sku?: { in: string[] } }> } }) =>
      catalogo.filter(p => where.venueId === 'v1' && where.OR.some(c => c.id?.in.includes(p.id) || c.sku?.in.includes(p.sku))),
  )
  return { db: { product: { findMany } } as unknown as Prisma.TransactionClient, findMany }
}

const conId = (productId: string, plu: string) => ({
  plu,
  name: plu,
  description: null,
  price: 50,
  imageUrl: null,
  modifierGroups: [],
  productId,
})
const menuCon = (...productos: Array<[string, string]>): MenuSnapshot => ({
  venueId: 'v1',
  generatedAt: 'x',
  categories: [{ name: 'TODO', products: productos.map(([id, plu]) => conId(id, plu)) }],
})

describe('normalizarSeleccion — la lista por código se guarda por producto', () => {
  it('{ productos: [LATTE] } ⇒ productoIds [p1] y la copia por código', async () => {
    const { db, findMany } = baseDe()
    const r = await normalizarSeleccion(db, 'v1', { productos: ['LATTE'] }, { productos: ['LATTE'] })
    expect(r.productoIds).toEqual(['p1'])
    expect(r.productos).toEqual(['LATTE'])
    // Una sola consulta, del negocio y con tope.
    expect(findMany).toHaveBeenCalledTimes(1)
    expect(findMany.mock.calls[0][0]).toEqual(expect.objectContaining({ where: expect.objectContaining({ venueId: 'v1' }), take: 1 }))
  })

  it('un código que no es de ningún producto ⇒ ValidationError que lo nombra', async () => {
    const { db } = baseDe()
    const p = normalizarSeleccion(db, 'v1', { productos: ['LATTE', 'NADIE'] }, { productos: ['LATTE', 'NADIE'] })
    await expect(p).rejects.toThrow(ValidationError)
    await expect(p).rejects.toThrow(/NADIE/)
  })

  it('productoIds con uno de otro negocio ⇒ ValidationError', async () => {
    const { db } = baseDe()
    await expect(
      normalizarSeleccion(db, 'v1', { productoIds: ['p1', 'pOtroNegocio'] }, { productoIds: ['p1', 'pOtroNegocio'] }),
    ).rejects.toThrow(ValidationError)
  })

  it('productoIds mal escrito (vacío) ⇒ ValidationError, sin consultar', async () => {
    const { db, findMany } = baseDe()
    await expect(normalizarSeleccion(db, 'v1', { productoIds: [] }, { productoIds: [] })).rejects.toThrow(ValidationError)
    expect(findMany).not.toHaveBeenCalled()
  })

  it('productoIds del negocio ⇒ se guardan y la copia por código sale con sus códigos vigentes', async () => {
    const { db } = baseDe()
    const r = await normalizarSeleccion(db, 'v1', { productoIds: ['p2', 'p1'] }, { productoIds: ['p2', 'p1'] })
    expect(r.productoIds).toEqual(['p2', 'p1'])
    expect(r.productos).toEqual(['CAP', 'LATTE'])
  })

  it('{ productos: null } ⇒ productoIds: null también (vuelve a todo el catálogo)', async () => {
    const { db } = baseDe()
    const r = await normalizarSeleccion(db, 'v1', { productoIds: ['p1'], productos: null }, { productos: null })
    expect(r.productoIds).toBeNull()
    expect(r.productos).toBeNull()
  })

  it('sólo { deliveryHours } ⇒ ni una consulta, y la config sale igual', async () => {
    const { db, findMany } = baseDe()
    const mezclado = { deliveryHours: { lunes: 1 }, productos: ['LATTE'], precios: { overrides: { LATTE: 60 } } }
    const r = await normalizarSeleccion(db, 'v1', mezclado, { deliveryHours: { lunes: 1 } })
    expect(findMany).not.toHaveBeenCalled()
    expect(r).toEqual(mezclado)
  })
})

describe('normalizarSeleccion — precios por producto', () => {
  it('🔴 Codex r3 #2: la lista vieja arrastra sus precios guardados, y un cambio de código ya no los pierde', async () => {
    const { db } = baseDe()
    // Lo guardado + un PATCH SÓLO con la lista (lo mezclado lleva los precios guardados).
    const mezclado = { productos: ['A'], precios: { overrides: { A: 79, 'MOD-m1': 5 } } }
    const r = await normalizarSeleccion(db, 'v1', mezclado, { productos: ['A'] })
    expect(r.productoIds).toEqual(['pA'])
    expect(r.precios).toEqual({ porProducto: { pA: 79 }, overrides: { A: 79, 'MOD-m1': 5 } })
    expect(r.productos).toEqual(['A'])

    // Después pA cambia a Z: se publica Z a 79 y el extra a 5.
    const { snapshot, precios } = aplicarSeleccion(menuCon(['pA', 'Z'], ['p2', 'A']), r)
    expect(snapshot.categories[0].products.map(p => p.plu)).toEqual(['Z'])
    expect(precios?.overrides).toEqual({ Z: 79, 'MOD-m1': 5 })
  })

  it('🔴 Codex r4 #1: un `overrides` ENVIADO reemplaza los precios del canal ya convertido', async () => {
    const { db } = baseDe()
    const guardado = { productoIds: ['pA'], productos: ['A'] }
    // Lo mezclado conserva el porProducto viejo (el PATCH no lo mandó): `overrides` enviado manda igual.
    const r = await normalizarSeleccion(
      db,
      'v1',
      { ...guardado, precios: { overrides: { A: 90 }, porProducto: { pA: 79 } } },
      { precios: { overrides: { A: 90 } } },
    )
    expect(r.precios).toEqual({ porProducto: { pA: 90 }, overrides: { A: 90 } })
    expect(aplicarSeleccion(menuCon(['pA', 'A']), r).precios?.overrides).toEqual({ A: 90 })

    // overrides: {} borra todos: se publica el de mostrador o el margen.
    const vacio = await normalizarSeleccion(
      db,
      'v1',
      { ...guardado, precios: { markupPercent: 20, overrides: {}, porProducto: { pA: 79 } } },
      { precios: { markupPercent: 20, overrides: {} } },
    )
    expect(vacio.precios).toEqual({ markupPercent: 20, porProducto: {}, overrides: {} })
    expect(aplicarSeleccion(menuCon(['pA', 'A']), vacio).precios).toEqual({ markupPercent: 20, overrides: {} })
  })

  it('🔴 Codex r3 #3: un precio de extra (MOD-…) se acepta como hoy y se queda en overrides', async () => {
    const { db } = baseDe()
    const r = await normalizarSeleccion(db, 'v1', { precios: { overrides: { 'MOD-m1': 7 } } }, { precios: { overrides: { 'MOD-m1': 7 } } })
    expect(r.precios).toEqual({ overrides: { 'MOD-m1': 7 } })
  })

  it('🔴 Codex r3 #3: un precio ENVIADO para un código que no es producto ni extra ⇒ ValidationError que lo nombra', async () => {
    const { db } = baseDe()
    const p = normalizarSeleccion(db, 'v1', { precios: { overrides: { NADIE: 1 } } }, { precios: { overrides: { NADIE: 1 } } })
    await expect(p).rejects.toThrow(ValidationError)
    await expect(p).rejects.toThrow(/NADIE/)
  })

  it('un precio por producto negativo, o de un producto ajeno ⇒ ValidationError', async () => {
    const { db } = baseDe()
    await expect(
      normalizarSeleccion(db, 'v1', { precios: { porProducto: { p1: -1 } } }, { precios: { porProducto: { p1: -1 } } }),
    ).rejects.toThrow(ValidationError)
    await expect(
      normalizarSeleccion(db, 'v1', { precios: { porProducto: { pOtro: 10 } } }, { precios: { porProducto: { pOtro: 10 } } }),
    ).rejects.toThrow(ValidationError)
  })

  it('`porProducto` enviado manda para productos; las MOD-… salen del overrides guardado si no viene otro', async () => {
    const { db } = baseDe()
    const r = await normalizarSeleccion(
      db,
      'v1',
      { productoIds: ['p1'], productos: ['LATTE'], precios: { porProducto: { p1: 65 }, overrides: { LATTE: 60, 'MOD-m1': 5 } } },
      { precios: { porProducto: { p1: 65 } } },
    )
    expect(r.precios).toEqual({ porProducto: { p1: 65 }, overrides: { LATTE: 65, 'MOD-m1': 5 } })
  })

  it('un precio GUARDADO de un código que ya no es de nadie se descarta al convertir (no truena)', async () => {
    const { db } = baseDe()
    const r = await normalizarSeleccion(db, 'v1', { productos: ['A'], precios: { overrides: { A: 79, VIEJO: 3 } } }, { productos: ['A'] })
    expect(r.precios).toEqual({ porProducto: { pA: 79 }, overrides: { A: 79 } })
  })

  it('una llave MOD-… que también es código de un producto cuenta como producto', async () => {
    const { db } = baseDe([...CATALOGO, { id: 'pM', sku: 'MOD-raro' }])
    const r = await normalizarSeleccion(
      db,
      'v1',
      { productos: ['MOD-raro'], precios: { overrides: { 'MOD-raro': 9 } } },
      { productos: ['MOD-raro'] },
    )
    expect(r.precios).toEqual({ porProducto: { pM: 9 }, overrides: { 'MOD-raro': 9 } })
  })
})

describe('sumarRevisados', () => {
  it('unión sin repetidos y sin los que están en la lista', () => {
    expect(sumarRevisados(['a', 'b'], ['b', 'c', 'd', 'c'], ['d'])).toEqual(['a', 'b', 'c'])
    expect(sumarRevisados(undefined, ['x'], null)).toEqual(['x'])
    expect(sumarRevisados('basura', ['x'], null)).toEqual(['x'])
  })

  it('los que entran a la lista salen de revisados', () => {
    expect(sumarRevisados(['a', 'b'], [], ['a'])).toEqual(['b'])
  })

  it('con más de 10,000 conserva los últimos 10,000', () => {
    const previos = Array.from({ length: 10_000 }, (_, i) => `v${i}`)
    const r = sumarRevisados(previos, ['n1', 'n2'], null)
    expect(r).toHaveLength(10_000)
    expect(r[0]).toBe('v2')
    expect(r.slice(-2)).toEqual(['n1', 'n2'])
  })
})
