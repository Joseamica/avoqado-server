/**
 * Square-style giveaway reporting (Sales Summary).
 *
 * Square separates Gross Sales (full catalog price) from a Discounts & Comps
 * line so the owner can see BOTH what was sold and what it cost to discount
 * (researched live 2026-08-14: squareup.com/help sales-summary + community
 * thread "Why are discounts not applied when determining gross sales").
 *
 * Two of our flows follow the NET line convention (OrderItem.total already
 * reduced, no OrderDiscount row), so their giveaway never reached
 * Order.discountAmount and the report showed neither side:
 *
 *  - Promotion lines: the giveaway lives in OrderPromotion.discountCents.
 *  - Mobile / TABLE_SERVICE cortesías: isCortesia=true, total=0,
 *    discountAmount = list price (comp-item.mobile.service and
 *    addItemsToOrder). Cobrar V1 cortesías are ALREADY visible (they create
 *    an OrderDiscount COMP row and their lines are gross) — that is why the
 *    comp filter below requires total = 0, so Cobrar comps never double-count.
 *
 * Folding the giveaway into BOTH grossSales and discounts keeps Net Sales
 * byte-identical — payments reconcile against net, so it must not move.
 */

/** Prisma `where` for comp lines whose giveaway is NOT in Order.discountAmount. */
export const HIDDEN_COMP_LINE_WHERE = { isCortesia: true, total: 0 } as const

const roundToCents = (n: number): number => Math.round(n * 100) / 100

export interface FoldableSummary {
  grossSales: number | null
  items: number | null
  discounts: number | null
}

/**
 * Adds the hidden giveaways to both sides of the P&L.
 *
 * @param base - order-derived metrics (null under a payment-method filter).
 * @param promoDiscountCents - Σ OrderPromotion.discountCents (CENTS — ledger
 *   convention; converted ÷100 here, the read boundary).
 * @param compGivenAwayPesos - Σ OrderItem.discountAmount of hidden comp lines
 *   (already pesos).
 */
export function foldGiveawaysIntoSummary(base: FoldableSummary, promoDiscountCents: number, compGivenAwayPesos: number): FoldableSummary {
  const giveaway = roundToCents(promoDiscountCents / 100 + compGivenAwayPesos)
  if (giveaway === 0) return base

  return {
    grossSales: base.grossSales === null ? null : roundToCents(base.grossSales + giveaway),
    items: base.items === null ? null : roundToCents(base.items + giveaway),
    discounts: base.discounts === null ? null : roundToCents(base.discounts + giveaway),
  }
}
