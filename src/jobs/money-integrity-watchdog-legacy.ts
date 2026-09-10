export const LEGACY_INVENTORY_NOTICE = 'VALE HISTÓRICO AUSENTE CON MOVIMIENTOS'

/**
 * Ventana retrospectiva investigada el 9-sep-2026 (ver docs/investigations/money-watchdog-2026-09-09-codex.md).
 * NO es la fecha de despliegue del outbox: la tabla ya existía el 14-ago. Estas ventas tienen
 * deducciones antiguas sin postingLineId. Eso amerita revisión histórica, no certificar que se
 * descontaron TODOS los ingredientes ni volver a descontarlos. El aviso permanece visible.
 */
const HISTORICAL_WINDOW_END_UTC = '2026-08-19 00:00:00'

/** Alias interno y constante; no aceptar entrada del usuario. Timestamps de Prisma guardados en UTC. */
export function historicalStockMovementSql(o = 'o'): string {
  const cutoff = `TIMESTAMP '${HISTORICAL_WINDOW_END_UTC}'`
  return `(
    ${o}.source = 'TPV'
    AND ${o}."createdAt" < ${cutoff}
    AND ${o}."completedAt" < ${cutoff}
    AND ${o}."updatedAt" < ${cutoff}
    AND (
      EXISTS (
        SELECT 1 FROM "InventoryMovement" im
        JOIN "Inventory" inv ON inv.id = im."inventoryId" AND inv."venueId" = ${o}."venueId"
        WHERE im.reference = ${o}.id AND im.type = 'SALE'
          AND im.quantity < 0 AND im."previousStock" > im."newStock"
          AND im."postingLineId" IS NULL
          AND im."createdAt" >= ${o}."completedAt"
          AND im."createdAt" <= ${o}."completedAt" + INTERVAL '15 minutes'
          AND im."createdAt" < ${cutoff}
      )
      OR EXISTS (
        SELECT 1 FROM "RawMaterialMovement" rm
        WHERE rm.reference = ${o}.id AND rm."venueId" = ${o}."venueId" AND rm.type = 'USAGE'
          AND rm.quantity < 0 AND rm."previousStock" > rm."newStock"
          AND rm."postingLineId" IS NULL
          AND rm."createdAt" >= ${o}."completedAt"
          AND rm."createdAt" <= ${o}."completedAt" + INTERVAL '15 minutes'
          AND rm."createdAt" < ${cutoff}
      )
    )
  )`
}
