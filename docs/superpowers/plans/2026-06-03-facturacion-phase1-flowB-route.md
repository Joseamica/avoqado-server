# Facturación CFDI — Phase 1: Flow B (staff issues a CFDI for a bill via API) — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Checkbox steps.
> `.claude/rules/permissions-policy.md` + `payments.md` may auto-load.

**Goal:** Expose the issuance engine over HTTP: `POST /venues/:venueId/orders/:orderId/cfdi` lets a staffer (OWNER/ADMIN/MANAGER) issue a
CFDI for a closed bill — gated by the Pro feature + the `cfdi:issue` permission — by calling the existing `issueCfdiForOrder` (0c-2). After
this, facturación is invocable end-to-end via API (sandbox).

**Architecture:** Thin controller (no DB) → `issueCfdiForOrder` (service). Route applies, in order: `authenticateTokenMiddleware` →
`validateRequest(receptor schema)` → `checkFeatureAccess('CFDI')` → `checkPermission('cfdi:issue')` → controller. (Validate body BEFORE
perm/feature checks, per permissions-policy.) This is the **first route to apply `checkFeatureAccess`** (the middleware exists but was
`@pending-implementation`). For Pro venues the `CFDI` feature is granted via the base-plan blanket grant — no `VenueFeature` row needed; the
`seed-cfdi-feature.ts` (Task 4) only registers `CFDI` as a known feature for white-label/dashboard listing.

**Tech Stack:** Express, Zod (Spanish messages — `.claude/rules/critical-warnings.md`), Jest (controller unit test, service mocked).

**Scope — IN:** receptor Zod schema, thin controller, route + middleware chain, `seed-cfdi-feature.ts`, controller unit test. **OUT
(later):** dashboard/TPV UI, autofactura portal (A), global job (C), MCP tools (founder is wiring those), email delivery, retry job,
cancel/status endpoints. Design: spec §7.3 (Flow B), §15.

**Reference rules:** `.claude/rules/critical-warnings.md` (authContext NOT req.user; tenant isolation; Zod Spanish),
`.claude/rules/permissions-policy.md` (validate before perm check; audit must pass), `.claude/rules/testing-and-git.md` (NEVER commit
without asking).

> **Coordination:** the founder is concurrently wiring the MCP (`src/mcp/tools/sales.ts`) against `issueCfdiForOrder`. Do NOT touch
> `src/mcp/**`. Only create the files this plan names + register one route.

---

### Task 1: Receptor Zod schema

**Files:**

- Create: `src/schemas/dashboard/cfdi.schema.ts`
- Test: (covered by controller test in Task 5)

> Read an existing schema in `src/schemas/dashboard/` first to match the repo's `validateRequest` envelope convention (whether it validates
> `{ body }`, `{ body, params }`, etc.) and export style. Mirror it exactly. Messages MUST be Spanish, shape-only.

- [ ] **Step 1: Implement** (adjust the envelope to match the repo's existing schemas)

```typescript
// src/schemas/dashboard/cfdi.schema.ts
import { z } from 'zod'

/** Receptor fiscal data for issuing a CFDI 4.0 (Flow B). Shape-only; SAT-registry validity is checked at stamp time. */
export const issueCfdiBodySchema = z.object({
  rfc: z
    .string({ required_error: 'El RFC es requerido' })
    .trim()
    .regex(/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/i, 'El RFC no tiene un formato válido'),
  razonSocial: z.string({ required_error: 'La razón social es requerida' }).trim().min(1, 'La razón social es requerida'),
  regimenFiscal: z.string({ required_error: 'El régimen fiscal es requerido' }).regex(/^\d{3}$/, 'El régimen fiscal no es válido'),
  codigoPostal: z.string({ required_error: 'El código postal es requerido' }).regex(/^\d{5}$/, 'El código postal debe tener 5 dígitos'),
  usoCfdi: z.string({ required_error: 'El uso de CFDI es requerido' }).trim().min(1, 'El uso de CFDI es requerido'),
  email: z.string().email('El correo no es válido').optional(),
})

export type IssueCfdiBody = z.infer<typeof issueCfdiBodySchema>
```

- [ ] **Step 2: Build** · `npm run build` → exit 0

---

### Task 2: Thin controller

**Files:**

- Create: `src/controllers/dashboard/cfdi.dashboard.controller.ts`

> Read an existing thin controller (e.g. `src/controllers/dashboard/*.controller.ts`) to match the export/handler signature + how
> `authContext` and errors are handled. Use `(req as any).authContext` (NOT `req.user`).

- [ ] **Step 1: Implement**

```typescript
// src/controllers/dashboard/cfdi.dashboard.controller.ts
import { Request, Response } from 'express'
import { env } from '../../config/env'
import logger from '../../config/logger'
import { issueCfdiForOrder } from '../../services/fiscal/cfdi.service'

/** POST /venues/:venueId/orders/:orderId/cfdi — issue a CFDI for a closed bill (Flow B). */
export async function issueCfdiForOrderController(req: Request, res: Response): Promise<void> {
  const { orderId } = req.params
  const { rfc, razonSocial, regimenFiscal, codigoPostal, usoCfdi, email } = req.body
  // dev/staging stamp in facturapi sandbox (free, no SAT effect); prod uses the emisor's live key.
  const sandbox = env.NODE_ENV !== 'production'

  try {
    const result = await issueCfdiForOrder({
      orderId,
      receptor: { rfc, razonSocial, regimenFiscal, codigoPostal, usoCfdi, email },
      sandbox,
      flow: 'STAFF_B',
    })

    if (result.status === 'VALIDATION_FAILED') {
      res.status(422).json({ error: 'No se pudo facturar', reasons: result.reasons, cfdiId: result.cfdi?.id })
      return
    }
    if (result.status === 'STAMP_FAILED') {
      res.status(502).json({ error: 'El PAC rechazó el timbrado', message: result.cfdi?.lastError, cfdiId: result.cfdi?.id })
      return
    }
    res.status(201).json({
      cfdi: {
        id: result.cfdi.id,
        uuid: result.cfdi.uuid,
        serie: result.cfdi.serie,
        folio: result.cfdi.folio,
        status: result.cfdi.status,
        xmlUrl: result.cfdi.xmlUrl,
        pdfUrl: result.cfdi.pdfUrl,
      },
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`[cfdi.controller] issue failed for order ${orderId}: ${message}`)
    if (/not found|no fiscal emisor/i.test(message)) {
      res.status(404).json({ error: 'Orden no encontrada o sin emisor fiscal configurado' })
      return
    }
    res.status(500).json({ error: 'Error interno al facturar' })
  }
}
```

- [ ] **Step 2: Build** · `npm run build` → exit 0

---

### Task 3: Register the route

**Files:**

- Modify: the dashboard router (find where `POST /venues/:venueId/...` routes with `checkPermission` are registered — likely
  `src/routes/dashboard.routes.ts` or a sub-router). Read a nearby route to copy the exact middleware-import names and chain order.

- [ ] **Step 1: Add the route** (match the repo's exact middleware import names; conceptual chain):

```typescript
router.post(
  '/venues/:venueId/orders/:orderId/cfdi',
  authenticateTokenMiddleware,
  validateRequest(issueCfdiBodySchema), // validate body BEFORE feature/perm checks (permissions-policy)
  checkFeatureAccess('CFDI'),
  checkPermission('cfdi:issue'),
  issueCfdiForOrderController,
)
```

Import `issueCfdiBodySchema` from `../schemas/dashboard/cfdi.schema`, `checkFeatureAccess` from
`../middlewares/checkFeatureAccess.middleware`, `issueCfdiForOrderController` from `../controllers/dashboard/cfdi.dashboard.controller`. Use
the SAME `validateRequest`/`checkPermission`/`authenticateTokenMiddleware` imports the file already uses.

- [ ] **Step 2: Build** · `npm run build` → exit 0

---

### Task 4: Seed the `CFDI` feature (hygiene — gating already works via blanket grant)

**Files:**

- Create: `scripts/seed-cfdi-feature.ts`

> Mirror `scripts/seed-plan-pro.ts`'s `prisma.feature.upsert` shape (NO Stripe — CFDI is bundled in Pro, not sold à la carte).

- [ ] **Step 1: Implement**

```typescript
// scripts/seed-cfdi-feature.ts — registers CFDI as a known feature (bundled in Pro; no Stripe price).
import prisma from '../src/utils/prismaClient'
import logger from '../src/config/logger'

async function main() {
  await prisma.feature.upsert({
    where: { code: 'CFDI' },
    update: { active: true },
    create: {
      code: 'CFDI',
      name: 'Facturación CFDI 4.0',
      description: 'Emisión de facturas CFDI 4.0 (incluido en el plan Pro)',
      category: 'OPERATIONS',
      monthlyPrice: 0,
      active: true,
    },
  })
  logger.info('✅ Seeded CFDI feature')
}

main()
  .catch(e => {
    logger.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
```

- [ ] **Step 2: Run it** · `npx ts-node -r tsconfig-paths/register scripts/seed-cfdi-feature.ts` → prints `✅ Seeded CFDI feature`. (If the
      `Feature` model fields differ — e.g. `category` is an enum or `monthlyPrice` is required/Decimal — adjust to match
      `prisma/schema.prisma`; the build/seed will reveal it.)

---

### Task 5: Controller unit test (service mocked)

**Files:**

- Test: `tests/unit/controllers/dashboard/cfdi.dashboard.controller.test.ts`

- [ ] **Step 1: Write the test** (mock `issueCfdiForOrder`; assert HTTP mapping for all 3 outcomes + the not-found path)

```typescript
const mockIssue = jest.fn()
jest.mock('../../../../src/services/fiscal/cfdi.service', () => ({ issueCfdiForOrder: (...a: any[]) => mockIssue(...a) }))
import { issueCfdiForOrderController } from '../../../../src/controllers/dashboard/cfdi.dashboard.controller'

function mockRes() {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}
const req = () =>
  ({
    params: { orderId: 'o1' },
    body: { rfc: 'XAXX010101000', razonSocial: 'P', regimenFiscal: '616', codigoPostal: '83240', usoCfdi: 'S01' },
  }) as any

describe('issueCfdiForOrderController', () => {
  beforeEach(() => jest.clearAllMocks())

  it('201 with cfdi on STAMPED', async () => {
    mockIssue.mockResolvedValue({
      status: 'STAMPED',
      cfdi: { id: 'c1', uuid: 'U1', serie: 'F', folio: '2', status: 'STAMPED', xmlUrl: 'x', pdfUrl: 'p' },
    })
    const res = mockRes()
    await issueCfdiForOrderController(req(), res)
    expect(res.status).toHaveBeenCalledWith(201)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ cfdi: expect.objectContaining({ uuid: 'U1' }) }))
  })

  it('422 with reasons on VALIDATION_FAILED', async () => {
    mockIssue.mockResolvedValue({ status: 'VALIDATION_FAILED', reasons: ['x'], cfdi: { id: 'c1' } })
    const res = mockRes()
    await issueCfdiForOrderController(req(), res)
    expect(res.status).toHaveBeenCalledWith(422)
  })

  it('502 on STAMP_FAILED', async () => {
    mockIssue.mockResolvedValue({ status: 'STAMP_FAILED', cfdi: { id: 'c1', lastError: 'SAT down' } })
    const res = mockRes()
    await issueCfdiForOrderController(req(), res)
    expect(res.status).toHaveBeenCalledWith(502)
  })

  it('404 when the order is not found', async () => {
    mockIssue.mockRejectedValue(new Error('Order o1 not found or has no fiscal emisor configured'))
    const res = mockRes()
    await issueCfdiForOrderController(req(), res)
    expect(res.status).toHaveBeenCalledWith(404)
  })
})
```

- [ ] **Step 2: Run → PASS** · `npm test -- tests/unit/controllers/dashboard/cfdi.dashboard.controller.test.ts`

---

### Task 6: Audit + format + regression (NO commit)

- [ ] **Step 1:** `npm run audit:permissions` → **exit 0** (now `cfdi:issue` is used by a real route + satisfiable by OWNER/ADMIN/MANAGER →
      no PHANTOM; still in catalog → no CATALOG_GAP).
- [ ] **Step 2:** `npm run format && npm run lint:fix`, then `npm run build` (exit 0), then
      `npm test -- tests/unit/services/fiscal tests/unit/controllers/dashboard/cfdi.dashboard.controller.test.ts` (all green).
- [ ] **Step 3:** DO NOT commit. Report the changed/created files + audit output.

---

## Self-review

**Spec coverage (§7.3 Flow B, §15):** HTTP route to issue a CFDI for a bill ✓; gated by `checkFeatureAccess('CFDI')` (Pro) +
`checkPermission('cfdi:issue')` ✓; thin controller → `issueCfdiForOrder` ✓; receptor Zod (Spanish) ✓; sandbox in dev, live in prod ✓; CFDI
feature registered ✓. **Deferred:** UI, portal A, global C, MCP (founder), email, retry, cancel/status endpoints.

**Placeholder scan:** none — the only "adjust to match repo conventions" notes are for the `validateRequest` envelope + `Feature` model
field shapes (legitimate — match real code), not logic gaps.

**Type consistency:** controller consumes `issueCfdiForOrder`'s exact `{ status, cfdi, reasons }` shape (0c-2); `cfdi:issue` string matches
permissions.ts + the feature map (0d); `'CFDI'` feature code matches 0d's `PERMISSION_TO_FEATURE_MAP` + the seed.

**Order-of-middleware:** validate → feature → permission → controller (validate first per permissions-policy; feature before permission so
non-Pro venues get a clear 403-subscription rather than a perm error).
