/**
 * El menú de Avoqado traducido al formato de Uber.
 *
 * Escrito contra el menú REAL de la tienda de sandbox (`GET /v2/eats/stores/{id}/menus`,
 * 2026-08-20), no contra la documentación.
 */
import { mapSnapshotToUberMenu } from '@/services/delivery-channels/providers/uber-eats/uber.menuMapper'
import type { MenuSnapshot } from '@/services/delivery-channels/core/menuSnapshot.service'

const menu = (overrides: Partial<MenuSnapshot> = {}): MenuSnapshot => ({
  venueId: 'v1',
  generatedAt: '2026-08-20T00:00:00.000Z',
  categories: [
    {
      name: 'Tacos',
      products: [
        {
          plu: 'SKU-COCHINITA',
          name: 'Cochinita',
          description: 'Con cebolla morada',
          price: 89.5,
          imageUrl: 'https://x/y.jpg',
          modifierGroups: [],
        },
      ],
    },
  ],
  ...overrides,
})

describe('uber.menuMapper', () => {
  it('🔴 el precio va en CENTAVOS: 89.50 pesos → 8950', () => {
    // Es la única multiplicación ×100 permitida (frontera Uber). Un error aquí cobra 100
    // veces de más o de menos y NADA falla: el menú se publica y el cliente ve el precio mal.
    expect(mapSnapshotToUberMenu(menu()).items[0].price_info.price).toBe(8950)
  })

  it('🔴 el `id` del item es el SKU: es el contrato con la ingesta', () => {
    // Uber devuelve este id en cada pedido, y `uber.productResolver` lo busca como
    // `Product.externalId`. Si cambia entre publicaciones, los pedidos entran igual (nunca
    // se pierde una venta) pero SIN inventario, SIN costo y SIN reporte por producto.
    expect(mapSnapshotToUberMenu(menu()).items[0].id).toBe('SKU-COCHINITA')
  })

  it('los tres niveles quedan enlazados por id: menú → categoría → item', () => {
    const p = mapSnapshotToUberMenu(menu())
    expect(p.menus[0].category_ids).toEqual([p.categories[0].id])
    expect(p.categories[0].entities).toEqual([{ id: 'SKU-COCHINITA' }])
  })

  it('🔴 un producto en DOS categorías se publica UNA vez', () => {
    // Uber rechaza el menú COMPLETO si hay un id repetido — se perdería la publicación
    // entera por un producto que está en "Tacos" y en "Favoritos".
    const dos = menu({
      categories: [
        { name: 'Tacos', products: menu().categories[0].products },
        { name: 'Favoritos', products: menu().categories[0].products },
      ],
    })
    const p = mapSnapshotToUberMenu(dos)

    expect(p.items).toHaveLength(1)
    expect(p.categories).toHaveLength(2)
    expect(p.categories.every(c => c.entities[0].id === 'SKU-COCHINITA')).toBe(true) // referenciado dos veces
  })

  it('una categoría vacía no se publica: sería una sección en blanco en la app', () => {
    const conVacia = menu({ categories: [...menu().categories, { name: 'Bebidas', products: [] }] })
    expect(mapSnapshotToUberMenu(conVacia).categories.map(c => c.title.translations.en)).toEqual(['Tacos'])
  })

  it('🔴 un modificador se publica también como ITEM, o el menú entero se rechaza', () => {
    // En el modelo de Uber un modificador ES un item. Publicar el grupo sin publicar sus
    // opciones deja ids colgando y Uber rechaza todo.
    const conMods = menu({
      categories: [
        {
          name: 'Tacos',
          products: [
            {
              ...menu().categories[0].products[0],
              modifierGroups: [
                {
                  id: 'g1',
                  name: 'Extras',
                  required: false,
                  allowMultiple: true,
                  minSelections: 0,
                  maxSelections: 3,
                  modifiers: [{ plu: 'MOD-QUESO', name: 'Queso', price: 12 }],
                },
              ],
            },
          ],
        },
      ],
    })
    const p = mapSnapshotToUberMenu(conMods)

    expect(p.items.map(i => i.id)).toContain('MOD-QUESO')
    expect(p.items.find(i => i.id === 'MOD-QUESO')!.price_info.price).toBe(1200)
    expect(p.modifier_groups[0].modifier_options).toEqual([{ id: 'MOD-QUESO', type: 'ITEM' }])
  })

  it('🔴 el horario por default es 24/7 y eso SOLO sirve para la tienda de pruebas', () => {
    // Publicar 24/7 en un negocio real lo muestra siempre abierto: le entran pedidos a las
    // 3 de la mañana que nadie va a cocinar, y Uber cuenta eso contra su tasa de inyección.
    expect(mapSnapshotToUberMenu(menu()).menus[0].service_availability).toHaveLength(7)

    const propio = [{ day_of_week: 'monday', time_periods: [{ start_time: '09:00', end_time: '18:00' }] }]
    expect(mapSnapshotToUberMenu(menu(), { availability: propio }).menus[0].service_availability).toEqual(propio)
  })
  it('🔴 `id` y `external_data` son AMBOS el SKU — el resolver depende de eso', () => {
    // ⚠️ MEDIDO: publicamos `external_data` y `GET /menus` lo devuelve `undefined` — Uber no
    // lo eco. Si aparece en un PEDIDO sigue sin verificarse. Así que lo que HOY hace que un
    // pedido reconozca el producto es el fallback `external_data ?? id` de `uber.mapper.ts`,
    // combinado con publicar `id = sku`.
    //
    // Por eso este test exige que los DOS sean el SKU: es la única forma de que el resolver
    // enganche por cualquiera de sus dos caminos. Publicar un `id` que no sea el SKU rompe
    // el reconocimiento de TODOS los pedidos sin que nada falle.
    const p = mapSnapshotToUberMenu(menu())
    expect(p.items[0].id).toBe('SKU-COCHINITA')
    expect(p.items[0].external_data).toBe('SKU-COCHINITA')
  })
  // ── Precios propios del canal ────────────────────────────────────────────────────────
  //
  // 🔴 Uber cobra ~30% de comisión: publicar el precio de mostrador hace que el comercio
  // PIERDA dinero en cada pedido. Subir el precio en el marketplace es práctica normal del
  // sector, y la falla que los agregadores (Otter, Chowly) documentan como la más común al
  // conectar un POS es justamente que la sincronización BORRA ese precio especial.
  describe('precios por canal', () => {
    it('sin configurar nada, publica el precio de mostrador (no cambia el comportamiento)', () => {
      expect(mapSnapshotToUberMenu(menu()).items[0].price_info.price).toBe(8950)
    })

    it('🔴 markup: +30% sobre 89.50 → 116.35', () => {
      const p = mapSnapshotToUberMenu(menu(), { precios: { markupPercent: 30 } })
      expect(p.items[0].price_info.price).toBe(11635) // 89.50 × 1.30 = 116.35
    })

    it('🔴 un override fijo GANA sobre el markup', () => {
      // El comercio puso un precio pensado para ese producto en ese canal; un porcentaje
      // genérico no puede pisarlo.
      const p = mapSnapshotToUberMenu(menu(), { precios: { markupPercent: 30, overrides: { 'SKU-COCHINITA': 99 } } })
      expect(p.items[0].price_info.price).toBe(9900)
    })

    it('🔴 los MODIFICADORES también llevan markup', () => {
      // Si no, un extra de $12 con 30% en el platillo se sigue publicando a $12 y la
      // comisión se come ese margen.
      const conMods = menu({
        categories: [
          {
            name: 'Tacos',
            products: [
              {
                ...menu().categories[0].products[0],
                modifierGroups: [
                  {
                    id: 'g1',
                    name: 'Extras',
                    required: false,
                    allowMultiple: true,
                    minSelections: 0,
                    maxSelections: 3,
                    modifiers: [{ plu: 'MOD-QUESO', name: 'Queso', price: 12 }],
                  },
                ],
              },
            ],
          },
        ],
      })
      const p = mapSnapshotToUberMenu(conMods, { precios: { markupPercent: 30 } })
      expect(p.items.find(i => i.id === 'MOD-QUESO')!.price_info.price).toBe(1560) // 12 × 1.30
    })

    it('un markup basura se ignora en vez de publicar un precio absurdo', () => {
      for (const malo of [NaN, Infinity, undefined as unknown as number]) {
        expect(mapSnapshotToUberMenu(menu(), { precios: { markupPercent: malo } }).items[0].price_info.price).toBe(8950)
      }
    })

    it('🔴 un override NEGATIVO se ignora: nadie publica un precio negativo', () => {
      expect(mapSnapshotToUberMenu(menu(), { precios: { overrides: { 'SKU-COCHINITA': -50 } } }).items[0].price_info.price).toBe(8950)
    })
  })
})
