/**
 * La selección del canal al ESCRIBIR (D1, 16-nov-2026): la lista y los precios se guardan por PRODUCTO (id), y la copia por
 * código se rehace con los códigos vigentes. Se prueba sobre la config ya mezclada, como la llama el PATCH.
 */
import type { Prisma } from '@prisma/client'

import { ValidationError } from '@/errors/AppError'
import { aplicarSeleccion } from '@/services/delivery-channels/core/productosDelCanal'
import { normalizarSeleccion, sumarRevisados } from '@/services/delivery-channels/core/seleccionDelCanal.service'
import type { MenuSnapshot } from '@/services/delivery-channels/core/menuSnapshot.service'
import { construirMenuRappi } from '@/services/delivery-channels/providers/rappi/rappi.menuMapper'

/** Los productos del negocio (archivados incluidos): la base de mentira filtra como el `findMany` real. */
const CATALOGO = [
  { id: 'p1', sku: 'LATTE' },
  { id: 'pA', sku: 'A' },
  { id: 'p2', sku: 'CAP' },
]

/** Los extras (modificadores) del negocio `v1`, por id: su código en el menú es `MOD-<id>`. */
const EXTRAS = ['m1']

function baseDe(catalogo = CATALOGO) {
  const findMany = jest.fn(
    async ({ where }: { where: { venueId: string; OR: Array<{ id?: { in: string[] }; sku?: { in: string[] } }> } }) =>
      catalogo.filter(p => where.venueId === 'v1' && where.OR.some(c => c.id?.in.includes(p.id) || c.sku?.in.includes(p.sku))),
  )
  const findModifiers = jest.fn(async ({ where }: { where: { id: { in: string[] }; group: { venueId: string } } }) =>
    EXTRAS.filter(id => where.group.venueId === 'v1' && where.id.in.includes(id)).map(id => ({ id })),
  )
  return {
    db: { product: { findMany }, modifier: { findMany: findModifiers } } as unknown as Prisma.TransactionClient,
    findMany,
    findModifiers,
  }
}

const conId = (productId: string, plu: string, extras: string[] = []) => ({
  plu,
  name: plu,
  description: null,
  price: 50,
  imageUrl: null,
  modifierGroups: extras.length
    ? [
        {
          id: 'g1',
          name: 'Extras',
          required: false,
          allowMultiple: true,
          minSelections: 0,
          maxSelections: null,
          modifiers: extras.map(e => ({ plu: e, name: e, price: 5 })),
        },
      ]
    : [],
  productId,
})
const menuCon = (...productos: Array<[string, string, string[]?]>): MenuSnapshot => ({
  venueId: 'v1',
  generatedAt: 'x',
  categories: [{ name: 'TODO', products: productos.map(([id, plu, extras]) => conId(id, plu, extras)) }],
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
    const { snapshot, precios } = aplicarSeleccion(menuCon(['pA', 'Z', ['MOD-m1']], ['p2', 'A']), r)
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

describe('normalizarSeleccion — un `MOD-…` es precio de extra sólo si el extra es de este negocio (Codex impl r1 #2)', () => {
  it('🔴 Codex impl r1 #2: el producto `MOD-raro` a $79 cambia a Z y otro toma `MOD-raro` ⇒ Rappi publica Z a 79 y el otro a 50', async () => {
    const { db } = baseDe([
      { id: 'p1', sku: 'MOD-raro' },
      { id: 'p2', sku: 'B' },
    ])
    // Se convierte el canal viejo (lista y precio por código).
    const r = await normalizarSeleccion(
      db,
      'v1',
      { productos: ['MOD-raro', 'B'], precios: { overrides: { 'MOD-raro': 79 } } },
      { productos: ['MOD-raro', 'B'] },
    )
    expect(r.productoIds).toEqual(['p1', 'p2'])
    expect(r.precios).toEqual({ porProducto: { p1: 79 }, overrides: { 'MOD-raro': 79 } })

    // p1 pasa a Z y p2 toma `MOD-raro` (desde la ficha o Shopify): la copia por código guardada todavía dice `MOD-raro: 79`.
    const { snapshot, precios } = aplicarSeleccion(menuCon(['p1', 'Z'], ['p2', 'MOD-raro']), r)
    expect(precios?.overrides).toEqual({ Z: 79 })
    const { payload } = construirMenuRappi(snapshot, 'store1', { precios })
    expect(payload.items.map(i => [i.sku, i.price])).toEqual([
      ['Z', 79],
      ['MOD-raro', 50],
    ])

    // Y el siguiente guardado (sólo el horario, con sus precios por producto) rehace la copia por código sin `MOD-raro`.
    const despues = await normalizarSeleccion(
      baseDe([
        { id: 'p1', sku: 'Z' },
        { id: 'p2', sku: 'MOD-raro' },
      ]).db,
      'v1',
      { ...r, deliveryHours: null, precios: { porProducto: { p1: 79 }, overrides: { 'MOD-raro': 79 } } },
      { deliveryHours: null, precios: { porProducto: { p1: 79 } } },
    )
    expect(despues.precios).toEqual({ porProducto: { p1: 79 }, overrides: { Z: 79 } })
  })

  it('un `MOD-…` GUARDADO cuyo extra no es del negocio se descarta al convertir; el de un extra del negocio se queda', async () => {
    const { db, findModifiers } = baseDe()
    const r = await normalizarSeleccion(
      db,
      'v1',
      { productos: ['A'], precios: { overrides: { A: 79, 'MOD-m1': 5, 'MOD-raro': 9 } } },
      { productos: ['A'] },
    )
    expect(r.precios).toEqual({ porProducto: { pA: 79 }, overrides: { A: 79, 'MOD-m1': 5 } })
    // UNA consulta de extras: del negocio, por id y con tope.
    expect(findModifiers).toHaveBeenCalledTimes(1)
    expect(findModifiers.mock.calls[0][0]).toEqual({
      where: { id: { in: ['m1', 'raro'] }, group: { venueId: 'v1' } },
      select: { id: true },
      take: 2,
    })
  })

  it('un `MOD-…` ENVIADO cuyo extra no es del negocio ⇒ ValidationError que lo nombra (con o sin `porProducto`)', async () => {
    const { db } = baseDe()
    const solo = normalizarSeleccion(
      db,
      'v1',
      { precios: { overrides: { 'MOD-ajeno': 3 } } },
      { precios: { overrides: { 'MOD-ajeno': 3 } } },
    )
    await expect(solo).rejects.toThrow(ValidationError)
    await expect(solo).rejects.toThrow(/MOD-ajeno/)

    const enviados = { porProducto: { p1: 60 }, overrides: { 'MOD-m1': 5, 'MOD-ajeno': 3 } }
    const conPorProducto = normalizarSeleccion(db, 'v1', { productoIds: ['p1'], precios: enviados }, { precios: enviados })
    await expect(conPorProducto).rejects.toThrow(/MOD-ajeno/)
  })

  it('sin llaves `MOD-` que no sean de producto, no consulta los extras', async () => {
    const { db, findModifiers } = baseDe()
    await normalizarSeleccion(db, 'v1', { productos: ['A'], precios: { overrides: { A: 79 } } }, { productos: ['A'] })
    expect(findModifiers).not.toHaveBeenCalled()
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
