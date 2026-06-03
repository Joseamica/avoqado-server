# Avoqado Admin MCP — Phase 1a (Read Tools) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a local, stdio MCP server inside `avoqado-server` exposing 5 read-only operational tools (`list_venues`/`list_orgs`,
`daily_sales`, `audit_terminals`, `find_order`/`find_payment`) that the founder drives from Claude.

**Architecture:** A small MCP server at `scripts/mcp/` that imports the repo's Prisma singleton (`@/utils/prismaClient`) and queries the DB
directly — same pattern as the ~40 existing `scripts/*.ts`. Read-only this phase: zero mutation risk. Pure logic (sales aggregation,
terminal-config auditing) is split into testable functions; the Prisma queries + MCP wiring are verified by a manual smoke test.

**Tech Stack:** `@modelcontextprotocol/sdk` (new dep), `zod` (present), `@prisma/client` (present), run with `tsx` (present), tests with
Jest/ts-jest (present, `tests/unit/**`).

**Source spec:** `docs/plans/2026-05-29-admin-mcp-design.md`

---

## File Structure

```
scripts/mcp/
  context.ts           # re-export prisma singleton; text()/formatMoney()/describeDbTarget() helpers
  server.ts            # entrypoint: McpServer, register all tools, StdioServerTransport, log DB target
  tools/
    venues.ts          # registerVenueTools  → list_venues, list_orgs
    sales.ts           # registerSalesTools   → daily_sales   (+ pure summarizeSales)
    terminals.ts       # registerTerminalTools→ audit_terminals (+ pure auditTerminalConfig)
    orders.ts          # registerOrderTools   → find_order, find_payment
  README.md            # how to register in Claude + run

tests/unit/mcp/
  summarizeSales.test.ts
  auditTerminalConfig.test.ts
```

Each tool file exports one `registerXxxTools(server)` function and keeps any branching logic in a separately-exported pure function.
`server.ts` imports and calls each register function.

**Type contracts used across tasks (defined in the tasks that own them):**

- `text(data: unknown): { content: { type: 'text'; text: string }[] }` — `context.ts` (Task 1)
- `summarizeSales(payments: SalesInput[]): SalesSummary` — `tools/sales.ts` (Task 3)
- `auditTerminalConfig(t: TerminalInput): TerminalConfigReport` — `tools/terminals.ts` (Task 4)

---

## Task 1: Scaffolding + smoke test

**Files:**

- Modify: `package.json` (add dep + `mcp` script)
- Create: `scripts/mcp/context.ts`
- Create: `scripts/mcp/server.ts`

- [ ] **Step 1: Install the MCP SDK**

Run:

```bash
npm install @modelcontextprotocol/sdk
```

Expected: adds `@modelcontextprotocol/sdk` to `dependencies`, no peer-dep errors.

- [ ] **Step 2: Create `scripts/mcp/context.ts`**

```typescript
import prisma from '@/utils/prismaClient'

export { prisma }

/** Wrap any data in the MCP text-content shape every tool returns. */
export function text(data: unknown): { content: { type: 'text'; text: string }[] } {
  const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  return { content: [{ type: 'text', text: body }] }
}

/** Format a Decimal/number as MXN money for human-readable output. */
export function formatMoney(amount: number | { toString(): string }): string {
  const n = Number(amount)
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n)
}

/** Human label for which DB this process is pointed at (logged on startup, stderr). */
export function describeDbTarget(): string {
  const url = process.env.DATABASE_URL ?? ''
  if (/localhost|127\.0\.0\.1/.test(url)) return 'LOCAL'
  if (/staging|stg/.test(url)) return 'STAGING'
  if (url) return 'REMOTE/PROD (⚠️ live data)'
  return 'UNKNOWN (DATABASE_URL not set)'
}
```

- [ ] **Step 3: Create `scripts/mcp/server.ts` with a single trivial `ping` tool**

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { describeDbTarget, text } from './context'

async function main() {
  const server = new McpServer({ name: 'avoqado-admin', version: '0.1.0' })

  // Smoke tool — confirms the server is wired before real tools are added.
  server.tool('ping', 'Health check. Returns the DB target this MCP is pointed at.', {}, async () =>
    text({ ok: true, dbTarget: describeDbTarget() }),
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
  // Logs MUST go to stderr — stdout is the MCP protocol channel.
  console.error(`[avoqado-admin MCP] connected · DB target: ${describeDbTarget()}`)
}

main().catch(err => {
  console.error('[avoqado-admin MCP] fatal:', err)
  process.exit(1)
})
```

- [ ] **Step 4: Add the `mcp` npm script**

In `package.json` `"scripts"`, add:

```json
"mcp": "tsx scripts/mcp/server.ts"
```

- [ ] **Step 5: Smoke test the server starts and the import chain resolves**

Run (the server reads from stdin; we send nothing and just confirm it boots without crashing, then Ctrl-C):

```bash
timeout 5 npm run mcp; echo "exit: $?"
```

Expected: stderr prints `[avoqado-admin MCP] connected · DB target: ...` and the process stays alive until the 5s timeout (exit 124). **If
it crashes with an ESM/`ERR_REQUIRE_ESM` or `Cannot find module '.../server/mcp.js'` error**, the SDK's ESM subpath imports aren't resolving
under tsx — fix by ensuring `scripts/mcp/*` is run through `tsx` (not `ts-node` CJS) and that imports use the exact `/server/mcp.js` and
`/server/stdio.js` subpaths shown. Do not proceed until this boots cleanly.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json scripts/mcp/context.ts scripts/mcp/server.ts
git commit -m "feat(mcp): scaffold avoqado-admin MCP server with ping smoke tool"
```

---

## Task 2: `list_venues` / `list_orgs` (base read tools)

**Files:**

- Create: `scripts/mcp/tools/venues.ts`
- Modify: `scripts/mcp/server.ts` (register the tools)

These are thin pass-through reads (resolve a venue/org by name → id). They have no branching logic, so they are verified by the manual smoke
test in Step 4 rather than a unit test.

- [ ] **Step 1: Create `scripts/mcp/tools/venues.ts`**

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { prisma, text } from '../context'

export function registerVenueTools(server: McpServer) {
  server.tool(
    'list_venues',
    'List venues, optionally filtered by a name substring or organization id. Returns id, name, slug, status, organization, city. Use this first to resolve the venueId that other tools need.',
    {
      query: z.string().optional().describe('Case-insensitive substring to match against venue name'),
      organizationId: z.string().optional().describe('Filter to one organization'),
      limit: z.number().int().min(1).max(200).default(50).describe('Max venues to return'),
    },
    async ({ query, organizationId, limit }) => {
      const venues = await prisma.venue.findMany({
        where: {
          ...(organizationId ? { organizationId } : {}),
          ...(query ? { name: { contains: query, mode: 'insensitive' } } : {}),
        },
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          active: true,
          city: true,
          timezone: true,
          organization: { select: { id: true, name: true } },
        },
        orderBy: { name: 'asc' },
        take: limit,
      })
      return text({ count: venues.length, venues })
    },
  )

  server.tool(
    'list_orgs',
    'List organizations, optionally filtered by a name substring. Returns id, name, slug, plus venue count. Use to resolve an organizationId.',
    {
      query: z.string().optional().describe('Case-insensitive substring to match against org name'),
      limit: z.number().int().min(1).max(200).default(50).describe('Max orgs to return'),
    },
    async ({ query, limit }) => {
      const orgs = await prisma.organization.findMany({
        where: query ? { name: { contains: query, mode: 'insensitive' } } : {},
        select: {
          id: true,
          name: true,
          slug: true,
          _count: { select: { venues: true } },
        },
        orderBy: { name: 'asc' },
        take: limit,
      })
      return text({ count: orgs.length, orgs })
    },
  )
}
```

- [ ] **Step 2: Register in `scripts/mcp/server.ts`**

Add the import at the top:

```typescript
import { registerVenueTools } from './tools/venues'
```

And inside `main()`, after the `ping` tool registration, add:

```typescript
registerVenueTools(server)
```

- [ ] **Step 3: Verify it compiles / boots**

Run:

```bash
timeout 5 npm run mcp; echo "exit: $?"
```

Expected: boots cleanly (stderr connected line, exit 124). No TS compile errors from `tsx`.

- [ ] **Step 4: Manual smoke (optional but recommended)**

Register the server in Claude (see Task 6) pointed at a non-prod DB, then ask Claude: "list venues matching 'pozos'". Expected: a JSON list
with matching venues and their ids.

- [ ] **Step 5: Commit**

```bash
git add scripts/mcp/tools/venues.ts scripts/mcp/server.ts
git commit -m "feat(mcp): add list_venues and list_orgs read tools"
```

---

## Task 3: `daily_sales` (with TDD on the aggregation)

**Files:**

- Create: `scripts/mcp/tools/sales.ts`
- Test: `tests/unit/mcp/summarizeSales.test.ts`
- Modify: `scripts/mcp/server.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/mcp/summarizeSales.test.ts`:

```typescript
import { summarizeSales } from '../../../scripts/mcp/tools/sales'

describe('summarizeSales', () => {
  const rows = [
    { amount: 100, method: 'CASH', type: 'REGULAR', status: 'COMPLETED' },
    { amount: 200, method: 'CREDIT_CARD', type: 'REGULAR', status: 'COMPLETED' },
    { amount: 50, method: 'CASH', type: 'FAST', status: 'COMPLETED' },
    { amount: 999, method: 'CASH', type: 'REGULAR', status: 'FAILED' }, // excluded
  ]

  it('totals only COMPLETED payments', () => {
    const s = summarizeSales(rows)
    expect(s.completedCount).toBe(3)
    expect(s.gross).toBe(350)
  })

  it('breaks down by payment method', () => {
    const s = summarizeSales(rows)
    expect(s.byMethod.CASH).toBe(150)
    expect(s.byMethod.CREDIT_CARD).toBe(200)
  })

  it('breaks down by payment type (flags FAST volume)', () => {
    const s = summarizeSales(rows)
    expect(s.byType.REGULAR).toBe(300)
    expect(s.byType.FAST).toBe(50)
  })

  it('handles an empty set', () => {
    const s = summarizeSales([])
    expect(s.completedCount).toBe(0)
    expect(s.gross).toBe(0)
    expect(s.byMethod).toEqual({})
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npx jest --selectProjects unit tests/unit/mcp/summarizeSales.test.ts
```

Expected: FAIL — `Cannot find module '.../scripts/mcp/tools/sales'` (file not created yet).

- [ ] **Step 3: Implement `scripts/mcp/tools/sales.ts`**

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { prisma, text, formatMoney } from '../context'
import { venueStartOfDay, venueEndOfDay } from '@/utils/datetime'

export interface SalesInput {
  amount: number | { toString(): string }
  method: string
  type: string | null
  status: string
}

export interface SalesSummary {
  completedCount: number
  gross: number
  byMethod: Record<string, number>
  byType: Record<string, number>
}

/** Pure aggregation over payment rows. Only COMPLETED payments count toward totals. */
export function summarizeSales(payments: SalesInput[]): SalesSummary {
  const summary: SalesSummary = { completedCount: 0, gross: 0, byMethod: {}, byType: {} }
  for (const p of payments) {
    if (p.status !== 'COMPLETED') continue
    const amt = Number(p.amount)
    summary.completedCount += 1
    summary.gross += amt
    summary.byMethod[p.method] = (summary.byMethod[p.method] ?? 0) + amt
    const t = p.type ?? 'UNKNOWN'
    summary.byType[t] = (summary.byType[t] ?? 0) + amt
  }
  return summary
}

export function registerSalesTools(server: McpServer) {
  server.tool(
    'daily_sales',
    "Sales summary for a venue over a day (default: today in the venue's timezone). Returns completed-payment count, gross total, and breakdowns by payment method and by payment type (REGULAR/FAST/etc).",
    {
      venueId: z.string().describe('Venue id (use list_venues to resolve)'),
      date: z.string().optional().describe('ISO date YYYY-MM-DD; defaults to today in the venue timezone'),
    },
    async ({ venueId, date }) => {
      const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { name: true, timezone: true } })
      if (!venue) return text({ error: `Venue ${venueId} not found` })

      const ref = date ? new Date(`${date}T12:00:00`) : undefined
      const start = venueStartOfDay(venue.timezone, ref)
      const end = venueEndOfDay(venue.timezone, ref)

      const payments = await prisma.payment.findMany({
        where: { venueId, createdAt: { gte: start, lte: end } },
        select: { amount: true, method: true, type: true, status: true },
      })

      const summary = summarizeSales(payments as SalesInput[])
      return text({
        venue: venue.name,
        window: { start: start.toISOString(), end: end.toISOString() },
        grossFormatted: formatMoney(summary.gross),
        ...summary,
      })
    },
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
npx jest --selectProjects unit tests/unit/mcp/summarizeSales.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Register in `scripts/mcp/server.ts`**

Add import:

```typescript
import { registerSalesTools } from './tools/sales'
```

Inside `main()`:

```typescript
registerSalesTools(server)
```

- [ ] **Step 6: Verify it boots**

Run:

```bash
timeout 5 npm run mcp; echo "exit: $?"
```

Expected: boots cleanly (exit 124).

- [ ] **Step 7: Commit**

```bash
git add scripts/mcp/tools/sales.ts tests/unit/mcp/summarizeSales.test.ts scripts/mcp/server.ts
git commit -m "feat(mcp): add daily_sales tool with tested aggregation"
```

---

## Task 4: `audit_terminals` (with TDD on the config audit)

**Files:**

- Create: `scripts/mcp/tools/terminals.ts`
- Test: `tests/unit/mcp/auditTerminalConfig.test.ts`
- Modify: `scripts/mcp/server.ts`

Background: a Terminal's effective TPV settings live in the `config` JSON (`config.settings`), with optional per-terminal `configOverrides`.
Known keys: `showCheckout` (the "Cobrar" button), `showQuickPayment` ("Pago rápido"), `enableShifts`. The PlayTelecom gap was
`showCheckout=true` while `showQuickPayment=false` across many terminals — this tool flags that.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/mcp/auditTerminalConfig.test.ts`:

```typescript
import { auditTerminalConfig } from '../../../scripts/mcp/tools/terminals'

describe('auditTerminalConfig', () => {
  it('extracts settings from config.settings merged with configOverrides', () => {
    const r = auditTerminalConfig({
      name: 'T1',
      serialNumber: 'AVQD-1',
      status: 'ACTIVE',
      config: { settings: { showCheckout: true, showQuickPayment: true, enableShifts: false } },
      configOverrides: { showQuickPayment: false }, // override wins
    })
    expect(r.settings.showCheckout).toBe(true)
    expect(r.settings.showQuickPayment).toBe(false)
    expect(r.settings.enableShifts).toBe(false)
  })

  it('flags checkout-on / quickpay-off (the PlayTelecom gap)', () => {
    const r = auditTerminalConfig({
      name: 'T2',
      serialNumber: null,
      status: 'ACTIVE',
      config: { settings: { showCheckout: true, showQuickPayment: false } },
      configOverrides: null,
    })
    expect(r.flags).toContain('checkout_on_quickpay_off')
  })

  it('produces no flags for a balanced config', () => {
    const r = auditTerminalConfig({
      name: 'T3',
      serialNumber: 'AVQD-3',
      status: 'ACTIVE',
      config: { settings: { showCheckout: true, showQuickPayment: true } },
      configOverrides: null,
    })
    expect(r.flags).toEqual([])
  })

  it('handles null/empty config without throwing', () => {
    const r = auditTerminalConfig({ name: 'T4', serialNumber: null, status: 'INACTIVE', config: null, configOverrides: null })
    expect(r.settings).toEqual({ showCheckout: undefined, showQuickPayment: undefined, enableShifts: undefined })
    expect(r.flags).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npx jest --selectProjects unit tests/unit/mcp/auditTerminalConfig.test.ts
```

Expected: FAIL — `Cannot find module '.../scripts/mcp/tools/terminals'`.

- [ ] **Step 3: Implement `scripts/mcp/tools/terminals.ts`**

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { prisma, text } from '../context'

export interface TerminalInput {
  name: string
  serialNumber: string | null
  status: string
  config: any
  configOverrides: any
}

export interface TerminalConfigReport {
  name: string
  serialNumber: string | null
  status: string
  settings: { showCheckout?: boolean; showQuickPayment?: boolean; enableShifts?: boolean }
  flags: string[]
}

/** Pure: merge config.settings + configOverrides, surface key TPV flags, detect known gaps. */
export function auditTerminalConfig(t: TerminalInput): TerminalConfigReport {
  const base = (t.config && typeof t.config === 'object' ? t.config.settings : null) ?? {}
  const overrides = (t.configOverrides && typeof t.configOverrides === 'object' ? t.configOverrides : null) ?? {}
  const merged = { ...base, ...overrides }

  const settings = {
    showCheckout: merged.showCheckout as boolean | undefined,
    showQuickPayment: merged.showQuickPayment as boolean | undefined,
    enableShifts: merged.enableShifts as boolean | undefined,
  }

  const flags: string[] = []
  if (settings.showCheckout === true && settings.showQuickPayment === false) {
    flags.push('checkout_on_quickpay_off')
  }

  return { name: t.name, serialNumber: t.serialNumber, status: t.status, settings, flags }
}

export function registerTerminalTools(server: McpServer) {
  server.tool(
    'audit_terminals',
    "Audit the TPV config of a venue's (or org's) terminals. Returns each terminal's effective showCheckout/showQuickPayment/enableShifts settings and flags known config gaps (e.g. checkout enabled while quick-pay disabled).",
    {
      venueId: z.string().optional().describe('Audit terminals of one venue'),
      organizationId: z.string().optional().describe('Audit terminals across an org (all its venues)'),
    },
    async ({ venueId, organizationId }) => {
      if (!venueId && !organizationId) return text({ error: 'Provide venueId or organizationId' })
      const terminals = await prisma.terminal.findMany({
        where: venueId ? { venueId } : { venue: { organizationId } },
        select: {
          name: true,
          serialNumber: true,
          status: true,
          config: true,
          configOverrides: true,
          venue: { select: { id: true, name: true } },
        },
        orderBy: { name: 'asc' },
      })
      const reports = terminals.map(t => ({
        venue: t.venue?.name,
        ...auditTerminalConfig(t as unknown as TerminalInput),
      }))
      const flagged = reports.filter(r => r.flags.length > 0)
      return text({ count: reports.length, flaggedCount: flagged.length, terminals: reports })
    },
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
npx jest --selectProjects unit tests/unit/mcp/auditTerminalConfig.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Register in `scripts/mcp/server.ts`**

Add import:

```typescript
import { registerTerminalTools } from './tools/terminals'
```

Inside `main()`:

```typescript
registerTerminalTools(server)
```

- [ ] **Step 6: Verify it boots**

Run:

```bash
timeout 5 npm run mcp; echo "exit: $?"
```

Expected: boots cleanly (exit 124).

- [ ] **Step 7: Commit**

```bash
git add scripts/mcp/tools/terminals.ts tests/unit/mcp/auditTerminalConfig.test.ts scripts/mcp/server.ts
git commit -m "feat(mcp): add audit_terminals tool with tested config audit"
```

---

## Task 5: `find_order` / `find_payment` (support lookup)

**Files:**

- Create: `scripts/mcp/tools/orders.ts`
- Modify: `scripts/mcp/server.ts`

Thin lookups (by id or by serial number → SerializedItem → OrderItem → Order). Verified by the manual smoke test; no branching logic worth a
unit test beyond what Prisma enforces.

- [ ] **Step 1: Create `scripts/mcp/tools/orders.ts`**

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { prisma, text, formatMoney } from '../context'

export function registerOrderTools(server: McpServer) {
  server.tool(
    'find_order',
    'Find an order by its id, or by a product serial number (ICCID/barcode) that was sold on it. Returns order number, status, total, venue, terminal and timestamps.',
    {
      orderId: z.string().optional().describe('Exact order id'),
      serialNumber: z.string().optional().describe('Serial of a sold item linked to the order'),
    },
    async ({ orderId, serialNumber }) => {
      if (!orderId && !serialNumber) return text({ error: 'Provide orderId or serialNumber' })

      let resolvedOrderId = orderId
      if (!resolvedOrderId && serialNumber) {
        const item = await prisma.serializedItem.findFirst({
          where: { serialNumber },
          select: { orderItem: { select: { orderId: true } } },
        })
        if (!item?.orderItem?.orderId) return text({ error: `No order found for serial ${serialNumber}` })
        resolvedOrderId = item.orderItem.orderId
      }

      const order = await prisma.order.findUnique({
        where: { id: resolvedOrderId },
        select: {
          id: true,
          orderNumber: true,
          type: true,
          status: true,
          total: true,
          createdAt: true,
          completedAt: true,
          venue: { select: { id: true, name: true } },
          terminal: { select: { id: true, name: true, serialNumber: true } },
          payments: { select: { id: true, amount: true, method: true, status: true, type: true } },
        },
      })
      if (!order) return text({ error: `Order ${resolvedOrderId} not found` })
      return text({ ...order, totalFormatted: formatMoney(order.total) })
    },
  )

  server.tool(
    'find_payment',
    'Find a payment by its id. Returns amount, method, status, type, venue, terminal, order and timestamp.',
    {
      paymentId: z.string().describe('Exact payment id'),
    },
    async ({ paymentId }) => {
      const payment = await prisma.payment.findUnique({
        where: { id: paymentId },
        select: {
          id: true,
          amount: true,
          method: true,
          status: true,
          type: true,
          createdAt: true,
          venue: { select: { id: true, name: true } },
          terminal: { select: { id: true, name: true, serialNumber: true } },
          order: { select: { id: true, orderNumber: true, status: true } },
        },
      })
      if (!payment) return text({ error: `Payment ${paymentId} not found` })
      return text({ ...payment, amountFormatted: formatMoney(payment.amount) })
    },
  )
}
```

- [ ] **Step 2: Register in `scripts/mcp/server.ts`**

Add import:

```typescript
import { registerOrderTools } from './tools/orders'
```

Inside `main()`:

```typescript
registerOrderTools(server)
```

- [ ] **Step 3: Verify it boots**

Run:

```bash
timeout 5 npm run mcp; echo "exit: $?"
```

Expected: boots cleanly (exit 124).

- [ ] **Step 4: Commit**

```bash
git add scripts/mcp/tools/orders.ts scripts/mcp/server.ts
git commit -m "feat(mcp): add find_order and find_payment lookup tools"
```

---

## Task 6: README, register in Claude, and full manual verification

**Files:**

- Create: `scripts/mcp/README.md`

- [ ] **Step 1: Run the full unit suite to confirm nothing regressed**

Run:

```bash
npx jest --selectProjects unit tests/unit/mcp
```

Expected: PASS (summarizeSales 4 + auditTerminalConfig 4 = 8 tests).

- [ ] **Step 2: Create `scripts/mcp/README.md`**

```markdown
# Avoqado Admin MCP (internal)

Local, single-user MCP server exposing read-only operational tools over stdio. Run with `npm run mcp`. See
`docs/plans/2026-05-29-admin-mcp-design.md` for the full design.

## Tools (Phase 1a — read only)

- `list_venues` / `list_orgs` — resolve venue/org ids
- `daily_sales` — sales summary for a venue/day (timezone-correct)
- `audit_terminals` — terminal TPV config audit + gap flags
- `find_order` / `find_payment` — support lookup by id or serial

## Register in Claude

Add to your MCP config (project `.mcp.json` or global), pointing `DOTENV_CONFIG_PATH` at the environment you want (⚠️ this server reads
whatever DATABASE_URL is set):

\`\`\`json { "mcpServers": { "avoqado-admin": { "command": "tsx", "args": ["scripts/mcp/server.ts"], "cwd":
"/Users/amieva/Documents/Programming/Avoqado/avoqado-server", "env": { "DOTENV_CONFIG_PATH": ".env" } } } } \`\`\`

The server logs its DB target to stderr on startup. Phase 1a is read-only; write tools (Phase 1b+) will add preview+confirm guards.
```

- [ ] **Step 3: Manual agent-loop verification**

Register the server in Claude pointed at a **non-prod** DB. In a Claude session, run each tool and confirm the agent selects the right one
and gets usable output:

1. "list venues matching 'pozos'" → `list_venues` returns matches + ids
2. "today's sales for venue <id>" → `daily_sales` returns a summary
3. "audit terminals for org <id>" → `audit_terminals` returns reports, flags any checkout/quickpay gaps
4. "find payment <id>" → `find_payment` returns the payment
5. "find the order for serial <iccid>" → `find_order` resolves via the serial

Note any tool the agent picks wrong or any confusing output; refine the tool `description` strings if needed (descriptions are how the agent
chooses).

- [ ] **Step 4: Commit**

```bash
git add scripts/mcp/README.md
git commit -m "docs(mcp): add Phase 1a README and registration guide"
```

---

## Self-Review

**Spec coverage (against `2026-05-29-admin-mcp-design.md`):**

- §2 architecture (scripts/mcp, stdio, Prisma direct, @modelcontextprotocol/sdk only new dep) → Task 1 ✓
- §3 safety: read/write separation → this plan is read-only ✓; env target surfaced on startup → `describeDbTarget()` Task 1 ✓
  (preview+confirm/audit-log apply to write tools, deferred to Phase 1b — out of scope here, intentionally)
- §4 Phase 1 read tools 1–4 (list_venues/orgs, daily_sales, audit_terminals, find_order/find_payment) → Tasks 2–5 ✓
- §4 light writes (sale_verifications reopen, move_terminal, update_user) → **deferred to Phase 1b plan** (separate doc) — noted, not a gap
- §5 registration → Task 6 README ✓
- §7 testing: unit tests on pure logic + manual agent loop → Tasks 3, 4, 6 ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every command shows expected output. ✓

**Type consistency:** `text()` (context.ts) used by all tools with the same shape; `summarizeSales`/`SalesInput`/`SalesSummary` consistent
between Task 3 test and impl; `auditTerminalConfig`/`TerminalInput`/`TerminalConfigReport` consistent between Task 4 test and impl;
`registerVenueTools`/`registerSalesTools`/`registerTerminalTools`/`registerOrderTools` names match between tool files and `server.ts`
imports. ✓

**Known risk carried from spec:** MCP SDK is ESM-only; Task 1 Step 5 smoke test exists specifically to catch ESM/tsx interop before building
further.
