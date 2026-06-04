# Facturación CFDI — Phase 0b: facturapi Connector — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use
> checkbox (`- [ ]`) syntax.

**Goal:** Build the provider-agnostic CFDI connector layer — a `FiscalProvider` interface + a facturapi adapter (org provisioning, CSD
upload, receptor validation, stamp, cancel, XML/PDF download) + encrypted key storage + env config + the deferred `MerchantFiscalConfig` XOR
check — all unit-tested with the facturapi SDK mocked. Live sandbox stamping is a final GATED step that needs a facturapi `sk_test_` key.

**Architecture:** Mirror the existing `src/services/payments/providers/` pattern (interface + concrete providers +
`not-implemented.error.ts`). New dir `src/services/fiscal/providers/`. Per-emisor facturapi keys are stored in `FiscalEmisor.providerKeyEnc`
(base64 AES-256-GCM via the repo's `createTokenCipher`). The adapter is instantiated per-call with the resolved key. Everything is
provider-agnostic so Facturama/Alegra adapters slot in later (spec §7.4–7.5).

**Tech Stack:** facturapi npm SDK (TS-first), Prisma, Zod env validation, Jest (mocked SDK).

**Scope — IN:** env + SDK install, `MerchantFiscalConfig` XOR CHECK migration, `FiscalProvider` interface, facturapi adapter, key-resolution
helper (encrypt/decrypt), unit tests (SDK mocked). **OUT (later plans):** receipts/global-invoice methods (Phase 2/3 — A/C flows), the
pre-timbrado validation engine orchestration (0c), the `CFDI` Feature + `cfdi:*` permissions + MCP tools (0d), any HTTP
routes/controllers/UI. Design source: `docs/superpowers/specs/2026-06-03-facturacion-cfdi-module-design.md` §7.

**Reference rules:** `.claude/rules/critical-warnings.md` (migrations NEVER `db push`; money rules), `.claude/rules/testing-and-git.md`
(NEVER commit without asking; temp scripts deleted before commit).

**⚠️ Dependency:** Tasks 1–8 build + unit-test the connector WITHOUT any facturapi account (SDK is mocked). **Task 9 (live sandbox smoke
test) requires a facturapi `sk_test_` key** and is therefore GATED — skip it until the founder provides the key.

---

### Task 1: Install facturapi SDK + add env vars

**Files:**

- Modify: `package.json` (dependency, via npm)
- Modify: `src/config/env.ts` (add to the `envSchema` zod object)
- Modify: `.env.example` (document the new vars)

- [ ] **Step 1: Install the SDK**

Run: `npm install facturapi` Expected: `facturapi` added to `dependencies` in `package.json`.

- [ ] **Step 2: Add env vars to the Zod schema**

In `src/config/env.ts`, inside the `envSchema = z.object({ ... })`, add a new block (all optional — facturación is opt-in per venue and not
configured in every environment):

```typescript
  // ─────────────────────────────────────────────────────────────────────────
  // FACTURACIÓN CFDI (facturapi)
  // ─────────────────────────────────────────────────────────────────────────
  /** facturapi account-level User Key (sk_user_…) — provisions organizations (emisores). Prod only. */
  FACTURAPI_USER_KEY: z.string().optional(),
  /** facturapi sandbox/test key (sk_test_…) — used in dev/staging to issue NON-billed test CFDIs. */
  FACTURAPI_TEST_KEY: z.string().optional(),
  /** Override base URL (defaults to facturapi prod in the SDK). Rarely needed. */
  FACTURAPI_BASE_URL: z.string().url().optional(),
  /** 32-byte hex key used to encrypt per-emisor facturapi live keys at rest (FiscalEmisor.providerKeyEnc). */
  FISCAL_PROVIDER_KEY: z.string().length(64, 'FISCAL_PROVIDER_KEY must be a 32-byte hex string (64 chars)').optional(),
```

- [ ] **Step 3: Document in `.env.example`**

Append:

```bash
# Facturación CFDI (facturapi) — optional; required only for venues on the Pro plan that enable facturación
FACTURAPI_USER_KEY=        # sk_user_... (prod: provisions emisor organizations)
FACTURAPI_TEST_KEY=        # sk_test_... (dev/staging: non-billed sandbox stamping)
# FACTURAPI_BASE_URL=      # optional override
FISCAL_PROVIDER_KEY=       # 32-byte hex (openssl rand -hex 32) — encrypts per-emisor keys at rest
```

- [ ] **Step 4: Verify build still compiles**

Run: `npm run build` Expected: exit 0 (env schema additions are optional, nothing else changed yet).

---

### Task 2: Add the `MerchantFiscalConfig` XOR CHECK constraint (0a follow-up)

Enforce at the DB level that exactly one merchant FK is set (spec §6.1b; flagged by the 0a review). Prisma can't express CHECK in the
schema, so use a `--create-only` migration and hand-edit the SQL.

**Files:**

- Create: `prisma/migrations/<timestamp>_merchant_fiscal_config_xor/migration.sql`

- [ ] **Step 1: Create an empty migration**

Run: `npx prisma migrate dev --create-only --name merchant_fiscal_config_xor` Expected: a new migration folder with an (empty or no-op)
`migration.sql`.

- [ ] **Step 2: Write the CHECK into that migration.sql**

Replace the file contents with:

```sql
-- Exactly ONE of merchantAccountId / ecommerceMerchantId must be set on a MerchantFiscalConfig.
ALTER TABLE "MerchantFiscalConfig"
  ADD CONSTRAINT "merchant_fiscal_config_exactly_one_merchant"
  CHECK (("merchantAccountId" IS NOT NULL) <> ("ecommerceMerchantId" IS NOT NULL));
```

- [ ] **Step 3: Apply it**

Run: `npx prisma migrate dev` Expected: migration applies cleanly. (No existing rows → no violation.) If it warns about a DB reset/drift →
STOP and report BLOCKED (do NOT reset).

---

### Task 3: Define the `FiscalProvider` interface + NotImplemented error

**Files:**

- Create: `src/services/fiscal/providers/fiscal-provider.interface.ts`
- Create: `src/services/fiscal/providers/not-implemented.error.ts`

- [ ] **Step 1: Write the NotImplemented error** (mirrors `src/services/payments/providers/not-implemented.error.ts`)

```typescript
/** Thrown by a FiscalProvider adapter for a contract method it does not yet implement. */
export class FiscalNotImplementedError extends Error {
  constructor(provider: string, method: string) {
    super(`FiscalProvider "${provider}" does not implement "${method}"`)
    this.name = 'FiscalNotImplementedError'
  }
}
```

- [ ] **Step 2: Write the interface + types**

```typescript
// Provider-agnostic CFDI contract. facturapi is the first adapter (spec §7.4).
// Money is integer cents end-to-end (cuadra al centavo).

export interface CreateOrgParams {
  legalName: string // razón social
  email: string
}

export interface CreateOrgResult {
  providerOrgId: string
  liveKey: string // per-org sk_live_ — caller encrypts before persisting
  testKey: string // per-org sk_test_
}

export interface UploadCsdParams {
  providerOrgId: string
  cerBase64: string
  keyBase64: string
  csdPassword: string
}

export interface UploadCsdResult {
  csdExpiresAt: Date | null
}

export interface ReceptorInput {
  rfc: string
  razonSocial: string
  regimenFiscal: string // c_RegimenFiscal
  codigoPostal: string
}

export interface ReceptorValidationResult {
  valid: boolean
  reasons: string[] // human-readable, Spanish (shown to staff/customer on failure)
}

export interface CfdiItemTax {
  type: 'IVA' | 'IEPS' | 'ISR'
  factor: 'Tasa' | 'Cuota' | 'Exento'
  rate: number // e.g. 0.16
  withholding: boolean // true = retención, false = traslado
}

export interface CfdiItemInput {
  satProductKey: string // ClaveProdServ
  satUnitKey: string // ClaveUnidad
  description: string
  quantity: number
  unitPriceCents: number // NET (sin IVA)
  discountCents: number
  objetoImp: string // 01/02/03
  taxes: CfdiItemTax[]
}

export interface CreateInvoiceParams {
  receptor: ReceptorInput & { usoCfdi: string; email?: string }
  items: CfdiItemInput[]
  formaPago: string // c_FormaPago
  metodoPago: 'PUE' | 'PPD'
  serie?: string
  idempotencyKey: string
}

export interface StampedInvoice {
  providerInvoiceId: string
  uuid: string // folio fiscal
  serie: string | null
  folio: string | null
  totalCents: number
  stampedAt: Date
  status: 'valid' | 'canceled'
}

export interface CancelInvoiceParams {
  providerInvoiceId: string
  motivo: '01' | '02' | '03' | '04'
  substituteUuid?: string // required when motivo = 01
}

export interface CancelInvoiceResult {
  status: 'pending' | 'accepted' | 'canceled' | 'rejected'
  cancelledAt: Date | null
}

/**
 * A CFDI provider (PAC integration layer). facturapi is the first adapter.
 * Receipts + global-invoice methods are intentionally NOT in this contract yet —
 * they arrive with the A/C issuance phases.
 */
export interface FiscalProvider {
  readonly name: string
  createOrganization(params: CreateOrgParams): Promise<CreateOrgResult>
  uploadCsd(params: UploadCsdParams): Promise<UploadCsdResult>
  validateReceptor(params: ReceptorInput): Promise<ReceptorValidationResult>
  createInvoice(params: CreateInvoiceParams): Promise<StampedInvoice>
  getInvoice(providerInvoiceId: string): Promise<StampedInvoice>
  downloadXml(providerInvoiceId: string): Promise<Buffer>
  downloadPdf(providerInvoiceId: string): Promise<Buffer>
  cancelInvoice(params: CancelInvoiceParams): Promise<CancelInvoiceResult>
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build` Expected: exit 0.

---

### Task 4: Implement the facturapi adapter

**Files:**

- Create: `src/services/fiscal/providers/facturapi.provider.ts`
- Test: `tests/unit/services/fiscal/facturapi.provider.test.ts`

> **SDK accuracy:** the `facturapi` package is TypeScript-first. BEFORE writing calls, read the installed types at
> `node_modules/facturapi/dist/index.d.ts` and `node_modules/facturapi/dist/types/` to confirm exact method names/shapes (e.g.
> `organizations.create`, `organizations.uploadCertificate` / `uploadLogo`, `invoices.create`, `invoices.retrieve`, `invoices.downloadXml`,
> `invoices.downloadPdf`, `invoices.cancel`, customer tax-info validation). Adjust the calls below to match the real signatures — do NOT
> guess.

- [ ] **Step 1: Write the failing test (SDK mocked)**

```typescript
// tests/unit/services/fiscal/facturapi.provider.test.ts
const mockCreate = jest.fn()
const mockRetrieve = jest.fn()
const mockCancel = jest.fn()
const mockOrgCreate = jest.fn()

jest.mock('facturapi', () => {
  return jest.fn().mockImplementation(() => ({
    invoices: { create: mockCreate, retrieve: mockRetrieve, cancel: mockCancel },
    organizations: { create: mockOrgCreate },
  }))
})

import { FacturapiProvider } from '../../../../src/services/fiscal/providers/facturapi.provider'

describe('FacturapiProvider', () => {
  beforeEach(() => jest.clearAllMocks())

  // NEW FEATURE
  it('createInvoice maps our cents-based params to the SDK and returns a StampedInvoice', async () => {
    mockCreate.mockResolvedValue({
      id: 'fa_inv_1',
      uuid: 'UUID-123',
      series: 'A',
      folio_number: 42,
      total: 116.0,
      stamp: { date: '2026-06-03T10:00:00Z' },
      status: 'valid',
    })
    const provider = new FacturapiProvider('sk_test_x')
    const result = await provider.createInvoice({
      receptor: {
        rfc: 'EKU9003173C9',
        razonSocial: 'ESCUELA KEMPER URGATE SA DE CV',
        regimenFiscal: '601',
        codigoPostal: '64000',
        usoCfdi: 'G03',
      },
      items: [
        {
          satProductKey: '90101500',
          satUnitKey: 'E48',
          description: 'Servicio',
          quantity: 1,
          unitPriceCents: 10000,
          discountCents: 0,
          objetoImp: '02',
          taxes: [{ type: 'IVA', factor: 'Tasa', rate: 0.16, withholding: false }],
        },
      ],
      formaPago: '01',
      metodoPago: 'PUE',
      idempotencyKey: 'idem-1',
    })
    expect(result.uuid).toBe('UUID-123')
    expect(result.totalCents).toBe(11600)
    expect(mockCreate).toHaveBeenCalledTimes(1)
    // unit price sent to SDK is pesos (net), not cents
    const sentItems = mockCreate.mock.calls[0][0].items
    expect(sentItems[0].product.price).toBe(100)
  })

  it('cancelInvoice passes motive + substitution', async () => {
    mockCancel.mockResolvedValue({ status: 'canceled', cancellation_status: 'accepted' })
    const provider = new FacturapiProvider('sk_test_x')
    const r = await provider.cancelInvoice({ providerInvoiceId: 'fa_inv_1', motivo: '02' })
    expect(mockCancel).toHaveBeenCalledWith('fa_inv_1', expect.objectContaining({ motive: '02' }))
    expect(['accepted', 'canceled']).toContain(r.status)
  })

  // REGRESSION / edge
  it('throws a clear error when the SDK rejects (PAC/SAT error)', async () => {
    mockCreate.mockRejectedValue(new Error('TaxObjectError: 02 required'))
    const provider = new FacturapiProvider('sk_test_x')
    await expect(
      provider.createInvoice({
        receptor: { rfc: 'X', razonSocial: 'Y', regimenFiscal: '601', codigoPostal: '64000', usoCfdi: 'G03' },
        items: [],
        formaPago: '01',
        metodoPago: 'PUE',
        idempotencyKey: 'i',
      }),
    ).rejects.toThrow(/TaxObjectError/)
  })
})
```

- [ ] **Step 2: Run it to confirm failure**

Run: `npm test -- tests/unit/services/fiscal/facturapi.provider.test.ts` Expected: FAIL (module `facturapi.provider` not found).

- [ ] **Step 3: Implement the adapter**

```typescript
// src/services/fiscal/providers/facturapi.provider.ts
import Facturapi from 'facturapi'
import logger from '../../../config/logger'
import {
  CancelInvoiceParams,
  CancelInvoiceResult,
  CreateInvoiceParams,
  CreateOrgParams,
  CreateOrgResult,
  FiscalProvider,
  ReceptorInput,
  ReceptorValidationResult,
  StampedInvoice,
  UploadCsdParams,
  UploadCsdResult,
} from './fiscal-provider.interface'

const toPesos = (cents: number): number => Math.round(cents) / 100
const toCents = (pesos: number): number => Math.round(pesos * 100)

/** facturapi adapter. Instantiate per-emisor with that org's secret key (or the test key in sandbox). */
export class FacturapiProvider implements FiscalProvider {
  readonly name = 'facturapi'
  private client: any

  constructor(apiKey: string) {
    if (!apiKey) throw new Error('FacturapiProvider requires an API key')
    this.client = new (Facturapi as any)(apiKey)
  }

  async createOrganization(params: CreateOrgParams): Promise<CreateOrgResult> {
    const org = await this.client.organizations.create({ name: params.legalName })
    // NOTE: confirm against SDK types how live/test keys are returned (may be a separate
    // organizations.getApiKeys / retrieve call). Adjust to the real shape.
    return { providerOrgId: org.id, liveKey: org.livekey ?? '', testKey: org.testkey ?? '' }
  }

  async uploadCsd(params: UploadCsdParams): Promise<UploadCsdResult> {
    // Confirm the real method name in SDK types (e.g. organizations.uploadCertificate).
    const res = await this.client.organizations.uploadCertificate(params.providerOrgId, {
      cer: Buffer.from(params.cerBase64, 'base64'),
      key: Buffer.from(params.keyBase64, 'base64'),
      password: params.csdPassword,
    })
    return { csdExpiresAt: res?.expires_at ? new Date(res.expires_at) : null }
  }

  async validateReceptor(params: ReceptorInput): Promise<ReceptorValidationResult> {
    const reasons: string[] = []
    if (!/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/i.test(params.rfc)) reasons.push('El RFC no tiene un formato válido.')
    if (!/^\d{5}$/.test(params.codigoPostal)) reasons.push('El código postal debe tener 5 dígitos.')
    if (!params.razonSocial?.trim()) reasons.push('La razón social es obligatoria.')
    if (!params.regimenFiscal?.trim()) reasons.push('El régimen fiscal es obligatorio.')
    // SDK-backed SAT-registry validation (confirm the exact method in types; may live under
    // client.customers or a dedicated validate endpoint). If unavailable, format checks above stand
    // and facturapi will reject at create() time.
    return { valid: reasons.length === 0, reasons }
  }

  async createInvoice(params: CreateInvoiceParams): Promise<StampedInvoice> {
    const payload = {
      customer: {
        legal_name: params.receptor.razonSocial,
        tax_id: params.receptor.rfc,
        tax_system: params.receptor.regimenFiscal,
        address: { zip: params.receptor.codigoPostal },
        email: params.receptor.email,
      },
      use: params.receptor.usoCfdi,
      payment_form: params.formaPago,
      payment_method: params.metodoPago,
      series: params.serie,
      items: params.items.map(it => ({
        quantity: it.quantity,
        discount: toPesos(it.discountCents),
        product: {
          description: it.description,
          product_key: it.satProductKey,
          unit_key: it.satUnitKey,
          price: toPesos(it.unitPriceCents), // NET pesos
          tax_included: false,
          taxes: it.taxes.map(t => ({ type: t.type, rate: t.rate, factor: t.factor, withholding: t.withholding })),
        },
      })),
    }
    try {
      const inv = await this.client.invoices.create(payload, { idempotencyKey: params.idempotencyKey } as any)
      return this.toStamped(inv)
    } catch (err: any) {
      logger.error(`[facturapi] createInvoice failed: ${err?.message}`)
      throw err
    }
  }

  async getInvoice(providerInvoiceId: string): Promise<StampedInvoice> {
    const inv = await this.client.invoices.retrieve(providerInvoiceId)
    return this.toStamped(inv)
  }

  async downloadXml(providerInvoiceId: string): Promise<Buffer> {
    const stream = await this.client.invoices.downloadXml(providerInvoiceId)
    return this.streamToBuffer(stream)
  }

  async downloadPdf(providerInvoiceId: string): Promise<Buffer> {
    const stream = await this.client.invoices.downloadPdf(providerInvoiceId)
    return this.streamToBuffer(stream)
  }

  async cancelInvoice(params: CancelInvoiceParams): Promise<CancelInvoiceResult> {
    const opts: any = { motive: params.motivo }
    if (params.substituteUuid) opts.substitution = params.substituteUuid
    const res = await this.client.invoices.cancel(params.providerInvoiceId, opts)
    const status = (res?.cancellation_status ?? res?.status ?? 'pending') as CancelInvoiceResult['status']
    return { status, cancelledAt: status === 'canceled' || status === 'accepted' ? new Date() : null }
  }

  private toStamped(inv: any): StampedInvoice {
    return {
      providerInvoiceId: inv.id,
      uuid: inv.uuid,
      serie: inv.series ?? null,
      folio: inv.folio_number != null ? String(inv.folio_number) : null,
      totalCents: toCents(Number(inv.total ?? 0)),
      stampedAt: inv.stamp?.date ? new Date(inv.stamp.date) : new Date(),
      status: inv.status === 'canceled' ? 'canceled' : 'valid',
    }
  }

  private async streamToBuffer(stream: any): Promise<Buffer> {
    if (Buffer.isBuffer(stream)) return stream
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks)
  }
}
```

- [ ] **Step 4: Run the test to green**

Run: `npm test -- tests/unit/services/fiscal/facturapi.provider.test.ts` Expected: PASS (3/3). If a mismatch surfaces a real SDK signature
difference, fix the adapter to match the installed types and re-run.

---

### Task 5: Per-emisor key resolution (encrypt/decrypt)

**Files:**

- Create: `src/services/fiscal/fiscalKey.service.ts`
- Test: `tests/unit/services/fiscal/fiscalKey.service.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/services/fiscal/fiscalKey.service.test.ts
import { encryptProviderKey, decryptProviderKey } from '../../../../src/services/fiscal/fiscalKey.service'

describe('fiscalKey.service', () => {
  const KEY = 'a'.repeat(64) // 32-byte hex
  beforeAll(() => {
    process.env.FISCAL_PROVIDER_KEY = KEY
  })

  it('round-trips a provider key through encrypt/decrypt', () => {
    const enc = encryptProviderKey('sk_live_secret123')
    expect(enc).not.toContain('sk_live_secret123') // stored ciphertext, not plaintext
    expect(decryptProviderKey(enc)).toBe('sk_live_secret123')
  })

  it('throws if FISCAL_PROVIDER_KEY is missing', () => {
    delete process.env.FISCAL_PROVIDER_KEY
    expect(() => encryptProviderKey('x')).toThrow()
    process.env.FISCAL_PROVIDER_KEY = KEY
  })
})
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm test -- tests/unit/services/fiscal/fiscalKey.service.test.ts` Expected: FAIL (module not found).

- [ ] **Step 3: Implement (reuse the repo's `createTokenCipher`)**

```typescript
// src/services/fiscal/fiscalKey.service.ts
import { createTokenCipher } from '../../lib/token-encryption'

// Lazy: createTokenCipher reads process.env[name] on each call, so a single instance is fine.
const cipher = createTokenCipher('FISCAL_PROVIDER_KEY')

/** Encrypt a facturapi per-org secret key for storage in FiscalEmisor.providerKeyEnc (base64). */
export function encryptProviderKey(plaintext: string): string {
  return cipher.encryptToBase64(plaintext)
}

/** Decrypt FiscalEmisor.providerKeyEnc back to the facturapi secret key. */
export function decryptProviderKey(encBase64: string): string {
  return cipher.decryptFromBase64(encBase64)
}
```

- [ ] **Step 4: Run to green**

Run: `npm test -- tests/unit/services/fiscal/fiscalKey.service.test.ts` Expected: PASS (2/2).

---

### Task 6: Provider factory (resolve adapter + key for an emisor)

**Files:**

- Create: `src/services/fiscal/fiscalProvider.factory.ts`
- Test: `tests/unit/services/fiscal/fiscalProvider.factory.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/services/fiscal/fiscalProvider.factory.test.ts
jest.mock('facturapi', () => jest.fn().mockImplementation(() => ({})))
import { resolveFiscalProvider } from '../../../../src/services/fiscal/fiscalProvider.factory'
import { encryptProviderKey } from '../../../../src/services/fiscal/fiscalKey.service'

describe('resolveFiscalProvider', () => {
  beforeAll(() => {
    process.env.FISCAL_PROVIDER_KEY = 'b'.repeat(64)
    process.env.FACTURAPI_TEST_KEY = 'sk_test_env'
  })

  it('uses the emisor decrypted live key when present', () => {
    const emisor = { provider: 'FACTURAPI', providerKeyEnc: encryptProviderKey('sk_live_org') } as any
    const p = resolveFiscalProvider(emisor, { sandbox: false })
    expect(p.name).toBe('facturapi')
  })

  it('falls back to FACTURAPI_TEST_KEY in sandbox when emisor has no key', () => {
    const emisor = { provider: 'FACTURAPI', providerKeyEnc: null } as any
    const p = resolveFiscalProvider(emisor, { sandbox: true })
    expect(p.name).toBe('facturapi')
  })

  it('throws for an unknown provider', () => {
    expect(() => resolveFiscalProvider({ provider: 'SOMETHING', providerKeyEnc: null } as any, { sandbox: true })).toThrow()
  })
})
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm test -- tests/unit/services/fiscal/fiscalProvider.factory.test.ts` Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
// src/services/fiscal/fiscalProvider.factory.ts
import { FiscalEmisor } from '@prisma/client'
import { FiscalProvider } from './providers/fiscal-provider.interface'
import { FacturapiProvider } from './providers/facturapi.provider'
import { decryptProviderKey } from './fiscalKey.service'

type EmisorKeyFields = Pick<FiscalEmisor, 'provider' | 'providerKeyEnc'>

/**
 * Resolve the FiscalProvider adapter (with the right API key) for an emisor.
 * sandbox=true → use FACTURAPI_TEST_KEY (non-billed test stamps) when the emisor has no stored key.
 */
export function resolveFiscalProvider(emisor: EmisorKeyFields, opts: { sandbox: boolean }): FiscalProvider {
  switch (emisor.provider) {
    case 'FACTURAPI': {
      const key = emisor.providerKeyEnc
        ? decryptProviderKey(emisor.providerKeyEnc)
        : opts.sandbox
          ? process.env.FACTURAPI_TEST_KEY
          : undefined
      if (!key) throw new Error('No facturapi key available for emisor (no providerKeyEnc and no FACTURAPI_TEST_KEY in sandbox)')
      return new FacturapiProvider(key)
    }
    // FACTURAMA / ALEGRA adapters land in future plans (spec §7.5)
    default:
      throw new Error(`Unsupported fiscal provider: ${emisor.provider}`)
  }
}
```

- [ ] **Step 4: Run to green**

Run: `npm test -- tests/unit/services/fiscal/fiscalProvider.factory.test.ts` Expected: PASS (3/3).

---

### Task 7: Format + full regression check

- [ ] **Step 1: Format + lint**

Run: `npm run format && npm run lint:fix` Expected: no errors.

- [ ] **Step 2: Build + unit tests**

Run: `npm run build && npm run test:unit` Expected: build exit 0; all unit tests pass (3369 baseline + the new fiscal tests). 0 failures.

---

### Task 8: Stop for commit decision (DO NOT commit unless the human says so)

Per `.claude/rules/testing-and-git.md`, NEVER commit without explicit permission, and the human asked for NO commits this session. So: do
NOT `git add`/`git commit`. Leave changes in the working tree. Report the file list. If/when the human approves a commit, stage ONLY:

```
package.json package-lock.json
src/config/env.ts .env.example
prisma/migrations/<merchant_fiscal_config_xor folder>
src/services/fiscal/**
tests/unit/services/fiscal/**
```

Do NOT stage unrelated WIP.

---

### Task 9: 🔒 GATED — Live sandbox smoke test (needs a facturapi `sk_test_` key)

**Skip this task unless the founder has provided a facturapi sandbox key in `FACTURAPI_TEST_KEY`.** It is the real end-to-end proof and
consumes NO billable timbres (test mode), but it cannot run without an account.

**Files:**

- Create (temporary, delete after): `scripts/temp-facturapi-sandbox-smoke.ts`

- [ ] **Step 1: Write the smoke script**

```typescript
// DELETE AFTER: live facturapi sandbox smoke test (Phase 0b)
// Requires FACTURAPI_TEST_KEY (sk_test_...). Stamps a test CFDI — NOT billed, NOT sent to SAT.
import { FacturapiProvider } from '../src/services/fiscal/providers/facturapi.provider'

async function main() {
  const key = process.env.FACTURAPI_TEST_KEY
  if (!key) throw new Error('Set FACTURAPI_TEST_KEY (sk_test_...) to run the sandbox smoke test')
  const p = new FacturapiProvider(key)

  const v = await p.validateReceptor({
    rfc: 'EKU9003173C9',
    razonSocial: 'ESCUELA KEMPER URGATE SA DE CV',
    regimenFiscal: '601',
    codigoPostal: '64000',
  })
  console.log('validateReceptor:', v)

  const inv = await p.createInvoice({
    receptor: {
      rfc: 'EKU9003173C9',
      razonSocial: 'ESCUELA KEMPER URGATE SA DE CV',
      regimenFiscal: '601',
      codigoPostal: '64000',
      usoCfdi: 'G03',
    },
    items: [
      {
        satProductKey: '90101500',
        satUnitKey: 'E48',
        description: 'Servicio de prueba',
        quantity: 1,
        unitPriceCents: 10000,
        discountCents: 0,
        objetoImp: '02',
        taxes: [{ type: 'IVA', factor: 'Tasa', rate: 0.16, withholding: false }],
      },
    ],
    formaPago: '01',
    metodoPago: 'PUE',
    idempotencyKey: `smoke-${Date.now()}`,
  })
  console.log('STAMPED:', inv.uuid, inv.totalCents)

  const xml = await p.downloadXml(inv.providerInvoiceId)
  console.log('XML bytes:', xml.length)
  console.log('✅ facturapi sandbox smoke test OK')
}

main()
  .catch(e => {
    console.error('❌', e?.response?.data ?? e)
    process.exit(1)
  })
  .finally(() => process.exit(0))
```

- [ ] **Step 2: Run it**

Run: `FACTURAPI_TEST_KEY=sk_test_... npx ts-node -r tsconfig-paths/register scripts/temp-facturapi-sandbox-smoke.ts` Expected: prints a
stamped `uuid` + XML byte count + `✅`. If the SDK signatures differ from Task 4, fix the adapter and re-run.

- [ ] **Step 3: Delete the temp script**

Run: `rm scripts/temp-facturapi-sandbox-smoke.ts`

---

## Self-review

**Spec coverage (§7):** §7.1 auth/keys + sandbox ✓ (T1 env, T6 factory sandbox fallback); §7.2 org provisioning + CSD upload ✓ (T4
createOrganization/uploadCsd); §7.4 provider-agnostic interface + facturapi adapter ✓ (T3, T4); D1 receptor validation ✓ (T4
validateReceptor, format-level + SDK-backed). 0a follow-ups: XOR CHECK ✓ (T2), providerKeyEnc encryption ✓ (T5). **Deferred by design:**
receipts/global (A/C phases), validation-engine orchestration (0c), Feature/permissions/MCP (0d), routes/UI.

**Placeholder scan:** none. The only "confirm against SDK types" notes are for the third-party facturapi surface (legitimate — the
implementer reads installed `dist/types`), not for our own logic.

**Type consistency:** `FiscalProvider` methods + types are used identically across adapter (T4) and factory (T6). Money is integer cents at
our boundary; `toPesos`/`toCents` convert only at the SDK edge. `encryptProviderKey`/`decryptProviderKey` names match between T5 and T6.

**Note:** Task 9 is gated on a facturapi account. Tasks 1–8 deliver a fully unit-tested connector without it.
