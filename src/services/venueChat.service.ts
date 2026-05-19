import { createHash, timingSafeEqual } from 'crypto'

import logger from '@/config/logger'
import { encodeCursor, decodeCursor } from '@/utils/chatCursor'
import { generateAccessToken, hashAccessToken } from '@/utils/sessionToken'
import { generateShortCode } from '@/utils/shortCode'
import prisma from '@/utils/prismaClient'

import { relayCustomerMessageToVenue } from './whatsappRelay.service'

// Stable per-request fingerprint so the same nonce replayed with the same
// content is recognized as a true retry (replay) vs a different request that
// happened to reuse the nonce (collision → 409).
function fingerprint(args: { venueSlug: string; name: string; email?: string; message: string }): string {
  return createHash('sha256')
    .update(`${args.venueSlug}:${args.name}:${args.email ?? ''}:${args.message}`)
    .digest('hex')
}

export type CreateSessionResult =
  | {
      kind: 'CREATED'
      sessionId: string
      accessToken: string
      shortCode: string
      firstMessage: { id: string; createdAt: Date; direction: string; body: string }
    }
  | { kind: 'NONCE_COLLISION' }
  | { kind: 'VENUE_NOT_AVAILABLE' }

// Create a brand-new venue chat session OR resolve a nonce replay/collision.
// v1 trade-off (per spec): we hash the accessToken at rest, so we cannot
// return the original token on a true replay. Both replay and collision
// therefore surface as 409 — the widget regenerates the nonce and retries.
export async function createSessionWithIdempotency(args: {
  venueSlug: string
  name: string
  email?: string
  message: string
  flowOrigin: string
  clientSessionNonce: string
}): Promise<CreateSessionResult> {
  const venue = await prisma.venue.findUnique({ where: { slug: args.venueSlug } })
  if (!venue || venue.whatsappContactMode !== 'RELAY') {
    return { kind: 'VENUE_NOT_AVAILABLE' }
  }

  const fp = fingerprint(args)
  const existing = await prisma.venueChatSession.findUnique({
    where: { clientSessionNonce: args.clientSessionNonce },
  })
  if (existing) {
    // Replay or collision — both treated as 409 in v1 (see file header).
    return { kind: 'NONCE_COLLISION' }
  }

  const accessToken = generateAccessToken()
  const accessTokenHash = hashAccessToken(accessToken)
  const shortCode = await pickUnusedShortCode(venue.id)

  const session = await prisma.venueChatSession.create({
    data: {
      venueId: venue.id,
      shortCode,
      customerName: args.name,
      customerEmail: args.email ?? null,
      flowOrigin: args.flowOrigin,
      clientSessionNonce: args.clientSessionNonce,
      requestFingerprintHash: fp,
      accessTokenHash,
      messages: {
        create: {
          direction: 'INBOUND_FROM_CUSTOMER',
          body: args.message,
          relayStatus: 'PENDING',
          clientMessageId: args.clientSessionNonce,
        },
      },
    },
    include: { messages: true },
  })

  // Fire-and-forget relay of the first message — same contract as
  // appendCustomerMessage: row is persisted as PENDING and relay marks it
  // SENT/FAILED out-of-band. Stale-PENDING cron picks up anything stuck.
  relayCustomerMessageToVenue(session.messages[0].id).catch(err => {
    logger.error('[VenueChat] Relay failed for initial customer message', { messageId: session.messages[0].id, err })
  })

  return {
    kind: 'CREATED',
    sessionId: session.id,
    accessToken,
    shortCode: session.shortCode,
    firstMessage: {
      id: session.messages[0].id,
      createdAt: session.messages[0].createdAt,
      direction: session.messages[0].direction,
      body: session.messages[0].body,
    },
  }
}

// shortCode collision probability is microscopic (31^4 ≈ 924k space, partial
// unique index scoped to OPEN sessions per venue), but retry a few times before
// throwing so the customer never sees a generic failure.
async function pickUnusedShortCode(venueId: string, attempts = 5): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    const code = generateShortCode()
    const collision = await prisma.venueChatSession.findFirst({
      where: { venueId, shortCode: code, status: 'OPEN' },
      select: { id: true },
    })
    if (!collision) return code
  }
  throw new Error('shortCode exhaustion (improbable; investigate)')
}

// Cursor-paginated message listing for the polling endpoint.
// - With `after`: returns messages strictly after (createdAt, id) cursor, ASC.
// - Without: returns latest N descending then reversed (hydration).
// Only INBOUND_* directions are returned — outbound email events are internal.
export async function listMessages(args: { sessionId: string; after?: string; limit: number }): Promise<{
  messages: Array<{ id: string; sessionId: string; direction: string; body: string; createdAt: Date }>
  nextCursor: string | null
  sessionStatus: string
}> {
  const session = await prisma.venueChatSession.findUnique({ where: { id: args.sessionId } })
  if (!session) throw new Error('session not found')

  type Row = { id: string; sessionId: string; direction: string; body: string; createdAt: Date }
  let rows: Row[]
  if (args.after) {
    const cursor = decodeCursor(args.after)
    rows = await prisma.$queryRawUnsafe<Row[]>(
      `SELECT id, "sessionId", direction, body, "createdAt"
       FROM "VenueChatMessage"
       WHERE "sessionId" = $1
         AND direction IN ('INBOUND_FROM_CUSTOMER', 'INBOUND_FROM_VENUE')
         AND ("createdAt", id) > ($2, $3)
       ORDER BY "createdAt" ASC, id ASC
       LIMIT $4`,
      args.sessionId,
      cursor.createdAt,
      cursor.id,
      args.limit,
    )
  } else {
    const desc = await prisma.$queryRawUnsafe<Row[]>(
      `SELECT id, "sessionId", direction, body, "createdAt"
       FROM "VenueChatMessage"
       WHERE "sessionId" = $1
         AND direction IN ('INBOUND_FROM_CUSTOMER', 'INBOUND_FROM_VENUE')
       ORDER BY "createdAt" DESC, id DESC
       LIMIT $2`,
      args.sessionId,
      args.limit,
    )
    rows = desc.reverse()
  }

  const nextCursor =
    rows.length === args.limit && rows.length > 0
      ? encodeCursor({ createdAt: rows[rows.length - 1].createdAt, id: rows[rows.length - 1].id })
      : null

  return { messages: rows, nextCursor, sessionStatus: session.status }
}

// Conditional UPDATE — only writes lastCustomerSeenAt if older than 20s or
// NULL. Single SQL statement so concurrent pollers can't race. This is the
// signal the venue dashboard uses to show "customer is watching".
export async function maybeUpdateCustomerSeen(sessionId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE "VenueChatSession"
     SET "lastCustomerSeenAt" = now()
     WHERE id = $1
       AND ("lastCustomerSeenAt" IS NULL OR "lastCustomerSeenAt" < now() - interval '20 seconds')`,
    sessionId,
  )
}

// Append a customer message with idempotency via @@unique([sessionId, clientMessageId]).
// Triggers the relay (Phase 6) but does not throw on relay failure — the row
// is persisted either way; the relay service is responsible for marking the
// row FAILED so the next polling tick surfaces the state.
export async function appendCustomerMessage(args: {
  sessionId: string
  body: string
  clientMessageId: string
}): Promise<{ id: string; createdAt: Date; direction: string; body: string; relayStatus: string }> {
  const existing = await prisma.venueChatMessage.findUnique({
    where: { sessionId_clientMessageId: { sessionId: args.sessionId, clientMessageId: args.clientMessageId } },
  })
  if (existing) {
    return {
      id: existing.id,
      createdAt: existing.createdAt,
      direction: existing.direction,
      body: existing.body,
      relayStatus: existing.relayStatus,
    }
  }

  const row = await prisma.venueChatMessage.create({
    data: {
      sessionId: args.sessionId,
      direction: 'INBOUND_FROM_CUSTOMER',
      body: args.body,
      clientMessageId: args.clientMessageId,
      relayStatus: 'PENDING',
      sendAttemptedAt: new Date(),
    },
  })
  await prisma.venueChatSession.update({
    where: { id: args.sessionId },
    data: { lastActivityAt: new Date() },
  })

  // Fire-and-forget: relay never blocks the customer-facing response. The
  // service marks the row FAILED on Cloud API errors and the stale-PENDING
  // cron alerts on anything that stays stuck. Errors thrown here would be
  // unhandled rejections, so we swallow them and log.
  relayCustomerMessageToVenue(row.id).catch(err => {
    logger.error('[VenueChat] Relay failed for inbound customer message', { messageId: row.id, err })
  })

  return {
    id: row.id,
    createdAt: row.createdAt,
    direction: row.direction,
    body: row.body,
    relayStatus: row.relayStatus,
  }
}

export type ResumeSessionResult = { kind: 'OK'; accessToken: string } | { kind: 'NOT_FOUND' }

// Customer proves possession of the on-file email and gets a fresh
// accessToken. Used by the email "you have a reply" link, which contains
// only the sessionId in its URL fragment. Returns a generic NOT_FOUND on any
// failure (missing session, email mismatch, closed session) — never leak
// which precondition failed.
export async function resumeSessionWithEmail(args: { sessionId: string; email: string }): Promise<ResumeSessionResult> {
  const session = await prisma.venueChatSession.findUnique({
    where: { id: args.sessionId },
    select: { id: true, customerEmail: true, status: true },
  })

  if (!session || !session.customerEmail || session.status !== 'OPEN') {
    return { kind: 'NOT_FOUND' }
  }
  if (!emailEquals(session.customerEmail, args.email)) {
    return { kind: 'NOT_FOUND' }
  }

  const newToken = generateAccessToken()
  await prisma.venueChatSession.update({
    where: { id: session.id },
    data: { accessTokenHash: hashAccessToken(newToken) },
  })
  return { kind: 'OK', accessToken: newToken }
}

// Constant-time, case-insensitive email comparison. Both sides are
// normalized to lowercase before comparison; lengths are zero-padded to the
// max of the two so timingSafeEqual never throws on differing lengths.
function emailEquals(a: string, b: string): boolean {
  const x = Buffer.from(a.trim().toLowerCase())
  const y = Buffer.from(b.trim().toLowerCase())
  if (x.length !== y.length) {
    // Compare both against the longer length so timing is independent of
    // input-length difference within a small bound.
    const max = Math.max(x.length, y.length)
    const xPadded = Buffer.alloc(max, 0)
    const yPadded = Buffer.alloc(max, 0)
    x.copy(xPadded)
    y.copy(yPadded)
    timingSafeEqual(xPadded, yPadded)
    return false
  }
  return timingSafeEqual(x, y)
}
