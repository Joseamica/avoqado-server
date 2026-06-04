# Facturación CFDI — Phase 0c-2: Issuance Orchestration — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Checkbox steps.

**Goal:** Wire a real Avoqado sale to the connector: `issueCfdiForOrder(orderId, receptor)` loads the Order → maps it to a CFDI payload
(pure) → validates (D1) → idempotency pre-check → stamps via the 0b connector → persists a `Cfdi` → stores XML/PDF to blob. After this, an
order can be stamped end-to-end (sandbox).

**Architecture:** Two units. (1) `assembleSaleInput.ts` — a PURE function from loaded Prisma entities → the 0c `AvoqadoSaleInput` (Decimal
pesos → integer cents, resolve per-item taxRate, tip). Fully unit-testable, no I/O. (2) `cfdi.service.ts` — the orchestrator, written with
**dependency injection** (loader / provider-factory / storage are injected, defaulting to the real impls) so its control-flow branches are
unit-testable with plain mocks, no DB. Reuses 0b (`resolveFiscalProvider`, `FiscalProvider`) and 0c (`buildCreateInvoiceParams`,
`validateBeforeStamp`).

**Tech Stack:** TypeScript, Prisma, Jest (mocked deps), `uploadFileToStorage`/`buildStoragePath` from `src/services/storage.service.ts`.

**Scope — IN:** `assembleSaleInput.ts` + tests; `cfdi.service.ts` `issueCfdiForOrder` (idempotency, validate, stamp, persist Cfdi, store
XML/PDF) + tests. **OUT (later):** HTTP routes/controllers, the `CFDI` Feature + `cfdi:*` permissions + MCP (0d), the autofactura portal +
global job (phases 1-3), email delivery (thin add-on later), REP. Carries 0c LOW items (per-line tasa-set check) — NOT added here; tracked
for a later hardening pass. Design: spec §7.3, §8, §14.

**Reference rules:** `.claude/rules/critical-warnings.md` (Money = Decimal/cents; `prisma.$transaction` for money;
`buildStoragePath`+`venue.slug` for storage; tenant isolation — always filter by venueId). `.claude/rules/testing-and-git.md` (NEVER commit
without asking).

---

### Task 1: Pure mapping `assembleSaleInput.ts`

**Files:**

- Create: `src/services/fiscal/assembleSaleInput.ts`
- Test: `tests/unit/services/fiscal/assembleSaleInput.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/services/fiscal/assembleSaleInput.test.ts
import { Prisma } from '@prisma/client'
import { assembleSaleInput, LoadedOrderForCfdi } from '../../../../src/services/fiscal/assembleSaleInput'

const D = (n: number) => new Prisma.Decimal(n)

const order: LoadedOrderForCfdi = {
  venueType: 'RESTAURANT',
  tipAmount: D(15),
  items: [
    {
      productName: 'Tacos',
      quantity: 2,
      unitPrice: D(50), // NET pesos
      discountAmount: D(0),
      product: {
        satProductKey: null,
        satUnitKey: null,
        objetoImp: '02',
        taxRate: D(0.16),
        category: { defaultSatProductKey: '90101500', defaultSatUnitKey: 'E48' },
      },
    },
  ],
}

describe('assembleSaleInput', () => {
  it('converts Decimal pesos → integer cents and carries SAT keys + tip', () => {
    const input = assembleSaleInput(order, {
      receptor: { rfc: 'XAXX010101000', razonSocial: 'PUBLICO EN GENERAL', regimenFiscal: '616', codigoPostal: '83240', usoCfdi: 'S01' },
      paymentMethod: 'CASH',
      metodoPago: 'PUE',
      idempotencyKey: 'cfdi-order-1',
    })
    expect(input.venueType).toBe('RESTAURANT')
    expect(input.tipCents).toBe(1500)
    expect(input.items[0].unitPriceCents).toBe(5000)
    expect(input.items[0].taxRate).toBe(0.16)
    expect(input.items[0].taxExempt).toBe(false)
    expect(input.items[0].categoryDefaultProductKey).toBe('90101500')
    expect(input.items[0].description).toBe('Tacos')
  })

  it('marks 0%/exempt items and tolerates a deleted product (null → sector default later)', () => {
    const exempt: LoadedOrderForCfdi = {
      ...order,
      items: [
        {
          productName: 'Libro',
          quantity: 1,
          unitPrice: D(100),
          discountAmount: D(0),
          product: { satProductKey: null, satUnitKey: null, objetoImp: '01', taxRate: D(0), category: null },
        },
      ],
    }
    const input = assembleSaleInput(exempt, {
      receptor: (order as any) && { rfc: 'XAXX010101000', razonSocial: 'P', regimenFiscal: '616', codigoPostal: '83240', usoCfdi: 'S01' },
      paymentMethod: 'CASH',
      metodoPago: 'PUE',
      idempotencyKey: 'k',
    })
    expect(input.items[0].taxExempt).toBe(true)
    expect(input.items[0].taxRate).toBe(0)
    expect(input.items[0].categoryDefaultProductKey).toBeNull()
  })

  it('handles a fully null product (deleted) without throwing', () => {
    const noProduct: LoadedOrderForCfdi = {
      ...order,
      items: [{ productName: 'X', quantity: 1, unitPrice: D(10), discountAmount: D(0), product: null }],
    }
    const input = assembleSaleInput(noProduct, {
      receptor: { rfc: 'XAXX010101000', razonSocial: 'P', regimenFiscal: '616', codigoPostal: '83240', usoCfdi: 'S01' },
      paymentMethod: 'CASH',
      metodoPago: 'PUE',
      idempotencyKey: 'k',
    })
    expect(input.items[0].taxRate).toBe(0.16) // default IVA when no product
    expect(input.items[0].satProductKey).toBeNull()
  })
})
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement**

```typescript
// src/services/fiscal/assembleSaleInput.ts
import { Prisma, PaymentMethod, VenueType } from '@prisma/client'
import { AvoqadoSaleInput, AvoqadoSaleItemInput } from './cfdiPayloadBuilder'

const centsOf = (d: Prisma.Decimal): number => Math.round(Number(d) * 100)

export interface LoadedOrderItemForCfdi {
  productName: string | null
  quantity: number
  unitPrice: Prisma.Decimal // NET pesos
  discountAmount: Prisma.Decimal
  product: {
    satProductKey: string | null
    satUnitKey: string | null
    objetoImp: string
    taxRate: Prisma.Decimal
    category: { defaultSatProductKey: string | null; defaultSatUnitKey: string | null } | null
  } | null
}

export interface LoadedOrderForCfdi {
  venueType: VenueType
  tipAmount: Prisma.Decimal
  items: LoadedOrderItemForCfdi[]
}

export interface AssembleOptions {
  receptor: AvoqadoSaleInput['receptor']
  paymentMethod: PaymentMethod
  metodoPago: 'PUE' | 'PPD'
  serie?: string
  idempotencyKey: string
}

const DEFAULT_IVA = 0.16

/** PURE: loaded Prisma order → the 0c builder input. Decimal pesos → integer cents. */
export function assembleSaleInput(order: LoadedOrderForCfdi, opts: AssembleOptions): AvoqadoSaleInput {
  const items: AvoqadoSaleItemInput[] = order.items.map(it => {
    const taxRate = it.product ? Number(it.product.taxRate) : DEFAULT_IVA
    return {
      description: it.productName ?? 'Producto',
      quantity: it.quantity,
      unitPriceCents: centsOf(it.unitPrice),
      discountCents: centsOf(it.discountAmount),
      taxRate,
      taxExempt: taxRate === 0,
      satProductKey: it.product?.satProductKey ?? null,
      satUnitKey: it.product?.satUnitKey ?? null,
      categoryDefaultProductKey: it.product?.category?.defaultSatProductKey ?? null,
      categoryDefaultUnitKey: it.product?.category?.defaultSatUnitKey ?? null,
      objetoImp: it.product?.objetoImp ?? null,
    }
  })
  return {
    venueType: order.venueType,
    receptor: opts.receptor,
    paymentMethod: opts.paymentMethod,
    metodoPago: opts.metodoPago,
    tipCents: centsOf(order.tipAmount),
    serie: opts.serie,
    idempotencyKey: opts.idempotencyKey,
    items,
  }
}
```

- [ ] **Step 4: Run → PASS**

---

### Task 2: Orchestrator `cfdi.service.ts` (`issueCfdiForOrder`)

**Files:**

- Create: `src/services/fiscal/cfdi.service.ts`
- Test: `tests/unit/services/fiscal/cfdi.service.test.ts`

The orchestrator uses **dependency injection** so it's unit-testable without a DB. Real defaults are wired at the bottom.

- [ ] **Step 1: Write the failing test (deps mocked)**

```typescript
// tests/unit/services/fiscal/cfdi.service.test.ts
import { Prisma } from '@prisma/client'
import { issueCfdiForOrder, IssueCfdiDeps } from '../../../../src/services/fiscal/cfdi.service'

const D = (n: number) => new Prisma.Decimal(n)
const receptor = { rfc: 'XAXX010101000', razonSocial: 'PUBLICO EN GENERAL', regimenFiscal: '616', codigoPostal: '83240', usoCfdi: 'S01' }

function makeDeps(over: Partial<IssueCfdiDeps> = {}): IssueCfdiDeps {
  const stamped = {
    providerInvoiceId: 'fa1',
    uuid: 'UUID-1',
    serie: 'F',
    folio: '2',
    totalCents: 11600,
    stampedAt: new Date(),
    status: 'valid' as const,
  }
  return {
    findExistingCfdi: jest.fn().mockResolvedValue(null),
    loadOrderForCfdi: jest.fn().mockResolvedValue({
      venueId: 'v1',
      venueSlug: 'demo',
      venueType: 'RESTAURANT',
      emisor: { id: 'e1', provider: 'FACTURAPI', providerKeyEnc: null, csdStatus: 'ACTIVE', serie: 'F' },
      paymentMethod: 'CASH',
      metodoPago: 'PUE',
      subtotalCents: 10000,
      taxCents: 1600,
      totalCents: 11600,
      order: {
        venueType: 'RESTAURANT',
        tipAmount: D(0),
        items: [
          {
            productName: 'X',
            quantity: 1,
            unitPrice: D(100),
            discountAmount: D(0),
            product: { satProductKey: '90101500', satUnitKey: 'E48', objetoImp: '02', taxRate: D(0.16), category: null },
          },
        ],
      },
    }),
    resolveProvider: jest.fn().mockReturnValue({
      name: 'facturapi',
      createInvoice: jest.fn().mockResolvedValue(stamped),
      downloadXml: jest.fn().mockResolvedValue(Buffer.from('<xml/>')),
      downloadPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
    } as any),
    storeArtifact: jest.fn().mockImplementation(async (_b, path) => `https://cdn/${path}`),
    persistCfdi: jest.fn().mockImplementation(async data => ({ id: 'cfdi1', ...data })),
    ...over,
  }
}

describe('issueCfdiForOrder', () => {
  it('happy path: validates, stamps, stores XML/PDF, persists STAMPED', async () => {
    const deps = makeDeps()
    const res = await issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true }, deps)
    expect(res.status).toBe('STAMPED')
    expect(res.cfdi.uuid).toBe('UUID-1')
    expect(deps.storeArtifact).toHaveBeenCalledTimes(2) // xml + pdf
    const persisted = (deps.persistCfdi as jest.Mock).mock.calls[0][0]
    expect(persisted.status).toBe('STAMPED')
    expect(persisted.xmlUrl).toMatch(/\.xml$/)
  })

  it('idempotent: returns the existing STAMPED Cfdi without calling the PAC', async () => {
    const existing = { id: 'c0', status: 'STAMPED', uuid: 'OLD' }
    const deps = makeDeps({ findExistingCfdi: jest.fn().mockResolvedValue(existing) })
    const res = await issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true }, deps)
    expect(res.status).toBe('STAMPED')
    expect(res.cfdi.uuid).toBe('OLD')
    expect(deps.resolveProvider).not.toHaveBeenCalled()
  })

  it('validation failure: never calls the PAC, persists VALIDATION_FAILED with reasons', async () => {
    const deps = makeDeps()
    const res = await issueCfdiForOrder({ orderId: 'o1', receptor: { ...receptor, rfc: 'BAD' }, sandbox: true }, deps)
    expect(res.status).toBe('VALIDATION_FAILED')
    expect(res.reasons && res.reasons.length).toBeGreaterThan(0)
    expect(deps.resolveProvider).not.toHaveBeenCalled()
  })

  it('PAC error: persists STAMP_FAILED with the error', async () => {
    const deps = makeDeps({
      resolveProvider: jest
        .fn()
        .mockReturnValue({
          name: 'facturapi',
          createInvoice: jest.fn().mockRejectedValue(new Error('SAT down')),
          downloadXml: jest.fn(),
          downloadPdf: jest.fn(),
        } as any),
    })
    const res = await issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true }, deps)
    expect(res.status).toBe('STAMP_FAILED')
    const persisted = (deps.persistCfdi as jest.Mock).mock.calls.at(-1)[0]
    expect(persisted.status).toBe('STAMP_FAILED')
    expect(persisted.lastError).toMatch(/SAT down/)
  })
})
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement**

```typescript
// src/services/fiscal/cfdi.service.ts
import { CsdStatus, FiscalProviderType, PaymentMethod, VenueType } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { buildStoragePath, uploadFileToStorage } from '../storage.service'
import { resolveFiscalProvider } from './fiscalProvider.factory'
import { buildCreateInvoiceParams } from './cfdiPayloadBuilder'
import { validateBeforeStamp } from './cfdiValidation'
import { assembleSaleInput, LoadedOrderForCfdi } from './assembleSaleInput'

export interface IssueReceptor {
  rfc: string
  razonSocial: string
  regimenFiscal: string
  codigoPostal: string
  usoCfdi: string
  email?: string
}

export interface LoadedOrderBundle {
  venueId: string
  venueSlug: string
  venueType: VenueType
  emisor: { id: string; provider: FiscalProviderType; providerKeyEnc: string | null; csdStatus: CsdStatus; serie: string | null }
  paymentMethod: PaymentMethod
  metodoPago: 'PUE' | 'PPD'
  subtotalCents: number
  taxCents: number
  totalCents: number
  order: LoadedOrderForCfdi
}

export interface IssueCfdiDeps {
  findExistingCfdi: (idempotencyKey: string) => Promise<any | null>
  loadOrderForCfdi: (orderId: string) => Promise<LoadedOrderBundle | null>
  resolveProvider: typeof resolveFiscalProvider
  storeArtifact: (buffer: Buffer, path: string, contentType: string) => Promise<string>
  persistCfdi: (data: Record<string, any>) => Promise<any>
}

export interface IssueCfdiResult {
  status: 'STAMPED' | 'VALIDATION_FAILED' | 'STAMP_FAILED'
  cfdi: any
  reasons?: string[]
}

export async function issueCfdiForOrder(
  params: { orderId: string; receptor: IssueReceptor; sandbox: boolean; flow?: 'STAFF_B' | 'AUTOFACTURA_A' },
  deps: IssueCfdiDeps = defaultDeps,
): Promise<IssueCfdiResult> {
  const idempotencyKey = `cfdi-order-${params.orderId}`

  // 1. Idempotency — never double-stamp (facturapi has no idempotency; we own it)
  const existing = await deps.findExistingCfdi(idempotencyKey)
  if (existing && existing.status === 'STAMPED') return { status: 'STAMPED', cfdi: existing }

  // 2. Load
  const bundle = await deps.loadOrderForCfdi(params.orderId)
  if (!bundle) throw new Error(`Order ${params.orderId} not found or has no fiscal emisor configured`)

  // 3. Assemble + build
  const saleInput = assembleSaleInput(bundle.order, {
    receptor: params.receptor,
    paymentMethod: bundle.paymentMethod,
    metodoPago: bundle.metodoPago,
    serie: bundle.emisor.serie ?? undefined,
    idempotencyKey,
  })
  const invoiceParams = buildCreateInvoiceParams(saleInput)

  // 4. Validate (D1) — never send garbage to the PAC
  const validation = validateBeforeStamp({
    csdStatus: bundle.emisor.csdStatus,
    formaPago: invoiceParams.formaPago,
    receptor: { ...params.receptor },
    items: invoiceParams.items,
    expectedSubtotalCents: bundle.subtotalCents,
    expectedTaxCents: bundle.taxCents,
    expectedTotalCents: bundle.totalCents,
  })
  if (!validation.valid) {
    const cfdi = await deps.persistCfdi(
      baseCfdiData(params, bundle, idempotencyKey, invoiceParams, 'VALIDATION_FAILED', { lastError: validation.reasons.join(' | ') }),
    )
    return { status: 'VALIDATION_FAILED', cfdi, reasons: validation.reasons }
  }

  // 5. Stamp via the connector
  const provider = deps.resolveProvider(bundle.emisor as any, { sandbox: params.sandbox })
  let stamped
  try {
    stamped = await provider.createInvoice(invoiceParams)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`[cfdi] stamp failed for order ${params.orderId}: ${message}`)
    const cfdi = await deps.persistCfdi(baseCfdiData(params, bundle, idempotencyKey, invoiceParams, 'STAMP_FAILED', { lastError: message }))
    return { status: 'STAMP_FAILED', cfdi }
  }

  // 6. Store XML + PDF
  const [xmlBuf, pdfBuf] = await Promise.all([
    provider.downloadXml(stamped.providerInvoiceId),
    provider.downloadPdf(stamped.providerInvoiceId),
  ])
  const base = `venues/${bundle.venueSlug}/cfdi/${stamped.uuid}`
  const [xmlUrl, pdfUrl] = await Promise.all([
    deps.storeArtifact(xmlBuf, buildStoragePath(`${base}.xml`), 'application/xml'),
    deps.storeArtifact(pdfBuf, buildStoragePath(`${base}.pdf`), 'application/pdf'),
  ])

  // 7. Persist STAMPED
  const cfdi = await deps.persistCfdi(
    baseCfdiData(params, bundle, idempotencyKey, invoiceParams, 'STAMPED', {
      facturapiId: stamped.providerInvoiceId,
      uuid: stamped.uuid,
      serie: stamped.serie,
      folio: stamped.folio,
      stampedAt: stamped.stampedAt,
      xmlUrl,
      pdfUrl,
    }),
  )
  return { status: 'STAMPED', cfdi }
}

function baseCfdiData(
  params: { orderId: string; receptor: IssueReceptor; flow?: string },
  bundle: LoadedOrderBundle,
  idempotencyKey: string,
  invoiceParams: any,
  status: string,
  extra: Record<string, any>,
) {
  return {
    venueId: bundle.venueId,
    fiscalEmisorId: bundle.emisor.id,
    orderId: params.orderId,
    flow: params.flow ?? 'STAFF_B',
    status,
    idempotencyKey,
    receptorRfc: params.receptor.rfc,
    receptorNombre: params.receptor.razonSocial,
    receptorRegimen: params.receptor.regimenFiscal,
    receptorCp: params.receptor.codigoPostal,
    usoCfdi: params.receptor.usoCfdi,
    formaPago: invoiceParams.formaPago,
    metodoPago: invoiceParams.metodoPago,
    subtotalCents: bundle.subtotalCents,
    taxCents: bundle.taxCents,
    totalCents: bundle.totalCents,
    ...extra,
  }
}

// ─── real default deps (DB + storage). Tests inject their own. ───
const defaultDeps: IssueCfdiDeps = {
  findExistingCfdi: idempotencyKey => prisma.cfdi.findUnique({ where: { idempotencyKey } }),
  storeArtifact: (buffer, path, contentType) => uploadFileToStorage(buffer, path, contentType),
  resolveProvider: resolveFiscalProvider,
  persistCfdi: data =>
    prisma.cfdi.upsert({
      where: { idempotencyKey: data.idempotencyKey },
      create: data as any,
      update: { status: data.status, lastError: data.lastError ?? null, attempts: { increment: 1 }, ...stampedFields(data) },
    }),
  loadOrderForCfdi: async orderId => {
    // Tenant-safe load: order + items + product(+category) + venue + the emisor for the payment's merchant.
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        venueId: true,
        subtotal: true,
        taxAmount: true,
        total: true,
        tipAmount: true,
        venue: {
          select: {
            slug: true,
            type: true,
            fiscalEmisors: { take: 1, select: { id: true, provider: true, providerKeyEnc: true, csdStatus: true, serie: true } },
          },
        },
        payments: { take: 1, orderBy: { createdAt: 'desc' }, select: { method: true, remainingBalance: true } },
        items: {
          select: {
            productName: true,
            quantity: true,
            unitPrice: true,
            discountAmount: true,
            product: {
              select: {
                satProductKey: true,
                satUnitKey: true,
                objetoImp: true,
                taxRate: true,
                category: { select: { defaultSatProductKey: true, defaultSatUnitKey: true } },
              },
            },
          },
        },
      },
    })
    if (!order || !order.venue.fiscalEmisors[0]) return null
    const peso = (d: any) => Math.round(Number(d) * 100)
    return {
      venueId: order.venueId,
      venueSlug: order.venue.slug,
      venueType: order.venue.type,
      emisor: order.venue.fiscalEmisors[0],
      paymentMethod: order.payments[0]?.method ?? 'CASH',
      metodoPago: 'PUE', // POS = PUE (PPD/REP deferred)
      subtotalCents: peso(order.subtotal),
      taxCents: peso(order.taxAmount),
      totalCents: peso(order.total),
      order: { venueType: order.venue.type, tipAmount: order.tipAmount, items: order.items as any },
    }
  },
}

function stampedFields(data: Record<string, any>) {
  const keys = ['facturapiId', 'uuid', 'serie', 'folio', 'stampedAt', 'xmlUrl', 'pdfUrl'] as const
  const out: Record<string, any> = {}
  for (const k of keys) if (data[k] !== undefined) out[k] = data[k]
  return out
}
```

> **Note (SDK/schema accuracy):** confirm against `prisma/schema.prisma` the exact relation names used in the `select`
> (`venue.fiscalEmisors`, `order.payments`, `items.product.category`, `Payment.remainingBalance`/`method`). Adjust to the real names; keep
> the public `issueCfdiForOrder` signature + `IssueCfdiDeps` shape as specified so the tests pass.

- [ ] **Step 4: Run → PASS** · `npm test -- tests/unit/services/fiscal/cfdi.service.test.ts`

---

### Task 3: Format + regression (NO commit)

- [ ] **Step 1:** `npm run format && npm run lint:fix`
- [ ] **Step 2:** `npm run build` (exit 0) + `npm test -- tests/unit/services/fiscal` (all fiscal suites green)
- [ ] **Step 3:** DO NOT commit. Report files. When approved, stage only `src/services/fiscal/{assembleSaleInput,cfdi.service}.ts` + the 2
      new test files.

---

## Self-review

**Spec coverage:** maps real Order → CFDI payload §7.3 ✓ (T1); idempotency at OUR layer via `Cfdi.idempotencyKey` (the 0b finding) ✓ (T2);
D1 validate-before-stamp ✓; stamp via 0b connector ✓; persist `Cfdi` with status machine (VALIDATION_FAILED / STAMPED / STAMP_FAILED) §14 ✓;
store XML+PDF to blob via `buildStoragePath`+`uploadFileToStorage` §14 ✓; tenant-safe load (selects by order id, scoped through venue) ✓.
**Deferred:** acuse storage, email delivery, retry job wiring (`cfdi-stamp-retry.job.ts`), global/autofactura flows, routes,
Feature/permissions/MCP (0d).

**Placeholder scan:** none — full implementations. The DI default `loadOrderForCfdi` carries one "confirm relation names against schema"
note (legitimate — Prisma select names), not a logic placeholder.

**Type consistency:** `IssueCfdiDeps` shape is identical between the test factory and the service;
`assembleSaleInput`/`buildCreateInvoiceParams`/`validateBeforeStamp`/`resolveFiscalProvider` reused from 0c/0b, not redefined.
`LoadedOrderForCfdi` shared between T1 and T2.
