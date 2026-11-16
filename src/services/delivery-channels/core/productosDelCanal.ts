/**
 * Qué productos publica un canal de delivery.
 *  · `config.productoIds` (D1, 16-nov-2026): una lista de PRODUCTOS (ids). Si está, manda: un cambio de código del producto
 *    no la desarma, porque se traduce al código vigente al publicar, sobre la misma copia del catálogo (`aplicarSeleccion`).
 *  · `config.productos`: la lista vieja, de SKU. Vale sólo si no hay `productoIds` (con ids es la copia para la API vieja).
 *
 * 🔴 Por qué existe (Testarudo, 12-nov-2026): en Rappi vende 40 productos y su catálogo de Avoqado tiene 111
 * (cervezas, vinos, esculturas, flores, eventos). Sin lista, el sincronizador subía el catálogo ENTERO. Ausente o
 * `null` = todo el catálogo activo, que es lo de siempre.
 *
 * 🔴 Una lista mal escrita (no es lista, vacía, con algo que no es un SKU o un id) TRUENA al leerla: nunca se lee como
 * «todo» (subiría lo que el negocio no quiere vender ahí) ni como «nada» (un menú vacío BORRA el de Uber, que
 * reemplaza el menú entero). El sincronizador la atrapa como FAILED y no publica. Al guardar se valida igual.
 */
import { createHash } from 'node:crypto'

import { ValidationError } from '../../../errors/AppError'
import { canonicalJson } from '../../customer-display/canonicalHash'
import type { PreciosDeCanal } from '../providers/uber-eats/uber.menuMapper'
import type { MenuSnapshot, MenuSnapshotProduct } from './menuSnapshot.service'

/** Tope de productos por canal: muy por encima de un menú real (Rappi acepta pocos cientos por pasillo). */
export const MAX_PRODUCTOS = 5000

/** Una lista por id nunca queda vacía (la casilla del producto, el PATCH y el MCP dicen lo mismo). */
export const LISTA_VACIA = 'Un canal necesita al menos un producto; pausa el canal si no quieres vender ahí'

/** Cómo se nombra cada lista en sus mensajes. Los de `productos` son los de siempre: no se cambian. */
const LISTAS = {
  productos: { varios: 'SKU', uno: 'un SKU' },
  productoIds: { varios: 'ids de producto', uno: 'un id de producto' },
} as const

/** El motivo de por qué la lista no sirve, o `null` si sirve. Lo comparten la lectura y el guardado. */
function problemaDeLaLista(v: unknown, llave: keyof typeof LISTAS = 'productos'): string | null {
  const { varios, uno } = LISTAS[llave]
  if (!Array.isArray(v)) return `\`${llave}\` debe ser una lista de ${varios} (o null para publicar todo el catálogo)`
  if (v.length === 0) {
    return llave === 'productoIds'
      ? LISTA_VACIA
      : 'La lista de productos del canal necesita al menos un producto (o null para publicar todo el catálogo)'
  }
  if (v.length > MAX_PRODUCTOS) return `La lista de productos del canal admite hasta ${MAX_PRODUCTOS} ${varios}`
  if (v.some(x => typeof x !== 'string' || x.trim() === '')) return `Cada producto del canal debe ser ${uno} (texto no vacío)`
  return null
}

function comoObjeto(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** La lista guardada en `config[llave]`, o `null` si no hay. Truena si no sirve. */
function listaGuardada(config: unknown, llave: keyof typeof LISTAS): string[] | null {
  const lista = comoObjeto(config)?.[llave]
  if (lista === undefined || lista === null) return null
  const problema = problemaDeLaLista(lista, llave)
  if (problema) throw new Error(`config.${llave} inválido: ${problema}`)
  return lista as string[]
}

/** Los SKU que publica el canal, o `null` = todo el catálogo. Truena si la lista guardada no sirve. */
export function productosDelCanal(config: unknown): Set<string> | null {
  const lista = listaGuardada(config, 'productos')
  return lista && new Set(lista)
}

/** Los productos (ids) que publica el canal, o `null` = no hay lista por id. Truena si la lista guardada no sirve. */
export function idsDelCanal(config: unknown): string[] | null {
  return listaGuardada(config, 'productoIds')
}

/** Sólo los productos que `queda` deja, sin pasillos vacíos. No muta el original. */
function soloLos(snapshot: MenuSnapshot, queda: (p: MenuSnapshotProduct) => boolean): MenuSnapshot {
  return {
    ...snapshot,
    categories: snapshot.categories.map(c => ({ ...c, products: c.products.filter(queda) })).filter(c => c.products.length > 0),
  }
}

/** El menú que viaja al proveedor: sólo los productos de la lista, sin pasillos vacíos. No muta el original. */
export function filtrarMenuDelCanal(snapshot: MenuSnapshot, productos: Set<string> | null): MenuSnapshot {
  if (!productos) return snapshot
  return soloLos(snapshot, p => productos.has(p.plu))
}

/**
 * El menú y los precios que viajan al proveedor, sacados de UNA sola copia del catálogo (Codex plan r3 #1: traducir los ids a
 * códigos en otra lectura dejaba una ventana para publicar otro producto con el código reusado). PURA.
 *  · Con `productoIds`: los productos de la copia cuyo id está en la lista. Sin ella: la lista vieja por código, como hoy.
 *  · Precios: con `precios.porProducto` o `precios.porExtra` (por id), `overrides` se arma SÓLO con ids y ESTA copia: el precio de
 *    cada producto publicado bajo el código que trae, y el de cada extra publicado bajo su `MOD-<id>` (estable). La `overrides`
 *    guardada (la copia por código) se ignora entera (Codex impl r2: compartir ese mapa entre productos y extras ponía precios en
 *    el artículo equivocado). Sin ninguno de los dos (canal viejo), los precios guardados viajan tal cual. `markupPercent` pasa igual.
 *  · La copia que devuelve no lleva `productId`: el payload y su huella no cambian para nadie.
 */
export function aplicarSeleccion(snapshot: MenuSnapshot, config: unknown): { snapshot: MenuSnapshot; precios: PreciosDeCanal | undefined } {
  const ids = idsDelCanal(config)
  const lista = ids && new Set(ids)
  const delCanal = lista
    ? soloLos(snapshot, p => p.productId !== undefined && lista.has(p.productId))
    : filtrarMenuDelCanal(snapshot, productosDelCanal(config))

  const sinId: MenuSnapshot = {
    ...delCanal,
    categories: delCanal.categories.map(c => ({ ...c, products: c.products.map(({ productId: _id, ...p }) => p) })),
  }

  const guardados = comoObjeto(config)?.precios
  const porProducto = comoObjeto(comoObjeto(guardados)?.porProducto)
  const porExtra = comoObjeto(comoObjeto(guardados)?.porExtra)
  if (!porProducto && !porExtra) return { snapshot: sinId, precios: guardados as PreciosDeCanal | undefined }

  const { porProducto: _p, porExtra: _e, overrides: _copia, ...resto } = guardados as Record<string, unknown>
  // Los valores se copian tal cual: el mapeador de cada proveedor ya ignora un precio que no es número finito ≥ 0.
  // Un producto cuyo código es literalmente el `MOD-<id>` de un extra comparte esa llave en el menú del proveedor (ya era así
  // antes de D1, fuera de alcance): ahí gana el precio del extra.
  const publicados = delCanal.categories.flatMap(c => c.products)
  const extras = new Set(publicados.flatMap(p => p.modifierGroups.flatMap(g => g.modifiers.map(m => m.plu))))
  const overrides: Record<string, number> = {}
  for (const p of publicados) {
    if (porProducto && p.productId !== undefined && Object.prototype.hasOwnProperty.call(porProducto, p.productId)) {
      overrides[p.plu] = porProducto[p.productId] as number
    }
  }
  for (const [id, precio] of Object.entries(porExtra ?? {})) if (extras.has(`MOD-${id}`)) overrides[`MOD-${id}`] = precio as number
  return { snapshot: sinId, precios: { ...resto, overrides } as PreciosDeCanal }
}

/** Al guardar `config.productos` (PATCH del canal). `undefined` = no lo tocaste; `null` = vuelve a todo el catálogo. */
export function validarProductosDelCanal(v: unknown): void {
  if (v === undefined || v === null) return
  const problema = problemaDeLaLista(v)
  if (problema) throw new ValidationError(problema)
}

/** Al guardar `config.productoIds` (PATCH del canal). `undefined` = no lo tocaste; `null` = sin lista por id. */
export function validarIdsDelCanal(v: unknown): void {
  if (v === undefined || v === null) return
  const problema = problemaDeLaLista(v, 'productoIds')
  if (problema) throw new ValidationError(problema)
}

/**
 * Para leer el canal (MCP): cuántos productos publica (`null` = todo el catálogo), y si la lista guardada no sirve. Nunca truena.
 * Con `productoIds` cuenta ésa (es la que manda); si no, la vieja por código.
 */
export function resumenDeProductos(config: unknown): { cuantos: number | null; problema?: string } {
  const c = comoObjeto(config)
  const llave = c?.productoIds !== undefined && c?.productoIds !== null ? 'productoIds' : 'productos'
  const lista = c?.[llave]
  if (lista === undefined || lista === null) return { cuantos: null }
  const problema = problemaDeLaLista(lista, llave)
  return problema
    ? { cuantos: null, problema: `${problema}: el menú de este canal no se publica hasta corregirla` }
    : { cuantos: new Set(lista as string[]).size }
}

/**
 * Lo que el dueño configuró y entra al menú publicado: listas, precios y horario del canal. Sirve para comprobar, con la fila
 * bloqueada, que la pasada no armó el menú con una copia vieja del canal (Codex r1 #2).
 */
export function seleccionDelCanal(config: unknown): string {
  const c = comoObjeto(config) ?? {}
  return JSON.stringify([c.productos ?? null, c.precios ?? null, c.deliveryHours ?? null, c.productoIds ?? null])
}

/**
 * La huella de lo que el dueño eligió para el canal (listas, precios, horario, agotar por inventario e impresión): sha256 de un
 * JSON CANÓNICO (llaves ordenadas en todos los niveles), así que el reenvío del mismo guardado con las llaves en otro orden da
 * la misma huella. Las llaves del sistema (revisión del menú, revisados, agotados) no entran. Nunca truena.
 */
export function huellaDeSeleccion(config: unknown): string {
  const c = comoObjeto(config) ?? {}
  const campos = [c.productoIds, c.productos, c.precios, c.deliveryHours, c.agotarPorInventario, c.impresion].map(v => v ?? null)
  return createHash('sha256').update(canonicalJson(campos)).digest('hex')
}
