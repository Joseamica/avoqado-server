-- Quantify the iOS offline-order ×1.16 overcharge (found 2026-07-02)
--
-- Context: before the iOS fix "fix(cart): treat catalog prices as IVA-incluido",
-- offline cash orders created on iOS charged cart.grandTotal (catalog price +16%
-- added on top) while the backend computed order.total as IVA-incluido. On sync,
-- the backend trusted the client-sent payment amount, so the overcharge persisted
-- in Payment.amount / VenueTransaction.grossAmount / Shift.totalSales while the
-- order itself stored the correct (lower) total.
--
-- Run against PRODUCTION read replica to size the remediation decision.
-- Read-only. Tolerance of $1 skips rounding noise. Split-aware: compares the
-- SUM of completed payments per order against the order total (an overcharged
-- half-split is individually below order.total and would evade a per-payment check).

-- 1) Per-venue summary
SELECT
  v.name AS venue,
  count(*) AS affected_orders,
  sum(pay.paid - o.total) AS total_overcharge,
  min(pay.first_payment) AS first_seen,
  max(pay.last_payment) AS last_seen
FROM (
  SELECT "orderId",
         sum(amount) AS paid,
         min("createdAt") AS first_payment,
         max("createdAt") AS last_payment
  FROM "Payment"
  WHERE status = 'COMPLETED'
  GROUP BY "orderId"
) pay
JOIN "Order" o ON o.id = pay."orderId"
JOIN "Venue" v ON v.id = o."venueId"
WHERE pay.paid > o.total + 1
GROUP BY v.name
ORDER BY total_overcharge DESC;

-- 2) Per-order detail (for the remediation sweep, if approved)
SELECT
  v.name AS venue,
  o.id AS order_id,
  o.total AS order_total,
  pay.paid AS amount_paid,
  pay.paid - o.total AS overcharge,
  pay.last_payment
FROM (
  SELECT "orderId", sum(amount) AS paid, max("createdAt") AS last_payment
  FROM "Payment"
  WHERE status = 'COMPLETED'
  GROUP BY "orderId"
) pay
JOIN "Order" o ON o.id = pay."orderId"
JOIN "Venue" v ON v.id = o."venueId"
WHERE pay.paid > o.total + 1
ORDER BY pay.last_payment DESC;
