// src/services/fiscal/ivaMath.ts
//
// Pure money helpers for the IVA-included (GROSS) pricing convention used across Avoqado.
//
// In Mexico, POS / menu prices are quoted IVA-included: the customer's out-of-pocket already
// contains the tax (a "$100" item is paid as $100, with ~$13.79 of that being IVA at 16%).
// A CFDI, however, must itemize base + IVA = total — and that total MUST equal what the
// customer actually paid. So before handing a gross price to the PAC we either tell it the
// price is tax-included (preferred) or split it ourselves for our own stored breakdown.

/**
 * Splits an IVA-included (gross) integer-cent amount into its net base + tax for a given rate.
 *
 * The tax absorbs the rounding remainder so `netCents + taxCents === grossCents` EXACTLY,
 * which guarantees the stored breakdown cuadra al centavo and the total equals what was paid.
 * A non-positive rate (exempt / 0%) means there is no IVA to extract: everything is base.
 *
 * @param grossCents IVA-included amount in integer cents (what the customer paid for the line)
 * @param rate       tax rate as a fraction, e.g. 0.16 / 0.08 / 0
 */
export function splitIvaIncluded(grossCents: number, rate: number): { netCents: number; taxCents: number } {
  if (!Number.isFinite(rate) || rate <= 0) return { netCents: grossCents, taxCents: 0 }
  const netCents = Math.round(grossCents / (1 + rate))
  return { netCents, taxCents: grossCents - netCents }
}

/**
 * Distribute an integer-cent `totalCents` across `weightsCents` proportionally, with the
 * LARGEST-weight bucket absorbing the rounding remainder so the parts sum to `totalCents`
 * EXACTLY (no cent lost/created). Empty weights → `[]`; all-zero weights → the whole total
 * lands in the first bucket (there is no proportion to honor).
 */
export function allocateByWeights(totalCents: number, weightsCents: number[]): number[] {
  const n = weightsCents.length
  if (n === 0) return []
  const sum = weightsCents.reduce((a, b) => a + b, 0)
  if (sum <= 0) return weightsCents.map((_, i) => (i === 0 ? totalCents : 0))
  const parts = weightsCents.map(w => Math.round((totalCents * w) / sum))
  const drift = totalCents - parts.reduce((a, b) => a + b, 0)
  if (drift !== 0) {
    let maxI = 0
    for (let i = 1; i < n; i++) if (weightsCents[i] > weightsCents[maxI]) maxI = i
    parts[maxI] += drift
  }
  return parts
}

/**
 * Split an IVA-included total across MULTIPLE tax rates (the real per-product rates of an order),
 * instead of assuming a single flat rate. Each `portions[i].grossCents` is split at its own `rate`
 * via {@link splitIvaIncluded} (exact), so `Σnet + Σtax === Σgross` EXACTLY — the póliza and the IVA
 * declaration cuadran al centavo. Returns the summed net + tax PLUS a per-rate tax map (the SAT IVA
 * declaration reports 16% and 8% separately, so callers need the breakdown, not just the total).
 *
 * `taxByRate` keys are the rate as a string (e.g. `"0.16"`, `"0.08"`); 0%/exempt lines add no key.
 */
export function splitIvaByRate(portions: { grossCents: number; rate: number }[]): {
  netCents: number
  taxCents: number
  taxByRate: Record<string, number>
} {
  let netCents = 0
  let taxCents = 0
  const taxByRate: Record<string, number> = {}
  for (const { grossCents, rate } of portions) {
    const s = splitIvaIncluded(grossCents, rate)
    netCents += s.netCents
    taxCents += s.taxCents
    if (s.taxCents !== 0) {
      const key = String(rate)
      taxByRate[key] = (taxByRate[key] ?? 0) + s.taxCents
    }
  }
  return { netCents, taxCents, taxByRate }
}

/**
 * Split ONE payment's IVA-included amount using the order's REAL per-rate mix. `grossByRate` is the
 * order's gross grouped by tax rate (from its line items). The payment amount is allocated across
 * those rates in proportion to each rate's share of the order (so partial / split payments work),
 * then split at each real rate. Guarantees `netCents + taxCents === paymentGrossCents` EXACTLY.
 *
 * Fallback: when the order has NO line items (e.g. a custom-amount / importe-libre sale), there is
 * no rate to read, so the whole amount is split at `fallbackRate` (default 16%) — the legacy behavior.
 */
export function splitPaymentIvaByOrderRates(
  paymentGrossCents: number,
  grossByRate: { rate: number; grossCents: number }[],
  fallbackRate = 0.16,
): { netCents: number; taxCents: number; taxByRate: Record<string, number> } {
  const meaningful = grossByRate.filter(r => r.grossCents !== 0)
  if (meaningful.length === 0) return splitIvaByRate([{ grossCents: paymentGrossCents, rate: fallbackRate }])
  const alloc = allocateByWeights(
    paymentGrossCents,
    meaningful.map(r => r.grossCents),
  )
  return splitIvaByRate(meaningful.map((r, i) => ({ grossCents: alloc[i], rate: r.rate })))
}

/**
 * Group an order's line items into gross (IVA-included, integer cents) per REAL tax rate — the single
 * source of truth for "how do we read each product's rate". An item with no `taxRate` defaults to
 * `defaultRate` (16%, same as the CFDI); 0-gross lines are skipped. The result feeds
 * {@link splitPaymentIvaByOrderRates} so IVA is computed per rate (16% central / 8% frontera / 0% exempt
 * / mixed) instead of assuming a flat rate on the whole amount. Empty items → `[]` (custom-amount sale →
 * callers fall back to the flat rate). Pure: item money arrives as NUMBER pesos (callers convert Decimals).
 */
export function grossByRateFromItems(
  items: { unitPrice: number; quantity: number; discountAmount: number; taxRate: number | null }[],
  defaultRate = 0.16,
): { rate: number; grossCents: number }[] {
  const byRate = new Map<number, number>()
  for (const it of items) {
    const rate = it.taxRate != null ? it.taxRate : defaultRate
    const grossCents = Math.round((it.unitPrice * it.quantity - it.discountAmount) * 100)
    if (grossCents === 0) continue
    byRate.set(rate, (byRate.get(rate) ?? 0) + grossCents)
  }
  return [...byRate.entries()].map(([rate, grossCents]) => ({ rate, grossCents }))
}
