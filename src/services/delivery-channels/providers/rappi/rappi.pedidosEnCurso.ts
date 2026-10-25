/**
 * Rappi fase 3 — lo que el panel necesita para decidir si una tienda se puede desconectar: QUÉ conexión vio el dueño y
 * cuántos pedidos de Rappi siguen vivos en ella. Aparte de `rappi.desconectar` para que el listado de canales lo use sin
 * importar el servicio de desconexión (que a su vez lee el `select` seguro del listado).
 */
import { DeliveryProvider, Prisma, PrismaClient } from '@prisma/client'

import { utcTs } from '@/utils/sqlDates'

import { configComoObjeto } from '../../core/llavesDelSistema'
import { RAPPI_EVENTS } from './rappi.adapter'

/** La ventana en que un pedido sin terminar todavía cuenta: uno olvidado (nadie lo terminó ni lo canceló) deja de frenar. */
export const VENTANA_PEDIDOS_EN_CURSO_MS = 24 * 60 * 60 * 1000

/**
 * La conexión que el dueño ve en pantalla. Cambia si reconecta por OAuth (otro `intentId`) o si un SUPERADMIN cambia la
 * tienda de un vínculo manual. El panel la manda de vuelta al desconectar: si ya no es la misma, no se desconecta nada.
 */
export function conexionIdDe(link: { config: unknown; externalLocationId: string }): string {
  const aprov = configComoObjeto(configComoObjeto(link.config).rappiProvisioning)
  const intentId = typeof aprov.intentId === 'string' && aprov.intentId ? aprov.intentId : 'manual'
  return `${intentId}:${link.externalLocationId}`
}

/**
 * Pedidos de Rappi en curso por vínculo, en UNA sentencia (una sola foto de la base), de las últimas 24 h:
 *   (a) órdenes del vínculo que no están terminadas, canceladas ni borradas, y
 *   (b) avisos de pedido nuevo del vínculo todavía sin orden y VIVOS con el mismo predicado del procesador (no PROCESSED ni
 *       DUPLICATE, y sin un error terminal): aceptaciones en vuelo y aceptadas sin registrar.
 * La orden se confirma ANTES de que su aviso reciba el `orderId`, así que la foto ve siempre al menos uno de los dos; y un aviso
 * cuyo pedido ya tiene orden (`Order.externalId` = `RAPPI:<pedido>`, el folio de la ingesta) no se cuenta otra vez.
 */
export async function contarPedidosEnCurso(db: Prisma.TransactionClient | PrismaClient, linkIds: string[]): Promise<Map<string, number>> {
  const conteo = new Map<string, number>()
  if (linkIds.length === 0) return conteo
  // Perezoso: el procesador es pesado y este módulo lo carga el listado de canales.
  const { ERRORES_TERMINALES } = await import('./rappi.eventProcessor')
  const desde = new Date(Date.now() - VENTANA_PEDIDOS_EN_CURSO_MS)
  const filas = await db.$queryRaw<Array<{ linkId: string; n: number }>>`
    SELECT l.id AS "linkId",
      (SELECT COUNT(*)::int FROM "Order" o
        WHERE o."deliveryChannelLinkId" = l.id
          AND o.status NOT IN ('COMPLETED', 'CANCELLED', 'DELETED')
          AND o."createdAt" >= ${utcTs(desde)})
      + (SELECT COUNT(*)::int FROM "DeliveryOrderEvent" e
        WHERE e."channelLinkId" = l.id
          AND e.provider = ${DeliveryProvider.RAPPI}::"DeliveryProvider"
          AND e."eventType" = ${RAPPI_EVENTS.NEW_ORDER}
          AND e."orderId" IS NULL
          AND e."receivedAt" >= ${utcTs(desde)}
          AND e.status NOT IN ('PROCESSED', 'DUPLICATE')
          AND (e.error IS NULL OR e.error NOT IN (${Prisma.join([...ERRORES_TERMINALES])}))
          -- El mismo pedido ya tiene su orden EN ESTA tienda (la ingesta la confirma antes de cerrar el aviso): ya contó arriba.
          AND NOT EXISTS (SELECT 1 FROM "Order" o2
            WHERE o2."venueId" = l."venueId" AND o2."externalId" = ${`${DeliveryProvider.RAPPI}:`} || e."externalOrderId"
              AND o2."deliveryChannelLinkId" = l.id)) AS n
    FROM "DeliveryChannelLink" l
    WHERE l.id IN (${Prisma.join(linkIds)})`
  for (const f of filas) conteo.set(f.linkId, f.n)
  return conteo
}
