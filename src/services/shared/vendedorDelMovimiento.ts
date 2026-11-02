import { Prisma } from '@prisma/client'

/**
 * D2/D4 (Codex r4 A3 de pedidos en línea): a quién pertenece un movimiento en las VENTAS por persona. Alias `p` para el Payment y `o`
 * para su cobro original (`SQL_COBRO_ORIGINAL_DE_LA_DEVOLUCION`, misma tienda): el cobro es de quien lo hizo; la devolución, de quien
 * hizo la venta que devuelve (NULL si fue un cobro web sin vendedor: no es de nadie). Lo usan el checador, el mapa de ventas por
 * persona y el avance de las metas de venta. El EFECTIVO por persona no lo usa: sigue con quien entregó el dinero.
 */
export const SQL_VENDEDOR_DEL_MOVIMIENTO = Prisma.sql`(CASE WHEN p."type" = 'REFUND' THEN o."processedById" ELSE p."processedById" END)`

/** El cobro original de una devolución (alias `o`), en la misma tienda; `NULL` para los cobros. */
export const SQL_COBRO_ORIGINAL_DE_LA_DEVOLUCION = Prisma.sql`LEFT JOIN "Payment" o ON p."type" = 'REFUND' AND o."id" = p."processorData"->>'originalPaymentId' AND o."venueId" = p."venueId"`
