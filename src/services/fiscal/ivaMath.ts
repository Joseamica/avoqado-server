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
