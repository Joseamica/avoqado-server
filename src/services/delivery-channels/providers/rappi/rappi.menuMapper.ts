/**
 * El menú de Avoqado → el formato de Rappi.
 *
 * 🔴 EL MENÚ DE RAPPI SE APRUEBA, NO SE PUBLICA. Su `POST /menu` contesta *"Menu updated and
 * ready to be validated"* — o sea que un `200` significa "en revisión", no "arriba". Lo
 * publicado llega después por el webhook `MENU_APPROVED`, y si lo rechazan llega
 * `MENU_REJECTED` **sin decir por qué**. Por eso este módulo valida lo que puede ANTES de
 * mandar: cada regla que atrapemos aquí es un rechazo que no vamos a tener que adivinar.
 *
 * Las reglas salen de su documentación, no de suposiciones:
 *   · Máximo DOS niveles: producto → topping. No hay nietos.
 *   · Máximo 50 hijos por producto, 50 productos por pasillo.
 *   · `sku` 1-500 · `name` 1-1000 · `description` 0-2000 caracteres.
 *   · El precio va COMPLETO, sin descuentos aplicados (su texto: "se deben enviar los precios
 *     full en lugar de precios con descuento aplicado"). El descuento lo pone Rappi.
 *   · Un producto SIN toppings debe costar más que cero.
 *
 * ⚠️ Lo que su documentación NO dice, y por eso no se asume: **si el precio va en pesos o en
 * centavos**. Aquí se manda el mismo número que el POS tiene, y el primer menú aprobado —o el
 * primer pedido— resuelve la duda. Es la misma incógnita que el mapeo de pedidos ya cubre con
 * su red de cuadre.
 */
import type { MenuSnapshot, MenuSnapshotProduct } from '../../core/menuSnapshot.service'

/** Topes documentados por Rappi. Superarlos es un rechazo garantizado. */
export const LIMITES = {
  hijosPorProducto: 50,
  productosPorPasillo: 50,
  sku: { min: 1, max: 500 },
  nombre: { min: 1, max: 1000 },
  descripcion: { max: 2000 },
} as const

export interface RappiMenuCategoria {
  id: string
  name: string
  sortingPosition: number
  minQty: number
  maxQty: number
}

export interface RappiMenuHijo {
  category: RappiMenuCategoria
  name: string
  description?: string
  price: number
  sku: string
  maxLimit: number
  sortingPosition: number
  type: 'TOPPING'
}

export interface RappiMenuItem {
  name: string
  description?: string
  imageUrl?: string
  price: number
  sku: string
  sortingPosition: number
  type: 'PRODUCT'
  category: RappiMenuCategoria
  children?: RappiMenuHijo[]
}

export interface RappiMenuPayload {
  storeId: string
  items: RappiMenuItem[]
}

export interface PreciosDeCanal {
  markupPercent?: number
  overrides?: Record<string, number>
}

/**
 * El precio que se publica: override fijo > markup > precio de mostrador.
 *
 * Idéntico en criterio al de Uber, y por la misma razón: sin markup se publica el precio de
 * mostrador y el comercio PIERDE en cada pedido, porque el marketplace se queda su comisión.
 * Rappi además pide el precio COMPLETO —sin descuentos—: los descuentos son campañas suyas.
 */
function precioPublicado(sku: string, precioMostrador: number, p?: PreciosDeCanal): number {
  const fijo = p?.overrides?.[sku]
  if (typeof fijo === 'number' && Number.isFinite(fijo) && fijo >= 0) return redondear(fijo)
  const pct = p?.markupPercent
  if (typeof pct === 'number' && Number.isFinite(pct) && pct !== 0) return redondear(precioMostrador * (1 + pct / 100))
  return redondear(precioMostrador)
}

/** Rappi acepta ENTEROS en `price`. Redondear una sola vez, al final. */
function redondear(v: number): number {
  return Math.round(v)
}

function recortar(v: string | null | undefined, max: number): string {
  return (v ?? '').trim().slice(0, max)
}

/** Un id de categoría estable para Rappi, derivado del nombre del pasillo. */
function idCategoria(nombre: string, idx: number): string {
  const slug = nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || `pasillo-${idx}`
}

function mapearHijos(producto: MenuSnapshotProduct, precios?: PreciosDeCanal): RappiMenuHijo[] {
  const hijos: RappiMenuHijo[] = []
  let posicion = 0

  for (const grupo of producto.modifierGroups ?? []) {
    // El grupo se vuelve la CATEGORÍA del topping: Rappi no tiene "grupo de modificadores"
    // como entidad aparte, la agrupación vive en `category` de cada hijo.
    const categoria: RappiMenuCategoria = {
      id: grupo.id,
      name: recortar(grupo.name, LIMITES.nombre.max),
      sortingPosition: posicion,
      // `minQty > 0` es lo que hace OBLIGATORIO al grupo. Un grupo marcado requerido con
      // mínimo 0 sería opcional en Rappi — la contradicción se resuelve a favor de
      // `required`, que es lo que el comercio configuró con esa palabra.
      minQty: grupo.required ? Math.max(1, grupo.minSelections ?? 0) : (grupo.minSelections ?? 0),
      // `null` en nuestro contrato significa "sin tope". Rappi necesita un número, y el tope
      // natural es cuántas opciones tiene el grupo.
      maxQty: grupo.maxSelections ?? grupo.modifiers.length,
    }

    for (const m of grupo.modifiers) {
      hijos.push({
        category: categoria,
        name: recortar(m.name, LIMITES.nombre.max),
        price: precioPublicado(m.plu, m.price, precios),
        sku: recortar(m.plu, LIMITES.sku.max),
        // Cuántas veces se puede repetir ESTE topping. Sin dato propio se usa el del grupo.
        maxLimit: grupo.allowMultiple ? (grupo.maxSelections ?? 1) : 1,
        sortingPosition: posicion,
        type: 'TOPPING',
      })
      posicion++
    }
  }

  return hijos
}

export interface ProblemaMenu {
  sku: string
  problema: string
}

/**
 * Arma el menú y devuelve TAMBIÉN lo que Rappi va a rechazar.
 *
 * 🔴 Se devuelven los problemas en vez de lanzar. Un solo producto mal formado no puede dejar
 * al comercio sin carta: se publica lo que sí sirve y se reporta lo que no, para que alguien
 * lo arregle. Lanzar convertiría un producto con el nombre demasiado largo en "el menú entero
 * no se publicó", que es exactamente el modo de falla que deja a un negocio invisible en la app.
 */
export function construirMenuRappi(
  snapshot: MenuSnapshot,
  storeId: string,
  opts: { precios?: PreciosDeCanal } = {},
): { payload: RappiMenuPayload; problemas: ProblemaMenu[] } {
  const items: RappiMenuItem[] = []
  const problemas: ProblemaMenu[] = []
  let posicion = 0

  snapshot.categories.forEach((cat, idxCat) => {
    const categoria: RappiMenuCategoria = {
      id: idCategoria(cat.name, idxCat),
      name: recortar(cat.name, LIMITES.nombre.max),
      sortingPosition: idxCat,
      // Un pasillo no obliga a elegir nada: eso es cosa de los grupos de modificadores.
      minQty: 0,
      maxQty: 0,
    }

    if (cat.products.length > LIMITES.productosPorPasillo) {
      problemas.push({
        sku: `pasillo:${categoria.id}`,
        problema: `El pasillo "${cat.name}" tiene ${cat.products.length} productos y Rappi acepta ${LIMITES.productosPorPasillo}. Los de más NO se publican.`,
      })
    }

    for (const p of cat.products.slice(0, LIMITES.productosPorPasillo)) {
      const sku = recortar(p.plu, LIMITES.sku.max)
      const nombre = recortar(p.name, LIMITES.nombre.max)

      if (!sku || !nombre) {
        problemas.push({ sku: sku || '(sin sku)', problema: 'Sin sku o sin nombre: Rappi los exige.' })
        continue
      }

      const hijos = mapearHijos(p, opts.precios)
      if (hijos.length > LIMITES.hijosPorProducto) {
        problemas.push({
          sku,
          problema: `Tiene ${hijos.length} modificadores y Rappi acepta ${LIMITES.hijosPorProducto}. Los de más NO se publican.`,
        })
      }

      const precio = precioPublicado(p.plu, p.price, opts.precios)
      // 🔴 Regla documentada: un producto SIN toppings tiene que costar más que cero. Con
      // toppings sí puede ser 0 (el clásico "arma tu ensalada"), y por eso la regla mira
      // los dos datos y no sólo el precio.
      if (precio <= 0 && hijos.length === 0) {
        problemas.push({ sku, problema: 'Cuesta $0 y no tiene modificadores: Rappi lo rechaza.' })
        continue
      }

      const descripcion = recortar(p.description, LIMITES.descripcion.max)

      items.push({
        name: nombre,
        ...(descripcion ? { description: descripcion } : {}),
        ...(p.imageUrl ? { imageUrl: p.imageUrl } : {}),
        price: precio,
        sku,
        sortingPosition: posicion++,
        type: 'PRODUCT',
        category: categoria,
        ...(hijos.length ? { children: hijos.slice(0, LIMITES.hijosPorProducto) } : {}),
      })
    }
  })

  return { payload: { storeId, items }, problemas }
}
