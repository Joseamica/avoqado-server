import { z } from 'zod'

/**
 * Id de un registro que YA existe en la base, para params/body que lo referencian.
 *
 * 🔴 No uses `z.string().cuid()` para ids de producto, categoría o inventario: exige que empiecen con «c»
 * y en producción hay registros que no (13-oct-2026: IQ con 273 productos y 9 categorías de ids al azar,
 * La Ribera con UUIDs, Mindform con `mf_inv_…`). El 400 llegaba al dashboard como un error genérico
 * («Error al generar etiquetas»). Los ids NUEVOS se siguen generando como cuid v1 (`AGENTS.md`).
 *
 * Sólo letras, números, `_` y `-`: nada de espacios, comillas ni barras.
 */
export const EXISTING_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export const existingId = (message = 'El identificador no es válido') => z.string().regex(EXISTING_ID_REGEX, { message })
