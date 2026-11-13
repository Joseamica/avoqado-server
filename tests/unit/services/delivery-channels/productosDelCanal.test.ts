/**
 * Qué productos publica un canal de delivery (`config.productos`).
 *
 * 🔴 Testarudo (12-nov): en Rappi vende 40 productos; su catálogo de Avoqado tiene 111 (cervezas, vinos,
 * esculturas, flores, eventos). Sin la lista, conectar Rappi subía TODO. Ausente = todo el catálogo (como siempre);
 * una lista mal escrita NUNCA cae a «todo» ni a «nada»: truena, y no se publica (un menú vacío borra el de Uber).
 */
import { filtrarMenuDelCanal, productosDelCanal, validarProductosDelCanal } from '@/services/delivery-channels/core/productosDelCanal'
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
