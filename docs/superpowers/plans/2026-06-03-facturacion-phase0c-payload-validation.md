# Facturación CFDI — Phase 0c: SAT Mapping + Payload Builder + Pre-timbrado Validation — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Checkbox (`- [ ]`) steps.

**Goal:** The pure functional core that turns an Avoqado sale into a valid CFDI payload and guarantees "cero rechazos" BEFORE we call the
PAC: (1) SAT catalog mappings, (2) a payload builder that produces the connector's `CreateInvoiceParams`, (3) a pre-timbrado validation
engine (D1). All pure functions — no DB, no facturapi — so they're fast and exhaustively unit-testable.

**Architecture:** New files under `src/services/fiscal/`. The builder output plugs directly into the Phase 0b `FiscalProvider.createInvoice`
(`CreateInvoiceParams` from `fiscal-provider.interface.ts`). Money is integer cents; **POS prices are NET** (verified: `TerminalOrderItem`
comment + Order `subtotal × taxRate`), so `unitPriceCents` maps straight to `ValorUnitario`. The **tip is excluded** from the CFDI base
(D2). SAT keys resolve **product override ?? category default ?? sector default**.

**Tech Stack:** TypeScript, Jest. Pure functions only.

**Scope — IN:** `satCatalog.ts` (FormaPago map, sector SAT-key defaults, helpers), `cfdiPayloadBuilder.ts`, `cfdiValidation.ts`, unit tests.
**OUT (next plans — 0c-2 / 0d / phases 1-3):** DB orchestration (read Order/Payment, idempotency pre-check via `Cfdi.idempotencyKey`,
persist Cfdi, store XML/PDF to blob), the `CFDI` Feature + permissions + MCP, routes/UI, the issuance flows. Design:
`docs/superpowers/specs/2026-06-03-facturacion-cfdi-module-design.md` §8–§10.

**Reference rules:** `.claude/rules/testing-and-git.md` (NEVER commit without asking; tests in `tests/unit/**`). Zod not used here (pure
functions, not request schemas).

**Carries the 0b finding:** idempotency is enforced at our service layer (not the PAC) — that lives in 0c-2's orchestration, NOT this
pure-core plan. Note it where the orchestration boundary is referenced.

---

### Task 1: SAT catalog mappings (`satCatalog.ts`)

**Files:**

- Create: `src/services/fiscal/satCatalog.ts`
- Test: `tests/unit/services/fiscal/satCatalog.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/services/fiscal/satCatalog.test.ts
import { mapFormaPago, sectorSatDefaults, isValidRegimen } from '../../../../src/services/fiscal/satCatalog'

describe('satCatalog', () => {
  it('maps Avoqado PaymentMethod → SAT c_FormaPago', () => {
    expect(mapFormaPago('CASH')).toBe('01')
    expect(mapFormaPago('CREDIT_CARD')).toBe('04')
    expect(mapFormaPago('DEBIT_CARD')).toBe('28')
    expect(mapFormaPago('BANK_TRANSFER')).toBe('03')
  })

  it('returns 99 (por definir) for ambiguous methods and flags them', () => {
    expect(mapFormaPago('OTHER')).toBe('99')
    expect(mapFormaPago('CRYPTOCURRENCY')).toBe('99')
    expect(mapFormaPago('DIGITAL_WALLET')).toBe('99') // disambiguation deferred (spec §10)
  })

  it('gives a per-sector SAT key default', () => {
    expect(sectorSatDefaults('RESTAURANT').productKey).toBe('90101500')
    expect(sectorSatDefaults('RESTAURANT').unitKey).toBe('E48')
    expect(sectorSatDefaults('RETAIL').unitKey).toBe('H87') // pieza
  })

  it('validates régimen codes (numeric, 3 digits)', () => {
    expect(isValidRegimen('601')).toBe(true)
    expect(isValidRegimen('616')).toBe(true)
    expect(isValidRegimen('99')).toBe(false)
    expect(isValidRegimen('abc')).toBe(false)
  })
})
```

- [ ] **Step 2: Run → FAIL** · `npm test -- tests/unit/services/fiscal/satCatalog.test.ts` (module not found)

- [ ] **Step 3: Implement**

```typescript
// src/services/fiscal/satCatalog.ts
import { PaymentMethod, VenueType } from '@prisma/client'

/** Avoqado PaymentMethod → SAT c_FormaPago. 99 = "Por definir" (caller flags for review). */
const FORMA_PAGO: Record<PaymentMethod, string> = {
  CASH: '01',
  CREDIT_CARD: '04',
  DEBIT_CARD: '28',
  BANK_TRANSFER: '03',
  DIGITAL_WALLET: '99', // monedero(05) vs wallet(04/06) — disambiguation deferred (spec §10)
  CRYPTOCURRENCY: '99',
  OTHER: '99',
}
export function mapFormaPago(method: PaymentMethod): string {
  return FORMA_PAGO[method] ?? '99'
}
export function isFormaPagoAmbiguous(method: PaymentMethod): boolean {
  return mapFormaPago(method) === '99'
}

/** Per-sector fallback SAT keys (last resort when product + category have none). */
const SECTOR_DEFAULTS: Partial<Record<VenueType, { productKey: string; unitKey: string }>> = {
  RESTAURANT: { productKey: '90101500', unitKey: 'E48' }, // Servicio de restaurante / unidad de servicio
  RETAIL: { productKey: '01010101', unitKey: 'H87' }, // genérico / pieza
}
const GENERIC_DEFAULT = { productKey: '01010101', unitKey: 'H87' }
export function sectorSatDefaults(venueType: VenueType): { productKey: string; unitKey: string } {
  return SECTOR_DEFAULTS[venueType] ?? GENERIC_DEFAULT
}

/** Shape check only (numeric, 3 digits). Full c_RegimenFiscal validity is the PAC's job at stamp time. */
export function isValidRegimen(code: string): boolean {
  return /^\d{3}$/.test(code)
}
```

- [ ] **Step 4: Run → PASS**

---

### Task 2: CFDI payload builder (`cfdiPayloadBuilder.ts`)

**Files:**

- Create: `src/services/fiscal/cfdiPayloadBuilder.ts`
- Test: `tests/unit/services/fiscal/cfdiPayloadBuilder.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/services/fiscal/cfdiPayloadBuilder.test.ts
import { buildCreateInvoiceParams, AvoqadoSaleInput } from '../../../../src/services/fiscal/cfdiPayloadBuilder'

const baseInput: AvoqadoSaleInput = {
  venueType: 'RESTAURANT',
  receptor: { rfc: 'EKU9003173C9', razonSocial: 'X', regimenFiscal: '601', codigoPostal: '64000', usoCfdi: 'G03' },
  paymentMethod: 'CASH',
  metodoPago: 'PUE',
  tipCents: 1500, // excluded from CFDI
  idempotencyKey: 'k1',
  items: [
    {
      description: 'Tacos',
      quantity: 2,
      unitPriceCents: 5000,
      discountCents: 0,
      taxRate: 0.16,
      satProductKey: null,
      satUnitKey: null,
      categoryDefaultProductKey: null,
      categoryDefaultUnitKey: null,
      objetoImp: null,
      taxExempt: false,
    },
  ],
}

describe('buildCreateInvoiceParams', () => {
  it('maps NET cents straight to ValorUnitario and adds IVA traslado', () => {
    const p = buildCreateInvoiceParams(baseInput)
    expect(p.formaPago).toBe('01')
    expect(p.metodoPago).toBe('PUE')
    expect(p.items).toHaveLength(1)
    const it = p.items[0]
    expect(it.unitPriceCents).toBe(5000) // NET, unchanged
    expect(it.taxes).toEqual([{ type: 'IVA', factor: 'Tasa', rate: 0.16, withholding: false }])
    expect(it.objetoImp).toBe('02')
  })

  it('resolves SAT keys: product override ?? category default ?? sector default', () => {
    const override = buildCreateInvoiceParams({
      ...baseInput,
      items: [{ ...baseInput.items[0], satProductKey: '12345678', satUnitKey: 'KGM' }],
    })
    expect(override.items[0].satProductKey).toBe('12345678')
    expect(override.items[0].satUnitKey).toBe('KGM')

    const cat = buildCreateInvoiceParams({
      ...baseInput,
      items: [{ ...baseInput.items[0], categoryDefaultProductKey: '99999999', categoryDefaultUnitKey: 'E48' }],
    })
    expect(cat.items[0].satProductKey).toBe('99999999')

    const sector = buildCreateInvoiceParams(baseInput) // nothing set → RESTAURANT sector default
    expect(sector.items[0].satProductKey).toBe('90101500')
    expect(sector.items[0].satUnitKey).toBe('E48')
  })

  it('NEVER includes the tip in the items (D2 — propina excluida)', () => {
    const p = buildCreateInvoiceParams(baseInput)
    const total = p.items.reduce((s, it) => s + it.unitPriceCents * it.quantity - it.discountCents, 0)
    expect(total).toBe(10000) // 2 × 5000, tip 1500 NOT included
  })

  it('exento item → objetoImp 01 and no traslado', () => {
    const p = buildCreateInvoiceParams({ ...baseInput, items: [{ ...baseInput.items[0], taxRate: 0, taxExempt: true }] })
    expect(p.items[0].objetoImp).toBe('01')
    expect(p.items[0].taxes).toEqual([])
  })
})
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement**

```typescript
// src/services/fiscal/cfdiPayloadBuilder.ts
import { PaymentMethod, VenueType } from '@prisma/client'
import { CreateInvoiceParams, CfdiItemInput, CfdiItemTax } from './providers/fiscal-provider.interface'
import { mapFormaPago, sectorSatDefaults } from './satCatalog'

export interface AvoqadoSaleItemInput {
  description: string
  quantity: number
  unitPriceCents: number // NET (sin IVA) — POS convention
  discountCents: number
  taxRate: number // 0.16 / 0.08 / 0
  taxExempt: boolean
  satProductKey: string | null // product override
  satUnitKey: string | null
  categoryDefaultProductKey: string | null
  categoryDefaultUnitKey: string | null
  objetoImp: string | null
}

export interface AvoqadoSaleInput {
  venueType: VenueType
  receptor: CreateInvoiceParams['receptor']
  paymentMethod: PaymentMethod
  metodoPago: 'PUE' | 'PPD'
  tipCents?: number // EXCLUDED from the CFDI (D2) — present only so callers can pass the full sale
  serie?: string
  idempotencyKey: string
  items: AvoqadoSaleItemInput[]
}

function resolveItem(it: AvoqadoSaleItemInput, venueType: VenueType): CfdiItemInput {
  const sector = sectorSatDefaults(venueType)
  const satProductKey = it.satProductKey ?? it.categoryDefaultProductKey ?? sector.productKey
  const satUnitKey = it.satUnitKey ?? it.categoryDefaultUnitKey ?? sector.unitKey
  const objetoImp = it.objetoImp ?? (it.taxExempt ? '01' : '02')
  const taxes: CfdiItemTax[] = it.taxExempt ? [] : [{ type: 'IVA', factor: 'Tasa', rate: it.taxRate, withholding: false }]
  return {
    satProductKey,
    satUnitKey,
    description: it.description,
    quantity: it.quantity,
    unitPriceCents: it.unitPriceCents, // NET — straight through
    discountCents: it.discountCents,
    objetoImp,
    taxes,
  }
}

/** Pure: Avoqado sale → connector CreateInvoiceParams. Tip is intentionally dropped (D2). */
export function buildCreateInvoiceParams(input: AvoqadoSaleInput): CreateInvoiceParams {
  return {
    receptor: input.receptor,
    items: input.items.map(it => resolveItem(it, input.venueType)),
    formaPago: mapFormaPago(input.paymentMethod),
    metodoPago: input.metodoPago,
    serie: input.serie,
    idempotencyKey: input.idempotencyKey,
  }
}
```

- [ ] **Step 4: Run → PASS**

---

### Task 3: Pre-timbrado validation engine (`cfdiValidation.ts`) — D1 "cero rechazos"

**Files:**

- Create: `src/services/fiscal/cfdiValidation.ts`
- Test: `tests/unit/services/fiscal/cfdiValidation.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/services/fiscal/cfdiValidation.test.ts
import { validateBeforeStamp, PreStampInput } from '../../../../src/services/fiscal/cfdiValidation'

const ok: PreStampInput = {
  csdStatus: 'ACTIVE',
  formaPago: '01',
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
  expectedSubtotalCents: 10000,
  expectedTaxCents: 1600,
  expectedTotalCents: 11600,
}

describe('validateBeforeStamp (D1)', () => {
  it('passes a clean payload', () => {
    expect(validateBeforeStamp(ok)).toEqual({ valid: true, reasons: [] })
  })

  it('rejects a missing SAT product key (the #1 blocker)', () => {
    const r = validateBeforeStamp({ ...ok, items: [{ ...ok.items[0], satProductKey: '' }] })
    expect(r.valid).toBe(false)
    expect(r.reasons.join(' ')).toMatch(/clave SAT|ClaveProdServ/i)
  })

  it('rejects a bad RFC and a non-5-digit CP', () => {
    expect(validateBeforeStamp({ ...ok, receptor: { ...ok.receptor, rfc: 'BAD' } }).valid).toBe(false)
    expect(validateBeforeStamp({ ...ok, receptor: { ...ok.receptor, codigoPostal: '123' } }).valid).toBe(false)
  })

  it('rejects when money does not cuadrar al centavo', () => {
    const r = validateBeforeStamp({ ...ok, expectedTotalCents: 11601 })
    expect(r.valid).toBe(false)
    expect(r.reasons.join(' ')).toMatch(/centavo|no cuadra/i)
  })

  it('rejects when the emisor CSD is not ACTIVE', () => {
    expect(validateBeforeStamp({ ...ok, csdStatus: 'EXPIRED' }).valid).toBe(false)
    expect(validateBeforeStamp({ ...ok, csdStatus: 'RESTRICTED' }).valid).toBe(false)
  })

  it('rejects objetoImp 02 with no traslado, and 01 with a traslado', () => {
    expect(validateBeforeStamp({ ...ok, items: [{ ...ok.items[0], objetoImp: '02', taxes: [] }] }).valid).toBe(false)
    expect(
      validateBeforeStamp({
        ...ok,
        items: [{ ...ok.items[0], objetoImp: '01', taxes: [{ type: 'IVA', factor: 'Tasa', rate: 0.16, withholding: false }] }],
      }).valid,
    ).toBe(false)
  })
})
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement**

```typescript
// src/services/fiscal/cfdiValidation.ts
import { CsdStatus } from '@prisma/client'
import { CfdiItemInput, ReceptorValidationResult } from './providers/fiscal-provider.interface'

export interface PreStampInput {
  csdStatus: CsdStatus
  formaPago: string
  receptor: { rfc: string; razonSocial: string; regimenFiscal: string; codigoPostal: string; usoCfdi: string }
  items: CfdiItemInput[]
  expectedSubtotalCents: number
  expectedTaxCents: number
  expectedTotalCents: number
}

const RFC_RE = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/i

/** Pure, deterministic pre-timbrado validation. Returns Spanish reasons (shown to staff/customer). */
export function validateBeforeStamp(input: PreStampInput): ReceptorValidationResult {
  const reasons: string[] = []

  // Emisor CSD must be live
  if (input.csdStatus !== 'ACTIVE') reasons.push('El sello digital (CSD) del emisor no está activo. No se puede facturar.')

  // Receptor
  if (!RFC_RE.test(input.receptor.rfc)) reasons.push('El RFC del receptor no tiene un formato válido.')
  if (!/^\d{5}$/.test(input.receptor.codigoPostal)) reasons.push('El código postal del receptor debe tener 5 dígitos.')
  if (!input.receptor.razonSocial?.trim()) reasons.push('La razón social del receptor es obligatoria.')
  if (!/^\d{3}$/.test(input.receptor.regimenFiscal)) reasons.push('El régimen fiscal del receptor no es válido.')
  if (!input.receptor.usoCfdi?.trim()) reasons.push('Falta el Uso del CFDI.')

  // FormaPago resolved
  if (!input.formaPago || input.formaPago === '99') reasons.push('La forma de pago no está definida para este CFDI.')

  // Conceptos
  if (input.items.length === 0) reasons.push('El CFDI no tiene conceptos.')
  input.items.forEach((it, i) => {
    const n = i + 1
    if (!it.satProductKey?.trim()) reasons.push(`Concepto ${n} ("${it.description}") sin clave de producto SAT (ClaveProdServ).`)
    if (!it.satUnitKey?.trim()) reasons.push(`Concepto ${n} ("${it.description}") sin clave de unidad SAT (ClaveUnidad).`)
    const hasTraslado = it.taxes.some(t => !t.withholding)
    if (it.objetoImp === '02' && !hasTraslado)
      reasons.push(`Concepto ${n}: ObjetoImp 02 (sí objeto de impuesto) pero sin impuesto trasladado.`)
    if (it.objetoImp === '01' && it.taxes.length > 0)
      reasons.push(`Concepto ${n}: ObjetoImp 01 (no objeto de impuesto) no debe llevar impuestos.`)
  })

  // Money cuadra al centavo (integer cents): subtotal + tax = total
  if (input.expectedSubtotalCents + input.expectedTaxCents !== input.expectedTotalCents) {
    reasons.push('Los importes no cuadran al centavo (subtotal + impuestos ≠ total).')
  }

  return { valid: reasons.length === 0, reasons }
}
```

- [ ] **Step 4: Run → PASS**

---

### Task 4: Format + regression check (NO commit)

- [ ] **Step 1:** `npm run format && npm run lint:fix`
- [ ] **Step 2:** `npm run build` (exit 0) and `npm test -- tests/unit/services/fiscal` (all fiscal suites green)
- [ ] **Step 3:** DO NOT commit (human asked for none). Report the file list. When approved, a 0c commit stages only
      `src/services/fiscal/{satCatalog,cfdiPayloadBuilder,cfdiValidation}.ts` + the 3 new test files.

---

## Self-review

**Spec coverage (§8–§10):** SAT FormaPago mapping §10 ✓ (T1); SAT-key resolution product→category→sector §6.3 ✓ (T2); tip excluded D2 ✓
(T2); NET ValorUnitario ✓ (T2); pre-timbrado validation D1 incl. SAT keys, RFC/CP/régimen, cent-exact, ObjetoImp coherence, CSD-active §8 ✓
(T3). **Deferred (0c-2):** reading real Order/Payment to populate `AvoqadoSaleInput`, idempotency pre-check via `Cfdi.idempotencyKey` (0b
finding), calling the connector, persisting `Cfdi`, storing XML/PDF to blob. IEPS/retenciones beyond IVA: the builder/validation already
accept the `CfdiItemTax` shape (type IEPS/ISR, withholding) — wiring real IEPS rates is a later enhancement, not blocked.

**Placeholder scan:** none — every function is fully implemented with complete code.

**Type consistency:** builder output is `CreateInvoiceParams` and items are `CfdiItemInput` (same types as the 0b connector consumes — they
plug together with no adapter). `CfdiItemTax`/`ReceptorValidationResult`/`CsdStatus` reused, not redefined.
`mapFormaPago`/`sectorSatDefaults` names match between T1 and T2.
