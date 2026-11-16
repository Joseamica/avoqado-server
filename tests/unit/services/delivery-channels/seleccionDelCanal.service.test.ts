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
    const r = await normalizarSeleccion(db, 'v1', { productos: ['LATTE'] }, { productos: ['LATTE'] }, {})
    expect(r.productoIds).toEqual(['p1'])
    expect(r.productos).toEqual(['LATTE'])
    // Una sola consulta, del negocio y con tope.
    expect(findMany).toHaveBeenCalledTimes(1)
    expect(findMany.mock.calls[0][0]).toEqual(expect.objectContaining({ where: expect.objectContaining({ venueId: 'v1' }), take: 1 }))
  })

  it('un código que no es de ningún producto ⇒ ValidationError que lo nombra', async () => {
    const { db } = baseDe()
    const p = normalizarSeleccion(db, 'v1', { productos: ['LATTE', 'NADIE'] }, { productos: ['LATTE', 'NADIE'] }, {})
    await expect(p).rejects.toThrow(ValidationError)
    await expect(p).rejects.toThrow(/NADIE/)
  })

  it('productoIds con uno de otro negocio ⇒ ValidationError', async () => {
    const { db } = baseDe()
    await expect(
      normalizarSeleccion(db, 'v1', { productoIds: ['p1', 'pOtroNegocio'] }, { productoIds: ['p1', 'pOtroNegocio'] }, {}),
    ).rejects.toThrow(ValidationError)
  })

  it('productoIds mal escrito (vacío) ⇒ ValidationError, sin consultar', async () => {
    const { db, findMany } = baseDe()
    await expect(normalizarSeleccion(db, 'v1', { productoIds: [] }, { productoIds: [] }, {})).rejects.toThrow(ValidationError)
    expect(findMany).not.toHaveBeenCalled()
  })

  it('productoIds del negocio ⇒ se guardan y la copia por código sale con sus códigos vigentes', async () => {
    const { db } = baseDe()
    const r = await normalizarSeleccion(db, 'v1', { productoIds: ['p2', 'p1'] }, { productoIds: ['p2', 'p1'] }, {})
    expect(r.productoIds).toEqual(['p2', 'p1'])
    expect(r.productos).toEqual(['CAP', 'LATTE'])
  })

  it('{ productos: null } ⇒ productoIds: null también (vuelve a todo el catálogo)', async () => {
    const { db } = baseDe()
    const r = await normalizarSeleccion(db, 'v1', { productoIds: ['p1'], productos: null }, { productos: null }, { productoIds: ['p1'] })
    expect(r.productoIds).toBeNull()
    expect(r.productos).toBeNull()
  })

  it('sólo { deliveryHours } ⇒ ni una consulta, y la config sale igual', async () => {
    const { db, findMany } = baseDe()
    const mezclado = { deliveryHours: { lunes: 1 }, productos: ['LATTE'], precios: { overrides: { LATTE: 60 } } }
    const r = await normalizarSeleccion(db, 'v1', mezclado, { deliveryHours: { lunes: 1 } }, mezclado)
    expect(findMany).not.toHaveBeenCalled()
    expect(r).toEqual(mezclado)
  })
})

describe('normalizarSeleccion — precios por producto', () => {
  it('🔴 Codex r3 #2: la lista vieja arrastra sus precios guardados, y un cambio de código ya no los pierde', async () => {
    const { db } = baseDe()
    // Lo guardado + un PATCH SÓLO con la lista (lo mezclado lleva los precios guardados).
    const mezclado = { productos: ['A'], precios: { overrides: { A: 79, 'MOD-m1': 5 } } }
    const r = await normalizarSeleccion(db, 'v1', mezclado, { productos: ['A'] }, mezclado)
    expect(r.productoIds).toEqual(['pA'])
    expect(r.precios).toEqual({ porProducto: { pA: 79 }, porExtra: { m1: 5 }, overrides: { A: 79, 'MOD-m1': 5 } })
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
      { ...guardado, precios: { overrides: { A: 79 }, porProducto: { pA: 79 } } },
    )
    expect(r.precios).toEqual({ porProducto: { pA: 90 }, overrides: { A: 90 } })
    expect(aplicarSeleccion(menuCon(['pA', 'A']), r).precios?.overrides).toEqual({ A: 90 })

    // overrides: {} borra todos: se publica el de mostrador o el margen.
    const vacio = await normalizarSeleccion(
      db,
      'v1',
      { ...guardado, precios: { markupPercent: 20, overrides: {}, porProducto: { pA: 79 } } },
      { precios: { markupPercent: 20, overrides: {} } },
      { ...guardado, precios: { overrides: { A: 79 }, porProducto: { pA: 79 } } },
    )
    expect(vacio.precios).toEqual({ markupPercent: 20, porProducto: {}, overrides: {} })
    expect(aplicarSeleccion(menuCon(['pA', 'A']), vacio).precios).toEqual({ markupPercent: 20, overrides: {} })
  })

  it('🔴 Codex r3 #3: un precio de extra (MOD-…) se acepta como hoy y se guarda por id del extra (porExtra)', async () => {
    const { db } = baseDe()
    const r = await normalizarSeleccion(
      db,
      'v1',
      { precios: { overrides: { 'MOD-m1': 7 } } },
      { precios: { overrides: { 'MOD-m1': 7 } } },
      {},
    )
    expect(r.precios).toEqual({ porProducto: {}, porExtra: { m1: 7 }, overrides: { 'MOD-m1': 7 } })
  })

  it('🔴 Codex r3 #3: un precio ENVIADO para un código que no es producto ni extra ⇒ ValidationError que lo nombra', async () => {
    const { db } = baseDe()
    const p = normalizarSeleccion(db, 'v1', { precios: { overrides: { NADIE: 1 } } }, { precios: { overrides: { NADIE: 1 } } }, {})
    await expect(p).rejects.toThrow(ValidationError)
    await expect(p).rejects.toThrow(/NADIE/)
  })

  it('un precio por producto negativo, o de un producto ajeno ⇒ ValidationError', async () => {
    const { db } = baseDe()
    await expect(
      normalizarSeleccion(db, 'v1', { precios: { porProducto: { p1: -1 } } }, { precios: { porProducto: { p1: -1 } } }, {}),
    ).rejects.toThrow(ValidationError)
    await expect(
      normalizarSeleccion(db, 'v1', { precios: { porProducto: { pOtro: 10 } } }, { precios: { porProducto: { pOtro: 10 } } }, {}),
    ).rejects.toThrow(ValidationError)
  })

  it('`porProducto` enviado manda para productos; el `MOD-…` de un extra real de la copia guardada pasa a porExtra', async () => {
    const { db } = baseDe()
    const r = await normalizarSeleccion(
      db,
      'v1',
      { productoIds: ['p1'], productos: ['LATTE'], precios: { porProducto: { p1: 65 }, overrides: { LATTE: 60, 'MOD-m1': 5 } } },
      { precios: { porProducto: { p1: 65 } } },
      { productoIds: ['p1'], productos: ['LATTE'], precios: { porProducto: { p1: 60 }, overrides: { LATTE: 60, 'MOD-m1': 5 } } },
    )
    expect(r.precios).toEqual({ porProducto: { p1: 65 }, porExtra: { m1: 5 }, overrides: { LATTE: 65, 'MOD-m1': 5 } })
  })

  it('un precio GUARDADO de un código que ya no es de nadie se descarta al convertir (no truena)', async () => {
    const { db } = baseDe()
    const r = await normalizarSeleccion(
      db,
      'v1',
      { productos: ['A'], precios: { overrides: { A: 79, VIEJO: 3 } } },
      { productos: ['A'] },
      {
        productos: ['A'],
        precios: { overrides: { A: 79, VIEJO: 3 } },
      },
    )
    expect(r.precios).toEqual({ porProducto: { pA: 79 }, overrides: { A: 79 } })
  })

  it('una llave MOD-… que también es código de un producto cuenta como producto', async () => {
    const { db } = baseDe([...CATALOGO, { id: 'pM', sku: 'MOD-raro' }])
    const r = await normalizarSeleccion(
      db,
      'v1',
      { productos: ['MOD-raro'], precios: { overrides: { 'MOD-raro': 9 } } },
      { productos: ['MOD-raro'] },
      { productos: ['MOD-raro'], precios: { overrides: { 'MOD-raro': 9 } } },
    )
    // `porExtra: {}`: la copia lleva un `MOD-…` de producto; así otro guardado no lo vuelve a leer como extra.
    expect(r.precios).toEqual({ porProducto: { pM: 9 }, porExtra: {}, overrides: { 'MOD-raro': 9 } })
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
      { productos: ['MOD-raro', 'B'], precios: { overrides: { 'MOD-raro': 79 } } },
    )
    expect(r.productoIds).toEqual(['p1', 'p2'])
    expect(r.precios).toEqual({ porProducto: { p1: 79 }, porExtra: {}, overrides: { 'MOD-raro': 79 } })

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
      { ...r, precios: { porProducto: { p1: 79 }, overrides: { 'MOD-raro': 79 } } },
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
      { productos: ['A'], precios: { overrides: { A: 79, 'MOD-m1': 5, 'MOD-raro': 9 } } },
    )
    expect(r.precios).toEqual({ porProducto: { pA: 79 }, porExtra: { m1: 5 }, overrides: { A: 79, 'MOD-m1': 5 } })
    // UNA consulta de extras: del negocio, por id y con tope.
    expect(findModifiers).toHaveBeenCalledTimes(1)
    expect(findModifiers.mock.calls[0][0]).toEqual({
      where: { id: { in: ['m1', 'raro'] }, group: { venueId: 'v1' } },
      select: { id: true },
      take: 2,
    })
  })

  it('un `MOD-…` ENVIADO sin porProducto/porExtra cuyo extra no es del negocio ⇒ ValidationError que lo nombra', async () => {
    const { db } = baseDe()
    const solo = normalizarSeleccion(
      db,
      'v1',
      { precios: { overrides: { 'MOD-ajeno': 3 } } },
      { precios: { overrides: { 'MOD-ajeno': 3 } } },
      {},
    )
    await expect(solo).rejects.toThrow(ValidationError)
    await expect(solo).rejects.toThrow(/MOD-ajeno/)
  })

  it('🔴 Codex impl r3 #3: con `porProducto` enviado, la `overrides` enviada se ignora por completo: no truena ni llena porExtra', async () => {
    const { db } = baseDe()
    const enviados = { porProducto: { p1: 60 }, overrides: { 'MOD-m1': 99, 'MOD-ajeno': 3, NADIE: 1 } }
    // Sin copia guardada: el extra se queda sin precio fijo.
    const r = await normalizarSeleccion(
      db,
      'v1',
      { productoIds: ['p1'], precios: enviados },
      { precios: enviados },
      { productoIds: ['p1'] },
    )
    expect(r.precios).toEqual({ porProducto: { p1: 60 }, overrides: { LATTE: 60 } })

    // Canal viejo con el extra a $7 en su copia GUARDADA: ése es el que pasa a porExtra, no el $99 enviado.
    const guardado = { productoIds: ['p1'], productos: ['LATTE'], precios: { overrides: { LATTE: 50, 'MOD-m1': 7 } } }
    const viejo = await normalizarSeleccion(db, 'v1', { ...guardado, precios: enviados }, { precios: enviados }, guardado)
    expect(viejo.precios).toEqual({ porProducto: { p1: 60 }, porExtra: { m1: 7 }, overrides: { LATTE: 60, 'MOD-m1': 7 } })
  })

  it('sin llaves `MOD-` que no sean de producto, no consulta los extras', async () => {
    const { db, findModifiers } = baseDe()
    await normalizarSeleccion(
      db,
      'v1',
      { productos: ['A'], precios: { overrides: { A: 79 } } },
      { productos: ['A'] },
      {
        productos: ['A'],
        precios: { overrides: { A: 79 } },
      },
    )
    expect(findModifiers).not.toHaveBeenCalled()
  })
})

describe('normalizarSeleccion — precios de extras por id (`porExtra`, Codex impl r2)', () => {
  it('🔴 Codex impl r2 #2: el producto `MOD-m1` a $79 se convierte, pasa a Z y m1 cuelga de otro ⇒ Z a 79 y el extra a su base', async () => {
    const r = await normalizarSeleccion(
      baseDe([
        { id: 'pM', sku: 'MOD-m1' },
        { id: 'p2', sku: 'CAP' },
      ]).db,
      'v1',
      { productos: ['MOD-m1', 'CAP'], precios: { overrides: { 'MOD-m1': 79 } } },
      { productos: ['MOD-m1', 'CAP'] },
      { productos: ['MOD-m1', 'CAP'], precios: { overrides: { 'MOD-m1': 79 } } },
    )
    // `MOD-m1` es el código de un producto: su precio es del producto, no del extra m1.
    expect(r.precios).toEqual({ porProducto: { pM: 79 }, porExtra: {}, overrides: { 'MOD-m1': 79 } })

    // pM pasa a Z y el extra m1 (base $5) se asocia a CAP.
    const menu = menuCon(['pM', 'Z'], ['p2', 'CAP', ['MOD-m1']])
    const publicar = (config: Record<string, unknown>) => {
      const { snapshot, precios } = aplicarSeleccion(menu, config)
      return construirMenuRappi(snapshot, 'store1', { precios }).payload.items.map(i => [
        i.sku,
        i.price,
        (i.children ?? []).map(h => [h.sku, h.price]),
      ])
    }
    const esperado = [
      ['Z', 79, []],
      ['CAP', 50, [['MOD-m1', 5]]],
    ]
    expect(publicar(r)).toEqual(esperado)

    // Los guardados siguientes no leen la copia vieja `MOD-m1: 79` como precio del extra.
    const ahora = baseDe([
      { id: 'pM', sku: 'Z' },
      { id: 'p2', sku: 'CAP' },
    ]).db
    const horario = await normalizarSeleccion(ahora, 'v1', { ...r, deliveryHours: null }, { deliveryHours: null }, r)
    expect(publicar(horario)).toEqual(esperado)
    const panel = await normalizarSeleccion(
      ahora,
      'v1',
      { ...r, precios: { ...(r.precios as object), porProducto: { pM: 79 } } },
      { precios: { porProducto: { pM: 79 } } },
      r,
    )
    expect(panel.precios).toEqual({ porProducto: { pM: 79 }, porExtra: {}, overrides: { Z: 79 } })
    expect(publicar(panel)).toEqual(esperado)
  })

  it('🔴 un producto que TOMA después el código `MOD-m1` deja `porExtra: {}` guardado: al renombrarse, su precio no pasa al extra', async () => {
    // Canal ya convertido (pM era `A`); pM pasa a llamarse `MOD-m1` y el DASHBOARD guarda su precio.
    const guardado = { productoIds: ['pM'], productos: ['A'], precios: { porProducto: { pM: 79 }, overrides: { A: 79 } } }
    const r = await normalizarSeleccion(
      baseDe([{ id: 'pM', sku: 'MOD-m1' }]).db,
      'v1',
      guardado,
      { precios: { porProducto: { pM: 79 } } },
      guardado,
    )
    expect(r.precios).toEqual({ porProducto: { pM: 79 }, porExtra: {}, overrides: { 'MOD-m1': 79 } })

    // pM pasa a Z; el siguiente guardado no lee la copia `MOD-m1: 79` como precio del extra m1.
    const despues = await normalizarSeleccion(
      baseDe([{ id: 'pM', sku: 'Z' }]).db,
      'v1',
      { ...r, deliveryHours: null },
      { deliveryHours: null },
      r,
    )
    expect((despues.precios as { porExtra?: unknown }).porExtra).toEqual({})
  })

  it('🔴 API vieja: `overrides` sin porProducto/porExtra reemplaza todos los precios, separados en producto y extra', async () => {
    const { db } = baseDe()
    const enviado = { precios: { overrides: { LATTE: 60, 'MOD-m1': 7 } } }
    const r = await normalizarSeleccion(db, 'v1', enviado, enviado, {})
    expect(r.precios).toEqual({ porProducto: { p1: 60 }, porExtra: { m1: 7 }, overrides: { LATTE: 60, 'MOD-m1': 7 } })

    await expect(
      normalizarSeleccion(db, 'v1', { precios: { overrides: { NADIE: 1 } } }, { precios: { overrides: { NADIE: 1 } } }, {}),
    ).rejects.toThrow(/NADIE/)

    // `{}` borra los dos (lo mezclado conserva los mapas guardados: el `overrides` enviado manda igual).
    const guardado = {
      productoIds: ['p1'],
      productos: ['LATTE'],
      precios: { porProducto: { p1: 60 }, porExtra: { m1: 7 }, overrides: {} },
    }
    const vacio = await normalizarSeleccion(db, 'v1', guardado, { precios: { overrides: {} } }, guardado)
    expect(vacio.precios).toEqual({ porProducto: {}, overrides: {} })
    expect(aplicarSeleccion(menuCon(['p1', 'LATTE', ['MOD-m1']]), vacio).precios).toEqual({ overrides: {} })
  })

  it('🔴 un canal convertido por el D1 anterior (porProducto + `MOD-m1: 7` en la copia, sin porExtra) lo pasa a porExtra en cualquier guardado', async () => {
    const guardado = {
      productoIds: ['p1'],
      productos: ['LATTE'],
      precios: { porProducto: { p1: 60 }, overrides: { LATTE: 60, 'MOD-m1': 7 } },
    }
    const esperado = { porProducto: { p1: 60 }, porExtra: { m1: 7 }, overrides: { LATTE: 60, 'MOD-m1': 7 } }

    const horario = await normalizarSeleccion(baseDe().db, 'v1', { ...guardado, deliveryHours: null }, { deliveryHours: null }, guardado)
    expect(horario.precios).toEqual(esperado)
    const margen = await normalizarSeleccion(
      baseDe().db,
      'v1',
      { ...guardado, precios: { ...guardado.precios, markupPercent: 10 } },
      { precios: { markupPercent: 10 } },
      guardado,
    )
    expect(margen.precios).toEqual({ ...esperado, markupPercent: 10 })

    // Y el extra se sigue publicando a 7.
    expect(aplicarSeleccion(menuCon(['p1', 'LATTE', ['MOD-m1']]), horario).precios).toEqual({ overrides: { LATTE: 60, 'MOD-m1': 7 } })
  })

  it('`porExtra` enviado manda sobre la copia; sólo extras del negocio y precios ≥ 0', async () => {
    const { db, findModifiers } = baseDe()
    const enviados = { porExtra: { m1: 8 }, overrides: { 'MOD-m1': 99 } }
    const r = await normalizarSeleccion(
      db,
      'v1',
      { productoIds: ['p1'], precios: enviados },
      { precios: enviados },
      { productoIds: ['p1'] },
    )
    expect(r.precios).toEqual({ porProducto: {}, porExtra: { m1: 8 }, overrides: { 'MOD-m1': 8 } })
    expect(findModifiers.mock.calls[0][0]).toEqual({
      where: { id: { in: ['m1'] }, group: { venueId: 'v1' } },
      select: { id: true },
      take: 1,
    })

    // En la copia por código, un producto que se llama literalmente `MOD-m1` gana la llave (como al publicar).
    const choque = { productoIds: ['pM'], precios: { porProducto: { pM: 79 }, porExtra: { m1: 8 } } }
    const copiaChoque = await normalizarSeleccion(baseDe([{ id: 'pM', sku: 'MOD-m1' }]).db, 'v1', choque, choque, {})
    expect((copiaChoque.precios as { overrides: unknown }).overrides).toEqual({ 'MOD-m1': 79 })

    const con = (porExtra: unknown) => normalizarSeleccion(db, 'v1', { precios: { porExtra } }, { precios: { porExtra } }, {})
    await expect(con({ mAjeno: 3 })).rejects.toThrow(/mAjeno/)
    await expect(con({ m1: -1 })).rejects.toThrow(ValidationError)
    await expect(con({ m1: Infinity })).rejects.toThrow(ValidationError)
    await expect(con(['m1'])).rejects.toThrow(ValidationError)
  })
})

describe('normalizarSeleccion — un canal viejo por código pasa lista y precios a ids JUNTOS', () => {
  const guardado = { productos: ['LATTE', 'A', 'VIEJO'], precios: { overrides: { LATTE: 60 } } }

  it('🔴 la API vieja pasa los precios a ids ⇒ la lista guardada también (el código de nadie se cae sin error)', async () => {
    const enviado = { precios: { overrides: { LATTE: 65 } } }
    const r = await normalizarSeleccion(baseDe().db, 'v1', { ...guardado, ...enviado }, enviado, guardado)
    expect(r.productoIds).toEqual(['p1', 'pA'])
    expect(r.productos).toEqual(['LATTE', 'A'])
    expect(r.precios).toEqual({ porProducto: { p1: 65 }, overrides: { LATTE: 65 } })

    // Después p1 pasa a Z: sigue publicándose, a su precio.
    const { snapshot, precios } = aplicarSeleccion(menuCon(['p1', 'Z'], ['pA', 'A']), r)
    expect(snapshot.categories[0].products.map(p => p.plu)).toEqual(['Z', 'A'])
    expect(precios?.overrides).toEqual({ Z: 65 })
  })

  it('`porProducto` sin lista (un cliente nuevo de la API) también pasa la lista a ids', async () => {
    const r = await normalizarSeleccion(
      baseDe().db,
      'v1',
      { ...guardado, precios: { porProducto: { p1: 70 }, overrides: { LATTE: 60 } } },
      { precios: { porProducto: { p1: 70 } } },
      guardado,
    )
    expect(r.productoIds).toEqual(['p1', 'pA'])
    expect(r.precios).toEqual({ porProducto: { p1: 70 }, overrides: { LATTE: 70 } })
  })

  it('sin precios por id que guardar (sólo el horario, o `overrides: {}`) el canal sigue por código, lista y precios', async () => {
    const { db, findMany } = baseDe()
    const horario = await normalizarSeleccion(db, 'v1', { ...guardado, deliveryHours: null }, { deliveryHours: null }, guardado)
    expect(horario).toEqual({ ...guardado, deliveryHours: null })
    const vacio = await normalizarSeleccion(db, 'v1', { ...guardado, precios: { overrides: {} } }, { precios: { overrides: {} } }, guardado)
    expect(vacio).toEqual({ productos: ['LATTE', 'A', 'VIEJO'], precios: { overrides: {} } })
    expect(findMany).not.toHaveBeenCalled()
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
