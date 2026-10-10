import { createHash } from 'crypto'
import { OrderStatus, Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { ESTADOS_FUERA_DE_LA_MESA } from '../shared/cuentaEnLaMesa'

/**
 * «¿Cambió algo?» barato para el plano del POS (spec docs/superpowers/specs/2026-10-09-plano-de-mesas-pos-design.md §3.1).
 *
 * - `tablesVersion`: mesas ACTIVAS del venue + cuentas que `/tables` puede pintar (vivas con `tableId`, más las apuntadas
 *   por `Table.currentOrderId` de una mesa activa) + el switch `VenueSettings.enforceTableOwnership`.
 * - `floorPlanVersion`: áreas del venue + elementos ACTIVOS del plano.
 *
 * Cada escritura de Prisma (también `updateMany`) sube `updatedAt`. Se SUMA (en ms), no se toma el máximo: Prisma pone
 * `updatedAt` al escribir y no al confirmar, así que una transacción que confirma tarde puede traer un `updatedAt` menor
 * que el máximo ya visto; la suma cambia igual. Entrar o salir del conjunto (cobrar, cerrar, anular, archivar) mueve el
 * `count`. Límite declarado: un cambio sólo en datos anidados (el nombre de un producto o de un mesero), un permiso por
 * mesero (`viewer.canManageAllTables`) o un UPDATE crudo que no toque `updatedAt` no la mueve; la consulta completa al
 * entrar a la pantalla y el botón de refrescar lo cubren.
 *
 * 🔴 Quien devuelve esta versión JUNTO con datos la calcula ANTES de leerlos: una versión vieja con datos nuevos sólo
 * cuesta una consulta de más; una versión nueva con datos viejos dejaría al mesero viendo lo viejo en silencio.
 */
export interface TablesVersions {
  tablesVersion: string
  floorPlanVersion: string
}

/** Los `*Sum` son la suma de `updatedAt` en ms, como TEXTO exacto (un `bigint` sumado no cabe sin pérdida en un `number`). */
export interface TablesVersionRow {
  tableCount: number
  tableSum: string
  orderCount: number
  orderSum: string
  areaCount: number
  areaSum: string
  elementCount: number
  elementSum: string
  ownershipRule: boolean
}

/** Cuánto se reusa una versión ya calculada para el mismo venue: 4 aparatos en el mismo segundo = 1 consulta. */
export const TABLES_VERSION_CACHE_MS = 1500
/** Con más venues que esto se tiran las entradas vencidas; el caché nunca crece sin límite. */
const MAX_CACHED_VENUES = 500

type Db = Prisma.TransactionClient | typeof prisma

/**
 * Los estados con los que una cuenta SIGUE en la mesa: el enum menos `ESTADOS_FUERA_DE_LA_MESA`. Derivado del enum (un
 * estado nuevo entra solo) y usado con `IN`, no `NOT IN`: así Postgres usa `Order(venueId, status, createdAt)` y lee sólo
 * las cuentas vivas, no todo el historial del venue.
 */
export const ESTADOS_EN_LA_MESA: OrderStatus[] = Object.values(OrderStatus).filter(
  s => !(ESTADOS_FUERA_DE_LA_MESA as readonly string[]).includes(s),
)

const ESTADOS_EN_LA_MESA_SQL = Prisma.join(ESTADOS_EN_LA_MESA.map(s => Prisma.sql`CAST(${s} AS "OrderStatus")`))

/** Suma exacta de `updatedAt` en milisegundos, como texto (0 si no hay filas). */
const SUMA_MS = (col: Prisma.Sql) => Prisma.sql`COALESCE(SUM((EXTRACT(EPOCH FROM ${col}) * 1000)::bigint), 0)::text`

/**
 * UNA consulta con cinco agregados, cada uno sobre un índice que empieza por `venueId` (`Table @@index([venueId])`,
 * `Order @@index([venueId, status, createdAt])`, `Table.currentOrderId @unique`, `Area @@unique([venueId, name])`,
 * `FloorElement @@index([venueId])`, `VenueSettings.venueId @unique`). Exportada para que la prueba de integración la mida
 * con EXPLAIN.
 */
export function tablesVersionSql(venueId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT t.c AS "tableCount", t.s AS "tableSum",
           o.c AS "orderCount", o.s AS "orderSum",
           a.c AS "areaCount", a.s AS "areaSum",
           e.c AS "elementCount", e.s AS "elementSum",
           r.v AS "ownershipRule"
    FROM (SELECT COUNT(*)::int AS c, ${SUMA_MS(Prisma.sql`"updatedAt"`)} AS s FROM "Table"
          WHERE "venueId" = ${venueId} AND "active" = true) t
    CROSS JOIN (SELECT COUNT(*)::int AS c, ${SUMA_MS(Prisma.sql`x."updatedAt"`)} AS s FROM (
                  SELECT ord.id, ord."updatedAt" FROM "Order" ord
                  WHERE ord."venueId" = ${venueId} AND ord."tableId" IS NOT NULL AND ord."status" IN (${ESTADOS_EN_LA_MESA_SQL})
                  UNION
                  SELECT ord.id, ord."updatedAt" FROM "Table" tb JOIN "Order" ord ON ord.id = tb."currentOrderId"
                  WHERE tb."venueId" = ${venueId} AND tb."active" = true
                ) x) o
    CROSS JOIN (SELECT COUNT(*)::int AS c, ${SUMA_MS(Prisma.sql`"updatedAt"`)} AS s FROM "Area"
                WHERE "venueId" = ${venueId}) a
    CROSS JOIN (SELECT COUNT(*)::int AS c, ${SUMA_MS(Prisma.sql`"updatedAt"`)} AS s FROM "FloorElement"
                WHERE "venueId" = ${venueId} AND "active" = true) e
    CROSS JOIN (SELECT COALESCE((SELECT vs."enforceTableOwnership" FROM "VenueSettings" vs
                                 WHERE vs."venueId" = ${venueId}), false) AS v) r`
}

/** sha256 de las piezas, recortado a 16 hex (la misma longitud que la huella del plano del dashboard). */
export function versionHash(parts: ReadonlyArray<string | number | boolean | null>): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16)
}

export function versionsFromRow(row: TablesVersionRow): TablesVersions {
  return {
    tablesVersion: versionHash([
      'mesas',
      row.tableCount,
      String(row.tableSum),
      'cuentas',
      row.orderCount,
      String(row.orderSum),
      'propiedad',
      row.ownershipRule === true,
    ]),
    floorPlanVersion: versionHash(['areas', row.areaCount, String(row.areaSum), 'elementos', row.elementCount, String(row.elementSum)]),
  }
}

const EMPTY_ROW: TablesVersionRow = {
  tableCount: 0,
  tableSum: '0',
  orderCount: 0,
  orderSum: '0',
  areaCount: 0,
  areaSum: '0',
  elementCount: 0,
  elementSum: '0',
  ownershipRule: false,
}

/** La versión tal como está en la base, sin caché. */
export async function readTablesVersions(venueId: string, db: Db = prisma): Promise<TablesVersions> {
  const rows = await db.$queryRaw<TablesVersionRow[]>(tablesVersionSql(venueId))
  return versionsFromRow(rows[0] ?? EMPTY_ROW)
}

/**
 * Caché en memoria del proceso. Producción corre UNA instancia (`.claude/rules/una-sola-instancia.md`); con varias, cada
 * una tendría su caché de 1.5 s y seguiría siendo correcto: nunca contesta algo más viejo que 1.5 s.
 */
const cache = new Map<string, { at: number; value: Promise<TablesVersions> }>()

/** La versión con caché de 1.5 s; las preguntas simultáneas del mismo venue comparten la misma consulta. */
export function computeTablesVersions(venueId: string, nowMs: number = Date.now()): Promise<TablesVersions> {
  const hit = cache.get(venueId)
  if (hit && nowMs - hit.at < TABLES_VERSION_CACHE_MS) return hit.value
  if (cache.size >= MAX_CACHED_VENUES) {
    for (const [key, entry] of cache) if (nowMs - entry.at >= TABLES_VERSION_CACHE_MS) cache.delete(key)
    if (cache.size >= MAX_CACHED_VENUES) cache.clear()
  }
  const value = readTablesVersions(venueId)
  const entry = { at: nowMs, value }
  cache.set(venueId, entry)
  // Un fallo no se queda pegado: la siguiente pregunta vuelve a la base.
  value.catch(() => {
    if (cache.get(venueId) === entry) cache.delete(venueId)
  })
  return value
}

/** Sólo pruebas. */
export function clearTablesVersionCache(): void {
  cache.clear()
}
