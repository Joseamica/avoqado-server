# WhatsApp OTP Customer Login — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Passwordless customer portal login via WhatsApp OTP (phone → code → in), keeping email+password and the `?manage=` magic-link
working.

**Architecture:** New `OtpChallenge` table + an isolated `otpAuth.public.service`. `request` generates a hashed 6-digit code and sends it
via the approved WhatsApp `otp_verify` template (email fallback). `verify` validates, then does **hybrid identity resolution** (global
`Consumer` by phone → per-venue `Customer` → existing `generateCustomerToken`), returning the same `{ token, customer }` shape as
`loginCustomer` so the portal/middleware/widget are unchanged. All additive.

**Tech Stack:** Express + TypeScript, Prisma/PostgreSQL, Jest (`prismaMock`), WhatsApp Cloud API, Preact widget.

**Spec:** `docs/superpowers/specs/2026-06-05-whatsapp-otp-customer-login-design.md` (source of truth).

---

## File structure

**avoqado-server:**

- `prisma/schema.prisma` — add `OtpChallenge` model + `PHONE` to `AuthProvider` (Modify)
- `src/services/public/otpAuth.public.service.ts` — OTP request/verify + identity resolution (Create)
- `src/lib/otp.ts` — pure helpers: `generateOtpCode`, `hashOtpCode`, `normalizeEmail` (Create)
- `src/controllers/public/otpAuth.public.controller.ts` — `requestOtp`, `verifyOtp` HTTP handlers (Create)
- `src/schemas/dashboard/creditPack.schema.ts` — add `otpRequestSchema`, `otpVerifySchema` (Modify)
- `src/routes/public.routes.ts` — wire 2 routes (Modify, additive)
- `src/services/whatsapp.service.ts` — add `sendOtpWhatsApp(phone, code)` sender (Modify, additive)
- `src/services/email.service.ts` — add `sendOtpCodeEmail(email, code)` (Modify, additive)
- `tests/unit/lib/otp.test.ts` (Create)
- `tests/unit/services/public/otpAuth.public.service.test.ts` (Create)

**avoqado-booking-widget:**

- `src/api/booking.ts` — add `requestOtp`, `verifyOtp` (Modify)
- `src/components/CustomerPortal.tsx` — add "Entrar con WhatsApp" login mode (Modify)
- `src/i18n/es.json`, `src/i18n/en.json` — OTP strings (Modify)

---

## Task 1: Prisma — `OtpChallenge` model + `AuthProvider.PHONE`

**Files:**

- Modify: `prisma/schema.prisma` (the `AuthProvider` enum ~line 6015 + add a new model)

- [ ] **Step 1: Add `PHONE` to the `AuthProvider` enum**

Find `enum AuthProvider {` and add `PHONE`:

```prisma
enum AuthProvider {
  EMAIL
  GOOGLE
  FACEBOOK
  APPLE
  PHONE
}
```

- [ ] **Step 2: Add the `OtpChallenge` model** (place near the `Consumer` model)

```prisma
model OtpChallenge {
  id          String    @id @default(cuid())
  channel     String    // 'whatsapp' | 'email'
  destination String    // E.164 phone OR lowercased email
  codeHash    String    // sha256(code + OTP_PEPPER); never store plaintext
  expiresAt   DateTime
  attempts    Int       @default(0)
  maxAttempts Int       @default(5)
  consumedAt  DateTime?
  ip          String?
  createdAt   DateTime  @default(now())

  @@index([destination, expiresAt])
}
```

- [ ] **Step 3: Create the migration** (coordinate ordering with the parallel CFDI session — run after a fresh `git pull`/their migration
      lands)

Run: `npx prisma migrate dev --name add_otp_challenge_and_phone_provider` Expected: migration created + applied; `npx prisma generate` runs.

- [ ] **Step 4: Verify the client regenerated**

Run: `npx tsc -p tsconfig.build.json --noEmit 2>&1 | grep -c "error TS"` Expected: `0`

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(otp): add OtpChallenge model + AuthProvider.PHONE

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Pure OTP helpers (`src/lib/otp.ts`)

**Files:**

- Create: `src/lib/otp.ts`
- Test: `tests/unit/lib/otp.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { generateOtpCode, hashOtpCode, normalizeEmail } from '@/lib/otp'

describe('otp helpers', () => {
  it('generateOtpCode returns a 6-digit numeric string', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateOtpCode()
      expect(code).toMatch(/^\d{6}$/)
    }
  })

  it('hashOtpCode is deterministic and not the plaintext', () => {
    process.env.OTP_PEPPER = 'test-pepper'
    const h1 = hashOtpCode('123456')
    const h2 = hashOtpCode('123456')
    expect(h1).toBe(h2)
    expect(h1).not.toContain('123456')
    expect(hashOtpCode('654321')).not.toBe(h1)
  })

  it('normalizeEmail lowercases + trims', () => {
    expect(normalizeEmail('  Foo@Bar.COM ')).toBe('foo@bar.com')
  })
})
```

- [ ] **Step 2: Run it — expect FAIL** (`Cannot find module '@/lib/otp'`)

Run: `npx jest tests/unit/lib/otp.test.ts`

- [ ] **Step 3: Implement `src/lib/otp.ts`**

```ts
import crypto from 'crypto'

/** 6-digit numeric OTP, uniformly distributed across 000000–999999. */
export function generateOtpCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0')
}

/** sha256(code + pepper). The pepper is a server secret so a DB leak alone
 *  can't brute-force the (tiny) code space offline. */
export function hashOtpCode(code: string): string {
  const pepper = process.env.OTP_PEPPER
  if (!pepper) throw new Error('OTP_PEPPER no está configurado')
  return crypto.createHash('sha256').update(`${code}:${pepper}`).digest('hex')
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npx jest tests/unit/lib/otp.test.ts`

- [ ] **Step 5: Add `OTP_PEPPER` to env**

Add to `.env` (and document in `.env.example`): `OTP_PEPPER=<random 32+ char string>`. Add to `src/config/env.ts` zod schema:
`OTP_PEPPER: z.string().min(16)`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/otp.ts tests/unit/lib/otp.test.ts src/config/env.ts .env.example
git commit -m "feat(otp): pure code helpers (generate/hash/normalize)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: WhatsApp + email OTP senders

**Files:**

- Modify: `src/services/whatsapp.service.ts` (add `sendOtpWhatsApp`)
- Modify: `src/services/email.service.ts` (add `sendOtpCodeEmail`)

- [ ] **Step 1: Add `sendOtpWhatsApp`** at the end of `whatsapp.service.ts`

The `otp_verify` template is Authentication-category: the code goes in the body `{{1}}` AND the copy-code button. The button component shape
is identical to the existing `buttonUrlParam` path (`sub_type: 'url'`, index `0`, the value as the text param), so we **reuse**
`sendTemplateMessage` by passing the code as both the body param and the button param.

```ts
/**
 * Send a login OTP via the approved Authentication template `otp_verify`.
 * Body {{1}} = code; the copy-code button also receives the code (same component
 * shape as a dynamic-URL button — see sendTemplateMessage's buttonUrlParam).
 */
export async function sendOtpWhatsApp(phone: string, code: string): Promise<boolean> {
  await sendTemplateMessage(phone, 'otp_verify', [{ type: 'text', text: code }], code)
  return true
}
```

> ⚠️ Two things to verify on the first real send (Task 9 E2E):
>
> 1. **Language code:** `sendTemplateMessage` hardcodes `es_MX`. If `otp_verify` was registered as plain `es`, Meta returns "template name
>    does not exist in es_MX" → register/clone the template as `es_MX` (matching the existing reservation templates) OR parametrize the
>    language. Verify in the WhatsApp send logs.
> 2. **Button sub_type:** if Meta rejects the `sub_type:'url'` button for an auth template, add an `otpButton` branch in
>    `sendTemplateMessage` emitting `sub_type:'copy_code'` instead. Keep it additive.

- [ ] **Step 2: Add `sendOtpCodeEmail`** to `email.service.ts` (mirror `sendEmailVerification`)

```ts
async sendOtpCodeEmail(email: string, code: string): Promise<boolean> {
  return this.sendEmail({
    to: email,
    subject: `${code} es tu código de acceso`,
    html: `<p>Tu código de acceso es <strong style="font-size:20px">${code}</strong>.</p><p>Vence en 10 minutos. Si no lo pediste, ignora este correo.</p>`,
    text: `Tu código de acceso es ${code}. Vence en 10 minutos.`,
  })
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc -p tsconfig.build.json --noEmit 2>&1 | grep -c "error TS"` → Expected: `0`

- [ ] **Step 4: Commit**

```bash
git add src/services/whatsapp.service.ts src/services/email.service.ts
git commit -m "feat(otp): WhatsApp otp_verify + email OTP senders

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `otpAuth.public.service` — `requestOtp`

**Files:**

- Create: `src/services/public/otpAuth.public.service.ts`
- Test: `tests/unit/services/public/otpAuth.public.service.test.ts`

- [ ] **Step 1: Write failing tests** (mirror the `prismaMock` style from `reservation.dashboard.service.test.ts`)

```ts
import { requestOtp } from '@/services/public/otpAuth.public.service'
import { prismaMock } from '@tests/__helpers__/setup'
import * as wa from '@/services/whatsapp.service'

jest.mock('@/services/whatsapp.service')

describe('requestOtp', () => {
  beforeEach(() => {
    jest.resetAllMocks()
    process.env.OTP_PEPPER = 'test-pepper'
    ;(wa.sendOtpWhatsApp as jest.Mock).mockResolvedValue(true)
  })

  it('expires prior challenges, stores a hashed code, sends WhatsApp, returns { ok:true }', async () => {
    prismaMock.otpChallenge.updateMany.mockResolvedValue({ count: 0 } as any)
    prismaMock.otpChallenge.count.mockResolvedValue(0) // rate-limit checks
    prismaMock.otpChallenge.create.mockResolvedValue({ id: 'otp-1' } as any)

    const res = await requestOtp({ venueId: 'v1', channel: 'whatsapp', destination: '+525555550199', ip: '1.2.3.4' })

    expect(res).toEqual({ ok: true })
    expect(prismaMock.otpChallenge.updateMany).toHaveBeenCalled() // expire prior
    const created = prismaMock.otpChallenge.create.mock.calls[0][0].data
    expect(created.codeHash).toMatch(/^[a-f0-9]{64}$/) // hashed, not plaintext
    expect(created.channel).toBe('whatsapp')
    expect(wa.sendOtpWhatsApp).toHaveBeenCalledWith('+525555550199', expect.stringMatching(/^\d{6}$/))
  })

  it('rate-limits: throws when >=5 challenges in the last hour for the destination', async () => {
    prismaMock.otpChallenge.updateMany.mockResolvedValue({ count: 0 } as any)
    prismaMock.otpChallenge.count.mockResolvedValueOnce(0).mockResolvedValueOnce(5) // 30s ok, hourly hit
    await expect(requestOtp({ venueId: 'v1', channel: 'whatsapp', destination: '+525555550199', ip: '1.2.3.4' })).rejects.toThrow(
      /demasiad/i,
    )
  })
})
```

- [ ] **Step 2: Run — expect FAIL** (module not found)

Run: `npx jest tests/unit/services/public/otpAuth.public.service.test.ts`

- [ ] **Step 3: Implement `requestOtp`** (+ shared helpers used by verify in Task 5)

```ts
import prisma from '../../utils/prismaClient'
import { BadRequestError } from '../../errors/AppError'
import logger from '../../config/logger'
import { generateOtpCode, hashOtpCode, normalizeEmail } from '../../lib/otp'
import { sendOtpWhatsApp } from '../whatsapp.service'
import emailService from '../email.service'

const TTL_MS = 10 * 60 * 1000

/** E.164-ish normalization: keep a leading +, strip the rest of non-digits. */
function normalizePhone(phone: string): string {
  const digits = phone.replace(/[^\d]/g, '')
  return `+${digits}`
}

export async function requestOtp(args: {
  venueId: string
  channel: 'whatsapp' | 'email'
  destination: string
  ip?: string | null
}): Promise<{ ok: true }> {
  const destination = args.channel === 'email' ? normalizeEmail(args.destination) : normalizePhone(args.destination)
  const now = Date.now()

  // Rate-limit: <=1 per 30s and <=5 per hour per destination.
  const last30s = await prisma.otpChallenge.count({
    where: { destination, createdAt: { gt: new Date(now - 30_000) } },
  })
  if (last30s > 0) throw new BadRequestError('Espera un momento antes de pedir otro código.')
  const lastHour = await prisma.otpChallenge.count({
    where: { destination, createdAt: { gt: new Date(now - 3_600_000) } },
  })
  if (lastHour >= 5) throw new BadRequestError('Demasiados códigos solicitados. Intenta más tarde.')

  // Invalidate prior unconsumed challenges for this destination.
  await prisma.otpChallenge.updateMany({
    where: { destination, consumedAt: null },
    data: { consumedAt: new Date() },
  })

  const code = generateOtpCode()
  await prisma.otpChallenge.create({
    data: {
      channel: args.channel,
      destination,
      codeHash: hashOtpCode(code),
      expiresAt: new Date(now + TTL_MS),
      ip: args.ip ?? null,
    },
  })

  try {
    if (args.channel === 'whatsapp') await sendOtpWhatsApp(destination, code)
    else await emailService.sendOtpCodeEmail(destination, code)
  } catch (err) {
    // Don't leak send failures as a different response; log + still return ok.
    logger.warn(`[OTP] send failed for ${args.channel}:${destination}: ${(err as Error).message}`)
  }

  return { ok: true } // never reveal whether the destination is known
}
```

- [ ] **Step 4: Add `otpChallenge` to the prisma mock** in `tests/__helpers__/setup.ts` (it auto-mocks listed models)

Add `otpChallenge: createMockModel(),` to the `prismaMock` object.

- [ ] **Step 5: Run — expect PASS**

Run: `npx jest tests/unit/services/public/otpAuth.public.service.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/services/public/otpAuth.public.service.ts tests/unit/services/public/otpAuth.public.service.test.ts tests/__helpers__/setup.ts
git commit -m "feat(otp): requestOtp service (rate-limited, hashed, channel send)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: `otpAuth.public.service` — `verifyOtp` + hybrid identity resolution

**Files:**

- Modify: `src/services/public/otpAuth.public.service.ts`
- Modify: `tests/unit/services/public/otpAuth.public.service.test.ts`

- [ ] **Step 1: Add failing tests**

```ts
import { verifyOtp } from '@/services/public/otpAuth.public.service'
import { generateCustomerToken } from '@/jwt.service'
jest.mock('@/jwt.service', () => ({ generateCustomerToken: jest.fn(() => 'tok_123') }))

const validChallenge = (over = {}) => ({
  id: 'otp-1',
  channel: 'whatsapp',
  destination: '+525555550199',
  codeHash: require('@/lib/otp').hashOtpCode('123456'),
  expiresAt: new Date(Date.now() + 60_000),
  attempts: 0,
  maxAttempts: 5,
  consumedAt: null,
  ...over,
})

describe('verifyOtp', () => {
  beforeEach(() => {
    jest.resetAllMocks()
    process.env.OTP_PEPPER = 'test-pepper'
    ;(generateCustomerToken as jest.Mock).mockReturnValue('tok_123')
  })

  it('rejects an expired challenge → 400', async () => {
    prismaMock.otpChallenge.findFirst.mockResolvedValue(validChallenge({ expiresAt: new Date(Date.now() - 1000) }))
    await expect(verifyOtp({ venueId: 'v1', channel: 'whatsapp', destination: '+525555550199', code: '123456' })).rejects.toThrow(/expir/i)
  })

  it('wrong code increments attempts and rejects generically', async () => {
    prismaMock.otpChallenge.findFirst.mockResolvedValue(validChallenge())
    await expect(verifyOtp({ venueId: 'v1', channel: 'whatsapp', destination: '+525555550199', code: '000000' })).rejects.toThrow(
      /incorrecto/i,
    )
    expect(prismaMock.otpChallenge.update).toHaveBeenCalledWith(expect.objectContaining({ data: { attempts: 1 } }))
  })

  it('too many attempts → invalidates + rejects', async () => {
    prismaMock.otpChallenge.findFirst.mockResolvedValue(validChallenge({ attempts: 5 }))
    await expect(verifyOtp({ venueId: 'v1', channel: 'whatsapp', destination: '+525555550199', code: '123456' })).rejects.toThrow(
      /intentos/i,
    )
  })

  it('valid code → resolves Consumer+Customer, issues customer-token', async () => {
    prismaMock.otpChallenge.findFirst.mockResolvedValue(validChallenge())
    prismaMock.consumer.findFirst.mockResolvedValue(null)
    prismaMock.consumer.create.mockResolvedValue({ id: 'cons-1' })
    prismaMock.customer.findFirst.mockResolvedValue(null)
    prismaMock.customer.create.mockResolvedValue({ id: 'cust-1', firstName: null, lastName: null, email: null, phone: '+525555550199' })

    const res = await verifyOtp({ venueId: 'v1', channel: 'whatsapp', destination: '+525555550199', code: '123456' })

    expect(res.token).toBe('tok_123')
    expect(res.customer.id).toBe('cust-1')
    expect(generateCustomerToken).toHaveBeenCalledWith('cust-1', 'v1')
    expect(prismaMock.otpChallenge.update).toHaveBeenCalledWith(expect.objectContaining({ data: { consumedAt: expect.any(Date) } }))
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx jest tests/unit/services/public/otpAuth.public.service.test.ts -t verifyOtp`

- [ ] **Step 3: Implement `verifyOtp` + `resolveIdentity`**

```ts
import { generateCustomerToken } from '../../jwt.service'

export async function verifyOtp(args: { venueId: string; channel: 'whatsapp' | 'email'; destination: string; code: string }): Promise<{
  token: string
  customer: { id: string; firstName: string | null; lastName: string | null; email: string | null; phone: string | null }
}> {
  const destination = args.channel === 'email' ? normalizeEmail(args.destination) : normalizePhone(args.destination)

  const challenge = await prisma.otpChallenge.findFirst({
    where: { destination, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  })
  if (!challenge || challenge.expiresAt.getTime() <= Date.now()) {
    throw new BadRequestError('El código expiró. Pide uno nuevo.')
  }
  if (challenge.attempts >= challenge.maxAttempts) {
    await prisma.otpChallenge.update({ where: { id: challenge.id }, data: { consumedAt: new Date() } })
    throw new BadRequestError('Demasiados intentos. Pide un código nuevo.')
  }
  if (challenge.codeHash !== hashOtpCode(args.code)) {
    await prisma.otpChallenge.update({ where: { id: challenge.id }, data: { attempts: challenge.attempts + 1 } })
    throw new BadRequestError('Código incorrecto.')
  }

  await prisma.otpChallenge.update({ where: { id: challenge.id }, data: { consumedAt: new Date() } })

  const isPhone = args.channel === 'whatsapp'
  const customer = await resolveIdentity(args.venueId, isPhone ? { phone: destination } : { email: destination })
  const token = generateCustomerToken(customer.id, args.venueId)
  return {
    token,
    customer: { id: customer.id, firstName: customer.firstName, lastName: customer.lastName, email: customer.email, phone: customer.phone },
  }
}

/**
 * Hybrid identity: find/create the GLOBAL Consumer (phone is NOT unique → 0:create,
 * 1:use, >1:oldest+log), then find/create the per-venue Customer linked to it, then
 * the caller issues the customer-token. Customer has @@unique([venueId, phone]) and
 * @@unique([venueId, email]) so the per-venue upsert can't duplicate.
 */
async function resolveIdentity(venueId: string, key: { phone?: string; email?: string }) {
  // 1. Global Consumer
  let consumer
  if (key.phone) {
    const matches = await prisma.consumer.findMany({ where: { phone: key.phone }, orderBy: { createdAt: 'asc' }, take: 2 })
    if (matches.length > 1) logger.warn(`[OTP] multiple Consumers share phone ${key.phone}; using oldest ${matches[0].id}`)
    consumer = matches[0] ?? (await prisma.consumer.create({ data: { phone: key.phone } }))
  } else {
    consumer =
      (await prisma.consumer.findFirst({ where: { email: key.email } })) ?? (await prisma.consumer.create({ data: { email: key.email } }))
  }

  // 2. Per-venue Customer (by phone/email or by consumerId), create+link if none.
  const where = key.phone ? { venueId_phone: { venueId, phone: key.phone } } : { venueId_email: { venueId, email: key.email! } }
  let customer = await prisma.customer.findUnique({ where: where as any })
  if (!customer) {
    customer = await prisma.customer.findFirst({ where: { venueId, consumerId: consumer.id } })
  }
  if (!customer) {
    customer = await prisma.customer.create({
      data: { venueId, consumerId: consumer.id, provider: 'PHONE', ...(key.phone ? { phone: key.phone } : { email: key.email }) },
    })
  } else if (!customer.consumerId) {
    customer = await prisma.customer.update({ where: { id: customer.id }, data: { consumerId: consumer.id } })
  }
  return customer
}
```

- [ ] **Step 4: Add `consumer` + `customer` to the prisma mock** if not already present in `tests/__helpers__/setup.ts` (customer is likely
      there; add `consumer: createMockModel(),` if missing).

- [ ] **Step 5: Run — expect PASS**

Run: `npx jest tests/unit/services/public/otpAuth.public.service.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/services/public/otpAuth.public.service.ts tests/unit/services/public/otpAuth.public.service.test.ts tests/__helpers__/setup.ts
git commit -m "feat(otp): verifyOtp + hybrid Consumer/Customer identity resolution

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Zod schemas + controllers + routes

**Files:**

- Modify: `src/schemas/dashboard/creditPack.schema.ts` (add OTP schemas)
- Create: `src/controllers/public/otpAuth.public.controller.ts`
- Modify: `src/routes/public.routes.ts` (additive — coordinate with CFDI session)

- [ ] **Step 1: Add Zod schemas** (Spanish messages, shape-only) to `creditPack.schema.ts`

```ts
export const otpRequestSchema = z
  .object({
    phone: z.string().min(8).optional(),
    email: z.string().email('Correo inválido').optional(),
  })
  .refine(d => Boolean(d.phone) || Boolean(d.email), { message: 'Proporciona teléfono o correo', path: ['phone'] })

export const otpVerifySchema = z
  .object({
    phone: z.string().min(8).optional(),
    email: z.string().email().optional(),
    code: z.string().regex(/^\d{6}$/, 'El código debe ser de 6 dígitos'),
  })
  .refine(d => Boolean(d.phone) || Boolean(d.email), { message: 'Proporciona teléfono o correo', path: ['phone'] })
```

- [ ] **Step 2: Create the controller** (mirror `customerPortal.public.controller.ts`: resolve venue by slug → call service → `res.json`)

```ts
import { Request, Response, NextFunction } from 'express'
import * as otpService from '../../services/public/otpAuth.public.service'
import { resolveVenueBySlug } from './reservation.public.controller' // reuse if exported; else replicate the lookup used by customerPortal controller

export async function requestOtp(req: Request, res: Response, next: NextFunction) {
  try {
    const venue = await resolveVenueBySlug(req.params.venueSlug)
    const { phone, email } = req.body as { phone?: string; email?: string }
    const channel = phone ? 'whatsapp' : 'email'
    await otpService.requestOtp({ venueId: venue.id, channel, destination: (phone ?? email)!, ip: req.ip })
    res.json({ ok: true })
  } catch (error) {
    next(error)
  }
}

export async function verifyOtp(req: Request, res: Response, next: NextFunction) {
  try {
    const venue = await resolveVenueBySlug(req.params.venueSlug)
    const { phone, email, code } = req.body as { phone?: string; email?: string; code: string }
    const channel = phone ? 'whatsapp' : 'email'
    const result = await otpService.verifyOtp({ venueId: venue.id, channel, destination: (phone ?? email)!, code })
    res.json(result)
  } catch (error) {
    next(error)
  }
}
```

> If `resolveVenueBySlug` is not exported from `reservation.public.controller.ts`, copy the same venue-lookup the
> `customerPortal.public.controller.ts` `login` handler uses (it resolves the venue from `:venueSlug`). Do not invent a new lookup.

- [ ] **Step 3: Wire routes** in `public.routes.ts` — add the import to the `reservation.schema`/`creditPack.schema` import block and
      register (additive, near the customer routes):

```ts
import * as otpAuthController from '../controllers/public/otpAuth.public.controller'
// ...add otpRequestSchema, otpVerifySchema to the creditPack.schema import...

router.post(
  '/venues/:venueSlug/auth/otp/request',
  writeLimit,
  validateRequest(z.object({ params: publicVenueParamsSchema, body: otpRequestSchema })),
  otpAuthController.requestOtp,
)

router.post(
  '/venues/:venueSlug/auth/otp/verify',
  authLimit,
  validateRequest(z.object({ params: publicVenueParamsSchema, body: otpVerifySchema })),
  otpAuthController.verifyOtp,
)
```

- [ ] **Step 4: Typecheck + lint**

Run: `npx tsc -p tsconfig.build.json --noEmit 2>&1 | grep -c "error TS"` → `0` Run:
`npx eslint src/controllers/public/otpAuth.public.controller.ts src/routes/public.routes.ts src/schemas/dashboard/creditPack.schema.ts` →
exit 0

- [ ] **Step 5: Commit**

```bash
git add src/controllers/public/otpAuth.public.controller.ts src/routes/public.routes.ts src/schemas/dashboard/creditPack.schema.ts
git commit -m "feat(otp): public request/verify routes + schemas + controller

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Widget API client

**Files:**

- Modify: `avoqado-booking-widget/src/api/booking.ts`

- [ ] **Step 1: Add `requestOtp` + `verifyOtp`** (after `customerLogin`)

```ts
export function requestOtp(slug: string, data: { phone?: string; email?: string }): Promise<{ ok: true }> {
  return request(`${BASE}/venues/${slug}/auth/otp/request`, { method: 'POST', body: JSON.stringify(data) })
}

export function verifyOtp(slug: string, data: { phone?: string; email?: string; code: string }): Promise<AuthResponse> {
  return request(`${BASE}/venues/${slug}/auth/otp/verify`, { method: 'POST', body: JSON.stringify(data) })
}
```

- [ ] **Step 2: Build**

Run (in widget repo): `npm run build` → Expected: `✓ built`

- [ ] **Step 3: Commit**

```bash
git add src/api/booking.ts
git commit -m "feat(otp): widget API client (requestOtp/verifyOtp)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Widget login UI — "Entrar con WhatsApp"

**Files:**

- Modify: `avoqado-booking-widget/src/components/CustomerPortal.tsx`
- Modify: `avoqado-booking-widget/src/i18n/es.json`, `src/i18n/en.json`

- [ ] **Step 1: Add i18n keys** under a new `otp` object in `es.json` + `en.json`:

```json
"otp": {
  "title": "Entrar con WhatsApp",
  "phoneLabel": "Tu número de WhatsApp",
  "sendCode": "Enviar código",
  "sent": "Te enviamos un código por WhatsApp",
  "codeLabel": "Código de 6 dígitos",
  "verify": "Entrar",
  "resend": "Reenviar código",
  "resendIn": "Reenviar en {{s}}s",
  "useEmail": "Usar correo",
  "useEmailLabel": "Tu correo",
  "errorExpired": "El código expiró. Pide uno nuevo.",
  "errorInvalid": "Código incorrecto.",
  "orPassword": "o entra con correo y contraseña"
}
```

(en.json: English equivalents.)

- [ ] **Step 2: Add the OTP login mode to `CustomerPortal`** — a two-step form (phone → code) that calls `api.requestOtp` then
      `api.verifyOtp`, stores the returned token via the same mechanism the existing email/password login uses (set the customer token +
      load portal), with a 30s resend cooldown and a "usar correo" toggle. Keep the existing email+password form behind an "o entra con
      correo y contraseña" link.

Key handlers (wire into the existing portal state/token storage — follow the current `customerLogin` success path):

```tsx
const [otpStep, setOtpStep] = useState<'phone' | 'code'>('phone')
const [phone, setPhone] = useState('')
const [code, setCode] = useState('')
const [cooldown, setCooldown] = useState(0)
const [otpError, setOtpError] = useState<string | null>(null)

async function sendCode() {
  setOtpError(null)
  try {
    await api.requestOtp(venueSlug, { phone })
    setOtpStep('code')
    setCooldown(30)
  } catch (e: any) {
    setOtpError(e.data?.message ?? t('errors.generic'))
  }
}
async function submitCode() {
  setOtpError(null)
  try {
    const auth = await api.verifyOtp(venueSlug, { phone, code })
    onAuthenticated(auth) // same callback/token-store the email login uses
  } catch (e: any) {
    setOtpError(e.data?.message ?? t('otp.errorInvalid'))
  }
}
// cooldown tick: useEffect(() => { if (!cooldown) return; const id=setInterval(()=>setCooldown(c=>c-1),1000); return ()=>clearInterval(id) }, [cooldown])
```

> Use the EXACT token-storage path the current `customerLogin` success uses in this component (find where `customerLogin`'s result is
> consumed and reuse it for `verifyOtp`'s identical `AuthResponse`). Do not invent a new token store.

- [ ] **Step 3: Build**

Run: `npm run build` → Expected: `✓ built`

- [ ] **Step 4: Commit**

```bash
git add src/components/CustomerPortal.tsx src/i18n/es.json src/i18n/en.json
git commit -m "feat(otp): WhatsApp OTP login UI in CustomerPortal + i18n

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Full verification (live E2E)

- [ ] **Step 1: Backend suite green**

Run: `npx jest tests/unit/lib/otp.test.ts tests/unit/services/public/otpAuth.public.service.test.ts` → all PASS

- [ ] **Step 2: Live OTP request (localhost)** — pick a real venue slug, real WhatsApp number:

```bash
curl -s -X POST "http://localhost:3000/api/v1/public/venues/<slug>/auth/otp/request" \
  -H "Content-Type: application/json" -d '{"phone":"+19565215642"}'
```

Expected: `{"ok":true}` + a WhatsApp message arrives with the code. **Check the backend log** for `WhatsApp template "otp_verify" sent` — if
it errors with "template ... does not exist in es_MX" → fix the language (Task 3 ⚠️#1); if it rejects the button → Task 3 ⚠️#2.

- [ ] **Step 3: Live verify** with the received code:

```bash
curl -s -X POST "http://localhost:3000/api/v1/public/venues/<slug>/auth/otp/verify" \
  -H "Content-Type: application/json" -d '{"phone":"+19565215642","code":"<received>"}'
```

Expected: `{ token, customer }`. Verify in DB a `Consumer` (phone) + `Customer` (venue, consumerId, provider=PHONE) exist and are linked.

- [ ] **Step 4: Widget E2E** — build the widget pointing at localhost, open the portal login, "Entrar con WhatsApp" → phone → code → portal
      loads with the customer's reservations. (Same local-bundle method used for the reschedule E2E.)

- [ ] **Step 5: Cleanup any test rows** (delete the test `OtpChallenge`/`Consumer`/`Customer` you created) and confirm email+password
      login + the `?manage=` magic-link still work (regression).

---

## Self-review (run before handoff)

- **Spec coverage:** OtpChallenge ✓(T1), AuthProvider.PHONE ✓(T1), hashing/expiry/attempts ✓(T2,T4,T5), request/verify routes ✓(T6), hybrid
  identity (Consumer 0/1/>1 + per-venue Customer upsert) ✓(T5), WhatsApp+email channels ✓(T3,T4), customer-token reuse ✓(T5), widget UI+i18n
  ✓(T7,T8), security/rate-limit ✓(T4), MCP N/A ✓(none), migration coordination ✓(T1 step 3). No gaps.
- **Placeholders:** none — every code step has full code; the two send unknowns (language, button sub_type) are explicit verification steps,
  not hand-waves.
- **Type consistency:** `verifyOtp` returns `{ token, customer }` matching `loginCustomer`/`AuthResponse`;
  `generateCustomerToken(customerId, venueId)` matches jwt.service; `requestOtp` args match the controller call.

---

## NOT in scope (deferred)

- SMS fallback. Auto-unify OAuth(email) ↔ OTP(phone) Consumers. Consumer-app session promotion. "Remember device" longer tokens. MCP tool
  (auth is not an ops action).
