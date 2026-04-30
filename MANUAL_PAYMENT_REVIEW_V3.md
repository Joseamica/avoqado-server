# Manual Payment — Review v3 Follow-up

> **Para el LLM revisor**: ya hiciste 2 rondas de review. Esta es la v3.
> En v1 encontraste 4 issues (P1×2, P2×2). Aprobé y fixé los 4.
> En v2 encontraste 1 regresión (multi-customer metrics solo a primary). Fixé.
> En v3 encontraste 1 regresión adicional (partial payments inflate metrics).
> Este documento muestra el fix de v3 + cambios resumidos.

---

## Tu hallazgo v3 (cerrado)

> **P2 — Partial payments inflate customer metrics**
> Manual now queues customer metrics before knowing whether the order is fully paid, so a multi-payment order increments totalVisits and totalSpent once per partial payment.
> /Users/amieva/Documents/Programming/Avoqado/avoqado-server/src/services/dashboard/manualPayment.service.ts:174-184

## Fix aplicado

**Cambio en el service** (`src/services/dashboard/manualPayment.service.ts`):

```diff
- // Customer metrics: queue updates for ALL customers associated with the
- // order, regardless of payment-completion state. Visits/spend/lastVisitAt
- // increments per customer for every payment recorded against this order.
- // Note: each manual payment increments these — if you split a $100 order
- // into 4 manual payments of $25, each customer's totalVisits goes up by 4.
- // This matches TPV's per-payment metric update semantics.
- for (const oc of order.orderCustomers) {
-   metricsCustomerIds.add(oc.customerId)
- }
- if (input.customerId) metricsCustomerIds.add(input.customerId)
- if (order.customerId) metricsCustomerIds.add(order.customerId)
-
- if (newTotalPaid.equals(anchorOrderTotal)) {
-   // Resolution: explicit input override > primary OrderCustomer > legacy column
-   const primaryCustomer = order.orderCustomers.find(oc => oc.isPrimary)
-   const resolvedCustomerId = input.customerId ?? primaryCustomer?.customerId ?? order.customerId ?? null
-   if (resolvedCustomerId) {
-     loyaltyCustomerId = resolvedCustomerId
-     loyaltyOrderId = order.id
-     loyaltyOrderTotal = anchorOrderTotal
-     loyaltyShouldEarn = true
-   }
- }
+ // Customer metrics + loyalty are only queued on FULL SETTLEMENT, matching
+ // TPV's `if (isFullyPaid)` guard. Per-payment metric increments would
+ // inflate totalVisits (4 partials of a $100 order = 4 visits instead of 1)
+ // and disconnect from TPV semantics. Both metrics and loyalty fire ONCE
+ // per order, with the FINAL order total — not per-payment amounts.
+ if (newTotalPaid.equals(anchorOrderTotal)) {
+   const primaryCustomer = order.orderCustomers.find(oc => oc.isPrimary)
+   const resolvedCustomerId = input.customerId ?? primaryCustomer?.customerId ?? order.customerId ?? null
+   if (resolvedCustomerId) {
+     loyaltyCustomerId = resolvedCustomerId
+     loyaltyOrderId = order.id
+     loyaltyOrderTotal = anchorOrderTotal
+     loyaltyShouldEarn = true
+   }
+   // Customer metrics: queue updates for ALL customers on the order
+   // (primary + secondaries + override + legacy column). Visits/spend
+   // increments ONCE per customer at settlement, using the final order
+   // total — not per-payment amounts.
+   for (const oc of order.orderCustomers) {
+     metricsCustomerIds.add(oc.customerId)
+   }
+   if (input.customerId) metricsCustomerIds.add(input.customerId)
+   if (order.customerId) metricsCustomerIds.add(order.customerId)
+ }
```

**Cambio en post-tx**:

```diff
  if (metricsCustomerIds.size > 0) {
-   const metricsAmount = Number(loyaltyOrderTotal.toString()) || Number(amount.plus(tipAmount).toString())
+   // metricsCustomerIds is only populated when the order is fully settled
+   // (Mode 1 fully-paid OR Mode 2 shadow), so loyaltyOrderTotal is always
+   // the FINAL order total here.
+   const metricsAmount = Number(loyaltyOrderTotal.toString())
    for (const customerId of metricsCustomerIds) {
      try {
        await updateCustomerMetrics(customerId, metricsAmount)
        ...
```

## Tests cambiados / agregados

**Test invertido** — antes esperaba metrics en partial, ahora espera lo contrario:

```typescript
it('REVIEW v3: PARTIAL payment does NOT increment customer metrics (matches TPV semantics)', async () => {
  // ...
  expect(updateCustomerMetricsMock).not.toHaveBeenCalled()
  expect(earnPointsMock).not.toHaveBeenCalled()
})
```

**Test nuevo** — el escenario exacto que mencionaste ($100 / 4 partials):

```typescript
it('REVIEW v3: 4 partials of $25 on $100 order → metrics fire ONCE on the 4th partial (with full $100)', async () => {
  // Mock has 3 prior payments of $25 each. 4th payment of $25 settles.
  // updateCustomerMetrics must be called ONCE per customer with $100 (not $25).
  const mockOrder = {
    payments: [
      { amount: new Prisma.Decimal(25), tipAmount: new Prisma.Decimal(0), status: 'COMPLETED' },
      { amount: new Prisma.Decimal(25), tipAmount: new Prisma.Decimal(0), status: 'COMPLETED' },
      { amount: new Prisma.Decimal(25), tipAmount: new Prisma.Decimal(0), status: 'COMPLETED' },
    ],
    // ...
    orderCustomers: [{ customerId: 'cust-once', isPrimary: true }],
  }
  // ...4th payment of $25...
  expect(updateCustomerMetricsMock).toHaveBeenCalledTimes(1)
  expect(updateCustomerMetricsMock).toHaveBeenCalledWith('cust-once', 100)
  expect(earnPointsMock).toHaveBeenCalledWith(VENUE_ID, 'cust-once', 100, ORDER_ID, 'sv-1')
})
```

**Tests preservados sin cambios** (el escenario primary + secondary):

```typescript
it('REVIEW v2: multi-customer order (1 primary + 2 secondary) → 3 metrics calls + 1 loyalty call', async () => {
  // Same as before, BUT now this is a fully-paid scenario.
  // ...3 customers in the order, payment fully settles...
  expect(updateCustomerMetricsMock).toHaveBeenCalledTimes(3)
  expect(earnPointsMock).toHaveBeenCalledTimes(1)
})
```

## Resultados de las 3 verificaciones que sugeriste

```bash
$ npx jest tests/unit/services/dashboard/manualPayment.service.test.ts --maxWorkers=1
Tests:       67 passed, 67 total

$ npx tsc -p tsconfig.build.json --noEmit
(no output — passed)

$ npm run test:unit
Tests:       8 skipped, 1881 passed, 1889 total
Test Suites: 89 passed, 89 total
```

## Estado de tus 4 puntos del v3

| Tu requerimiento | Status |
|---|:---:|
| Solo poblar/usar metricsCustomerIds cuando newTotalPaid deja la orden fully paid | ✅ |
| Pasar anchorOrderTotal como metricsAmount (no amount + tipAmount en parciales) | ✅ |
| Cambiar el test que esperaba metrics en partial → expect no llamado | ✅ |
| Mantener test 1 primary + 2 secondary en pago final: 3 métricas + 1 loyalty | ✅ |

## Service file completo

`src/services/dashboard/manualPayment.service.ts` (línea 165-185 ahora):

```typescript
// Customer metrics + loyalty are only queued on FULL SETTLEMENT, matching
// TPV's `if (isFullyPaid)` guard. Per-payment metric increments would
// inflate totalVisits (4 partials of a $100 order = 4 visits instead of 1)
// and disconnect from TPV semantics. Both metrics and loyalty fire ONCE
// per order, with the FINAL order total — not per-payment amounts.
if (newTotalPaid.equals(anchorOrderTotal)) {
  // Resolution: explicit input override > primary OrderCustomer > legacy column
  const primaryCustomer = order.orderCustomers.find(oc => oc.isPrimary)
  const resolvedCustomerId = input.customerId ?? primaryCustomer?.customerId ?? order.customerId ?? null
  if (resolvedCustomerId) {
    loyaltyCustomerId = resolvedCustomerId
    loyaltyOrderId = order.id
    loyaltyOrderTotal = anchorOrderTotal
    loyaltyShouldEarn = true
  }
  // Customer metrics: queue updates for ALL customers on the order
  // (primary + secondaries + override + legacy column). Visits/spend
  // increments ONCE per customer at settlement, using the final order
  // total — not per-payment amounts.
  for (const oc of order.orderCustomers) {
    metricsCustomerIds.add(oc.customerId)
  }
  if (input.customerId) metricsCustomerIds.add(input.customerId)
  if (order.customerId) metricsCustomerIds.add(order.customerId)
}
```

## ¿Algún issue residual?

Por favor revisa:
- ¿`anchorOrderTotal` es realmente el total final? (es: `subtotal + tax - discount + cumulative tips` actualizado en cada partial)
- ¿Hay algún edge case con `newTotalPaid.equals` vs `>=` que pueda dejar una orden marcada PAID sin disparar metrics? (En mi código uso `.equals` para metrics/loyalty pero `>=` para `paymentStatus = PAID`)
- ¿Algo más que TPV haga que yo no esté haciendo en pagos completos?

Si todo OK → SHIP. Si hay algo más → otro round.
