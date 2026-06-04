# Facturación CFDI — Phase 1.5: Cancel + Status endpoints — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Checkbox steps.

**Goal:** Round out the CFDI lifecycle over HTTP: **cancel** an issued CFDI (4.0, with motivo) and **read its status**. Both reuse the
existing 0b connector (`cancelInvoice`, `getInvoice`). Cancel is destructive (voids a fiscal doc) → gated by `cfdi:configure` (OWNER/ADMIN);
status read → `cfdi:view`.

**Architecture:** Two thin controllers → two new service functions (`cancelCfdi`, `getCfdiStatus`) in `src/services/fiscal/cfdi.service.ts`,
written with the SAME dependency-injection pattern as `issueCfdiForOrder` (loader/provider/persist injected) so they're unit-testable
without DB. Tenant-safe: both load the `Cfdi` by id scoped to the caller's venue (`expectedVenueId`).

**Tech Stack:** Express, Zod (Spanish), Jest (mocked deps). Reuses 0b `FiscalProvider.cancelInvoice`/`getInvoice` + 0d permissions.

**Scope — IN:** `cancelCfdi` + `getCfdiStatus` service fns (DI) + tests; cancel Zod schema (motivo 01-04, substituteUuid required for 01); 2
controllers; 2 routes (`POST .../cfdi/:cfdiId/cancel`, `GET .../cfdi/:cfdiId`); controller tests. **OUT (later):** emisor/CSD onboarding
(needs facturapi account), global job (C), retry job, the receptor-acceptance buzón UX (PAC/SAT handle it). Design: spec §12.

**Reference rules:** `.claude/rules/critical-warnings.md` (authContext, tenant isolation, Zod Spanish),
`.claude/rules/permissions-policy.md`, `.claude/rules/testing-and-git.md` (NEVER commit; do NOT touch `src/mcp/**`).

> **Coordination:** founder is wiring the MCP concurrently — do NOT touch `src/mcp/**`. Read the existing `issueCfdiForOrder` +
> `IssueCfdiDeps` in `cfdi.service.ts` first and mirror its DI + tenant-guard style exactly.

---

### Task 1: Service — `cancelCfdi` + `getCfdiStatus` (DI, tenant-safe)

**Files:**

- Modify: `src/services/fiscal/cfdi.service.ts` (add two exported fns + their deps types + real defaults, mirroring
  `issueCfdiForOrder`/`IssueCfdiDeps`/`defaultDeps`)
- Test: `tests/unit/services/fiscal/cfdiCancel.service.test.ts`

> Read `issueCfdiForOrder` + `IssueCfdiDeps` + `defaultDeps` first. Mirror: a `*Deps` interface, real defaults at the bottom (prisma +
> `resolveFiscalProvider`), and the `expectedVenueId` tenant guard (throw `"... not found"` → 404).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/services/fiscal/cfdiCancel.service.test.ts
import { cancelCfdi, getCfdiStatus, CancelCfdiDeps, GetCfdiStatusDeps } from '../../../../src/services/fiscal/cfdi.service'

const stampedCfdi = {
  id: 'c1',
  venueId: 'v1',
  status: 'STAMPED',
  uuid: 'U1',
  facturapiId: 'fa1',
  fiscalEmisor: { provider: 'FACTURAPI', providerKeyEnc: null, csdStatus: 'ACTIVE' },
}
function cancelDeps(over: Partial<CancelCfdiDeps> = {}): CancelCfdiDeps {
  return {
    loadCfdi: jest.fn().mockResolvedValue(stampedCfdi),
    resolveProvider: jest.fn().mockReturnValue({
      name: 'facturapi',
      cancelInvoice: jest.fn().mockResolvedValue({ status: 'accepted', cancelledAt: new Date() }),
    } as any),
    updateCfdi: jest.fn().mockImplementation(async (_id, data) => ({ ...stampedCfdi, ...data })),
    ...over,
  }
}

describe('cancelCfdi', () => {
  beforeEach(() => jest.clearAllMocks())

  it('cancels a STAMPED cfdi (motivo 02) and persists cancel status', async () => {
    const deps = cancelDeps()
    const res = await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true, expectedVenueId: 'v1' }, deps)
    expect(deps.resolveProvider).toHaveBeenCalled()
    const update = (deps.updateCfdi as jest.Mock).mock.calls[0][1]
    expect(update.cancelMotivo).toBe('02')
    expect(['ACCEPTED', 'CANCELLED', 'REQUESTED']).toContain(update.cancelStatus)
    expect(res.cancelStatus).toBeDefined()
  })

  it('tenant isolation: throws (→404) when the cfdi belongs to another venue', async () => {
    const deps = cancelDeps()
    await expect(cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true, expectedVenueId: 'OTHER' }, deps)).rejects.toThrow(/not found/)
    expect(deps.resolveProvider).not.toHaveBeenCalled()
  })

  it('rejects motivo 01 without a substitute UUID', async () => {
    const deps = cancelDeps()
    await expect(cancelCfdi({ cfdiId: 'c1', motivo: '01', sandbox: true, expectedVenueId: 'v1' }, deps)).rejects.toThrow(
      /sustituci|substitut/i,
    )
    expect(deps.resolveProvider).not.toHaveBeenCalled()
  })

  it('rejects cancelling a cfdi that is not STAMPED', async () => {
    const deps = cancelDeps({ loadCfdi: jest.fn().mockResolvedValue({ ...stampedCfdi, status: 'DRAFT' }) })
    await expect(cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true, expectedVenueId: 'v1' }, deps)).rejects.toThrow(/timbrad|stamped/i)
  })
})

describe('getCfdiStatus', () => {
  it('returns the cfdi scoped to the venue', async () => {
    const deps: GetCfdiStatusDeps = { loadCfdi: jest.fn().mockResolvedValue(stampedCfdi) }
    const res = await getCfdiStatus({ cfdiId: 'c1', expectedVenueId: 'v1' }, deps)
    expect(res.uuid).toBe('U1')
  })
  it('tenant isolation: throws when venue mismatches', async () => {
    const deps: GetCfdiStatusDeps = { loadCfdi: jest.fn().mockResolvedValue(stampedCfdi) }
    await expect(getCfdiStatus({ cfdiId: 'c1', expectedVenueId: 'OTHER' }, deps)).rejects.toThrow(/not found/)
  })
})
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement** — add to `cfdi.service.ts` (illustrative; match the existing DI/types style):

```typescript
// ─── Cancel ───────────────────────────────────────────────────────────────
export interface CancelCfdiDeps {
  loadCfdi: (cfdiId: string) => Promise<any | null>
  resolveProvider: typeof resolveFiscalProvider
  updateCfdi: (cfdiId: string, data: Record<string, any>) => Promise<any>
}

const CANCEL_MOTIVOS = ['01', '02', '03', '04'] as const

export async function cancelCfdi(
  params: { cfdiId: string; motivo: '01' | '02' | '03' | '04'; substituteUuid?: string; sandbox: boolean; expectedVenueId?: string },
  deps: CancelCfdiDeps = defaultCancelDeps,
): Promise<{ cancelStatus: string; cancelledAt: Date | null; cfdi: any }> {
  const cfdi = await deps.loadCfdi(params.cfdiId)
  if (!cfdi) throw new Error(`CFDI ${params.cfdiId} not found`)
  if (params.expectedVenueId && cfdi.venueId !== params.expectedVenueId) throw new Error(`CFDI ${params.cfdiId} not found`) // tenant isolation → 404
  if (cfdi.status !== 'STAMPED') throw new Error('Solo se puede cancelar un CFDI timbrado')
  if (params.motivo === '01' && !params.substituteUuid) throw new Error('El motivo 01 requiere el UUID de sustitución')

  const provider = deps.resolveProvider(cfdi.fiscalEmisor, { sandbox: params.sandbox })
  const result = await provider.cancelInvoice({
    providerInvoiceId: cfdi.facturapiId,
    motivo: params.motivo,
    substituteUuid: params.substituteUuid,
  })

  const cancelStatus = mapProviderCancelToCfdi(result.status) // accepted/canceled→ACCEPTED/CANCELLED, pending→REQUESTED, rejected→REJECTED
  const updated = await deps.updateCfdi(cfdi.id, {
    cancelMotivo: params.motivo,
    cancelSubstituteUuid: params.substituteUuid ?? null,
    cancelStatus,
    cancelRequestedAt: new Date(),
    cancelledAt: result.cancelledAt,
    status: cancelStatus === 'CANCELLED' || cancelStatus === 'ACCEPTED' ? 'CANCELLED' : cfdi.status,
  })
  return { cancelStatus, cancelledAt: result.cancelledAt, cfdi: updated }
}

function mapProviderCancelToCfdi(s: string): 'REQUESTED' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED' {
  switch (s) {
    case 'canceled':
      return 'CANCELLED'
    case 'accepted':
      return 'ACCEPTED'
    case 'rejected':
      return 'REJECTED'
    default:
      return 'REQUESTED' // pending/verifying/none/expired → still pending resolution
  }
}

// ─── Status ───────────────────────────────────────────────────────────────
export interface GetCfdiStatusDeps {
  loadCfdi: (cfdiId: string) => Promise<any | null>
}
export async function getCfdiStatus(
  params: { cfdiId: string; expectedVenueId?: string },
  deps: GetCfdiStatusDeps = defaultStatusDeps,
): Promise<any> {
  const cfdi = await deps.loadCfdi(params.cfdiId)
  if (!cfdi) throw new Error(`CFDI ${params.cfdiId} not found`)
  if (params.expectedVenueId && cfdi.venueId !== params.expectedVenueId) throw new Error(`CFDI ${params.cfdiId} not found`)
  return cfdi
}

// Real defaults (mirror defaultDeps): loadCfdi includes fiscalEmisor; updateCfdi = prisma.cfdi.update.
const defaultCancelDeps: CancelCfdiDeps = {
  loadCfdi: id => prisma.cfdi.findUnique({ where: { id }, include: { fiscalEmisor: true } }),
  resolveProvider: resolveFiscalProvider,
  updateCfdi: (id, data) => prisma.cfdi.update({ where: { id }, data }),
}
const defaultStatusDeps: GetCfdiStatusDeps = {
  loadCfdi: id => prisma.cfdi.findUnique({ where: { id } }),
}
```

> Confirm `CancelInvoiceParams` shape (`providerInvoiceId`/`motivo`/`substituteUuid`) + `CancelInvoiceResult` (`status`/`cancelledAt`)
> against `fiscal-provider.interface.ts`. `CfdiCancelStatus` enum values (REQUESTED/ACCEPTED/REJECTED/CANCELLED) per `prisma/schema.prisma`.

- [ ] **Step 4: Run → PASS**

---

### Task 2: Cancel Zod schema

**Files:**

- Modify: `src/schemas/dashboard/cfdi.schema.ts` (add `cancelCfdiSchema`, same envelope convention as `issueCfdiSchema`)

```typescript
export const cancelCfdiSchema = z.object({
  body: z.object({
    motivo: z.enum(['01', '02', '03', '04'], { required_error: 'El motivo de cancelación es requerido' }),
    substituteUuid: z.string().uuid('El UUID de sustitución no es válido').optional(),
  }),
})
```

(The "01 requires substituteUuid" cross-field rule stays in the service — Zod is shape-only per the rule.)

- [ ] Build → exit 0

---

### Task 3: Controllers

**Files:**

- Modify: `src/controllers/dashboard/cfdi.dashboard.controller.ts` (add `cancelCfdiController`, `getCfdiStatusController`)

Both read `(req as any).authContext.venueId` → pass as `expectedVenueId`; `sandbox = env.NODE_ENV !== 'production'`. Map: cancel success →
200 `{ cancelStatus }`; status → 200 `{ cfdi }`; not-found → 404; the service's validation `Error`s (not stamped / motivo 01 / substitute) →
409 with the Spanish message. Mirror the existing `issueCfdiForOrderController` error-handling shape.

- [ ] Build → exit 0

---

### Task 4: Routes

**Files:**

- Modify: `src/routes/dashboard.routes.ts`

```typescript
router.get(
  '/venues/:venueId/cfdi/:cfdiId',
  authenticateTokenMiddleware,
  checkFeatureAccess('CFDI'),
  checkPermission('cfdi:view'),
  getCfdiStatusController,
)
router.post(
  '/venues/:venueId/cfdi/:cfdiId/cancel',
  authenticateTokenMiddleware,
  validateRequest(cancelCfdiSchema),
  checkFeatureAccess('CFDI'),
  checkPermission('cfdi:configure'), // destructive → OWNER/ADMIN
  cancelCfdiController,
)
```

- [ ] Build → exit 0

---

### Task 5: Controller tests + audit + regression (NO commit)

**Files:**

- Test: `tests/unit/controllers/dashboard/cfdi.dashboard.controller.test.ts` (extend: cancel→200, not-stamped→409, not-found→404;
  status→200/404 — mock the service fns)

- [ ] `npm run audit:permissions` → exit 0 (cancel uses `cfdi:configure`, status uses `cfdi:view` — both already in defaults/catalog from 0d
      → no PHANTOM).
- [ ] `npm run format && npm run lint:fix`, `npm run build` (exit 0),
      `npm test -- tests/unit/services/fiscal tests/unit/controllers/dashboard/cfdi.dashboard.controller.test.ts` (all green).
- [ ] DO NOT commit. Report files + audit output.

---

## Self-review

**Spec coverage (§12):** cancel with motivo 01-04 ✓; motivo 01 requires substitution ✓; cancel gated to OWNER/ADMIN (`cfdi:configure`) —
appropriate for a destructive fiscal action ✓; status read (`cfdi:view`) ✓; PAC/SAT handle receptor-acceptance (we record `cancelStatus`) ✓;
tenant-safe ✓. **Deferred:** late-cancel multa warning UI, buzón polling, emisor onboarding, global/retry jobs.

**Placeholder scan:** none — the "confirm interface/enum shapes" notes are for matching existing 0b/0a types, not logic gaps.

**Type consistency:** `cancelInvoice`/`getInvoice` calls match the 0b `FiscalProvider` interface; `CfdiCancelStatus` values match 0a schema;
`cfdi:configure`/`cfdi:view` match 0d permissions + feature map; DI shapes identical between service and tests; tenant guard mirrors
`issueCfdiForOrder`.
