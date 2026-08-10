# Catalog master import XLSX V1

This is the closed write contract for `catalog-master-import-v1.xlsx`. The template is downloaded from:

```http
GET /api/v1/dashboard/organizations/:orgId/master-catalog/templates/catalog-master-import-v1.xlsx
```

Previewing an import never mutates catalog data. A separate, explicit confirmation applies the staged proposal.

## Package and Metadata

The upload must be a valid `.xlsx` OOXML ZIP. Macro-enabled workbooks, formulas, external links, arbitrary XML parts, duplicate ZIP entries,
path traversal, duplicate sheets, extra sheets, extra columns, reordered headers, and unsupported cell types are rejected before catalog
validation.

The workbook has exactly five sheets in this order:

1. `Metadata`
2. `Items`
3. `OrganizationValues`
4. `BusinessTypes`
5. `VenueBindingRequests`

`Metadata` has columns `key,value` and exact grain `(key,value)`. The template contains these seven rows, sorted by that grain:

| key              | value                                                                      |
| ---------------- | -------------------------------------------------------------------------- |
| `documentType`   | `catalog-master-import`                                                    |
| `filters`        | `{}`                                                                       |
| `generatedAt`    | RFC3339 UTC timestamp                                                      |
| `organizationId` | route organization ID                                                      |
| `profileVersion` | sorted CSV of applicable active profile versions, or `1` for baseline only |
| `schemaVersion`  | `1`                                                                        |
| `timezone`       | organization timezone                                                      |

Metadata identity is checked against the authenticated route organization. A workbook cannot choose a different organization through a cell,
filename, multipart field, query, body, or bearer claim.

## Closed sheet columns

### Items

```text
operation, catalog_item_id, expected_revision, corporate_sku, item_kind,
name, description, image_url, brand, manufacturer, family, subfamily,
presentation, unit, product_type, iva_rate, sat_product_key, sat_unit_key,
objeto_imp, ieps_mode, ieps_rate, ieps_quota, ieps_quota_unit
```

`operation` is one of `CREATE`, `UPDATE`, or `RETIRE`.

- `CREATE`: `catalog_item_id` and `expected_revision` are empty. The corporate SKU must not already identify another item.
- `UPDATE`: `catalog_item_id`, `expected_revision`, and `corporate_sku` identify the same active item and revision.
- `RETIRE`: the same identity and revision checks apply. Detail/value/binding rows for a retired command are rejected.

IDs, SKUs, SAT codes, and other identifiers are text cells so leading zeroes are preserved. Decimal cells are parsed from their exact
lexical value; values are never silently rounded. Empty cells mean `null` only where the field contract permits it. A blank required field
is an error, not an instruction to keep an old value.

Reference names can stage bounded create proposals, but the preview remains fail-closed against ambiguous, inactive, foreign, non-leaf, or
concurrently changed reference authority.

### OrganizationValues

```text
corporate_sku, value_type, amount, currency, expected_rule_revision
```

Each row targets an `Items` command by corporate SKU. Values are normalized to the Task 5 organization-value contract and currency rules.
Expected rule revision is required when the operation changes an existing rule.

### BusinessTypes

```text
corporate_sku, business_type
```

Each row links one `Items` command to one supported business type. Applicable active validation profiles add required fields but cannot
relax the V1 baseline.

### VenueBindingRequests

```text
corporate_sku, venue_id, requested_action, product_id, local_sku,
category_id, initial_price, currency
```

`requested_action` is the closed Task 8 binding action. Venue, existing Product, category, currency, access, and tenant ownership are
revalidated during preview and again under confirmation locks. This sheet cannot directly write a Product or binding.

## Upload and parser limits

These limits are enforced before or while hostile OOXML is parsed in an isolated worker:

| Axis                    |                                          V1 limit |
| ----------------------- | ------------------------------------------------: |
| Compressed upload       |                                            10 MiB |
| ZIP entries             |                                               128 |
| Expanded package        |                                            64 MiB |
| Compression ratio       |                                             100:1 |
| Sheets                  |                                         exactly 5 |
| Physical rows, total    |                                            50,000 |
| Physical rows per sheet |                                            20,000 |
| Columns                 | 64 maximum; exact declared headers still required |
| Characters per cell     |                                             4,096 |
| Parse timeout           |                                        15 seconds |

The parser worker is isolated with bounded old/young generations and stack. Cancellation, timeout, worker crash, malformed OOXML,
entity/namespace abuse, macros, formulas, and active/external content return stable non-leaking workbook error codes. Original cell values
and filenames are not copied into the safe error envelope.

## Preview, capacity, and confirmation

Preview accepts multipart field `file` only. Additional files, unexpected fields, truncated multipart bodies, forged scope fields, and files
over 10 MiB return a stable 422 boundary error before the import service runs.

The preview response is paged (default 25, maximum 50) and includes a one-time bearer token. Raw workbook bytes and the raw token are not
stored. Durable staging contains only canonical, bounded commands, findings, dependency snapshots, hashes, actor authority, and capacity
evidence.

Confirmation is explicit and idempotent. It requires the same organization, actor, idempotency authority, target hash, unexpired token hash,
exact staged rows, dependency snapshot, and current locked authority. It rejects a preview with any invalid row.

The V1 confirmation cost model has a limit of 12,000 work units and an overflow sentinel of 12,001. This is distinct from the physical
50,000-row parser cap: a syntactically valid workbook may still be too expensive to confirm and will return
`CATALOG_IMPORT_CONFIRM_LIMIT_EXCEEDED` without partial catalog mutation.

Catalog item changes, organization values, business types, reference proposals, binding requests, durable result, and audit evidence are
committed atomically. Concurrent authority drift, stale revisions, timeout, failed audit, or affected-count mismatch rolls back the catalog
transaction.

## Durable errors

Rejected rows are stored as bounded structured findings, not as a second copy of the workbook. The downloadable error workbook is actor- and
tenant-bound:

```http
GET /api/v1/dashboard/organizations/:orgId/master-catalog/imports/:importBatchId/errors.xlsx
```

Its exact `Errors` grain is `(source_sheet,source_row,column,error_code)`, so two distinct findings on one coordinate remain distinct.
Rejected values are truncated to 128 complete Unicode scalars and formula-neutralized.

## Operator checklist

- Start from a freshly downloaded template for the same organization.
- Keep the five sheet names and every header unchanged.
- Keep IDs and codes as text; do not let spreadsheet software remove leading zeroes.
- Preview first and review every section/page before confirmation.
- Treat the preview token as a short-lived bearer secret; do not paste it into tickets or logs.
- On 409, recover by idempotency key and re-preview when authority or revisions changed.
- On 413, split the workbook by bounded business scope instead of changing server limits.
- Keep the generated error workbook as evidence; do not re-upload it as an import template.
