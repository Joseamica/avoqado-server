# Master catalog H1A HTTP API

Version: H1A / schema v1. Base prefix: `/api/v1`.

This document describes the additive H1A routes mounted by the server. Existing Product endpoints and envelopes are unchanged.

## Authentication and tenant authority

All routes require the normal HTTP-only authenticated session.

| Surface                   | Route scope                                        | Authority                                                                                                                            |
| ------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Organization catalog      | `/dashboard/organizations/:orgId/master-catalog/*` | Active Staff + active StaffOrganization for the exact org. OWNER/ADMIN command, VIEWER read, MEMBER denied. No impersonated command. |
| Venue projection/override | `/dashboard/venues/:venueId/master-catalog/*`      | Active Staff + active StaffVenue and exact `catalog-venue:read` or `catalog-venue:request-override`.                                 |
| Control plane             | `/superadmin/master-catalog/*`                     | Live active SUPERADMIN assignment, active Staff, no impersonation.                                                                   |

Cross-tenant and unknown child identifiers are resolved inside the authorized tenant and return indistinguishable 404 responses. Body/query
scope keys such as a forged `organizationId`, `orgId`, or venue scope are rejected before service invocation.

MASTER_CATALOG requires an explicit organization entitlement, enabled organization-only module assignment, supported schema-v1 config, and
the gate required by the operation. Dependency outage maps to a stable 503; an unknown config fails closed.

## Response and error envelopes

Successful handlers use the platform envelope:

```json
{
  "success": true,
  "data": {}
}
```

Errors use the platform AppError envelope with stable HTTP status and code. Common classes:

- 401 unauthenticated;
- 403 live role, membership, permission, entitlement, module, config, or gate denial;
- 404 tenant-scoped organization/venue/item/batch/line not found;
- 409 stale preview, idempotency reuse, concurrent change, lineage conflict, or durable-result mismatch;
- 413 workbook/target/output capacity exceeded;
- 422 closed input, invalid workbook, unsupported operation/schema, or malformed multipart;
- 503 access/readiness dependency unavailable.

Do not branch clients on translated messages. Use the stable code and HTTP status.

## Organization routes

Base: `/api/v1/dashboard/organizations/:orgId/master-catalog`.

### Access and catalog items

| Method | Path                           | Purpose                                                        |
| ------ | ------------------------------ | -------------------------------------------------------------- |
| GET    | `/access`                      | Effective H1 access/gates for the authenticated actor.         |
| GET    | `/items`                       | Cursor-paginated corporate items.                              |
| POST   | `/items`                       | Create an item with exact v1 references/values/business types. |
| GET    | `/items/:catalogItemId`        | Tenant-scoped item detail.                                     |
| PATCH  | `/items/:catalogItemId`        | Revision-checked managed update.                               |
| POST   | `/items/:catalogItemId/retire` | Retire without erasing identifier/provenance history.          |

Catalog item input is closed. Corporate SKU identity uses the shared normalization contract; money, tax, SAT, lifecycle, product type,
family hierarchy, and prepared-dish readiness are server validated.

### Validation profiles and references

| Method   | Path                                             | Purpose                               |
| -------- | ------------------------------------------------ | ------------------------------------- |
| GET      | `/validation-profiles`                           | Active/historical profile view.       |
| POST     | `/validation-profiles/preview`                   | Preview a versioned profile change.   |
| POST     | `/validation-profiles/:profileBatchId/confirm`   | Confirm exact preview authority.      |
| GET/POST | `/catalogs/brands`                               | List/create brands.                   |
| PATCH    | `/catalogs/brands/:brandId`                      | Revision-checked brand update.        |
| POST     | `/catalogs/brands/:brandId/retire`               | Retire brand.                         |
| GET/POST | `/catalogs/manufacturers`                        | List/create manufacturers.            |
| PATCH    | `/catalogs/manufacturers/:manufacturerId`        | Revision-checked manufacturer update. |
| POST     | `/catalogs/manufacturers/:manufacturerId/retire` | Retire manufacturer.                  |
| GET/POST | `/catalogs/families`                             | List/create root or leaf families.    |
| PATCH    | `/catalogs/families/:familyId`                   | Revision-checked family update.       |
| POST     | `/catalogs/families/:familyId/retire`            | Retire family.                        |

Profile confirmation and reference writes are atomic with classified audit. Profile rules are schema v1 and fail closed on unknown rule
shape/version.

### XLSX imports and exports

| Method | Path                                                      | Purpose                                                          |
| ------ | --------------------------------------------------------- | ---------------------------------------------------------------- |
| GET    | `/exports/catalog-master.xlsx`                            | Tenant master export.                                            |
| GET    | `/exports/catalog-by-business-type.xlsx?businessType=...` | Filtered export with RequiredFields.                             |
| GET    | `/templates/catalog-master-import-v1.xlsx`                | Empty exact import template.                                     |
| POST   | `/imports/preview`                                        | Multipart field `file`, one XLSX, max compressed request 10 MiB. |
| GET    | `/imports/:importBatchId`                                 | Actor-bound durable preview/recovery view.                       |
| GET    | `/imports/:importBatchId/errors.xlsx`                     | Actor-bound durable error workbook.                              |
| POST   | `/imports/:importBatchId/confirm`                         | Confirm preview token/idempotency authority.                     |

`imports/preview` rejects extra multipart files/fields, malformed headers, truncated forms, MIME/OOXML mismatch, macros/external
links/formulas, invalid exact sheets/columns, unsafe XML, excessive compression, and capacity overflow. Preview creates no catalog
mutations. Confirmation revalidates dependencies and writes all-or-nothing.

See [catalog-master-v1.md](../xlsx/catalog-master-v1.md) and [catalog-master-import-v1.md](../xlsx/catalog-master-import-v1.md).

### Binding

| Method | Path                | Purpose                                |
| ------ | ------------------- | -------------------------------------- |
| POST   | `/bindings/preview` | Preview LINK, CREATE, or SKIP targets. |
| POST   | `/bindings/confirm` | Confirm the exact batch/token/key.     |

LINK preserves the existing Product. CREATE materializes an inactive Product from validated catalog authority. SKIP does not create a
Product. Prepared-dish readiness, binding revision, item invariant, Product type, tenant references, and audit are rechecked in the
confirmation transaction.

### Publication, activation, and reversal

| Method | Path                                                          | Purpose                                                                                         |
| ------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| POST   | `/publications/preview`                                       | Preview one of the three v1 publication operations.                                             |
| POST   | `/publications/:publicationBatchId/confirm`                   | Confirm a previewed operation.                                                                  |
| GET    | `/publications`                                               | Cursor-paginated batches.                                                                       |
| GET    | `/publications/:publicationBatchId`                           | Tenant-scoped batch detail.                                                                     |
| GET    | `/publications/by-idempotency-key/:operation/:idempotencyKey` | Recovery without re-exposing a preview bearer. This static route precedes the dynamic ID route. |
| POST   | `/publications/:publicationBatchId/reversal/preview`          | Preview reversal of lines belonging to the route batch.                                         |

Operations:

- `CATALOG_FIELDS_PUBLISH`: publish managed fields with per-field decisions;
- `CATALOG_PRODUCT_ACTIVATION`: only `active:false -> true`, with exact publication/readiness/override provenance;
- `CATALOG_FIELDS_REVERSION`: restore managed history with `supersedes`/`reverses` lineage.

Target cap is 10,000; persistence chunks are at most 500. Confirmation uses attempt/organization/row/recipe locks, exact durable dual
authority, leases, compare-and-set completion, classified audit, and outbox. Same key plus different request is rejected. A lost PREVIEWED
bearer is never recovered in plaintext; use a new key.

### Organization audit

| Method | Path             | Purpose                                   |
| ------ | ---------------- | ----------------------------------------- |
| GET    | `/audit/actions` | Bounded action vocabulary for filters.    |
| GET    | `/audit`         | Organization-scoped H1 ActivityLog query. |

The query always ANDs tenant scope with optional venue/action/entity/actor/date/search filters, sorts by `(createdAt DESC, id DESC)`, and
includes organization rows even when the actor has zero venues.

## Venue routes

Base: `/api/v1/dashboard/venues/:venueId/master-catalog`.

| Method | Path                                         | Permission/purpose                                                      |
| ------ | -------------------------------------------- | ----------------------------------------------------------------------- |
| GET    | `/access`                                    | Live venue access and effective gate state.                             |
| GET    | `/products/:productId/provenance`            | Bound Product/catalog/publication provenance.                           |
| GET    | `/changes`                                   | Incremental venue changes.                                              |
| POST   | `/override-requests/preview`                 | `catalog-venue:request-override`; preview 1..25 managed-field requests. |
| POST   | `/override-requests/:requestBatchId/confirm` | Confirm exact token/key and create REQUESTED decisions/audit.           |

Venue override preview does not auto-confirm. Values are derived server-side from Product/binding authority; a client cannot smuggle an
arbitrary before/after value.

## Superadmin routes

Base: `/api/v1/superadmin/master-catalog`.

| Method | Path                                                        | Purpose                                                                                   |
| ------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| GET    | `/organizations`                                            | Cursor-paginated organization list after live SUPERADMIN recheck.                         |
| GET    | `/organizations/:organizationId`                            | Entitlement, module, config/access, per-venue rollout/readiness, last actor/date/failure. |
| PUT    | `/organizations/:organizationId/entitlement`                | Explicit commercial grant/revoke with reason and time window.                             |
| PUT    | `/organizations/:organizationId/module`                     | Enable/disable exact organization-only module assignment.                                 |
| PUT    | `/organizations/:organizationId/config`                     | Replace exact schema-v1 config.                                                           |
| PUT    | `/organizations/:organizationId/venues/:venueId/governance` | Only the write-once transition to `ENFORCED`.                                             |

Every mutation returns server-authoritative values:

```json
{
  "success": true,
  "data": {
    "before": {},
    "after": {}
  }
}
```

The UI must show confirmation before calling a mutation and must display this returned before/after. No endpoint edits Product, price, or
corporate content.

## Idempotency and recovery rules

- Keys are scoped by organization plus operation.
- Keys and request bodies are canonicalized/versioned; equivalent retries converge.
- Same key with a different canonical request is a 409 reuse error.
- Preview tokens are random bearers; only their hash is durable.
- Confirmation compares the token in constant time where applicable and requires `confirm=true`.
- Batch and idempotency record are dual durable authority; forged/mismatched schema, actor, dependencies, target hash, result, lease, or
  terminal state fails closed.
- Applied results are validated against relational lines before replay.
- Watchdog/outbox workers use leases and compare-and-set; APPLIED remains immutable.

## Compatibility

- Legacy Product HTTP payloads and fixtures remain byte-compatible.
- Organizations without an explicit grant/module/config remain on the no-H1 path.
- Regional export sheets exist in H1A but are header-only. Regional identifiers/pricing are not available until H1B/H1C.
- Disabling access stops new H1 mutations but does not delete Products or durable catalog history.
