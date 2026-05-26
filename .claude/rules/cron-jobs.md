---
paths:
  - 'src/jobs/**/*.ts'
  - 'src/server.ts'
---

# Cron Jobs — MANDATORY: wrap the entry DB read with connection retry

## The problem (real production incident, 2026-05-26)

Every hour at minute `:00` (and `:05`, `:10`, `:15`, `:30`...) ALL cron schedules align —
`*/2`, `*/5`, `*/15`, `*/30s` and `0 * * * *` jobs fire at the same instant. The simultaneous
burst of new Prisma connections exceeds Prisma's default 5s `connect_timeout`, and any job
that needs a fresh connection throws **`P1001 — Can't reach database server`** and dies for
that tick. It is transient (the DB is healthy, recovers in <10s) but it kills the tick.

Empirically this took down 9 different jobs (TPV health, Marketing, Reservation Reminders,
Auto No-Show, Deposit Reconciliation, Gcal Inbox/Outbox Sweeper, Monitor POS, Auto-Clockout).

## The rule

**Any cron job that queries the DB MUST wrap its FIRST/entry query with `retry()` using the
`shouldRetryDbConnectionError` predicate.** That entry read is what fails during the stampede
(it runs before any side effect). Helper already exists — DO NOT build a new one:

```typescript
import { retry, shouldRetryDbConnectionError } from '../utils/retry'

const rows = await retry(
  () => prisma.someModel.findMany({ where: { ... } }),
  { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context: 'my-job.findX' },
)
```

`shouldRetryDbConnectionError` retries ONLY connection-level errors (P1001/P1002/P1008/P1017 +
ECONNREFUSED/ETIMEDOUT/ENOTFOUND/ECONNRESET/EPIPE). It deliberately does NOT retry P2xxx
data/constraint errors — those still fail fast.

## What you may and may NOT wrap — READ THIS

P1001 means "the query never reached the server", so retrying it is safe ONLY for operations
that are safe to run twice:

| Safe to wrap (retry) | NEVER wrap (would double-execute) |
| --- | --- |
| Pure reads (`findMany`, `findFirst`, `count`) | Email / WhatsApp / push sends |
| Idempotent `updateMany` (WHERE excludes already-done rows) | `increment` / `decrement` counters |
| | Stripe / MercadoPago / external API calls |
| | Anything inside `prisma.$transaction(...)` |

**NEVER add a global Prisma retry (client extension / `$use` middleware).** The codebase has
~90 files using interactive `$transaction(async (tx) => ...)`, including money flows
(`order.tpv.service`, pricing, payments). Retrying a single statement inside a live transaction
corrupts atomicity. The per-job entry-read wrap is the correct, contained fix.

## Checklist when adding/editing a cron job

1. [ ] Does it query the DB on each tick? → wrap the entry read with `retry(..., shouldRetryDbConnectionError)`.
2. [ ] Is the wrapped op a pure read or an idempotent updateMany? (If not, you're wrapping the wrong line.)
3. [ ] Did I leave all sends / external calls / `$transaction` blocks OUTSIDE the retry? (required)
4. [ ] Consider offsetting the cron minute (e.g. `7 * * * *` instead of `0 * * * *`) to reduce stampede overlap.
5. [ ] `npm run build` passes.
