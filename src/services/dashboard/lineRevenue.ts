/**
 * What ONE order line actually earned — the single definition, shared by every
 * item-revenue report.
 *
 *     unitPrice × COALESCE(weightQuantity, quantity) − discountAmount + modifiers
 *
 * The reports used to sum `unitPrice * quantity` and nothing else, which got
 * FIVE things wrong at once. All five are listed below with live counts
 * (measured on av-db-25) so the next reader doesn't have to re-derive them.
 *
 * ── The five classes this formula handles ────────────────────────────────────
 *
 * 1. DISCOUNT on the line (the original bug). A combo writes its giveaway to
 *    `OrderItem.discountAmount` and leaves `Order.discountAmount` at 0, so the
 *    line was billed at LIST price (89 instead of 77.29) and the food-cost
 *    percentage came out flattered.
 *
 * 2. MODIFIERS (683 lines, $33,811). Modifiers are their OWN table
 *    (`OrderItemModifier`, one row per modifier, with `price` and `quantity`);
 *    there is no `modifiersTotal` column on the line. `unitPrice` does NOT
 *    include them, so this revenue was simply missing. Example: a line with
 *    unitPrice 169 + two modifiers worth 280 really earned 449.
 *
 * 3. SOLD BY WEIGHT (16 lines). Weighted lines keep `quantity = 1` and put the
 *    kilos in `weightQuantity`, so `unitPrice × quantity` charged a FULL kilo
 *    for every weighing: 240/kg × 0.435 kg reported 240.00 instead of 104.40.
 *    Across the DB that over-reported 3,840.00 where 1,771.20 was sold (+117%).
 *
 * 4. TAX stacked on top. Some rows carry tax inside the price (Mexican) and
 *    others add it on top (US-style) — `taxAmount` means two different things
 *    in the same column, so `total` cannot be untangled by arithmetic. This
 *    formula never touches tax, so it stays out of that ambiguity entirely.
 *
 * 5. "Cobrar" cortesías (7 lines) whose line stays GROSS because the giveaway
 *    was booked on `Order.discountAmount` instead. See `isItemLevelDiscount`.
 *
 * ── Why NOT `OrderItem.total` ────────────────────────────────────────────────
 * It looks like the obvious answer, and for weighted lines it is the only thing
 * that was ever right. But it is not usable as the general definition:
 *
 *   • It is ambiguous on tax (class 4): 1,374 lines carry tax INCLUDED and
 *     1,155 carry it ON TOP. No arithmetic separates them.
 *   • It is inconsistent on modifiers. On 502 lines `total` EXCLUDES the
 *     modifiers and on 36 it INCLUDES them. Verified where the money actually
 *     went: on 320 orders (of 324) `Order.subtotal` equals the line totals PLUS
 *     the modifiers — the customer WAS charged for them. So `SUM(total)` simply
 *     loses that revenue on the lines where it excludes them.
 *
 * Building revenue up from `unitPrice` instead means modifiers can never be
 * double-counted: the base is derived from `unitPrice`, which never contains
 * them, so adding them is correct on BOTH populations above.
 *
 * Gross vs net stays a product decision (see `salesGiveaways.ts`): this helper
 * does not decide what a report DISPLAYS, only what a line is worth when a
 * report needs one revenue number.
 */

/** Units actually sold on a line: kilos when sold by weight, else quantity. */
export const lineUnitsSql = (alias = 'oi'): string => `COALESCE(${alias}."weightQuantity", ${alias}."quantity")`

/**
 * The line WITHOUT its modifiers: price × units sold, net of the line discount.
 * Exists only for `isItemLevelDiscountSql`, which compares against
 * `OrderItem.total` — a column that excludes the modifiers on most rows.
 */
export const lineBaseSql = (alias = 'oi'): string => `(${alias}."unitPrice" * ${lineUnitsSql(alias)} - ${alias}."discountAmount")`

/**
 * Σ of the line's modifiers. They live in their own table, so this is a
 * correlated subquery — there is no column to read.
 */
export const lineModifiersSql = (alias = 'oi'): string =>
  `COALESCE((SELECT SUM(m."price" * m."quantity") FROM "OrderItemModifier" m WHERE m."orderItemId" = ${alias}."id"), 0)`

/**
 * LIST value of what the line sold, BEFORE its discount: price × units, plus the
 * modifiers the customer added. This is the "gross sales" figure a report shows
 * next to a separate discounts column, so that `net = gross − discounts` holds
 * exactly. Modifiers belong on BOTH sides or that identity breaks.
 */
export const lineGrossSql = (alias = 'oi'): string => `(${alias}."unitPrice" * ${lineUnitsSql(alias)} + ${lineModifiersSql(alias)})`

/**
 * SQL expression for what a line earned. Safe inside `SUM(...)` — every term is
 * per-row.
 *
 * @param alias - the `OrderItem` alias in the query (every call site uses `oi`).
 */
export const lineRevenueSql = (alias = 'oi'): string => `(${lineGrossSql(alias)} - ${alias}."discountAmount")`

/**
 * SQL twin of `isItemLevelDiscount`: true when the line total is already net of
 * its own discount, i.e. the giveaway is NOT also sitting on
 * `Order.discountAmount`. Keep the two in step — they answer the same question.
 */
export const isItemLevelDiscountSql = (alias = 'oi'): string =>
  `(${alias}."discountAmount" > 0 AND ABS(${alias}."total" - ${lineBaseSql(alias)}) < 0.005)`

interface LineLike {
  quantity: number
  unitPrice: unknown
  discountAmount?: unknown
  weightQuantity?: unknown
  modifiers?: Array<{ price: unknown; quantity?: number }> | null
}

/** Units actually sold: kilos when sold by weight, else quantity. */
export function lineUnits(item: Pick<LineLike, 'quantity' | 'weightQuantity'>): number {
  return item.weightQuantity == null ? (item.quantity ?? 0) : Number(item.weightQuantity)
}

/** The line WITHOUT its modifiers — see `lineBaseSql`. */
export function lineBase(item: LineLike): number {
  return Number(item.unitPrice ?? 0) * lineUnits(item) - Number(item.discountAmount ?? 0)
}

/** Σ of the line's modifiers — see `lineModifiersSql`. */
export function lineModifiers(item: Pick<LineLike, 'modifiers'>): number {
  return (item.modifiers ?? []).reduce((sum, m) => sum + Number(m.price ?? 0) * (m.quantity ?? 1), 0)
}

/** LIST value before the discount, modifiers included — see `lineGrossSql`. */
export function lineGross(item: LineLike): number {
  return Number(item.unitPrice ?? 0) * lineUnits(item) + lineModifiers(item)
}

/**
 * What a line earned, modifiers included.
 *
 * 🔴 The caller MUST have loaded `modifiers` (and `weightQuantity`) in its
 * Prisma select, or the modifier revenue silently disappears again. An absent
 * relation is treated as "no modifiers", which is correct for a line that has
 * none and wrong for a select that forgot to ask.
 */
export function lineRevenue(item: LineLike): number {
  return lineGross(item) - Number(item.discountAmount ?? 0)
}

/**
 * A line's discount counts as ITEM-level only when the line total is already net
 * of it. When the line is still gross (`total = unitPrice × units`) the giveaway
 * was booked on `Order.discountAmount` instead — counting it again would double
 * it. Verified on live data: the two sets never overlap.
 *
 * Compares against `lineBase`, NOT `lineRevenue`: `OrderItem.total` excludes the
 * modifiers on most rows, so including them here would misread a perfectly
 * normal discounted line as "already booked at order level".
 */
export function isItemLevelDiscount(item: LineLike & { total: unknown }): boolean {
  const discount = Number(item.discountAmount ?? 0)
  if (discount <= 0) return false
  return Math.abs(Number(item.total ?? 0) - lineBase(item)) < 0.005
}
