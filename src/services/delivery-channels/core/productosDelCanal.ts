/**
 * Qué productos publica un canal de delivery: `DeliveryChannelLink.config.productos`, una lista de SKU.
 *
 * 🔴 Por qué existe (Testarudo, 12-nov-2026): en Rappi vende 40 productos y su catálogo de Avoqado tiene 111
 * (cervezas, vinos, esculturas, flores, eventos). Sin lista, el sincronizador subía el catálogo ENTERO. Ausente o
 * `null` = todo el catálogo activo, que es lo de siempre.
 *
 * 🔴 Una lista mal escrita (no es lista, vacía, con algo que no es un SKU) TRUENA al leerla: nunca se lee como
 * «todo» (subiría lo que el negocio no quiere vender ahí) ni como «nada» (un menú vacío BORRA el de Uber, que
 * reemplaza el menú entero). El sincronizador la atrapa como FAILED y no publica. Al guardar se valida igual.
 */
import { ValidationError } from '../../../errors/AppError'
import type { MenuSnapshot } from './menuSnapshot.service'

/** Tope de SKU por canal: muy por encima de un menú real (Rappi acepta pocos cientos por pasillo). */
const MAX_PRODUCTOS = 5000

/** El motivo de por qué la lista no sirve, o `null` si sirve. Lo comparten la lectura y el guardado. */
function problemaDeLaLista(v: unknown): string | null {
  if (!Array.isArray(v)) return '`productos` debe ser una lista de SKU (o null para publicar todo el catálogo)'
  if (v.length === 0) return 'La lista de productos del canal necesita al menos un producto (o null para publicar todo el catálogo)'
  if (v.length > MAX_PRODUCTOS) return `La lista de productos del canal admite hasta ${MAX_PRODUCTOS} SKU`
  if (v.some(sku => typeof sku !== 'string' || sku.trim() === '')) return 'Cada producto del canal debe ser un SKU (texto no vacío)'
  return null
}

/** Los SKU que publica el canal, o `null` = todo el catálogo. Truena si la lista guardada no sirve. */
export function productosDelCanal(config: unknown): Set<string> | null {
  const lista = config && typeof config === 'object' && !Array.isArray(config) ? (config as { productos?: unknown }).productos : undefined
  if (lista === undefined || lista === null) return null
  const problema = problemaDeLaLista(lista)
  if (problema) throw new Error(`config.productos inválido: ${problema}`)
  return new Set(lista as string[])
}

/** El menú que viaja al proveedor: sólo los productos de la lista, sin pasillos vacíos. No muta el original. */
export function filtrarMenuDelCanal(snapshot: MenuSnapshot, productos: Set<string> | null): MenuSnapshot {
  if (!productos) return snapshot
  return {
    ...snapshot,
    categories: snapshot.categories
      .map(c => ({ ...c, products: c.products.filter(p => productos.has(p.plu)) }))
      .filter(c => c.products.length > 0),
  }
}

/** Al guardar `config.productos` (PATCH del canal). `undefined` = no lo tocaste; `null` = vuelve a todo el catálogo. */
export function validarProductosDelCanal(v: unknown): void {
  if (v === undefined || v === null) return
  const problema = problemaDeLaLista(v)
  if (problema) throw new ValidationError(problema)
}

/** Para leer el canal (MCP): cuántos productos publica (`null` = todo el catálogo), y si la lista guardada no sirve. Nunca truena. */
export function resumenDeProductos(config: unknown): { cuantos: number | null; problema?: string } {
  const lista = config && typeof config === 'object' && !Array.isArray(config) ? (config as { productos?: unknown }).productos : undefined
  if (lista === undefined || lista === null) return { cuantos: null }
  const problema = problemaDeLaLista(lista)
  return problema
    ? { cuantos: null, problema: `${problema}: el menú de este canal no se publica hasta corregirla` }
    : { cuantos: new Set(lista as string[]).size }
}
