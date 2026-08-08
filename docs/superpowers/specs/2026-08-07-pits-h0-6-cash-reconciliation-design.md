# PITS H0.6 — Cash Reconciliation at Shift Close

**Date:** 2026-08-07  
**Status:** Approved — revised after contract and concurrency review  
**Tier:** PRO  
**Rollout:** Explicit opt-in per venue, disabled by default  
**Repositories:** `avoqado-server`, `avoqado-web-dashboard`, `avoqado-tpv`

## 1. Problem

H0.6 promises a real cash over/short amount when a shift closes. The shared formula now has the
right meaning:

```text
expected cash   = starting cash + recorded cash sales
cash difference = physically counted cash - expected cash
```

The live TPV flow still does not collect a physical count, so the server has nothing trustworthy
to compare. Worse, the current HTTP boundary turns an absent count into zero, the shift service
uses truthiness and loses a legitimate zero count, and dashboard serializers turn a balanced
`cashDifference = 0` back into `null`.

The feature must be additive. Existing venues, old APKs, kiosks, and any venue that does not opt
in must keep the current close-shift flow with no new prompt or blocking condition.

## 2. Industry Reference

The design follows the common denominator of current cash-management products:

- [Square cash drawer sessions](https://squareup.com/help/us/en/article/8344-start-and-end-a-cash-drawer-session)
  distinguish ending a drawer without recording an actual count from closing it with the actual
  cash in the drawer. Square also records starting cash and cash paid in/out.
- [Square close-of-day procedures](https://squareup.com/help/us/en/article/6594-end-of-day-reporting-with-square-for-restaurants)
  are location-specific and allow an authorized override when a required closing task cannot be
  completed.
- [Toast shift review](https://central.toasttab.com/articles/Knowledge/Shift-Review-Overview)
  has an optional close-drawer step and supports blind cash counting so cashiers cannot copy the
  expected value.
- [Toast cash-drawer setup](https://central.toasttab.com/articles/Knowledge/Setting-Up-Cash-Drawers)
  recommends blind access for cashiers and full expected-balance access for managers.
- [Shopify register sessions](https://help.shopify.com/en/manual/sell-in-person/shopify-pos/cash-register-management/register-sessions-in-shopify-admin)
  require explicit confirmation of a cash discrepancy and still provide a recovery path when the
  drawer cannot be counted.

For H0.6, Avoqado adopts blind counting, an explicit non-blocking escape, and auditable actual vs.
expected amounts. Denomination counting, paid-in/out attribution, and manager-only overrides are
deliberately deferred.

## 3. Decisions

### D1. Entitlement and activation are separate

`CASH_RECONCILIATION` is a PRO capability. The operational opt-in is a new venue setting:

```prisma
cashReconciliationEnabled Boolean @default(false)
```

Effective access is:

```text
venueHasFeatureAccess(venueId, "CASH_RECONCILIATION")
AND VenueSettings.cashReconciliationEnabled == true
```

The first term provides the existing tier, explicit-grant, grandfathered, and demo semantics. The
second term guarantees that no current venue is activated merely because its plan grants PRO
features.

`VenueFeature` alone cannot be the opt-in because the PRO blanket grant wins when no explicit row
exists. `Module` is not used because it represents internal/free capability activation rather than
a paid-plan operational preference; combining both gate systems would create another special-case
dual resolver.

### D2. Fail closed for the new capability, never for shift closing

If plan or setting resolution is absent or fails, reconciliation is treated as disabled. The
terminal-config endpoint still responds with all its existing fields.

The close-shift route keeps only its existing authentication and `shifts:close` permission. It
must never receive `checkFeatureAccess("CASH_RECONCILIATION")`, because a plan/configuration issue
must not prevent an operator from closing a shift.

The effective flag is server-owned and is returned outside the mutable TPV settings object:

```json
{
  "data": {
    "cashReconciliationEnabled": false
  }
}
```

The TPV copies that value into its local read model with a default of `false`, but its generic
settings PUT never serializes it. This avoids making a venue-level entitlement look like editable
terminal configuration. Only the authenticated venue-settings endpoint may change the raw opt-in.

If a new `COUNTED` action arrives while effective access is false or cannot be resolved, the server
ignores that new count, closes the shift through the no-count path, leaves `cashDifference = null`,
and writes an observable warning/audit reason. It does not fabricate a zero and does not return a
feature 403. Legacy `cashDeclared` remains outside this rule.

### D3. API uses an explicit additive action and keeps legacy semantics separate

The new TPV sends one of these two shapes:

```json
{
  "cashReconciliationAction": "COUNTED",
  "countedCash": "6000.00"
}
```

```json
{
  "cashReconciliationAction": "SKIPPED"
}
```

The action distinguishes an intentional no-count close from an old APK or kiosk that never offered
reconciliation, so the audit log never guesses intent from a missing field. Absence of the action
means `NOT_REQUESTED`, not `SKIPPED`.

`countedCash` means the total physical cash in the drawer, including the starting float. It is not
cash sales and is not an amount to add to starting cash. Its preferred wire representation is a
canonical decimal string using a period and no exponent. The TPV may accept comma input locally,
but sends `BigDecimal.toPlainString()`.

For backward compatibility, the controller continues accepting the existing declaration shapes:

```json
{ "cashDeclared": 6000.00 }
{ "closeData": { "cashDeclared": 6000.00 } }
```

Those fields remain on the legacy path regardless of the new entitlement and keep their current
database and SoftRestaurant behavior. H0.6 does not silently reinterpret them as the new physical
count and does not ignore them when the new capability is disabled.

Normalization is deterministic:

1. If `cashReconciliationAction` is present, it owns the request. Legacy aliases are not used as a
   fallback.
2. `COUNTED` requires a valid `countedCash`; `SKIPPED` requires it to be absent.
3. A present but invalid higher-priority field produces `IGNORED_INVALID`; it never falls through to
   a lower-priority alias.
4. Without a new action, top-level `cashDeclared` wins over nested `closeData.cashDeclared`; both
   retain legacy behavior and produce the observational outcome `LEGACY_APPLIED`.
5. Complete absence is `NOT_REQUESTED`. Canonical new `"0.00"` is always a real physical count.
   Legacy numeric zero stays on the legacy path and is not promoted into the new feature.

The TPV request keeps its existing `venueId`, `shiftId`, and nullable `closeData` fields and adds
nullable, top-level `cashReconciliationAction` and `countedCash: String?`. Gson omits both when null,
preserving the old wire shape byte-for-byte for old call sites.

The success wrapper gains an optional root-level result; `data` remains the same Shift object, so
old clients keep parsing it unchanged:

```json
{
  "success": true,
  "data": { "id": "...", "cashDifference": "0.00" },
  "reconciliation": {
    "outcome": "APPLIED",
    "countedCash": "6000.00",
    "cashDifference": "0.00"
  }
}
```

Allowed outcomes are `APPLIED`, `SKIPPED`, `LEGACY_APPLIED`, `IGNORED_DISABLED`,
`IGNORED_INVALID`, `IGNORED_OVERFLOW`, and `NOT_REQUESTED`. The result is request-scoped;
skip/ignore/source reasons are persisted in `ActivityLog`, not guessed later from nullable Shift
columns.

### D4. Existing data semantics are preserved when no count exists

With a valid, entitled new count:

```text
Shift.cashDeclared  = countedCash        // legacy DB column, retained
Shift.endingCash    = countedCash
Shift.cashDifference = countedCash - (startingCash + totalCashPayments)
```

With neither a new count nor a legacy declaration:

```text
Shift.cashDeclared   = null
Shift.cashDifference = null
```

The pre-existing no-count and legacy-declaration behavior of `endingCash`, declaration fields, and
the SoftRestaurant close command is preserved to avoid changing old reports or integrations in
H0.6. Only an opted-in `COUNTED` close assigns the physical total directly to `endingCash`.

All serializers use nullish checks rather than truthiness so a balanced difference (`0`) and an
empty physical drawer (`countedCash = 0`) survive unchanged.

### D5. TPV interaction is blind and recoverable

When effective access is false, `CloseShiftDialog` is behaviorally and visually unchanged.

When effective access is true:

1. The dialog hides the expected cash, cash-payment total, and other monetary totals from which the
   cashier could derive the expected count.
2. It shows `Efectivo total contado` with helper copy `Incluye el fondo inicial`.
3. The value is parsed as `BigDecimal`, accepts comma or period as decimal separator, allows zero,
   and permits at most two decimal places.
4. The primary `Cerrar y conciliar` action requires a valid count.
5. A secondary `Cerrar sin conteo` action opens a confirmation explaining that no difference will
   be calculated.
6. Confirming the escape closes normally and is audited as an intentional skip.

This mirrors Square's end-vs-close distinction and Shopify's deliberate discrepancy confirmation,
while retaining the Toast-style blind count.

`ShiftDto` and the domain model gain nullable string/`BigDecimal` values for `cashDeclared` and
`cashDifference`. `ShiftClosedContent` shows the resulting `cashDifference` when present:

- `0`: `Caja cuadrada`.
- negative: `Faltante`.
- positive: `Sobrante`.
- null after an attempted count: a non-blocking warning that the shift closed without
  reconciliation.

The result stays on screen until the operator confirms it; the current two-second automatic
dismissal is disabled only for a reconciliation attempt. Shift history continues to work with old
responses and shows the stored result when present.

### D6. Kiosk remains untouched

`KioskAdminBottomSheet` continues calling the repository without a count. Kiosk shifts open with
zero starting cash and explicitly model a no-drawer flow. The new repository argument defaults to
null so this call site does not gain a prompt or a new failure mode.

### D7. Venue configuration UI

The opt-in lives under `Venue > Edit > Basic information > Operational configuration > Shift
system`. It is shown when shifts are enabled and either the plan grants the capability or the raw
setting is already true. The latter case lets a downgraded venue turn off a now-ineffective setting.

- Existing value defaults to off.
- Turning it on requires `can('venues:update')`, a resolved positive plan signal in the UI, and
  server-side PRO entitlement.
- Turning it off is always allowed.
- The mutation is immediate and audited with actor, previous value, and new value.
- If a downgraded venue still has the raw value on, the control explains that the capability is
  inactive and permits only the off transition.
- Missing/unknown plan state fails closed for this control; it does not reuse a fail-open feature
  hook. Non-entitled venues are not operationally affected; the plan catalog identifies the
  capability as PRO.

No new shift-closing permission is introduced in H0.6. The existing `shifts:close` permission
governs both counted close and the confirmed no-count escape. A future hardening phase may add a
manager-only override permission after real usage data exists.

### D8. Closing is claimed atomically and side effects happen once

The existing `ShiftStatus.CLOSING` becomes a compare-and-set claim:

```text
UPDATE Shift
SET status = CLOSING
WHERE id = shiftId AND venueId = venueId AND status = OPEN AND endTime IS NULL
```

Only the request that updates one row may calculate and finalize the shift. A concurrent request
receives `409 SHIFT_CLOSE_IN_PROGRESS`; a closed shift retains the existing already-closed error.
The final `CLOSING -> CLOSED` update and its `SHIFT_CLOSED` ActivityLog row are one database
transaction. The audit actor is the authenticated `authContext.userId`, falling back to the shift
owner only for existing trusted direct-call paths.

All external effects move after the successful database commit. The SoftRestaurant command and
Socket event are best-effort, at-most-one attempts for the winning close request. This deliberately
does not claim impossible exactly-once delivery across PostgreSQL and RabbitMQ; if the process dies
after commit and before publish, the local closed Shift remains authoritative and the TPV recovers
by refetching the shift/history rather than resending money fields.

If calculation/finalization fails before commit, a guarded `CLOSING -> OPEN` release makes the
shift retryable. A process death can leave `CLOSING`; the next close may recover a claim older than
five minutes with another compare-and-set and retry once. A fresh claim is never stolen. Tests use
an injected clock and prove one final update, one audit row, and at most one POS publish under two
concurrent requests.

### D9. Dashboard, Socket, MCP, and feature catalog stay in lockstep

- Dashboard Shift detail gets a reconciliation summary with `Caja cuadrada`, `Faltante`,
  `Sobrante`, or `Sin conteo`. It tests `cashDifference != null`, so zero is visible.
- Shift list/detail serializers and the optional Socket shift payload carry `cashDeclared` and
  `cashDifference` with nullish checks. The Socket remains additive; existing listeners ignore the
  fields and continue invalidating their queries.
- Customer MCP `list_shifts` returns the physical count and difference in pesos under its existing
  `shifts:read` permission. It does not infer an intentional skip; that reason remains available in
  the ActivityLog.
- `CASH_RECONCILIATION` is registered as an active OPERATIONS Feature and in the server seed,
  dashboard PRO catalog, and TPV mirror. The TPV mirror is informational only; runtime UI trusts
  the server-owned effective boolean.

## 4. Error and Safety Rules

- New counted money stays `Prisma.Decimal` from canonical-string normalization through
  calculation and persistence; response conversion happens only at the serialization edge.
- The new field accepts `0` through `99,999,999.99`, matching database `Decimal(10,2)`, with no
  sign, exponent, thousands separator, or more than two fractional digits.
- The TPV validates before submission. At the server boundary an invalid optional count is ignored
  and logged rather than turning shift closing into a stopper. A present invalid field never falls
  back to a legacy alias.
- If the calculated difference does not fit `Decimal(10,2)`, the physical count may still be stored
  in `cashDeclared`/`endingCash`, `cashDifference` stays null, and the result is
  `IGNORED_OVERFLOW`; the exact Decimal strings remain in the audit data.
- Atomic `OPEN -> CLOSING -> CLOSED` transitions, not a stale read, enforce one close.
- Tenant isolation remains `venueId + shiftId` at the shift lookup.
- The server is deployed before the dashboard and APK.
- Every response field is additive; no legacy field is removed or renamed.
- The migration only adds a non-null boolean with a database default of false. There is no data
  backfill and no current venue becomes active.

## 5. Known Limitation

Square includes cash paid in/out in expected drawer cash. Avoqado's `CashDrawerSession` movements
are not linked to `Shift`; attributing them by staff and overlapping timestamps would be a guess and
could assign real money to the wrong shift.

H0.6 therefore keeps the honest formula:

```text
expected = starting cash + completed cash payments
```

A venue that removes or adds cash mid-shift without a shift-linked movement may see an apparent
shortage or surplus. Linking drawer movements to shifts is a separate accounting change and is out
of scope here.

The calculation is a snapshot of payments already `COMPLETED` when the winning close request reads
them. H0.6 does not alter card-charge finalization or attempt to make an in-flight payment and drawer
close one distributed transaction; doing so inside this opt-in feature would endanger the existing
payment path. The atomic claim in D8 solves duplicate closes, not that broader payment-ledger race.

## 6. Out of Scope

- Cash denomination counting.
- Shift-linked paid-in/out and safe-deposit movements.
- Reopening or editing a closed drawer from TPV.
- Mandatory manager PIN for `Cerrar sin conteo`.
- Card/voucher declaration and reconciliation.
- Per-terminal activation.
- Changes to Android/iOS general POS apps or Avoqado Desktop; H0.6 concerns `avoqado-tpv` while
  preserving Desktop's active legacy close contract.

## 7. Acceptance Criteria

1. A current venue with no new setting and no declaration follows the old TPV close flow and stores
   `cashDifference = null`; an active Desktop legacy declaration remains applied.
2. A FREE venue without an explicit grant or exemption cannot activate reconciliation; its close
   flow remains unchanged.
3. A PRO/PREMIUM/eligible exempt venue with the setting off remains unchanged.
4. An eligible venue with the setting on sees the blind count UI.
5. `COUNTED` with `countedCash = startingCash + cashSales` produces and returns
   `cashDifference = 0` and outcome `APPLIED`.
6. A zero physical count is persisted as zero and produces the correct shortage.
7. Blank, `SKIPPED`, invalid, overflowed, or unauthorized new input never becomes a fabricated zero
   and never prevents the shift from closing; each produces its explicit outcome/audit reason.
8. Old top-level and nested declaration shapes remain accepted and retain their existing ungated
   behavior.
9. Kiosk closure remains unchanged.
10. Dashboard detail, TPV result/history, Socket types, and customer MCP preserve zero as a real
    balanced result rather than missing data.
11. Toggle changes and every close disposition are auditable with the authenticated actor and
    Decimal inputs/results.
12. Two concurrent close requests yield one `CLOSED` transition, one audit row, and at most one POS
    command; a stale `CLOSING` claim is recoverable without stealing a fresh claim.
13. The TPV result stays visible until acknowledgment after an attempted reconciliation.
14. Server tests, dashboard tests/build, TPV unit tests/compile, cross-repo contract checks, and a
    real local-DB close flow pass before H0 is reported complete.

## 8. Rollout

1. Deploy the additive server migration, server normalization, effective gate, and response fixes.
2. Verify old close payloads against a local production-shaped clone.
3. Deploy the dashboard opt-in, still default off everywhere.
4. Ship the TPV APK; no venue sees the new dialog until explicitly enabled.
5. Enable one internal/demo venue, monitor logs and `cashDifference` outcomes, then enable selected
   PITS venues.
