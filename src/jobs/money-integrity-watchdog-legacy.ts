export const LEGACY_INVENTORY_NOTICE = 'VALE HISTÓRICO AUSENTE CON MOVIMIENTOS'

/**
 * Ventana retrospectiva investigada el 9-sep-2026 (ver docs/investigations/money-watchdog-2026-09-09-codex.md).
 * NO es la fecha de despliegue del outbox: la tabla ya existía el 14-ago. Estas ventas tienen
 * deducciones antiguas sin postingLineId. Eso amerita revisión histórica, no certificar que se
 * descontaron TODOS los ingredientes ni volver a descontarlos. El aviso permanece visible.
 */
const HISTORICAL_WINDOW_END_UTC = '2026-08-19 00:00:00'

/**
 * Alias interno y constante; no aceptar entrada del usuario. Timestamps de Prisma guardados en UTC.
 *
 * 🔴 El corte va como literal `TIMESTAMP '…'` INLINE y la ventana de 15 minutos como `BETWEEN`,
 * no como `>= … AND <= …`. No es estilo: `rawSqlDateBindGuard` prohíbe la forma
 * `"…At" <operador> ${…}` porque un `Date` de Prisma llega como `timestamptz` y Postgres lo
 * convierte con la zona de la SESIÓN antes de comparar — seis horas de corrimiento en la Mac
 * local. Aquí NO hay ningún bind: el corte es texto fijo del propio código y los dos lados de la
 * ventana son COLUMNAS, así que la guarda daba un falso positivo. Se escribe en la forma que no
 * lo provoca en vez de meter el archivo a una lista de excepciones que por diseño sólo encoge.
 * `BETWEEN` es inclusivo en los dos extremos, o sea exactamente el `>=` y el `<=` que sustituye.
 */
export function historicalStockMovementSql(o = 'o'): string {
  return `(
    ${o}.source = 'TPV'
    AND ${o}."createdAt" < TIMESTAMP '${HISTORICAL_WINDOW_END_UTC}'
    AND ${o}."completedAt" < TIMESTAMP '${HISTORICAL_WINDOW_END_UTC}'
    AND ${o}."updatedAt" < TIMESTAMP '${HISTORICAL_WINDOW_END_UTC}'
    AND (
      EXISTS (
        SELECT 1 FROM "InventoryMovement" im
        JOIN "Inventory" inv ON inv.id = im."inventoryId" AND inv."venueId" = ${o}."venueId"
        WHERE im.reference = ${o}.id AND im.type = 'SALE'
          AND im.quantity < 0 AND im."previousStock" > im."newStock"
          AND im."postingLineId" IS NULL
          AND im."createdAt" BETWEEN ${o}."completedAt" AND ${o}."completedAt" + INTERVAL '15 minutes'
          AND im."createdAt" < TIMESTAMP '${HISTORICAL_WINDOW_END_UTC}'
      )
      OR EXISTS (
        SELECT 1 FROM "RawMaterialMovement" rm
        WHERE rm.reference = ${o}.id AND rm."venueId" = ${o}."venueId" AND rm.type = 'USAGE'
          AND rm.quantity < 0 AND rm."previousStock" > rm."newStock"
          AND rm."postingLineId" IS NULL
          AND rm."createdAt" BETWEEN ${o}."completedAt" AND ${o}."completedAt" + INTERVAL '15 minutes'
          AND rm."createdAt" < TIMESTAMP '${HISTORICAL_WINDOW_END_UTC}'
      )
    )
  )`
}
