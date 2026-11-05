/**
 * D6 (4-nov-2026): caché en memoria del catálogo que bajan los POS (`GET /mobile/venues/:venueId/products`).
 *
 * Por qué: los POS piden el catálogo completo cada pocos minutos aunque no haya cambiado. Con La Galeterie (1,022 productos,
 * ~2.5 MB de respuesta) armarlo —Prisma + mapeo— retenía el hilo único del SERVIDOR 0.2–1 s cada vez, y en ese rato no
 * avanzaba ningún cobro de ningún negocio (47 avisos `[event-loop] hilo retenido` en 3 días).
 *
 * Cómo sabe que no cambió: `versionDelCatalogoMovil` le pregunta a Postgres por el `xmin` (la marca de la transacción que
 * escribió cada fila) de TODAS las filas que la respuesta lee: productos, categorías, inventario, familias y variantes,
 * modificadores y recetas. Cualquier INSERT/UPDATE/DELETE —por Prisma, por SQL a mano o por un trigger, ponga o no
 * `updatedAt`— cambia la huella. Una sola instancia (regla `una-sola-instancia.md`), sin Redis: memoria basta.
 *
 * Tope: por BYTES del JSON de cada catálogo, más un costo fijo por negocio (Codex r1 P2: contar productos dejaba pasar
 * descripciones enormes y catálogos vacíos sin límite). En memoria ocupa ~1.8× su JSON (medido: ~4.4 KB por producto contra
 * ~2.4 KB de JSON). Vida: la versión es la que manda; al guardar se sueltan los vencidos de todos los negocios.
 */
import prisma from '../../utils/prismaClient'

export const VIDA_DEL_CATALOGO_MS = 30 * 60_000
/** 32 MB de JSON ≈ 60 MB de memoria en el peor caso. Hoy La Galeterie, el catálogo más grande, pesa 2.5 MB. */
export const TOPE_DE_BYTES_EN_CACHE = 32 * 1024 * 1024
/** Lo que cuenta cada negocio aunque su catálogo esté vacío: acota el número de entradas a ~32 mil. */
export const COSTO_FIJO_POR_NEGOCIO = 1024

interface Entrada {
  version: string
  data: unknown[]
  guardadoEn: number
  bytes: number
}

const cache = new Map<string, Entrada>()
let bytesGuardados = 0

function soltar(venueId: string): void {
  const e = cache.get(venueId)
  if (!e) return
  bytesGuardados -= e.bytes
  cache.delete(venueId)
}

export function catalogoMovilCacheado(venueId: string, version: string, ahora = Date.now()): unknown[] | undefined {
  const e = cache.get(venueId)
  if (!e) return undefined
  if (e.version !== version || ahora - e.guardadoEn >= VIDA_DEL_CATALOGO_MS) {
    soltar(venueId)
    return undefined
  }
  return e.data
}

export function guardarCatalogoMovil(venueId: string, version: string, data: unknown[], ahora = Date.now()): void {
  soltar(venueId)
  for (const [id, e] of cache) if (ahora - e.guardadoEn >= VIDA_DEL_CATALOGO_MS) soltar(id)
  // Sólo al volver a armar (algo cambió): ~15 ms con el catálogo más grande, contra los 150+ ms de armarlo.
  const bytes = Buffer.byteLength(JSON.stringify(data)) + COSTO_FIJO_POR_NEGOCIO
  if (bytes > TOPE_DE_BYTES_EN_CACHE) return
  cache.set(venueId, { version, data, guardadoEn: ahora, bytes })
  bytesGuardados += bytes
  // El Map recuerda el orden de inserción: el primero es el que se guardó hace más tiempo.
  for (const masViejo of cache.keys()) {
    if (bytesGuardados <= TOPE_DE_BYTES_EN_CACHE) break
    soltar(masViejo)
  }
}

export function vaciarCacheDelCatalogoMovil(): void {
  cache.clear()
  bytesGuardados = 0
}

/**
 * La «versión» del catálogo de un negocio: huella (md5) de cada fila que la respuesta lee, como `tabla:id:xmin`, recorridas
 * por las mismas relaciones que el `include` de `listProducts` (no por `venueId`, para no perder una fila ligada de otro lado).
 * Fila por fila y no una suma: una transacción VIEJA que confirma después de otra más nueva puede dejar la misma suma de
 * `xmin` con precios distintos (Codex r1 P1, reproducido en la prueba de integración). Cada UPDATE le da a su fila un `xmin`
 * distinto del que tenía, así que cualquier cambio confirmado cambia la huella.
 * Los productos inactivos o borrados también cuentan: es un superconjunto, sólo puede dar de más un «cambió».
 *
 * Devuelve null si no se pudo leer: entonces se arma como antes y no se guarda nada.
 */
export async function versionDelCatalogoMovil(venueId: string): Promise<string | null> {
  try {
    const filas = await prisma.$queryRaw<Array<{ version: string }>>`
      WITH p AS (SELECT id, "categoryId", "productGroupId", xmin::text AS x FROM "Product" WHERE "venueId" = ${venueId}),
      vv AS (SELECT "productId" || '/' || "optionId" AS id, "optionId", "optionValueId", xmin::text AS x FROM "ProductVariantValue" WHERE "productId" IN (SELECT id FROM p)),
      pmg AS (SELECT id, "groupId", xmin::text AS x FROM "ProductModifierGroup" WHERE "productId" IN (SELECT id FROM p)),
      r AS (SELECT id, xmin::text AS x FROM "Recipe" WHERE "productId" IN (SELECT id FROM p)),
      rl AS (SELECT id, "rawMaterialId", xmin::text AS x FROM "RecipeLine" WHERE "recipeId" IN (SELECT id FROM r)),
      filas AS (
        SELECT 'p' AS t, id, x FROM p
        UNION ALL SELECT 'c', id, xmin::text FROM "MenuCategory" WHERE id IN (SELECT "categoryId" FROM p)
        UNION ALL SELECT 'i', id, xmin::text FROM "Inventory" WHERE "productId" IN (SELECT id FROM p)
        UNION ALL SELECT 'g', id, xmin::text FROM "ProductGroup" WHERE id IN (SELECT "productGroupId" FROM p)
        UNION ALL SELECT 'vv', id, x FROM vv
        UNION ALL SELECT 'o', id, xmin::text FROM "ProductGroupOption" WHERE id IN (SELECT "optionId" FROM vv)
        UNION ALL SELECT 'ov', id, xmin::text FROM "ProductGroupOptionValue" WHERE id IN (SELECT "optionValueId" FROM vv)
        UNION ALL SELECT 'pmg', id, x FROM pmg
        UNION ALL SELECT 'mg', id, xmin::text FROM "ModifierGroup" WHERE id IN (SELECT "groupId" FROM pmg)
        UNION ALL SELECT 'm', id, xmin::text FROM "Modifier" WHERE "groupId" IN (SELECT "groupId" FROM pmg)
        UNION ALL SELECT 'r', id, x FROM r
        UNION ALL SELECT 'rl', id, x FROM rl
        UNION ALL SELECT 'rm', id, xmin::text FROM "RawMaterial" WHERE id IN (SELECT "rawMaterialId" FROM rl)
      )
      SELECT md5(coalesce(string_agg(t || ':' || id || ':' || x, ',' ORDER BY t, id), '')) AS version FROM filas`
    const version = Array.isArray(filas) ? filas[0]?.version : undefined
    return typeof version === 'string' && version.length > 0 ? version : null
  } catch {
    return null
  }
}
