/**
 * Qué productos publica un canal de delivery (`config.productos`).
 *
 * 🔴 Testarudo (12-nov): en Rappi vende 40 productos; su catálogo de Avoqado tiene 111 (cervezas, vinos,
 * esculturas, flores, eventos). Sin la lista, conectar Rappi subía TODO. Ausente = todo el catálogo (como siempre);
 * una lista mal escrita NUNCA cae a «todo» ni a «nada»: truena, y no se publica (un menú vacío borra el de Uber).
 */
import {
  aplicarSeleccion,
  filtrarMenuDelCanal,
  huellaDeSeleccion,
  idsDelCanal,
  MAX_PRODUCTOS,
  productosDelCanal,
  resumenDeProductos,
  seleccionDelCanal,
  validarIdsDelCanal,
  validarProductosDelCanal,
} from '@/services/delivery-channels/core/productosDelCanal'
import { ValidationError } from '@/errors/AppError'
import type { MenuSnapshot } from '@/services/delivery-channels/core/menuSnapshot.service'

const producto = (plu: string) => ({ plu, name: plu, description: null, price: 50, imageUrl: null, modifierGroups: [] })

const MENU: MenuSnapshot = {
  venueId: 'v1',
  generatedAt: 'x',
  categories: [
    { name: 'BARRA DE CAFE', products: [producto('LATTE'), producto('AMERICANO')] },
    { name: 'CERVEZAS', products: [producto('CORONA')] },
    { name: 'PANADERIA', products: [producto('CROISSANT')] },
  ],
}

describe('productosDelCanal — leer la lista del canal', () => {
  it('sin lista (ausente o null) es «todo el catálogo», como hasta hoy', () => {
    expect(productosDelCanal(null)).toBeNull()
    expect(productosDelCanal({})).toBeNull()
    expect(productosDelCanal({ precios: { markupPercent: 30 } })).toBeNull()
    expect(productosDelCanal({ productos: null })).toBeNull()
  })

  it('una lista de SKU devuelve esos SKU', () => {
    expect(productosDelCanal({ productos: ['LATTE', 'CROISSANT'] })).toEqual(new Set(['LATTE', 'CROISSANT']))
  })

  it('🔴 una lista mal escrita truena (nunca se lee como «todo» ni como «nada»)', () => {
    expect(() => productosDelCanal({ productos: 'LATTE' })).toThrow(/productos/)
    expect(() => productosDelCanal({ productos: [] })).toThrow(/productos/)
    expect(() => productosDelCanal({ productos: ['LATTE', 7] })).toThrow(/productos/)
    expect(() => productosDelCanal({ productos: ['  '] })).toThrow(/productos/)
  })
})

describe('filtrarMenuDelCanal — el menú que viaja al proveedor', () => {
  it('sin lista, el menú sale completo y sin tocar', () => {
    expect(filtrarMenuDelCanal(MENU, null)).toBe(MENU)
  })

  it('con lista, sólo salen sus productos y desaparecen los pasillos que quedan vacíos', () => {
    const r = filtrarMenuDelCanal(MENU, new Set(['LATTE', 'CROISSANT']))
    expect(r.categories).toEqual([
      { name: 'BARRA DE CAFE', products: [producto('LATTE')] },
      { name: 'PANADERIA', products: [producto('CROISSANT')] },
    ])
    // No muta el original: la misma foto se usa para la disponibilidad y el log.
    expect(MENU.categories).toHaveLength(3)
  })

  it('un SKU de la lista que ya no existe en el catálogo simplemente no sale', () => {
    const r = filtrarMenuDelCanal(MENU, new Set(['LATTE', 'VASO-INFUSOR']))
    expect(r.categories.flatMap(c => c.products.map(p => p.plu))).toEqual(['LATTE'])
  })
})

describe('validarProductosDelCanal — al guardar', () => {
  it('acepta ausente, null (= todo el catálogo) y una lista de SKU', () => {
    expect(() => validarProductosDelCanal(undefined)).not.toThrow()
    expect(() => validarProductosDelCanal(null)).not.toThrow()
    expect(() => validarProductosDelCanal(['LATTE', 'CROISSANT'])).not.toThrow()
  })

  it('rechaza una lista vacía, con basura o demasiado larga, en español', () => {
    expect(() => validarProductosDelCanal([])).toThrow(/al menos un producto/)
    expect(() => validarProductosDelCanal('LATTE')).toThrow(/lista/)
    expect(() => validarProductosDelCanal(['LATTE', ''])).toThrow(/SKU/)
    expect(() => validarProductosDelCanal(Array.from({ length: 5001 }, (_, i) => `S${i}`))).toThrow(/5000/)
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════
//  D1 (16-nov): la lista del canal guarda PRODUCTOS (ids) y se traduce al código sobre la MISMA copia que se publica
// ═════════════════════════════════════════════════════════════════════════════════════════

/** Un producto de la copia del catálogo, con su id (lo que arma `buildMenuSnapshot`). */
const conId = (productId: string, plu: string) => ({ ...producto(plu), productId })

const copia = (p1: string, p2: string, p3: string): MenuSnapshot => ({
  venueId: 'v1',
  generatedAt: 'x',
  categories: [
    { name: 'BARRA DE CAFE', products: [conId('p1', p1), conId('p2', p2)] },
    { name: 'TES', products: [conId('p3', p3)] },
  ],
})

const plus = (m: MenuSnapshot) => m.categories.flatMap(c => c.products.map(p => p.plu))
const algunId = (m: MenuSnapshot) => m.categories.some(c => c.products.some(p => 'productId' in p))

describe('idsDelCanal — leer la lista de productos (ids) del canal', () => {
  it('ausente o null = no hay lista por id', () => {
    expect(idsDelCanal(null)).toBeNull()
    expect(idsDelCanal({})).toBeNull()
    expect(idsDelCanal({ productos: ['LATTE'] })).toBeNull()
    expect(idsDelCanal({ productoIds: null })).toBeNull()
  })

  it('una lista de ids devuelve esos ids', () => {
    expect(idsDelCanal({ productoIds: ['p1', 'p3'] })).toEqual(['p1', 'p3'])
  })

  it('🔴 una lista mal escrita truena (nunca se lee como «todo» ni como «nada»)', () => {
    expect(() => idsDelCanal({ productoIds: 'x' })).toThrow(/productoIds/)
    expect(() => idsDelCanal({ productoIds: [] })).toThrow(/productoIds/)
    expect(() => idsDelCanal({ productoIds: ['p1', 7] })).toThrow(/productoIds/)
    expect(() => idsDelCanal({ productoIds: ['  '] })).toThrow(/productoIds/)
    expect(() => idsDelCanal({ productoIds: Array.from({ length: MAX_PRODUCTOS + 1 }, (_, i) => `p${i}`) })).toThrow(/productoIds/)
  })
})

describe('validarIdsDelCanal — al guardar (PATCH)', () => {
  it('acepta ausente, null y una lista de ids', () => {
    expect(() => validarIdsDelCanal(undefined)).not.toThrow()
    expect(() => validarIdsDelCanal(null)).not.toThrow()
    expect(() => validarIdsDelCanal(['p1'])).not.toThrow()
    expect(() => validarIdsDelCanal(Array.from({ length: MAX_PRODUCTOS }, (_, i) => `p${i}`))).not.toThrow()
  })

  it('rechaza con ValidationError en español una lista vacía, con basura o demasiado larga', () => {
    expect(() => validarIdsDelCanal([])).toThrow(ValidationError)
    expect(() => validarIdsDelCanal([])).toThrow(/al menos un producto/)
    expect(() => validarIdsDelCanal('p1')).toThrow(/lista/)
    expect(() => validarIdsDelCanal(['p1', ''])).toThrow(/texto no vacío/)
    expect(() => validarIdsDelCanal(Array.from({ length: 5001 }, (_, i) => `p${i}`))).toThrow(/5000/)
  })
})

describe('aplicarSeleccion — filtra y arma los precios sobre la MISMA copia del catálogo', () => {
  it('🔴 con productoIds sólo salen esos productos, por id, y la copia que sale NO lleva productId', () => {
    const { snapshot } = aplicarSeleccion(copia('LATTE', 'CAP', 'TE'), { productoIds: ['p1', 'p3'] })
    expect(plus(snapshot)).toEqual(['LATTE', 'TE'])
    expect(snapshot.categories).toEqual([
      { name: 'BARRA DE CAFE', products: [producto('LATTE')] },
      { name: 'TES', products: [producto('TE')] },
    ])
    expect(algunId(snapshot)).toBe(false)
  })

  it('🔴 Review Focus 2: p1 pasó de LATTE a Z y p2 tomó LATTE: se publica Z (p1) y NO LATTE (p2)', () => {
    const { snapshot } = aplicarSeleccion(copia('Z', 'LATTE', 'TE'), { productoIds: ['p1', 'p3'] })
    expect(plus(snapshot)).toEqual(['Z', 'TE'])
  })

  it('con productoIds se ignora la copia por código (`productos`), aunque esté dañada', () => {
    const { snapshot } = aplicarSeleccion(copia('LATTE', 'CAP', 'TE'), { productoIds: ['p2'], productos: 'basura' })
    expect(plus(snapshot)).toEqual(['CAP'])
  })

  it('sin productoIds y con la lista vieja por código, filtra por código como hoy (y sin productId)', () => {
    const menu = copia('LATTE', 'CAP', 'TE')
    const { snapshot } = aplicarSeleccion(menu, { productos: ['CAP'] })
    expect(snapshot.categories).toEqual([{ name: 'BARRA DE CAFE', products: [producto('CAP')] }])
    // No muta la copia: se usa una sola vez, pero quien la armó la puede seguir leyendo.
    expect(algunId(menu)).toBe(true)
  })

  it('sin ninguna lista sale el catálogo entero, sin productId', () => {
    const { snapshot } = aplicarSeleccion(copia('LATTE', 'CAP', 'TE'), {})
    expect(snapshot).toEqual({
      venueId: 'v1',
      generatedAt: 'x',
      categories: [
        { name: 'BARRA DE CAFE', products: [producto('LATTE'), producto('CAP')] },
        { name: 'TES', products: [producto('TE')] },
      ],
    })
    expect(algunId(snapshot)).toBe(false)
  })

  it('🔴 una lista de ids mal escrita truena (no publica)', () => {
    expect(() => aplicarSeleccion(copia('LATTE', 'CAP', 'TE'), { productoIds: 'x' })).toThrow(/productoIds/)
    expect(() => aplicarSeleccion(copia('LATTE', 'CAP', 'TE'), { productos: [] })).toThrow(/productos/)
  })

  it('🔴 precios por producto: el código sale de ESTA copia; la llave vieja de producto se ignora y la del extra se conserva', () => {
    const menu = copia('Z', 'LATTE', 'TE')
    menu.categories[1].products[0].modifierGroups = [
      {
        id: 'g1',
        name: 'Leche',
        required: false,
        allowMultiple: false,
        minSelections: 0,
        maxSelections: 1,
        modifiers: [{ plu: 'MOD-m1', name: 'Avena', price: 10 }],
      },
    ]
    const { precios } = aplicarSeleccion(menu, {
      productoIds: ['p1', 'p3'],
      precios: { markupPercent: 30, porProducto: { p1: 79 }, overrides: { LATTE: 50, 'MOD-m1': 5 } },
    })
    expect(precios).toEqual({ markupPercent: 30, overrides: { Z: 79, 'MOD-m1': 5 } })
  })

  it('🔴 Codex impl r1 #2: con porProducto, un `MOD-…` guardado sólo viaja si es un extra de ESTA copia y no el código de un producto', () => {
    // p2 tomó el código `MOD-raro` que antes era de otro producto: su precio guardado por código NO se le pasa.
    const { precios } = aplicarSeleccion(copia('Z', 'MOD-raro', 'TE'), {
      productoIds: ['p1', 'p2'],
      precios: { porProducto: { p1: 79 }, overrides: { 'MOD-raro': 79, 'MOD-m1': 5 } },
    })
    // `MOD-m1` tampoco viaja: no es extra de ningún producto de esta copia.
    expect(precios).toEqual({ overrides: { Z: 79 } })
  })

  it('precios por producto de un producto que no se publica no viajan', () => {
    const { precios } = aplicarSeleccion(copia('LATTE', 'CAP', 'TE'), {
      productoIds: ['p1'],
      precios: { porProducto: { p1: 79, p2: 40 } },
    })
    expect(precios).toEqual({ overrides: { LATTE: 79 } })
  })

  it('sin porProducto, los precios guardados viajan TAL CUAL (como hoy)', () => {
    const guardados = { markupPercent: 30, overrides: { LATTE: 50, 'MOD-m1': 5 } }
    expect(aplicarSeleccion(copia('LATTE', 'CAP', 'TE'), { productoIds: ['p1'], precios: guardados }).precios).toBe(guardados)
    expect(aplicarSeleccion(copia('LATTE', 'CAP', 'TE'), { precios: guardados }).precios).toBe(guardados)
    expect(aplicarSeleccion(copia('LATTE', 'CAP', 'TE'), {}).precios).toBeUndefined()
  })
})

describe('huellaDeSeleccion — la huella canónica de lo que el dueño eligió', () => {
  const base = {
    productoIds: ['p1', 'p3'],
    productos: ['LATTE', 'TE'],
    precios: { markupPercent: 10, porProducto: { p1: 79, p3: 40 }, overrides: { LATTE: 79 } },
    deliveryHours: { mon: { enabled: true, ranges: [{ open: '09:00', close: '18:00' }] } },
    agotarPorInventario: false,
    impresion: { imprimir: true },
  }

  it('es sha256 en hex', () => {
    expect(huellaDeSeleccion(base)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('🔴 Review Focus 5: no cambia con las llaves en otro orden (el reenvío del mismo guardado)', () => {
    const reordenado = {
      impresion: { imprimir: true },
      precios: { overrides: { LATTE: 79 }, porProducto: { p3: 40, p1: 79 }, markupPercent: 10 },
      agotarPorInventario: false,
      deliveryHours: { mon: { ranges: [{ close: '18:00', open: '09:00' }], enabled: true } },
      productos: ['LATTE', 'TE'],
      productoIds: ['p1', 'p3'],
    }
    expect(huellaDeSeleccion(reordenado)).toBe(huellaDeSeleccion(base))
  })

  it('cambia con cualquiera de los seis campos', () => {
    const h = huellaDeSeleccion(base)
    expect(huellaDeSeleccion({ ...base, productoIds: ['p1'] })).not.toBe(h)
    expect(huellaDeSeleccion({ ...base, productos: ['LATTE'] })).not.toBe(h)
    expect(huellaDeSeleccion({ ...base, precios: { ...base.precios, markupPercent: 11 } })).not.toBe(h)
    expect(huellaDeSeleccion({ ...base, deliveryHours: null })).not.toBe(h)
    expect(huellaDeSeleccion({ ...base, agotarPorInventario: true })).not.toBe(h)
    expect(huellaDeSeleccion({ ...base, impresion: { imprimir: false } })).not.toBe(h)
  })

  it('no cambia con llaves del sistema (menuEnRevision, productosRevisados, soldOutSkus)', () => {
    const h = huellaDeSeleccion(base)
    expect(huellaDeSeleccion({ ...base, menuEnRevision: { huella: 'x', publicadaEn: 'y' } })).toBe(h)
    expect(huellaDeSeleccion({ ...base, productosRevisados: ['p9'] })).toBe(h)
    expect(huellaDeSeleccion({ ...base, soldOutSkus: ['LATTE'] })).toBe(h)
  })

  it('ausente y null valen lo mismo; nunca truena', () => {
    expect(huellaDeSeleccion({})).toBe(huellaDeSeleccion({ productoIds: null, precios: null }))
    expect(huellaDeSeleccion(null)).toBe(huellaDeSeleccion({}))
  })
})

describe('seleccionDelCanal y resumenDeProductos leen también `productoIds`', () => {
  it('seleccionDelCanal cambia si cambia la lista de ids (la comprobación bajo candado la ve)', () => {
    expect(seleccionDelCanal({ productoIds: ['p1'] })).not.toBe(seleccionDelCanal({ productoIds: ['p1', 'p2'] }))
    expect(seleccionDelCanal({ productoIds: ['p1'] })).not.toBe(seleccionDelCanal({}))
  })

  it('resumenDeProductos cuenta los ids cuando están (ganan sobre la lista vieja) y avisa si la lista no sirve', () => {
    expect(resumenDeProductos({ productoIds: ['p1', 'p2', 'p2'], productos: ['LATTE'] })).toEqual({ cuantos: 2 })
    expect(resumenDeProductos({ productoIds: 'x' })).toEqual({ cuantos: null, problema: expect.stringMatching(/no se publica/) })
    expect(resumenDeProductos({ productos: ['LATTE', 'TE'] })).toEqual({ cuantos: 2 })
    expect(resumenDeProductos({})).toEqual({ cuantos: null })
  })
})
