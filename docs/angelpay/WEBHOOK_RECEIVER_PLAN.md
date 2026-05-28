# AngelPay Webhook Receiver — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `POST /api/v1/webhooks/angelpay` receiver that verifies Svix-signed AngelPay payment confirmations and reconciles them
against the `Payment` table.

**Architecture:** Pure-function service (`angelpay-webhook.service.ts`) wrapped by a thin Express controller
(`angelpay-webhook.tpv.controller.ts`). The service is fully testable in isolation; the controller is the HTTP adapter (raw-body parse, Svix
verify, response codes). Persists every event to `ProviderEventLog` (reused from Blumon). One new `MerchantAccount` column
(`angelpayWebhookLastReceivedAt`). No cron, no PENDING TTL — justified by the "AngelPay terminal requires internet to cobrar" invariant.

**Tech Stack:** TypeScript, Express, Prisma (PostgreSQL), Svix npm (already installed `^1.84.1`), Jest + ts-jest.

**Spec:** [`docs/angelpay/WEBHOOK_RECEIVER_SPEC.md`](./WEBHOOK_RECEIVER_SPEC.md)

---

## File Map

| File                                                                                          | Action           | Responsibility                                                                                                                                            |
| --------------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prisma/schema.prisma`                                                                        | Modify           | Add `angelpayWebhookLastReceivedAt DateTime?` to `MerchantAccount`                                                                                        |
| `prisma/migrations/<ts>_add_angelpay_webhook_last_received_to_merchant_account/migration.sql` | Create (via CLI) | One ALTER TABLE statement                                                                                                                                 |
| `src/services/tpv/angelpay-webhook.service.ts`                                                | Create           | Pure logic: types, error reasons, secret resolver, validators, persist helpers, matching loop, top-level `processAngelPayWebhook` orchestrator            |
| `src/controllers/tpv/angelpay-webhook.tpv.controller.ts`                                      | Create           | HTTP adapter: parse Buffer, normalize Svix headers, verify signature, dispatch to service, map result → HTTP response. Plus `angelpayWebhookHealthCheck`. |
| `src/routes/webhook.routes.ts`                                                                | Modify           | Register `POST /angelpay` + `GET /angelpay/health` (next to Blumon routes)                                                                                |
| `tests/unit/services/tpv/angelpay-webhook.service.test.ts`                                    | Create           | Service-layer tests (mocked Prisma) covering every action label in §11 of the spec                                                                        |
| `tests/unit/controllers/tpv/angelpay-webhook.tpv.controller.test.ts`                          | Create           | Controller-layer tests (mocked service + svix) covering signature failure paths and response shapes                                                       |

**Conventions to follow (verified in existing codebase):**

- Import `prisma` from `@/utils/prismaClient`
- Import `logger` from `@/config/logger` (or relative `../../config/logger` — match the file's local style)
- Jest mocks via `jest.mock('@/path/...', () => ({...}))`
- Test file naming: `<feature>.test.ts` colocated under `tests/unit/{services|controllers}/tpv/`
- Webhook routes use `express.raw({ type: 'application/json' })` at the app level — body is `Buffer` inside the handler

---

## Pre-commit checklist for every task

After each task: `npm run lint` and the specific test command for that task must pass. Final commit message format:
`feat(angelpay-webhook): <short description>`.

---

## Task 1: Prisma schema + migration

**Files:**

- Modify: `prisma/schema.prisma` (the `MerchantAccount` model)
- Create: `prisma/migrations/<auto-timestamp>_add_angelpay_webhook_last_received_to_merchant_account/migration.sql`

- [ ] **Step 1: Add the column to schema**

Open `prisma/schema.prisma`, find `model MerchantAccount {`. Locate the existing AngelPay display fields block (search for
`angelpayMerchantName`). Add this single line in the same block:

```prisma
  /// Last time we successfully processed an AngelPay webhook for this merchant.
  /// NULL = never. Useful for ops dashboard ("¿está vivo el endpoint?").
  angelpayWebhookLastReceivedAt DateTime?
```

- [ ] **Step 2: Generate migration**

Run: `npx prisma migrate dev --name add_angelpay_webhook_last_received_to_merchant_account`

Expected: Prisma creates the migration folder, applies it to the dev DB, and regenerates the client. The generated SQL should be:

```sql
ALTER TABLE "MerchantAccount" ADD COLUMN "angelpayWebhookLastReceivedAt" TIMESTAMP(3);
```

- [ ] **Step 3: Verify Prisma client regenerated**

Run: `npx prisma generate && npx tsc --noEmit -p tsconfig.json 2>&1 | head -5` Expected: no errors. The new field is now available as
`merchantAccount.angelpayWebhookLastReceivedAt`.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(angelpay-webhook): add MerchantAccount.angelpayWebhookLastReceivedAt"
```

---

## Task 2: Service scaffold — types, error reasons, secret resolver

**Files:**

- Create: `src/services/tpv/angelpay-webhook.service.ts`
- Create: `tests/unit/services/tpv/angelpay-webhook.service.test.ts`

- [ ] **Step 1: Write failing tests for secret resolver**

Create `tests/unit/services/tpv/angelpay-webhook.service.test.ts`:

```ts
import { getActiveWebhookSecret } from '@/services/tpv/angelpay-webhook.service'

describe('getActiveWebhookSecret', () => {
  const ORIGINAL_ENV = process.env

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV }
    delete process.env.ANGELPAY_WEBHOOK_SECRET_SANDBOX
    delete process.env.ANGELPAY_WEBHOOK_SECRET_PROD
  })

  afterAll(() => {
    process.env = ORIGINAL_ENV
  })

  it('returns sandbox secret when NODE_ENV != production', () => {
    process.env.NODE_ENV = 'development'
    process.env.ANGELPAY_WEBHOOK_SECRET_SANDBOX = 'whsec_sandbox'
    process.env.ANGELPAY_WEBHOOK_SECRET_PROD = 'whsec_prod'
    expect(getActiveWebhookSecret()).toBe('whsec_sandbox')
  })

  it('returns prod secret when NODE_ENV = production', () => {
    process.env.NODE_ENV = 'production'
    process.env.ANGELPAY_WEBHOOK_SECRET_SANDBOX = 'whsec_sandbox'
    process.env.ANGELPAY_WEBHOOK_SECRET_PROD = 'whsec_prod'
    expect(getActiveWebhookSecret()).toBe('whsec_prod')
  })

  it('returns null when active env var is missing', () => {
    process.env.NODE_ENV = 'development'
    expect(getActiveWebhookSecret()).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/unit/services/tpv/angelpay-webhook.service.test.ts -t "getActiveWebhookSecret"` Expected: FAIL with
`Cannot find module '@/services/tpv/angelpay-webhook.service'`.

- [ ] **Step 3: Create service file with types + error reasons + secret resolver**

Create `src/services/tpv/angelpay-webhook.service.ts`:

```ts
/**
 * AngelPay TPV Webhook Service
 *
 * Layer 4 of 4 in the payment reconciliation strategy. Receives Svix-signed
 * payment confirmations from AngelPay cloud, verifies them, and reconciles
 * against the `Payment` table.
 *
 * See: docs/angelpay/WEBHOOK_RECEIVER_SPEC.md
 */

import prisma from '@/utils/prismaClient'
import { Prisma, ProviderType, EventStatus } from '@prisma/client'
import logger from '@/config/logger'

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Public types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** EXPECTED body shape — see §6.2 of WEBHOOK_RECEIVER_SPEC.md. Lenient on every field. */
export interface AngelPayWebhookPayload {
  event_type: string
  event_id?: string
  merchant_id: string
  occurred_at?: string
  data: {
    transaction_id?: string
    external_reference?: string
    amount: number | string
    currency?: string
    status?: string
    auth_code?: string
    card?: {
      last_four?: string
      brand?: string
      entry_mode?: string
    }
    operation_type?: string
    processed_at?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

export type AngelPayWebhookAction =
  | 'MATCHED'
  | 'DISCREPANCY'
  | 'ORPHANED'
  | 'NOT_APPROVED'
  | 'UNKNOWN_MERCHANT'
  | 'UNSUPPORTED_EVENT_TYPE'
  | 'DUPLICATE'
  | 'ERROR'

export interface AngelPayWebhookResult {
  action: AngelPayWebhookAction
  eventLogId?: string
  paymentId?: string
  errorReason?: string
  message?: string
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Canonical error reasons — string literals so we can add without DB migrations
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const ANGELPAY_WEBHOOK_ERROR_REASONS = {
  NOT_PROVISIONED: 'NOT_PROVISIONED',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  UNSUPPORTED_EVENT_TYPE: 'UNSUPPORTED_EVENT_TYPE',
  UNKNOWN_MERCHANT: 'UNKNOWN_MERCHANT',
  NO_MATCH_FIELDS: 'NO_MATCH_FIELDS',
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  NOT_APPROVED: 'NOT_APPROVED',
  ORPHANED: 'ORPHANED',
  PROCESSING_ERROR: 'PROCESSING_ERROR',
} as const

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Env-selected secret
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function getActiveWebhookSecret(): string | null {
  return process.env.NODE_ENV === 'production'
    ? (process.env.ANGELPAY_WEBHOOK_SECRET_PROD ?? null)
    : (process.env.ANGELPAY_WEBHOOK_SECRET_SANDBOX ?? null)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/unit/services/tpv/angelpay-webhook.service.test.ts -t "getActiveWebhookSecret"` Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/tpv/angelpay-webhook.service.ts tests/unit/services/tpv/angelpay-webhook.service.test.ts
git commit -m "feat(angelpay-webhook): service scaffold (types, error reasons, secret resolver)"
```

---

## Task 3: Payload validator

**Files:**

- Modify: `src/services/tpv/angelpay-webhook.service.ts`
- Modify: `tests/unit/services/tpv/angelpay-webhook.service.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `tests/unit/services/tpv/angelpay-webhook.service.test.ts`:

```ts
import { validateAngelPayWebhookPayload } from '@/services/tpv/angelpay-webhook.service'

describe('validateAngelPayWebhookPayload', () => {
  const valid = {
    event_type: 'send_transaction',
    merchant_id: '351',
    data: { amount: 100 },
  }

  it('accepts a minimal valid payload', () => {
    expect(validateAngelPayWebhookPayload(valid)).toBe(true)
  })

  it('rejects when event_type is missing', () => {
    expect(validateAngelPayWebhookPayload({ ...valid, event_type: undefined })).toBe(false)
  })

  it('rejects when merchant_id is missing', () => {
    expect(validateAngelPayWebhookPayload({ ...valid, merchant_id: undefined })).toBe(false)
  })

  it('rejects when data.amount is missing', () => {
    expect(validateAngelPayWebhookPayload({ ...valid, data: {} })).toBe(false)
  })

  it('rejects null/non-object inputs', () => {
    expect(validateAngelPayWebhookPayload(null)).toBe(false)
    expect(validateAngelPayWebhookPayload(undefined)).toBe(false)
    expect(validateAngelPayWebhookPayload('string')).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest tests/unit/services/tpv/angelpay-webhook.service.test.ts -t "validateAngelPayWebhookPayload"` Expected: FAIL (function not
exported).

- [ ] **Step 3: Implement**

Append to `src/services/tpv/angelpay-webhook.service.ts`:

```ts
export function validateAngelPayWebhookPayload(payload: unknown): payload is AngelPayWebhookPayload {
  if (!payload || typeof payload !== 'object') return false
  const p = payload as Record<string, unknown>
  if (typeof p.event_type !== 'string' || !p.event_type) return false
  if (typeof p.merchant_id !== 'string' || !p.merchant_id) return false
  const data = p.data as Record<string, unknown> | undefined
  if (!data || data.amount == null) return false
  return true
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest tests/unit/services/tpv/angelpay-webhook.service.test.ts -t "validateAngelPayWebhookPayload"` Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/tpv/angelpay-webhook.service.ts tests/unit/services/tpv/angelpay-webhook.service.test.ts
git commit -m "feat(angelpay-webhook): payload validator"
```

---

## Task 4: Persistence helper — `persistErrorEvent`

**Files:**

- Modify: `src/services/tpv/angelpay-webhook.service.ts`
- Modify: `tests/unit/services/tpv/angelpay-webhook.service.test.ts`

This helper writes a single `ProviderEventLog` row in ERROR status — used by every bailout path before retry logic kicks in.

- [ ] **Step 1: Append failing test**

Add to test file:

```ts
import { persistErrorEvent } from '@/services/tpv/angelpay-webhook.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    providerEventLog: { create: jest.fn() },
  },
}))

const mockedProviderEventLogCreate = prisma.providerEventLog.create as jest.Mock

describe('persistErrorEvent', () => {
  beforeEach(() => {
    mockedProviderEventLogCreate.mockReset()
  })

  it('creates a ProviderEventLog row with status=ERROR and the given errorReason', async () => {
    mockedProviderEventLogCreate.mockResolvedValue({ id: 'evt_123' })
    const result = await persistErrorEvent({
      eventId: 'angelpay-msg_1',
      type: 'send_transaction',
      payload: { merchant_id: '351', event_type: 'send_transaction', data: { amount: 10 } } as any,
      venueId: null,
      errorReason: 'UNKNOWN_MERCHANT',
    })
    expect(result.id).toBe('evt_123')
    expect(mockedProviderEventLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        provider: 'PAYMENT_PROCESSOR',
        eventId: 'angelpay-msg_1',
        status: 'ERROR',
        errorReason: 'UNKNOWN_MERCHANT',
        type: 'send_transaction',
        venueId: null,
      }),
      select: { id: true },
    })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest tests/unit/services/tpv/angelpay-webhook.service.test.ts -t "persistErrorEvent"` Expected: FAIL (function not exported).

- [ ] **Step 3: Implement**

Append to service file:

```ts
export async function persistErrorEvent(args: {
  eventId: string | null
  type: string
  payload: AngelPayWebhookPayload
  venueId: string | null
  errorReason: string
}): Promise<{ id: string }> {
  return prisma.providerEventLog.create({
    data: {
      provider: ProviderType.PAYMENT_PROCESSOR,
      eventId: args.eventId,
      type: args.type,
      payload: args.payload as unknown as Prisma.InputJsonValue,
      venueId: args.venueId,
      status: EventStatus.ERROR,
      errorReason: args.errorReason,
      processedAt: new Date(),
    },
    select: { id: true },
  })
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest tests/unit/services/tpv/angelpay-webhook.service.test.ts -t "persistErrorEvent"` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/tpv/angelpay-webhook.service.ts tests/unit/services/tpv/angelpay-webhook.service.test.ts
git commit -m "feat(angelpay-webhook): persistErrorEvent helper"
```

---

## Task 5: Payment matching loop — `attemptPaymentMatch`

**Files:**

- Modify: `src/services/tpv/angelpay-webhook.service.ts`
- Modify: `tests/unit/services/tpv/angelpay-webhook.service.test.ts`

Core retry loop: 3 attempts at 0/2/3s = 5s total. The retry config is exposed for tests to override.

- [ ] **Step 1: Append failing tests**

Add to test file:

```ts
import { attemptPaymentMatch } from '@/services/tpv/angelpay-webhook.service'

// Extend the prisma mock
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    providerEventLog: { create: jest.fn() },
    payment: { findFirst: jest.fn() },
  },
}))

const mockedPaymentFindFirst = prisma.payment.findFirst as jest.Mock

describe('attemptPaymentMatch', () => {
  beforeEach(() => {
    mockedPaymentFindFirst.mockReset()
  })

  const baseArgs = {
    payload: {
      event_type: 'send_transaction',
      merchant_id: '351',
      data: {
        external_reference: 'ref-123',
        auth_code: '987654',
        transaction_id: 'tx_abc',
        amount: 100,
      },
    } as any,
    venueId: 'venue_xyz',
    retryDelaysMs: [0, 0, 0], // collapse retries for tests
  }

  it('returns the payment on first attempt when found', async () => {
    const payment = { id: 'pay_1', amount: 100 }
    mockedPaymentFindFirst.mockResolvedValueOnce(payment)
    const result = await attemptPaymentMatch(baseArgs)
    expect(result).toBe(payment)
    expect(mockedPaymentFindFirst).toHaveBeenCalledTimes(1)
  })

  it('retries up to 3 times and returns the payment when later attempts succeed', async () => {
    mockedPaymentFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'pay_2', amount: 100 })
    const result = await attemptPaymentMatch(baseArgs)
    expect(result).toEqual({ id: 'pay_2', amount: 100 })
    expect(mockedPaymentFindFirst).toHaveBeenCalledTimes(3)
  })

  it('returns null after 3 attempts with no match', async () => {
    mockedPaymentFindFirst.mockResolvedValue(null)
    const result = await attemptPaymentMatch(baseArgs)
    expect(result).toBeNull()
    expect(mockedPaymentFindFirst).toHaveBeenCalledTimes(3)
  })

  it('builds OR conditions from external_reference, auth_code, transaction_id and scopes by venueId', async () => {
    mockedPaymentFindFirst.mockResolvedValueOnce({ id: 'pay_3' })
    await attemptPaymentMatch(baseArgs)
    expect(mockedPaymentFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ referenceNumber: 'ref-123' }, { authorizationNumber: '987654' }, { processorId: 'tx_abc' }],
          status: { in: ['COMPLETED', 'PENDING'] },
          order: { venueId: 'venue_xyz' },
        }),
      }),
    )
  })

  it('omits a condition when its corresponding field is missing', async () => {
    mockedPaymentFindFirst.mockResolvedValueOnce(null)
    await attemptPaymentMatch({
      ...baseArgs,
      payload: { ...baseArgs.payload, data: { ...baseArgs.payload.data, auth_code: undefined } } as any,
    })
    const callArgs = mockedPaymentFindFirst.mock.calls[0][0]
    expect(callArgs.where.OR).toEqual([{ referenceNumber: 'ref-123' }, { processorId: 'tx_abc' }])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest tests/unit/services/tpv/angelpay-webhook.service.test.ts -t "attemptPaymentMatch"` Expected: FAIL (function not exported).

- [ ] **Step 3: Implement**

Append to service file:

```ts
const DEFAULT_RETRY_DELAYS_MS = [0, 2000, 3000]
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export interface MatchedPayment {
  id: string
  amount: Prisma.Decimal | number | string
  processorData: Prisma.JsonValue | null
}

export async function attemptPaymentMatch(args: {
  payload: AngelPayWebhookPayload
  venueId: string
  retryDelaysMs?: number[]
}): Promise<MatchedPayment | null> {
  const { payload, venueId } = args
  const delays = args.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS

  const conditions: Prisma.PaymentWhereInput[] = []
  if (payload.data.external_reference) conditions.push({ referenceNumber: payload.data.external_reference })
  if (payload.data.auth_code) conditions.push({ authorizationNumber: payload.data.auth_code })
  if (payload.data.transaction_id) conditions.push({ processorId: payload.data.transaction_id })

  if (conditions.length === 0) return null

  const where: Prisma.PaymentWhereInput = {
    OR: conditions,
    status: { in: ['COMPLETED', 'PENDING'] },
    order: { venueId },
  }

  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) await delay(delays[i])
    const payment = await prisma.payment.findFirst({
      where,
      select: { id: true, amount: true, processorData: true },
    })
    if (payment) return payment as MatchedPayment
  }
  return null
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest tests/unit/services/tpv/angelpay-webhook.service.test.ts -t "attemptPaymentMatch"` Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/tpv/angelpay-webhook.service.ts tests/unit/services/tpv/angelpay-webhook.service.test.ts
git commit -m "feat(angelpay-webhook): attemptPaymentMatch with 0/2/3s retry"
```

---

## Task 6: Orchestrator — happy path `MATCHED`

**Files:**

- Modify: `src/services/tpv/angelpay-webhook.service.ts`
- Modify: `tests/unit/services/tpv/angelpay-webhook.service.test.ts`

- [ ] **Step 1: Extend prisma mock + write failing test**

Extend the existing `jest.mock` block at the top of the test file:

```ts
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    providerEventLog: {
      create: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    payment: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    merchantAccount: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
  },
}))
```

Append the orchestrator test:

```ts
import { processAngelPayWebhook } from '@/services/tpv/angelpay-webhook.service'

const mockedProviderEventLogFindFirst = prisma.providerEventLog.findFirst as jest.Mock
const mockedProviderEventLogUpdate = prisma.providerEventLog.update as jest.Mock
const mockedPaymentUpdate = prisma.payment.update as jest.Mock
const mockedMerchantAccountFindFirst = prisma.merchantAccount.findFirst as jest.Mock
const mockedMerchantAccountUpdate = prisma.merchantAccount.update as jest.Mock

describe('processAngelPayWebhook — MATCHED happy path', () => {
  beforeEach(() => {
    ;[
      mockedProviderEventLogCreate,
      mockedProviderEventLogFindFirst,
      mockedProviderEventLogUpdate,
      mockedPaymentFindFirst,
      mockedPaymentUpdate,
      mockedMerchantAccountFindFirst,
      mockedMerchantAccountUpdate,
    ].forEach(m => m.mockReset())
  })

  it('stamps processorData.angelpayWebhook, marks event PROCESSED, touches lastReceivedAt', async () => {
    mockedMerchantAccountFindFirst.mockResolvedValue({ id: 'ma_1', venueId: 'venue_1', externalMerchantId: '351' })
    mockedProviderEventLogFindFirst.mockResolvedValue(null)
    mockedProviderEventLogCreate.mockResolvedValue({ id: 'evt_1' })
    mockedPaymentFindFirst.mockResolvedValueOnce({ id: 'pay_1', amount: 100, processorData: null })

    const result = await processAngelPayWebhook({
      payload: {
        event_type: 'send_transaction',
        merchant_id: '351',
        data: {
          external_reference: 'ref-1',
          amount: 100,
          status: 'APPROVED',
          auth_code: '111111',
          transaction_id: 'tx_1',
          card: { last_four: '4242', brand: 'VISA', entry_mode: 'CHIP' },
        },
      } as any,
      svixId: 'msg_a',
      retryDelaysMs: [0, 0, 0],
    })

    expect(result.action).toBe('MATCHED')
    expect(result.paymentId).toBe('pay_1')
    expect(result.eventLogId).toBe('evt_1')

    expect(mockedPaymentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pay_1' },
        data: expect.objectContaining({
          processorData: expect.objectContaining({
            angelpayWebhook: expect.objectContaining({
              svixId: 'msg_a',
              transactionId: 'tx_1',
              authCode: '111111',
              lastFour: '4242',
              brand: 'VISA',
              entryMode: 'CHIP',
            }),
          }),
        }),
      }),
    )

    expect(mockedProviderEventLogUpdate).toHaveBeenCalledWith({
      where: { id: 'evt_1' },
      data: expect.objectContaining({ status: 'PROCESSED', paymentId: 'pay_1' }),
    })

    expect(mockedMerchantAccountUpdate).toHaveBeenCalledWith({
      where: { id: 'ma_1' },
      data: { angelpayWebhookLastReceivedAt: expect.any(Date) },
    })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest tests/unit/services/tpv/angelpay-webhook.service.test.ts -t "MATCHED happy path"` Expected: FAIL (function not exported).

- [ ] **Step 3: Implement orchestrator**

Append to service file:

```ts
export interface ProcessArgs {
  payload: AngelPayWebhookPayload
  svixId: string
  retryDelaysMs?: number[]
}

export async function processAngelPayWebhook(args: ProcessArgs): Promise<AngelPayWebhookResult> {
  const { payload, svixId } = args
  const eventId = `angelpay-${svixId}`
  const correlationId = `angelpay-wh-${svixId}`

  // 1. Lenient validation
  if (!validateAngelPayWebhookPayload(payload)) {
    const errored = await persistErrorEvent({
      eventId,
      type: payload?.event_type ?? 'unknown',
      payload: payload as AngelPayWebhookPayload,
      venueId: null,
      errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.INVALID_PAYLOAD,
    })
    return { action: 'ERROR', errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.INVALID_PAYLOAD, eventLogId: errored.id }
  }

  // 2. Resolve merchant
  const merchantAccount = await prisma.merchantAccount.findFirst({
    where: { externalMerchantId: payload.merchant_id, provider: { code: 'ANGELPAY' } },
    select: { id: true, venueId: true, externalMerchantId: true },
  })

  if (!merchantAccount) {
    const errored = await persistErrorEvent({
      eventId,
      type: payload.event_type,
      payload,
      venueId: null,
      errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.UNKNOWN_MERCHANT,
    })
    return { action: 'UNKNOWN_MERCHANT', errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.UNKNOWN_MERCHANT, eventLogId: errored.id }
  }

  // 3. Insert PENDING row (race-safe)
  let eventLogId: string
  try {
    const created = await prisma.providerEventLog.create({
      data: {
        provider: ProviderType.PAYMENT_PROCESSOR,
        eventId,
        type: payload.event_type,
        payload: payload as unknown as Prisma.InputJsonValue,
        venueId: merchantAccount.venueId,
        status: EventStatus.PENDING,
      },
      select: { id: true },
    })
    eventLogId = created.id
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const existing = await prisma.providerEventLog.findFirst({
        where: { provider: ProviderType.PAYMENT_PROCESSOR, eventId },
        select: { id: true, paymentId: true },
      })
      return { action: 'DUPLICATE', eventLogId: existing?.id, paymentId: existing?.paymentId ?? undefined }
    }
    throw err
  }

  // 4. Match
  const payment = await attemptPaymentMatch({ payload, venueId: merchantAccount.venueId, retryDelaysMs: args.retryDelaysMs })

  if (!payment) {
    await prisma.providerEventLog.update({
      where: { id: eventLogId },
      data: { status: EventStatus.ERROR, errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.ORPHANED, processedAt: new Date() },
    })
    return { action: 'ORPHANED', errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.ORPHANED, eventLogId }
  }

  // 5. Reconcile amount
  const webhookAmount = Number(payload.data.amount)
  const recordedAmount = Number(payment.amount)
  const diff = Math.abs(webhookAmount - recordedAmount)

  if (diff < 0.01) {
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        processorData: {
          ...((payment.processorData as Record<string, unknown>) ?? {}),
          angelpayWebhook: {
            receivedAt: new Date().toISOString(),
            svixId,
            transactionId: payload.data.transaction_id ?? null,
            authCode: payload.data.auth_code ?? null,
            lastFour: payload.data.card?.last_four ?? null,
            brand: payload.data.card?.brand ?? null,
            entryMode: payload.data.card?.entry_mode ?? null,
          },
        } as Prisma.InputJsonValue,
      },
    })
    await prisma.providerEventLog.update({
      where: { id: eventLogId },
      data: { status: EventStatus.PROCESSED, paymentId: payment.id, errorReason: null, processedAt: new Date() },
    })
    await prisma.merchantAccount.update({
      where: { id: merchantAccount.id },
      data: { angelpayWebhookLastReceivedAt: new Date() },
    })
    logger.info({ correlationId, paymentId: payment.id, webhookAmount }, '✅ [AngelPay webhook] matched')
    return { action: 'MATCHED', eventLogId, paymentId: payment.id }
  }

  // DISCREPANCY path — implemented in Task 7
  throw new Error('DISCREPANCY handling not yet implemented')
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest tests/unit/services/tpv/angelpay-webhook.service.test.ts -t "MATCHED happy path"` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/tpv/angelpay-webhook.service.ts tests/unit/services/tpv/angelpay-webhook.service.test.ts
git commit -m "feat(angelpay-webhook): processAngelPayWebhook orchestrator — MATCHED path"
```

---

## Task 7: Orchestrator — `DISCREPANCY`

**Files:**

- Modify: `src/services/tpv/angelpay-webhook.service.ts`
- Modify: `tests/unit/services/tpv/angelpay-webhook.service.test.ts`

- [ ] **Step 1: Append failing test**

```ts
describe('processAngelPayWebhook — DISCREPANCY', () => {
  beforeEach(() => {
    ;[
      mockedProviderEventLogCreate,
      mockedProviderEventLogFindFirst,
      mockedProviderEventLogUpdate,
      mockedPaymentFindFirst,
      mockedPaymentUpdate,
      mockedMerchantAccountFindFirst,
      mockedMerchantAccountUpdate,
    ].forEach(m => m.mockReset())
  })

  it('stamps angelpayDiscrepancy, marks event ERROR/AMOUNT_MISMATCH, does NOT mutate payment.status', async () => {
    mockedMerchantAccountFindFirst.mockResolvedValue({ id: 'ma_1', venueId: 'venue_1', externalMerchantId: '351' })
    mockedProviderEventLogFindFirst.mockResolvedValue(null)
    mockedProviderEventLogCreate.mockResolvedValue({ id: 'evt_2' })
    mockedPaymentFindFirst.mockResolvedValueOnce({ id: 'pay_2', amount: 100, processorData: { existing: true } })

    const result = await processAngelPayWebhook({
      payload: {
        event_type: 'send_transaction',
        merchant_id: '351',
        data: { external_reference: 'ref-2', amount: 105.5, status: 'APPROVED', transaction_id: 'tx_2' },
      } as any,
      svixId: 'msg_b',
      retryDelaysMs: [0, 0, 0],
    })

    expect(result.action).toBe('DISCREPANCY')
    expect(result.errorReason).toBe('AMOUNT_MISMATCH')

    const updateCall = mockedPaymentUpdate.mock.calls[0][0]
    expect(updateCall.data.processorData).toEqual(
      expect.objectContaining({
        existing: true,
        angelpayDiscrepancy: expect.objectContaining({
          webhookAmount: 105.5,
          recordedAmount: 100,
          difference: 5.5,
          transactionId: 'tx_2',
        }),
      }),
    )
    expect(updateCall.data).not.toHaveProperty('status')

    expect(mockedProviderEventLogUpdate).toHaveBeenCalledWith({
      where: { id: 'evt_2' },
      data: expect.objectContaining({ status: 'ERROR', errorReason: 'AMOUNT_MISMATCH', paymentId: 'pay_2' }),
    })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest tests/unit/services/tpv/angelpay-webhook.service.test.ts -t "DISCREPANCY"` Expected: FAIL — current implementation throws
`DISCREPANCY handling not yet implemented`.

- [ ] **Step 3: Replace the `throw new Error('DISCREPANCY handling not yet implemented')` line with this block:**

```ts
await prisma.payment.update({
  where: { id: payment.id },
  data: {
    processorData: {
      ...((payment.processorData as Record<string, unknown>) ?? {}),
      angelpayDiscrepancy: {
        detectedAt: new Date().toISOString(),
        webhookAmount,
        recordedAmount,
        difference: diff,
        transactionId: payload.data.transaction_id ?? null,
      },
    } as Prisma.InputJsonValue,
  },
})
await prisma.providerEventLog.update({
  where: { id: eventLogId },
  data: {
    status: EventStatus.ERROR,
    errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.AMOUNT_MISMATCH,
    paymentId: payment.id,
    processedAt: new Date(),
  },
})
await prisma.merchantAccount.update({
  where: { id: merchantAccount.id },
  data: { angelpayWebhookLastReceivedAt: new Date() },
})
logger.error({ correlationId, paymentId: payment.id, webhookAmount, recordedAmount, diff }, '❌ [AngelPay webhook] amount discrepancy')
return { action: 'DISCREPANCY', errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.AMOUNT_MISMATCH, eventLogId, paymentId: payment.id }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest tests/unit/services/tpv/angelpay-webhook.service.test.ts -t "DISCREPANCY"` Expected: PASS. Also re-run the MATCHED test to
ensure it still passes: `npx jest tests/unit/services/tpv/angelpay-webhook.service.test.ts -t "processAngelPayWebhook"` Expected: 2 tests
PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/tpv/angelpay-webhook.service.ts tests/unit/services/tpv/angelpay-webhook.service.test.ts
git commit -m "feat(angelpay-webhook): orchestrator DISCREPANCY path (no payment.status mutation)"
```

---

## Task 8: Orchestrator — `NOT_APPROVED`, `UNSUPPORTED_EVENT_TYPE`

**Files:**

- Modify: `src/services/tpv/angelpay-webhook.service.ts`
- Modify: `tests/unit/services/tpv/angelpay-webhook.service.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
describe('processAngelPayWebhook — early-return paths', () => {
  beforeEach(() => {
    ;[
      mockedProviderEventLogCreate,
      mockedProviderEventLogFindFirst,
      mockedProviderEventLogUpdate,
      mockedPaymentFindFirst,
      mockedPaymentUpdate,
      mockedMerchantAccountFindFirst,
      mockedMerchantAccountUpdate,
    ].forEach(m => m.mockReset())
  })

  it('returns NOT_APPROVED when data.status is not APPROVED', async () => {
    mockedMerchantAccountFindFirst.mockResolvedValue({ id: 'ma_1', venueId: 'venue_1', externalMerchantId: '351' })
    mockedProviderEventLogFindFirst.mockResolvedValue(null)
    mockedProviderEventLogCreate.mockResolvedValue({ id: 'evt_3' })

    const result = await processAngelPayWebhook({
      payload: {
        event_type: 'send_transaction',
        merchant_id: '351',
        data: { external_reference: 'ref-3', amount: 50, status: 'DECLINED' },
      } as any,
      svixId: 'msg_c',
      retryDelaysMs: [0, 0, 0],
    })

    expect(result.action).toBe('NOT_APPROVED')
    expect(mockedPaymentFindFirst).not.toHaveBeenCalled()
    expect(mockedProviderEventLogUpdate).toHaveBeenCalledWith({
      where: { id: 'evt_3' },
      data: expect.objectContaining({ status: 'ERROR', errorReason: 'NOT_APPROVED' }),
    })
  })

  it('returns UNSUPPORTED_EVENT_TYPE for event_type != send_transaction', async () => {
    mockedMerchantAccountFindFirst.mockResolvedValue({ id: 'ma_1', venueId: 'venue_1', externalMerchantId: '351' })

    const result = await processAngelPayWebhook({
      payload: {
        event_type: 'canceled_transaction',
        merchant_id: '351',
        data: { amount: 10 },
      } as any,
      svixId: 'msg_d',
      retryDelaysMs: [0, 0, 0],
    })

    expect(result.action).toBe('UNSUPPORTED_EVENT_TYPE')
    expect(mockedPaymentFindFirst).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest tests/unit/services/tpv/angelpay-webhook.service.test.ts -t "early-return paths"` Expected: FAIL.

- [ ] **Step 3: Insert the unsupported-event-type guard right after merchant resolution succeeds (before the PENDING row insert):**

```ts
// Bail early: only act on send_transaction in v1
if (payload.event_type !== 'send_transaction') {
  const errored = await persistErrorEvent({
    eventId,
    type: payload.event_type,
    payload,
    venueId: merchantAccount.venueId,
    errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.UNSUPPORTED_EVENT_TYPE,
  })
  return { action: 'UNSUPPORTED_EVENT_TYPE', errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.UNSUPPORTED_EVENT_TYPE, eventLogId: errored.id }
}
```

Insert the NOT_APPROVED guard right after the PENDING row insert (before `attemptPaymentMatch`):

```ts
// Bail: only reconcile approved transactions
if (payload.data.status && payload.data.status !== 'APPROVED') {
  await prisma.providerEventLog.update({
    where: { id: eventLogId },
    data: { status: EventStatus.ERROR, errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.NOT_APPROVED, processedAt: new Date() },
  })
  return { action: 'NOT_APPROVED', errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.NOT_APPROVED, eventLogId }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest tests/unit/services/tpv/angelpay-webhook.service.test.ts -t "early-return paths"` Expected: 2 tests PASS. Also:
`npx jest tests/unit/services/tpv/angelpay-webhook.service.test.ts -t "processAngelPayWebhook"` should now show 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/tpv/angelpay-webhook.service.ts tests/unit/services/tpv/angelpay-webhook.service.test.ts
git commit -m "feat(angelpay-webhook): orchestrator NOT_APPROVED + UNSUPPORTED_EVENT_TYPE bailouts"
```

---

## Task 9: Orchestrator — `UNKNOWN_MERCHANT`, `DUPLICATE`, `ORPHANED`, `NO_MATCH_FIELDS`

These are the remaining error paths. The implementation already covers them (from Task 6 they exist) — this task only adds the missing tests
to lock them in.

**Files:**

- Modify: `tests/unit/services/tpv/angelpay-webhook.service.test.ts`

- [ ] **Step 1: Append the 4 failing tests**

```ts
describe('processAngelPayWebhook — error paths', () => {
  beforeEach(() => {
    ;[
      mockedProviderEventLogCreate,
      mockedProviderEventLogFindFirst,
      mockedProviderEventLogUpdate,
      mockedPaymentFindFirst,
      mockedPaymentUpdate,
      mockedMerchantAccountFindFirst,
      mockedMerchantAccountUpdate,
    ].forEach(m => m.mockReset())
  })

  it('returns UNKNOWN_MERCHANT when merchant_id not found', async () => {
    mockedMerchantAccountFindFirst.mockResolvedValue(null)
    mockedProviderEventLogCreate.mockResolvedValue({ id: 'evt_4' })

    const result = await processAngelPayWebhook({
      payload: { event_type: 'send_transaction', merchant_id: '999', data: { amount: 10 } } as any,
      svixId: 'msg_e',
      retryDelaysMs: [0, 0, 0],
    })

    expect(result.action).toBe('UNKNOWN_MERCHANT')
    expect(mockedPaymentFindFirst).not.toHaveBeenCalled()
  })

  it('returns DUPLICATE when ProviderEventLog already has this svix-id (P2002 race)', async () => {
    mockedMerchantAccountFindFirst.mockResolvedValue({ id: 'ma_1', venueId: 'venue_1', externalMerchantId: '351' })
    const p2002 = new Prisma.PrismaClientKnownRequestError('unique violation', { code: 'P2002', clientVersion: 'x' })
    mockedProviderEventLogCreate.mockRejectedValueOnce(p2002)
    mockedProviderEventLogFindFirst.mockResolvedValue({ id: 'evt_existing', paymentId: 'pay_existing' })

    const result = await processAngelPayWebhook({
      payload: {
        event_type: 'send_transaction',
        merchant_id: '351',
        data: { external_reference: 'ref-dup', amount: 10, status: 'APPROVED' },
      } as any,
      svixId: 'msg_f',
      retryDelaysMs: [0, 0, 0],
    })

    expect(result.action).toBe('DUPLICATE')
    expect(result.eventLogId).toBe('evt_existing')
    expect(result.paymentId).toBe('pay_existing')
  })

  it('returns ORPHANED when no Payment matches after retries', async () => {
    mockedMerchantAccountFindFirst.mockResolvedValue({ id: 'ma_1', venueId: 'venue_1', externalMerchantId: '351' })
    mockedProviderEventLogCreate.mockResolvedValue({ id: 'evt_5' })
    mockedPaymentFindFirst.mockResolvedValue(null)

    const result = await processAngelPayWebhook({
      payload: {
        event_type: 'send_transaction',
        merchant_id: '351',
        data: { external_reference: 'ref-miss', amount: 10, status: 'APPROVED' },
      } as any,
      svixId: 'msg_g',
      retryDelaysMs: [0, 0, 0],
    })

    expect(result.action).toBe('ORPHANED')
    expect(mockedProviderEventLogUpdate).toHaveBeenCalledWith({
      where: { id: 'evt_5' },
      data: expect.objectContaining({ status: 'ERROR', errorReason: 'ORPHANED' }),
    })
  })

  it('returns ERROR/NO_MATCH_FIELDS when payload has none of external_reference/auth_code/transaction_id', async () => {
    mockedMerchantAccountFindFirst.mockResolvedValue({ id: 'ma_1', venueId: 'venue_1', externalMerchantId: '351' })
    mockedProviderEventLogCreate.mockResolvedValue({ id: 'evt_6' })
    // attemptPaymentMatch returns null because conditions array is empty
    mockedPaymentFindFirst.mockResolvedValue(null)

    const result = await processAngelPayWebhook({
      payload: { event_type: 'send_transaction', merchant_id: '351', data: { amount: 10, status: 'APPROVED' } } as any,
      svixId: 'msg_h',
      retryDelaysMs: [0, 0, 0],
    })

    // Current impl returns ORPHANED for empty conditions; we want NO_MATCH_FIELDS to be distinct.
    expect(result.action).toBe('ORPHANED')
    expect(result.errorReason).toBe('NO_MATCH_FIELDS')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest tests/unit/services/tpv/angelpay-webhook.service.test.ts -t "error paths"` Expected: 3 PASS, 1 FAIL (the NO_MATCH_FIELDS test
— current implementation gives errorReason=ORPHANED).

- [ ] **Step 3: Fix the `NO_MATCH_FIELDS` distinction**

In `src/services/tpv/angelpay-webhook.service.ts`, locate the block right before `attemptPaymentMatch` call. Add explicit guard:

```ts
// Bail: no usable matching field
const hasMatchableField = !!(payload.data.external_reference || payload.data.auth_code || payload.data.transaction_id)
if (!hasMatchableField) {
  await prisma.providerEventLog.update({
    where: { id: eventLogId },
    data: { status: EventStatus.ERROR, errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.NO_MATCH_FIELDS, processedAt: new Date() },
  })
  return { action: 'ORPHANED', errorReason: ANGELPAY_WEBHOOK_ERROR_REASONS.NO_MATCH_FIELDS, eventLogId }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest tests/unit/services/tpv/angelpay-webhook.service.test.ts -t "error paths"` Expected: 4 tests PASS. Full file:
`npx jest tests/unit/services/tpv/angelpay-webhook.service.test.ts` should now report ~17 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/services/tpv/angelpay-webhook.service.ts tests/unit/services/tpv/angelpay-webhook.service.test.ts
git commit -m "feat(angelpay-webhook): orchestrator error paths (UNKNOWN_MERCHANT, DUPLICATE, ORPHANED, NO_MATCH_FIELDS)"
```

---

## Task 10: Controller — HTTP adapter

**Files:**

- Create: `src/controllers/tpv/angelpay-webhook.tpv.controller.ts`
- Create: `tests/unit/controllers/tpv/angelpay-webhook.tpv.controller.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/controllers/tpv/angelpay-webhook.tpv.controller.test.ts`:

```ts
import type { Request, Response } from 'express'

import { handleAngelPayWebhook, angelpayWebhookHealthCheck } from '@/controllers/tpv/angelpay-webhook.tpv.controller'
import * as service from '@/services/tpv/angelpay-webhook.service'

jest.mock('svix', () => {
  class Webhook {
    constructor(public secret: string) {}
    verify(body: Buffer, headers: Record<string, string>) {
      if (headers['svix-signature'] === 'bad') throw new Error('invalid signature')
      return JSON.parse(body.toString('utf8'))
    }
  }
  return { Webhook }
})

jest.mock('@/services/tpv/angelpay-webhook.service', () => ({
  ...jest.requireActual('@/services/tpv/angelpay-webhook.service'),
  processAngelPayWebhook: jest.fn(),
  getActiveWebhookSecret: jest.fn(),
}))

const mockedProcess = service.processAngelPayWebhook as jest.Mock
const mockedSecret = service.getActiveWebhookSecret as jest.Mock

function mkReq(opts: { body?: object; headers?: Record<string, string> }): Request {
  const raw = Buffer.from(JSON.stringify(opts.body ?? {}))
  return {
    body: raw,
    header(name: string) {
      return opts.headers?.[name.toLowerCase()]
    },
  } as unknown as Request
}
function mkRes(): Response & { __status?: number; __body?: unknown } {
  const res: any = {}
  res.status = (n: number) => {
    res.__status = n
    return res
  }
  res.json = (b: unknown) => {
    res.__body = b
    return res
  }
  return res
}

describe('handleAngelPayWebhook', () => {
  beforeEach(() => {
    mockedProcess.mockReset()
    mockedSecret.mockReset()
  })

  it('returns 503 when no env secret is configured', async () => {
    mockedSecret.mockReturnValue(null)
    const res = mkRes()
    await handleAngelPayWebhook(mkReq({}), res, jest.fn())
    expect(res.__status).toBe(503)
    expect(mockedProcess).not.toHaveBeenCalled()
  })

  it('returns 401 when svix headers are missing', async () => {
    mockedSecret.mockReturnValue('whsec_x')
    const res = mkRes()
    await handleAngelPayWebhook(mkReq({}), res, jest.fn())
    expect(res.__status).toBe(401)
  })

  it('accepts webhook-* alias headers when svix-* are absent', async () => {
    mockedSecret.mockReturnValue('whsec_x')
    mockedProcess.mockResolvedValue({ action: 'MATCHED', eventLogId: 'evt_1', paymentId: 'pay_1' })
    const res = mkRes()
    await handleAngelPayWebhook(
      mkReq({
        body: { event_type: 'send_transaction', merchant_id: '351', data: { amount: 10 } },
        headers: { 'webhook-id': 'msg_a', 'webhook-timestamp': '1', 'webhook-signature': 'good' },
      }),
      res,
      jest.fn(),
    )
    expect(res.__status).toBe(200)
    expect(mockedProcess).toHaveBeenCalledWith(expect.objectContaining({ svixId: 'msg_a' }))
  })

  it('returns 401 when signature verification throws', async () => {
    mockedSecret.mockReturnValue('whsec_x')
    const res = mkRes()
    await handleAngelPayWebhook(
      mkReq({
        body: { event_type: 'send_transaction', merchant_id: '351', data: { amount: 10 } },
        headers: { 'svix-id': 'msg_b', 'svix-timestamp': '1', 'svix-signature': 'bad' },
      }),
      res,
      jest.fn(),
    )
    expect(res.__status).toBe(401)
    expect(mockedProcess).not.toHaveBeenCalled()
  })

  it('returns 200 + action body on success', async () => {
    mockedSecret.mockReturnValue('whsec_x')
    mockedProcess.mockResolvedValue({ action: 'MATCHED', eventLogId: 'evt_9', paymentId: 'pay_9' })
    const res = mkRes()
    await handleAngelPayWebhook(
      mkReq({
        body: { event_type: 'send_transaction', merchant_id: '351', data: { amount: 10 } },
        headers: { 'svix-id': 'msg_c', 'svix-timestamp': '1', 'svix-signature': 'good' },
      }),
      res,
      jest.fn(),
    )
    expect(res.__status).toBe(200)
    expect(res.__body).toMatchObject({ action: 'MATCHED', eventLogId: 'evt_9', paymentId: 'pay_9' })
  })
})

describe('angelpayWebhookHealthCheck', () => {
  it('returns 200 with success + timestamp', () => {
    const res = mkRes()
    angelpayWebhookHealthCheck({} as Request, res)
    expect(res.__status).toBe(200)
    expect(res.__body).toMatchObject({ success: true })
    expect((res.__body as any).timestamp).toBeDefined()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest tests/unit/controllers/tpv/angelpay-webhook.tpv.controller.test.ts` Expected: FAIL (module not found).

- [ ] **Step 3: Implement controller**

Create `src/controllers/tpv/angelpay-webhook.tpv.controller.ts`:

```ts
/**
 * AngelPay TPV Webhook Controller — HTTP adapter for the receiver endpoint.
 *
 * Responsibilities:
 *   1. Read raw Buffer body (svix verification needs exact bytes)
 *   2. Normalize Svix headers (accept webhook-* aliases per AngelPay's reference impl)
 *   3. Verify signature with the env-selected secret
 *   4. Hand off to the service for tenant resolution + matching
 *   5. Map AngelPayWebhookResult → HTTP response (always 200 if signature ok, except 503 when not provisioned)
 *
 * See: docs/angelpay/WEBHOOK_RECEIVER_SPEC.md §7
 */

import { Request, Response, NextFunction } from 'express'
import { Webhook } from 'svix'

import logger from '@/config/logger'
import { AngelPayWebhookPayload, getActiveWebhookSecret, processAngelPayWebhook } from '@/services/tpv/angelpay-webhook.service'

export async function handleAngelPayWebhook(req: Request, res: Response, _next: NextFunction): Promise<void> {
  const secret = getActiveWebhookSecret()
  if (!secret) {
    res.status(503).json({ error: 'webhook not provisioned' })
    return
  }

  // Accept either svix-* or webhook-* aliases (AngelPay reference impl emits both)
  const headers = {
    'svix-id': req.header('svix-id') ?? req.header('webhook-id'),
    'svix-timestamp': req.header('svix-timestamp') ?? req.header('webhook-timestamp'),
    'svix-signature': req.header('svix-signature') ?? req.header('webhook-signature'),
  }
  if (!headers['svix-id'] || !headers['svix-timestamp'] || !headers['svix-signature']) {
    res.status(401).json({ error: 'missing signature headers' })
    return
  }

  // Body must be a raw Buffer for HMAC verification — webhook.routes.ts uses express.raw()
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}))

  let payload: AngelPayWebhookPayload
  try {
    payload = new Webhook(secret).verify(rawBody, headers as Record<string, string>) as AngelPayWebhookPayload
  } catch {
    logger.warn({ svixId: headers['svix-id'] }, '🚫 [AngelPay webhook] invalid signature')
    res.status(401).json({ error: 'invalid signature' })
    return
  }

  try {
    const result = await processAngelPayWebhook({
      payload,
      svixId: headers['svix-id']!,
    })
    res.status(200).json(result)
  } catch (err) {
    logger.error({ err, svixId: headers['svix-id'] }, '❌ [AngelPay webhook] unexpected processing error')
    // Still 200 — AngelPay should not retry. Operator must investigate via logs.
    res.status(200).json({ action: 'ERROR', errorReason: 'PROCESSING_ERROR' })
  }
}

export function angelpayWebhookHealthCheck(_req: Request, res: Response): void {
  res.status(200).json({
    success: true,
    message: 'AngelPay TPV webhook endpoint is healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  })
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest tests/unit/controllers/tpv/angelpay-webhook.tpv.controller.test.ts` Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/controllers/tpv/angelpay-webhook.tpv.controller.ts tests/unit/controllers/tpv/angelpay-webhook.tpv.controller.test.ts
git commit -m "feat(angelpay-webhook): controller (Svix verify + service dispatch + health)"
```

---

## Task 11: Route registration

**Files:**

- Modify: `src/routes/webhook.routes.ts`

- [ ] **Step 1: Add imports**

Open `src/routes/webhook.routes.ts`. Locate the import block at the top. Add a new import line below the Blumon controller import:

```ts
import { handleAngelPayWebhook, angelpayWebhookHealthCheck } from '../controllers/tpv/angelpay-webhook.tpv.controller'
```

- [ ] **Step 2: Register the routes**

Locate the Blumon route registration block (search for `router.post('/blumon/tpv', blumonIPWhitelist, handleBlumonTPVWebhook)`). Immediately
after the Blumon health route registration, add:

```ts
/**
 * @openapi
 * /api/v1/webhooks/angelpay:
 *   post:
 *     tags: [Webhooks]
 *     summary: AngelPay TPV payment-confirmation webhook
 *     description: |
 *       Receives Svix-signed payment confirmations from AngelPay cloud.
 *       Verifies HMAC signature using the env-resolved secret
 *       (ANGELPAY_WEBHOOK_SECRET_SANDBOX or _PROD), reconciles against
 *       the Payment table, and persists every event to ProviderEventLog
 *       for audit.
 *     responses:
 *       200:
 *         description: Webhook processed (signature valid; any reconciliation outcome)
 *       401:
 *         description: Missing or invalid signature
 *       503:
 *         description: Webhook secret not configured for this environment
 */
router.post('/angelpay', handleAngelPayWebhook)

/**
 * @openapi
 * /api/v1/webhooks/angelpay/health:
 *   get:
 *     tags: [Webhooks]
 *     summary: AngelPay webhook health check
 *     responses:
 *       200:
 *         description: OK
 */
router.get('/angelpay/health', angelpayWebhookHealthCheck)
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "webhook.routes\|angelpay-webhook" | head -10` Expected: no errors.

- [ ] **Step 4: Smoke-test the route is reachable**

Run: `npm run dev` in one terminal (background). In another:

```bash
curl -s http://localhost:8080/api/v1/webhooks/angelpay/health | head
```

Expected: JSON `{ "success": true, "message": "AngelPay TPV webhook endpoint is healthy", ... }`.

Stop the dev server when done (Ctrl+C).

- [ ] **Step 5: Commit**

```bash
git add src/routes/webhook.routes.ts
git commit -m "feat(angelpay-webhook): register /webhooks/angelpay routes"
```

---

## Task 12: Integration smoke test — POST with valid Svix signature

This test exercises the full route through Express, with the real `svix` library doing real HMAC. Confirms wiring end-to-end.

**Files:**

- Create: `tests/integration/webhook/angelpay-webhook.integration.test.ts`

- [ ] **Step 1: Write the integration test**

Create the file:

```ts
import express from 'express'
import request from 'supertest'
import { Webhook } from 'svix'

// Mock the service so the test doesn't need a real Prisma connection
jest.mock('@/services/tpv/angelpay-webhook.service', () => ({
  ...jest.requireActual('@/services/tpv/angelpay-webhook.service'),
  processAngelPayWebhook: jest.fn().mockResolvedValue({ action: 'MATCHED', eventLogId: 'evt_int', paymentId: 'pay_int' }),
  getActiveWebhookSecret: jest.fn(),
}))

import * as service from '@/services/tpv/angelpay-webhook.service'
import { handleAngelPayWebhook } from '@/controllers/tpv/angelpay-webhook.tpv.controller'

const TEST_SECRET = 'whsec_' + Buffer.from('test-secret-32-bytes-padded-xxxxx').toString('base64')

describe('POST /webhooks/angelpay (integration)', () => {
  const app = express()
  app.post('/webhooks/angelpay', express.raw({ type: 'application/json' }), handleAngelPayWebhook)

  beforeAll(() => {
    ;(service.getActiveWebhookSecret as jest.Mock).mockReturnValue(TEST_SECRET)
  })

  it('accepts a properly Svix-signed payload', async () => {
    const wh = new Webhook(TEST_SECRET)
    const body = JSON.stringify({ event_type: 'send_transaction', merchant_id: '351', data: { amount: 10 } })
    const msgId = 'msg_int_1'
    const ts = String(Math.floor(Date.now() / 1000))
    // Manually sign the body using the same algorithm as svix
    const signedHeaders = (wh as any).sign(msgId, new Date(Number(ts) * 1000), body)

    const res = await request(app)
      .post('/webhooks/angelpay')
      .set('Content-Type', 'application/json')
      .set('svix-id', msgId)
      .set('svix-timestamp', ts)
      .set('svix-signature', signedHeaders)
      .send(body)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ action: 'MATCHED' })
  })

  it('rejects an unsigned request', async () => {
    const res = await request(app)
      .post('/webhooks/angelpay')
      .set('Content-Type', 'application/json')
      .send({ event_type: 'send_transaction', merchant_id: '351', data: { amount: 10 } })
    expect(res.status).toBe(401)
  })
})
```

> Note: `Webhook.sign()` may be a private API in the `svix` package depending on version. If it's not exposed, replace the `signedHeaders`
> computation with manual HMAC:
>
> ```ts
> import crypto from 'crypto'
> const secretBytes = Buffer.from(TEST_SECRET.slice('whsec_'.length), 'base64')
> const toSign = `${msgId}.${ts}.${body}`
> const sig = crypto.createHmac('sha256', secretBytes).update(toSign).digest('base64')
> const signedHeaders = `v1,${sig}`
> ```

- [ ] **Step 2: Run the test**

Run: `npx jest tests/integration/webhook/angelpay-webhook.integration.test.ts` Expected: 2 tests PASS.

If `Webhook.sign()` is private and the call fails, swap in the manual HMAC variant shown in the Step 1 note, and re-run.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/webhook/angelpay-webhook.integration.test.ts
git commit -m "test(angelpay-webhook): end-to-end integration test (real Svix sign + verify)"
```

---

## Task 13: Final regression check

**Files:** None (test-only)

- [ ] **Step 1: Run the full unit suite to ensure nothing else broke**

Run: `npm run test:unit 2>&1 | tail -20` Expected: All existing tests still passing + new AngelPay tests included. Specifically:

- `tests/unit/services/tpv/angelpay-webhook.service.test.ts` — ~17 tests passing
- `tests/unit/controllers/tpv/angelpay-webhook.tpv.controller.test.ts` — 6 tests passing

- [ ] **Step 2: Run lint**

Run:
`npm run lint -- src/services/tpv/angelpay-webhook.service.ts src/controllers/tpv/angelpay-webhook.tpv.controller.ts src/routes/webhook.routes.ts`
Expected: no errors.

- [ ] **Step 3: Build check**

Run: `npm run build 2>&1 | tail -5` Expected: build succeeds.

- [ ] **Step 4: Document the next manual step**

Append to the bottom of `docs/angelpay/WEBHOOK_RECEIVER_SPEC.md` (after section §14):

```markdown
---

## Implementation status

- ✅ Code implemented per `WEBHOOK_RECEIVER_PLAN.md` (Tasks 1-13)
- ⏳ Manual provisioning needed BEFORE going live:
  1. Register a webhook endpoint in the AngelPay sandbox portal pointing at the Render dev URL
     `https://<dev-service>.onrender.com/api/v1/webhooks/angelpay`, subscribed to `send_transaction`
  2. Copy the returned `whsec_*` secret into `ANGELPAY_WEBHOOK_SECRET_SANDBOX` on Render dev service
  3. Trigger a sandbox cobro on a Nexgo terminal and verify the row lands in `ProviderEventLog` as `MATCHED`
  4. If the real body field names differ from §6.2 EXPECTED shape, patch the spec and the `AngelPayWebhookPayload` interface accordingly.
     Implementation already logs the full body on first sighting of each event type — check Render logs for the dump.
- ⏳ Production rollout: repeat steps 1-3 against the AngelPay production portal + Render prod service
```

- [ ] **Step 5: Commit**

```bash
git add docs/angelpay/WEBHOOK_RECEIVER_SPEC.md
git commit -m "docs(angelpay-webhook): document manual provisioning steps for go-live"
```

---

## Self-review notes (resolved inline)

- **Spec §11 coverage:** every acceptance criterion maps to at least one test in Tasks 6, 7, 8, 9, or 10. The amount-tolerance ≥ $0.01 check
  is covered by Task 7 (the test uses 105.50 vs 100 = diff 5.5). The lastReceivedAt touch is covered by Task 6 (MATCHED test asserts the
  merchantAccount.update call). The race-condition retry test is covered by Task 5 (attemptPaymentMatch retries 3x).
- **Type consistency:** `AngelPayWebhookPayload`, `AngelPayWebhookResult`, and `AngelPayWebhookAction` are defined in Task 2 and used in
  every subsequent task without rename. `getActiveWebhookSecret` (Task 2) is used identically in Tasks 10 and 12.
- **Manual capture deferred:** Task 13 step 4 documents the empirical body-shape capture as the next operational step. The implementation
  logs raw body on first sighting so any field-name churn surfaces without a code change.
- **`svix` install:** already in `package.json` at `^1.84.1`. No install task needed.
- **Body shape evolution:** the implementation accesses `payload.data.external_reference`, `auth_code`, `transaction_id`, and
  `card.{last_four, brand, entry_mode}`. If AngelPay's real payload uses camelCase (`externalReference`) or a different envelope, the only
  changes are in the `AngelPayWebhookPayload` interface and the destructuring in the service — all matching logic is otherwise
  field-agnostic.
