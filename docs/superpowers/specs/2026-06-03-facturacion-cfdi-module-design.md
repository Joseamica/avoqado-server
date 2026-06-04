# Facturación CFDI 4.0 — Module Design

- **Status:** DRAFT — design for review (brainstorming output, pre-implementation)
- **Date:** 2026-06-03
- **Repo:** avoqado-server (the hub — backend/API/DB/business logic)
- **Author:** Jose Amica + Claude
- **Related memory:** `facturacion-cfdi-module.md`, `sat-2026-compliance-facts.md`
- **PAC decided:** **facturapi.io** (confirmed via deep-research, 2026-06-03)

> ⚠️ This is a **design doc**, not an implementation plan. No code until this is approved and a writing-plans pass produces the step-by-step
> plan. Code snippets here are **illustrative**.

---

## 1. Why this exists (strategic frame)

In México 2026, _issuing_ a CFDI is table stakes — every competitor does it (Soft Restaurant, Parrot, Last.app, CLIP). The **moat is issuing
it CORRECTLY**, defensively, and staying compliant as the SAT changes rules. The SAT hardened enforcement in 2026 (can now _suspend_ a
venue's ability to invoice, validates to the centavo, shortened REP deadlines). See `sat-2026-compliance-facts.md`.

So this module is **"cumplimiento fiscal blindado"**, not "facturación". Correctness _is_ the product. Three differentiators become **hard
requirements**, not nice-to-haves:

| #   | Differentiator                       | Why it wins                                                                  | How we deliver it                                                                                      |
| --- | ------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| D1  | **Cero rechazos**                    | RFC-not-matching-padrón is the #1 rejection cause                            | Pre-timbrado validation of RFC + name + régimen + CP against SAT registry, _before_ sending to the PAC |
| D2  | **Propinas resueltas nativo**        | Competitors bolt on a manual "addenda PROPINAS"                              | `tipAmount` is already cleanly separated → we exclude it from the CFDI base correctly, natively        |
| D3  | **Catálogos al día = nuestra carga** | Keeping SAT catalogs current is the _system provider's_ legal responsibility | facturapi maintains catalogs; we surface/validate. Choosing facturapi is itself risk coverage          |

**Non-goals (explicitly out of MVP):**

- Complemento de Pago (REP) issuance — deferred (POS sales are PUE). Documented in §13 for the future.
- Cancelación buzón UX (receptor-acceptance inbox) — we model status; the PAC/SAT handle the mechanics.
- Nómina, Carta Porte, Comercio Exterior, other complementos.
- Becoming our own PAC (legally requires ~$10M capital + $10M fianza — see research).

---

## 2. Scope & build order

Three issuance flows share ONE engine. Build the engine once, expose triggers in risk order:

- **Phase 0 — Core CFDI engine (invisible):** data model + facturapi connector + validation + storage.
- **Phase 1 — Flow B (staff invoices a selected closed bill):** internal, controlled, lowest risk. Proves the pipeline end-to-end with a
  pilot venue.
- **Phase 2 — Flow A (autofacturación portal):** QR/folio on the ticket → diner self-invoices. The daily-volume case. Higher surface
  (public).
- **Phase 3 — Flow C (factura global):** batch job sweeps everything un-invoiced into one CFDI to Público en General. Last, because it needs
  A+B working to know "what's left".

**Sectors:** restaurants, retail, services, beauty salons. All share the engine; per-sector differences live in SAT-key defaults (§6.3) and
UsoCFDI defaults.

---

## 3. Flow diagram — "venta cerrada → CFDI timbrado y guardado"

```
                          ┌─────────────────────────────────────────────┐
                          │  Venta cerrada (Order/Payment COMPLETED)      │
                          │  → create facturapi "Receipt" (recibo)        │  ← Phase 0
                          └───────────────┬─────────────────────────────┘
                                          │
            ┌─────────────────────────────┼──────────────────────────────┐
            │ Flow B (Phase 1)            │ Flow A (Phase 2)             │ Flow C (Phase 3)
            │ staff selects a bill        │ diner scans QR / folio       │ month-end job
            ▼                             ▼                              ▼
   capture receptor data         self-service portal              gather all receipts
   (RFC, name, régimen,          (RFC, name, régimen,             NOT self-invoiced
    CP, UsoCFDI)                  CP, UsoCFDI) — NO constancia      in the period
            │                             │                              │
            └─────────────┬───────────────┘                              │
                          ▼                                              ▼
            ┌───────────────────────────────────────────────────────────────────┐
            │  PRE-TIMBRADO VALIDATION (D1 — "cero rechazos")                      │
            │  • RFC format + against SAT registry (régimen/CP coherence)          │
            │  • every concepto has ClaveProdServ + ClaveUnidad + ObjetoImp        │
            │  • tax math cuadra al centavo; tip excluded from base (D2)           │
            │  • FormaPago / MetodoPago resolved; emisor CSD ACTIVE                 │
            └───────────────┬───────────────────────────────────────────────────┘
                            │ valid                          │ invalid
                            ▼                                ▼
            ┌───────────────────────────────┐   ┌──────────────────────────────┐
            │  facturapi: stamp (timbrar)    │   │  reject locally, explain why  │
            │  POST /v2/invoices (org key)   │   │  (never sent to PAC)          │
            └───────────────┬───────────────┘   └──────────────────────────────┘
                            │
              ┌─────────────┴─────────────┐
              │ stamped                   │ PAC/SAT error
              ▼                           ▼
   ┌────────────────────────┐   ┌──────────────────────────────┐
   │ persist Cfdi: UUID,     │   │ Cfdi.status=STAMP_FAILED,     │
   │ serie/folio, XML, PDF,  │   │ store error, queue retry      │
   │ acuse → blob storage    │   │ (idempotency-keyed)           │
   │ status=STAMPED          │   └──────────────────────────────┘
   │ email XML+PDF to receptor│
   └────────────────────────┘
```

For Flow C the right-hand path is the same stamping step, but the receptor is `XAXX010101000` "PÚBLICO EN GENERAL" with the
`InformacionGlobal` node (periodicidad/mes/año).

---

## 4. Minimum mandatory CFDI 4.0 fields

What a valid CFDI 4.0 "Ingreso" needs (the engine must guarantee all of these):

**Comprobante (header)**

- `Version` = 4.0 · `Fecha` (≤72h old) · `Sello`/`Certificado` (PAC) · `TipoDeComprobante` (I/E/P)
- `SubTotal` · `Descuento` · `Total` · `Moneda` (MXN) · `Exportacion` (01 default)
- `FormaPago` (c_FormaPago: 01/03/04/28…) · `MetodoPago` (PUE/PPD)
- `LugarExpedicion` = emisor's fiscal CP

**Emisor (the venue)** — _already captured_

- `Rfc` (`Venue.rfc`) · `Nombre` (`Venue.legalName`) · `RegimenFiscal` (`Venue.fiscalRegime`, must be valid c_RegimenFiscal)

**Receptor (the customer)** — _MISSING today_

- `Rfc` · `Nombre` (must match SAT padrón exactly in 4.0) · `DomicilioFiscalReceptor` (CP)
- `RegimenFiscalReceptor` · `UsoCFDI`

**Conceptos (line items)** — _partially missing_

- `ClaveProdServ` (SAT, 8 digits) — **MISSING** · `ClaveUnidad` (SAT, e.g. E48/H87) — **MISSING**
- `NoIdentificacion` (SKU, ✅) · `Cantidad` (✅) · `Descripcion` (✅) · `ValorUnitario` (net, ✅\*)
- `Importe` · `Descuento` · `ObjetoImp` (01/02/03) — **MISSING**
- `Impuestos` per concepto: Traslados (IVA 002 base/tasa/importe), Retenciones if applicable

**Impuestos (totals)**

- `TotalImpuestosTrasladados` / `TotalImpuestosRetenidos` + per-tax breakdown

\* `ValorUnitario` must be NET (sin IVA). **OPEN ITEM (§17):** confirm whether `Product.price` / `OrderItem.unitPrice` are stored net or
IVA-included; `TerminalOrder` is explicitly net.

---

## 5. Readiness audit → 5 critical gaps

(From the codebase audit, 2026-06-03.) Foundation ≈ 40%. Critical gaps that block a valid CFDI:

| Gap                         | Today                                  | Fix (see §6)                                                     |
| --------------------------- | -------------------------------------- | ---------------------------------------------------------------- |
| G1 SAT keys on products     | `Product` has none                     | Add `satProductKey`/`satUnitKey`/`objetoImp` + category defaults |
| G2 Receptor fiscal data     | `Customer` has zero fiscal fields      | New `CustomerTaxProfile` + receptor snapshot on `Cfdi`           |
| G3 No CFDI model            | only internal-billing `Invoice` exists | New `Cfdi` model (UUID/XML/PDF/acuse/status/cancel)              |
| G4 CSD registration         | nowhere                                | New `VenueFiscalConfig` (facturapi org id + CSD status)          |
| G5 ObjetoImp + per-line tax | flat `taxAmount`/`taxRate` only        | Per-line tax breakdown + ObjetoImp + IEPS/retención support      |

**Already have:** emisor identity on `Venue`; tax base on `Order`/`Payment`; `Payment.method` enum; module toggle system;
RabbitMQ/Redis/jobs; blob storage; `Decimal`+cents money (`TerminalOrder.taxCents`).

---

## 6. Data model changes (Prisma) — illustrative

### 6.1 New: `FiscalEmisor` (the emisor = an RFC + CSD; 1+ per venue)

> **DESIGN CHANGE (2026-06-03, per founder):** Fiscal config is **per-merchant**, not per-venue. A venue has multiple merchants
> (`MerchantAccount` for in-person POS; `EcommerceMerchant` for online channels — the latter already carries its own `rfc`). The venue must
> be able to choose **which merchants invoice** (autofactura + month-end global) and which don't. And the customer-facing "facturar" option
> must only appear when **the merchant they paid through** has it enabled. So we split into: `FiscalEmisor` (the legal issuer:
> RFC+CSD+provider org) and `MerchantFiscalConfig` (per-merchant enablement + which emisor it maps to).

```prisma
model FiscalEmisor {
  id        String @id @default(cuid())
  venueId   String
  venue     Venue  @relation(fields: [venueId], references: [id], onDelete: Cascade)

  // Legal identity (an emisor = one RFC). Most venues have 1; an EcommerceMerchant
  // with a different RFC can map to its own emisor.
  rfc           String
  legalName     String  // razón social (must match SAT)
  regimenFiscal String  // c_RegimenFiscal
  lugarExpedicion String // fiscal CP

  // Provider binding (PROVIDER-AGNOSTIC — see §7). For facturapi: the org id + its key.
  provider          FiscalProviderType @default(FACTURAPI)
  providerOrgId     String?            // facturapi org / Alegra empresa id
  providerKeyEnc    String?            // encrypted per-emisor key
  csdStatus         CsdStatus @default(NONE) // NONE/UPLOADED/ACTIVE/EXPIRED/RESTRICTED
  csdExpiresAt      DateTime?
  csdLastCheckedAt  DateTime?

  // Comprobante defaults
  serie             String?
  defaultUsoCfdi    String  @default("G03")
  globalPeriodicity GlobalPeriodicity @default(MENSUAL)

  merchantConfigs   MerchantFiscalConfig[]
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@unique([venueId, rfc])
}

enum CsdStatus { NONE UPLOADED ACTIVE EXPIRED RESTRICTED }
enum GlobalPeriodicity { DIARIO SEMANAL QUINCENAL MENSUAL BIMESTRAL }
enum FiscalProviderType { FACTURAPI FACTURAMA ALEGRA } // provider-agnostic; ALEGRA = future
```

### 6.1b New: `MerchantFiscalConfig` (per-merchant enablement — the core of this requirement)

One row per merchant (exactly one of the two FKs set). Drives BOTH the venue's "which merchants invoice" choice AND the customer-facing
gating.

```prisma
model MerchantFiscalConfig {
  id        String @id @default(cuid())

  // Exactly ONE of these (the merchant this config governs):
  merchantAccountId   String? @unique   // in-person POS merchant
  merchantAccount     MerchantAccount? @relation(fields: [merchantAccountId], references: [id], onDelete: Cascade)
  ecommerceMerchantId String? @unique   // online channel merchant
  ecommerceMerchant   EcommerceMerchant? @relation(fields: [ecommerceMerchantId], references: [id], onDelete: Cascade)

  // Which emisor issues for sales through this merchant
  fiscalEmisorId String
  fiscalEmisor   FiscalEmisor @relation(fields: [fiscalEmisorId], references: [id])

  // The two toggles the founder asked for:
  facturacionEnabled Boolean @default(false) // master switch for this merchant
  autofacturaEnabled Boolean @default(false) // customer self-invoice (Flow A) allowed
  includeInGlobal    Boolean @default(true)  // included in month-end global sweep (Flow C)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

### 6.1c Resolution logic (how the two requirements are satisfied)

- **Customer "facturar" gating (Flow A):** from `Payment` → its `merchantAccountId | ecommerceMerchantId` → `MerchantFiscalConfig`. Show
  "facturar" only if `facturacionEnabled && autofacturaEnabled`. The CFDI's emisor = `MerchantFiscalConfig.fiscalEmisorId`. If the merchant
  has no config or is disabled → no "facturar" option appears for that sale.
- **Venue picks which merchants autofacture / enter global:** the venue toggles `facturacionEnabled` / `autofacturaEnabled` /
  `includeInGlobal` per merchant in the dashboard.
- **Global sweep (Flow C):** grouped **per `FiscalEmisor`**, including only sales whose merchant has `includeInGlobal = true` AND was not
  individually invoiced. One global CFDI per emisor per period.

### 6.2 New: `CustomerTaxProfile` (receptor) + snapshot on `Cfdi`

A `Customer` may have several profiles (personal vs company). Guests/autofactura capture a one-off profile at issuance; the receptor data is
always **snapshotted** onto the `Cfdi`.

```prisma
model CustomerTaxProfile {
  id            String  @id @default(cuid())
  venueId       String
  customerId    String? // nullable: guest / autofactura one-off
  customer      Customer? @relation(fields: [customerId], references: [id], onDelete: SetNull)

  rfc           String
  razonSocial   String  // must match SAT padrón
  regimenFiscal String  // c_RegimenFiscal
  codigoPostal  String  // domicilio fiscal
  defaultUsoCfdi String @default("G03")
  email         String?

  // D1: validation against SAT registry (via facturapi)
  validationStatus ValidationStatus @default(UNVALIDATED) // UNVALIDATED/VALID/INVALID
  validatedAt      DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@index([venueId, rfc])
}
enum ValidationStatus { UNVALIDATED VALID INVALID }
```

### 6.3 `Product` + `MenuCategory` — SAT keys (G1), strategy = **default por categoría + override**

```prisma
// MenuCategory (defaults per category/sector)
  defaultSatProductKey String? // e.g. 90101500 "Servicio de restaurante"
  defaultSatUnitKey    String? // e.g. E48 "Unidad de servicio"

// Product (override + objeto de impuesto)
  satProductKey String? // overrides category default when set
  satUnitKey    String?
  objetoImp     String  @default("02") // 02 = sí objeto de impuesto
```

Resolution at issuance: `product.satProductKey ?? category.defaultSatProductKey ?? venue-sector default`. Per-sector seed defaults
(restaurant 90101500/E48, retail by category, services 80000000-class, etc.).

### 6.4 New: `Cfdi` (G3 — the fiscal document)

```prisma
model Cfdi {
  id        String @id @default(cuid())
  venueId   String
  venue     Venue  @relation(fields: [venueId], references: [id])

  type      CfdiType   @default(INGRESO) // INGRESO/EGRESO/PAGO
  status    CfdiStatus @default(DRAFT)
  flow      CfdiFlow                      // STAFF_B / AUTOFACTURA_A / GLOBAL_C

  // Source (individual) — or global period
  orderId       String?
  isGlobal      Boolean  @default(false)
  globalPeriod  Json?    // { periodicidad, meses, anio }

  // Receptor snapshot (denormalized at issuance)
  receptorRfc           String
  receptorNombre        String
  receptorRegimen       String
  receptorCp            String
  usoCfdi               String

  // Payment classification (SAT)
  formaPago  String   // c_FormaPago code
  metodoPago String   // PUE / PPD

  // Money (cents, cuadra al centavo)
  subtotalCents Int
  discountCents Int @default(0)
  taxCents      Int
  totalCents    Int
  taxBreakdown  Json  // [{ impuesto:002, tipo:Traslado, base, tasa, importe }, ...]

  // Provider + fiscal identifiers
  facturapiId String?  // facturapi invoice id
  uuid        String?  @unique // folio fiscal (timbre)
  serie       String?
  folio       String?
  stampedAt   DateTime?

  // Artifacts (blob storage)
  xmlUrl   String?
  pdfUrl   String?
  acuseUrl String?

  // Errors / retries
  lastError    String? @db.Text
  attempts     Int     @default(0)
  idempotencyKey String? @unique

  // Cancellation (4.0)
  cancelMotivo        String?   // 01/02/03/04
  cancelSubstituteUuid String?  // required for motivo 01
  cancelStatus        CancelStatus? // REQUESTED/ACCEPTED/REJECTED/CANCELLED
  cancelRequestedAt   DateTime?
  cancelledAt         DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@index([venueId, status])
  @@index([venueId, isGlobal, createdAt])
}
enum CfdiType { INGRESO EGRESO PAGO }
enum CfdiStatus { DRAFT VALIDATING VALIDATION_FAILED STAMPING STAMPED STAMP_FAILED CANCEL_REQUESTED CANCELLED }
enum CfdiFlow { STAFF_B AUTOFACTURA_A GLOBAL_C }
enum CancelStatus { REQUESTED ACCEPTED REJECTED CANCELLED }
```

> Naming note: existing `Invoice` model = internal SaaS billing (Avoqado → venue). The fiscal document is `Cfdi` — no collision.

---

## 7. PAC connector architecture (facturapi)

### 7.1 Auth model (two key tiers)

- **Account User Key** (`sk_user_…`) — env var `FACTURAPI_USER_KEY`. Used only to **provision organizations** (create org, upload CSD, set
  legal info). One per Avoqado account.
- **Per-org Live Key** (`sk_live_…`) — returned when an org is created; stored **encrypted** in `FiscalEmisor.providerKeyEnc`. Used to
  issue/cancel CFDIs for that venue. This is what isolates venues from each other.
- **Sandbox / Test mode** (`sk_test_…`) — facturapi has a full test environment: test stamps are **NOT billed** and **NOT sent to SAT**
  (`livemode:false`); test/live data is isolated. **You can develop + stamp test CFDIs WITHOUT uploading any real CSD** — the real CSD
  upload is only needed to go Live. → all of Phase 0 (connector + validation) is built/tested in sandbox with the SAT test RFC
  `EKU9003173C9`, zero real fiscal effect. Env: dev/staging use `sk_test_`; prod uses per-org `sk_live_`.

### 7.2 Org provisioning (once per venue, part of fiscal onboarding)

```
POST /v2/organizations { name }                       → org id
PUT  /v2/organizations/{id}/legal { ...emisor data }  → razón social, régimen, CP
PUT  /v2/organizations/{id}/certificate (.cer/.key + password)  → CSD uploaded
  → set VenueFiscalConfig.csdStatus = ACTIVE, store encrypted live key
```

We never store the raw CSD — facturapi holds it. We store only the org id + status + key (encrypted).

### 7.3 Issuance — plain `invoices.create` for ALL flows (COST DECISION 2026-06-03)

> **Why NOT facturapi "Receipts":** facturapi's e-receipts + hosted autofactura portal + "facturas globales con e-receipts" are a SEPARATE paid product — **"E-Receipts y autofactura" = $599 MXN / organización / mes** (i.e. PER VENUE). The core **"API de facturación" ($299/mes FLAT, RFC emisores ILIMITADOS, $0.60/timbre)** already emits **all CFDI types incl. the global** via plain `invoices.create`. So we **do NOT use facturapi Receipts** — we track un-invoiced sales in OUR OWN DB (the `Cfdi` model + existing Order/Payment tables) and emit plain invoices. This keeps the whole platform on the single $299/mes plan (see §7.6) instead of $599 × every venue.

All three flows use the same primitive — `invoices.create` (our `FiscalProvider.createInvoice`):

- **Flow B (Phase 1):** staff picks a closed bill → build CFDI payload → `createInvoice`.
- **Flow A (Phase 2):** OUR OWN hosted autofactura portal (QR/folio on the ticket → our page) collects receptor data → `createInvoice`. We do NOT buy facturapi's hosted portal.
- **Flow C (Phase 3):** a job aggregates OUR un-invoiced sales for the period → ONE `createInvoice` to `XAXX010101000` with the `InformacionGlobal` node. No e-receipts needed.

Core endpoints used (the venue's org key):

```
POST   /v2/invoices                      issue CFDI directly (B, A, and C with global node)
GET    /v2/invoices/{id}                 status / fetch
GET    /v2/invoices/{id}/xml | /pdf      artifacts
DELETE /v2/invoices/{id} { motive, substitution }  cancel 4.0 (§12)
```

> ✅ The Phase 0b connector already matches this: `FiscalProvider` has `createInvoice`/`cancel`/`getInvoice`/`downloadXml|Pdf` and intentionally NO receipt methods — no rework. The global is a `createInvoice` variant (add the `InformacionGlobal` mapping in Phase 3).

### 7.4 Connector service shape (DDD, mirrors existing provider pattern)

- `src/services/fiscal/FiscalProvider.ts` — **provider-agnostic interface** (`createReceipt`, `invoiceReceipt`, `globalInvoice`,
  `stampInvoice`, `cancel`, `validateReceptor`, `uploadCsd`). Decouples the engine from any single PAC, so **Alegra / Facturama can be added
  later as adapters with zero rewrite** (mirrors how `PaymentProvider` already abstracts Blumon/Stripe/MercadoPago).
- `src/services/fiscal/providers/facturapi.adapter.ts` — first adapter; thin typed wrapper over the facturapi SDK; org-scoped.
- `src/services/fiscal/cfdi.service.ts` — orchestration: build payload from Order → validate → stamp → persist.
- `src/services/fiscal/cfdiValidation.service.ts` — the D1 pre-timbrado engine (§8).
- `src/services/fiscal/satMapping.ts` — Avoqado→SAT mappings (FormaPago, régimen, etc.) (§10).
- `src/services/fiscal/fiscalOnboarding.service.ts` — org provisioning + CSD upload (§7.2).
- `src/jobs/cfdi-stamp-retry.job.ts` — retries STAMP_FAILED (idempotency-keyed) (§14).
- `src/jobs/factura-global.job.ts` — Flow C batch (§11).
- `src/jobs/csd-health.job.ts` — CSD expiry/restriction monitoring (§14).
- Webhook handler for facturapi async events (mirrors `blumon-webhook.service.ts`).

**Env vars:** `FACTURAPI_USER_KEY`, `FACTURAPI_BASE_URL`, `FACTURAPI_WEBHOOK_SECRET`, `FISCAL_KEY_ENCRYPTION_KEY` (for encrypting per-org
live keys at rest).

### 7.5 "Alegra-style accounting" (FUTURE NATIVE capability — vision, NOT an integration)

**CLARIFIED 2026-06-03 by founder:** he does NOT want to integrate with or use Alegra the company. Alegra is the **product north-star** for
a _future native_ "Avoqado Contabilidad" capability — bring the accounting / contador experience INSIDE Avoqado. (Alegra is a cloud
accounting + facturación + POS + inventory SaaS for SMEs/contadores in México/LATAM.) So: **no Alegra adapter, no Alegra sync.**

What this means for THIS module: **nothing changes in the build** — facturapi stays the timbrado provider. This facturación module is the
**first building block** of that vision. Design so a future native accounting layer can consume it cleanly: CFDIs stored with full fiscal
data + XML, sales / payments already structured, money al-centavo. Future native layers (OUT of scope now, YAGNI): pólizas, IVA acreditable,
DIOT, reportes para el contador, multiempresa accounting. The `FiscalProvider` interface (§7.4) still stands — but only for PAC redundancy /
portability, not Alegra.

### 7.6 Cost model — which facturapi product we contract (RESOLVED 2026-06-03)

We contract **ONE product: "API de facturación" — $299 MXN/mes FLAT for the whole Avoqado account + $0.60 MXN/timbre.** Its included scope (per facturapi's own list) covers everything this module needs:
- Emisión de **todo tipo de CFDI y complementos** vía API (Flow B/A/C) · **RFC emisores ILIMITADOS** (every venue = one emisor, **no per-org fee**) · **Sin tope de timbrado** · **Cancelaciones ilimitadas** (§12) · Webhooks · **PDF personalizado + envío por correo** (§14 artifacts/delivery) · **Búsqueda en catálogos Producto/Unidad SAT** (D3 — catalogs are facturapi's burden) · soporte e-mail/chat.

**We do NOT contract** the per-organización add-ons: ~~Facturación web $199~~ (we have our own dashboard), ~~E-Receipts y autofactura $599~~ (we build our own portal + global, §7.3), ~~Descarga masiva $999~~, ~~Facturapi para Stripe $299~~.

**Economics:** the ENTIRE platform (all venues) = **$299/mes + $0.60 per stamped CFDI.** Not per venue. Since facturación is a **Pro-tier ($999/mes) feature** (§15), a single Pro venue more than covers the $299; most diners don't ask for factura so timbre volume is low. Comfortably profitable; the $0.60/timbre can even be passed through.

**Building + testing now = $0:** facturapi test mode is FREE — *"Los CFDI emitidos con tu test secret key o mediante playground no generan costo."* The $299 plan is only needed to issue LIVE CFDIs. So get a free account + `sk_test_` key to run the smoke test; subscribe only when going to production.

---

## 8. Pre-timbrado validation engine (D1 — "cero rechazos")

Runs **locally before** any call to the PAC. Rejects with a human-readable reason so we _never_ send something the SAT will bounce:

1. **Receptor**: RFC format valid; name/régimen/CP coherent; validate against SAT registry via facturapi `tax-info-validation` (cached **per
   receptor**, not per invoice — cost control).
2. **Conceptos**: every line has `ClaveProdServ` + `ClaveUnidad` + `ObjetoImp`. Missing → block + tell venue which product.
3. **Money**: subtotal − descuento + impuestos = total, **al centavo** (integer-cents math); tip excluded from base (D2).
4. **Tax coherence**: per-line tasa ∈ {0.16, 0.08, 0.00, exento}; traslados sum matches totals.
5. **Emisor**: `csdStatus = ACTIVE` and not expiring within N days (else warn/block).
6. **FormaPago/MetodoPago** resolved and consistent (PUE for paid-in-full).

> ⚠️ Diligence (§17): facturapi's SAT-registry validation is real but under-documented; the 69-B-blacklist screening claim was **refuted**
> in research. Confirm depth with facturapi before marketing "cero rechazos" as turnkey. Our engine adds the deterministic checks
> regardless.

---

## 9. Tax handling (IVA / IEPS / retenciones / propina)

- **IVA (002, Traslado):** per-line `tasa` driven by `Product.taxRate`. Support 0.16 / 0.08 (frontera) / 0.00 / **exento** (exento needs
  `ObjetoImp=01` or 03 + no traslado). Today only flat 0.16 exists → extend.
- **IEPS (003):** relevant for retail selling alcohol/tobacco/sugary drinks. `Product.isAlcoholic` exists but no IEPS rate → add optional
  `iepsRate` for retail. Restaurants generally don't itemize IEPS.
- **Retenciones:** some service régimens require retención (e.g. honorarios). Model as optional per-line retención; off by default. MVP:
  most venues won't use it.
- **Propina (D2):** `tipAmount` is already separated everywhere. The CFDI base **excludes** the tip (SAT: propina is a gratuity to the
  employee, not venue income). No "addenda PROPINAS" needed — the tip simply doesn't enter the conceptos/impuestos. (If a corporate client
  needs the tip comprobable, that's a future addenda — out of MVP.)

---

## 10. Forma / Método de pago mapping

`satMapping.ts` maps `Payment.method` → SAT `c_FormaPago`:

| Avoqado `PaymentMethod` | SAT FormaPago                               |
| ----------------------- | ------------------------------------------- |
| CASH                    | 01 Efectivo                                 |
| CREDIT_CARD             | 04 Tarjeta de crédito                       |
| DEBIT_CARD              | 28 Tarjeta de débito                        |
| BANK_TRANSFER           | 03 Transferencia electrónica                |
| DIGITAL_WALLET          | 04/06 — **needs rule** (monedero vs wallet) |
| CRYPTOCURRENCY / OTHER  | 99 Por definir — flag for review            |

**MetodoPago:** PUE (pago en una exhibición) when the sale is fully paid at point of sale — the default for POS. PPD only if
`Order.remainingBalance > 0` at issuance (→ would need REP, §13, deferred).

---

## 11. Factura global (Flow C — Phase 3)

- Job `factura-global.job.ts` runs per `FiscalEmisor.globalPeriodicity` (default mensual), grouped per emisor.
- Gathers OUR un-invoiced sales (tracked in our DB) in the period whose merchant has `includeInGlobal=true` and that were NOT individually invoiced (A or B). NOT facturapi receipts (§7.3 cost decision).
- Issues one CFDI via `createInvoice` (the global variant): Receptor `XAXX010101000` "PÚBLICO EN GENERAL", `RegimenFiscalReceptor=616`, `UsoCFDI=S01`, with
  `InformacionGlobal { Periodicidad, Meses, Año }`.
- Idempotent per (venue, period) — never double-issue a period.
- Surfaces result + any excluded sales in the dashboard (no silent truncation).

---

## 12. Cancelación 4.0 (model now, full UX later)

- Motivos: 01 (comprobante con errores **con** relación → requires `cancelSubstituteUuid`), 02 (errores sin relación), 03 (no se llevó a
  cabo), 04 (operación nominativa en global).
- `DELETE /v2/invoices/{id} { motive, substitution }` → facturapi handles the SAT side (incl. receptor-acceptance for amounts > $1,000 MXN).
- We model `cancelStatus` (REQUESTED/ACCEPTED/REJECTED/CANCELLED) and poll/webhook for resolution.
- ⚠️ Compliance (research): cancelar fuera de plazo = multa **5–10% del valor de cada factura** (CFF 81-XLVI). The UI must warn on late
  cancellation; the engine timestamps everything.

---

## 13. Complemento de Pago / REP (DEFERRED — documented)

Only needed for **PPD** sales (credit/parcial). POS+Blumon sales are PUE, so **out of MVP.** When/if added:

- Trigger: a PPD invoice receives a payment → issue a REP.
- **Plazo (RMF 2.7.1.32):** by the **5th calendar day of the month FOLLOWING** the payment. Auto-schedule + alert.
- **Cent-exact "Totales" node:** must match individual payments to the centavo or the PAC auto-rejects.
- Late REP = infracción 83-VII → multa 84-IV.

---

## 14. Error handling, retries, storage, CSD health

- **Idempotency:** every issuance carries an idempotency key (mirror the `Payment.idempotencyKey` pattern) so retries never double-stamp.
- **Retries:** STAMP*FAILED → exponential backoff via `cfdi-stamp-retry.job.ts` (RabbitMQ/Redis). Distinguish \_retryable* (PAC timeout)
  from _terminal_ (invalid data → needs human fix).
- **Storage:** on stamp, persist `uuid`, `serie/folio`, and pull XML + PDF + acuse into blob storage (same store as `taxDocumentUrl`); set
  URLs on `Cfdi`. XML is the legal artifact — never lose it.
- **CSD health (`csd-health.job.ts`):** poll each org's CSD status; alert venue on EXPIRED/RESTRICTED (existential — no CSD = zero invoicing
  per 17-H Bis). Block issuance if not ACTIVE.
- **Email delivery:** XML+PDF to the receptor (reuse `email.service.ts` / resend).

---

## 15. Gating & access (RESOLVED: PAID, Pro-tier feature — not a free Module)

**Decision (2026-06-03, founder):** facturación is available **only on plan Pro+** ("solo en el plan Pro"). So it is a PAID, tier-gated
capability → use the `Feature`/`VenueFeature` + Stripe machinery, **NOT a free `Module`** (this overrides the earlier `MODULE_CODES.CFDI`
assumption). Consistent with `2026-06-02-venue-base-subscription-design.md`, where the Pro plan is a `Feature` row and premium capabilities
lock via `checkFeatureAccess` when a venue isn't Pro / stops paying. (That spec even listed "CFDI/factura generation" as explicit future
work — this is it.)

**Two independent gating layers (BOTH must pass to issue):**

1. **Plan entitlement (venue-level):** `checkFeatureAccess('CFDI')` → true only for Pro+ venues (and not in non-payment lock). If false →
   facturación hidden/locked entirely.
2. **Per-merchant config (within an entitled venue):** `MerchantFiscalConfig` decides WHICH merchants invoice / show the customer "facturar"
   / enter the global (§6.1b–c). A Pro venue still chooses per merchant.

- **Feature:** add a `Feature` (code `CFDI`) in the Pro entitlement set. Backend gate `checkFeatureAccess('CFDI')` via the feature-access
  middleware; sidebar **teaser** (lock → "upgrade to Pro") for non-Pro. Register in `PERMISSION_TO_FEATURE_MAP` (`access.service.ts`) so
  white-label feature-filtering works.
- **Permissions (config restricted to OWNER/ADMIN — founder decision 2026-06-03):**
  - `cfdi:configure` — set up emisor/CSD, per-merchant toggles, defaults, fiscal onboarding. **OWNER + ADMIN only.**
  - `cfdi:issue` — issue/cancel a CFDI from a closed bill (Flow B). Default OWNER/ADMIN/MANAGER (confirm whether CASHIER issues at the
    counter, in writing-plans). Flow A = customer self-serve (no staff perm); Flow C = automated job.
  - `cfdi:view` — view issued CFDIs / fiscal reports. OWNER/ADMIN/MANAGER.
  - Full cross-repo permission checklist (§18) + `npm run audit:permissions`.
- **Config object (per emisor/merchant, §6.1):**
  `{ autofacturaEnabled, includeInGlobal, globalPeriodicity, defaultUsoCfdi, iepsEnabled, retencionEnabled }`.
- **Non-payment edge:** if a Pro venue drops to basic, facturación locks; already-issued CFDIs + XMLs stay readable (legal records);
  issuance/global resumes on re-payment. (Detail for the plan.)
- **API responses:** new fields optional with defaults (never break old app versions — cross-repo rule).

---

## 16. Build phases (what each delivers)

| Phase          | Deliverable                                                                                                                                           | Done when                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **0 — Engine** | Schema (§6) + facturapi connector (§7) + validation (§8) + storage (§14) + fiscal onboarding (CSD upload, §7.2) + `CFDI` Feature gate (Pro-tier, §15) | A pilot venue is provisioned in facturapi; a hardcoded test sale stamps a valid CFDI 4.0 in sandbox |
| **1 — Flow B** | Dashboard: pick a closed bill → capture/validate receptor → stamp → store → email                                                                     | Staff issues a real CFDI for a real bill; appears with UUID + XML/PDF                               |
| **2 — Flow A** | QR/folio on ticket (TPV/POS) + autofactura portal (RFC + name + régimen + CP + UsoCFDI; **no constancia**)                                            | A diner self-invoices from the ticket; cero rechazos validated                                      |
| **3 — Flow C** | `factura-global.job.ts` + dashboard surfacing                                                                                                         | Month-end global CFDI issued for un-invoiced sales                                                  |

---

## 17. Open decisions / diligence (before/within implementation)

1. **Confirm with facturapi (commercial, not architecture):** (a) depth of pre-timbrado RFC-padrón validation incl. 69-B; (b) uptime / PAC
   redundancy (own PAC vs aggregator) + viability.
2. **Net vs IVA-included prices:** verify `Product.price` / `OrderItem.unitPrice` convention (net vs gross). `ValorUnitario` must be net.
   (Code check, §4.)
3. **SAT-key strategy:** confirm "default por categoría + override" (recommended) and seed the per-sector defaults
   (restaurant/retail/services/salon).
4. **DIGITAL_WALLET / OTHER / CRYPTO → FormaPago** disambiguation rules (§10).
5. **PUE-only MVP** confirmed? (defers REP entirely). Assumed yes.
6. **Feature-gating (RESOLVED 2026-06-03):** PAID, **Pro-tier** capability via `Feature`/`VenueFeature` + `checkFeatureAccess` (teaser →
   "upgrade to Pro" for non-Pro venues). NOT a free Module. Two gating layers: plan entitlement + per-merchant config. See §15.
7. **Alegra (RESOLVED 2026-06-03):** NOT an integration — it's the north-star for a _future native_ "Avoqado Contabilidad" capability built
   inside Avoqado. Out of scope for this module; this module is its foundation (§7.5).

---

## 18. Implementation governance (repo rules to honor — not optional)

- **Schema map:** new models (`FiscalEmisor`, `MerchantFiscalConfig`, `Cfdi`, `CustomerTaxProfile`) MUST be added to
  `scripts/generate-schema-map.ts` `MODEL_TO_DOMAIN` + `npm run schema:map`, same commit (`.claude/rules/critical-warnings.md`).
- **Migrations:** `npx prisma migrate dev --name ...` — NEVER `db push`.
- **Permissions:** `cfdi:configure` (OWNER/ADMIN only), `cfdi:issue`, `cfdi:view` follow the full cross-repo checklist
  (`.claude/rules/permissions-policy.md`) + `npm run audit:permissions`.
- **MCP sync (🔴):** every new model/service/endpoint/permission needs a matching tool in `scripts/mcp/` in the SAME change — e.g.
  `cfdi.issue`, `cfdi.status`, `cfdi.cancel`, `fiscal.config` (admin MCP). A capability not reachable via MCP is unfinished.
- **No breaking API fields:** new fields optional w/ defaults (old TPV/app versions depend on responses).
- **Money:** reconcile `Cfdi` integer-cents with the `Decimal` money on `Order`/`Payment`; al-centavo math, `$transaction` for issuance.

---

## 19. Sources (PAC research, verified 2026-06-03)

- facturapi multiemisor + pricing + receipts: facturapi.io/pricing, docs.facturapi.io/docs/guides/{organizations,receipts},
  help.facturapi.io
- facturapi Node SDK: github.com/FacturAPI/facturapi-node, npmjs.com/package/facturapi (v4.17.0)
- Facturama Multiemisor (runner-up): apisandbox.facturama.mx/guias/{diferencias,api-multi/csds,cfdi40/multiemisor},
  facturama.mx/api-facturacion-electronica
- SAT 2026 compliance (CSD/17-H Bis, constancia, REP, cancelación): see `sat-2026-compliance-facts.md`
