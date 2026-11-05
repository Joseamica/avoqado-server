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
 * `updatedAt`— cambia la suma o el conteo. Una sola instancia (regla `una-sola-instancia.md`), sin Redis: memoria basta.
 *
 * Tope: por PRODUCTOS guardados (≈4.4 KB de memoria cada uno, medido), no por negocios. Vida: la versión es la que manda;
 * la vida sólo suelta a los negocios que ya no preguntan.
 */
import prisma from '../../utils/prismaClient'

export const VIDA_DEL_CATALOGO_MS = 30 * 60_000
/** ~90 MB en el peor caso. Hoy, todos los catálogos de producción juntos suman ~2,000 productos. */
export const TOPE_DE_PRODUCTOS_EN_CACHE = 20_000

interface Entrada {
  version: string
  data: unknown[]
  guardadoEn: number
}

const cache = new Map<string, Entrada>()
let productosGuardados = 0

function soltar(venueId: string): void {
  const e = cache.get(venueId)
  if (!e) return
  productosGuardados -= e.data.length
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
  if (data.length > TOPE_DE_PRODUCTOS_EN_CACHE) return
  cache.set(venueId, { version, data, guardadoEn: ahora })
  productosGuardados += data.length
  // El Map recuerda el orden de inserción: el primero es el que se guardó hace más tiempo.
  for (const masViejo of cache.keys()) {
    if (productosGuardados <= TOPE_DE_PRODUCTOS_EN_CACHE) break
    soltar(masViejo)
  }
}

export function vaciarCacheDelCatalogoMovil(): void {
  cache.clear()
  productosGuardados = 0
}

/**
 * La «versión» del catálogo de un negocio: conteo y suma de `xmin` de cada tabla que la respuesta lee, recorridas por las
 * mismas relaciones que el `include` de `listProducts` (no por `venueId`, para no perder una fila ligada de otro lado).
 * Los productos inactivos o borrados también cuentan: es un superconjunto, sólo puede dar de más un «cambió».
 *
 * Devuelve null si no se pudo leer: entonces se arma como antes y no se guarda nada.
 */
export async function versionDelCatalogoMovil(venueId: string): Promise<string | null> {
  try {
    const filas = await prisma.$queryRaw<Array<{ version: string }>>`
      WITH p AS (SELECT id, "categoryId", "productGroupId", xmin::text::bigint AS x FROM "Product" WHERE "venueId" = ${venueId}),
      vv AS (SELECT "optionId", "optionValueId", xmin::text::bigint AS x FROM "ProductVariantValue" WHERE "productId" IN (SELECT id FROM p)),
      pmg AS (SELECT "groupId", xmin::text::bigint AS x FROM "ProductModifierGroup" WHERE "productId" IN (SELECT id FROM p)),
      r AS (SELECT id, xmin::text::bigint AS x FROM "Recipe" WHERE "productId" IN (SELECT id FROM p)),
      rl AS (SELECT "rawMaterialId", xmin::text::bigint AS x FROM "RecipeLine" WHERE "recipeId" IN (SELECT id FROM r))
      SELECT concat_ws('|',
        (SELECT count(*) || ':' || coalesce(sum(x), 0) FROM p),
        (SELECT count(*) || ':' || coalesce(sum(xmin::text::bigint), 0) FROM "MenuCategory" WHERE id IN (SELECT "categoryId" FROM p)),
        (SELECT count(*) || ':' || coalesce(sum(xmin::text::bigint), 0) FROM "Inventory" WHERE "productId" IN (SELECT id FROM p)),
        (SELECT count(*) || ':' || coalesce(sum(xmin::text::bigint), 0) FROM "ProductGroup" WHERE id IN (SELECT "productGroupId" FROM p)),
        (SELECT count(*) || ':' || coalesce(sum(x), 0) FROM vv),
        (SELECT count(*) || ':' || coalesce(sum(xmin::text::bigint), 0) FROM "ProductGroupOption" WHERE id IN (SELECT "optionId" FROM vv)),
        (SELECT count(*) || ':' || coalesce(sum(xmin::text::bigint), 0) FROM "ProductGroupOptionValue" WHERE id IN (SELECT "optionValueId" FROM vv)),
        (SELECT count(*) || ':' || coalesce(sum(x), 0) FROM pmg),
        (SELECT count(*) || ':' || coalesce(sum(xmin::text::bigint), 0) FROM "ModifierGroup" WHERE id IN (SELECT "groupId" FROM pmg)),
        (SELECT count(*) || ':' || coalesce(sum(xmin::text::bigint), 0) FROM "Modifier" WHERE "groupId" IN (SELECT "groupId" FROM pmg)),
        (SELECT count(*) || ':' || coalesce(sum(x), 0) FROM r),
        (SELECT count(*) || ':' || coalesce(sum(x), 0) FROM rl),
        (SELECT count(*) || ':' || coalesce(sum(xmin::text::bigint), 0) FROM "RawMaterial" WHERE id IN (SELECT "rawMaterialId" FROM rl))
      ) AS version`
    const version = Array.isArray(filas) ? filas[0]?.version : undefined
    return typeof version === 'string' && version.length > 0 ? version : null
  } catch {
    return null
  }
}
