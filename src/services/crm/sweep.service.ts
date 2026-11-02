/**
 * The CRM's repair sweep (spec 2026-10-30 §5.3 step 5, plan task 6). Every five minutes it finishes what the landing
 * capture could not, and fills in what only time brings:
 *
 * 1. `applyPending` — every entry not applied yet (a crash, an error, a signup still running), oldest first, through the
 *    same `applyEntry` the landing calls: every field of the form, one account and one set of events per entry.
 *    `resendPendingNotices` — the notice of an applied entry that did not reach everyone (ruling 49), again with the
 *    same keys and content, up to 5 tries within the entry's 24 h, an hour more apart each time (ruling 59).
 * 2. `linkLandingAccounts` — a LANDING account, or one that took a landing entry — whatever its source: the landing may
 *    have reused a WhatsApp or HubSpot account (rulings 48 and 57) — still without an Organization is linked as soon as
 *    one of its emails owns one, whatever path made the person an owner: the landing, the dashboard signup, an
 *    invitation. One LINKED event, no note.
 * 3. `backfillFromOnboarding` — every landing signup (`LANDING_SIGNUP_CREATED`) without its CRM account gets one, without
 *    the form's qualification, which old signups never kept — or, when the person is already in the CRM by email or
 *    phone, that account (ruling 59).
 * 4. `fillFirstMoney` — the date a linked account's Organization first got paid for real: the oldest charge of any of its
 *    venues. Set once; commissions (another project) read it.
 *
 * Every pass reads one batch at most, and an item — or a whole pass — that fails never stops the rest: the next sweep
 * retries it. Each pass's first read is a pure read, retried on a connection blip like every job's
 * (`.claude/rules/cron-jobs.md`); nothing that writes is.
 *
 * Two sweeps at once (an overlap, or a second instance) only repeat work: every write is gated by a unique key (the
 * entry's and the link's `sourceKey`, the account's source + key) or a compare-and-set (`firstMoneyAt` while empty).
 */
import { Prisma, TransactionStatus } from '@prisma/client'
import logger from '../../config/logger'
import { PRODUCTION_VENUE_STATUSES } from '../../lib/venueStatus.constants'
import { canonicalPhoneE164 } from '../../utils/phone'
import prisma from '../../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../../utils/retry'
import { utcTs } from '../../utils/sqlDates'
import { getInitialStage } from './accounts.service'
import type { NoticeContent } from './digest.service'
import {
  accountForTx,
  addPersonTx,
  announceEntry,
  applyEntry,
  IdentityConflictError,
  LANDING,
  linkTx,
  repeatOf,
  sourceDetailOf,
  teamOrganizationId,
} from './inbound.service'
import { esCorreoDePrueba } from './internalEmail'
import { addEvent } from './timeline.service'

const BATCH = 200
const DAY_MS = 86_400_000
/** Once the backfill is caught up, its cursor waits this far behind «now»: longer than any signup takes to commit. */
const CAUGHT_UP_LAG_MS = 10 * 60_000
/** Ruling 30: a signup older than this when it is loaded enters archived — found by a search, out of the pipeline. */
const ARCHIVE_AFTER_MS = 14 * DAY_MS
/** Ruling 30b: of what the backfill creates, only a signup younger than this is announced. */
const ANNOUNCE_WITHIN_MS = DAY_MS
/** The source of the entry that keeps a backfilled account's notice (ruling 65 f): never a landing form. */
const BACKFILL = 'CARGA_INICIAL'
/** Ruling 49: a notice that did not reach everyone is tried this many times in all… */
const NOTICE_MAX_ATTEMPTS = 5
/** …and only within the entry's first 24 h: Resend's idempotency window, after which a key no longer stops a repeat. */
const NOTICE_WINDOW_MS = DAY_MS
/**
 * What the late link starts from (rulings 57 and 65 c): a LANDING account — its key is the person's email, also when the
 * backfill created it without an entry — or an account of any source that took a landing entry.
 */
const LINK_EVIDENCE = {
  OR: [{ source: LANDING }, { inboundEntries: { some: { source: LANDING, appliedAt: { not: null } } } }],
} satisfies Prisma.CrmAccountWhereInput

/**
 * Real money (spec §8, Codex plan r1 #1): a charge processed in a real venue. A plan on trial or courtesy charges
 * nothing, a $0.00 sale moves nothing, and a demo venue comes seeded with sample sales: TRIAL and LIVE_DEMO by their
 * status, and a TRIAL moved to another status without `convertDemoVenue` (a superadmin, a suspension, a failed
 * clean-up) by the `demoExpiresAt` it keeps — only the conversion deletes the sales and clears the date (I-1). The
 * oldest-charge read (`fillFirstMoney`) writes the same rule in SQL.
 */
export const MONEY = { status: TransactionStatus.COMPLETED, amount: { gt: 0 } } satisfies Prisma.PaymentWhereInput
export const REAL_VENUE = { status: { in: PRODUCTION_VENUE_STATUSES }, demoExpiresAt: null } satisfies Prisma.VenueWhereInput

/**
 * The same two rules in raw SQL over a venue aliased `v` (ruling 51): «has it charged real money?» is a correlated
 * `EXISTS` that stops at the first charge on `Payment(venueId, status, createdAt)`. A Prisma `payments.some` becomes
 * `IN (SELECT "venueId" FROM "Payment" …)`, which inside an `OR` Postgres runs as a hashed subplan that reads EVERY
 * completed payment of the platform. Only the statuses travel as binds.
 */
export const REAL_VENUE_SQL = Prisma.sql`v."status"::text IN (${Prisma.join(PRODUCTION_VENUE_STATUSES)}) AND v."demoExpiresAt" IS NULL`
export const VENUE_HAS_MONEY_SQL = Prisma.sql`EXISTS (SELECT 1 FROM "Payment" p WHERE p."venueId" = v."id" AND p."status" = 'COMPLETED' AND p."amount" > 0)`

type Cursor = { createdAt: Date; id: string }

/**
 * Where the two paged passes left off, and the landing accounts whose Organization another account holds that this
 * process already warned about. In memory on purpose: the server runs one instance, and a restart only walks the pages
 * once more — what is already done is skipped — and warns once more.
 */
const cursors: { link: Cursor | null; backfill: Cursor | null } = { link: null, backfill: null }
const warnedHeld = new Set<string>()

/** The paged passes start over and forget what they warned about, as after a restart. */
export function resetSweepCursors(): void {
  cursors.link = null
  cursors.backfill = null
  warnedHeld.clear()
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
/** The cap is the server's, whatever a caller asks for. */
const batchOf = (limit: number) => Math.min(Math.max(limit, 1), BATCH)
const cursorOf = ({ createdAt, id }: Cursor): Cursor => ({ createdAt, id })
/** What comes after a cursor in (createdAt, id) order. */
const after = (cursor: Cursor) => ({
  OR: [{ createdAt: { gt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { gt: cursor.id } }],
})

/** A pass's first read: pure, so a connection blip (the stampede at the top of the hour) gets two more tries. */
const entryRead = <T>(context: string, read: () => Promise<T>) =>
  retry(read, { retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context })

// ── 1. Entries not applied yet ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Applies the entries still without `appliedAt`, oldest first, and returns how many it went over. `applyEntry` never
 * throws: a failure stays on its entry (`lastError`), and an entry whose signup is still running waits for the next pass.
 *
 * ponytail: an entry that always fails is retried on every pass; 200 of them at the head would hold back the rest. Give
 * entries a retry count and a backoff if `lastError` ever piles up.
 */
export async function applyPending(limit = BATCH): Promise<number> {
  const entries = await entryRead('crm-sweep.applyPending', () =>
    prisma.crmInboundEntry.findMany({
      where: { appliedAt: null },
      select: { id: true },
      orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
      take: batchOf(limit),
    }),
  )
  for (const { id } of entries) await applyEntry(id)
  return entries.length
}

/**
 * Retries the notices of applied entries that did not reach everyone (ruling 49): what each entry's ENTRY_APPLIED says
 * it announces — a new prospect or one back from the archive, never a customer — with the same keys and the content it
 * fixed, so a person who already got it gets nothing new. Up to 5 tries, and only within the entry's 24 h; returns how
 * many it retried. `announceEntry` never throws and writes down how each one went.
 *
 * Spaced (ruling 59): an entry is retried only once `receivedAt + tries × 1 h` has passed — an entry that never got its
 * first try goes at once, then one hour after the entry, two, three, four — so a Resend outage of minutes does not burn
 * the five tries in one go.
 *
 * The (noticeSentAt, receivedAt) index bounds the read to the last day's pending entries, and the join is one lookup
 * per entry on the event's unique `sourceKey`.
 */
export async function resendPendingNotices(limit = BATCH): Promise<number> {
  const now = new Date()
  const since = new Date(now.getTime() - NOTICE_WINDOW_MS)
  const pending = await entryRead('crm-sweep.resendPendingNotices', () =>
    prisma.$queryRaw<Array<{ id: string; accountId: string; data: Prisma.JsonValue }>>(Prisma.sql`
      SELECT e."id", t."accountId", t."data"
      FROM "CrmInboundEntry" e
      JOIN "CrmTimelineEvent" t ON t."sourceKey" = 'entry:' || e."id"
      WHERE e."noticeSentAt" IS NULL AND e."appliedAt" IS NOT NULL AND e."noticeAttempts" < ${NOTICE_MAX_ATTEMPTS}
        AND e."receivedAt" >= ${utcTs(since)}
        AND e."receivedAt" + e."noticeAttempts" * INTERVAL '1 hour' < ${utcTs(now)}
        AND t."kind" = 'ENTRY_APPLIED'
        AND COALESCE(t."data"->>'signup', '') <> 'CUSTOMER'
        AND ((t."data"->>'created') = 'true' OR (t."data"->>'reactivated') = 'true')
      ORDER BY e."receivedAt" ASC, e."id" ASC
      LIMIT ${batchOf(limit)}`),
  )
  for (const entry of pending) await announceEntry(entry.id, repeatOf({ accountId: entry.accountId, data: entry.data }))
  return pending.length
}

// ── 2. Linking ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The Organization each account of a page can be linked to (rulings 57 and 65 c): among ALL the emails that are evidence
 * of its person — every landing entry applied to it, whatever the account's source, and the key of a LANDING account,
 * which the backfill creates without any entry (Codex exhaustiva #3) — the newest one whose person, active, OWNS an
 * Organization that is not the sales team's (`OWNED_ORGANIZATION`, written in SQL). Searched in the database before
 * anything is cut, so an account that took many forms never hides the email that owns its business (Codex r3, R3-1).
 * One read per page; at most one row per account.
 */
async function ownedByEvidence(accountIds: string[], team: string | null): Promise<Map<string, string>> {
  if (!accountIds.length) return new Map()
  const rows = await prisma.$queryRaw<Array<{ accountId: string; organizationId: string }>>(Prisma.sql`
    SELECT DISTINCT ON (ev."accountId") ev."accountId", o."organizationId"
    FROM (
      SELECT e."accountId", e."externalKey" AS "email", e."receivedAt" AS "at"
      FROM "CrmInboundEntry" e
      WHERE e."accountId" IN (${Prisma.join(accountIds)}) AND e."source" = 'LANDING' AND e."appliedAt" IS NOT NULL
      UNION ALL
      SELECT a."id", a."externalKey", a."createdAt"
      FROM "CrmAccount" a
      WHERE a."id" IN (${Prisma.join(accountIds)}) AND a."source" = 'LANDING' AND a."externalKey" IS NOT NULL
    ) ev
    JOIN "Staff" s ON s."email" = ev."email" AND s."active" = true
    CROSS JOIN LATERAL (
      SELECT so."organizationId" FROM "StaffOrganization" so
      WHERE so."staffId" = s."id" AND so."role" = 'OWNER' AND so."isActive" = true
      ORDER BY so."isPrimary" DESC, so."joinedAt" ASC, so."id" ASC
      LIMIT 1
    ) o
    ${team ? Prisma.sql`WHERE o."organizationId" <> ${team}` : Prisma.empty}
    ORDER BY ev."accountId", ev."at" DESC, ev."email" ASC`)
  return new Map(rows.map(row => [row.accountId, row.organizationId]))
}

/**
 * Links the accounts still without an Organization that are LANDING ones or took a landing entry — one of another source
 * the landing reused (rulings 48 and 57) — to the one an email of theirs owns now, by the same rule as the entry
 * (`OWNED_ORGANIZATION`, the login's exact email), never the sales team's own nor one another account holds; returns how
 * many it linked. Every email the account has evidence of counts, newest first (`ownedByEvidence`). A page per pass:
 * the cursor walks every such account, so the ones that will never link (their person owns nothing) never keep a newer
 * one waiting. An account no landing entry reached (WhatsApp, HubSpot, by hand) is never linked here: a phone is not
 * enough to name a business (spec §5.3); «Ganar» links it.
 */
export async function linkLandingAccounts(limit = BATCH): Promise<number> {
  const size = batchOf(limit)
  const from = cursors.link
  const accounts = await entryRead('crm-sweep.linkLandingAccounts', () =>
    prisma.crmAccount.findMany({
      where: { organizationId: null, AND: [LINK_EVIDENCE, ...(from ? [after(from)] : [])] },
      select: { id: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: size,
    }),
  )
  // A full page: the next pass goes on after it. A short one reached the end: the next pass starts over.
  cursors.link = accounts.length === size ? cursorOf(accounts[accounts.length - 1]) : null
  if (!accounts.length) return 0

  const owned = await ownedByEvidence(
    accounts.map(account => account.id),
    await teamOrganizationId(),
  )
  // The Organizations another account already holds (one CRM account per Organization), in one read: they are skipped
  // before any transaction and said once per account and process (M-1). Otherwise every pass would take the lock and
  // warn again, for good.
  const wanted = [...new Set(owned.values())]
  const holders = wanted.length
    ? await prisma.crmAccount.findMany({
        where: { organizationId: { in: wanted } },
        select: { id: true, organizationId: true },
        take: wanted.length,
      })
    : []
  const heldBy = new Map(holders.map(holder => [holder.organizationId, holder.id]))

  let linked = 0
  for (const account of accounts) {
    const organizationId = owned.get(account.id)
    if (!organizationId) continue
    const holder = heldBy.get(organizationId)
    if (holder) {
      if (!warnedHeld.has(account.id)) {
        warnedHeld.add(account.id)
        logger.warn('[CRM] Landing account left unlinked: its Organization already has a CRM account', {
          accountId: account.id,
          organizationId,
          heldBy: holder,
        })
      }
      continue
    }
    try {
      const done = await prisma.$transaction(async tx => {
        // The row is locked BEFORE its `link:` key goes in, as `applyTx` does before `linkTx`: the sweep and an entry
        // of the same email queue on it instead of deadlocking.
        const [current] = await tx.$queryRaw<Array<{ organizationId: string | null }>>`
          SELECT "organizationId" FROM "CrmAccount" WHERE "id" = ${account.id} FOR UPDATE`
        // Gone, or linked in the meantime (an entry, «Ganar»).
        if (!current || current.organizationId) return false
        return linkTx(tx, account.id, organizationId)
      })
      if (done) linked++
    } catch (error) {
      logger.error('[CRM] A landing account could not be linked; the next sweep retries it', {
        accountId: account.id,
        organizationId,
        error: errorText(error),
      })
    }
  }
  return linked
}

// ── 3. Old signups ────────────────────────────────────────────────────────────────────────────────────────────────────

const asObject = (value: Prisma.JsonValue): Prisma.JsonObject => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})

/** A landing mark (`LANDING_SIGNUP_CREATED`) with its person: null fields when the person's row is gone. */
type SignupMark = {
  id: string
  createdAt: Date
  data: Prisma.JsonValue
  email: string | null
  firstName: string | null
  lastName: string | null
  phone: string | null
  active: boolean | null
}

/**
 * Gives every landing signup its CRM account (spec §5.3): the initial load of the signups from before the CRM, and the
 * signup whose entry could not be saved. They never kept the form's qualification, so the account says it is not
 * available (`qualificationAvailable: false`). Returns how many it created.
 *
 * By the signup's age when it is loaded (rulings 30 and 30b): older than 14 days, archived — found by a search, out of
 * the pipeline and of the daily digest —; younger, open and «Sin dueño»; and only one younger than 24 h is announced
 * with «Nuevo prospecto»: today's signup whose entry was never saved, which nothing else announces. That notice is kept
 * with the account, as an applied entry of its own (`CARGA_INICIAL`), so `resendPendingNotices` recovers it (ruling 65 f).
 *
 * Nothing is created for a signup whose person was deleted (the platform anonymizes and keeps the row, inactive: I-2) or
 * is gone, whose Organization already has its account (of any source) or no longer exists, or whose entry is still
 * pending — that one brings every field.
 *
 * The marks are read on their own partial index (`ActivityLog_landing_signup_mark_idx`, ruling 29b), with the action as
 * a SQL LITERAL: bound as a parameter, a generic plan (the one a cached prepared statement settles on) cannot prove the
 * index's predicate, and walks the `createdAt` index filtering by action instead (measured with EXPLAIN on the
 * throwaway database).
 *
 * ponytail: a restart walks every mark from the first one again, one page of 200 per sweep on that index; until it
 * catches up, a mark from today waits behind it, ceil(marks / 200) sweeps of 5 minutes. Persist the cursor, or read the
 * newest marks first, when the marks reach the tens of thousands.
 */
export async function backfillFromOnboarding(limit = BATCH): Promise<number> {
  const size = batchOf(limit)
  const from = cursors.backfill
  const startedAt = Date.now()
  const signups = await entryRead('crm-sweep.backfillFromOnboarding', () =>
    prisma.$queryRaw<SignupMark[]>(Prisma.sql`
      SELECT l."id", l."createdAt", l."data", s."email", s."firstName", s."lastName", s."phone", s."active"
      FROM "ActivityLog" l
      LEFT JOIN "Staff" s ON s."id" = l."staffId"
      WHERE l."action" = 'LANDING_SIGNUP_CREATED'${from ? Prisma.sql` AND (l."createdAt", l."id") > (${utcTs(from.createdAt)}, ${from.id})` : Prisma.empty}
      ORDER BY l."createdAt" ASC, l."id" ASC
      LIMIT ${size}`),
  )
  // A full page: the next pass goes on after it. A short one reached the end, and the cursor stays at the EARLIER of the
  // last mark read and ten minutes ago (M-3): a signup whose transaction started before can still commit its mark in
  // between, and reading those minutes again costs a few rows of the index, each skipped once it has its account.
  const lastRead = signups.length ? cursorOf(signups[signups.length - 1]) : from
  const caughtUp: Cursor = { createdAt: new Date(startedAt - CAUGHT_UP_LAG_MS), id: '' }
  const next = signups.length === size || (lastRead && lastRead.createdAt < caughtUp.createdAt) ? lastRead : caughtUp
  if (!signups.length) {
    cursors.backfill = next
    return 0
  }

  const rows = signups.map(signup => {
    const data = asObject(signup.data)
    return {
      signup,
      data,
      organizationId: typeof data.organizationId === 'string' ? data.organizationId : null,
      email: signup.email?.toLowerCase().trim() || null,
    }
  })
  const organizationIds = [...new Set(rows.flatMap(row => (row.organizationId ? [row.organizationId] : [])))]
  const emails = [...new Set(rows.flatMap(row => (row.email ? [row.email] : [])))]
  const [organizations, waiting, stage] = await Promise.all([
    prisma.organization.findMany({
      where: { id: { in: organizationIds } },
      select: { id: true, name: true, phone: true, crmAccount: { select: { id: true } } },
      take: organizationIds.length,
    }),
    prisma.crmInboundEntry.groupBy({ by: ['externalKey'], where: { source: LANDING, externalKey: { in: emails }, appliedAt: null } }),
    getInitialStage(),
  ])
  const organizationOf = new Map(organizations.map(organization => [organization.id, organization]))
  const pending = new Set(waiting.map(entry => entry.externalKey))

  let created = 0
  let firstFailed = -1
  for (const [index, { signup, data, organizationId, email }] of rows.entries()) {
    const organization = organizationId ? organizationOf.get(organizationId) : undefined
    if (!email || !signup.active || !organization || organization.crmAccount || pending.has(email)) continue
    const phone = signup.phone || organization.phone
    const age = startedAt - signup.createdAt.getTime()
    // An internal test of the funnel (founder, 2-nov) goes in archived and is never announced, however new.
    const prueba = esCorreoDePrueba(email)
    const archived = age > ARCHIVE_AFTER_MS || prueba
    const person = {
      name: [signup.firstName, signup.lastName].filter(Boolean).join(' ') || organization.name,
      email,
      phoneE164: phone ? canonicalPhoneE164(phone) : null,
    }
    try {
      const announce = age < ANNOUNCE_WITHIN_MS && !prueba
      const content: NoticeContent = {
        name: organization.name,
        giro: null,
        ventasRango: null,
        sucursales: null,
        modulos: [],
        qualificationAvailable: false,
      }
      const done = await prisma.$transaction(async tx => {
        // The resolver every writer shares (ruling 65 a): this Organization's account, the landing one of this email, or —
        // ruling 59, the family of ruling 48 — a person the CRM already has by email or phone (WhatsApp, HubSpot, by hand).
        // That ONE account keeps this email and phone and is linked to this Organization; nothing is announced.
        const { account, created: isNew } = await accountForTx(
          tx,
          { emails: [email], phones: person.phoneE164 ? [person.phoneE164] : [], organizationId: organization.id },
          {
            source: LANDING,
            externalKey: email,
            data: {
              name: organization.name,
              stageId: stage.id,
              organizationId: organization.id,
              qualificationAvailable: false,
              sourceDetail: sourceDetailOf(data),
              ...(archived ? { archivedAt: new Date(startedAt) } : {}),
            },
            contact: { ...person, isPrimary: true },
          },
        )
        if (!isNew) {
          await addPersonTx(tx, account.id, person)
          if (!account.organizationId) await linkTx(tx, account.id, organization.id)
          return null
        }
        await addEvent(tx, {
          accountId: account.id,
          kind: 'SYSTEM',
          actorStaffId: null,
          data: {
            event: 'CREATED_FROM_SIGNUP',
            activityLogId: signup.id,
            signedUpAt: signup.createdAt.toISOString(),
            archived,
            ...(prueba ? { prueba: true } : {}),
          },
        })
        if (!announce) return { accountId: account.id, entryId: null }
        // Ruling 65 (f, Codex exhaustiva #12): its notice is kept with the account, in the same transaction — an applied
        // entry with its ENTRY_APPLIED, as the landing leaves it — so `resendPendingNotices` recovers it, with the same
        // email key and content, if the send fails or the process dies before it. Its 24 h count from the signup.
        const entry = await tx.crmInboundEntry.create({
          data: {
            source: BACKFILL,
            externalKey: email,
            payload: { activityLogId: signup.id, signedUpAt: signup.createdAt.toISOString() },
            receivedAt: signup.createdAt,
            appliedAt: new Date(),
            accountId: account.id,
          },
          select: { id: true },
        })
        await addEvent(tx, {
          accountId: account.id,
          kind: 'ENTRY_APPLIED',
          actorStaffId: null,
          sourceKey: `entry:${entry.id}`,
          data: { entryId: entry.id, signup: BACKFILL, created: true, noticeContent: { ...content } },
        })
        return { accountId: account.id, entryId: entry.id }
      })
      if (!done) continue
      created++
      // After the commit, and never throws: how it went stays on its entry, and the sweep retries what did not go out.
      if (done.entryId) await announceEntry(done.entryId, { accountId: done.accountId, notice: 'NEW', content })
    } catch (error) {
      // Even the account of this signup's own Organization belongs to another business (rulings 70 and 71): nothing to
      // create or write here, and no retry changes it — not a failure that holds the cursor.
      if (error instanceof IdentityConflictError) {
        logger.warn('[CRM] Old landing signup skipped: the accounts of this person are linked to another Organization', {
          activityLogId: signup.id,
          organizationId: organization.id,
          error: errorText(error),
        })
        continue
      }
      if (firstFailed < 0) firstFailed = index
      logger.error('[CRM] An old landing signup could not get its CRM account; the next sweep retries it', {
        activityLogId: signup.id,
        organizationId: organization.id,
        error: errorText(error),
      })
    }
  }
  // Ruling 65 (f, Codex exhaustiva #11): walking past a mark is not resolving it. The cursor never passes one that
  // failed: the next pass reads it again — and the ones after it, each skipped once it has its account.
  // ponytail: a mark that ALWAYS fails holds the cursor; each pass still does the 200 marks from it, but a signup further
  // ahead waits. Keep failed marks in a retry set of their own (by id) if that ever happens.
  cursors.backfill = firstFailed < 0 ? next : firstFailed === 0 ? from : cursorOf(signups[firstFailed - 1])
  return created
}

// ── 4. First money ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Fills `firstMoneyAt` of linked accounts that do not have it with the date of the oldest charge of ANY venue of their
 * Organization (spec §8), never with the plan (`getVenueBaseTier` also takes a plan on trial or courtesy, and that is
 * not money); returns how many it filled. «ANTERIOR_AL_CRM» when that charge is older than the account itself — the
 * money did not come with the CRM (ruling 28) — and «PAGO» otherwise. Set once: written only while still empty, with
 * its event.
 */
export async function fillFirstMoney(limit = BATCH): Promise<number> {
  // Only the accounts whose Organization did charge: the many that never will would otherwise fill every batch. Raw SQL
  // (ruling 51): the two conditions of the partial index `CrmAccount_first_money_pending_idx` as literals, and «did it
  // charge» as an EXISTS per venue that stops at the first charge — never a scan of every payment.
  const accounts = await entryRead('crm-sweep.fillFirstMoney', () =>
    prisma.$queryRaw<Array<{ id: string; organizationId: string | null; createdAt: Date }>>(Prisma.sql`
      SELECT a."id", a."organizationId", a."createdAt"
      FROM "CrmAccount" a
      WHERE a."firstMoneyAt" IS NULL AND a."organizationId" IS NOT NULL
        AND EXISTS (SELECT 1 FROM "Venue" v WHERE v."organizationId" = a."organizationId" AND ${REAL_VENUE_SQL} AND ${VENUE_HAS_MONEY_SQL})
      ORDER BY a."createdAt" ASC, a."id" ASC
      LIMIT ${batchOf(limit)}`),
  )
  const organizationIds = [...new Set(accounts.flatMap(account => (account.organizationId ? [account.organizationId] : [])))]
  if (!organizationIds.length) return 0

  // The oldest real charge of each real venue of those Organizations (M-2): a LATERAL `ORDER BY … LIMIT 1` reads about one
  // row per venue on `Payment(venueId, status, createdAt)`, never a whole history. `MONEY` and `REAL_VENUE` written in
  // SQL; only ids and statuses travel as binds, so no date can shift with the session's time zone.
  const firstByVenue = await prisma.$queryRaw<Array<{ venueId: string; organizationId: string; createdAt: Date }>>(Prisma.sql`
    SELECT v."id" AS "venueId", v."organizationId", oldest."createdAt"
    FROM "Venue" v
    CROSS JOIN LATERAL (
      SELECT p."createdAt" FROM "Payment" p
      WHERE p."venueId" = v."id" AND p."status" = 'COMPLETED' AND p."amount" > 0
      ORDER BY p."createdAt" ASC
      LIMIT 1
    ) oldest
    WHERE v."organizationId" IN (${Prisma.join(organizationIds)})
      AND ${REAL_VENUE_SQL}`)
  const firstMoney = new Map<string, Date>()
  for (const { organizationId, createdAt } of firstByVenue) {
    const earlier = firstMoney.get(organizationId)
    if (!earlier || createdAt < earlier) firstMoney.set(organizationId, createdAt)
  }

  let filled = 0
  for (const account of accounts) {
    const at = account.organizationId ? firstMoney.get(account.organizationId) : undefined
    if (!at) continue
    const source = at < account.createdAt ? 'ANTERIOR_AL_CRM' : 'PAGO'
    try {
      const wrote = await prisma.$transaction(async tx => {
        // Still empty AND still linked to the Organization the date was read for: a re-link in between (with its reset,
        // ruling 65 g) never gets the old Organization's charge (Codex autorización H2).
        const { count } = await tx.crmAccount.updateMany({
          where: { id: account.id, firstMoneyAt: null, organizationId: account.organizationId },
          data: { firstMoneyAt: at, firstMoneySource: source },
        })
        if (count === 0) return false
        await addEvent(tx, {
          accountId: account.id,
          kind: 'SYSTEM',
          actorStaffId: null,
          data: { event: 'FIRST_MONEY', at: at.toISOString(), source },
        })
        return true
      })
      if (wrote) filled++
    } catch (error) {
      logger.error('[CRM] The first money date could not be written; the next sweep retries it', {
        accountId: account.id,
        error: errorText(error),
      })
    }
  }
  return filled
}

// ── The sweep ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const PASSES = [
  ['applyPending', applyPending],
  ['resendPendingNotices', resendPendingNotices],
  ['linkLandingAccounts', linkLandingAccounts],
  ['backfillFromOnboarding', backfillFromOnboarding],
  ['fillFirstMoney', fillFirstMoney],
] as const

/**
 * One sweep, in this order: a pending entry is applied before the backfill could take its signup, and an account linked
 * or created in this sweep gets its first money in the same sweep. Each pass on its own: one that fails is logged, and
 * the next one runs.
 */
export async function runSweep(): Promise<void> {
  const counts: Record<string, number> = {}
  for (const [pass, run] of PASSES) {
    try {
      counts[pass] = await run()
    } catch (error) {
      logger.error('[CRM] A sweep pass failed; the next sweep runs it again', { pass, error: errorText(error) })
    }
  }
  if (Object.values(counts).some(Boolean)) logger.info('[CRM] Sweep', counts)
}
