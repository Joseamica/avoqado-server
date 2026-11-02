import { Prisma } from '@prisma/client'
import { utcTs } from '@/utils/sqlDates'
import { MAX_ORDER_LOCK_SCOPE } from '../shared/paymentShiftClaim'

/** Only the already locked exchange scope supplies its local accounting clock. */
export async function exchangeAccountingAt(tx: Prisma.TransactionClient, venueId: string, orderIds: string[]): Promise<Date> {
  const [{ accountingAt }] = await tx.$queryRaw<Array<{ accountingAt: Date }>>`
    WITH RECURSIVE ancestors(id) AS (
      SELECT id FROM "Order" WHERE id = ANY(${orderIds}::text[]) AND "venueId" = ${venueId}
      UNION
      SELECT root."orderId" FROM ancestors child
      JOIN "Payment" credit ON credit."orderId" = child.id AND credit."venueId" = ${venueId}
      JOIN "ExchangeCreditLink" link ON link."creditPaymentId" = credit.id AND link."venueId" = credit."venueId"
      JOIN "Payment" root ON root.id = link."originPaymentId" AND root."venueId" = credit."venueId"
      JOIN "Order" parent ON parent.id = root."orderId" AND parent."venueId" = credit."venueId"
    ), scope AS MATERIALIZED (SELECT id FROM ancestors LIMIT ${Prisma.raw(String(MAX_ORDER_LOCK_SCOPE))})
    SELECT GREATEST(${utcTs(new Date())}, MAX(m."createdAt") + INTERVAL '1 millisecond') AS "accountingAt"
    FROM scope LEFT JOIN LATERAL (
      SELECT p."createdAt" FROM "Payment" p
      WHERE p."orderId" = scope.id AND p."venueId" = ${venueId} AND p.status = 'COMPLETED'
      ORDER BY p."createdAt" DESC LIMIT 1
    ) m ON true`
  return accountingAt
}
