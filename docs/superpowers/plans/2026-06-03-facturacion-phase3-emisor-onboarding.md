# Facturación CFDI — Phase 3: Emisor onboarding (provision + CSD) — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Checkbox steps.
> `permissions-policy.md` + `critical-warnings.md` auto-load.

**Goal:** Make a `FiscalEmisor` actually able to stamp: **provision** its facturapi organization (createOrganization → set legal info →
store org id + encrypted live key) and **upload its CSD** (.cer/.key/password → facturapi → `csdStatus=ACTIVE`). After this, a configured
emisor's `issueCfdiForOrder` stops 404-ing. Built + unit-tested with the facturapi SDK MOCKED (no account needed); the live org-provisioning
is exercised in prod with the account User Key.

**Architecture:** Extend the 0b connector with `updateOrgLegal` (the org needs its legal data set before it can issue). New
`fiscalOnboarding.service.ts` (DI, tenant-safe — mirror `fiscalConfig.service.ts`): `provisionEmisor` (uses an **account-level** provider
built from `FACTURAPI_USER_KEY`) + `uploadEmisorCsd`. Thin controllers + routes gated `cfdi:configure`. ActivityLog on both mutations (per
the repo rule). The CSD is sent straight to facturapi and **never persisted by us** (we keep only `providerOrgId` + the org key encrypted).

**Tech Stack:** Express, Prisma, Zod (Spanish), Jest (mocked SDK), `createTokenCipher` (already wired via `fiscalKey.service`).

**Scope — IN:** connector `updateOrgLegal` + adapter test; `provisionEmisor` + `uploadEmisorCsd` services (DI, tenant-safe) + tests;
CSD-upload Zod (base64 cer/key + password — NO multipart); controllers + routes; ActivityLog. **OUT:** the dashboard UI (other repo), the
LIVE org-provisioning run (needs founder `sk_user_` + a real CSD — Claude runs a sandbox issue e2e separately), multipart file upload
(base64 JSON is enough), MCP tools (founder owns `src/mcp/`). Design: spec §7.2, §15.

**Reference rules:** `.claude/rules/critical-warnings.md` (authContext; tenant isolation; **ActivityLog on mutations**; never log the CSD
password/key), `.claude/rules/permissions-policy.md`, `.claude/rules/testing-and-git.md` (NEVER commit; do NOT touch `src/mcp/**`).

> **Coordination:** founder co-develops fiscal + MCP in parallel — do NOT touch `src/mcp/**`. First grep
> `provisionEmisor`/`uploadEmisorCsd`/`updateOrgLegal` to confirm they don't already exist (if they do, STOP and report — the founder beat
> us to it).

---

### Task 1: Extend the connector — `updateOrgLegal`

**Files:**

- Modify: `src/services/fiscal/providers/fiscal-provider.interface.ts` (add method + params type)
- Modify: `src/services/fiscal/providers/facturapi.provider.ts` (implement)
- Test: extend `tests/unit/services/fiscal/facturapi.provider.test.ts`

> Read the installed SDK types `node_modules/facturapi/dist/...` to confirm the org legal-update method (likely
> `organizations.updateLegal(id, { legal_name, tax_system, address: { zip } })`). Adjust to the real signature.

- [ ] **Step 1: Interface** — add to `FiscalProvider`:

```typescript
export interface UpdateOrgLegalParams {
  providerOrgId: string
  legalName: string
  taxSystem: string // c_RegimenFiscal
  zip: string // lugar de expedición
}
// in interface FiscalProvider:
updateOrgLegal(params: UpdateOrgLegalParams): Promise<void>
```

- [ ] **Step 2: Adapter** — implement (confirm method name vs installed types):

```typescript
async updateOrgLegal(params: UpdateOrgLegalParams): Promise<void> {
  await this.client.organizations.updateLegal(params.providerOrgId, {
    legal_name: params.legalName,
    tax_system: params.taxSystem,
    address: { zip: params.zip },
  })
}
```

- [ ] **Step 3: Test** — mock `organizations.updateLegal`, assert it's called with the mapped body. Build → exit 0.

---

### Task 2: `fiscalOnboarding.service.ts` (DI, tenant-safe)

**Files:**

- Create: `src/services/fiscal/fiscalOnboarding.service.ts`
- Test: `tests/unit/services/fiscal/fiscalOnboarding.service.test.ts`

> Mirror `fiscalConfig.service.ts` DI + tenant-guard. Reuse `encryptProviderKey` from `fiscalKey.service`.

- [ ] **Step 1: Write the failing test** (mock all deps)

```typescript
// tests/unit/services/fiscal/fiscalOnboarding.service.test.ts
import { provisionEmisor, uploadEmisorCsd, EmisorOnboardingDeps } from '../../../../src/services/fiscal/fiscalOnboarding.service'

const emisor = {
  id: 'e1',
  venueId: 'v1',
  legalName: 'X SA',
  regimenFiscal: '601',
  lugarExpedicion: '64000',
  providerOrgId: null,
  csdStatus: 'NONE',
}
function deps(over: Partial<EmisorOnboardingDeps> = {}): EmisorOnboardingDeps {
  return {
    findEmisor: jest.fn().mockResolvedValue(emisor),
    accountProvider: {
      createOrganization: jest.fn().mockResolvedValue({ providerOrgId: 'org1', liveKey: 'sk_live_x', testKey: 'sk_test_x' }),
      updateOrgLegal: jest.fn().mockResolvedValue(undefined),
      uploadCsd: jest.fn().mockResolvedValue({ csdExpiresAt: new Date('2030-01-01') }),
    } as any,
    updateEmisor: jest.fn().mockImplementation(async (_id, data) => ({ ...emisor, ...data })),
    encryptKey: jest.fn().mockReturnValue('ENC'),
    ...over,
  }
}

describe('provisionEmisor', () => {
  it('creates the org, sets legal info, stores providerOrgId + encrypted key', async () => {
    const d = deps()
    const r = await provisionEmisor({ emisorId: 'e1', expectedVenueId: 'v1' }, d)
    expect(d.accountProvider.createOrganization).toHaveBeenCalled()
    expect(d.accountProvider.updateOrgLegal).toHaveBeenCalledWith(
      expect.objectContaining({ providerOrgId: 'org1', taxSystem: '601', zip: '64000' }),
    )
    const upd = (d.updateEmisor as jest.Mock).mock.calls[0][1]
    expect(upd.providerOrgId).toBe('org1')
    expect(upd.providerKeyEnc).toBe('ENC') // live key encrypted, never plaintext
    expect(r.providerOrgId).toBe('org1')
  })
  it('tenant guard: throws when emisor belongs to another venue', async () => {
    const d = deps({ findEmisor: jest.fn().mockResolvedValue({ ...emisor, venueId: 'OTHER' }) })
    await expect(provisionEmisor({ emisorId: 'e1', expectedVenueId: 'v1' }, d)).rejects.toThrow(/not found/)
    expect(d.accountProvider.createOrganization).not.toHaveBeenCalled()
  })
})

describe('uploadEmisorCsd', () => {
  const provisioned = { ...emisor, providerOrgId: 'org1' }
  it('uploads the CSD and marks the emisor ACTIVE with the expiry', async () => {
    const d = deps({ findEmisor: jest.fn().mockResolvedValue(provisioned) })
    const r = await uploadEmisorCsd({ emisorId: 'e1', cerBase64: 'AA==', keyBase64: 'BB==', csdPassword: 'pw', expectedVenueId: 'v1' }, d)
    expect(d.accountProvider.uploadCsd).toHaveBeenCalledWith(
      expect.objectContaining({ providerOrgId: 'org1', cerBase64: 'AA==', keyBase64: 'BB==', csdPassword: 'pw' }),
    )
    const upd = (d.updateEmisor as jest.Mock).mock.calls[0][1]
    expect(upd.csdStatus).toBe('ACTIVE')
    expect(upd.csdExpiresAt).toBeInstanceOf(Date)
    expect(r.csdStatus).toBe('ACTIVE')
  })
  it('rejects uploading a CSD before the org is provisioned', async () => {
    const d = deps({ findEmisor: jest.fn().mockResolvedValue({ ...emisor, providerOrgId: null }) })
    await expect(
      uploadEmisorCsd({ emisorId: 'e1', cerBase64: 'AA==', keyBase64: 'BB==', csdPassword: 'pw', expectedVenueId: 'v1' }, d),
    ).rejects.toThrow(/provision/i)
  })
  it('tenant guard on the emisor', async () => {
    const d = deps({ findEmisor: jest.fn().mockResolvedValue({ ...provisioned, venueId: 'OTHER' }) })
    await expect(
      uploadEmisorCsd({ emisorId: 'e1', cerBase64: 'AA==', keyBase64: 'BB==', csdPassword: 'pw', expectedVenueId: 'v1' }, d),
    ).rejects.toThrow(/not found/)
  })
})
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement** (account provider built from `FACTURAPI_USER_KEY`; CSD never persisted)

```typescript
// src/services/fiscal/fiscalOnboarding.service.ts
import prisma from '../../utils/prismaClient'
import { env } from '../../config/env'
import { FacturapiProvider } from './providers/facturapi.provider'
import { FiscalProvider } from './providers/fiscal-provider.interface'
import { encryptProviderKey } from './fiscalKey.service'

export interface EmisorOnboardingDeps {
  findEmisor: (emisorId: string) => Promise<any | null>
  accountProvider: Pick<FiscalProvider, 'createOrganization' | 'updateOrgLegal' | 'uploadCsd'>
  updateEmisor: (emisorId: string, data: Record<string, any>) => Promise<any>
  encryptKey: (plaintext: string) => string
}

export async function provisionEmisor(
  params: { emisorId: string; expectedVenueId: string },
  deps: EmisorOnboardingDeps = defaultDeps(),
): Promise<any> {
  const emisor = await deps.findEmisor(params.emisorId)
  if (!emisor || emisor.venueId !== params.expectedVenueId) throw new Error(`Emisor ${params.emisorId} not found`) // tenant → 404

  const org = await deps.accountProvider.createOrganization({
    legalName: emisor.legalName,
    email: env.SUPPORT_EMAIL ?? 'facturacion@avoqado.io',
  })
  await deps.accountProvider.updateOrgLegal({
    providerOrgId: org.providerOrgId,
    legalName: emisor.legalName,
    taxSystem: emisor.regimenFiscal,
    zip: emisor.lugarExpedicion,
  })

  return deps.updateEmisor(emisor.id, {
    providerOrgId: org.providerOrgId,
    providerKeyEnc: deps.encryptKey(org.liveKey), // never store plaintext
    // csdStatus stays NONE — CSD upload is the next step
  })
}

export async function uploadEmisorCsd(
  params: { emisorId: string; cerBase64: string; keyBase64: string; csdPassword: string; expectedVenueId: string },
  deps: EmisorOnboardingDeps = defaultDeps(),
): Promise<any> {
  const emisor = await deps.findEmisor(params.emisorId)
  if (!emisor || emisor.venueId !== params.expectedVenueId) throw new Error(`Emisor ${params.emisorId} not found`) // tenant → 404
  if (!emisor.providerOrgId) throw new Error('El emisor debe provisionarse antes de subir el CSD')

  const res = await deps.accountProvider.uploadCsd({
    providerOrgId: emisor.providerOrgId,
    cerBase64: params.cerBase64,
    keyBase64: params.keyBase64,
    csdPassword: params.csdPassword,
  })
  // NOTE: cer/key/password are passed straight to facturapi and NEVER persisted or logged.
  return deps.updateEmisor(emisor.id, { csdStatus: 'ACTIVE', csdExpiresAt: res.csdExpiresAt, csdLastCheckedAt: new Date() })
}

function defaultDeps(): EmisorOnboardingDeps {
  // Org provisioning + CSD upload are ACCOUNT-level → use the account User Key.
  const accountProvider = new FacturapiProvider(env.FACTURAPI_USER_KEY ?? '')
  return {
    findEmisor: id => prisma.fiscalEmisor.findUnique({ where: { id } }),
    accountProvider,
    updateEmisor: (id, data) => prisma.fiscalEmisor.update({ where: { id }, data }),
    encryptKey: encryptProviderKey,
  }
}
```

> If `env.SUPPORT_EMAIL` doesn't exist, use a literal `'facturacion@avoqado.io'`. Confirm `FacturapiProvider` throws helpfully if
> `FACTURAPI_USER_KEY` is empty (it should — the constructor guards an empty key); provisioning without the key is a clear ops error, not a
> crash.

- [ ] **Step 4: Run → PASS**

---

### Task 3: Schemas + Controllers + Routes + ActivityLog

**Files:** `src/schemas/dashboard/cfdi.schema.ts`, `src/controllers/dashboard/cfdi.dashboard.controller.ts`,
`src/routes/dashboard.routes.ts`

- [ ] **CSD schema** (Spanish, `{ body }`): `uploadCsdSchema` = `{ cerBase64: string min1, keyBase64: string min1, password: string min1 }`.
      (Provision needs no body.)
- [ ] **Controllers** `provisionEmisorController` + `uploadEmisorCsdController`: read `authContext.venueId` + `:emisorId`; call the service;
      **write ActivityLog** on success (`FISCAL_EMISOR_PROVISIONED`, `FISCAL_CSD_UPLOADED`, entity `FiscalEmisor`, entityId,
      staffId=`authContext.userId`) via the same `logAction` helper used by the other cfdi controllers — match its signature; do NOT include
      the CSD key/password in the log `data`. Map `/not found/`→404, `/provision/`→409, else 500.
- [ ] **Routes** (gated `cfdi:configure`):

```typescript
router.post(
  '/venues/:venueId/fiscal/emisores/:emisorId/provision',
  authenticateTokenMiddleware,
  checkFeatureAccess('CFDI'),
  checkPermission('cfdi:configure'),
  provisionEmisorController,
)
router.post(
  '/venues/:venueId/fiscal/emisores/:emisorId/csd',
  authenticateTokenMiddleware,
  validateRequest(uploadCsdSchema),
  checkFeatureAccess('CFDI'),
  checkPermission('cfdi:configure'),
  uploadEmisorCsdController,
)
```

- [ ] Build → exit 0

---

### Task 4: Audit + regression (NO commit)

- [ ] `npm run audit:permissions` → exit 0.
- [ ] `npm run format && npm run lint:fix`, `npm run build` (exit 0),
      `npm test -- tests/unit/services/fiscal tests/unit/controllers/dashboard/cfdi.dashboard.controller.test.ts` (all green).
- [ ] DO NOT commit. Report files + audit + the SDK method name you confirmed for `updateOrgLegal`.

---

## Self-review

**Spec coverage (§7.2):** org provisioning (create + legal) ✓; CSD upload → `csdStatus=ACTIVE` + expiry ✓; CSD never persisted by us (only
org id + encrypted key) ✓; gated `cfdi:configure` ✓; tenant-safe (emisor venue == caller) ✓; ActivityLog on both mutations ✓. **Deferred:**
dashboard UI, LIVE provisioning run (needs founder `sk_user_` + real CSD), multipart, MCP tools.

**Placeholder scan:** the "confirm SDK method against installed types" notes (updateOrgLegal, uploadCertificate shape) are real
third-party-API verification, not logic gaps.

**Type consistency:** `updateOrgLegal`/`uploadCsd`/`createOrganization` use the 0b `FiscalProvider` types; `encryptProviderKey` from
`fiscalKey.service`; `cfdi:configure` from 0d; tenant-guard-as-404 mirrors `fiscalConfig`/`cfdi` services; `csdStatus` enum from 0a.

**Security:** CSD `.cer`/`.key`/password flow straight to facturapi and are NEVER written to DB or logs; only `providerOrgId` + the org live
key (encrypted) are stored.
