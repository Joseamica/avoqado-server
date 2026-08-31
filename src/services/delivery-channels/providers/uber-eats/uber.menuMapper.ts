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

/**
 * El precio que se publica para un SKU: override fijo > markup > precio de mostrador.
 *
 * Se redondea al centavo en la MISMA operación que convierte a centavos, no antes: redondear
 * dos veces (a pesos y luego a centavos) desplaza el precio y el comercio cobra distinto de
 * lo que configuró.
 */
function precioPublicado(sku: string, precioMostrador: number, p?: PreciosDeCanal): number {
  const fijo = p?.overrides?.[sku]
  if (typeof fijo === 'number' && Number.isFinite(fijo) && fijo >= 0) return aCentavos(fijo)
  const pct = p?.markupPercent
  if (typeof pct === 'number' && Number.isFinite(pct) && pct !== 0) return aCentavos(precioMostrador * (1 + pct / 100))
  return aCentavos(precioMostrador)
}

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
    /** Los grupos de opciones que ESTE artículo ofrece. Sin esto los grupos existen en el
     *  menú pero ningún producto los muestra: el cliente no puede pedir queso extra. */
    modifier_group_ids?: { ids: string[] }
  }>
  modifier_groups: Array<{
    id: string
    title: ReturnType<typeof t>
    quantity_info: unknown
    modifier_options: Array<{ id: string; type: string }>
  }>
}

export interface PreciosDeCanal {
  /**
   * Porcentaje que se SUMA al precio de mostrador para este canal. `30` = +30%.
   *
   * 🔴 Existe porque Uber cobra ~30% de comisión: publicar el precio de mostrador hace que
   * el comercio PIERDA dinero en cada pedido de delivery. Subir el precio en el marketplace
   * es práctica normal del sector.
   */
  markupPercent?: number
  /** Precio fijo en PESOS para un SKU concreto. Gana sobre el markup. */
  overrides?: Record<string, number>
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

  /**
   * Precios propios de este canal.
   *
   * 🔴 LA LECCIÓN MÁS REPETIDA DE LOS AGREGADORES (Otter, Chowly): una sincronización desde
   * el POS SOBRESCRIBE los precios especiales que el comercio puso en el marketplace. Sin
   * esto, nuestro sincronizador —que corre cada 5 minutos— le borraría al comercio su
   * markup de delivery una y otra vez, y perdería dinero en cada pedido sin entender por qué.
   *
   * Default: sin markup y sin overrides ⇒ se publica el precio de mostrador, que es
   * exactamente lo que hacía antes. Nadie cambia de comportamiento hasta configurarlo.
   */
  precios?: PreciosDeCanal
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
/** Cuántas opciones EXIGE el grupo. Nunca más de las que realmente tiene. */
const minPermitido = (g: { required: boolean; minSelections: number; modifiers: unknown[] }) =>
  g.required ? Math.min(Math.max(1, g.minSelections), g.modifiers.length) : 0

/** Cuántas PERMITE. Sin tope explícito, tantas como opciones haya (o una si no es múltiple). */
const maxPermitido = (g: { allowMultiple: boolean; maxSelections: number | null; modifiers: unknown[] }) =>
  Math.min(g.maxSelections ?? (g.allowMultiple ? g.modifiers.length : 1), g.modifiers.length)

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
  // 🔴 DOS espacios de nombres, porque hay DOS arreglos en el payload de Uber (corregido
  // tras la 2ª pasada de Codex, que cazó el error de la 1ª):
  //   · `items[]`      → productos Y opciones comparten arreglo, así que comparten set.
  //                      Separarlos dejaba pasar dos `items[].id` iguales y Uber rechaza
  //                      el menú COMPLETO — el negocio se queda sin catálogo.
  //   · `modifier_groups[]` → arreglo aparte, set aparte. Con el set compartido, un SKU que
  //                      por casualidad valiera `grp-<id>` hacía que el grupo se omitiera
  //                      como "duplicado" y el artículo quedaba apuntando a un grupo que
  //                      nunca se publica: referencia colgante, mismo rechazo.
  const vistos = new Set<string>()
  const gruposVistos = new Set<string>()
  /** Sólo los ids de PRODUCTO, para poder distinguir un duplicado legítimo (el mismo
   *  producto en dos categorías) de una colisión producto↔opción, que sí es un error. */
  const productosVistos = new Set<string>()

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
      productosVistos.add(p.plu)

      // 🔴 El ENLACE del producto a sus grupos. Se calcula ANTES de publicar el artículo
      // porque va DENTRO de él: sin `modifier_group_ids` los grupos viajan al menú pero
      // ningún producto los ofrece — medido en la tienda sandbox el 27-ago, donde los 3
      // grupos con sus 9 opciones estaban publicados y `items con modifier_group_ids` era 0.
      // El cliente veía la hamburguesa sin poder elegir nada.
      // Se filtra con el MISMO criterio que abajo (grupo sin opciones se omite), o el
      // artículo apuntaría a un grupo que nunca se publica y Uber rechaza el menú entero.
      const idsDeGrupos = p.modifierGroups.filter(g => g.modifiers.length > 0).map(g => `grp-${g.id}`)

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
        price_info: { price: precioPublicado(p.plu, p.price, opts.precios) },
        tax_info: {},
        ...(idsDeGrupos.length > 0 ? { modifier_group_ids: { ids: idsDeGrupos } } : {}),
      })

      for (const g of p.modifierGroups) {
        // 🔴 Un grupo de modificadores VACÍO rompe el pedido del cliente. Si además es
        // obligatorio, le pide elegir algo de una lista sin opciones y NO PUEDE completar la
        // compra — el producto queda invendible sin que nada falle de nuestro lado.
        // Toast lo documenta como falla de sincronización con Uber, DoorDash, Grubhub,
        // Deliveroo y Skip: "an empty modifier group is one that exists but has no
        // selectable modifier options inside it".
        // Un grupo sin opciones no aporta NADA: se omite en vez de publicarlo roto.
        if (g.modifiers.length === 0) continue

        const gid = `grp-${g.id}`
        if (gruposVistos.has(gid)) continue
        gruposVistos.add(gid)

        grupos.push({
          id: gid,
          title: t(g.name),
          quantity_info: {
            quantity: {
              // El máximo nunca puede quedar por debajo del mínimo ni de las opciones que
              // existen: un grupo que exige 2 y permite 1 deja al cliente sin poder avanzar.
              max_permitted: Math.max(maxPermitido(g), minPermitido(g)),
              min_permitted: minPermitido(g),
            },
          },
          modifier_options: g.modifiers.map(m => ({ id: m.plu, type: 'ITEM' })),
        })

        // Un modificador ES un item en el modelo de Uber: sin esto, el grupo apunta a ids
        // inexistentes y el menú se rechaza completo.
        for (const m of g.modifiers) {
          // 🔴 Una opción cuyo PLU choca con el SKU de un producto NO se salta en silencio
          // (Codex, 3ª pasada): "el primero gana" publicaría el nombre y el precio de uno
          // bajo el id del otro — el cliente vería un extra vendido como producto, al precio
          // equivocado. Se aborta la publicación con los dos ids en el mensaje; el menú
          // anterior sigue vivo en Uber mientras alguien renombra uno de los dos.
          if (productosVistos.has(m.plu)) {
            throw new Error(
              `El menú de Uber no se puede publicar: el modificador "${m.name}" usa el id "${m.plu}", que ya lo ocupa ` +
                `un PRODUCTO. Uber los guarda en la misma lista, así que uno pisaría al otro y se vendería al precio ` +
                `equivocado. Cambia el SKU de uno de los dos.`,
            )
          }
          if (vistos.has(m.plu)) continue
          vistos.add(m.plu)
          items.push({
            id: m.plu,
            external_data: m.plu,
            title: t(m.name),
            // Los modificadores también llevan markup: si no, un extra de $20 con 30% de markup
            // en el platillo sigue publicándose a $20 y la comisión se come ese margen.
            price_info: { price: precioPublicado(m.plu, m.price, opts.precios) },
            tax_info: {},
          })
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
