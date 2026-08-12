# PITS H1A master catalog rollout runbook

Status: software candidate, default-off. Last reviewed: 2026-08-10.

This runbook covers the H1A corporate catalog core. It does not authorize a PITS grant, a production rollout, regional identifiers, or
regional pricing. Those decisions remain explicit operator actions.

## Non-negotiable safety model

- `MASTER_CATALOG` is an `ORGANIZATION_ONLY` module definition.
- A definition is not an assignment. An assignment is not an entitlement. Neither enables a gate by itself.
- The effective organization config is schema v1 and starts with `catalogCoreEnabled=false`, `identifiersEnabled=false`,
  `regionalPricingEnabled=false`, and `governanceMode=OFF`.
- PITS receives no automatic entitlement, module assignment, config, catalog row, binding, or rollout row from migrations or deploys.
- Content commands require active Staff plus an active `StaffOrganization` membership. OWNER/ADMIN may mutate corporate content; VIEWER is
  read-only; MEMBER is denied.
- Venue reads and override requests re-check active `StaffVenue` membership and the exact `catalog-venue:*` permission.
- SUPERADMIN control-plane writes require a live active SUPERADMIN assignment and no impersonation.
- Preview never authorizes confirm. Confirm re-checks actor, tenant, gates, durable dependency snapshots, hashes, locks, idempotency, and
  staged relational authority.

## Deployment order

1. Deploy `avoqado-server` with expand-only migrations and all gates off.
2. Verify API health, migration state, schema map, permissions audit, jobs, and default-off probes.
3. Deploy `avoqado-web-dashboard`. Its H1 UI remains hidden unless the auth-status access envelope says it is readable.
4. Deploy `avoqado-superadmin`. The control page is `/master-catalog`; it exposes only commercial/control-plane state.
5. Do not grant PITS in the deployment transaction or seed.
6. Run a canary first in an isolated organization created for H1 verification.

Dashboard can auto-deploy independently of the server. Never deploy a dashboard build that expects H1 routes until the matching backend
environment is healthy. Render staging may be suspended and Fly auto-deploy may be disabled; use an explicitly owned isolated backend rather
than assuming `develop` is live.

## Required preflight evidence

Record each item with timestamp, environment, operator, commit, and log link.

- Server commit containing the intended H1A code and migrations.
- Dashboard and superadmin commits built against the same API contract.
- Disposable `H1_TEST_DATABASE_URL`; the wrapper must reject missing, shared, or production-like URLs.
- `prisma migrate status`, `prisma validate`, generated client, schema map check, and permissions audit.
- The exact unit/API/integration matrix in the H1A implementation plan.
- Dashboard targeted tests, lint, and production build.
- Superadmin targeted tests, `npm run check`, and production build.
- Zero unexpected catalog, entitlement, organization-module, rollout, import, binding, publication, or ActivityLog rows after applying
  migrations to an empty/default-off organization.
- Legacy Product/menu/inventory/recipe/order fixtures unchanged for a non-H1 organization.

## Default-off database probe

Run only on the disposable database.

1. Apply every migration.
2. Query the `Module` definition for `MASTER_CATALOG`; require `scope=ORGANIZATION_ONLY` and schema-v1 config defaults all false/OFF.
3. Require zero `OrganizationEntitlement` rows with `featureCode=MASTER_CATALOG` unless the test itself created them.
4. Require zero `OrganizationModule` assignments to the master-catalog definition unless the test itself created them.
5. Require zero catalog domain rows for the test organization before fixtures are inserted.
6. Run one legacy Product create/update/read flow and verify no H1 access, registry, binding, publication, or audit side effects.

If any row is synthesized by migration or seed, stop. Do not continue to canary.

## Canary sequence

Use a non-customer organization and data prefixed `H1A-CANARY-`.

### Phase 1: commercial authority

1. In superadmin `/master-catalog`, select the canary organization.
2. Confirm the page shows no explicit grant, no implicit PITS grant, and the server-provided before state.
3. Create an explicit `CONTRACT` or `CUSTOM` entitlement with reason, startsAt, and optional endsAt.
4. Confirm the dialog and retain the server-returned before/after evidence.
5. Enable the organization module assignment and retain before/after.
6. Keep all schema-v1 gates false and governance OFF.

### Phase 2: read-only catalog authoring

1. Enable only `catalogCoreEnabled` for the canary.
2. Verify OWNER/ADMIN authoring, VIEWER read-only, MEMBER denial, revoked membership denial, impersonation denial, and cross-tenant 404.
3. Export the template and master workbook. Verify Metadata, exact sheets/columns, typed cells, formula neutralization, caps, and tenant
   scope.
4. Preview an import with a new idempotency key. Inspect durable validation errors; do not confirm yet.
5. Retry the same key/body and verify convergence. Retry the same key with a different body and require key-reuse rejection.
6. Confirm only after the preview is accepted and the bearer token is still available.

### Phase 3: binding and publication

1. Preview bindings and verify LINK preserves the existing Product; CREATE creates an inactive Product; SKIP writes no Product.
2. Confirm under the same actor and organization. Verify audit rollback and replay behavior.
3. Preview a field publication. Confirm that managed-field decisions, Product/binding writes, audit, and outbox co-commit.
4. Verify outbox delivery order, retry, stable eventId/venue sequence, and dead-letter behavior.
5. Verify activation only changes `active` after exact publication provenance, readiness, approvals, and revisions.
6. Verify reversal links `supersedes`/`reverses` to the correct managed publication history.

### Phase 4: identifiers and venue governance

`identifiersEnabled` and `governanceMode` remain off until registry preflight, client readiness, and canary evidence are complete.

1. Advance registry rollout only through documented states to `READY`.
2. Set required client families and minimum versions. Missing, stale, malformed, or incompatible observations remain not-ready.
3. A readiness override must be explicit, expiring, audited, and scoped to the failing family (or all families with `family=null`).
4. Enable identifiers only after registry readiness.
5. Transition a venue to `ENFORCED` only from `READY_TO_ENFORCE`. The cutoff is write-once.
6. Repeat exact-cutoff transition and verify it is a no-op with no duplicate audit.

## Observability

Correlate every canary operation across API response, database rows, ActivityLog, outbox, job logs, and UI.

Watch at minimum:

- access reason codes and dependency-unavailable responses;
- import/binding/publication state, attemptId, heartbeat, lease expiry, failure code/message;
- outbox pending/claimed/delivered/dead-letter counts and oldest pending age;
- watchdog recoveries and compare-and-set failures;
- venue registry/alias/governance state and identifier revision;
- required client observations, stale age, minimum-version mismatch, and active overrides;
- catalog audit actor type, staff/service principal, organization, venue, reason, before/after;
- legacy Product writer rejections after ENFORCED.

Suggested alerts:

- any H1 5xx or dependency outage sustained for five minutes;
- APPLYING lease expired without watchdog recovery;
- outbox oldest pending age above two sweep intervals;
- dead-letter count above zero;
- governance transition attempted while readiness is not satisfied;
- cross-tenant/permission denial burst;
- migration or schema-map drift.

## Rollback and containment

The first response is disablement, not data deletion.

1. Stop new catalog commands by setting config gates false.
2. Disable the `OrganizationModule` assignment if broader containment is needed.
3. Revoke the entitlement if commercial access must stop.
4. Keep jobs running long enough to settle already committed outbox events; do not delete durable history.
5. Use publication reversal for managed content changes. Do not hand-edit Product snapshots or publication lineage.
6. Do not clear `productIdentifierRegistryRequired`, bootstrap timestamps, governance cutoff, identifier revision, or applied audit rows.
   They are monotonic evidence.
7. If a migration phase fails, follow its exact resume/rollback instructions; never mark a phase applied without verifying constraints and
   indexes.

Disabling H1 must leave legacy Product reads and permitted legacy operations available. If it does not, treat it as a release blocker.

## PITS acceptance boundary

Software readiness and customer acceptance are separate.

Still required before a PITS grant:

- signed field/layout matrix and real sample workbook;
- confirmed business-type and required-field profiles;
- named PITS OWNER/ADMIN users and venue permission assignments;
- disposable/full-test evidence with the exact PITS-shaped fixture;
- client-family/version inventory and device canary owner;
- acceptance of H1A limitations: Regions and RegionalValues are header-only; regional identifiers/pricing remain H1B/H1C unavailable;
- rollback owner, monitoring owner, and maintenance window.

Record approval in the handoff/bitácora. A deploy, demo, tier, or migration is never approval.

## Customer collateral evidence

The source-of-truth collateral is in `Avoqado-HQ/operations/marketing/platform-presentation/`.

| Artifact                 | Owner                | Evidence/status                                                                                                                                               |
| ------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V2 platform PDF          | Marketing/commercial | 29 pages, catalog claim present, all pages rasterized for Task 15 visual QC                                                                                   |
| PAX/Blumon PDF           | Marketing/commercial | 29 pages, reforked claim present, text guard contains no NexGo or non-Blumon processor                                                                        |
| V2 and client one-pagers | Marketing/commercial | one letter page each; catalog claim present and regional scope labeled next phase                                                                             |
| Clickable web deck       | Marketing/commercial | **PENDING external action**: owner must publish/share the artifact and record its URL plus screenshot; no Git artifact or public URL exists in this workspace |

Do not substitute the local `file://` HTML or generated PDF for the public clickable-deck URL. The missing URL/evidence is a commercial
handoff blocker, not a software rollout blocker.

## Operator checklist

- [ ] Disposable database verified and snapshotted.
- [ ] Exact automated gates are green.
- [ ] Legacy fixtures are unchanged.
- [ ] No implicit grant/assignment/config/rollout rows exist.
- [ ] Server deployed and healthy before clients.
- [ ] Canary organization only.
- [ ] Explicit entitlement and module before/after retained.
- [ ] Config gates advanced one at a time.
- [ ] Import, binding, publication, activation, reversal, audit, and outbox correlated.
- [ ] Client readiness and registry evidence complete.
- [ ] PITS contractual blockers resolved before any PITS grant.
- [ ] Rollback owner and monitoring window assigned.
