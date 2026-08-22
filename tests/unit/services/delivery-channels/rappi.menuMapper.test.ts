/**
 * El menú de Avoqado → el de Rappi.
 *
 * Las reglas salen de la documentación de Rappi, no de suposiciones. Lo que estos tests NO
 * pueden probar es si el precio va en pesos o en centavos: su portal nunca lo dice.
 */
import { construirMenuRappi, LIMITES } from '../../../../src/services/delivery-channels/providers/rappi/rappi.menuMapper'
import type { MenuSnapshot } from '../../../../src/services/delivery-channels/core/menuSnapshot.service'

function producto(over: Record<string, unknown> = {}) {
  return {
    plu: 'TACO-1',
    name: 'Taco de pastor',
    description: 'Con piña',
    price: 25,
    imageUrl: null,
    modifierGroups: [],
    ...over,
  }
}

function menu(productos: unknown[] = [producto()], nombreCat = 'Tacos'): MenuSnapshot {
  return {
    venueId: 'v1',
    generatedAt: '2026-08-22T00:00:00.000Z',
    categories: [{ name: nombreCat, products: productos as never }],
  }
}

describe('construirMenuRappi', () => {
  it('arma la forma que Rappi espera: storeId + items con su categoría', () => {
    const { payload, problemas } = construirMenuRappi(menu(), '900103361')

    expect(problemas).toEqual([])
    expect(payload.storeId).toBe('900103361')
    expect(payload.items[0]).toMatchObject({
      name: 'Taco de pastor',
      sku: 'TACO-1',
      price: 25,
      type: 'PRODUCT',
      category: { name: 'Tacos' },
    })
  })

  // ── El margen: lo único que evita perder dinero en cada pedido ────────────────────
  it('aplica el margen del canal al precio publicado', () => {
    const { payload } = construirMenuRappi(menu(), 's1', { precios: { markupPercent: 30 } })
    expect(payload.items[0].price).toBe(33) // 25 × 1.30 = 32.5 → entero
  })

  it('un precio fijo por producto gana sobre el margen', () => {
    const { payload } = construirMenuRappi(menu(), 's1', { precios: { markupPercent: 30, overrides: { 'TACO-1': 40 } } })
    expect(payload.items[0].price).toBe(40)
  })

  it('🔴 el margen alcanza también a los modificadores', () => {
    // Sin esto, un extra de $20 con 30% de margen se publica en $20 y el comercio lo regala.
    const conExtra = producto({
      modifierGroups: [
        {
          id: 'g1',
          name: 'Extras',
          required: false,
          allowMultiple: false,
          minSelections: 0,
          maxSelections: 1,
          modifiers: [{ plu: 'QUESO', name: 'Queso', price: 20 }],
        },
      ],
    })
    const { payload } = construirMenuRappi(menu([conExtra]), 's1', { precios: { markupPercent: 30 } })
    expect(payload.items[0].children![0].price).toBe(26)
  })

  // ── Modificadores: el grupo se vuelve la categoría del hijo ───────────────────────
  it('un grupo REQUERIDO sale con minQty ≥ 1', () => {
    const p = producto({
      modifierGroups: [
        {
          id: 'g1',
          name: 'Salsa',
          required: true,
          allowMultiple: false,
          minSelections: 0,
          maxSelections: 1,
          modifiers: [{ plu: 'S1', name: 'Verde', price: 0 }],
        },
      ],
    })
    // `required: true` con `minSelections: 0` se contradice; gana `required`, que es la
    // palabra con la que el comercio lo configuró.
    expect(construirMenuRappi(menu([p]), 's1').payload.items[0].children![0].category.minQty).toBe(1)
  })

  it('un grupo sin tope usa el número de opciones como maxQty (Rappi exige un número)', () => {
    const p = producto({
      modifierGroups: [
        {
          id: 'g1',
          name: 'Extras',
          required: false,
          allowMultiple: true,
          minSelections: 0,
          maxSelections: null,
          modifiers: [
            { plu: 'A', name: 'A', price: 1 },
            { plu: 'B', name: 'B', price: 2 },
          ],
        },
      ],
    })
    expect(construirMenuRappi(menu([p]), 's1').payload.items[0].children![0].category.maxQty).toBe(2)
  })

  // ── Las reglas documentadas que evitan un rechazo a ciegas ────────────────────────
  // Un menú rechazado llega como `MENU_REJECTED` SIN motivo. Cada regla que atrapemos aquí
  // es un rechazo que no vamos a tener que adivinar.
  it('🔴 un producto de $0 SIN modificadores se reporta y NO se publica', () => {
    const { payload, problemas } = construirMenuRappi(menu([producto({ price: 0 })]), 's1')
    expect(payload.items).toHaveLength(0)
    expect(problemas[0].problema).toMatch(/\$0/)
  })

  it('un producto de $0 CON modificadores SÍ se publica (el "arma tu ensalada")', () => {
    const p = producto({
      price: 0,
      modifierGroups: [
        {
          id: 'g1',
          name: 'Ingredientes',
          required: true,
          allowMultiple: true,
          minSelections: 1,
          maxSelections: 5,
          modifiers: [{ plu: 'X', name: 'Lechuga', price: 10 }],
        },
      ],
    })
    expect(construirMenuRappi(menu([p]), 's1').payload.items).toHaveLength(1)
  })

  it('recorta los textos a los largos que Rappi acepta en vez de que los rechace', () => {
    const largo = producto({ name: 'x'.repeat(2000), description: 'y'.repeat(5000) })
    const item = construirMenuRappi(menu([largo]), 's1').payload.items[0]
    expect(item.name.length).toBe(LIMITES.nombre.max)
    expect(item.description!.length).toBe(LIMITES.descripcion.max)
  })

  it('🔴 respeta el tope de 50 modificadores y AVISA cuáles quedaron fuera', () => {
    // Cortar en silencio dejaría al comercio sin entender por qué faltan opciones.
    const muchos = Array.from({ length: 60 }, (_, i) => ({ plu: `M${i}`, name: `Extra ${i}`, price: 5 }))
    const p = producto({
      modifierGroups: [
        { id: 'g1', name: 'Extras', required: false, allowMultiple: true, minSelections: 0, maxSelections: 60, modifiers: muchos },
      ],
    })
    const { payload, problemas } = construirMenuRappi(menu([p]), 's1')
    expect(payload.items[0].children).toHaveLength(LIMITES.hijosPorProducto)
    expect(problemas[0].problema).toMatch(/50/)
  })

  it('respeta el tope de 50 productos por pasillo y avisa', () => {
    const muchos = Array.from({ length: 60 }, (_, i) => producto({ plu: `P${i}` }))
    const { payload, problemas } = construirMenuRappi(menu(muchos), 's1')
    expect(payload.items).toHaveLength(LIMITES.productosPorPasillo)
    expect(problemas.some(p => /50/.test(p.problema))).toBe(true)
  })

  // ── Un producto malo NO puede dejar al negocio sin carta ──────────────────────────
  it('🔴 reporta los problemas en vez de LANZAR: se publica lo que sí sirve', () => {
    const { payload, problemas } = construirMenuRappi(menu([producto({ plu: '' }), producto({ plu: 'BUENO' })]), 's1')
    expect(payload.items).toHaveLength(1)
    expect(payload.items[0].sku).toBe('BUENO')
    expect(problemas).toHaveLength(1)
  })

  it('el id de categoría es estable y sin acentos ni espacios', () => {
    const { payload } = construirMenuRappi(menu([producto()], 'Bebidas Frías'), 's1')
    expect(payload.items[0].category.id).toBe('bebidas-frias')
  })

  it('omite description e imageUrl cuando no hay, en vez de mandarlos vacíos', () => {
    const { payload } = construirMenuRappi(menu([producto({ description: null, imageUrl: null })]), 's1')
    expect(payload.items[0].description).toBeUndefined()
    expect(payload.items[0].imageUrl).toBeUndefined()
  })

  it('un menú vacío produce un payload vacío, no una excepción', () => {
    const vacio: MenuSnapshot = { venueId: 'v1', generatedAt: '', categories: [] }
    expect(construirMenuRappi(vacio, 's1').payload.items).toEqual([])
  })
})
