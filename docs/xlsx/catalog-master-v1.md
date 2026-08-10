# Catalog master export v1

Files:

- `catalog-master-v1.xlsx` from `GET .../exports/catalog-master.xlsx`;
- `catalog-by-business-type-v1.xlsx` from `GET .../exports/catalog-by-business-type.xlsx?businessType=...`;
- `import-errors-v1.xlsx` from `GET .../imports/:importBatchId/errors.xlsx`.

All exports are read-only, tenant-scoped snapshots rendered from server authority. They never mutate CatalogItem, Recipe, Product, binding,
import, or publication state.

## Workbook-wide contract

Every workbook starts with `Metadata`, columns `key,value`, unique/sorted by grain `(key,value)`.

Required metadata keys:

| Key              | Meaning                                                                       |
| ---------------- | ----------------------------------------------------------------------------- |
| `schemaVersion`  | `1`.                                                                          |
| `organizationId` | Authorized tenant ID.                                                         |
| `generatedAt`    | RFC3339 UTC timestamp.                                                        |
| `timezone`       | `America/Mexico_City` in H1A.                                                 |
| `filters`        | Canonical JSON text: `{}` or the exact request filter.                        |
| `profileVersion` | Sorted unique active profile versions joined by comma; `1` for baseline-only. |

The import template adds `documentType=catalog-master-import`; see [catalog-master-import-v1.md](catalog-master-import-v1.md).

Cell behavior:

- IDs, SKUs, GTINs, SAT codes, revisions represented as identifiers, and leading-zero values are text where declared.
- Null is a blank cell; empty string remains an explicit empty text value when the source contract permits it.
- Text beginning with `=`, `+`, `-`, or `@` is prefixed with an apostrophe to prevent formula execution.
- XML noncharacters, controls, lone surrogates, bidi spoofing, unsafe OOXML text, exponent notation, rounding, and undeclared precision are
  rejected.
- Dates are UTC timestamps. Money is decimal(10,2). Recipe cost is decimal(10,4). IVA is decimal(5,4). IEPS rate is decimal(7,6); quota is
  decimal(12,4).
- Every sheet is sorted and unique by its declared grain. One-to-many data lives in separate sheets; no cartesian expansion is emitted.

## Capacity and availability

The service preflights tenant grains before hydration and yields cooperatively every 128 rows.

| Limit                         |                                          v1 value |
| ----------------------------- | ------------------------------------------------: |
| Sheets                        |                                                12 |
| Columns per sheet             |                                                40 |
| Data rows/output              |                                             5,000 |
| Hydrated rows                 |                                             5,000 |
| Cells                         |                                           180,000 |
| Unicode scalars per text cell | 32,767, including formula-neutralizing apostrophe |
| XML per part                  |                                             8 MiB |
| Aggregate XML                 |                                            32 MiB |
| ZIP output                    |                                            16 MiB |

Overflow is a stable 413; invalid durable/source data is a fail-closed 409/422 as classified by the endpoint. Limits can be reduced for
tests but not relaxed at runtime.

## Master and business export sheets

The master workbook has Metadata plus eight data sheets. The business-type workbook additionally includes `RequiredFields`.

### Items

Grain: `(corporate_sku)`.

Columns, in order:

```text
corporate_sku, item_kind, name, description, image_url, brand,
manufacturer, family, subfamily, presentation, unit, product_type,
iva_rate, sat_product_key, sat_unit_key, objeto_imp, ieps_mode,
ieps_rate, ieps_quota, ieps_quota_unit, status, created_by,
created_at, updated_by, updated_at
```

Family authority is an active root plus an active leaf with no active child. Invalid/corrupt hierarchy fails closed rather than exporting a
misleading subfamily.

### OrganizationValues

Grain: `(corporate_sku,value_type,currency)`.

```text
corporate_sku, value_type, amount, currency, revision
```

H1A requires exact SALE/PURCHASE organization value semantics where applicable. Amount is money decimal(10,2).

### BusinessTypes

Grain: `(corporate_sku,business_type)`.

```text
corporate_sku, business_type
```

The business export includes only items assigned to the requested business type. Its applicable profiles are active rows with
`businessType=null|requested` and `operationalRole=null`.

### VenueBindings

Grain: `(corporate_sku,venue_id)`.

```text
corporate_sku, venue_id, venue_name, product_id, local_sku,
binding_status, category_id, last_published_revision
```

Product and category identifiers are tenant/venue scoped. The export does not create or repair a binding.

### PreparedDishDetails

Grain: `(corporate_sku,venue_id)`.

```text
corporate_sku, venue_id, product_id, recipe_id, portion_yield,
prep_time_minutes, total_recipe_cost, cost_per_portion, currency,
recipe_status
```

Representable statuses:

- `MISSING_RECIPE`;
- `INVALID_PORTION_YIELD`;
- `MISSING_PREP_TIME`;
- `EMPTY_LINES`;
- `COST_STALE`;
- `COMPLETE`.

Costs are calculated live and purely from tenant-valid Recipe/RawMaterial authority. Foreign, inactive, deleted, invalid-unit/quantity, or
otherwise unrepresentable recipe lines fail the whole export with 409; they are never mislabeled as a representable incomplete status.
Complete costs must fit decimal(10,4).

### Identifiers

Grain: `(corporate_sku,code)`.

```text
corporate_sku, code, format, status, created_by, created_at
```

All CORPORATE_SKU lifecycle rows are preserved, including retired identifiers retained for history.

### Regions

Grain: `(price_region_id,venue_id)`.

```text
price_region_id, price_region_name, venue_id, venue_name, priority, active
```

Header-only in H1A. No organization fallback or invented region is emitted.

### RegionalValues

Grain: `(corporate_sku,value_type,venue_id)`.

```text
corporate_sku, value_type, venue_id, source_scope, source_region_id,
source_region_name, region_priority, amount, currency
```

Header-only in H1A. Regional pricing is an H1C capability and must not be advertised as available.

### RequiredFields

Business export only. Grain: `(profile_version,business_type,field)`.

```text
profile_version, business_type, field, required, source
```

The non-relaxable validation baseline is emitted at version 1 with source `CONTRACT`. Active applicable profile additions are emitted at
their exact profile version with source `PROFILE`. Contradictory grains or unsupported rules schema fail closed.

## Durable import errors workbook

`import-errors-v1.xlsx` uses the original import dependency snapshot, not live profile versions.

Metadata `filters` is:

```json
{ "importBatchId": "..." }
```

The only data sheet is `Errors`.

Grain: `(source_sheet,source_row,column,error_code)`. Multiple distinct errors on the same coordinate are retained.

```text
source_sheet, source_row, column, error_code, message,
rejected_value, suggestion
```

Rows are read through the actor-bound durable import reader in pages of 50. More than 5,000 total output/profile rows is 413. Repeated
cursors, oversized pages, invalid durable shape, duplicate full grain, or nonterminal/foreign batch authority is 409. `rejected_value` is
truncated to 128 complete Unicode scalars and then formula-neutralized by the writer.

## Verification checklist

- Parse the generated file with an independent XLSX reader.
- Require exact sheet order, columns, types, styles, grains, row order, and Metadata.
- Check a leading-zero SKU/code, null vs empty, every decimal precision, timestamp, boolean, and integer.
- Check formula prefixes and rejected controls/bidi/noncharacters/surrogates.
- Exercise row, cell, XML-part, aggregate-XML, ZIP, and event-loop/yield limits.
- Verify tenant predicates on every query and no writes.
- For PreparedDish, cover all six statuses plus unsupported-line dominance.
- For errors, cover multi-page, two codes at one coordinate, duplicate full grain, cursor loop, and 5,001 overflow.
