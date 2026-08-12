# Master catalog H1A MCP contract

Version: H1A / tool contract v1.

The customer MCP server conditionally advertises exactly seven master-catalog tools. They are organization-only and reuse the same services,
authorization, preview/confirm, idempotency, validation, audit, and tenant boundaries as HTTP.

## Advertisement and scope

Catalog tools are advertised only when the connection resolves a live active organization membership and effective readable MASTER_CATALOG
access for that organization. Venue fallback and `anyVenue` do not advertise organization catalog tools. SUPERADMIN is not an implicit
customer-organization identity.

Every call rechecks:

- active Staff;
- active StaffOrganization and exact active organization;
- supported entitlement/module/config/gate;
- operation capability;
- venue membership/permission for a venue override.

Writes additionally require the unconditional MCP OAuth scope `mcp:write`. A feature flag, role, or venue permission never substitutes for
it. Impersonated catalog command is denied.

## Exact tool set

| Tool                          | Class                 | Shared service contract                                      |
| ----------------------------- | --------------------- | ------------------------------------------------------------ | ------------------------------------------- |
| `list_catalog_items`          | read                  | Corporate item cursor page, max 100.                         |
| `get_catalog_item`            | read                  | One tenant-scoped item by ID.                                |
| `preview_catalog_import`      | write preview         | Base64 XLSX preview using the same import worker/validator.  |
| `confirm_catalog_import`      | write confirm         | Exact import batch/token/idempotency key and `confirm=true`. |
| `preview_catalog_publication` | write preview         | Three publication operations, target cap 10,000.             |
| `confirm_catalog_publication` | write confirm         | Exact publication batch/token/key and `confirm=true`.        |
| `request_catalog_override`    | write preview/confirm | One tool with explicit `phase=PREVIEW                        | CONFIRM`, venue permission, request cap 25. |

No MCP tool grants entitlements, changes module/config/rollout, or edits prices/content outside the shared H1 command services.

## Read tools

### `list_catalog_items`

Input:

```json
{
  "cursor": "optional signed/opaque cursor",
  "pageSize": 25,
  "status": "ACTIVE"
}
```

- `pageSize`: 1..100.
- `status`: `ACTIVE` or `RETIRED`.
- Unsupported filters are not advertised.

### `get_catalog_item`

Input:

```json
{ "catalogItemId": "catalog-item-id" }
```

ID length is 1..256. Foreign and missing items are indistinguishable in the active organization.

## Import tools

### `preview_catalog_import`

Input:

```json
{
  "fileBase64": "UEsDB...",
  "originalFilename": "catalog-master-import-v1.xlsx"
}
```

- `fileBase64` is bounded before decode.
- The decoded buffer is passed to the same MIME/OOXML worker boundary as HTTP.
- Preview writes only durable staging/idempotency/audit summary; it does not mutate catalog content.

### `confirm_catalog_import`

Input:

```json
{
  "importBatchId": "batch-id",
  "previewToken": "one-time-bearer",
  "idempotencyKey": "caller-key",
  "confirm": true
}
```

The tool calls the shared import confirmation service. It does not add a second audit and does not auto-confirm.

## Publication tools

### `preview_catalog_publication`

Input:

```json
{
  "operation": "CATALOG_FIELDS_PUBLISH",
  "idempotencyKey": "utf8-byte-bounded-key",
  "targets": []
}
```

Allowed operations:

- `CATALOG_FIELDS_PUBLISH`;
- `CATALOG_PRODUCT_ACTIVATION`;
- `CATALOG_FIELDS_REVERSION`.

Targets are 1..10,000. The idempotency key uses the shared Task 9 UTF-8 byte validator: 1..256 bytes, including multibyte boundaries.

### `confirm_catalog_publication`

Input:

```json
{
  "publicationBatchId": "batch-id",
  "previewToken": "one-time-bearer",
  "idempotencyKey": "same-caller-key",
  "confirm": true
}
```

The shared confirmation service rechecks live organization authority, gates, target/dependency hashes, locks, relational staging, lease/CAS,
audit, and outbox.

## Venue override tool

`request_catalog_override` uses an explicit phase union. It first rechecks active organization READ access plus `mcp:write`, then resolves
the venue inside that organization and applies the exact HTTP venue permission `catalog-venue:request-override`. An organization VIEWER who
is a venue MANAGER can request an override if the live permission allows it; corporate content mutation authority is not substituted.

Preview:

```json
{
  "phase": "PREVIEW",
  "venueId": "venue-id",
  "bindingId": "binding-id",
  "idempotencyKey": "caller-key",
  "requests": [
    {
      "field": "name",
      "reason": "Local legal naming requirement"
    }
  ]
}
```

Confirm:

```json
{
  "phase": "CONFIRM",
  "venueId": "venue-id",
  "requestBatchId": "request-batch-id",
  "previewToken": "one-time-bearer",
  "idempotencyKey": "same-caller-key",
  "confirm": true
}
```

Managed fields are the exact shared Task 8 allowlist. Requests are 1..25 and reasons are 1..1,000 characters. PREVIEW and CONFIRM shapes are
strict and mutually exclusive.

## Result and error behavior

Tool results are JSON serialized through the standard MCP text response helper. Zod rejects malformed tool input before any shared service
call. Service errors preserve the platform's stable classification rather than returning a partially successful tool result.

Important outcomes:

- missing/revoked membership: scope/authorization error;
- missing `mcp:write`: denied before mutation service;
- foreign venue/item/batch: tenant-scoped not found;
- unknown config/dependency outage: fail closed;
- preview bearer lost: never re-exposed from storage;
- same idempotency key/different request: conflict;
- valid retry: convergent shared result;
- stale dependency or concurrent change: no partial catalog/Product mutation.

## Operator verification

Use a real SDK client and in-memory transport for contract tests, not a synthetic tool object. Verify:

- tools/list contains exactly the seven names only when organization access is effective;
- schema rejection happens through the SDK;
- read/write scope separation;
- live membership revocation between calls;
- cross-tenant foreign/missing behavior;
- publication target 10,000/10,001;
- override request 25/26;
- publication idempotency ASCII and multibyte 256-byte boundaries for preview and confirm;
- PREVIEW never calls confirm and CONFIRM never calls preview;
- no duplicate audit around shared services.
