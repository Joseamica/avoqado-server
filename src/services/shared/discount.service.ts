/**
 * Shared Discount Helpers
 *
 * Pure, channel-agnostic discount validation + calculation logic used by
 * order-creation flows across clients (TPV, mobile/iOS/Android). Extracted
 * from `order.tpv.service.ts` (the reference implementation) so every
 * channel that lets a client attach a `Discount` row to an order/line item
 * applies the exact same rules.
 *
 * IMPORTANT: This is a byte-for-byte extraction of TPV's original inline
 * logic — do not change behavior here without re-validating every caller
 * (TPV's order.tpv.service.ts and mobile's order.mobile.service.ts both
 * depend on this being identical to what TPV shipped before the extraction).
 */

import { BadRequestError } from '../../errors/AppError'

/**
 * Compute the peso amount a `Discount` reduces a given base (line or order)
 * total by. Handles PERCENTAGE, FIXED_AMOUNT, and COMP types, and clamps to
 * `maxDiscountAmount` / the base itself (a discount can never make a
 * line/order negative).
 *
 * @throws BadRequestError if `basePesos` is below the discount's
 *   `minPurchaseAmount`, or if the discount has an unsupported `type`.
 */
export function calculateDiscountPesos(discount: any, basePesos: number): number {
  if (basePesos <= 0) return 0

  if (discount.minPurchaseAmount && basePesos < Number(discount.minPurchaseAmount)) {
    throw new BadRequestError(`Discount "${discount.name}" requires a minimum purchase amount`)
  }

  let amountPesos: number
  if (discount.type === 'PERCENTAGE') {
    amountPesos = roundPesos((basePesos * Number(discount.value)) / 100)
  } else if (discount.type === 'FIXED_AMOUNT') {
    amountPesos = roundPesos(Number(discount.value))
  } else if (discount.type === 'COMP') {
    amountPesos = basePesos
  } else {
    throw new BadRequestError(`Unsupported discount type: ${discount.type}`)
  }

  if (discount.maxDiscountAmount) {
    amountPesos = Math.min(amountPesos, Number(discount.maxDiscountAmount))
  }

  return roundPesos(Math.min(amountPesos, basePesos))
}

/**
 * Validate that a `Discount` row is currently usable: active, within its
 * validity window, and under its total-use cap.
 *
 * @throws BadRequestError on any failed check.
 */
export function validateDiscountActive(discount: any): void {
  const now = new Date()
  if (!discount.active) {
    throw new BadRequestError(`Discount "${discount.name}" is inactive`)
  }
  if (discount.validFrom && discount.validFrom > now) {
    throw new BadRequestError(`Discount "${discount.name}" is not active yet`)
  }
  if (discount.validUntil && discount.validUntil < now) {
    throw new BadRequestError(`Discount "${discount.name}" has expired`)
  }
  if (discount.maxTotalUses != null && discount.currentUses >= discount.maxTotalUses) {
    throw new BadRequestError(`Discount "${discount.name}" has reached its usage limit`)
  }
}

function roundPesos(value: number): number {
  return Math.round(value * 100) / 100
}
