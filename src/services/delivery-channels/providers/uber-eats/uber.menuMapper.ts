/**
 * Traductor: menú de Avoqado (`MenuSnapshot`, en PESOS) → el formato de menú de Uber Eats.
 *
 * ESCRITO CONTRA EL MENÚ REAL de la tienda de sandbox (leído con `GET /v2/eats/stores/{id}/menus`
 * el 2026-08-20), no contra la documentación. Tres cosas que sólo se saben mirándolo:
 *
 *   1. `price_info.price` va en CENTAVOS (MX$1.00 → `100`). Es una frontera externa: es el
 *      único lugar donde se multiplica por 100.
 *   2. Los textos viven bajo `title.translations.en` **incluso siendo español** — así lo
 *      devuelve la tienda real. Usar otra llave que Uber no espere deja el nombre en blanco
 *      en la app, que es peor que un idioma mal etiquetado.
 *   3. `menus[].category_ids` enlaza con `categories[].id`, y `categories[].entities[].id`
 *      enlaza con `items[].id`. Tres niveles por id, sin anidamiento.
 *
 * 🔴 EL `id` DE CADA ITEM ES EL CONTRATO CON LA INGESTA. Es lo que Uber devuelve en el
 * pedido y lo que `uber.productResolver` busca como `Product.externalId`. Si cambia entre
 * publicaciones, los pedidos dejan de resolver a un producto: entran igual (nunca se pierde
 * una venta) pero sin inventario, sin costo y sin reportes por producto.
 */
import type { HorarioSemanal } from '../../core/deliveryHours.service'
import type { MenuSnapshot } from '../../core/menuSnapshot.service'

/** Un texto como lo quiere Uber. Ver nota (2) arriba sobre por qué la llave es `en`. */
const t = (texto: string) => ({ translations: { en: texto } })

/** PESOS → centavos. La ÚNICA multiplicación ×100 permitida (frontera Uber). */
const aCentavos = (pesos: number): number => Math.round(pesos * 100)

const DIAS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const

export interface UberMenuPayload {
  menus: Array<{ id: string; title: ReturnType<typeof t>; service_availability: unknown[]; category_ids: string[] }>
  categories: Array<{ id: string; title: ReturnType<typeof t>; entities: Array<{ id: string }> }>
  items: Array<{
    id: string
    external_data: string
    title: ReturnType<typeof t>
    description?: ReturnType<typeof t>
    image_url?: string
    price_info: { price: number }
    tax_info: Record<string, never>
  }>
  modifier_groups: Array<{
    id: string
    title: ReturnType<typeof t>
    quantity_info: unknown
    modifier_options: Array<{ id: string; type: string }>
  }>
}

export interface UberMenuOptions {
  /**
   * Horario en que la tienda acepta pedidos, ya en formato de Uber.
   *
   * 🔴 Lo resuelve `resolveDeliveryHours` (núcleo) y lo traduce `aDisponibilidadUber`. El
   * default 24/7 de abajo SÓLO aplica si alguien llama a este traductor sin pasar nada —
   * cosa que el sincronizador ya no hace. Publicar 24/7 en un negocio real le mete pedidos
   * a las 3 de la mañana que nadie va a cocinar, y cada rechazo cuenta contra la tasa de
   * inyección que Uber exige para no revocar el acceso.
   */
  availability?: Array<{ day_of_week: string; time_periods: Array<{ start_time: string; end_time: string }> }>
}

const TODO_EL_DIA = DIAS.map(d => ({ day_of_week: d, time_periods: [{ start_time: '00:00', end_time: '23:59' }] }))

/**
 * Horario neutral (el del núcleo) → el formato de Uber.
 *
 * Un día apagado simplemente NO aparece: Uber entiende la ausencia como "cerrado". Mandarlo
 * con una lista vacía de periodos hace que rechace el menú entero.
 */
export function aDisponibilidadUber(horario: HorarioSemanal) {
  return DIAS.filter(d => horario[d]?.enabled && horario[d].ranges.length > 0).map(d => ({
    day_of_week: d,
    time_periods: horario[d].ranges.map(r => ({ start_time: r.open, end_time: r.close })),
  }))
}

/** Ids estables y legibles: si cambian, los pedidos dejan de resolver (ver nota 🔴 arriba). */
const idCategoria = (nombre: string) =>
  `cat-${nombre
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}`

export function mapSnapshotToUberMenu(snapshot: MenuSnapshot, opts: UberMenuOptions = {}): UberMenuPayload {
  const categorias: UberMenuPayload['categories'] = []
  const items: UberMenuPayload['items'] = []
  const grupos: UberMenuPayload['modifier_groups'] = []
  const vistos = new Set<string>()

  for (const cat of snapshot.categories) {
    // Una categoría sin productos hace que Uber muestre una sección vacía en la app.
    if (cat.products.length === 0) continue

    categorias.push({
      id: idCategoria(cat.name),
      title: t(cat.name),
      entities: cat.products.map(p => ({ id: p.plu })),
    })

    for (const p of cat.products) {
      // El MISMO producto puede estar en dos categorías. Duplicar el item hace que Uber
      // rechace el menú entero por id repetido — se publica una vez y se referencia dos.
      if (vistos.has(p.plu)) continue
      vistos.add(p.plu)

      items.push({
        id: p.plu,
        // Se manda por si Uber lo devuelve en el pedido, pero NO se puede contar con él:
        // ⚠️ MEDIDO el 2026-08-20 — lo publicamos y `GET /menus` lo devuelve `undefined`.
        // Uber no lo eco en el menú, y si aparece o no en un PEDIDO sigue sin verificarse.
        //
        // 🔴 Consecuencia real, y por eso está escrito aquí: lo que HOY hace que un pedido
        // reconozca el producto es el fallback `external_data ?? id` de `uber.mapper.ts`,
        // porque publicamos `id = sku`. Ese fallback NO es defensivo: es LOAD-BEARING. El
        // día que alguien lo "limpie" por parecer redundante, TODOS los pedidos de Uber
        // dejan de reconocer productos —entran igual, sin inventario ni costo— y nadie va a
        // relacionar una cosa con la otra.
        external_data: p.plu,
        title: t(p.name),
        ...(p.description ? { description: t(p.description) } : {}),
        ...(p.imageUrl ? { image_url: p.imageUrl } : {}),
        price_info: { price: aCentavos(p.price) },
        tax_info: {},
      })

      for (const g of p.modifierGroups) {
        const gid = `grp-${g.id}`
        if (vistos.has(gid)) continue
        vistos.add(gid)

        grupos.push({
          id: gid,
          title: t(g.name),
          quantity_info: {
            quantity: {
              max_permitted: g.maxSelections ?? (g.allowMultiple ? 99 : 1),
              min_permitted: g.required ? Math.max(1, g.minSelections) : 0,
            },
          },
          modifier_options: g.modifiers.map(m => ({ id: m.plu, type: 'ITEM' })),
        })

        // Un modificador ES un item en el modelo de Uber: sin esto, el grupo apunta a ids
        // inexistentes y el menú se rechaza completo.
        for (const m of g.modifiers) {
          if (vistos.has(m.plu)) continue
          vistos.add(m.plu)
          items.push({ id: m.plu, external_data: m.plu, title: t(m.name), price_info: { price: aCentavos(m.price) }, tax_info: {} })
        }
      }
    }
  }

  return {
    menus: [
      {
        id: 'avoqado-menu',
        title: t('Menú'),
        service_availability: opts.availability ?? TODO_EL_DIA,
        category_ids: categorias.map(c => c.id),
      },
    ],
    categories: categorias,
    items,
    modifier_groups: grupos,
  }
}
