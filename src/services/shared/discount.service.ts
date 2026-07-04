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

import { Prisma } from '@prisma/client'
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

/**
 * Enforce that an ITEM/CATEGORY-scoped `Discount` actually targets the line
 * item it's being applied to, and that an ORDER-scoped discount is never
 * smuggled in through a per-item `discountId`/`itemDiscountId` field.
 *
 * Without this, a tampered client could send an ITEM discount scoped to
 * product A against product B's line item, or send an ORDER-scoped discount
 * (meant only for the order-level discount field) as a per-item discount.
 *
 * Wildcard rule: an ITEM discount with an empty/null `targetItemIds` (same
 * for CATEGORY + `targetCategoryIds`) applies to ALL products/categories —
 * it is not "targets nothing". This matches the long-standing client
 * semantic (iOS's `Discount.appliesToProduct` in CartModels.swift has always
 * treated an empty target list as "applies to everything"), so a venue's
 * ITEM/CATEGORY discount created with no explicit targets keeps working
 * everywhere instead of being newly rejected by this server-side check.
 *
 * @param item The line item's `productId`/`categoryId` (both `null` for a
 *   custom "Otro importe" line — which then can never match an ITEM/CATEGORY
 *   discount, since there's no real product to check against).
 * @throws BadRequestError — same class + rejection style as the existing
 *   "Descuento no encontrado o no pertenece a este local" check in this same
 *   code path: reject the WHOLE order, Spanish message naming the mismatch.
 */
export function validateDiscountScopeForItem(discount: any, item: { productId: string | null; categoryId: string | null }): void {
  if (discount.scope === 'ORDER') {
    throw new BadRequestError(`Descuento "${discount.name}" es de alcance de orden y no puede aplicarse a un artículo individual`)
  }

  if (discount.scope === 'ITEM') {
    const targetItemIds: string[] = discount.targetItemIds ?? []
    const isWildcard = targetItemIds.length === 0
    if (!isWildcard && (!item.productId || !targetItemIds.includes(item.productId))) {
      throw new BadRequestError(`Descuento "${discount.name}" no aplica a este producto`)
    }
    return
  }

  if (discount.scope === 'CATEGORY') {
    const targetCategoryIds: string[] = discount.targetCategoryIds ?? []
    const isWildcard = targetCategoryIds.length === 0
    if (!isWildcard && (!item.categoryId || !targetCategoryIds.includes(item.categoryId))) {
      throw new BadRequestError(`Descuento "${discount.name}" no aplica a la categoría de este producto`)
    }
    return
  }

  // Other scopes (e.g. CUSTOMER_GROUP) aren't reachable via the per-item
  // discountId/itemDiscountId input today — nothing to enforce here.
}

export type ItemDiscountRowInput = {
  orderId: string
  itemId: string
  discount: any
  discountAmountPesos: number
  appliedById: string | null
}

/**
 * Build the `OrderDiscount` create-input for a single item-scoped discount
 * application: one row per discounted item, `appliedToItemIds: [itemId]`.
 * This is the exact shape TPV writes in `order.tpv.service.ts
 * createOrderWithItems` (extracted verbatim) — used by both TPV and mobile
 * so dashboard discount-breakdown reporting (which reads `OrderDiscount`)
 * reflects item discounts applied through either channel identically.
 */
export function buildItemDiscountRow(input: ItemDiscountRowInput): Prisma.OrderDiscountUncheckedCreateInput {
  const { orderId, itemId, discount, discountAmountPesos, appliedById } = input
  return {
    orderId,
    discountId: discount.id,
    type: discount.type,
    name: discount.name,
    value: discount.value,
    amount: new Prisma.Decimal(roundPesos(discountAmountPesos)),
    taxReduction: 0,
    isComp: discount.type === 'COMP',
    isManual: true,
    compReason: discount.type === 'COMP' ? discount.compReason || discount.name : null,
    appliedById,
    appliedToItemIds: [itemId],
  }
}

function roundPesos(value: number): number {
  return Math.round(value * 100) / 100
}
