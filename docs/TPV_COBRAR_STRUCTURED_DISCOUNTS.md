# TPV Cobrar Structured Discounts

## Purpose

These schema fields were added for the new standalone TPV **Cobrar** flow:

- `OrderItem.isCortesia`
- `OrderItem.cortesiaReason`
- `OrderItem.appliedDiscountId`
- `OrderDiscount.appliedToItemIds`

They exist so a single TPV cart can persist catalog products, custom line items, cortesía items, per-item discounts, and order-level
discounts in one transaction while keeping receipts, dashboard details, reports, and audit trails explainable.

## Scope Rule

These fields are **additive metadata**, not a required replacement for the legacy discount model.

Do not migrate existing endpoints or clients to these fields unless the product owner explicitly asks for that migration.

This includes:

- `/mobile/*` endpoints
- legacy TPV order endpoints
- dashboard order/discount flows
- payment links
- public checkout/payment flows
- iOS or Android mobile clients outside the standalone TPV Cobrar flow

Existing flows can keep using:

- `Order.discountAmount`
- `OrderItem.discountAmount`
- `OrderDiscount`
- `OrderAction`

New Cobrar should write the new structured fields **in addition to** the legacy money fields, so old reports continue to work.

## Money Invariants

For new TPV Cobrar V1:

- `Order.subtotal` is gross: sum of all `OrderItem.total` before cortesía or discounts.
- `OrderItem.total` is gross: `unitPrice * quantity`.
- `OrderItem.discountAmount` stores item-level reductions.
- `Order.discountAmount` stores total reductions: cortesía + per-item discounts + order-level discount.
- `Order.total = Order.subtotal - Order.discountAmount`.
- `Order.taxAmount = 0` in V1. The new Cobrar flow must not enable order tax until payment math, receipts, and dashboard totals are updated
  together.

Do not set `OrderItem.total = 0` for cortesía. That breaks gross sales reporting. A cortesía item keeps its gross total and stores the
reduction in `discountAmount`, with `isCortesia=true`.

## How To Adopt In Another Endpoint Later

Only do this after explicit product approval.

1. Keep legacy money fields populated exactly as before.
2. Add structured metadata as a supplement, not a replacement.
3. Preserve gross/net semantics:
   - `OrderItem.total` stays gross.
   - `OrderItem.discountAmount` carries line reductions.
   - `Order.discountAmount` carries aggregate reductions.
4. For item-level cortesía:
   - set `OrderItem.isCortesia=true`
   - set `OrderItem.cortesiaReason`
   - set `OrderItem.discountAmount = lineGross`
   - create `OrderAction` with `actionType='COMP'`
5. For item-level predefined discounts:
   - set `OrderItem.appliedDiscountId`
   - set `OrderItem.discountAmount` to the resolved discount amount
   - create/update `OrderDiscount` and include the affected item ids
6. Add tests for:
   - receipts
   - dashboard order/payment detail
   - sales summary reports
   - sales-by-item reports
   - commission calculation
   - inventory deduction
   - refunds/voids if the endpoint supports them

## Non-Goals

These fields do not require a global frontend migration.

They do not change how payment capture, tips, transaction costs, commissions, or inventory deduction work by themselves. Those systems still
depend on the existing payment/order completion flows unless a separate plan changes them explicitly.
