import { Prisma, WasteItemType } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { ValidationError } from '../../errors/AppError'
import { utcTs } from '../../utils/sqlDates'

/**
 * Lectores de la merma (spec §4.4 y §4.6). Todo en PESOS 1:1 y filtrando por el `createdAt`
 * del servidor, como el resto del inventario.
 *
 * 🔴 La regla que impide contar dos veces: la merma es la SUMA de dos términos agregados por
 * separado, nunca un JOIN folio × movimientos (multiplicaría una declaración por cada lote):
 *   1. la declaración de cada folio `APPLIED` (`InventoryWasteReport`), y
 *   2. |movimiento| `SPOILAGE` / `LOSS` SIN `wasteReportId` — mermas viejas del dashboard y
 *      bajas del cron de caducidad, una vez, como hoy.
 * Un movimiento CON `wasteReportId` ya lo representa su folio y no se suma.
 *
 * Un costo desconocido NO es cero: la parte sin costo se reporta como cantidad «sin valorar»
 * y el costo total es `null` cuando nada tiene costo conocido.
 */

const PAGE_CAP = 200

export interface WastePage {
  page: number
  pageSize: number
  search?: string
  /** ISO 8601 con hora y zona (lo que valida el Zod de la ruta). Una fecha pelona se rechaza. */
  startDate?: string
  endDate?: string
}

/** Lo que el aparato descarga para elegir qué mermar. SIN existencias ni costos a propósito:
 *  `inventory:log-waste` no concede `inventory:read`. */
export interface WasteItem {
  itemType: WasteItemType
  itemId: string
  name: string
  sku: string
  unit: string
}

export interface WasteFilter {
  itemType?: WasteItemType
  itemId?: string
}

export interface WasteTotals {
  quantity: Prisma.Decimal
  /** Suma del costo CONOCIDO; `null` si ninguna parte tiene costo. */
  cost: Prisma.Decimal | null
  unvaluedQuantity: Prisma.Decimal
}

export interface WasteBreakdownRow extends WasteTotals {
  itemType: WasteItemType
  itemId: string
  name: string | null
  unit: string
}

function invalidPage(): ValidationError {
  return new ValidationError('Paginación inválida.', 'INVALID_WASTE_PAYLOAD')
}

/** El tope lo impone el servidor: un `pageSize` hostil se recorta, nunca se obedece. */
function pagination(page: number, requestedSize: number) {
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(requestedSize) || requestedSize < 1) {
    throw invalidPage()
  }
  const pageSize = Math.min(requestedSize, PAGE_CAP)
  const skip = (page - 1) * pageSize
  if (!Number.isSafeInteger(skip)) throw invalidPage()
  return { page, pageSize, skip }
}

function assertWindow(from: Date, to: Date): void {
  if (!(from instanceof Date) || !(to instanceof Date) || !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
    throw new ValidationError('Rango de fechas inválido.', 'INVALID_WASTE_PAYLOAD')
  }
}

/** ISO con hora y zona → instante. Una fecha sin hora ni zona (`2026-03-10`) no dice de qué día
 *  LOCAL se habla, y el runtime la leería en UTC: se rechaza en vez de adivinar. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(?:Z|[+-]\d{2}(?::?\d{2})?)$/i

function instant(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined
  const parsed = ISO_INSTANT.test(value) ? new Date(value) : null
  if (!parsed || !Number.isFinite(parsed.getTime())) {
    throw new ValidationError('La fecha debe llevar hora y zona horaria (ISO 8601).', 'INVALID_WASTE_PAYLOAD')
  }
  return parsed
}

/** Búsqueda normalizada: vacía o de puros espacios = sin filtro. */
function searchTerm(search: string | undefined): string | undefined {
  const trimmed = search?.trim()
  return trimmed ? trimmed : undefined
}

/** `%`, `_` y `\` que teclea el usuario se buscan literales, no como comodines (`\` es el escape por
 *  defecto de `LIKE`/`ILIKE` en Postgres). */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, ch => `\\${ch}`)
}

function likeContains(term: string): string {
  return `%${escapeLike(term)}%`
}

/**
 * Artículos elegibles del venue, con la MISMA regla que `logWaste` aplica en el POS:
 * ingredientes activos sin borrar y productos por CANTIDAD con inventario. La unidad sale igual
 * que la compara `logWaste` (`COALESCE(p.unit, 'UNIT')`), para que el aparato mande la correcta.
 */
function catalogSql(venueId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT 'RAW_MATERIAL'::text AS "itemType", r.id AS "itemId", r.name, r.sku, r.unit::text AS unit
    FROM "RawMaterial" r
    WHERE r."venueId" = ${venueId}
      AND r.active = TRUE
      AND r."deletedAt" IS NULL
    UNION ALL
    SELECT 'PRODUCT'::text, p.id, p.name, p.sku, COALESCE(p.unit::text, 'UNIT')
    FROM "Product" p
    INNER JOIN "Inventory" i ON i."productId" = p.id AND i."venueId" = p."venueId"
    WHERE p."venueId" = ${venueId}
      AND p.active = TRUE
      AND p."deletedAt" IS NULL
      AND p."trackInventory" = TRUE
      AND p."inventoryMethod" = 'QUANTITY'
  `
}

function catalogFilter(search: string | undefined): Prisma.Sql {
  if (!search) return Prisma.sql`TRUE`
  const pattern = likeContains(search)
  return Prisma.sql`(name ILIKE ${pattern} OR sku ILIKE ${pattern})`
}

export async function findWasteItem(venueId: string, itemType: WasteItemType, itemId: string): Promise<WasteItem | null> {
  const rows = await prisma.$queryRaw<WasteItem[]>`
    SELECT * FROM (${catalogSql(venueId)}) items
    WHERE "itemType" = ${itemType} AND "itemId" = ${itemId}
    LIMIT 1
  `
  return rows[0] ?? null
}

/** Catálogo paginado que el aparato recorre hasta `total`. Orden estable `(name, itemId, itemType)`:
 *  el par `(itemId, itemType)` es único, así que ninguna página repite ni salta. */
export async function listWasteItems(venueId: string, query: WastePage) {
  const { page, pageSize, skip } = pagination(query.page, query.pageSize)
  const filter = catalogFilter(searchTerm(query.search))

  // Conteo y página en la MISMA foto: el total que ve el aparato cuadra con lo que recorre.
  return prisma.$transaction(
    async tx => {
      const counts = await tx.$queryRaw<Array<{ total: number }>>`
        SELECT COUNT(*)::int AS total FROM (${catalogSql(venueId)}) items WHERE ${filter}
      `
      const items = await tx.$queryRaw<WasteItem[]>`
        SELECT * FROM (${catalogSql(venueId)}) items
        WHERE ${filter}
        ORDER BY name ASC, "itemId" ASC, "itemType" ASC
        LIMIT ${pageSize} OFFSET ${skip}
      `
      return { items, total: counts[0]?.total ?? 0, page, pageSize }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  )
}

/**
 * El libro de merma de la ventana: UNA fila por folio aplicado y UNA por movimiento legacy, con
 * `quantity` (positiva), `cost` (costo CONOCIDO, positivo o null) y `unvaluedQuantity`.
 *
 * Cantidad sin valorar de un folio — la cabecera no guarda la cantidad valorada, se DERIVA de
 * `costState`, que `logWaste` fija con esas mismas cantidades:
 *   KNOWN            → 0 (todo lo declarado salió con costo)
 *   NONE / UNKNOWN   → lo declarado entero (nada descontado, o descontado sin costo)
 *   PARTIAL producto → `unrecordedQuantity` (lo descontado lleva la foto del costo)
 *   PARTIAL insumo   → declarado − Σ|cantidad| de SUS movimientos con costo (los que salieron
 *                      de lotes). La cabecera no distingue «descontado por lote» de «ajuste
 *                      directo sin lote», así que se lee de los hijos por `wasteReportId` en una
 *                      subconsulta escalar: agrega por folio y no multiplica la fila.
 * Movimiento legacy: sin costo (`costImpact` / `unitCost` nulos) ⇒ toda su cantidad sin valorar.
 *
 * Acceso acotado por tenant (T9c, medido con EXPLAIN ANALYZE): cada rama legacy tiene su índice
 * PARCIAL con el predicado EXACTO de abajo — `RawMaterialMovement(venueId, createdAt)` y
 * `InventoryMovement(inventoryId, createdAt)`, ambos `WHERE type = … AND "wasteReportId" IS NULL`.
 * Por eso el tipo y el `IS NULL` van LITERALES: con un parámetro Postgres no puede probar que la
 * consulta cae dentro del predicado y no usa el índice.
 * `InventoryMovement` no tiene `venueId`: la rama de productos recorre los inventarios DEL VENUE y
 * baja a sus mermas por `LATERAL`. El `OFFSET 0` es una barrera deliberada: sin ella el planificador
 * aplana la subconsulta y, en ventanas largas, vuelve a un hash join sobre las `LOSS` de TODA la
 * plataforma (medido: 365 días, 4 k mermas del venue contra 12 k–410 k de la plataforma). Con ella
 * son N búsquedas por índice, N = inventarios del venue. ⚠️ Depende del índice parcial
 * `InventoryMovement_inventoryId_createdAt_waste_legacy_idx`: sin él, cada búsqueda recorre todos
 * los movimientos del inventario (medido: ~600 ms con 400 k movimientos en el venue).
 */
export function wasteLedgerSql(venueId: string, from: Date, to: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT r."itemType"::text AS "itemType",
           COALESCE(r."rawMaterialId", r."productId") AS "itemId",
           r.unit AS unit,
           r."declaredQuantity" AS quantity,
           r."costImpact" AS cost,
           CASE
             WHEN r."costState" = 'KNOWN' THEN 0
             WHEN r."costState" IN ('NONE', 'UNKNOWN') THEN r."declaredQuantity"
             WHEN r."itemType" = 'PRODUCT' THEN r."unrecordedQuantity"
             ELSE r."declaredQuantity" - COALESCE((
               SELECT SUM(ABS(c.quantity))
               FROM "RawMaterialMovement" c
               WHERE c."wasteReportId" = r.id
                 AND c."venueId" = r."venueId"
                 AND c."costImpact" IS NOT NULL
             ), 0)
           END AS "unvaluedQuantity"
    FROM "InventoryWasteReport" r
    WHERE r."venueId" = ${venueId}
      AND r.status = 'APPLIED'
      AND r."createdAt" >= ${utcTs(from)}
      AND r."createdAt" <= ${utcTs(to)}

    UNION ALL

    SELECT 'RAW_MATERIAL'::text, m."rawMaterialId", m.unit::text,
           ABS(m.quantity),
           ABS(m."costImpact"),
           CASE WHEN m."costImpact" IS NULL THEN ABS(m.quantity) ELSE 0 END
    FROM "RawMaterialMovement" m
    WHERE m."venueId" = ${venueId}
      AND m.type = 'SPOILAGE'
      AND m."wasteReportId" IS NULL
      AND m."createdAt" >= ${utcTs(from)}
      AND m."createdAt" <= ${utcTs(to)}

    UNION ALL

    SELECT 'PRODUCT'::text, p.id, COALESCE(p.unit::text, 'UNIT'),
           ABS(m.quantity),
           CASE WHEN m."unitCost" IS NULL THEN NULL ELSE ABS(m.quantity * m."unitCost") END,
           CASE WHEN m."unitCost" IS NULL THEN ABS(m.quantity) ELSE 0 END
    FROM "Product" p
    INNER JOIN "Inventory" i ON i."productId" = p.id AND i."venueId" = p."venueId"
    CROSS JOIN LATERAL (
      SELECT mv.quantity, mv."unitCost"
      FROM "InventoryMovement" mv
      WHERE mv."inventoryId" = i.id
        AND mv.type = 'LOSS'
        AND mv."wasteReportId" IS NULL
        AND mv."createdAt" >= ${utcTs(from)}
        AND mv."createdAt" <= ${utcTs(to)}
      OFFSET 0
    ) m
    WHERE p."venueId" = ${venueId}
      AND i."venueId" = ${venueId}
  `
}

function ledgerFilter(filter?: WasteFilter): Prisma.Sql {
  return Prisma.sql`
    TRUE
    ${filter?.itemType ? Prisma.sql`AND "itemType" = ${filter.itemType}` : Prisma.empty}
    ${filter?.itemId ? Prisma.sql`AND "itemId" = ${filter.itemId}` : Prisma.empty}
  `
}

export async function getWasteTotals(venueId: string, from: Date, to: Date, filter?: WasteFilter): Promise<WasteTotals> {
  assertWindow(from, to)
  const rows = await prisma.$queryRaw<WasteTotals[]>`
    SELECT COALESCE(SUM(quantity), 0) AS quantity,
           SUM(cost) AS cost,
           COALESCE(SUM("unvaluedQuantity"), 0) AS "unvaluedQuantity"
    FROM (${wasteLedgerSql(venueId, from, to)}) ledger
    WHERE ${ledgerFilter(filter)}
  `
  return (
    rows[0] ?? {
      quantity: new Prisma.Decimal(0),
      cost: null,
      unvaluedQuantity: new Prisma.Decimal(0),
    }
  )
}

/** Merma por artículo (y unidad), paginada con `total`. Orden estable: `(itemType, itemId, unit)`
 *  identifica el grupo, así que el desempate es único. */
export async function getWasteBreakdown(venueId: string, from: Date, to: Date, requestedLimit = 100, offset = 0, filter?: WasteFilter) {
  assertWindow(from, to)
  if (!Number.isSafeInteger(offset) || offset < 0) throw invalidPage()
  const { pageSize: limit } = pagination(1, requestedLimit)
  const grouped = Prisma.sql`
    SELECT "itemType", "itemId", unit,
           SUM(quantity) AS quantity,
           SUM(cost) AS cost,
           SUM("unvaluedQuantity") AS "unvaluedQuantity"
    FROM (${wasteLedgerSql(venueId, from, to)}) ledger
    WHERE ${ledgerFilter(filter)}
    GROUP BY "itemType", "itemId", unit
  `

  return prisma.$transaction(
    async tx => {
      const counts = await tx.$queryRaw<Array<{ total: number }>>`
        SELECT COUNT(*)::int AS total FROM (${grouped}) grouped
      `
      const items = await tx.$queryRaw<WasteBreakdownRow[]>`
        SELECT g."itemType", g."itemId", g.unit, g.quantity, g.cost, g."unvaluedQuantity",
               COALESCE(r.name, p.name) AS name
        FROM (${grouped}) g
        LEFT JOIN "RawMaterial" r
          ON g."itemType" = 'RAW_MATERIAL' AND r.id = g."itemId" AND r."venueId" = ${venueId}
        LEFT JOIN "Product" p
          ON g."itemType" = 'PRODUCT' AND p.id = g."itemId" AND p."venueId" = ${venueId}
        ORDER BY name ASC, g."itemId" ASC, g."itemType" ASC, g.unit ASC
        LIMIT ${limit} OFFSET ${offset}
      `
      return { items, total: counts[0]?.total ?? 0, limit, offset }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  )
}

/** Folios aplicados (incluidas las declaraciones que no pudieron descontar nada), más recientes
 *  primero, desempate por id. Las lápidas `VOIDED` no son merma y no salen. */
export async function listWasteReports(venueId: string, query: WastePage) {
  const { page, pageSize, skip } = pagination(query.page, query.pageSize)
  const startDate = instant(query.startDate)
  const endDate = instant(query.endDate)
  // `contains` de Prisma arma `%término%` SIN escapar (medido en 6.19): se le pasa ya escapado, igual que
  // al catálogo, para que buscar `%` no devuelva todos los folios del venue.
  const search = searchTerm(query.search)
  const pattern = search === undefined ? undefined : escapeLike(search)

  const where: Prisma.InventoryWasteReportWhereInput = {
    venueId,
    status: 'APPLIED',
    ...(startDate || endDate ? { createdAt: { gte: startDate, lte: endDate } } : {}),
    ...(pattern
      ? {
          OR: [
            { rawMaterial: { name: { contains: pattern, mode: 'insensitive' } } },
            { rawMaterial: { sku: { contains: pattern, mode: 'insensitive' } } },
            { product: { name: { contains: pattern, mode: 'insensitive' } } },
            { product: { sku: { contains: pattern, mode: 'insensitive' } } },
          ],
        }
      : {}),
  }

  return prisma.$transaction(
    async tx => {
      const total = await tx.inventoryWasteReport.count({ where })
      const items = await tx.inventoryWasteReport.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          itemType: true,
          rawMaterialId: true,
          productId: true,
          unit: true,
          reasonCode: true,
          declaredQuantity: true,
          deductedQuantity: true,
          unrecordedQuantity: true,
          costImpact: true,
          costState: true,
          unitCostSnapshot: true,
          note: true,
          reference: true,
          supplier: true,
          source: true,
          createdAt: true,
          clientOccurredAt: true,
          reportedByStaffId: true,
          reportedByStaff: { select: { firstName: true, lastName: true } },
          rawMaterial: { select: { name: true, sku: true } },
          product: { select: { name: true, sku: true } },
        },
      })
      return { items, total, page, pageSize }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  )
}
