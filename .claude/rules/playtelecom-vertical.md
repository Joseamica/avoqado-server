# PlayTelecom — Custom White-Label Vertical (know this before touching it)

`PlayTelecom` shows up constantly in this codebase (scripts, service docstrings, seed data, Asana project "Bait <> Play Telecom"). This file
exists so you don't have to re-derive who they are and what's generic vs bespoke every time.

## Who's who (business context — not in the schema anywhere)

- **PlayTelecom** = the org client in Avoqado (Isaac Mayoral is the primary contact, `glossary.md` calls it "cliente/partner de integración,
  contexto de servicios telecom").
- **Bait** = the telecom company whose prepaid SIM lines PlayTelecom's promoters sell and activate. Bait does not appear in code — it's a
  real-world brand behind the product.
- **Walmart / Bodega Aurrerá Express** = the host retail chain. PlayTelecom's promoters work physical counters _inside_ Bodega Aurrerá
  Express stores — that's why venues are named `BAE <sucursal>` (e.g. "BAE Unidad Pavón", "BAE Papagayo"), across Querétaro + San Luis
  Potosí (~39 venues).
- **Why sale-verification approval exists:** Walmart pays PlayTelecom only for SIM sales with correct documentation (ID linking /
  portabilidad proof). Back-office (org OWNER) must approve/reject each promoter's sale before it counts as revenue — see
  `src/services/dashboard/sale-verification.dashboard.service.ts` (venue-scoped) and `sale-verification.org.dashboard.service.ts`
  (org-level, delegates to the venue service).

## Core principle: generic primitives, config-driven, never hardcoded

`.claude/rules/critical-warnings.md` already states the rule — repeating it here because this is exactly where it bites:

```typescript
if (venue.slug === 'playtelecom') { ... }  // WRONG — never do this
```

Everything PlayTelecom uses is a **generic, Module-gated feature** that any other tenant could also turn on. PT is the first (and so far
only) real tenant exercising these paths at scale, but the code must stay tenant-agnostic. Full generic-mechanism doc:
`docs/features/SERIALIZED_INVENTORY.md`. This file only covers what that doc doesn't: the custody/promoter/cash-out layer and the truly
bespoke pieces.

## What's generic (reused infrastructure, gated independently of paid tier)

| Primitive                  | Model / service                                                                                                                                                     | PT's use                                                                                                          | Gate                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Feature flags              | `Module` (`prisma/schema.prisma:7537`) / `VenueModule` (`:7565`) / `OrganizationModule` (`:7593`)                                                                   | `SERIALIZED_INVENTORY`, `WHITE_LABEL_DASHBOARD`, `COMMISSIONS` enabled at **org level** for PT                    | `moduleService.isModuleEnabled(venueId, MODULE_CODES.X)` — **never** the Feature/tier resolver. Full rule: `feature-gating.md`  |
| Serialized goods + custody | `SerializedItem` (`:7664`), chain `ADMIN_HELD → SUPERVISOR_HELD → PROMOTER_PENDING → PROMOTER_HELD → SOLD` (`custodyState`), `SerializedItemCustodyEvent` (`:7827`) | ICCIDs — `serialNumber` comment literally says "Barcode, ICCID, certificate, etc." — PT just configures the label | `SERIALIZED_INVENTORY` module                                                                                                   |
| Categories                 | `ItemCategory` (`:7621`)                                                                                                                                            | PT's SIM types (seeded, org-level)                                                                                | n/a — org-scoped data, not a gate                                                                                               |
| Commissions payout         | Cash Out (`src/services/dashboard/cash-out/`)                                                                                                                       | promoter same-day commission                                                                                      | appears wherever `SERIALIZED_INVENTORY` is enabled — **not** its own module/tier (founder decision)                             |
| Sale approval              | `sale-verification*` services above                                                                                                                                 | Walmart-payment gate                                                                                              | permission `sale-verifications:review` (MANAGER+)                                                                               |
| Promoters                  | `src/services/promoters/promoters.service.ts`                                                                                                                       | attendance, sales stats, deposits                                                                                 | its own docstring literally says "for the PlayTelecom/White-Label dashboard" — generic-shaped but not yet generalized in naming |

**Module vs Feature — do not cross them.** `SERIALIZED_INVENTORY`/`WHITE_LABEL_DASHBOARD` are `Module` codes (no pricing, no Stripe) —
completely independent of the `Feature`/tier system (`CFDI`, `INVENTORY_TRACKING`...). Crossing the resolvers fails **silently** because
most prod venues are grandfathered (a wrong-system gate "passes" for everyone). Full table: `.claude/rules/feature-gating.md`. Also:
serialized ↔ white-label are independent modules — PT has both at org level, but requiring one for the other would break a tenant with only
one.

## What's genuinely bespoke to PlayTelecom (don't generalize further without asking)

- **One-off scripts** — `scripts/setup-playtelecom.ts`, `setup-playtelecom-complete.ts`, `cleanup-playtelecom-users.ts`,
  `temp-fix-playtelecom-estructura.ts`, `temp-fix-playtelecom-supervisors-v2.ts`. Re-runnable, resolve staff/venues by normalized name at
  runtime (safe to point at prod). This is the founder's explicit pattern for fixing PT-only data gaps — see next point.
- **`requiresOwnerApproval`** on `SerializedItem` (`:7720`) — PT's "only Virtual-origin SIMs are trusted, everything else needs OWNER
  approval" business rule. Additive, defaults `false`, zero effect on any other org.
- **5 sale-rejection reasons** — `SaleVerificationRejectionReason` enum (`:6218`): missing linking image, missing portabilidad, illegible
  images, duplicate vinculación, other. Tuned to PT/Walmart's specific documentation requirements.
- **"Cubre Descanso"** — an operational pattern, not code: a shared placeholder venue (no city, `SERIALIZED_INVENTORY` + `COMMISSIONS`
  modules, borrowed merchant config from a real BAE store) for relief/temp promoters covering someone's day off. Their sales land in "Cubre
  Descanso" and get manually reassigned weekly to the real store they covered, keyed by date + promoter (no automation yet — revisit if
  volume grows).
- **Founder's explicit stance (2026-06-23):** do NOT harden the generic bulk-venue-creation path (`bulkVenueCreation.service.ts`) to fix
  PT-only data gaps like missing city/state or an auto-assigned MANAGER — "no quiero romper lo escalable de avoqado." Fix those gaps via the
  re-runnable by-name scripts above, never by changing the shared creation path.

## Gotchas that specifically bite PlayTelecom flows

- **ICCID case sensitivity**: a handful of legacy `SerializedItem` rows are lower-cased (pre-`normalizeSerial()`). Any NEW serial lookup
  must match case variants (`trimmed`, `.toUpperCase()`, `.toLowerCase()`), never an exact/re-normalized match — bit
  `markAsReturned`/`markAsDamaged`/`find_order` before.
- **Staff removal is always soft-delete** (`Staff.active=false` + `StaffVenue.active=false`) — many financial/audit tables FK to `Staff.id`;
  a hard `DELETE` cascades and wipes real paid sales. Before deactivating a promoter, verify: SIMs currently held
  (`SerializedItem.assignedPromoterId`), pending sales (`Order`/`SaleVerification`/ `SimRegistrationRequest` not yet completed).
- **Moving a PT terminal between stores** (e.g. a "Cubre Descanso" relief promoter's PAX getting re-parented to the real store) is a
  money-safety issue, not just a config change — see `avoqado-tpv/.claude/rules/serialized-inventory-and-sim-custody.md`.
