# Facturación CFDI — Phase 0a: Fiscal Data Model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Prisma data foundation for the CFDI 4.0 facturación module — the emisor/merchant/CFDI/receptor models and product SAT keys
— so later phases (facturapi connector, validation engine, issuance flows) have schema to build on.

**Architecture:** Five new models + product/category SAT-key fields, all additive (no changes to existing columns). `FiscalEmisor`
(RFC+CSD+provider, 1+ per venue) and `MerchantFiscalConfig` (per-merchant enablement → which emisor, autofactura, global) implement the
founder's "config per-merchant" requirement. `Cfdi` stores issued documents; `CustomerTaxProfile` stores receptor fiscal data. One
migration, schema-map updated, validated with a throwaway script.

**Tech Stack:** PostgreSQL + Prisma, TypeScript. Migrations via `prisma migrate dev`. Schema map via `npm run schema:map`.

**Scope:** Phase 0a is ONLY the data model. NOT in this plan (separate plans): facturapi connector (0b), pre-timbrado validation engine
(0c), gating — `CFDI` Feature + `cfdi:*` permissions + MCP tools (0d), and the issuance flows B/A/C (Phases 1–3). Design source:
`docs/superpowers/specs/2026-06-03-facturacion-cfdi-module-design.md` §6.

**Reference rules:** `.claude/rules/critical-warnings.md` (migrations: NEVER `db push`; Schema Map mandatory for new models; money =
Decimal/cents), `.claude/rules/testing-and-git.md` (temp-script→permanent-test; NEVER commit without asking).

---

### Task 1: Add fiscal enums

**Files:**

- Modify: `prisma/schema.prisma` (append enums near the other enums, e.g. after `enum PaymentMethod {...}` ~line 5846)

- [ ] **Step 1: Add the enums**

Append to `prisma/schema.prisma` (names are prefixed to avoid collisions with existing `VerificationStatus`/`InvoiceStatus`):

```prisma
// ─── Facturación CFDI 4.0 ───────────────────────────────────────────────
enum CsdStatus {
  NONE
  UPLOADED
  ACTIVE
  EXPIRED
  RESTRICTED
}

enum GlobalPeriodicity {
  DIARIO
  SEMANAL
  QUINCENAL
  MENSUAL
  BIMESTRAL
}

enum FiscalProviderType {
  FACTURAPI
  FACTURAMA
  ALEGRA
}

enum CfdiType {
  INGRESO
  EGRESO
  PAGO
}

enum CfdiStatus {
  DRAFT
  VALIDATING
  VALIDATION_FAILED
  STAMPING
  STAMPED
  STAMP_FAILED
  CANCEL_REQUESTED
  CANCELLED
}

enum CfdiFlow {
  STAFF_B
  AUTOFACTURA_A
  GLOBAL_C
}

enum CfdiCancelStatus {
  REQUESTED
  ACCEPTED
  REJECTED
  CANCELLED
}

enum FiscalValidationStatus {
  UNVALIDATED
  VALID
  INVALID
}
```

- [ ] **Step 2: Verify it parses**

Run: `npx prisma validate` Expected: `The schema at prisma/schema.prisma is valid 🚀` (models from later tasks not added yet — enums alone
are valid).

---

### Task 2: Add `FiscalEmisor` model + Venue back-relation

**Files:**

- Modify: `prisma/schema.prisma` (new model + one line on `model Venue`)

- [ ] **Step 1: Add the model**

Append to `prisma/schema.prisma`:

```prisma
/// The fiscal issuer (emisor) = one RFC + its CSD + provider binding. 1+ per venue.
model FiscalEmisor {
  id      String @id @default(cuid())
  venueId String
  venue   Venue  @relation(fields: [venueId], references: [id], onDelete: Cascade)

  // Legal identity (must match SAT)
  rfc             String
  legalName       String
  regimenFiscal   String // c_RegimenFiscal
  lugarExpedicion String // fiscal CP

  // Provider binding (provider-agnostic; facturapi = first adapter)
  provider         FiscalProviderType @default(FACTURAPI)
  providerOrgId    String? // facturapi org id / Alegra empresa id
  providerKeyEnc   String? // encrypted per-emisor key
  csdStatus        CsdStatus          @default(NONE)
  csdExpiresAt     DateTime?
  csdLastCheckedAt DateTime?

  // Comprobante defaults
  serie             String?
  defaultUsoCfdi    String            @default("G03")
  globalPeriodicity GlobalPeriodicity @default(MENSUAL)

  merchantConfigs MerchantFiscalConfig[]
  cfdis           Cfdi[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([venueId, rfc])
  @@index([venueId])
}
```

- [ ] **Step 2: Add the Venue back-relation**

In `model Venue { ... }` (starts ~line 108), add this line alongside the other relation fields (e.g. near `ecommerceMerchants`):

```prisma
  fiscalEmisors FiscalEmisor[]
```

- [ ] **Step 3: Verify**

Run: `npx prisma validate` Expected: error about `MerchantFiscalConfig` / `Cfdi` not yet defined is OK at this point — they are added in
Tasks 3–4. If you prefer a clean validate, do Tasks 2–5 then validate once at Task 6. (Relations resolve once all five models exist.)

---

### Task 3: Add `MerchantFiscalConfig` + merchant back-relations

**Files:**

- Modify: `prisma/schema.prisma` (new model + one line each on `MerchantAccount` ~line 3475 and `EcommerceMerchant` ~line 3690)

- [ ] **Step 1: Add the model**

```prisma
/// Per-merchant facturación enablement. Exactly ONE of the two merchant FKs is set.
/// Drives BOTH "which merchants invoice" (venue choice) and the customer-facing "facturar" gate.
model MerchantFiscalConfig {
  id String @id @default(cuid())

  merchantAccountId   String?          @unique // in-person POS merchant
  merchantAccount     MerchantAccount? @relation(fields: [merchantAccountId], references: [id], onDelete: Cascade)
  ecommerceMerchantId String?            @unique // online channel merchant
  ecommerceMerchant   EcommerceMerchant? @relation(fields: [ecommerceMerchantId], references: [id], onDelete: Cascade)

  fiscalEmisorId String
  fiscalEmisor   FiscalEmisor @relation(fields: [fiscalEmisorId], references: [id], onDelete: Restrict)

  facturacionEnabled Boolean @default(false) // master switch for this merchant
  autofacturaEnabled Boolean @default(false) // customer self-invoice (Flow A) allowed
  includeInGlobal    Boolean @default(true)  // included in month-end global sweep (Flow C)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([fiscalEmisorId])
}
```

- [ ] **Step 2: Add back-relation on `MerchantAccount`** (model starts ~line 3475)

```prisma
  fiscalConfig MerchantFiscalConfig?
```

- [ ] **Step 3: Add back-relation on `EcommerceMerchant`** (model starts ~line 3690)

```prisma
  fiscalConfig MerchantFiscalConfig?
```

---

### Task 4: Add `Cfdi` model + Venue/Order back-relations

**Files:**

- Modify: `prisma/schema.prisma` (new model + one line on `model Venue` and one on `model Order` ~line 2277)

- [ ] **Step 1: Add the model**

```prisma
/// An issued (or in-flight) CFDI 4.0 fiscal document. NOTE: distinct from `Invoice` (internal SaaS billing).
model Cfdi {
  id      String @id @default(cuid())
  venueId String
  venue   Venue  @relation(fields: [venueId], references: [id], onDelete: Restrict)

  fiscalEmisorId String
  fiscalEmisor   FiscalEmisor @relation(fields: [fiscalEmisorId], references: [id], onDelete: Restrict)

  type   CfdiType   @default(INGRESO)
  status CfdiStatus @default(DRAFT)
  flow   CfdiFlow

  // Source (individual) OR global period
  orderId      String?
  order        Order?  @relation(fields: [orderId], references: [id], onDelete: SetNull)
  isGlobal     Boolean @default(false)
  globalPeriod Json? // { periodicidad, meses, anio }

  // Receptor snapshot (denormalized at issuance)
  receptorRfc     String
  receptorNombre  String
  receptorRegimen String
  receptorCp      String
  usoCfdi         String

  // SAT payment classification
  formaPago  String // c_FormaPago code
  metodoPago String // PUE / PPD

  // Money — integer cents (cuadra al centavo)
  subtotalCents Int
  discountCents Int  @default(0)
  taxCents      Int
  totalCents    Int
  taxBreakdown  Json? // [{ impuesto:002, tipo:Traslado, base, tasa, importe }, ...]

  // Provider + fiscal identifiers
  facturapiId String?
  uuid        String?   @unique // folio fiscal (timbre)
  serie       String?
  folio       String?
  stampedAt   DateTime?

  // Artifacts (blob storage URLs)
  xmlUrl   String?
  pdfUrl   String?
  acuseUrl String?

  // Errors / retries
  lastError      String? @db.Text
  attempts       Int     @default(0)
  idempotencyKey String? @unique

  // Cancellation (4.0)
  cancelMotivo         String? // 01/02/03/04
  cancelSubstituteUuid String? // required for motivo 01
  cancelStatus         CfdiCancelStatus?
  cancelRequestedAt    DateTime?
  cancelledAt          DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([venueId, status])
  @@index([fiscalEmisorId, isGlobal, createdAt])
}
```

- [ ] **Step 2: Add back-relation on `model Venue`**

```prisma
  cfdis Cfdi[]
```

- [ ] **Step 3: Add back-relation on `model Order`** (starts ~line 2277)

```prisma
  cfdis Cfdi[]
```

---

### Task 5: Add `CustomerTaxProfile` + Customer back-relation

**Files:**

- Modify: `prisma/schema.prisma` (new model + one line on `model Customer` ~line 4812)

- [ ] **Step 1: Add the model**

```prisma
/// Receptor fiscal data. A Customer may have several; guests/autofactura create a one-off.
/// The receptor data is ALSO snapshotted onto the Cfdi at issuance.
model CustomerTaxProfile {
  id         String    @id @default(cuid())
  venueId    String
  customerId String?
  customer   Customer? @relation(fields: [customerId], references: [id], onDelete: SetNull)

  rfc            String
  razonSocial    String
  regimenFiscal  String
  codigoPostal   String
  defaultUsoCfdi String  @default("G03")
  email          String?

  validationStatus FiscalValidationStatus @default(UNVALIDATED)
  validatedAt      DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([venueId, rfc])
}
```

- [ ] **Step 2: Add back-relation on `model Customer`**

```prisma
  taxProfiles CustomerTaxProfile[]
```

---

### Task 6: Add SAT keys to `Product` + `MenuCategory`

**Files:**

- Modify: `prisma/schema.prisma` (`model Product` ~line 1289, `model MenuCategory`)

- [ ] **Step 1: Add to `model Product`** (near `taxRate`, ~line 1311)

```prisma
  // SAT keys for CFDI 4.0 (override category defaults when set)
  satProductKey String? // ClaveProdServ (8 digits)
  satUnitKey    String? // ClaveUnidad (e.g. E48, H87)
  objetoImp     String  @default("02") // 02 = sí objeto de impuesto
```

- [ ] **Step 2: Add to `model MenuCategory`** (per-sector defaults; resolution = product override ?? category default ?? sector default)

```prisma
  defaultSatProductKey String? // e.g. 90101500 "Servicio de restaurante"
  defaultSatUnitKey    String? // e.g. E48 "Unidad de servicio"
```

- [ ] **Step 3: Validate the full schema**

Run: `npx prisma validate` Expected: `The schema at prisma/schema.prisma is valid 🚀` (all five models + relations now resolve).

---

### Task 7: Create the migration

**Files:**

- Create: `prisma/migrations/<timestamp>_add_cfdi_facturacion_models/migration.sql` (generated)

- [ ] **Step 1: Generate + apply the migration (dev DB)**

Run: `npx prisma migrate dev --name add_cfdi_facturacion_models` Expected: new migration folder created, applied to the dev DB,
`✔ Generated Prisma Client`. NEVER use `prisma db push` (`.claude/rules/critical-warnings.md`).

- [ ] **Step 2: Sanity-check the generated SQL**

Run: `ls prisma/migrations | tail -1` then open the new `migration.sql`. Expected: `CREATE TABLE "FiscalEmisor"`, `"MerchantFiscalConfig"`,
`"Cfdi"`, `"CustomerTaxProfile"`, the 8 new enum types, `ALTER TABLE "Product" ADD COLUMN "satProductKey"...`,
`ALTER TABLE "MenuCategory" ADD COLUMN "defaultSatProductKey"...`. No `DROP`/`ALTER ... DROP COLUMN` (this migration is purely additive).

---

### Task 8: Register new models in the schema map

**Files:**

- Modify: `scripts/generate-schema-map.ts` (DOMAINS array ~line 42; MODEL_TO_DOMAIN ~line 130)
- Regenerate: `docs/SCHEMA_MAP.md`

- [ ] **Step 1: Add a new domain to the `DOMAINS` array**

Insert after the `Payment Links` entry (~line 86):

```typescript
  {
    name: 'Facturación (CFDI)',
    description: 'Mexican CFDI 4.0 e-invoicing: fiscal emisores + CSD, per-merchant config, issued CFDIs, receptor tax profiles.',
  },
```

- [ ] **Step 2: Add the four models to `MODEL_TO_DOMAIN`**

Insert after the `Payment Links` block in `MODEL_TO_DOMAIN`:

```typescript
  // Facturación (CFDI)
  FiscalEmisor: 'Facturación (CFDI)',
  MerchantFiscalConfig: 'Facturación (CFDI)',
  Cfdi: 'Facturación (CFDI)',
  CustomerTaxProfile: 'Facturación (CFDI)',
```

> Note: `CustomerTaxProfile` is placed in the Facturación domain (not Customers) because it only exists for CFDI issuance and relates to
> `FiscalEmisor`/`Cfdi`.

- [ ] **Step 3: Regenerate the schema map**

Run: `npm run schema:map` Expected: exits 0, `docs/SCHEMA_MAP.md` regenerated with a new "Facturación (CFDI)" section listing the 4 models.
If it fails with "unclassified model", a model name in Step 2 doesn't match the schema — fix the spelling.

---

### Task 9: Validate the data model end-to-end (throwaway script)

Per `.claude/rules/testing-and-git.md` (temp-script → permanent-test): Phase 0a has no service behavior yet, so validate the schema + the
per-merchant resolution linkage with a throwaway script. The **permanent Jest test** lands in Phase 0d with the eligibility-resolution
service (where there is real behavior to assert).

**Files:**

- Create (temporary, deleted before commit): `scripts/temp-verify-fiscal-models.ts`

- [ ] **Step 1: Write the verification script**

```typescript
// DELETE AFTER: temporary Phase 0a schema validation
// Purpose: prove FiscalEmisor / MerchantFiscalConfig / Cfdi persist + the per-merchant
//          → emisor linkage resolves. Uses an existing venue + merchant account; cleans up after.
// Created: 2026-06-03
import prisma from '../src/utils/prismaClient'

async function main() {
  const venue = await prisma.venue.findFirst({ select: { id: true, rfc: true } })
  if (!venue) throw new Error('No venue in dev DB to test against')

  const merchant = await prisma.merchantAccount.findFirst({ select: { id: true } })
  if (!merchant) throw new Error('No MerchantAccount in dev DB to test against')

  // 1. Emisor
  const emisor = await prisma.fiscalEmisor.create({
    data: {
      venueId: venue.id,
      rfc: 'EKU9003173C9', // SAT test RFC
      legalName: 'ESCUELA KEMPER URGATE SA DE CV',
      regimenFiscal: '601',
      lugarExpedicion: '64000',
    },
  })

  // 2. Per-merchant config → emisor (the founder's requirement)
  const cfg = await prisma.merchantFiscalConfig.create({
    data: {
      merchantAccountId: merchant.id,
      fiscalEmisorId: emisor.id,
      facturacionEnabled: true,
      autofacturaEnabled: true,
    },
  })

  // 3. A draft CFDI under that emisor
  const cfdi = await prisma.cfdi.create({
    data: {
      venueId: venue.id,
      fiscalEmisorId: emisor.id,
      flow: 'STAFF_B',
      receptorRfc: 'XAXX010101000',
      receptorNombre: 'PUBLICO EN GENERAL',
      receptorRegimen: '616',
      receptorCp: '64000',
      usoCfdi: 'S01',
      formaPago: '01',
      metodoPago: 'PUE',
      subtotalCents: 10000,
      taxCents: 1600,
      totalCents: 11600,
    },
  })

  // 4. Resolve merchant → emisor (the gating linkage)
  const resolved = await prisma.merchantFiscalConfig.findUnique({
    where: { merchantAccountId: merchant.id },
    include: { fiscalEmisor: true },
  })

  console.log('emisor:', emisor.id, '| cfg.enabled:', cfg.facturacionEnabled)
  console.log('cfdi:', cfdi.id, cfdi.status, '| resolved emisor rfc:', resolved?.fiscalEmisor.rfc)
  if (resolved?.fiscalEmisor.rfc !== 'EKU9003173C9') throw new Error('resolution FAILED')

  // cleanup (only the fiscal rows we created)
  await prisma.cfdi.delete({ where: { id: cfdi.id } })
  await prisma.merchantFiscalConfig.delete({ where: { id: cfg.id } })
  await prisma.fiscalEmisor.delete({ where: { id: emisor.id } })
  console.log('✅ Phase 0a data model verified + cleaned up')
}

main()
  .catch(e => {
    console.error('❌', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
```

- [ ] **Step 2: Run it**

Run: `npx ts-node -r tsconfig-paths/register scripts/temp-verify-fiscal-models.ts` Expected: prints
`✅ Phase 0a data model verified + cleaned up`, exit 0.

- [ ] **Step 3: Delete the temp script**

Run: `rm scripts/temp-verify-fiscal-models.ts`

---

### Task 10: Format, regression-check, and commit

- [ ] **Step 1: Format + lint**

Run: `npm run format && npm run lint:fix` Expected: no errors (schema.prisma + generate-schema-map.ts formatted).

- [ ] **Step 2: Build + existing tests (no regressions)**

Run: `npm run build && npm run test:unit` Expected: build succeeds; unit tests still pass (this change is additive — nothing should break).

- [ ] **Step 3: Commit (ASK THE USER FIRST — git policy)**

Per `.claude/rules/testing-and-git.md`, NEVER commit without explicit permission. Ask: "¿Hago commit de la migración + modelos fiscales?"
Only on yes:

```bash
git add prisma/schema.prisma \
        prisma/migrations \
        scripts/generate-schema-map.ts \
        docs/SCHEMA_MAP.md
git commit -m "feat(facturacion): add CFDI fiscal data model (Phase 0a)

FiscalEmisor + MerchantFiscalConfig (per-merchant config) + Cfdi + CustomerTaxProfile
+ Product/MenuCategory SAT keys + 8 enums. Additive migration. Schema map updated.
Spec: docs/superpowers/specs/2026-06-03-facturacion-cfdi-module-design.md

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

Do NOT touch unrelated WIP in the working tree (stage only the files listed above).

---

## Self-review

**Spec coverage (§6 of the design):** §6.1 FiscalEmisor ✓ (T2), §6.1b MerchantFiscalConfig ✓ (T3), §6.1c resolution linkage ✓ (verified T9),
§6.2 CustomerTaxProfile ✓ (T5), §6.3 Product/MenuCategory SAT keys ✓ (T6), §6.4 Cfdi ✓ (T4). Enums ✓ (T1). Migration + schema-map governance
(§18) ✓ (T7–T8). **Out of scope by design:** connector (§7→0b), validation engine (§8→0c), Feature gate + `cfdi:*` permissions + MCP tools
(§15,§18→0d), issuance flows (Phases 1–3).

**Placeholder scan:** none — every step has exact code/commands/expected output.

**Type consistency:** enum names used in models match Task 1 exactly (`CsdStatus`, `GlobalPeriodicity`, `FiscalProviderType`, `CfdiType`,
`CfdiStatus`, `CfdiFlow`, `CfdiCancelStatus`, `FiscalValidationStatus`). Relation field names consistent:
`FiscalEmisor.merchantConfigs`↔`MerchantFiscalConfig.fiscalEmisor`, `FiscalEmisor.cfdis`↔`Cfdi.fiscalEmisor`,
`MerchantAccount.fiscalConfig`/`EcommerceMerchant.fiscalConfig`↔the two `@unique` FKs, `Venue.fiscalEmisors`/`Venue.cfdis`, `Order.cfdis`,
`Customer.taxProfiles`.

**Note for 0d:** the `CFDI` Feature row + `cfdi:configure`(OWNER/ADMIN)/`cfdi:issue`/`cfdi:view` permissions + matching MCP tools are
intentionally deferred — they gate behavior that doesn't exist until the connector/issuance lands.
