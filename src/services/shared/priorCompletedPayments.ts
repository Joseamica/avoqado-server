import type { Prisma } from '@prisma/client'

/**
 * The slice of a Prisma transaction client this helper needs. Production always
 * passes the real `Prisma.TransactionClient`; a unit-test double MUST implement
 * `payment.count` (see `countPriorCompletedPayments`).
 */
export type PriorCompletedPaymentsTransaction = {
  payment: Pick<Prisma.TransactionClient['payment'], 'count'>
}

/**
 * How many COMPLETED, non-refund payments the order already has in this venue.
 *
 * `0` means the payment being recorded is the FIRST money captured on the order —
 * the single input that decides `incrementTotalOrders` on the shift claim
 * (`claimShiftFor*Payment` in `paymentShiftClaim.ts`), i.e. whether the shift's
 * `totalOrders` counter moves. Every rail that records money on an existing order
 * asks this question here, so the rule lives ONCE: TPV `recordOrderPayment`, the
 * dashboard's `createManualPayment` and `settleOrder`, and the B4Bit confirmation.
 *
 * 🔴 No fallback to `0`. `Prisma.TransactionClient` always exposes `payment.count`,
 * so the guard below never fires in production; its only job is to make a
 * mis-assembled test double fail HERE, with the dependency named, instead of
 * silently counting every payment as "the first one" (which inflated the shift's
 * `totalOrders` in the tested scenario while the suite stayed green). A double
 * whose `count` resolves to `undefined` is the same defect one layer down: a
 * `?? 0` would turn it into "first payment" just as silently, so it throws too.
 */
export async function countPriorCompletedPayments(
  tx: PriorCompletedPaymentsTransaction,
  input: { venueId: string; orderId: string },
): Promise<number> {
  const countFn = (tx as { payment?: { count?: unknown } } | undefined)?.payment?.count
  if (typeof countFn !== 'function') {
    throw new Error('countPriorCompletedPayments requiere una transacción con payment.count')
  }
  const count: unknown = await tx.payment.count({
    where: { venueId: input.venueId, orderId: input.orderId, status: 'COMPLETED', type: { not: 'REFUND' } },
  })
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
    throw new Error(
      `countPriorCompletedPayments: payment.count devolvió ${String(count)} en vez de un entero — el doble de la transacción está mal armado`,
    )
  }
  return count
}
