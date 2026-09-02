import { Prisma, type PrismaClient } from '@prisma/client'
import { utcTs } from '../../utils/sqlDates'

/**
 * Criterio ÚNICO de «orden cobrada que sigue abierta». Lo consumen el barrido
 * (`paid-order-reconciler.job.ts`) y el vigilante de dinero (check #5): si alguna vez
 * divergen, uno de los dos miente. Caso semilla: ORD-1788276418170 (Testarudo, 1-sep-2026).
 *
 * Reglas:
 *  - la orden no está en estado terminal;
 *  - la suma de sus cobros COMPLETED (los REFUND son negativos y restan) cubre la base
 *    sin propina, `max(0, subtotal − descuento)`, con un centavo de tolerancia;
 *  - existe al menos un cobro REGULAR o FAST positivo — así una cuenta de $0 sin cobro
 *    (cortesía total) NO se marca pagada: ésa la cierra el cajero cobrando $0.
 */
export function criterioPagadaPeroAbiertaSql(alias = 'o'): string {
  const o = alias
  return `
    ${o}.status NOT IN ('COMPLETED', 'CANCELLED', 'DELETED')
    AND EXISTS (
      SELECT 1 FROM "Payment" p
      WHERE p."orderId" = ${o}.id AND p.status = 'COMPLETED'
        AND p.type IN ('REGULAR', 'FAST') AND p.amount > 0
    )
    AND (
      SELECT COALESCE(SUM(p.amount), 0) FROM "Payment" p
      WHERE p."orderId" = ${o}.id AND p.status = 'COMPLETED'
    ) >= GREATEST(0, ${o}.subtotal - COALESCE(${o}."discountAmount", 0)) - 0.01`
}

export interface CandidataPagadaAbierta {
  id: string
  venueId: string
  orderNumber: string
  status: string
  paymentStatus: string
  base: string
  pagado: string
  paymentIds: string[]
}

type Db = Pick<PrismaClient, '$queryRaw'> | Pick<Prisma.TransactionClient, '$queryRaw'>

/** Candidatas, del más viejo al más nuevo, sin tocar órdenes actualizadas hace menos de `graceMs`. */
export async function findPaidButOpenOrders(
  db: Db,
  opts: { graceMs: number; limit: number; now?: Date },
): Promise<CandidataPagadaAbierta[]> {
  const now = opts.now ?? new Date()
  const antesDe = new Date(now.getTime() - opts.graceMs)
  // `$queryRaw` con template: sólo los valores van parametrizados; el fragmento es texto fijo.
  const rows = await db.$queryRaw<CandidataPagadaAbierta[]>`
    SELECT o.id, o."venueId", o."orderNumber", o.status::text AS status, o."paymentStatus"::text AS "paymentStatus",
           GREATEST(0, o.subtotal - COALESCE(o."discountAmount", 0))::text AS base,
           (SELECT COALESCE(SUM(p.amount), 0) FROM "Payment" p WHERE p."orderId" = o.id AND p.status = 'COMPLETED')::text AS pagado,
           ARRAY(SELECT p.id FROM "Payment" p WHERE p."orderId" = o.id AND p.status = 'COMPLETED' ORDER BY p."createdAt") AS "paymentIds"
    FROM "Order" o
    WHERE ${Prisma.raw(criterioPagadaPeroAbiertaSql('o'))}
      AND o."updatedAt" < ${utcTs(antesDe)}
    ORDER BY o."createdAt" ASC
    LIMIT ${opts.limit}
  `
  return rows
}
