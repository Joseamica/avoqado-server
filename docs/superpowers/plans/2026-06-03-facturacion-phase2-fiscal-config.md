# Facturación CFDI — Phase 2: Fiscal config (emisor metadata + per-merchant toggles) — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Checkbox steps.
> `permissions-policy.md` + `critical-warnings.md` auto-load.

**Goal:** Backend management of the founder's **per-merchant facturación config** (which merchants invoice / autofactura / enter the
global) + the **emisor metadata** (RFC/régimen/CP/defaults). Pure DB, tenant-safe, gated by `cfdi:configure` (OWNER/ADMIN) for writes and
`cfdi:view` for reads. This is the "configure" side of the module — it makes the per-merchant gate real for the issuance/autofactura flows.

**Architecture:** `fiscalConfig.service.ts` (DI, tenant-safe — mirror `cfdi.service.ts`'s DI + `expectedVenueId` guard) → thin controllers →
routes. NO facturapi calls here (org provisioning + CSD upload are a separate founder-involved step that sets
`providerOrgId`/`providerKeyEnc`/`csdStatus`). A new emisor starts `csdStatus=NONE` and cannot issue until provisioned — that's expected.

**Tech Stack:** Express, Prisma, Zod (Spanish), Jest (DI mocks).

**Scope — IN:** `getFiscalConfig`, `upsertEmisor`, `upsertMerchantFiscalConfig` service fns (DI, tenant-safe) + tests; Zod schemas;
controllers; routes (`GET .../fiscal/config`, `POST/PUT .../fiscal/emisores[/:id]`, `PUT .../fiscal/merchant-config`). **OUT
(founder-involved / later):** facturapi org provisioning + CSD upload (needs the live account + key live/sandbox model — do WITH founder),
global job (C), MCP tools (founder owns). Design: spec §6.1–6.1c, §15.

**Reference rules:** `.claude/rules/critical-warnings.md` (authContext; **tenant isolation — every emisor/merchant op MUST be scoped to the
caller venueId**; Zod Spanish), `.claude/rules/permissions-policy.md`, `.claude/rules/testing-and-git.md` (NEVER commit; do NOT touch
`src/mcp/**`).

> **Coordination:** founder wires MCP concurrently — do NOT touch `src/mcp/**`.

---

### Task 1: `fiscalConfig.service.ts` (DI, tenant-safe)

**Files:**

- Create: `src/services/fiscal/fiscalConfig.service.ts`
- Test: `tests/unit/services/fiscal/fiscalConfig.service.test.ts`

> Read `cfdi.service.ts` (the `*Deps` + real-defaults pattern) first and mirror it. Read the `FiscalEmisor` + `MerchantFiscalConfig` models
> in `prisma/schema.prisma` for exact fields.

- [ ] **Step 1: Write the failing test** (mock the deps; assert tenant guards + the XOR + the upserts)

```typescript
// tests/unit/services/fiscal/fiscalConfig.service.test.ts
import {
  upsertEmisor,
  upsertMerchantFiscalConfig,
  getFiscalConfig,
  FiscalConfigDeps,
} from '../../../../src/services/fiscal/fiscalConfig.service'

function deps(over: Partial<FiscalConfigDeps> = {}): FiscalConfigDeps {
  return {
    upsertEmisorRow: jest.fn().mockImplementation(async d => ({ id: 'e1', ...d })),
    findEmisor: jest.fn().mockResolvedValue({ id: 'e1', venueId: 'v1' }),
    findMerchantVenue: jest.fn().mockResolvedValue('v1'), // venueId that owns the merchant
    upsertMerchantConfigRow: jest.fn().mockImplementation(async d => ({ id: 'mc1', ...d })),
    listEmisores: jest.fn().mockResolvedValue([{ id: 'e1', rfc: 'EKU9003173C9', csdStatus: 'NONE' }]),
    listMerchantConfigs: jest.fn().mockResolvedValue([{ id: 'mc1', merchantAccountId: 'ma1', facturacionEnabled: true }]),
    ...over,
  }
}

describe('upsertEmisor', () => {
  it('creates an emisor scoped to the venue (csdStatus stays NONE until provisioned)', async () => {
    const d = deps()
    const r = await upsertEmisor({ venueId: 'v1', rfc: 'EKU9003173C9', legalName: 'X', regimenFiscal: '601', lugarExpedicion: '64000' }, d)
    expect(r.id).toBe('e1')
    expect((d.upsertEmisorRow as jest.Mock).mock.calls[0][0].venueId).toBe('v1')
  })
  it('tenant guard on update: throws when the emisor belongs to another venue', async () => {
    const d = deps({ findEmisor: jest.fn().mockResolvedValue({ id: 'e1', venueId: 'OTHER' }) })
    await expect(
      upsertEmisor(
        { venueId: 'v1', emisorId: 'e1', rfc: 'EKU9003173C9', legalName: 'X', regimenFiscal: '601', lugarExpedicion: '64000' },
        d,
      ),
    ).rejects.toThrow(/not found/)
  })
})

describe('upsertMerchantFiscalConfig', () => {
  const base = { venueId: 'v1', fiscalEmisorId: 'e1', facturacionEnabled: true, autofacturaEnabled: true, includeInGlobal: true }
  it('upserts a merchant config when merchant + emisor both belong to the venue', async () => {
    const d = deps()
    const r = await upsertMerchantFiscalConfig({ ...base, merchantAccountId: 'ma1' }, d)
    expect(r.id).toBe('mc1')
  })
  it('rejects when neither or both merchant FKs are set (XOR)', async () => {
    const d = deps()
    await expect(upsertMerchantFiscalConfig({ ...base }, d)).rejects.toThrow(/merchant/i)
    await expect(upsertMerchantFiscalConfig({ ...base, merchantAccountId: 'ma1', ecommerceMerchantId: 'em1' }, d)).rejects.toThrow(
      /merchant/i,
    )
  })
  it('tenant guard: rejects a merchant that belongs to another venue', async () => {
    const d = deps({ findMerchantVenue: jest.fn().mockResolvedValue('OTHER') })
    await expect(upsertMerchantFiscalConfig({ ...base, merchantAccountId: 'ma1' }, d)).rejects.toThrow(/not found/)
  })
  it('tenant guard: rejects when the fiscalEmisor belongs to another venue', async () => {
    const d = deps({ findEmisor: jest.fn().mockResolvedValue({ id: 'e1', venueId: 'OTHER' }) })
    await expect(upsertMerchantFiscalConfig({ ...base, merchantAccountId: 'ma1' }, d)).rejects.toThrow(/not found/)
  })
})

describe('getFiscalConfig', () => {
  it('returns emisores + merchant configs for the venue', async () => {
    const r = await getFiscalConfig({ venueId: 'v1' }, deps())
    expect(r.emisores).toHaveLength(1)
    expect(r.merchantConfigs).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement** (mirror cfdi.service DI; real defaults use prisma with venueId filters)

```typescript
// src/services/fiscal/fiscalConfig.service.ts
import prisma from '../../utils/prismaClient'
import { GlobalPeriodicity } from '@prisma/client'

export interface EmisorInput {
  venueId: string
  emisorId?: string // present → update
  rfc: string
  legalName: string
  regimenFiscal: string
  lugarExpedicion: string
  serie?: string
  defaultUsoCfdi?: string
  globalPeriodicity?: GlobalPeriodicity
}

export interface MerchantFiscalConfigInput {
  venueId: string
  merchantAccountId?: string
  ecommerceMerchantId?: string
  fiscalEmisorId: string
  facturacionEnabled: boolean
  autofacturaEnabled: boolean
  includeInGlobal: boolean
}

export interface FiscalConfigDeps {
  upsertEmisorRow: (data: Record<string, any>, emisorId?: string) => Promise<any>
  findEmisor: (emisorId: string) => Promise<{ id: string; venueId: string } | null>
  findMerchantVenue: (merchantAccountId?: string, ecommerceMerchantId?: string) => Promise<string | null>
  upsertMerchantConfigRow: (data: Record<string, any>) => Promise<any>
  listEmisores: (venueId: string) => Promise<any[]>
  listMerchantConfigs: (venueId: string) => Promise<any[]>
}

export async function upsertEmisor(input: EmisorInput, deps: FiscalConfigDeps = defaultDeps): Promise<any> {
  if (input.emisorId) {
    const existing = await deps.findEmisor(input.emisorId)
    if (!existing || existing.venueId !== input.venueId) throw new Error(`Emisor ${input.emisorId} not found`) // tenant → 404
  }
  return deps.upsertEmisorRow(
    {
      venueId: input.venueId,
      rfc: input.rfc,
      legalName: input.legalName,
      regimenFiscal: input.regimenFiscal,
      lugarExpedicion: input.lugarExpedicion,
      serie: input.serie ?? null,
      defaultUsoCfdi: input.defaultUsoCfdi ?? 'G03',
      globalPeriodicity: input.globalPeriodicity ?? 'MENSUAL',
    },
    input.emisorId,
  )
}

export async function upsertMerchantFiscalConfig(input: MerchantFiscalConfigInput, deps: FiscalConfigDeps = defaultDeps): Promise<any> {
  const hasAcct = !!input.merchantAccountId
  const hasEcom = !!input.ecommerceMerchantId
  if (hasAcct === hasEcom) throw new Error('Debe especificar exactamente un merchant (merchantAccountId o ecommerceMerchantId)')

  const merchantVenue = await deps.findMerchantVenue(input.merchantAccountId, input.ecommerceMerchantId)
  if (merchantVenue !== input.venueId) throw new Error('Merchant not found') // tenant → 404

  const emisor = await deps.findEmisor(input.fiscalEmisorId)
  if (!emisor || emisor.venueId !== input.venueId) throw new Error(`Emisor ${input.fiscalEmisorId} not found`) // tenant → 404

  return deps.upsertMerchantConfigRow({
    merchantAccountId: input.merchantAccountId ?? null,
    ecommerceMerchantId: input.ecommerceMerchantId ?? null,
    fiscalEmisorId: input.fiscalEmisorId,
    facturacionEnabled: input.facturacionEnabled,
    autofacturaEnabled: input.autofacturaEnabled,
    includeInGlobal: input.includeInGlobal,
  })
}

export async function getFiscalConfig(
  input: { venueId: string },
  deps: FiscalConfigDeps = defaultDeps,
): Promise<{ emisores: any[]; merchantConfigs: any[] }> {
  const [emisores, merchantConfigs] = await Promise.all([deps.listEmisores(input.venueId), deps.listMerchantConfigs(input.venueId)])
  return { emisores, merchantConfigs }
}

// ─── real defaults (tenant-filtered prisma) ───
const defaultDeps: FiscalConfigDeps = {
  upsertEmisorRow: (data, emisorId) =>
    emisorId ? prisma.fiscalEmisor.update({ where: { id: emisorId }, data }) : prisma.fiscalEmisor.create({ data: data as any }),
  findEmisor: id => prisma.fiscalEmisor.findUnique({ where: { id }, select: { id: true, venueId: true } }),
  findMerchantVenue: async (ma, em) => {
    if (ma)
      return (
        (
          await prisma.merchantAccount.findUnique({
            where: { id: ma },
            select: {
              /* venueId path */
            } as any,
          })
        )?.venueConfigsPrimary?.[0]?.venueId ?? null
      )
    if (em) return (await prisma.ecommerceMerchant.findUnique({ where: { id: em }, select: { venueId: true } }))?.venueId ?? null
    return null
  },
  upsertMerchantConfigRow: data => {
    const where = data.merchantAccountId ? { merchantAccountId: data.merchantAccountId } : { ecommerceMerchantId: data.ecommerceMerchantId }
    return prisma.merchantFiscalConfig.upsert({ where: where as any, create: data as any, update: data })
  },
  listEmisores: venueId => prisma.fiscalEmisor.findMany({ where: { venueId } }),
  listMerchantConfigs: venueId => prisma.merchantFiscalConfig.findMany({ where: { fiscalEmisor: { venueId } } }),
}
```

> **CRITICAL — resolve `MerchantAccount → venueId`:** `MerchantAccount` is linked to a venue via `VenuePaymentConfig`
> (primary/secondary/tertiary), NOT a direct `venueId`. **Read the schema** and implement `findMerchantVenue` correctly (a `MerchantAccount`
> may serve a venue through any of the 3 slots — match against `VenuePaymentConfig.venueId`). `EcommerceMerchant` HAS a direct `venueId`. If
> the relationship is ambiguous, the tenant check must still guarantee the merchant belongs to the caller's venue — when unsure, query
> `VenuePaymentConfig` for `{ venueId, OR: [primaryAccountId, secondaryAccountId, tertiaryAccountId] = merchantAccountId }`.

- [ ] **Step 4: Run → PASS**

---

### Task 2: Zod schemas (Spanish, `{ body }` envelope)

**Files:** Modify `src/schemas/dashboard/cfdi.schema.ts`

- [ ] Add `upsertEmisorSchema` (rfc regex, regimenFiscal `^\d{3}$`, codigoPostal/lugarExpedicion `^\d{5}$`, legalName min 1,
      serie/defaultUsoCfdi/globalPeriodicity optional) and `upsertMerchantConfigSchema` (merchantAccountId?/ecommerceMerchantId? both
      optional strings, fiscalEmisorId required, three booleans). Cross-field XOR stays in the SERVICE. Spanish messages.

---

### Task 3: Controllers + Task 4: Routes

**Files:** Modify `src/controllers/dashboard/cfdi.dashboard.controller.ts` + `src/routes/dashboard.routes.ts`

- [ ] Controllers: `getFiscalConfigController` (→ service `getFiscalConfig`), `upsertEmisorController`,
      `upsertMerchantFiscalConfigController`. All read `authContext.venueId` and pass it (never trust the path `:venueId` for the tenant
      decision — use authContext). Map service `Error /not found/` → 404, XOR/validation errors → 409, else 500. Mirror existing
      controllers.
- [ ] Routes (match existing import names):

```typescript
router.get(
  '/venues/:venueId/fiscal/config',
  authenticateTokenMiddleware,
  checkFeatureAccess('CFDI'),
  checkPermission('cfdi:view'),
  getFiscalConfigController,
)
router.post(
  '/venues/:venueId/fiscal/emisores',
  authenticateTokenMiddleware,
  validateRequest(upsertEmisorSchema),
  checkFeatureAccess('CFDI'),
  checkPermission('cfdi:configure'),
  upsertEmisorController,
)
router.put(
  '/venues/:venueId/fiscal/emisores/:emisorId',
  authenticateTokenMiddleware,
  validateRequest(upsertEmisorSchema),
  checkFeatureAccess('CFDI'),
  checkPermission('cfdi:configure'),
  upsertEmisorController,
)
router.put(
  '/venues/:venueId/fiscal/merchant-config',
  authenticateTokenMiddleware,
  validateRequest(upsertMerchantConfigSchema),
  checkFeatureAccess('CFDI'),
  checkPermission('cfdi:configure'),
  upsertMerchantFiscalConfigController,
)
```

---

### Task 5: Controller tests + audit + regression (NO commit)

- [ ] Extend `tests/unit/controllers/dashboard/cfdi.dashboard.controller.test.ts` (mock the service fns): config→200, emisor upsert→200/404,
      merchant-config→200/409(XOR)/404.
- [ ] `npm run audit:permissions` → exit 0 (cfdi:configure/view already in defaults).
- [ ] `npm run format && npm run lint:fix`, `npm run build` (exit 0),
      `npm test -- tests/unit/services/fiscal tests/unit/controllers/dashboard/cfdi.dashboard.controller.test.ts` (all green).
- [ ] DO NOT commit. Report files + audit.

---

## Self-review

**Spec coverage (§6.1c, §15):** per-merchant config (facturacion/autofactura/includeInGlobal + which emisor) ✓ — the founder's "venue
chooses which merchants invoice" requirement; emisor metadata CRUD ✓; gated `cfdi:configure` (OWNER/ADMIN) writes / `cfdi:view` read ✓;
**tenant-safe — emisor AND merchant both verified to belong to the caller venueId** (the resolution logic in §6.1c depends on this) ✓.
**Deferred:** facturapi org provisioning + CSD upload (founder + live account), global job, MCP.

**Placeholder scan:** the `findMerchantVenue` real-default has a "resolve via VenuePaymentConfig" note — that's a REAL implementation
requirement the subagent must get right against the schema (MerchantAccount has no direct venueId), not a logic gap. Everything else is
complete.

**Type consistency:** `GlobalPeriodicity` enum from Prisma; `cfdi:configure`/`cfdi:view` match 0d; DI shapes identical between service +
tests; tenant-guard-as-404 mirrors `issueCfdiForOrder`/`cancelCfdi`.

**Tenant safety is the #1 risk here** (config writes that cross venues = a venue could point another venue's merchant at its emisor). The
service verifies BOTH the merchant's venue and the emisor's venue against the caller's `authContext.venueId` before any write.
