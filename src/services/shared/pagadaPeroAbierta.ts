import { Prisma, type PrismaClient } from '@prisma/client'
import { utcTs } from '../../utils/sqlDates'

/**
 * Criterio ÚNICO de «orden cobrada que sigue abierta». Lo consumen el barrido
 * (`paid-order-reconciler.job.ts`) y el vigilante de dinero (check #5): si alguna vez
 * divergen, uno de los dos miente. Caso semilla: ORD-1788276418170 (Testarudo, 1-sep-2026).
 *
 * Reglas:
 *  - la orden no está en estado terminal;
 *  - la suma de sus cobros COMPLETED que NO son REFUND cubre la base sin propina,
 *    `max(0, subtotal − descuento)`, con un centavo de tolerancia. 🔴 Misma regla que
 *    `summarizeRefunds` en `orderBalance.ts` —los REFUND no restan de lo pagado (decisión
 *    del founder 2026-08-18: «un reembolso NO reabre saldo»)— porque es exactamente lo que
 *    usa el camino que cierra, `updateOrderTotalsForStandalonePayment`. Si esta suma
 *    restara los reembolsos, una orden pagada y luego devuelta por completo sería
 *    `isFullyPaid` para quien cierra y NO candidata para nosotros: el barrido nunca la
 *    alcanzaría;
 *  - la suma es CIEGA AL TIPO salvo REFUND: los TEST y los ADJUSTMENT cuentan, igual que
 *    en el camino de cierre. No se filtra por `type` más allá de excluir la devolución;
 *  - existe al menos un cobro REGULAR o FAST positivo — así una cuenta de $0 sin cobro
 *    (cortesía total) NO se marca pagada: ésa la cierra el cajero cobrando $0;
 *  - asimetría deliberada con `type` NULL: la puerta del EXISTS lo RECHAZA (un NULL no
 *    entra en un `IN (...)`) pero la suma sí lo CUENTA (`IS DISTINCT FROM` conserva los
 *    NULL). Hoy producción no tiene ninguno — REGULAR 41,616 · FAST 2,244 · REFUND 31.
 *
 * `alias` es texto de confianza (código propio), nunca entrada de usuario: se interpola
 * sin parametrizar y acaba dentro de un `$queryRawUnsafe`.
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
      WHERE p."orderId" = ${o}.id AND p.status = 'COMPLETED' AND p.type IS DISTINCT FROM 'REFUND'
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

/**
 * Candidatas, del más viejo al más nuevo, sin tocar órdenes actualizadas hace menos de `graceMs`.
 *
 * `pagado` aplica el MISMO filtro que el criterio (COMPLETED y no REFUND) para que el número
 * reportado sea el que decidió la selección. `paymentIds` en cambio trae TODOS los COMPLETED,
 * reembolsos incluidos: es rastro de auditoría, no la suma que manda.
 */
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
           (SELECT COALESCE(SUM(p.amount), 0) FROM "Payment" p
             WHERE p."orderId" = o.id AND p.status = 'COMPLETED' AND p.type IS DISTINCT FROM 'REFUND')::text AS pagado,
           ARRAY(SELECT p.id FROM "Payment" p WHERE p."orderId" = o.id AND p.status = 'COMPLETED' ORDER BY p."createdAt") AS "paymentIds"
    FROM "Order" o
    WHERE ${Prisma.raw(criterioPagadaPeroAbiertaSql('o'))}
      AND o."updatedAt" < ${utcTs(antesDe)}
    ORDER BY o."createdAt" ASC
    LIMIT ${opts.limit}
  `
  return rows
}
