# Reseñas en el recibo digital + redirección a Google (5★) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a customer-facing 1-5★ rating widget to the public digital receipt that saves every rating internally and, on a perfect 5★, offers a one-tap CTA to leave a public Google review — gated to the PRO plan.

**Architecture:** Backend (`avoqado-server`) is authoritative: it stores the venue's Google review link, resolves the PRO gate + normalized Google URL server-side, and exposes both on the existing public receipt status endpoint. The dashboard (`avoqado-web-dashboard`) adds the config field (Integrations → Google) and the receipt widget. The customer MCP exposes the link read-only to OWNER connections. Sales collateral (`Avoqado-HQ`) is updated to match.

**Tech Stack:** Express + TypeScript + Prisma/PostgreSQL (backend), Zod validation, Jest (backend unit), React 18 + Vite + TanStack Query + Tailwind/Radix + i18next (dashboard), axios (public calls).

## Global Constraints

- **Money/dates:** not applicable to this feature (no money, no date-range math).
- **Migrations:** `npx prisma migrate dev --name <desc>` — NEVER `npx prisma db push`.
- **Zod messages:** SPANISH ONLY (validation middleware shows them raw to users).
- **authContext:** read `(req as any).authContext` — never `req.user`.
- **Tenant isolation:** every query scoped by `venueId`.
- **Permissions/features:** mirrored by exact string name across repos; a mismatch fails silently. Feature code: `GOOGLE_REVIEW_REDIRECT` (exact, everywhere).
- **i18n (dashboard):** all user-facing text via `t()`, with `es` + `en` + `fr` keys (all three namespaces exist for `googleIntegration` and `payment`).
- **Theme (dashboard):** semantic tokens only (`bg-muted`, `text-foreground`…), no hardcoded grays/hex.
- **API prefix:** all dashboard API paths include `/api/v1/`.
- **Public receipt calls:** use `axios` directly with `import.meta.env.VITE_API_URL` (no `withCredentials`; endpoint is `origin:'*'`).
- **Testing hygiene:** after writing/adding Jest tests, run `npx tsc --noEmit` (ts-jest is transpile-only). Backend full check: `npm run pre-deploy`.
- **No prod writes.** All dev/testing on local dev DB. Do NOT run seeds/migrations against production.
- **No git commits/push** until the founder explicitly says "commitea"/"push"/"lanza". The "Commit" steps below stage the work; only run `git commit` if the founder has authorized it for this session. Otherwise leave changes staged/uncommitted and report per slice.

---

# PHASE A — Backend (`avoqado-server`)

Working dir for this phase: `/Users/amieva/Documents/Programming/Avoqado/avoqado-server`

---

### Task A1: Add `googleReviewLink` to `VenueSettings` (schema + migration)

**Files:**
- Modify: `prisma/schema.prisma` (model `VenueSettings`, Reviews section ~line 697-701)

**Interfaces:**
- Produces: `VenueSettings.googleReviewLink: string | null` (Prisma field, nullable, no default).

- [ ] **Step 1: Add the field to the schema**

In `prisma/schema.prisma`, inside `model VenueSettings`, in the `// Reviews` block, after `badReviewAlertRoles`:

```prisma
  // Reviews
  autoReplyReviews    Boolean  @default(false)
  notifyBadReviews    Boolean  @default(true)
  badReviewThreshold  Int      @default(3)
  badReviewAlertRoles String[] @default(["OWNER", "ADMIN", "MANAGER"])
  googleReviewLink    String? // Raw: full Google review URL OR bare Place ID (normalized to a writereview URL on read)
```

- [ ] **Step 2: Create the migration (local dev DB only)**

Run: `npx prisma migrate dev --name add_google_review_link_to_venue_settings`
Expected: migration created under `prisma/migrations/`, applied to local dev DB, Prisma Client regenerated. No prompt about data loss (additive nullable column).

- [ ] **Step 3: Verify the client type**

Run: `npx tsc --noEmit`
Expected: PASS (no type errors; `googleReviewLink` now exists on the `VenueSettings` type).

- [ ] **Step 4: Commit** (only if founder authorized — see Global Constraints)

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(reviews): add googleReviewLink to VenueSettings"
```

---

### Task A2: Google review link validation + normalization util (TDD — highest-risk logic)

**Files:**
- Create: `src/utils/googleReviewLink.ts`
- Test: `tests/unit/utils/googleReviewLink.test.ts`

**Interfaces:**
- Produces:
  - `GOOGLE_REVIEW_DOMAINS: string[]`
  - `validateGoogleReviewLink(raw: string): string | null` — returns a Spanish error message when invalid, or `null` when valid (empty/whitespace counts as valid = "clearing").
  - `normalizeGoogleReviewUrl(raw: string | null | undefined): string | null` — full clickable URL, or `null`.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/utils/googleReviewLink.test.ts`:

```typescript
import { validateGoogleReviewLink, normalizeGoogleReviewUrl } from '../../../src/utils/googleReviewLink'

describe('validateGoogleReviewLink', () => {
  it('accepts a full g.page review URL', () => {
    expect(validateGoogleReviewLink('https://g.page/r/AbC123_/review')).toBeNull()
  })
  it('accepts a search.google.com writereview URL', () => {
    expect(validateGoogleReviewLink('https://search.google.com/local/writereview?placeid=ChIJ12345abc')).toBeNull()
  })
  it('accepts a bare Place ID', () => {
    expect(validateGoogleReviewLink('ChIJ12345abcDEF-_')).toBeNull()
  })
  it('treats empty string as valid (clearing)', () => {
    expect(validateGoogleReviewLink('   ')).toBeNull()
  })
  it('rejects a non-Google URL with a Spanish message', () => {
    const err = validateGoogleReviewLink('https://facebook.com/mypage')
    expect(err).toMatch(/Google/)
  })
  it('rejects a malformed URL', () => {
    expect(validateGoogleReviewLink('http://')).not.toBeNull()
  })
  it('rejects a Place ID with spaces/symbols', () => {
    expect(validateGoogleReviewLink('ChIJ 12/34.5')).not.toBeNull()
  })
  it('rejects a too-short Place ID', () => {
    expect(validateGoogleReviewLink('abc')).not.toBeNull()
  })
})

describe('normalizeGoogleReviewUrl', () => {
  it('passes through a full URL unchanged', () => {
    expect(normalizeGoogleReviewUrl('https://g.page/r/AbC/review')).toBe('https://g.page/r/AbC/review')
  })
  it('builds a writereview URL from a bare Place ID', () => {
    expect(normalizeGoogleReviewUrl('ChIJ12345abc')).toBe('https://search.google.com/local/writereview?placeid=ChIJ12345abc')
  })
  it('returns null for null/empty', () => {
    expect(normalizeGoogleReviewUrl(null)).toBeNull()
    expect(normalizeGoogleReviewUrl('  ')).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/unit/utils/googleReviewLink.test.ts`
Expected: FAIL ("Cannot find module '../../../src/utils/googleReviewLink'").

- [ ] **Step 3: Write the implementation**

Create `src/utils/googleReviewLink.ts`:

```typescript
/**
 * Google review link helpers. A venue owner may paste EITHER a full Google
 * review URL (e.g. https://g.page/r/XXXX/review) OR a bare Place ID (ChIJ...).
 * We store the raw value and normalize to a clickable "write a review" URL on read.
 */

/** Hosts we accept for a pasted full URL. Anything else is rejected. */
export const GOOGLE_REVIEW_DOMAINS = [
  'g.page',
  'goo.gl',
  'maps.app.goo.gl',
  'google.com',
  'www.google.com',
  'search.google.com',
  'maps.google.com',
]

const PLACE_ID_RE = /^[A-Za-z0-9_-]{10,256}$/

/**
 * Returns a SPANISH error message if the value is not a valid Google review
 * link or Place ID, or `null` if it is valid. An empty/whitespace value is
 * treated as valid (it means the owner is clearing the field).
 */
export function validateGoogleReviewLink(raw: string): string | null {
  const v = (raw ?? '').trim()
  if (!v) return null // clearing the field

  if (/^https?:\/\//i.test(v)) {
    let url: URL
    try {
      url = new URL(v)
    } catch {
      return 'El link de Google no es una URL válida.'
    }
    const host = url.hostname.toLowerCase()
    if (!GOOGLE_REVIEW_DOMAINS.includes(host)) {
      return 'El link debe ser de Google (por ejemplo g.page, maps.app.goo.gl o google.com).'
    }
    return null
  }

  if (!PLACE_ID_RE.test(v)) {
    return 'Pega el link completo de Google o solo el Place ID (sin espacios ni símbolos).'
  }
  return null
}

/**
 * Turn the stored raw value into a clickable "write a review" URL:
 *  - a full URL passes through unchanged,
 *  - a bare Place ID becomes a search.google.com writereview URL,
 *  - null/empty returns null.
 */
export function normalizeGoogleReviewUrl(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim()
  if (!v) return null
  if (/^https?:\/\//i.test(v)) return v
  return `https://search.google.com/local/writereview?placeid=${v}`
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/unit/utils/googleReviewLink.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: tsc**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit** (if authorized)

```bash
git add src/utils/googleReviewLink.ts tests/unit/utils/googleReviewLink.test.ts
git commit -m "feat(reviews): add google review link validation + normalization util"
```

---

### Task A3: Wire validation into `UpdateVenueSettingsSchema`

**Files:**
- Modify: `src/schemas/dashboard/venueSettings.schema.ts` (Reviews block in `UpdateVenueSettingsSchema.body`, ~line 61-65)
- Test: `tests/unit/schemas/venueSettings.schema.test.ts`

**Interfaces:**
- Consumes: `validateGoogleReviewLink` from Task A2.
- Produces: `UpdateVenueSettingsSchema` accepts optional `googleReviewLink: string | null` (empty string coerced to `null`); `getVenueSettings` already returns the whole `VenueSettings` row so the field flows to the dashboard read with no controller change.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/schemas/venueSettings.schema.test.ts`:

```typescript
import { UpdateVenueSettingsSchema } from '../../../src/schemas/dashboard/venueSettings.schema'

const parseBody = (body: unknown) =>
  UpdateVenueSettingsSchema.safeParse({ params: { venueId: 'v1' }, body })

describe('UpdateVenueSettingsSchema googleReviewLink', () => {
  it('accepts a valid Place ID', () => {
    const r = parseBody({ googleReviewLink: 'ChIJ12345abc' })
    expect(r.success).toBe(true)
  })
  it('coerces empty string to null (clearing)', () => {
    const r = parseBody({ googleReviewLink: '' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.body.googleReviewLink).toBeNull()
  })
  it('accepts explicit null', () => {
    const r = parseBody({ googleReviewLink: null })
    expect(r.success).toBe(true)
  })
  it('rejects a non-Google URL', () => {
    const r = parseBody({ googleReviewLink: 'https://facebook.com/x' })
    expect(r.success).toBe(false)
  })
  it('still accepts a body without the field (optional)', () => {
    const r = parseBody({ notifyBadReviews: false })
    expect(r.success).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/unit/schemas/venueSettings.schema.test.ts`
Expected: FAIL (googleReviewLink stripped/undefined; `''` not coerced to null).

- [ ] **Step 3: Implement — add the field to the schema**

In `src/schemas/dashboard/venueSettings.schema.ts`:

1. Add the import at the top (after the `zod` import):

```typescript
import { validateGoogleReviewLink } from '../../utils/googleReviewLink'
```

2. In `UpdateVenueSettingsSchema.body`, in the `// Reviews` block right after `badReviewAlertRoles`:

```typescript
    // Reviews
    autoReplyReviews: z.boolean().optional(),
    notifyBadReviews: z.boolean().optional(),
    badReviewThreshold: z.number().int().min(1).max(5).optional(),
    badReviewAlertRoles: z.array(z.enum(['OWNER', 'ADMIN', 'MANAGER', 'CASHIER', 'WAITER', 'KITCHEN', 'HOST', 'VIEWER'])).optional(),
    googleReviewLink: z
      .union([
        z.literal('').transform(() => null),
        z
          .string()
          .trim()
          .max(300, 'El link es demasiado largo.')
          .refine(v => validateGoogleReviewLink(v) === null, v => ({ message: validateGoogleReviewLink(v) ?? 'Link de Google inválido.' })),
      ])
      .nullable()
      .optional(),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/unit/schemas/venueSettings.schema.test.ts`
Expected: PASS.

- [ ] **Step 5: tsc**

Run: `npx tsc --noEmit`
Expected: PASS. (`updateVenueSettings` passes `req.body` straight to `prisma.venueSettings.upsert({ update })`; `googleReviewLink` now flows through, and `getVenueSettings` already returns the full row. `updateVenueSettings` already writes an `ActivityLog` (`SETTINGS_UPDATED`) — no audit change needed.)

- [ ] **Step 6: Commit** (if authorized)

```bash
git add src/schemas/dashboard/venueSettings.schema.ts tests/unit/schemas/venueSettings.schema.test.ts
git commit -m "feat(reviews): validate googleReviewLink in venue settings schema"
```

---

### Task A4: Expose `reviewsEnabled` + `googleReviewUrl` on the public review-status endpoint (TDD)

**Files:**
- Modify: `src/services/tpv/receiptReview.tpv.service.ts` (`canSubmitReview`, ~line 159-208)
- Test: `tests/unit/services/receiptReview.status.test.ts`

**Interfaces:**
- Consumes: `venueHasFeatureAccess(venueId, featureCode)` from `src/services/access/basePlan.service.ts`; `normalizeGoogleReviewUrl` from Task A2.
- Produces: `canSubmitReview(accessKey)` return type gains `reviewsEnabled: boolean` and `googleReviewUrl: string | null`. Existing fields (`canSubmit`, `reason?`, `venue?`) unchanged (backward-compatible). The public controller `checkReviewStatus` returns `result` verbatim, so no controller change is needed.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/services/receiptReview.status.test.ts`:

```typescript
import { canSubmitReview } from '../../../src/services/tpv/receiptReview.tpv.service'

jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    digitalReceipt: { findUnique: jest.fn() },
    venueSettings: { findUnique: jest.fn() },
  },
}))
jest.mock('../../../src/services/access/basePlan.service', () => ({
  venueHasFeatureAccess: jest.fn(),
}))

import prisma from '../../../src/utils/prismaClient'
import { venueHasFeatureAccess } from '../../../src/services/access/basePlan.service'

const mockedPrisma = prisma as unknown as {
  digitalReceipt: { findUnique: jest.Mock }
  venueSettings: { findUnique: jest.Mock }
}
const mockedFeature = venueHasFeatureAccess as jest.Mock

describe('canSubmitReview status extension', () => {
  beforeEach(() => jest.clearAllMocks())

  it('returns reviewsEnabled=true + normalized googleReviewUrl for a PRO venue with a Place ID', async () => {
    mockedPrisma.digitalReceipt.findUnique.mockResolvedValue({
      paymentId: 'p1',
      payment: { venue: { id: 'v1', name: 'Alberto' }, review: null },
    })
    mockedFeature.mockResolvedValue(true)
    mockedPrisma.venueSettings.findUnique.mockResolvedValue({ googleReviewLink: 'ChIJ12345abc' })

    const r = await canSubmitReview('key-1')
    expect(r.canSubmit).toBe(true)
    expect(r.reviewsEnabled).toBe(true)
    expect(r.googleReviewUrl).toBe('https://search.google.com/local/writereview?placeid=ChIJ12345abc')
  })

  it('returns reviewsEnabled=false + null url for a FREE venue', async () => {
    mockedPrisma.digitalReceipt.findUnique.mockResolvedValue({
      paymentId: 'p1',
      payment: { venue: { id: 'v1', name: 'Alberto' }, review: null },
    })
    mockedFeature.mockResolvedValue(false)
    mockedPrisma.venueSettings.findUnique.mockResolvedValue({ googleReviewLink: 'ChIJ12345abc' })

    const r = await canSubmitReview('key-1')
    expect(r.reviewsEnabled).toBe(false)
    expect(r.googleReviewUrl).toBeNull()
  })

  it('returns null url when the venue has no link even if enabled', async () => {
    mockedPrisma.digitalReceipt.findUnique.mockResolvedValue({
      paymentId: 'p1',
      payment: { venue: { id: 'v1', name: 'Alberto' }, review: null },
    })
    mockedFeature.mockResolvedValue(true)
    mockedPrisma.venueSettings.findUnique.mockResolvedValue(null)

    const r = await canSubmitReview('key-1')
    expect(r.reviewsEnabled).toBe(true)
    expect(r.googleReviewUrl).toBeNull()
  })

  it('keeps canSubmit=false when a review already exists', async () => {
    mockedPrisma.digitalReceipt.findUnique.mockResolvedValue({
      paymentId: 'p1',
      payment: { venue: { id: 'v1', name: 'Alberto' }, review: { id: 'r1' } },
    })
    mockedFeature.mockResolvedValue(true)
    mockedPrisma.venueSettings.findUnique.mockResolvedValue({ googleReviewLink: null })

    const r = await canSubmitReview('key-1')
    expect(r.canSubmit).toBe(false)
    expect(r.reason).toBe('Review already submitted')
    expect(r.reviewsEnabled).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/unit/services/receiptReview.status.test.ts`
Expected: FAIL (`reviewsEnabled`/`googleReviewUrl` undefined).

- [ ] **Step 3: Implement — extend `canSubmitReview`**

In `src/services/tpv/receiptReview.tpv.service.ts`:

1. Add imports at the top (after the existing imports):

```typescript
import { venueHasFeatureAccess } from '../access/basePlan.service'
import { normalizeGoogleReviewUrl } from '../../utils/googleReviewLink'
```

2. Replace the `canSubmitReview` function body's return-shape logic. The function currently returns `{ canSubmit, reason?, venue? }`. Update its signature and the three return sites:

```typescript
export async function canSubmitReview(accessKey: string): Promise<{
  canSubmit: boolean
  reason?: string
  venue?: { id: string; name: string }
  reviewsEnabled: boolean
  googleReviewUrl: string | null
}> {
  try {
    const receipt = await prisma.digitalReceipt.findUnique({
      where: { accessKey },
      include: {
        payment: {
          include: {
            venue: { select: { id: true, name: true } },
            review: true, // Check if review already exists
          },
        },
      },
    })

    if (!receipt) {
      return { canSubmit: false, reason: 'Receipt not found', reviewsEnabled: false, googleReviewUrl: null }
    }

    const venue = receipt.payment.venue

    // PRO gate (server-side source of truth) + normalized Google URL, computed in parallel.
    const [reviewsEnabled, settings] = await Promise.all([
      venueHasFeatureAccess(venue.id, 'GOOGLE_REVIEW_REDIRECT'),
      prisma.venueSettings.findUnique({ where: { venueId: venue.id }, select: { googleReviewLink: true } }),
    ])
    const googleReviewUrl = reviewsEnabled ? normalizeGoogleReviewUrl(settings?.googleReviewLink) : null

    if (receipt.payment.review) {
      return { canSubmit: false, reason: 'Review already submitted', venue, reviewsEnabled, googleReviewUrl }
    }

    return { canSubmit: true, venue, reviewsEnabled, googleReviewUrl }
  } catch (error) {
    logger.error('Error checking review eligibility', { accessKey, error })
    return { canSubmit: false, reason: 'Error checking eligibility', reviewsEnabled: false, googleReviewUrl: null }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/unit/services/receiptReview.status.test.ts`
Expected: PASS.

- [ ] **Step 5: Regression — the review submit path is untouched**

Run: `npx jest tests/unit/services/ --testPathPattern receiptReview`
Expected: PASS (submit flow unaffected; only `canSubmitReview` changed).

- [ ] **Step 6: tsc**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit** (if authorized)

```bash
git add src/services/tpv/receiptReview.tpv.service.ts tests/unit/services/receiptReview.status.test.ts
git commit -m "feat(reviews): expose reviewsEnabled + googleReviewUrl on review-status endpoint"
```

---

### Task A5: Seed the `GOOGLE_REVIEW_REDIRECT` Feature (dev)

**Files:**
- Create: `scripts/seed-google-review-feature.ts` (mirrors `scripts/seed-cfdi-feature.ts`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a `Feature` row `{ code: 'GOOGLE_REVIEW_REDIRECT' }` so the feature is grantable per-venue from the superadmin control and appears in catalogs. NOTE: gating already works WITHOUT this row for PRO/PREMIUM venues (`venueHasFeatureAccess` grants any non-`PREMIUM_ONLY_CODES` code by tier — see `basePlan.service.ts`). This seed only enables explicit per-venue grants and catalog display.

- [ ] **Step 1: Read the reference seed to copy its exact shape**

Run: `sed -n '1,80p' scripts/seed-cfdi-feature.ts`
Expected: shows the `prisma.feature.upsert({ where: { code }, ... })` pattern, including required fields (`name`, `description`, pricing/category columns). Copy those exact column names.

- [ ] **Step 2: Write the seed script**

Create `scripts/seed-google-review-feature.ts`, mirroring `seed-cfdi-feature.ts` field-for-field but with:

```typescript
// Values specific to this feature (copy every OTHER required column verbatim from seed-cfdi-feature.ts):
//   code:        'GOOGLE_REVIEW_REDIRECT'
//   name:        'Reseñas y redirección a Google'
//   description: 'Calificación con estrellas en el recibo digital; las de 5★ se canalizan a Google Reviews.'
//   monthlyPrice / category / etc.: match how CFDI sets a PRO-included (non-standalone) feature,
//     or the closest existing included-feature seed. Do NOT invent columns not present in the model.
```

If `seed-cfdi-feature.ts` sets a standalone price for a paid add-on, prefer copying a bundled/included feature seed instead (e.g. grep `scripts/` for a seed of `LOYALTY_PROGRAM` or `RESERVATIONS`); this feature is PRO-included, not a standalone add-on.

- [ ] **Step 3: Run the seed against LOCAL dev DB only**

Run: `npx ts-node -r tsconfig-paths/register scripts/seed-google-review-feature.ts`
Expected: logs an upsert of the `GOOGLE_REVIEW_REDIRECT` feature; exit 0.

- [ ] **Step 4: Verify**

Run: `npx ts-node -e "import('./src/utils/prismaClient').then(async m => { const f = await m.default.feature.findUnique({ where: { code: 'GOOGLE_REVIEW_REDIRECT' } }); console.log(f); process.exit(0) })" -r tsconfig-paths/register`
Expected: prints the feature row (not null).

- [ ] **Step 5: Commit** (if authorized)

```bash
git add scripts/seed-google-review-feature.ts
git commit -m "chore(reviews): seed GOOGLE_REVIEW_REDIRECT feature"
```

---

### Task A6: Expose `googleReviewUrl` in the customer MCP `venue_profile` — OWNER only

**Files:**
- Modify: `src/mcp/tools/venues.ts` (`venue_profile` tool, ~line 55-100)
- Test: none (thin read tool; covered by manual MCP check). Optional smoke via existing MCP test harness if present.

**Interfaces:**
- Consumes: `normalizeGoogleReviewUrl` from Task A2; `scope.perVenueAccess` (Map → `UserAccess` with `.role`).
- Produces: `venue_profile` response gains `reviews: { googleReviewUrl: string | null }` ONLY when the connected user's venue role is `OWNER` or `SUPERADMIN`; otherwise the field is omitted entirely.

- [ ] **Step 1: Implement the OWNER-gated field**

In `src/mcp/tools/venues.ts`:

1. Add import at the top:

```typescript
import { normalizeGoogleReviewUrl } from '@/utils/googleReviewLink'
```

2. Inside the `venue_profile` handler, after the existing `const v = await prisma.venue.findFirst(...)` block and the `if (!v) return ...` guard, before the final `return text(...)`:

```typescript
      // OWNER-only: expose the venue's Google-review redirect link. Roles differ
      // per venue, so read this venue's role from scope (never a global role).
      const role = scope.perVenueAccess.get(venueId)?.role
      const isOwnerLevel = role === 'OWNER' || role === 'SUPERADMIN'
      let googleReviewUrl: string | null = null
      if (isOwnerLevel) {
        const settings = await prisma.venueSettings.findUnique({
          where: { venueId },
          select: { googleReviewLink: true },
        })
        googleReviewUrl = normalizeGoogleReviewUrl(settings?.googleReviewLink)
      }
```

3. Add the field to the returned `profile` object ONLY when owner-level (spread conditionally so non-owners never see the key):

```typescript
      return text({
        found: true,
        venueId,
        profile: {
          name: v.name,
          slug: v.slug,
          type: v.type,
          currency: v.currency,
          timezone: v.timezone,
          language: v.language,
          active: v.active,
          address: { line: v.address, city: v.city, state: v.state, country: v.country, zip: v.zipCode },
          contact: { phone: v.phone, email: v.email, website: v.website },
          ...(isOwnerLevel ? { reviews: { googleReviewUrl } } : {}),
        },
      })
```

- [ ] **Step 2: Update the tool description**

Change the `venue_profile` description string to note the owner-only field, e.g. append: `" For OWNER connections it also includes reviews.googleReviewUrl (the venue's Google-review redirect link)."`

- [ ] **Step 3: tsc**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Manual smoke (optional, local)**

If the MCP dev harness is available, connect as an OWNER and call `venue_profile` → expect `reviews.googleReviewUrl`; connect as a non-owner (e.g. MANAGER) → the `reviews` key is absent.

- [ ] **Step 5: Commit** (if authorized)

```bash
git add src/mcp/tools/venues.ts
git commit -m "feat(mcp): expose googleReviewUrl in venue_profile (owner only)"
```

---

### Task A7: Backend slice green-check

- [ ] **Step 1: Full pre-deploy**

Run: `npm run pre-deploy`
Expected: build + lint + tests PASS. Report the result. This closes the backend slice.

---

# PHASE B — Dashboard (`avoqado-web-dashboard`)

Working dir for this phase: `/Users/amieva/Documents/Programming/Avoqado/avoqado-web-dashboard`

---

### Task B1: Add `GOOGLE_REVIEW_REDIRECT` to the PRO tier catalog

**Files:**
- Modify: `src/config/plan-catalog.ts` (PRO block `includes` array, ~line 55-67)

**Interfaces:**
- Produces: `getTierForFeature('GOOGLE_REVIEW_REDIRECT')` resolves to PRO; `useTierFeatureAccess('GOOGLE_REVIEW_REDIRECT')` / `<FeatureGate feature="GOOGLE_REVIEW_REDIRECT">` unlock for PRO+ venues.

- [ ] **Step 1: Add the code to PRO.includes**

In `src/config/plan-catalog.ts`, in the `id: 'PRO'` object's `includes` array, add `'GOOGLE_REVIEW_REDIRECT'` (keep it grouped with the other customer-facing PRO features):

```typescript
    includes: [
      'ADVANCED_REPORTS',
      'AVAILABLE_BALANCE',
      'AI_ASSISTANT_BUBBLE',
      'LOYALTY_PROGRAM',
      'REFERRAL_PROGRAM',
      'PROMOTIONS',
      'RESERVATIONS',
      'ONLINE_ORDERING',
      'BANK_RECONCILIATION',
      'BANKING_HUB',
      'VENUE_AUDIT_LOG',
      'GOOGLE_REVIEW_REDIRECT',
    ],
```

- [ ] **Step 2: Typecheck**

Run: `npm run build` (or `npx tsc --noEmit -p tsconfig.json` if faster)
Expected: PASS.

- [ ] **Step 3: Commit** (if authorized)

```bash
git add src/config/plan-catalog.ts
git commit -m "feat(reviews): add GOOGLE_REVIEW_REDIRECT to PRO tier catalog"
```

---

### Task B2: Frontend mirror of the link validation/normalization util

**Files:**
- Create: `src/lib/googleReviewLink.ts`

**Interfaces:**
- Produces (mirror of the backend util — same names, same rules):
  - `validateGoogleReviewLink(raw: string): string | null` (Spanish error or null)
  - `normalizeGoogleReviewUrl(raw: string | null | undefined): string | null`

- [ ] **Step 1: Create the util (identical logic to the backend, so validation/preview match)**

Create `src/lib/googleReviewLink.ts` with the SAME implementation as `avoqado-server/src/utils/googleReviewLink.ts` (copy `GOOGLE_REVIEW_DOMAINS`, `PLACE_ID_RE`, `validateGoogleReviewLink`, `normalizeGoogleReviewUrl` verbatim — it is framework-free TS). This gives the config form instant, matching validation before the PUT.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit** (if authorized)

```bash
git add src/lib/googleReviewLink.ts
git commit -m "feat(reviews): frontend google review link util (mirror of backend)"
```

---

### Task B3: Config card in `GoogleIntegration.tsx` (Integrations → Google), PRO-gated

**Files:**
- Modify: `src/pages/Settings/GoogleIntegration.tsx`
- Modify: `src/locales/es/googleIntegration.json`, `src/locales/en/googleIntegration.json`, `src/locales/fr/googleIntegration.json`

**Interfaces:**
- Consumes: `validateGoogleReviewLink` from B2; `<FeatureGate feature="GOOGLE_REVIEW_REDIRECT">` from `@/components/billing/FeatureGate`; existing settings endpoints `GET/PUT /api/v1/dashboard/venues/${venueId}/settings`.
- Produces: a card where OWNER/ADMIN paste the venue's Google review link or Place ID; saved to `VenueSettings.googleReviewLink`.

- [ ] **Step 1: Add i18n keys (es + en + fr)**

In each `googleIntegration.json`, add a `reviewRedirect` block. Spanish (`es`):

```json
"reviewRedirect": {
  "title": "Link de reseñas de Google",
  "description": "Cuando un cliente califica con 5 estrellas en el recibo, lo enviamos a dejar su reseña en Google. Pega el link de tu perfil de Google (Perfil de Empresa → “Obtener más reseñas”) o solo tu Place ID.",
  "inputLabel": "Link de Google o Place ID",
  "placeholder": "https://g.page/r/XXXX/review  o  ChIJ...",
  "save": "Guardar",
  "saved": "Link de reseñas guardado",
  "saveError": "No se pudo guardar el link",
  "clearHint": "Deja el campo vacío para desactivar la redirección a Google."
}
```

English (`en`) and French (`fr`): same keys, translated (French may reuse English wording if no reviewer — but the keys MUST exist in all three files to satisfy the missing-key lint).

- [ ] **Step 2: Add the card component to `GoogleIntegration.tsx`**

Add imports needed (`Input`, `FeatureGate`, `validateGoogleReviewLink`, `useState`, `useMutation`, `useQuery`). Inside the component, add a query for current settings and a mutation to save. Render, near the top of the returned JSX (e.g. right after the header `</div>`), the following card wrapped in `<FeatureGate feature="GOOGLE_REVIEW_REDIRECT">`:

```tsx
<FeatureGate feature="GOOGLE_REVIEW_REDIRECT">
  <Card>
    <CardHeader>
      <CardTitle>{t('reviewRedirect.title')}</CardTitle>
      <CardDescription>{t('reviewRedirect.description')}</CardDescription>
    </CardHeader>
    <CardContent className="space-y-3">
      <Label htmlFor="google-review-link">{t('reviewRedirect.inputLabel')}</Label>
      <Input
        id="google-review-link"
        value={reviewLink}
        onChange={e => {
          setReviewLink(e.target.value)
          setReviewLinkError(validateGoogleReviewLink(e.target.value))
        }}
        placeholder={t('reviewRedirect.placeholder')}
        className="h-11"
      />
      {reviewLinkError && <p className="text-sm text-destructive">{reviewLinkError}</p>}
      <p className="text-xs text-muted-foreground">{t('reviewRedirect.clearHint')}</p>
      <Button
        onClick={() => saveReviewLinkMutation.mutate(reviewLink)}
        disabled={!!reviewLinkError || saveReviewLinkMutation.isPending}
      >
        {saveReviewLinkMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
        {t('reviewRedirect.save')}
      </Button>
    </CardContent>
  </Card>
</FeatureGate>
```

Wire the supporting state + queries in the component body:

```tsx
const [reviewLink, setReviewLink] = useState('')
const [reviewLinkError, setReviewLinkError] = useState<string | null>(null)

const { data: venueSettings } = useQuery({
  queryKey: ['venue-settings', venueId],
  queryFn: async () => (await api.get(`/api/v1/dashboard/venues/${venueId}/settings`)).data,
  enabled: !!venueId,
})
useEffect(() => {
  if (venueSettings?.googleReviewLink != null) setReviewLink(venueSettings.googleReviewLink)
}, [venueSettings?.googleReviewLink])

const saveReviewLinkMutation = useMutation({
  mutationFn: async (link: string) =>
    (await api.put(`/api/v1/dashboard/venues/${venueId}/settings`, { googleReviewLink: link })).data,
  onSuccess: () => {
    toast({ title: t('reviewRedirect.saved') })
    queryClient.invalidateQueries({ queryKey: ['venue-settings', venueId] })
  },
  onError: (error: any) =>
    toast({ variant: 'destructive', title: t('reviewRedirect.saveError'), description: error?.response?.data?.message }),
})
```

(Reuse the existing `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `Button`, `toast`, `queryClient`, `venueId`, `Loader2` already imported/available in the file. Add `Input`, `Label`, `FeatureGate`, `useEffect`, `useState`, `useMutation` where missing.)

- [ ] **Step 3: Build + lint (catches missing i18n keys and hardcoded colors)**

Run: `npm run build && npm run lint`
Expected: PASS. (`no-missing-translation-keys` passes because keys exist in es/en/fr; no hardcoded colors — used `text-destructive`/`text-muted-foreground`.)

- [ ] **Step 4: Manual check (dev server)**

Start `npm run dev`, open a PRO venue → Configuración → Integraciones → Google. Confirm the card renders, pasting a Facebook URL shows the Spanish error and disables Save, pasting a Place ID enables Save, saving shows the success toast. On a FREE venue the card shows the FeatureGate upsell teaser instead.

- [ ] **Step 5: Commit** (if authorized)

```bash
git add src/pages/Settings/GoogleIntegration.tsx src/locales/es/googleIntegration.json src/locales/en/googleIntegration.json src/locales/fr/googleIntegration.json
git commit -m "feat(reviews): google review link config card in integrations (PRO-gated)"
```

---

### Task B4: `ReceiptReviewWidget` component

**Files:**
- Create: `src/components/receipts/ReceiptReviewWidget.tsx`
- Modify: `src/locales/es/payment.json`, `src/locales/en/payment.json`, `src/locales/fr/payment.json`

**Interfaces:**
- Consumes: public endpoints `GET/POST /api/v1/public/receipt/${accessKey}/review` and `/review/status` (the status now returns `reviewsEnabled`, `googleReviewUrl`, `canSubmit`, `reason`).
- Produces: `<ReceiptReviewWidget accessKey={string} />` — renders nothing unless `reviewsEnabled`; otherwise a 1-5★ form; on 5★ success with a `googleReviewUrl` shows a primary CTA to Google.

- [ ] **Step 1: Add i18n keys (es + en + fr) under `receipt.review`**

In each `payment.json`, add under the existing `receipt` object a `review` block. Spanish:

```json
"review": {
  "title": "¿Cómo estuvo tu experiencia?",
  "commentPlaceholder": "Cuéntanos más (opcional)",
  "namePlaceholder": "Tu nombre (opcional)",
  "submit": "Enviar calificación",
  "submitting": "Enviando...",
  "thanksTitle": "¡Gracias por tu opinión!",
  "thanksBody": "Tu calificación nos ayuda a mejorar.",
  "googleTitle": "¡Gracias! ⭐",
  "googleBody": "¿Nos ayudas con una reseña en Google? Toma 10 segundos.",
  "googleCta": "Califícanos en Google",
  "alreadyRated": "Ya calificaste este ticket",
  "error": "No se pudo enviar tu calificación. Inténtalo de nuevo.",
  "ratingRequired": "Selecciona una calificación"
}
```

English + French: same keys, translated (keys must exist in all three).

- [ ] **Step 2: Create the widget**

Create `src/components/receipts/ReceiptReviewWidget.tsx`:

```tsx
import { useState } from 'react'
import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Star, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'

interface ReviewStatus {
  canSubmit: boolean
  reason?: string
  reviewsEnabled: boolean
  googleReviewUrl: string | null
}

const API_BASE = import.meta.env.VITE_API_URL

export function ReceiptReviewWidget({ accessKey }: { accessKey: string }) {
  const { t } = useTranslation('payment')
  const [rating, setRating] = useState(0)
  const [hover, setHover] = useState(0)
  const [comment, setComment] = useState('')
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { data: status } = useQuery({
    queryKey: ['public-review-status', accessKey],
    queryFn: async () => (await axios.get<{ success: boolean; data: ReviewStatus }>(
      `${API_BASE}/api/v1/public/receipt/${accessKey}/review/status`,
    )).data.data,
    enabled: !!accessKey,
    retry: 1,
  })

  // Hide entirely unless the venue's plan enables reviews.
  if (!status?.reviewsEnabled) return null

  // Already rated → quiet confirmation.
  const alreadyRated = status.canSubmit === false && status.reason === 'Review already submitted'

  const showGoogleCta = submitted && rating === 5 && !!status.googleReviewUrl

  const handleSubmit = async () => {
    if (rating === 0) {
      setError(t('receipt.review.ratingRequired'))
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      // ALWAYS save internally first (source=AVOQADO server-side), regardless of rating.
      await axios.post(`${API_BASE}/api/v1/public/receipt/${accessKey}/review`, {
        overallRating: rating,
        comment: comment.trim() || null,
        customerName: name.trim() || null,
      })
      setSubmitted(true)
    } catch {
      setError(t('receipt.review.error'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rounded-2xl border border-border/50 bg-card p-6 space-y-4">
      {alreadyRated ? (
        <p className="text-sm font-medium text-muted-foreground">✅ {t('receipt.review.alreadyRated')}</p>
      ) : submitted ? (
        showGoogleCta ? (
          <div className="space-y-3 text-center">
            <h3 className="text-lg font-semibold">{t('receipt.review.googleTitle')}</h3>
            <p className="text-sm text-muted-foreground">{t('receipt.review.googleBody')}</p>
            <Button
              size="lg"
              className="w-full"
              onClick={() => window.open(status.googleReviewUrl!, '_blank', 'noopener,noreferrer')}
            >
              <Star className="w-5 h-5 mr-2" />
              {t('receipt.review.googleCta')}
            </Button>
          </div>
        ) : (
          <div className="space-y-1 text-center">
            <h3 className="text-lg font-semibold">{t('receipt.review.thanksTitle')}</h3>
            <p className="text-sm text-muted-foreground">{t('receipt.review.thanksBody')}</p>
          </div>
        )
      ) : (
        <>
          <h3 className="text-lg font-semibold text-center">{t('receipt.review.title')}</h3>
          <div className="flex justify-center gap-1">
            {[1, 2, 3, 4, 5].map(v => (
              <button
                key={v}
                type="button"
                aria-label={`${v}`}
                onMouseEnter={() => setHover(v)}
                onMouseLeave={() => setHover(0)}
                onClick={() => { setRating(v); setError(null) }}
                className="p-1 cursor-pointer"
              >
                <Star
                  className={`w-9 h-9 transition-colors ${
                    v <= (hover || rating) ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/40'
                  }`}
                />
              </button>
            ))}
          </div>
          <Textarea
            value={comment}
            onChange={e => setComment(e.target.value)}
            placeholder={t('receipt.review.commentPlaceholder')}
            rows={3}
          />
          <Input value={name} onChange={e => setName(e.target.value)} placeholder={t('receipt.review.namePlaceholder')} />
          {error && <p className="text-sm text-destructive text-center">{error}</p>}
          <Button onClick={handleSubmit} disabled={submitting} className="w-full" size="lg">
            {submitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            {submitting ? t('receipt.review.submitting') : t('receipt.review.submit')}
          </Button>
        </>
      )}
    </div>
  )
}
```

(If `Textarea` is not at `@/components/ui/textarea`, grep `src/components/ui` for the correct export and adjust the import.)

- [ ] **Step 3: Build + lint**

Run: `npm run build && npm run lint`
Expected: PASS (all `receipt.review.*` keys exist in es/en/fr; semantic tokens only).

- [ ] **Step 4: Commit** (if authorized)

```bash
git add src/components/receipts/ReceiptReviewWidget.tsx src/locales/es/payment.json src/locales/en/payment.json src/locales/fr/payment.json
git commit -m "feat(reviews): receipt review widget with 5-star Google redirect CTA"
```

---

### Task B5: Wire the widget into the public receipt

**Files:**
- Modify: `src/components/receipts/ModernReceiptDesign.tsx` (props interface ~line 39-57; render near `autofacturaSlot` ~line 613)
- Modify: `src/pages/Payment/ReceiptViewer.tsx` (~line 165-184)

**Interfaces:**
- Consumes: `<ReceiptReviewWidget />` from B4; the existing `autofacturaSlot` render pattern.
- Produces: `ModernReceiptDesign` gains an optional `reviewSlot?: React.ReactNode`, rendered in the public (`full`) layout; `ReceiptViewer` passes the widget only in public, non-refund view.

- [ ] **Step 1: Add the `reviewSlot` prop**

In `src/components/receipts/ModernReceiptDesign.tsx`, in `interface ModernReceiptDesignProps`, next to `autofacturaSlot?: React.ReactNode`:

```tsx
  autofacturaSlot?: React.ReactNode
  reviewSlot?: React.ReactNode
```

Add `reviewSlot` to the destructured props in the component signature (next to `autofacturaSlot`).

- [ ] **Step 2: Render it**

Near where `{autofacturaSlot}` is rendered (~line 613), add the review slot right after it:

```tsx
          {autofacturaSlot}
          {reviewSlot}
```

- [ ] **Step 3: Pass the widget from `ReceiptViewer`**

In `src/pages/Payment/ReceiptViewer.tsx`, add the import:

```tsx
import { ReceiptReviewWidget } from '@/components/receipts/ReceiptReviewWidget'
```

Then add the `reviewSlot` prop to the `<ModernReceiptDesign ... />` element, right after `autofacturaSlot`:

```tsx
      reviewSlot={
        // Public view only, and not for refund receipts. The widget self-hides
        // unless the venue's plan enables reviews (reviewsEnabled from the status endpoint).
        isPublicView && accessKey && !isRefund ? <ReceiptReviewWidget accessKey={accessKey} /> : undefined
      }
```

- [ ] **Step 4: Build + lint**

Run: `npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 5: Manual end-to-end (dev)**

With a PRO venue that has a `googleReviewLink` set: open a real public receipt URL (`/receipts/public/:accessKey`). Confirm: the widget appears; rating 5★ + submit → success screen with "Califícanos en Google" that opens the link in a new tab; rating ≤4★ + submit → "¡Gracias!" with no Google CTA; reload → "Ya calificaste este ticket". On a FREE venue receipt: the widget does not appear at all.

- [ ] **Step 6: Commit** (if authorized)

```bash
git add src/components/receipts/ModernReceiptDesign.tsx src/pages/Payment/ReceiptViewer.tsx
git commit -m "feat(reviews): wire review widget into public receipt"
```

---

### Task B6: Dashboard slice green-check

- [ ] **Step 1: Full checks**

Run: `npm run build && npm run lint && npm run test:e2e`
Expected: build + lint PASS; e2e PASS (no regressions). Report result. This closes the dashboard slice.

---

# PHASE C — Sales collateral (`Avoqado-HQ`)

Working dir: `~/Documents/Programming/Avoqado-HQ/operations/marketing/platform-presentation`

---

### Task C1: Update deck + one-pager and regenerate PDFs

**Files:**
- Modify: the full deck HTML and the one-pager HTML (the canonical current files — confirm exact names from that folder's `README.md`; candidates present include `avoqado-one-pager.html`, `avoqado-one-pager-v2.html`).
- Regenerate: the matching PDFs via the folder's `README.md` pipeline (Chrome-headless HTML→PDF).

**Interfaces:**
- Consumes: nothing (documentation).
- Produces: both deliverables mention the new capability so third-party sellers don't fall behind the platform.

- [ ] **Step 1: Read the README to learn the exact canonical files + regeneration command**

Run: `sed -n '1,120p' README.md`
Expected: identifies which HTML is the current deck and which is the current one-pager, and the exact command to regenerate each PDF.

- [ ] **Step 2: Add the capability to BOTH HTML files**

In the features/modules section of each, add a short bullet, e.g.:
> **Reseñas y reputación** — Calificación con estrellas en el recibo digital; las reseñas de 5★ se canalizan automáticamente a Google, las demás quedan internas para el negocio. (Plan PRO.)

Keep wording consistent with the existing copy style; mark it PRO where tiers are shown.

- [ ] **Step 3: Regenerate both PDFs**

Run the exact command(s) from the README (Chrome-headless HTML→PDF) for the deck and the one-pager.
Expected: both PDFs updated with the new bullet.

- [ ] **Step 4: Commit** (if authorized)

```bash
git add .
git commit -m "docs(marketing): add receipt reviews + Google redirect (PRO) to deck and one-pager"
```

---

## Self-Review (author checklist — completed during planning)

**Spec coverage:** every spec section maps to a task —
data model→A1; validation/normalization→A2; schema wiring→A3; status endpoint fields→A4; PRO Feature→A5+B1; MCP owner-only→A6; config UI→B3; widget→B4; wiring→B5; deck→C1. `ActivityLog` requirement: satisfied by the existing `SETTINGS_UPDATED` write in `updateVenueSettings` (noted in A3).

**Placeholder scan:** no "TBD/TODO". The only intentionally-open item is A5's exact non-code column names for the Feature seed, which is handled by copying from `seed-cfdi-feature.ts` (a concrete reference file, per the "repeat the code / point at the reference" rule) — the plan tells the implementer exactly which file to copy and which fields to change.

**Type consistency:** `validateGoogleReviewLink` / `normalizeGoogleReviewUrl` names identical across backend (A2) and frontend (B2); `reviewsEnabled` + `googleReviewUrl` names identical across A4 (producer), B4 (consumer), and A6 (`googleReviewUrl`). Feature code `GOOGLE_REVIEW_REDIRECT` identical across A4, A5, A6, B1, B3. `reviewSlot` identical across B4/B5.

## Dependency order

A1 → A2 → A3 → A4 → (A5, A6) → A7 → B1 → B2 → B3/B4 → B5 → B6 → C1.
Backend fully precedes dashboard (dashboard consumes the extended status endpoint + the tier catalog). Deck last.
