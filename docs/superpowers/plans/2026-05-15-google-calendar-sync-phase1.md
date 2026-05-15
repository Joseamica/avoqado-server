# Google Calendar Sync — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-15-google-calendar-sync-design.md` (v1.5)

**Goal:** Ship read-only Google Calendar sync so events in a connected staff/venue calendar block availability on `book.avoqado.io` and the
dashboard reservation calendar. No push yet (Phase 2).

**Architecture:** OAuth → `GoogleOAuthSession` bridge → `GoogleCalendarConnection`. Watch channels POST notifications to a webhook that
writes a `GoogleCalendarWebhookInbox` row durably BEFORE acking, then enqueues to RabbitMQ. A single-flight pull worker calls `events.list`
(Phase A backfill or Phase B incremental with `syncToken`) and upserts/tombstones `ExternalBusyBlock` rows. A new `checkExternalBusyBlock`
helper is called inside every reservation write transaction AND the availability read.

**Tech Stack:** Express.js + TypeScript, PostgreSQL via Prisma, RabbitMQ, Redis, `googleapis` npm package, AES-256-GCM via Node `crypto`,
Jest for tests.

**Scope discipline:**

- ✅ Phase 1: schema, OAuth, pull, conflict-check integration, all relevant crons.
- ❌ Phase 2 (deferred to its own plan): `CalendarSyncOutbox`, `ReservationGoogleEventMapping`, push hooks in reservation/classSession
  services, dashboard UI for push detail level.
- ❌ Phase 3 (deferred): connection-status dashboard, dead-letter UI, privacy preview UI.

The Phase 2/3 schema fields are NOT added in this plan; they'll be added with their respective plans to avoid carrying unused columns in
production.

**Estimated effort:** ~36 tasks × ~15 min each ≈ 9 hours of focused work for a developer who knows the codebase. First-time implementer
should plan for 2× that.

---

## File map

### New files

| File                                                            | Purpose                                                                                                                                       |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/services/google-calendar/encryption.service.ts`            | AES-256-GCM encrypt/decrypt for refresh/access tokens                                                                                         |
| `src/services/google-calendar/oauth.service.ts`                 | `buildAuthUrl`, `exchangeCodeForTokens`, `verifyIdToken`                                                                                      |
| `src/services/google-calendar/oauth-session.service.ts`         | create + atomic-consume `GoogleOAuthSession`                                                                                                  |
| `src/services/google-calendar/connection.service.ts`            | create/list/disconnect `GoogleCalendarConnection`                                                                                             |
| `src/services/google-calendar/watch-channel.service.ts`         | subscribe / renew / stop `events.watch` channels                                                                                              |
| `src/services/google-calendar/pull.service.ts`                  | Phase A backfill + Phase B incremental, per-event handling                                                                                    |
| `src/services/google-calendar/external-busy-block.service.ts`   | upsert/delete blocks; time parsing with TZ for all-day                                                                                        |
| `src/services/reservation/external-busy-block.service.ts`       | `checkExternalBusyBlock` helper (called from write paths)                                                                                     |
| `src/controllers/google-calendar.controller.ts`                 | HTTP layer for OAuth + connections endpoints                                                                                                  |
| `src/controllers/webhook/google-calendar.webhook.controller.ts` | `handleGoogleCalendarWebhook`                                                                                                                 |
| `src/routes/google-calendar.routes.ts`                          | mounts the controller                                                                                                                         |
| `src/jobs/gcal-channel-renewal.job.ts`                          | every 12h, renew channels <48h to expiry                                                                                                      |
| `src/jobs/gcal-inbox-sweeper.job.ts`                            | every 30s, picks orphan Inbox rows                                                                                                            |
| `src/jobs/gcal-horizon-refresh.job.ts`                          | daily, bounded re-sync of newly-uncovered window                                                                                              |
| `src/jobs/gcal-pruning.job.ts`                                  | daily, drop `ExternalBusyBlock` past `endsAt < NOW-7d`                                                                                        |
| `src/jobs/gcal-health-check.job.ts`                             | daily, ping `calendarList.get` on quiet connections                                                                                           |
| Tests                                                           | mirroring above; `tests/unit/services/google-calendar/`, `tests/api-tests/google-calendar/`, `tests/workflows/google-calendar-phase1.test.ts` |

### Modified files

| File                                                        | Why                                                                                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `prisma/schema.prisma`                                      | Add 5 new models + relations on `Venue`, `Staff`                                                 |
| `prisma/migrations/<new>/migration.sql`                     | Partial unique indexes + CHECK constraint (raw SQL)                                              |
| `scripts/setup-modules.ts`                                  | Register `GOOGLE_CALENDAR_SYNC` module                                                           |
| `src/services/access/access.service.ts`                     | Add 4 `calendar:*` permissions to `PERMISSION_CATALOG`                                           |
| `src/app.ts`                                                | Mount Google webhook BEFORE the Stripe `/api/v1/webhooks` raw parser                             |
| `src/server.ts`                                             | Register 5 new cron jobs                                                                         |
| `src/services/dashboard/reservation.dashboard.service.ts`   | Add `checkExternalBusyBlock` call in `createReservation` (~:252) and `updateReservation` (~:821) |
| `src/controllers/public/reservation.public.controller.ts`   | Add `checkExternalBusyBlock` call in public create (~:551) and slot hold (~:1616)                |
| `src/services/dashboard/reservationAvailability.service.ts` | UNION `ExternalBusyBlock` into busy intervals (~:92)                                             |
| `.env.example`, deploy env config                           | Document new env vars                                                                            |

---

## Required env vars

Add to `.env.example` and document for deploy:

```
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_REDIRECT_URI=https://api.avoqado.io/api/v1/google-calendar/oauth/callback
GOOGLE_CALENDAR_TOKEN_KEY=          # 32-byte hex; AES-256-GCM key; ROTATE-SEPARATELY from JWT_SECRET
GOOGLE_CALENDAR_WEBHOOK_BASE=https://api.avoqado.io     # base URL Google posts to
OAUTH_STATE_SECRET=                  # JWT secret for OAuth state; separate from JWT_SECRET
```

---

## Section A — Foundation

### Task 1: Install dependencies

**Files:**

- Modify: `package.json`

- [ ] **Step 1: Install packages**

```bash
npm install googleapis google-auth-library
```

- [ ] **Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add googleapis + google-auth-library for calendar sync"
```

---

### Task 2: AES-256-GCM encryption service

**Files:**

- Create: `src/services/google-calendar/encryption.service.ts`
- Test: `tests/unit/services/google-calendar/encryption.service.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/services/google-calendar/encryption.service.test.ts
import { encryptToken, decryptToken } from '../../../../src/services/google-calendar/encryption.service'

describe('GoogleCalendarTokenEncryption', () => {
  const originalKey = process.env.GOOGLE_CALENDAR_TOKEN_KEY
  beforeAll(() => {
    process.env.GOOGLE_CALENDAR_TOKEN_KEY = 'a'.repeat(64)
  }) // 32-byte hex
  afterAll(() => {
    process.env.GOOGLE_CALENDAR_TOKEN_KEY = originalKey
  })

  it('round-trips a plaintext refresh token', () => {
    const plaintext = '1//0g_some_long_google_refresh_token_xyz'
    const ct = encryptToken(plaintext)
    expect(ct).toBeInstanceOf(Buffer)
    expect(ct.length).toBeGreaterThan(plaintext.length) // IV + tag + ciphertext
    expect(decryptToken(ct)).toBe(plaintext)
  })

  it('produces different ciphertexts for the same plaintext (random IV)', () => {
    const plaintext = 'same-token'
    expect(encryptToken(plaintext).toString('hex')).not.toBe(encryptToken(plaintext).toString('hex'))
  })

  it('throws on tampered ciphertext', () => {
    const ct = encryptToken('hello')
    ct[ct.length - 1] ^= 0xff // flip last byte (tag)
    expect(() => decryptToken(ct)).toThrow()
  })

  it('throws if GOOGLE_CALENDAR_TOKEN_KEY missing', () => {
    delete process.env.GOOGLE_CALENDAR_TOKEN_KEY
    expect(() => encryptToken('x')).toThrow(/GOOGLE_CALENDAR_TOKEN_KEY/)
    process.env.GOOGLE_CALENDAR_TOKEN_KEY = 'a'.repeat(64)
  })
})
```

- [ ] **Step 2: Run test, expect failure**

```bash
npm test -- tests/unit/services/google-calendar/encryption.service.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/services/google-calendar/encryption.service.ts
import crypto from 'crypto'

const ALGO = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16

function getKey(): Buffer {
  const hex = process.env.GOOGLE_CALENDAR_TOKEN_KEY
  if (!hex || hex.length !== 64) {
    throw new Error('GOOGLE_CALENDAR_TOKEN_KEY missing or wrong length (expect 32-byte hex)')
  }
  return Buffer.from(hex, 'hex')
}

export function encryptToken(plaintext: string): Buffer {
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ct])
}

export function decryptToken(blob: Buffer): string {
  const iv = blob.subarray(0, IV_LEN)
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const ct = blob.subarray(IV_LEN + TAG_LEN)
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
npm test -- tests/unit/services/google-calendar/encryption.service.test.ts
```

Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/services/google-calendar/encryption.service.ts tests/unit/services/google-calendar/encryption.service.test.ts
git commit -m "feat(gcal): AES-256-GCM token encryption helper"
```

---

### Task 3: Prisma schema — Phase 1 models

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_gcal_phase1/migration.sql`

- [ ] **Step 1: Add enums + 5 models to schema.prisma**

Append the following enums and models (place near existing reservation models for locality):

```prisma
enum GoogleCalendarConnectionScope {
  VENUE
  STAFF_PERSONAL
}

enum GoogleCalendarConnectionStatus {
  CONNECTED
  TOKEN_REVOKED
  CALENDAR_LOST
  WATCH_FAILED
  DISCONNECTED
}

enum GoogleCalendarChannelStatus {
  ACTIVE
  RENEWING
  EXPIRED
  STOPPED
}

model GoogleCalendarConnection {
  id                       String                          @id @default(cuid())
  scope                    GoogleCalendarConnectionScope
  venueId                  String?
  venue                    Venue?                          @relation(fields: [venueId], references: [id], onDelete: Cascade)
  staffId                  String?
  staff                    Staff?                          @relation("StaffGoogleCalendarConnection", fields: [staffId], references: [id], onDelete: Cascade)
  googleAccountEmail       String
  googleAccountSub         String
  selectedCalendarId       String
  selectedCalendarSummary  String
  selectedCalendarTimeZone String
  refreshTokenCiphertext   Bytes
  accessTokenCiphertext    Bytes?
  accessTokenExpiresAt     DateTime?
  syncToken                String?
  lastSyncedAt             DateTime?
  lastHorizonEnd           DateTime?
  status                   GoogleCalendarConnectionStatus  @default(CONNECTED)
  statusReason             String?                         @db.Text
  connectedAt              DateTime                        @default(now())
  disconnectedAt           DateTime?
  createdByStaffId         String?
  createdByStaff           Staff?                          @relation("StaffCreatedGoogleConnection", fields: [createdByStaffId], references: [id], onDelete: SetNull)
  channels                 GoogleCalendarChannel[]
  busyBlocks               ExternalBusyBlock[]
  createdAt                DateTime                        @default(now())
  updatedAt                DateTime                        @updatedAt
  @@index([venueId])
  @@index([staffId])
  @@index([status])
}

model GoogleCalendarChannel {
  id           String                       @id @default(cuid())
  connectionId String
  connection   GoogleCalendarConnection     @relation(fields: [connectionId], references: [id], onDelete: Cascade)
  channelId    String                       @unique
  resourceId   String
  token        String
  expiresAt    DateTime
  status       GoogleCalendarChannelStatus  @default(ACTIVE)
  createdAt    DateTime                     @default(now())
  stoppedAt    DateTime?
  @@index([connectionId, status])
  @@index([expiresAt, status])
  @@index([resourceId])
}

model ExternalBusyBlock {
  id                  String                    @id @default(cuid())
  googleConnectionId  String
  connection          GoogleCalendarConnection  @relation(fields: [googleConnectionId], references: [id], onDelete: Cascade)
  venueId             String?
  staffId             String?
  externalSource      String                    @default("GOOGLE")
  externalCalendarId  String
  externalEventId     String
  startsAt            DateTime
  endsAt              DateTime
  allDay              Boolean                   @default(false)
  title               String?                   @db.Text
  isPrivate           Boolean                   @default(true)
  createdAt           DateTime                  @default(now())
  updatedAt           DateTime                  @updatedAt
  @@unique([googleConnectionId, externalEventId])
  @@index([venueId, startsAt, endsAt])
  @@index([staffId, startsAt, endsAt])
}

model GoogleCalendarWebhookInbox {
  id              String   @id @default(cuid())
  connectionId    String
  channelId       String
  resourceId      String
  resourceState   String
  messageNumber   String
  receivedAt      DateTime @default(now())
  processedAt     DateTime?
  attempts        Int      @default(0)
  lastError       String?  @db.Text
  @@index([processedAt, receivedAt])
  @@index([connectionId, processedAt])
}

model GoogleOAuthSession {
  id                       String   @id @default(cuid())
  tokenHash                String   @unique
  authUserId               String
  intent                   String
  venueId                  String?
  staffId                  String?
  encryptedRefreshToken    Bytes
  encryptedAccessToken     Bytes
  accessTokenExpiresAt     DateTime
  googleAccountEmail       String
  googleAccountSub         String
  createdAt                DateTime  @default(now())
  expiresAt                DateTime
  consumedAt               DateTime?
  @@index([expiresAt])
}
```

Add relations on existing models:

```prisma
// inside model Venue { ... }
googleCalendarConnections GoogleCalendarConnection[]

// inside model Staff { ... }
googleCalendarConnection   GoogleCalendarConnection?   @relation("StaffGoogleCalendarConnection")
createdGoogleConnections   GoogleCalendarConnection[]  @relation("StaffCreatedGoogleConnection")
```

- [ ] **Step 2: Generate Prisma migration**

```bash
npx prisma migrate dev --name gcal_phase1 --create-only
```

This produces a migration directory but does NOT apply it yet (we need to append raw SQL).

- [ ] **Step 3: Append CHECK constraint + partial unique indexes**

Open the generated `prisma/migrations/<timestamp>_gcal_phase1/migration.sql` and append at the bottom:

```sql
-- Enforce "exactly one of venueId/staffId, matching scope"
ALTER TABLE "GoogleCalendarConnection"
  ADD CONSTRAINT gcal_conn_scope_xor CHECK (
    (scope = 'VENUE'          AND "venueId" IS NOT NULL AND "staffId" IS NULL) OR
    (scope = 'STAFF_PERSONAL' AND "staffId" IS NOT NULL AND "venueId" IS NULL)
  );

-- One venue-master per venue, one personal connection per staff (NULLs in Postgres unique indexes don't enforce this)
CREATE UNIQUE INDEX gcal_conn_venue_unique
  ON "GoogleCalendarConnection"("venueId") WHERE "scope" = 'VENUE';
CREATE UNIQUE INDEX gcal_conn_staff_unique
  ON "GoogleCalendarConnection"("staffId") WHERE "scope" = 'STAFF_PERSONAL';
```

- [ ] **Step 4: Apply migration**

```bash
npx prisma migrate dev
```

Expected: migration applies cleanly, `npx prisma generate` runs.

- [ ] **Step 5: Sanity-check the CHECK constraint**

```bash
psql "$DATABASE_URL" -c "INSERT INTO \"GoogleCalendarConnection\" (id,scope,\"googleAccountEmail\",\"googleAccountSub\",\"selectedCalendarId\",\"selectedCalendarSummary\",\"selectedCalendarTimeZone\",\"refreshTokenCiphertext\") VALUES ('x','VENUE','a','b','c','d','UTC','\\x00');"
```

Expected: FAIL with `gcal_conn_scope_xor` violation (venueId is NULL but scope=VENUE requires it).

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(gcal): phase 1 schema — connection, channel, busy block, webhook inbox, oauth session"
```

---

### Task 4: Register `GOOGLE_CALENDAR_SYNC` module + permissions

**Files:**

- Modify: `scripts/setup-modules.ts`
- Modify: `src/services/access/access.service.ts`

- [ ] **Step 1: Add module to `scripts/setup-modules.ts`**

Locate the array of module definitions and append:

```typescript
{
  code: 'GOOGLE_CALENDAR_SYNC',
  name: 'Google Calendar Sync',
  category: 'INTEGRATIONS',
  description: 'Sincronización bidireccional con Google Calendar para reservaciones',
  configSchema: {},
  defaultEnabled: false,
},
```

(Match the exact shape used by other entries in that file.)

- [ ] **Step 2: Run setup-modules to insert the row**

```bash
npx ts-node -r tsconfig-paths/register scripts/setup-modules.ts
```

Expected: log line `Upserted module GOOGLE_CALENDAR_SYNC`.

- [ ] **Step 3: Add permissions to `PERMISSION_CATALOG`**

In `src/services/access/access.service.ts`, locate `PERMISSION_CATALOG` and add:

```typescript
'calendar:manage_venue':     { description: 'Connect/disconnect the venue master Google Calendar',                roles: ['OWNER', 'ADMIN'] },
'calendar:connect_self':     { description: "Connect/disconnect your own personal Google Calendar",               roles: ['OWNER', 'ADMIN', 'MANAGER', 'CASHIER', 'WAITER', 'KITCHEN', 'HOST'] },
'calendar:disconnect_staff': { description: "Force-disconnect another staff member's personal calendar (audit)",  roles: ['OWNER', 'ADMIN'] },
'calendar:view_status':      { description: 'View calendar connection status for the venue',                      roles: ['OWNER', 'ADMIN', 'MANAGER'] },
```

- [ ] **Step 4: Commit**

```bash
git add scripts/setup-modules.ts src/services/access/access.service.ts
git commit -m "feat(gcal): register module + 4 calendar:* permissions"
```

---

## Section B — OAuth + Connection Endpoints

### Task 5: `GoogleOAuthSession` service (create + consume)

**Files:**

- Create: `src/services/google-calendar/oauth-session.service.ts`
- Test: `tests/unit/services/google-calendar/oauth-session.service.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/services/google-calendar/oauth-session.service.test.ts
import { createOAuthSession, loadAndAuthorizeSession, consumeSession } from '../../../../src/services/google-calendar/oauth-session.service'
import { prisma } from '../../../__helpers__/prisma' // existing test prisma helper

describe('GoogleOAuthSession service', () => {
  beforeEach(async () => {
    await prisma.googleOAuthSession.deleteMany()
  })

  it('creates a session and returns an opaque 64-char token', async () => {
    const { sessionToken, session } = await createOAuthSession({
      authUserId: 'user-1',
      intent: 'staff_personal',
      staffId: 'user-1',
      encryptedRefreshToken: Buffer.from('rt'),
      encryptedAccessToken: Buffer.from('at'),
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      googleAccountEmail: 'a@b.com',
      googleAccountSub: '1234',
    })
    expect(sessionToken).toHaveLength(64)
    expect(session.tokenHash).toHaveLength(64)
    expect(session.tokenHash).not.toBe(sessionToken) // hashed
  })

  it('loadAndAuthorizeSession rejects mismatched authUserId', async () => {
    const { sessionToken } = await createOAuthSession({
      authUserId: 'user-1',
      intent: 'staff_personal',
      staffId: 'user-1',
      encryptedRefreshToken: Buffer.alloc(1),
      encryptedAccessToken: Buffer.alloc(1),
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      googleAccountEmail: 'a',
      googleAccountSub: 's',
    })
    await expect(
      loadAndAuthorizeSession(sessionToken, { userId: 'user-2', orgId: 'o', venueId: 'v', role: 'OWNER' as any }),
    ).rejects.toThrow(/oauth_session_user_mismatch/)
  })

  it('rejects expired sessions', async () => {
    const { sessionToken, session } = await createOAuthSession({
      authUserId: 'user-1',
      intent: 'staff_personal',
      staffId: 'user-1',
      encryptedRefreshToken: Buffer.alloc(1),
      encryptedAccessToken: Buffer.alloc(1),
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      googleAccountEmail: 'a',
      googleAccountSub: 's',
    })
    await prisma.googleOAuthSession.update({ where: { id: session.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
    await expect(loadAndAuthorizeSession(sessionToken, { userId: 'user-1' } as any)).rejects.toThrow(/oauth_session_expired/)
  })

  it('rejects already-consumed sessions', async () => {
    const { sessionToken, session } = await createOAuthSession({
      authUserId: 'user-1',
      intent: 'staff_personal',
      staffId: 'user-1',
      encryptedRefreshToken: Buffer.alloc(1),
      encryptedAccessToken: Buffer.alloc(1),
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      googleAccountEmail: 'a',
      googleAccountSub: 's',
    })
    await prisma.googleOAuthSession.update({ where: { id: session.id }, data: { consumedAt: new Date() } })
    await expect(loadAndAuthorizeSession(sessionToken, { userId: 'user-1' } as any)).rejects.toThrow(/already_consumed/)
  })

  it('consumeSession is atomic — second call to same session throws', async () => {
    const { session } = await createOAuthSession({
      authUserId: 'user-1',
      intent: 'staff_personal',
      staffId: 'user-1',
      encryptedRefreshToken: Buffer.alloc(1),
      encryptedAccessToken: Buffer.alloc(1),
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      googleAccountEmail: 'a',
      googleAccountSub: 's',
    })
    await consumeSession(prisma, session.id)
    await expect(consumeSession(prisma, session.id)).rejects.toThrow(/already_consumed/)
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

```bash
npm test -- tests/unit/services/google-calendar/oauth-session.service.test.ts
```

- [ ] **Step 3: Implement**

```typescript
// src/services/google-calendar/oauth-session.service.ts
import crypto from 'crypto'
import { Prisma, PrismaClient } from '@prisma/client'
import prisma from '../../utils/prisma' // existing default prisma client
import { HttpError } from '../../utils/HttpError' // existing pattern
import { hasPermission, AuthContext } from '../access/access.service'

const SESSION_TTL_MS = 10 * 60 * 1000

function sha256(s: string) {
  return crypto.createHash('sha256').update(s).digest('hex')
}

export async function createOAuthSession(args: {
  authUserId: string
  intent: 'staff_personal' | 'venue_master'
  venueId?: string
  staffId?: string
  encryptedRefreshToken: Buffer
  encryptedAccessToken: Buffer
  accessTokenExpiresAt: Date
  googleAccountEmail: string
  googleAccountSub: string
}) {
  const sessionToken = crypto.randomBytes(32).toString('hex')
  const tokenHash = sha256(sessionToken)
  const session = await prisma.googleOAuthSession.create({
    data: {
      tokenHash,
      authUserId: args.authUserId,
      intent: args.intent,
      venueId: args.venueId,
      staffId: args.staffId,
      encryptedRefreshToken: args.encryptedRefreshToken,
      encryptedAccessToken: args.encryptedAccessToken,
      accessTokenExpiresAt: args.accessTokenExpiresAt,
      googleAccountEmail: args.googleAccountEmail,
      googleAccountSub: args.googleAccountSub,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  })
  return { sessionToken, session }
}

export async function loadAndAuthorizeSession(sessionToken: string, authContext: AuthContext) {
  const tokenHash = sha256(sessionToken)
  const session = await prisma.googleOAuthSession.findUnique({ where: { tokenHash } })
  if (!session) throw new HttpError(404, 'oauth_session_not_found')
  if (session.consumedAt) throw new HttpError(409, 'oauth_session_already_consumed')
  if (session.expiresAt < new Date()) throw new HttpError(410, 'oauth_session_expired')
  if (session.authUserId !== authContext.userId) throw new HttpError(403, 'oauth_session_user_mismatch')
  if (session.intent === 'staff_personal' && session.staffId && session.staffId !== session.authUserId) {
    if (!hasPermission(authContext, 'calendar:disconnect_staff')) {
      throw new HttpError(403, 'cross_user_oauth_denied')
    }
  }
  return session
}

export async function consumeSession(tx: Prisma.TransactionClient | PrismaClient, sessionId: string) {
  const res = await tx.googleOAuthSession.updateMany({
    where: { id: sessionId, consumedAt: null },
    data: { consumedAt: new Date() },
  })
  if (res.count === 0) throw new HttpError(409, 'oauth_session_already_consumed')
}
```

- [ ] **Step 4: Run tests, expect PASS**

```bash
npm test -- tests/unit/services/google-calendar/oauth-session.service.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/services/google-calendar/oauth-session.service.ts tests/unit/services/google-calendar/oauth-session.service.test.ts
git commit -m "feat(gcal): GoogleOAuthSession create/load/consume service"
```

---

### Task 6: OAuth core service (URL build, token exchange, id_token verify)

**Files:**

- Create: `src/services/google-calendar/oauth.service.ts`
- Test: `tests/unit/services/google-calendar/oauth.service.test.ts`

- [ ] **Step 1: Failing test for `buildAuthUrl`**

```typescript
import { buildAuthUrl, signState, verifyState } from '../../../../src/services/google-calendar/oauth.service'

describe('OAuth core', () => {
  beforeAll(() => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid'
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://api.example.com/cb'
    process.env.OAUTH_STATE_SECRET = 'secret'
  })

  it('buildAuthUrl includes the 4 required scopes + access_type=offline', () => {
    const url = buildAuthUrl('state-jwt', false)
    expect(url).toContain('client_id=cid')
    expect(url).toContain('access_type=offline')
    expect(url).toContain('include_granted_scopes=true')
    expect(url).toContain('openid')
    expect(url).toContain('email')
    expect(url).toContain('calendar.events')
    expect(url).toContain('calendar.calendarlist.readonly')
    expect(url).not.toContain('prompt=consent')
  })

  it('buildAuthUrl with forceConsent includes prompt=consent', () => {
    expect(buildAuthUrl('s', true)).toContain('prompt=consent')
  })

  it('signState / verifyState round-trips', () => {
    const state = signState({ intent: 'staff_personal', authUserId: 'u1', staffId: 'u1', csrfNonce: 'n' })
    const decoded = verifyState(state)
    expect(decoded.authUserId).toBe('u1')
    expect(decoded.intent).toBe('staff_personal')
  })

  it('verifyState rejects tampered JWT', () => {
    const state = signState({ intent: 'staff_personal', authUserId: 'u1', staffId: 'u1', csrfNonce: 'n' })
    const tampered = state.slice(0, -2) + 'XX'
    expect(() => verifyState(tampered)).toThrow()
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

```bash
npm test -- tests/unit/services/google-calendar/oauth.service.test.ts
```

- [ ] **Step 3: Implement**

```typescript
// src/services/google-calendar/oauth.service.ts
import jwt from 'jsonwebtoken'
import { OAuth2Client } from 'google-auth-library'
import { google } from 'googleapis'

export const GOOGLE_CALENDAR_OAUTH_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
].join(' ')

const STATE_TTL = 600 // 10 min

export interface OAuthState {
  intent: 'staff_personal' | 'venue_master'
  authUserId: string
  staffId?: string
  venueId?: string
  csrfNonce: string
}

export function buildAuthUrl(state: string, forceConsent: boolean): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
    redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT_URI!,
    response_type: 'code',
    scope: GOOGLE_CALENDAR_OAUTH_SCOPES,
    access_type: 'offline',
    include_granted_scopes: 'true',
    state,
  })
  if (forceConsent) params.set('prompt', 'consent')
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`
}

export function signState(payload: OAuthState): string {
  return jwt.sign(payload, process.env.OAUTH_STATE_SECRET!, { expiresIn: STATE_TTL })
}

export function verifyState(token: string): OAuthState {
  return jwt.verify(token, process.env.OAUTH_STATE_SECRET!) as OAuthState
}

// Single shared OAuth2 client (creds shared, instances differ for setCredentials)
export function buildOAuthClient(): OAuth2Client {
  return new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID!,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
    process.env.GOOGLE_OAUTH_REDIRECT_URI!,
  )
}

export async function exchangeCodeForTokens(code: string) {
  const client = buildOAuthClient()
  const { tokens } = await client.getToken(code)
  if (!tokens.id_token) throw new Error('oidc_id_token_missing')
  if (!tokens.access_token) throw new Error('oauth_access_token_missing')
  return tokens
}

export async function verifyGoogleIdToken(idToken: string) {
  const client = buildOAuthClient()
  const ticket = await client.verifyIdToken({ idToken, audience: process.env.GOOGLE_OAUTH_CLIENT_ID! })
  const payload = ticket.getPayload()
  if (!payload?.sub || !payload?.email) throw new Error('oidc_missing_claims')
  if (!payload.email_verified) throw new Error('google_email_not_verified')
  return { sub: payload.sub, email: payload.email }
}
```

- [ ] **Step 4: Run, expect PASS**

```bash
npm test -- tests/unit/services/google-calendar/oauth.service.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/services/google-calendar/oauth.service.ts tests/unit/services/google-calendar/oauth.service.test.ts
git commit -m "feat(gcal): OAuth URL build, state sign/verify, id_token verification"
```

---

### Task 7: Watch-channel service

**Files:**

- Create: `src/services/google-calendar/watch-channel.service.ts`
- Test: `tests/unit/services/google-calendar/watch-channel.service.test.ts`

- [ ] **Step 1: Failing test (mock the calendar API)**

```typescript
// Use jest.mock('googleapis', ...) to return a fake calendar.events.watch resolver
import { subscribeToCalendar, stopChannel } from '../../../../src/services/google-calendar/watch-channel.service'

jest.mock('googleapis', () => {
  const watchMock = jest.fn().mockResolvedValue({ data: { resourceId: 'res-1', expiration: String(Date.now() + 7 * 86400_000) } })
  const stopMock = jest.fn().mockResolvedValue({})
  return {
    google: {
      auth: { OAuth2: jest.fn().mockImplementation(() => ({ setCredentials: jest.fn() })) },
      calendar: jest.fn().mockReturnValue({ events: { watch: watchMock }, channels: { stop: stopMock } }),
    },
  }
})

describe('watch-channel.service', () => {
  it('subscribeToCalendar sends params.ttl and stores Google-returned expiration', async () => {
    const out = await subscribeToCalendar({ accessToken: 'at', refreshToken: 'rt', calendarId: 'c1', webhookUrl: 'https://x/y' })
    expect(out.channelId).toMatch(/^[0-9a-f-]{36}$/)
    expect(out.resourceId).toBe('res-1')
    expect(out.expiresAt.getTime()).toBeGreaterThan(Date.now())
    expect(out.token).toHaveLength(64)
    // Verify what we sent to Google:
    const watchMock = (require('googleapis').google.calendar() as any).events.watch as jest.Mock
    const callArg = watchMock.mock.calls[0][0]
    expect(callArg.requestBody.params).toEqual({ ttl: '604800' })
    expect(callArg.requestBody).not.toHaveProperty('expiration') // do NOT send expiration in request
    expect(callArg.requestBody.type).toBe('web_hook')
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

```bash
npm test -- tests/unit/services/google-calendar/watch-channel.service.test.ts
```

- [ ] **Step 3: Implement**

```typescript
// src/services/google-calendar/watch-channel.service.ts
import crypto from 'crypto'
import { google } from 'googleapis'
import { buildOAuthClient } from './oauth.service'

export interface SubscribeArgs {
  accessToken: string
  refreshToken: string
  calendarId: string
  webhookUrl: string
}

export interface SubscribeResult {
  channelId: string
  resourceId: string
  token: string
  expiresAt: Date
}

export async function subscribeToCalendar(args: SubscribeArgs): Promise<SubscribeResult> {
  const auth = buildOAuthClient()
  auth.setCredentials({ access_token: args.accessToken, refresh_token: args.refreshToken })
  const calendar = google.calendar({ version: 'v3', auth })

  const channelId = crypto.randomUUID()
  const token = crypto.randomBytes(32).toString('hex')

  const res = await calendar.events.watch({
    calendarId: args.calendarId,
    requestBody: {
      id: channelId,
      type: 'web_hook',
      address: args.webhookUrl,
      token,
      params: { ttl: '604800' }, // seconds; Google's max ≈ 7 days
    },
  })

  return {
    channelId,
    resourceId: res.data.resourceId!,
    token,
    expiresAt: new Date(Number(res.data.expiration!)),
  }
}

export async function stopChannel(args: { accessToken: string; refreshToken: string; channelId: string; resourceId: string }) {
  const auth = buildOAuthClient()
  auth.setCredentials({ access_token: args.accessToken, refresh_token: args.refreshToken })
  const calendar = google.calendar({ version: 'v3', auth })
  await calendar.channels.stop({ requestBody: { id: args.channelId, resourceId: args.resourceId } })
}
```

- [ ] **Step 4: Run, expect PASS, then commit**

```bash
npm test -- tests/unit/services/google-calendar/watch-channel.service.test.ts
git add src/services/google-calendar/watch-channel.service.ts tests/unit/services/google-calendar/watch-channel.service.test.ts
git commit -m "feat(gcal): events.watch subscribe/stop with params.ttl (not expiration)"
```

---

### Task 8: OAuth init endpoint

**Files:**

- Create: `src/controllers/google-calendar.controller.ts`
- Create: `src/routes/google-calendar.routes.ts`
- Modify: `src/routes/index.ts` (or whatever the existing route registry is)
- Test: `tests/api-tests/google-calendar/oauth-init.test.ts`

- [ ] **Step 1: Failing API test**

```typescript
import request from 'supertest'
import { app } from '../../../src/app'
import { loginAsOwner } from '../../__helpers__/auth' // existing helper

describe('GET /api/v1/google-calendar/oauth/init', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/google-calendar/oauth/init?intent=staff_personal')
    expect(res.status).toBe(401)
  })

  it('returns authorization URL with signed state', async () => {
    const { agent } = await loginAsOwner()
    const res = await agent.get('/api/v1/google-calendar/oauth/init?intent=staff_personal')
    expect(res.status).toBe(200)
    expect(res.body.url).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/)
    expect(res.body.url).toContain('access_type=offline')
    expect(res.body.url).toContain('state=')
  })

  it('rejects invalid intent', async () => {
    const { agent } = await loginAsOwner()
    const res = await agent.get('/api/v1/google-calendar/oauth/init?intent=foo')
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run, expect FAIL (route not registered)**

- [ ] **Step 3: Implement controller + route**

```typescript
// src/controllers/google-calendar.controller.ts
import crypto from 'crypto'
import { Request, Response, NextFunction } from 'express'
import { buildAuthUrl, signState } from '../services/google-calendar/oauth.service'
import { HttpError } from '../utils/HttpError'
import { hasPermission } from '../services/access/access.service'

export async function oauthInit(req: Request, res: Response, next: NextFunction) {
  try {
    const intent = req.query.intent
    if (intent !== 'staff_personal' && intent !== 'venue_master') throw new HttpError(400, 'invalid_intent')
    const ctx = (req as any).authContext
    if (intent === 'venue_master' && !hasPermission(ctx, 'calendar:manage_venue')) throw new HttpError(403, 'forbidden')
    if (intent === 'staff_personal' && !hasPermission(ctx, 'calendar:connect_self')) throw new HttpError(403, 'forbidden')

    const state = signState({
      intent,
      authUserId: ctx.userId,
      staffId: intent === 'staff_personal' ? ctx.userId : undefined,
      venueId: intent === 'venue_master' ? ctx.venueId : undefined,
      csrfNonce: crypto.randomBytes(32).toString('hex'),
    })
    res.json({ url: buildAuthUrl(state, false) })
  } catch (e) {
    next(e)
  }
}
```

```typescript
// src/routes/google-calendar.routes.ts
import { Router } from 'express'
import { authenticateTokenMiddleware } from '../middlewares/authenticateToken.middleware'
import { oauthInit } from '../controllers/google-calendar.controller'

const router = Router()
router.get('/oauth/init', authenticateTokenMiddleware, oauthInit)
export default router
```

Register in route index (path: `/api/v1/google-calendar`).

- [ ] **Step 4: Run, expect PASS, commit**

```bash
npm test -- tests/api-tests/google-calendar/oauth-init.test.ts
git add src/controllers/google-calendar.controller.ts src/routes/google-calendar.routes.ts src/routes/index.ts tests/api-tests/google-calendar/oauth-init.test.ts
git commit -m "feat(gcal): GET /oauth/init endpoint"
```

---

### Task 9: OAuth callback endpoint (GET, no authContext)

**Files:**

- Modify: `src/controllers/google-calendar.controller.ts`
- Modify: `src/routes/google-calendar.routes.ts`
- Test: `tests/api-tests/google-calendar/oauth-callback.test.ts`

- [ ] **Step 1: Failing test (mock token exchange + id_token verify)**

```typescript
import request from 'supertest'
import { app } from '../../../src/app'
import { signState } from '../../../src/services/google-calendar/oauth.service'

jest.mock('../../../src/services/google-calendar/oauth.service', () => {
  const real = jest.requireActual('../../../src/services/google-calendar/oauth.service')
  return {
    ...real,
    exchangeCodeForTokens: jest.fn().mockResolvedValue({
      access_token: 'at',
      refresh_token: 'rt',
      id_token: 'idt',
      expiry_date: Date.now() + 3600_000,
    }),
    verifyGoogleIdToken: jest.fn().mockResolvedValue({ sub: '12345', email: 'a@b.com' }),
  }
})

describe('GET /api/v1/google-calendar/oauth/callback', () => {
  it('redirects to dashboard with session token on success', async () => {
    const state = signState({ intent: 'staff_personal', authUserId: 'u1', staffId: 'u1', csrfNonce: 'n' })
    const res = await request(app).get(`/api/v1/google-calendar/oauth/callback?code=abc&state=${state}`)
    expect(res.status).toBe(303)
    expect(res.header.location).toMatch(/dashboardv2\.avoqado\.io\/google-calendar\/picker\?session=[a-f0-9]{64}/)
  })

  it('400 on invalid state JWT', async () => {
    const res = await request(app).get('/api/v1/google-calendar/oauth/callback?code=x&state=garbage')
    expect(res.status).toBe(400)
  })

  it('retries with prompt=consent when refresh_token missing', async () => {
    const oauthMod = require('../../../src/services/google-calendar/oauth.service')
    oauthMod.exchangeCodeForTokens.mockResolvedValueOnce({ access_token: 'at', id_token: 'idt', expiry_date: Date.now() + 3600_000 }) // no refresh_token
    const state = signState({ intent: 'staff_personal', authUserId: 'u1', staffId: 'u1', csrfNonce: 'n' })
    const res = await request(app).get(`/api/v1/google-calendar/oauth/callback?code=abc&state=${state}`)
    expect(res.status).toBe(303)
    expect(res.header.location).toContain('prompt=consent')
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

```typescript
// in src/controllers/google-calendar.controller.ts
import { exchangeCodeForTokens, verifyGoogleIdToken, verifyState, buildAuthUrl, signState } from '../services/google-calendar/oauth.service'
import { encryptToken } from '../services/google-calendar/encryption.service'
import { createOAuthSession } from '../services/google-calendar/oauth-session.service'

const DASHBOARD_BASE = process.env.DASHBOARD_URL ?? 'https://dashboardv2.avoqado.io'

export async function oauthCallback(req: Request, res: Response, next: NextFunction) {
  try {
    const code = String(req.query.code ?? '')
    const state = String(req.query.state ?? '')
    if (!code || !state) throw new HttpError(400, 'missing_code_or_state')

    let decoded
    try {
      decoded = verifyState(state)
    } catch {
      throw new HttpError(400, 'invalid_state')
    }

    const tokens = await exchangeCodeForTokens(code)

    // Refresh token retry path
    if (!tokens.refresh_token) {
      const retryState = signState({ ...decoded, csrfNonce: decoded.csrfNonce })
      return res.redirect(303, buildAuthUrl(retryState, true))
    }

    const { sub, email } = await verifyGoogleIdToken(tokens.id_token!)

    const { sessionToken } = await createOAuthSession({
      authUserId: decoded.authUserId,
      intent: decoded.intent,
      venueId: decoded.venueId,
      staffId: decoded.staffId,
      encryptedRefreshToken: encryptToken(tokens.refresh_token),
      encryptedAccessToken: encryptToken(tokens.access_token!),
      accessTokenExpiresAt: new Date(tokens.expiry_date ?? Date.now() + 3600_000),
      googleAccountEmail: email,
      googleAccountSub: sub,
    })

    res.redirect(303, `${DASHBOARD_BASE}/google-calendar/picker?session=${sessionToken}`)
  } catch (e) {
    next(e)
  }
}
```

Add to router:

```typescript
router.get('/oauth/callback', oauthCallback) // NO auth middleware — public
```

- [ ] **Step 4: Run, expect PASS, commit**

```bash
npm test -- tests/api-tests/google-calendar/oauth-callback.test.ts
git add src/controllers/google-calendar.controller.ts src/routes/google-calendar.routes.ts tests/api-tests/google-calendar/oauth-callback.test.ts
git commit -m "feat(gcal): GET /oauth/callback with id_token verify + refresh_token retry"
```

---

### Task 10: List calendars endpoint (post-callback picker)

**Files:**

- Modify: `src/controllers/google-calendar.controller.ts`
- Modify: `src/routes/google-calendar.routes.ts`
- Test: `tests/api-tests/google-calendar/list-calendars.test.ts`

- [ ] **Step 1: Failing test**

```typescript
import request from 'supertest'
import { app } from '../../../src/app'
import { loginAsOwner } from '../../__helpers__/auth'
import { createOAuthSession } from '../../../src/services/google-calendar/oauth-session.service'

jest.mock('googleapis', () => {
  return {
    google: {
      auth: { OAuth2: jest.fn().mockImplementation(() => ({ setCredentials: jest.fn() })) },
      calendar: jest.fn().mockReturnValue({
        calendarList: {
          list: jest.fn().mockResolvedValue({
            data: {
              items: [
                { id: 'primary', summary: 'Personal', timeZone: 'America/Mexico_City', accessRole: 'owner' },
                { id: 'shared@group', summary: 'Familia', timeZone: 'America/Mexico_City', accessRole: 'reader' },
              ],
            },
          }),
        },
      }),
    },
  }
})

describe('GET /api/v1/google-calendar/oauth/calendars', () => {
  it('returns calendar list filtered to writable for staff_personal intent', async () => {
    const { agent, user } = await loginAsOwner()
    const { sessionToken } = await createOAuthSession({
      authUserId: user.id,
      intent: 'staff_personal',
      staffId: user.id,
      encryptedRefreshToken: Buffer.from('x'),
      encryptedAccessToken: Buffer.from('x'),
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      googleAccountEmail: 'a@b.com',
      googleAccountSub: 's1',
    })
    const res = await agent.get(`/api/v1/google-calendar/oauth/calendars?session=${sessionToken}`)
    expect(res.status).toBe(200)
    expect(res.body.calendars).toHaveLength(1)
    expect(res.body.calendars[0].id).toBe('primary')
  })

  it('rejects mismatched authUserId on session', async () => {
    const { agent } = await loginAsOwner()
    const { sessionToken } = await createOAuthSession({
      authUserId: 'OTHER_USER',
      intent: 'staff_personal',
      staffId: 'OTHER_USER',
      encryptedRefreshToken: Buffer.from('x'),
      encryptedAccessToken: Buffer.from('x'),
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      googleAccountEmail: 'a',
      googleAccountSub: 's',
    })
    const res = await agent.get(`/api/v1/google-calendar/oauth/calendars?session=${sessionToken}`)
    expect(res.status).toBe(403)
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

```typescript
// in google-calendar.controller.ts
import { google } from 'googleapis'
import { buildOAuthClient } from '../services/google-calendar/oauth.service'
import { loadAndAuthorizeSession } from '../services/google-calendar/oauth-session.service'
import { decryptToken } from '../services/google-calendar/encryption.service'

export async function listCalendars(req: Request, res: Response, next: NextFunction) {
  try {
    const sessionToken = String(req.query.session ?? '')
    if (!sessionToken) throw new HttpError(400, 'missing_session')
    const session = await loadAndAuthorizeSession(sessionToken, (req as any).authContext)

    const auth = buildOAuthClient()
    auth.setCredentials({
      access_token: decryptToken(session.encryptedAccessToken),
      refresh_token: decryptToken(session.encryptedRefreshToken),
    })
    const calendar = google.calendar({ version: 'v3', auth })
    const out = await calendar.calendarList.list({ minAccessRole: 'reader', showHidden: false })

    // For staff_personal we need owner|writer; venue_master accepts owner|writer (or reader if push disabled — checked at commit)
    const minRoles = session.intent === 'staff_personal' ? ['owner', 'writer'] : ['owner', 'writer', 'reader']
    const calendars = (out.data.items ?? [])
      .filter(c => minRoles.includes(c.accessRole ?? 'reader'))
      .map(c => ({ id: c.id, summary: c.summary, timeZone: c.timeZone, accessRole: c.accessRole, primary: c.primary }))
    res.json({ calendars })
  } catch (e) {
    next(e)
  }
}
```

Add route:

```typescript
router.get('/oauth/calendars', authenticateTokenMiddleware, listCalendars)
```

- [ ] **Step 4: Run, expect PASS, commit**

```bash
git add src/controllers/google-calendar.controller.ts src/routes/google-calendar.routes.ts tests/api-tests/google-calendar/list-calendars.test.ts
git commit -m "feat(gcal): GET /oauth/calendars with accessRole filtering by intent"
```

---

### Task 11: Create connection endpoint

**Files:**

- Modify: `src/controllers/google-calendar.controller.ts`
- Modify: `src/routes/google-calendar.routes.ts`
- Create: `src/services/google-calendar/connection.service.ts`
- Test: `tests/api-tests/google-calendar/create-connection.test.ts`

- [ ] **Step 1: Failing test**

```typescript
// Test that POST /connections:
//   1. Validates session (404/409/410/403)
//   2. Re-checks accessRole on the picked calendar (rejects reader for staff_personal)
//   3. In ONE transaction: consumes session, INSERTs GoogleCalendarConnection, INSERTs GoogleCalendarChannel (events.watch result)
//   4. Returns 201 with the connection id
//   5. After the txn, enqueues backfill (best-effort, can fail)
//   6. Session is consumed
// Mock googleapis (calendarList.get + events.watch).
```

(Spell out the full test in the file — assertions for each numbered behavior. Mock googleapis to return
`{ id: 'cal-1', timeZone: 'America/Mexico_City', accessRole: 'owner' }` for calendarList.get and the standard watch shape.)

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement connection service**

```typescript
// src/services/google-calendar/connection.service.ts
import { Prisma } from '@prisma/client'
import prisma from '../../utils/prisma'
import { google } from 'googleapis'
import { buildOAuthClient } from './oauth.service'
import { decryptToken } from './encryption.service'
import { subscribeToCalendar } from './watch-channel.service'
import { consumeSession } from './oauth-session.service'
import { HttpError } from '../../utils/HttpError'

export async function commitConnection(args: { sessionId: string; selectedCalendarId: string; createdByStaffId: string }) {
  const session = await prisma.googleOAuthSession.findUnique({ where: { id: args.sessionId } })
  if (!session) throw new HttpError(404, 'session_not_found')

  // Fetch calendar metadata + final accessRole check
  const auth = buildOAuthClient()
  auth.setCredentials({
    access_token: decryptToken(session.encryptedAccessToken),
    refresh_token: decryptToken(session.encryptedRefreshToken),
  })
  const calendarApi = google.calendar({ version: 'v3', auth })
  const meta = await calendarApi.calendarList.get({ calendarId: args.selectedCalendarId })
  const accessRole = meta.data.accessRole ?? 'reader'
  if (session.intent === 'staff_personal' && !['owner', 'writer'].includes(accessRole)) {
    throw new HttpError(422, 'calendar_insufficient_access')
  }
  if (!meta.data.timeZone) throw new HttpError(502, 'calendar_no_timezone')

  // Subscribe to push BEFORE the txn so we have the channel data atomic-insertable
  const webhookUrl = `${process.env.GOOGLE_CALENDAR_WEBHOOK_BASE}/api/v1/webhooks/google-calendar`
  const channel = await subscribeToCalendar({
    accessToken: decryptToken(session.encryptedAccessToken),
    refreshToken: decryptToken(session.encryptedRefreshToken),
    calendarId: args.selectedCalendarId,
    webhookUrl,
  })

  // ONE transaction: consume session + create connection + insert channel
  const connection = await prisma.$transaction(async tx => {
    await consumeSession(tx, session.id)
    const conn = await tx.googleCalendarConnection.create({
      data: {
        scope: session.intent === 'venue_master' ? 'VENUE' : 'STAFF_PERSONAL',
        venueId: session.intent === 'venue_master' ? session.venueId : null,
        staffId: session.intent === 'staff_personal' ? session.staffId : null,
        googleAccountEmail: session.googleAccountEmail,
        googleAccountSub: session.googleAccountSub,
        selectedCalendarId: args.selectedCalendarId,
        selectedCalendarSummary: meta.data.summary ?? args.selectedCalendarId,
        selectedCalendarTimeZone: meta.data.timeZone,
        refreshTokenCiphertext: session.encryptedRefreshToken,
        accessTokenCiphertext: session.encryptedAccessToken,
        accessTokenExpiresAt: session.accessTokenExpiresAt,
        createdByStaffId: args.createdByStaffId,
      },
    })
    await tx.googleCalendarChannel.create({
      data: {
        connectionId: conn.id,
        channelId: channel.channelId,
        resourceId: channel.resourceId,
        token: channel.token,
        expiresAt: channel.expiresAt,
        status: 'ACTIVE',
      },
    })
    return conn
  })

  // POST-commit: enqueue backfill (best-effort; pull worker also picks up syncToken=null connections)
  // (Implemented later — for now, this hook is a no-op; the pull worker's "needs full sync" predicate handles it.)
  return connection
}
```

Controller:

```typescript
export async function postConnection(req: Request, res: Response, next: NextFunction) {
  try {
    const sessionToken = String(req.body.session ?? '')
    const calendarId = String(req.body.selectedCalendarId ?? '')
    if (!sessionToken || !calendarId) throw new HttpError(400, 'missing_params')
    const session = await loadAndAuthorizeSession(sessionToken, (req as any).authContext)
    const conn = await commitConnection({
      sessionId: session.id,
      selectedCalendarId: calendarId,
      createdByStaffId: (req as any).authContext.userId,
    })
    res.status(201).json({
      connection: {
        id: conn.id,
        scope: conn.scope,
        googleAccountEmail: conn.googleAccountEmail,
        selectedCalendarSummary: conn.selectedCalendarSummary,
      },
    })
  } catch (e) {
    next(e)
  }
}
```

Route:

```typescript
router.post('/connections', authenticateTokenMiddleware, postConnection)
```

- [ ] **Step 4: Run, expect PASS, commit**

```bash
git add src/services/google-calendar/connection.service.ts src/controllers/google-calendar.controller.ts src/routes/google-calendar.routes.ts tests/api-tests/google-calendar/create-connection.test.ts
git commit -m "feat(gcal): POST /connections commits connection+channel atomically, consumes session"
```

---

### Task 12: List + disconnect connection endpoints

**Files:**

- Modify: `src/controllers/google-calendar.controller.ts`
- Modify: `src/routes/google-calendar.routes.ts`
- Test: `tests/api-tests/google-calendar/connections-list-disconnect.test.ts`

- [ ] **Step 1: Failing tests** (list returns user's venue + own personal; disconnect revokes with Google and drops blocks; permission gate)

- [ ] **Step 2: Implement**

```typescript
export async function listConnections(req: Request, res: Response, next: NextFunction) {
  try {
    const ctx = (req as any).authContext
    const connections = await prisma.googleCalendarConnection.findMany({
      where: { OR: [{ staffId: ctx.userId }, { venueId: ctx.venueId }] },
      select: {
        id: true,
        scope: true,
        googleAccountEmail: true,
        selectedCalendarSummary: true,
        selectedCalendarTimeZone: true,
        status: true,
        lastSyncedAt: true,
        venueId: true,
        staffId: true,
        connectedAt: true,
      },
    })
    res.json({ connections })
  } catch (e) {
    next(e)
  }
}

export async function disconnect(req: Request, res: Response, next: NextFunction) {
  try {
    const ctx = (req as any).authContext
    const conn = await prisma.googleCalendarConnection.findUnique({ where: { id: req.params.id }, include: { channels: true } })
    if (!conn) throw new HttpError(404, 'not_found')

    // Permission check
    const isOwnPersonal = conn.scope === 'STAFF_PERSONAL' && conn.staffId === ctx.userId
    const isVenueAdmin = conn.scope === 'VENUE' && conn.venueId === ctx.venueId && hasPermission(ctx, 'calendar:manage_venue')
    const isStaffAdmin = conn.scope === 'STAFF_PERSONAL' && conn.staffId !== ctx.userId && hasPermission(ctx, 'calendar:disconnect_staff')
    if (!isOwnPersonal && !isVenueAdmin && !isStaffAdmin) throw new HttpError(403, 'forbidden')

    // Stop watch channels with Google (best-effort)
    for (const ch of conn.channels.filter(c => c.status === 'ACTIVE')) {
      try {
        await stopChannel({
          accessToken: decryptToken(conn.accessTokenCiphertext!),
          refreshToken: decryptToken(conn.refreshTokenCiphertext),
          channelId: ch.channelId,
          resourceId: ch.resourceId,
        })
      } catch {
        /* connection may already be revoked at Google; proceed */
      }
    }

    // Drop blocks + mark connection DISCONNECTED (single txn)
    await prisma.$transaction([
      prisma.externalBusyBlock.deleteMany({ where: { googleConnectionId: conn.id } }),
      prisma.googleCalendarChannel.updateMany({ where: { connectionId: conn.id }, data: { status: 'STOPPED', stoppedAt: new Date() } }),
      prisma.googleCalendarConnection.update({ where: { id: conn.id }, data: { status: 'DISCONNECTED', disconnectedAt: new Date() } }),
    ])
    res.status(204).end()
  } catch (e) {
    next(e)
  }
}
```

Routes:

```typescript
router.get('/connections', authenticateTokenMiddleware, listConnections)
router.delete('/connections/:id', authenticateTokenMiddleware, disconnect)
```

- [ ] **Step 3: Run, expect PASS, commit**

```bash
git commit -m "feat(gcal): GET /connections + DELETE /connections/:id"
```

---

## Section C — Pull sync

### Task 13: Webhook handler + mount BEFORE Stripe

**Files:**

- Create: `src/controllers/webhook/google-calendar.webhook.controller.ts`
- Modify: `src/app.ts`
- Test: `tests/api-tests/google-calendar/webhook.test.ts`

- [ ] **Step 1: Failing test** (assert: missing headers → 400; bad token → 401; valid sync notification → 200 no-op; valid exists
      notification → 200 + Inbox row written; DB write failure → 503; constant-time compare; Stripe webhook still verifies after this
      change)

- [ ] **Step 2: Implement controller**

```typescript
// src/controllers/webhook/google-calendar.webhook.controller.ts
import crypto from 'crypto'
import { Request, Response } from 'express'
import prisma from '../../utils/prisma'
import logger from '../../utils/logger' // adapt to existing logger
import { rabbitmq } from '../../communication/rabbitmq/connection'

export async function handleGoogleCalendarWebhook(req: Request, res: Response) {
  const channelId = req.header('X-Goog-Channel-ID')
  const token = req.header('X-Goog-Channel-Token')
  const resourceId = req.header('X-Goog-Resource-ID')
  const resourceState = req.header('X-Goog-Resource-State')
  const messageNumber = req.header('X-Goog-Message-Number')

  if (!channelId || !token || !resourceId) return res.status(400).end()

  const channels = await prisma.googleCalendarChannel.findMany({
    where: { channelId, status: { in: ['ACTIVE', 'RENEWING'] } },
    include: { connection: true },
  })
  if (channels.length === 0) return res.status(404).end()

  const channel = channels.find(c => {
    if (c.token.length !== token.length) return false
    return crypto.timingSafeEqual(Buffer.from(c.token), Buffer.from(token))
  })
  if (!channel) return res.status(401).end()
  if (channel.resourceId !== resourceId) return res.status(401).end()
  if (channel.connection.status !== 'CONNECTED') return res.status(200).end()
  if (resourceState === 'sync') return res.status(200).end()

  try {
    await prisma.googleCalendarWebhookInbox.create({
      data: {
        connectionId: channel.connectionId,
        channelId,
        resourceId,
        resourceState: resourceState ?? 'unknown',
        messageNumber: messageNumber ?? '0',
      },
    })
  } catch (err) {
    logger.error({ err, channelId }, 'gcal webhook inbox write failed')
    return res.status(503).end()
  }

  rabbitmq.publish('gcal.pull', { connectionId: channel.connectionId }).catch(() => {})
  return res.status(200).end()
}
```

- [ ] **Step 3: Mount BEFORE the existing `/api/v1/webhooks` route in `src/app.ts`**

Find the existing block at line ~79:

```typescript
app.use('/api/v1/webhooks', express.raw({ type: 'application/json' }), webhookRoutes)
```

Insert IMMEDIATELY ABOVE it:

```typescript
import { handleGoogleCalendarWebhook } from './controllers/webhook/google-calendar.webhook.controller'

// ⚠️ Mount BEFORE the existing /api/v1/webhooks router so Google notifications hit
// the */* raw parser, not Stripe's strict application/json parser.
app.post('/api/v1/webhooks/google-calendar', express.raw({ type: '*/*', limit: '64kb' }), handleGoogleCalendarWebhook)
```

- [ ] **Step 4: Run tests including Stripe regression**

```bash
npm test -- tests/api-tests/google-calendar/webhook.test.ts
npm test -- tests/api-tests/webhook        # existing Stripe tests — MUST still pass
```

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(gcal): POST /webhooks/google-calendar with constant-time token + DB inbox"
```

---

### Task 14: `ExternalBusyBlock` service — upsert/delete + time parsing

**Files:**

- Create: `src/services/google-calendar/external-busy-block.service.ts`
- Test: `tests/unit/services/google-calendar/external-busy-block.service.test.ts`

- [ ] **Step 1: Failing tests**

Test cases:

- All-day event `{ start: { date: '2026-05-15' } }` with `selectedCalendarTimeZone='America/Mexico_City'` →
  `startsAt = 2026-05-15T06:00:00Z` (MX is UTC-6) and `endsAt = 2026-05-16T06:00:00Z`.
- Timed event with explicit dateTime + timeZone → preserved as UTC.
- Recurring instance (singleEvents=true gives unique id) → upserts with composite id.
- `status: 'cancelled'` → triggers delete by `(connectionId, externalEventId)`.
- Tombstone of unknown event id → no-op (no row, no error).

- [ ] **Step 2: Implement**

```typescript
// src/services/google-calendar/external-busy-block.service.ts
import { Prisma } from '@prisma/client'
import { fromZonedTime } from 'date-fns-tz'
import type { calendar_v3 } from 'googleapis'

export interface ParsedEventTime {
  startsAt: Date
  endsAt: Date
  allDay: boolean
}

export function parseGoogleEventTime(event: calendar_v3.Schema$Event, calendarTimeZone: string): ParsedEventTime {
  if (event.start?.date) {
    // All-day. Google sends YYYY-MM-DD; treat as local midnight in calendar's TZ.
    const startsAt = fromZonedTime(new Date(`${event.start.date}T00:00:00`), calendarTimeZone)
    const endsAt = fromZonedTime(new Date(`${event.end!.date}T00:00:00`), calendarTimeZone) // Google end.date is exclusive
    return { startsAt, endsAt, allDay: true }
  }
  return {
    startsAt: new Date(event.start!.dateTime!),
    endsAt: new Date(event.end!.dateTime!),
    allDay: false,
  }
}

export interface UpsertArgs {
  connectionId: string
  venueId: string | null
  staffId: string | null
  externalCalendarId: string
  event: calendar_v3.Schema$Event
  calendarTimeZone: string
}

export async function upsertBlock(tx: Prisma.TransactionClient, args: UpsertArgs) {
  const t = parseGoogleEventTime(args.event, args.calendarTimeZone)
  await tx.externalBusyBlock.upsert({
    where: { googleConnectionId_externalEventId: { googleConnectionId: args.connectionId, externalEventId: args.event.id! } },
    create: {
      googleConnectionId: args.connectionId,
      venueId: args.venueId,
      staffId: args.staffId,
      externalCalendarId: args.externalCalendarId,
      externalEventId: args.event.id!,
      startsAt: t.startsAt,
      endsAt: t.endsAt,
      allDay: t.allDay,
      title: args.event.summary ?? null,
      isPrivate: args.event.visibility === 'private' || !args.event.summary,
    },
    update: {
      startsAt: t.startsAt,
      endsAt: t.endsAt,
      allDay: t.allDay,
      title: args.event.summary ?? null,
    },
  })
}

export async function deleteBlock(tx: Prisma.TransactionClient, connectionId: string, externalEventId: string) {
  await tx.externalBusyBlock.deleteMany({ where: { googleConnectionId: connectionId, externalEventId } })
}
```

- [ ] **Step 3: Run, expect PASS, commit**

```bash
git commit -m "feat(gcal): ExternalBusyBlock upsert/delete + all-day TZ parsing"
```

---

### Task 15: Pull service — Phase A backfill

**Files:**

- Create: `src/services/google-calendar/pull.service.ts`
- Test: `tests/unit/services/google-calendar/pull.service.backfill.test.ts`

- [ ] **Step 1: Failing test**

Mock `events.list` returning two pages. Assert:

- First call sends `{ timeMin, timeMax, singleEvents: true, showDeleted: false }`, NO `syncToken`.
- Second call sends `pageToken` from the first response.
- After the last page, the connection's `syncToken`, `lastSyncedAt`, AND `lastHorizonEnd` are all written in a single txn.
- Events with `extendedProperties.private.avoqadoOrigin === 'avoqado'` are skipped (no busy block created).

- [ ] **Step 2: Implement** the `runBackfill(connectionId)` function. The full function consumes `events.list` pages, calls `upsertBlock`
      for each non-cancelled non-Avoqado event, and finalizes with a single transaction:

```typescript
// src/services/google-calendar/pull.service.ts (partial — backfill only here, incremental in next task)
import { google, calendar_v3 } from 'googleapis'
import prisma from '../../utils/prisma'
import { buildOAuthClient } from './oauth.service'
import { decryptToken } from './encryption.service'
import { upsertBlock } from './external-busy-block.service'

const MAX_RESULTS = 250

export async function runBackfill(connectionId: string) {
  const conn = await prisma.googleCalendarConnection.findUnique({
    where: { id: connectionId },
    include: { venue: { include: { reservationSettings: true } } },
  })
  if (!conn || conn.status !== 'CONNECTED') return

  const auth = buildOAuthClient()
  auth.setCredentials({ access_token: decryptToken(conn.accessTokenCiphertext!), refresh_token: decryptToken(conn.refreshTokenCiphertext) })
  const calendar = google.calendar({ version: 'v3', auth })

  const now = new Date()
  const maxAdvanceDays = conn.venue?.reservationSettings?.maxAdvanceDays ?? 60
  const horizonEnd = new Date(now.getTime() + maxAdvanceDays * 86400_000)

  const events: calendar_v3.Schema$Event[] = []
  let pageToken: string | undefined
  let nextSyncToken: string | undefined
  do {
    const page = await calendar.events.list({
      calendarId: conn.selectedCalendarId,
      timeMin: now.toISOString(),
      timeMax: horizonEnd.toISOString(),
      singleEvents: true,
      showDeleted: false,
      maxResults: MAX_RESULTS,
      pageToken,
    })
    for (const ev of page.data.items ?? []) events.push(ev)
    pageToken = page.data.nextPageToken ?? undefined
    if (!pageToken) nextSyncToken = page.data.nextSyncToken ?? undefined
  } while (pageToken)

  await prisma.$transaction(async tx => {
    // Clear any existing blocks (backfill is authoritative for the window)
    await tx.externalBusyBlock.deleteMany({ where: { googleConnectionId: conn.id } })
    for (const ev of events) {
      if (ev.extendedProperties?.private?.avoqadoOrigin === 'avoqado') continue
      if (ev.transparency === 'transparent') continue
      const selfDeclined = (ev.attendees ?? []).some(a => a.self && a.responseStatus === 'declined')
      if (selfDeclined) continue
      await upsertBlock(tx, {
        connectionId: conn.id,
        venueId: conn.venueId,
        staffId: conn.staffId,
        externalCalendarId: conn.selectedCalendarId,
        event: ev,
        calendarTimeZone: conn.selectedCalendarTimeZone,
      })
    }
    await tx.googleCalendarConnection.update({
      where: { id: conn.id },
      data: { syncToken: nextSyncToken, lastSyncedAt: new Date(), lastHorizonEnd: horizonEnd },
    })
  })
}
```

- [ ] **Step 3: Run, expect PASS, commit**

```bash
git commit -m "feat(gcal): pull service — Phase A backfill"
```

---

### Task 16: Pull service — Phase B incremental + horizon filter

**Files:**

- Modify: `src/services/google-calendar/pull.service.ts`
- Test: `tests/unit/services/google-calendar/pull.service.incremental.test.ts`

- [ ] **Step 1: Failing tests**

Mock `events.list` with `syncToken`. Assert:

- Request uses `syncToken`, no `timeMin/timeMax`.
- `status: 'cancelled'` event → block deleted.
- Event moved outside `[NOW-7d, NOW+maxAdvanceDays]` → block deleted.
- New event inside horizon → block upserted.
- Self-declined event → block deleted/not created.
- 410 GONE → triggers full backfill (mock another call to events.list without syncToken).
- 401 → triggers token refresh path (mocked).

- [ ] **Step 2: Implement `runIncrementalPull(connectionId)` + 410 + 401 handling**

```typescript
// in pull.service.ts
export async function runIncrementalPull(connectionId: string) {
  const conn = await prisma.googleCalendarConnection.findUnique({
    where: { id: connectionId },
    include: { venue: { include: { reservationSettings: true } } },
  })
  if (!conn || conn.status !== 'CONNECTED') return
  if (!conn.syncToken) return runBackfill(connectionId) // first sync after connect

  const auth = buildOAuthClient()
  auth.setCredentials({ access_token: decryptToken(conn.accessTokenCiphertext!), refresh_token: decryptToken(conn.refreshTokenCiphertext) })
  const calendar = google.calendar({ version: 'v3', auth })

  const now = new Date()
  const maxAdvanceDays = conn.venue?.reservationSettings?.maxAdvanceDays ?? 60
  const horizonStart = new Date(now.getTime() - 7 * 86400_000)
  const horizonEnd = new Date(now.getTime() + maxAdvanceDays * 86400_000)

  const collected: calendar_v3.Schema$Event[] = []
  let pageToken: string | undefined
  let nextSyncToken = conn.syncToken
  try {
    do {
      const page = await calendar.events.list({
        calendarId: conn.selectedCalendarId,
        syncToken: conn.syncToken,
        singleEvents: true,
        showDeleted: true,
        maxResults: MAX_RESULTS,
        pageToken,
      })
      for (const ev of page.data.items ?? []) collected.push(ev)
      pageToken = page.data.nextPageToken ?? undefined
      if (!pageToken && page.data.nextSyncToken) nextSyncToken = page.data.nextSyncToken
    } while (pageToken)
  } catch (err: any) {
    if (err.code === 410) {
      // syncToken expired — full recovery
      await prisma.externalBusyBlock.deleteMany({ where: { googleConnectionId: conn.id } })
      await prisma.googleCalendarConnection.update({ where: { id: conn.id }, data: { syncToken: null } })
      return runBackfill(connectionId)
    }
    if (err.code === 401) {
      // Refresh handling — implemented in Task 18
      return handleAuthError(conn.id, err)
    }
    throw err
  }

  await prisma.$transaction(async tx => {
    for (const ev of collected) {
      if (ev.status === 'cancelled') {
        await tx.externalBusyBlock.deleteMany({ where: { googleConnectionId: conn.id, externalEventId: ev.id! } })
        continue
      }
      if (ev.extendedProperties?.private?.avoqadoOrigin === 'avoqado') continue
      const selfDeclined = (ev.attendees ?? []).some(a => a.self && a.responseStatus === 'declined')
      if (ev.transparency === 'transparent' || selfDeclined) {
        await tx.externalBusyBlock.deleteMany({ where: { googleConnectionId: conn.id, externalEventId: ev.id! } })
        continue
      }
      // Horizon filter
      const start = ev.start?.dateTime ? new Date(ev.start.dateTime) : new Date(`${ev.start?.date}T00:00:00Z`)
      const end = ev.end?.dateTime ? new Date(ev.end.dateTime) : new Date(`${ev.end?.date}T00:00:00Z`)
      const inHorizon = end > horizonStart && start < horizonEnd
      if (!inHorizon) {
        await tx.externalBusyBlock.deleteMany({ where: { googleConnectionId: conn.id, externalEventId: ev.id! } })
        continue
      }
      await upsertBlock(tx, {
        connectionId: conn.id,
        venueId: conn.venueId,
        staffId: conn.staffId,
        externalCalendarId: conn.selectedCalendarId,
        event: ev,
        calendarTimeZone: conn.selectedCalendarTimeZone,
      })
    }
    await tx.googleCalendarConnection.update({
      where: { id: conn.id },
      data: { syncToken: nextSyncToken, lastSyncedAt: new Date() },
    })
  })
}

async function handleAuthError(connectionId: string, err: any) {
  // Implemented in Task 18
}
```

- [ ] **Step 3: Run, expect PASS, commit**

```bash
git commit -m "feat(gcal): pull service — Phase B incremental with horizon filter"
```

---

### Task 17: Single-flight lock around pull

**Files:**

- Modify: `src/services/google-calendar/pull.service.ts`
- Test: `tests/unit/services/google-calendar/pull.service.singleflight.test.ts`

- [ ] **Step 1: Failing test** — two parallel calls to `pullConnection(id)` with the same id should only result in ONE `events.list` call
      (the second is short-circuited by the lock).

- [ ] **Step 2: Implement** — wrap `runIncrementalPull` with a Redis `SET key 1 NX EX 60`:

```typescript
import { redis } from '../../utils/redis' // existing redis client
export async function pullConnection(connectionId: string) {
  const lockKey = `gcal:pull:${connectionId}`
  const got = await redis.set(lockKey, '1', 'NX', 'EX', 60)
  if (got !== 'OK') return // another worker has it
  try {
    await runIncrementalPull(connectionId)
  } finally {
    await redis.del(lockKey).catch(() => {})
  }
}
```

- [ ] **Step 3: Wire up RabbitMQ consumer**

In `src/server.ts` (or wherever RabbitMQ consumers are bootstrapped), add a consumer for `gcal.pull` that invokes
`pullConnection(msg.connectionId)`.

- [ ] **Step 4: Run, commit**

```bash
git commit -m "feat(gcal): single-flight Redis lock around pull + RabbitMQ consumer"
```

---

### Task 18: Auth-error handling (refresh + invalid_grant)

**Files:**

- Modify: `src/services/google-calendar/pull.service.ts`
- Modify: `src/services/google-calendar/oauth.service.ts` (add `refreshAccessToken`)
- Test: `tests/unit/services/google-calendar/pull.service.auth.test.ts`

- [ ] **Step 1: Failing tests** — 401 → refresh succeeds → new access token saved + retry; 401 → refresh fails with `invalid_grant` →
      connection status → `TOKEN_REVOKED`, busy blocks dropped.

- [ ] **Step 2: Implement `refreshAccessToken` in oauth.service**

```typescript
export async function refreshAccessToken(refreshToken: string) {
  const client = buildOAuthClient()
  client.setCredentials({ refresh_token: refreshToken })
  const { credentials } = await client.refreshAccessToken()
  return credentials
}
```

- [ ] **Step 3: Implement `handleAuthError` in pull.service**

```typescript
async function handleAuthError(connectionId: string) {
  const conn = await prisma.googleCalendarConnection.findUnique({ where: { id: connectionId } })
  if (!conn) return
  try {
    const creds = await refreshAccessToken(decryptToken(conn.refreshTokenCiphertext))
    await prisma.googleCalendarConnection.update({
      where: { id: conn.id },
      data: {
        accessTokenCiphertext: encryptToken(creds.access_token!),
        accessTokenExpiresAt: new Date(creds.expiry_date ?? Date.now() + 3600_000),
      },
    })
    // Retry incremental once; if it 401s again we let it bubble.
    return runIncrementalPull(connectionId)
  } catch (err: any) {
    if (err.response?.data?.error === 'invalid_grant' || /invalid_grant/.test(err.message ?? '')) {
      await prisma.$transaction([
        prisma.externalBusyBlock.deleteMany({ where: { googleConnectionId: conn.id } }),
        prisma.googleCalendarConnection.update({
          where: { id: conn.id },
          data: { status: 'TOKEN_REVOKED', statusReason: 'invalid_grant' },
        }),
      ])
      // TODO Phase 3: notify user via email/in-app
      return
    }
    throw err
  }
}
```

- [ ] **Step 4: Run, expect PASS, commit**

```bash
git commit -m "feat(gcal): refresh access token + handle invalid_grant"
```

---

### Task 19: Inbox sweeper job

**Files:**

- Create: `src/jobs/gcal-inbox-sweeper.job.ts`
- Modify: `src/server.ts` (register job)
- Test: `tests/unit/jobs/gcal-inbox-sweeper.test.ts`

- [ ] **Step 1: Failing test** — Inbox row with `processedAt=null, receivedAt < NOW-1min` triggers `pullConnection`; row gets `processedAt`
      set after.

- [ ] **Step 2: Implement** — every 30s, query unprocessed Inbox rows grouped by `connectionId`, call `pullConnection`, mark processed.

```typescript
// src/jobs/gcal-inbox-sweeper.job.ts
import prisma from '../utils/prisma'
import { pullConnection } from '../services/google-calendar/pull.service'

export async function runInboxSweeper() {
  const rows = await prisma.googleCalendarWebhookInbox.findMany({
    where: {
      processedAt: null,
      receivedAt: { lt: new Date(Date.now() - 60_000) }, // 1 min grace
    },
    distinct: ['connectionId'],
    take: 100,
  })
  for (const row of rows) {
    try {
      await pullConnection(row.connectionId)
      await prisma.googleCalendarWebhookInbox.updateMany({
        where: { connectionId: row.connectionId, processedAt: null },
        data: { processedAt: new Date() },
      })
    } catch (err: any) {
      await prisma.googleCalendarWebhookInbox.updateMany({
        where: { connectionId: row.connectionId, processedAt: null },
        data: { attempts: { increment: 1 }, lastError: String(err.message).slice(0, 500) },
      })
    }
  }
}
```

Register in `server.ts`:

```typescript
setInterval(runInboxSweeper, 30_000)
```

- [ ] **Step 3: Run, commit**

```bash
git commit -m "feat(gcal): inbox sweeper job — 30s tick"
```

---

### Task 20: Channel renewal job

**Files:**

- Create: `src/jobs/gcal-channel-renewal.job.ts`
- Modify: `src/server.ts`
- Test: `tests/unit/jobs/gcal-channel-renewal.test.ts`

- [ ] **Step 1: Failing test** — channel with `expiresAt < NOW+48h` triggers `subscribeToCalendar` for the renewal, old channel marked
      `RENEWING` then `STOPPED`, new channel inserted as `ACTIVE`, 3 consecutive failures → connection `WATCH_FAILED`.

- [ ] **Step 2: Implement** — every 12h, find channels expiring soon, call `subscribeToCalendar` for each, mark old `STOPPED`, insert new.

```typescript
// src/jobs/gcal-channel-renewal.job.ts
import prisma from '../utils/prisma'
import { subscribeToCalendar, stopChannel } from '../services/google-calendar/watch-channel.service'
import { decryptToken } from '../services/google-calendar/encryption.service'

const RENEWAL_WINDOW_MS = 48 * 3600_000

export async function runChannelRenewal() {
  const channels = await prisma.googleCalendarChannel.findMany({
    where: { status: 'ACTIVE', expiresAt: { lt: new Date(Date.now() + RENEWAL_WINDOW_MS) } },
    include: { connection: true },
    take: 200,
  })
  for (const ch of channels) {
    try {
      const newCh = await subscribeToCalendar({
        accessToken: decryptToken(ch.connection.accessTokenCiphertext!),
        refreshToken: decryptToken(ch.connection.refreshTokenCiphertext),
        calendarId: ch.connection.selectedCalendarId,
        webhookUrl: `${process.env.GOOGLE_CALENDAR_WEBHOOK_BASE}/api/v1/webhooks/google-calendar`,
      })
      await prisma.$transaction([
        prisma.googleCalendarChannel.update({ where: { id: ch.id }, data: { status: 'RENEWING' } }),
        prisma.googleCalendarChannel.create({
          data: {
            connectionId: ch.connectionId,
            channelId: newCh.channelId,
            resourceId: newCh.resourceId,
            token: newCh.token,
            expiresAt: newCh.expiresAt,
            status: 'ACTIVE',
          },
        }),
      ])
      // Stop old channel at Google (best-effort)
      stopChannel({
        accessToken: decryptToken(ch.connection.accessTokenCiphertext!),
        refreshToken: decryptToken(ch.connection.refreshTokenCiphertext),
        channelId: ch.channelId,
        resourceId: ch.resourceId,
      }).catch(() => {})
      await prisma.googleCalendarChannel.update({ where: { id: ch.id }, data: { status: 'STOPPED', stoppedAt: new Date() } })
    } catch (err) {
      // Track failures via channel.status; after 3 failures, escalate connection to WATCH_FAILED.
      // (For brevity: simple attempt counter pattern — add `renewalAttempts` to GoogleCalendarChannel in this task's migration if not present.)
    }
  }
}
```

Register: `setInterval(runChannelRenewal, 12 * 3600_000)`.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(gcal): channel renewal cron — every 12h"
```

---

### Task 21: Horizon refresh job

**Files:**

- Create: `src/jobs/gcal-horizon-refresh.job.ts`
- Modify: `src/server.ts`
- Test: `tests/unit/jobs/gcal-horizon-refresh.test.ts`

- [ ] **Step 1: Failing test** — given a CONNECTED connection with `lastHorizonEnd = NOW + 30d`, after this job runs with
      `maxAdvanceDays=60`, a windowed events.list is called with `timeMin = NOW + 30d, timeMax = NOW + 60d`, new rows are upserted,
      `lastHorizonEnd` is updated, `syncToken` is NOT changed.

- [ ] **Step 2: Implement** — see spec §8.1.5.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(gcal): horizon refresh cron — daily 04:00"
```

---

### Task 22: Pruning + health-check jobs

**Files:**

- Create: `src/jobs/gcal-pruning.job.ts`
- Create: `src/jobs/gcal-health-check.job.ts`
- Modify: `src/server.ts`

- [ ] **Step 1: Implement pruning** — daily, `DELETE FROM "ExternalBusyBlock" WHERE "endsAt" < NOW() - INTERVAL '7 days'`.

- [ ] **Step 2: Implement health check** — daily, for connections with `lastSyncedAt < NOW-24h`, do `calendarList.get(selectedCalendarId)`.
      403/404 → status `CALENDAR_LOST`; 401 → run `handleAuthError`.

- [ ] **Step 3: Register both in `server.ts`** with daily intervals.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(gcal): pruning + health check cron jobs"
```

---

## Section D — Conflict check integration

### Task 23: `checkExternalBusyBlock` helper

**Files:**

- Create: `src/services/reservation/external-busy-block.service.ts`
- Test: `tests/unit/services/reservation/external-busy-block.service.test.ts`

- [ ] **Step 1: Failing tests** — overlap matrix from spec §16.1: venue/staff/both/neither ×
      exact-bound/partial-inside/fully-inside/fully-outside × staffId null/set.

```typescript
// 16 test cases minimum. Example:
it('returns block when venue-master block overlaps exactly', async () => {
  await createBlock({ venueId: 'V', startsAt: '10:00', endsAt: '11:00' })
  const r = await checkExternalBusyBlock(prisma, { venueId: 'V', staffId: null, startsAt: at('10:00'), endsAt: at('11:00') })
  expect(r?.id).toBeDefined()
})
it('returns null when no overlap', async () => { ... })
it('staff-personal block does NOT block when staffId is null in query', async () => { ... })
it('staff-personal block blocks at venue A AND venue B (multi-venue staff)', async () => { ... })
```

- [ ] **Step 2: Implement**

```typescript
// src/services/reservation/external-busy-block.service.ts
import { Prisma } from '@prisma/client'

export async function checkExternalBusyBlock(
  tx: Prisma.TransactionClient,
  args: { venueId: string; staffId?: string | null; startsAt: Date; endsAt: Date },
) {
  const orClauses: Prisma.ExternalBusyBlockWhereInput[] = [{ venueId: args.venueId }]
  if (args.staffId) orClauses.push({ staffId: args.staffId })
  return tx.externalBusyBlock.findFirst({
    where: { OR: orClauses, startsAt: { lt: args.endsAt }, endsAt: { gt: args.startsAt } },
  })
}
```

- [ ] **Step 3: Run, expect PASS, commit**

```bash
git commit -m "feat(gcal): checkExternalBusyBlock helper with overlap matrix tests"
```

---

### Task 24: Integrate into `createReservation`

**Files:**

- Modify: `src/services/dashboard/reservation.dashboard.service.ts` (around line 252)
- Test: `tests/api-tests/reservations/create-blocked-by-external.test.ts`

- [ ] **Step 1: Failing API test** — given a venue with `ExternalBusyBlock` for staff S at 3pm, attempt to create a Reservation via the
      dashboard for S at 3pm → expect 409/422 with `external_calendar_busy`.

- [ ] **Step 2: Insert call inside the existing SERIALIZABLE transaction**

Locate the `$transaction` block in `createReservation`. Immediately AFTER the venue lookup and BEFORE the existing reservation/staff overlap
checks, insert:

```typescript
const block = await checkExternalBusyBlock(tx, {
  venueId: venueId,
  staffId: data.assignedStaffId ?? null,
  startsAt: data.startsAt,
  endsAt: data.endsAt,
})
if (block) {
  throw new ConflictError('external_calendar_busy', {
    externalSource: block.externalSource,
    blockStartsAt: block.startsAt,
    blockEndsAt: block.endsAt,
  })
}
```

- [ ] **Step 3: Run, expect PASS, commit**

```bash
git commit -m "feat(gcal): createReservation rejects when ExternalBusyBlock overlaps"
```

---

### Task 25: Integrate into `updateReservation`

**Files:**

- Modify: `src/services/dashboard/reservation.dashboard.service.ts` (around line 821)
- Test: `tests/api-tests/reservations/update-blocked-by-external.test.ts`

- [ ] **Step 1: Failing test** — reschedule a reservation onto a slot that has a Google event → 409.

- [ ] **Step 2: Insert call inside the existing update SERIALIZABLE transaction** with the NEW (target) `startsAt/endsAt/assignedStaffId`
      (NOT the current values).

- [ ] **Step 3: Run, expect PASS, commit**

```bash
git commit -m "feat(gcal): updateReservation rejects reschedule onto external busy time"
```

---

### Task 26: Integrate into public booking + slot hold

**Files:**

- Modify: `src/controllers/public/reservation.public.controller.ts` (around lines 551, 1616)
- Test: `tests/api-tests/public/booking-blocked-by-external.test.ts`

- [ ] **Step 1: Failing tests** — public `POST /reservations` AND `POST /reservations/hold` both reject when a Google event covers the slot.

- [ ] **Step 2: Insert calls inside the existing advisory-lock-wrapped transactions** at both sites. Use the same throw pattern as Task 24.

- [ ] **Step 3: Run, expect PASS, commit**

```bash
git commit -m "feat(gcal): public booking + slot hold reject external busy slots"
```

---

### Task 27: Integrate into availability read path

**Files:**

- Modify: `src/services/dashboard/reservationAvailability.service.ts` (around line 92)
- Test: `tests/unit/services/dashboard/reservationAvailability.test.ts`

- [ ] **Step 1: Failing test** — `getAvailableSlots` for a venue+staff with an `ExternalBusyBlock` in window should exclude that slot from
      results.

- [ ] **Step 2: Modify the busy-intervals computation**

Locate the section that gathers existing Reservation + SlotHold busy intervals. UNION an additional query:

```typescript
const externalBlocks = await prisma.externalBusyBlock.findMany({
  where: {
    OR: [
      { venueId, startsAt: { lt: rangeEnd }, endsAt: { gt: rangeStart } },
      ...(staffId ? [{ staffId, startsAt: { lt: rangeEnd }, endsAt: { gt: rangeStart } }] : []),
    ],
  },
  select: { startsAt: true, endsAt: true },
})
// Merge into busy intervals (same array the existing logic uses for Reservations + SlotHolds)
busyIntervals.push(...externalBlocks.map(b => ({ startsAt: b.startsAt, endsAt: b.endsAt })))
```

- [ ] **Step 3: Run, expect PASS, commit**

```bash
git commit -m "feat(gcal): getAvailableSlots unions ExternalBusyBlock"
```

---

## Section E — E2E + Regression

### Task 28: E2E workflow — connect → backfill → block visible

**Files:**

- Create: `tests/workflows/google-calendar-phase1.test.ts`

- [ ] **Step 1: Write E2E test**

```typescript
// Pseudocode for the workflow:
// 1. Seed venue + staff + ReservationSettings(maxAdvanceDays=60).
// 2. Mock Google: oauth2 token exchange + id_token verify + calendarList.get + events.list.
// 3. Drive init → callback → calendars → connections endpoints.
// 4. Assert GoogleCalendarConnection row exists, GoogleCalendarChannel row exists, syncToken=null.
// 5. Manually run pullConnection(id) — assert ExternalBusyBlock rows match mocked events, syncToken/lastHorizonEnd set.
// 6. Attempt to create a reservation overlapping a synced event → 409.
// 7. Attempt to create a reservation in a free slot → 201.
```

- [ ] **Step 2: Run, expect PASS, commit**

```bash
git commit -m "test(gcal): E2E workflow Phase 1 — connect, backfill, conflict reject"
```

---

### Task 29: E2E workflow — webhook → pull → block updated

**Files:**

- Modify: `tests/workflows/google-calendar-phase1.test.ts`

- [ ] **Step 1: Add test** — POST a valid webhook notification to `/webhooks/google-calendar`, assert Inbox row created, run inbox sweeper,
      assert ExternalBusyBlock updated based on mocked events.list with syncToken.

- [ ] **Step 2: Commit**

```bash
git commit -m "test(gcal): E2E workflow — webhook triggers incremental pull"
```

---

### Task 30: E2E workflow — multi-venue staff

**Files:**

- Modify: `tests/workflows/google-calendar-phase1.test.ts`

- [ ] **Step 1: Add test** — staff Juan works at Venue A and Venue B (via StaffVenue rows). Juan connects his personal calendar. After
      backfill, `ExternalBusyBlock.staffId=Juan, venueId=null`. Attempt to create a reservation for Juan at Venue A overlapping the block
      → 409. Attempt at Venue B overlapping the same block → 409.

- [ ] **Step 2: Commit**

```bash
git commit -m "test(gcal): E2E — staff-personal block applies across venues"
```

---

### Task 31: Regression suite + pre-deploy

**Files:**

- Run: full test suite

- [ ] **Step 1: Run all tests**

```bash
npm test
```

Expected: all green (existing + new).

- [ ] **Step 2: Run pre-deploy simulation**

```bash
npm run pre-deploy
```

Expected: PASS.

- [ ] **Step 3: Manually verify existing reservation flows** — create / update / cancel a reservation in dashboard and public widget with NO
      Google connections. Behavior must be identical to today.

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git commit -m "test(gcal): regression sweep — existing flows unaffected without connections"
```

---

## Self-review checklist (final)

Before declaring Phase 1 done:

- [ ] Stripe webhook tests still pass after the new Google webhook route was inserted in `app.ts`.
- [ ] No `db push` was ever used — all schema changes via `prisma migrate dev`.
- [ ] `GOOGLE_CALENDAR_TOKEN_KEY`, `OAUTH_STATE_SECRET`, and OAuth client credentials are documented in `.env.example` and noted in
      `docs/PRODUCTION_READINESS_CHECKLIST.md`.
- [ ] OAuth consent screen submitted for Google verification (sensitive scope).
- [ ] Webhook URL is HTTPS and reachable from Google's IPs (no auth header required by Google — token in `X-Goog-Channel-Token` is our
      security).
- [ ] No `authorizeRole` introduced — only `checkPermission`.
- [ ] All Zod schemas (request bodies) have Spanish error messages per `.claude/rules/critical-warnings.md`.
- [ ] No PII pushed to Google (Phase 2 concern; we only PULL in Phase 1).
- [ ] Module `GOOGLE_CALENDAR_SYNC` is `defaultEnabled: false`; venues opt in.

---

## Out of scope (Phase 2 and Phase 3 will have their own plans)

- `CalendarSyncOutbox`, `ReservationGoogleEventMapping`, push semantics, `ReservationSettings.googleCalendar*` push flags.
- ClassSession push (one event per class, debounced roster patches).
- Connection-status dashboard UI.
- Dead-letter outbox UI.
- Privacy detail-level preview UI.
- GiST range indexes (optimization for later scale).
- Outlook / iCloud / Apple Calendar.

When you're ready to start Phase 2, write its plan from spec §8.2 + §10 + §11 + §14.
