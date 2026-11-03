/**
 * Every landing submission lands in the CRM without ever risking the signup (spec 2026-10-30 §5.3).
 *
 * 1. `saveLandingEntry` — the FIRST thing the controller does: the raw form, cleaned, as a `CrmInboundEntry`.
 * 2. The signup (`signupFromLanding`) runs exactly as before; `recordSignupOutcome` writes down what it really returned.
 * 3. `applyEntry` applies the entry to the ONE account it belongs to — the account the Organization the person owns
 *    already has (one per Organization), the landing account of that email, or the account of another source that
 *    already has this person by email or phone (one per person), all by `accountForTx`, the resolver every writer
 *    shares (ruling 65) — and creates it only when there is none; the timeline event `entry:<id>` proves it was
 *    applied. It never throws, and running it again — the sweep after a crash, or both at once — changes nothing.
 *
 * The box «Quiero recibir novedades de Avoqado por correo» is applied in the same transaction (`consentTx`): it leaves the
 * consent of the entry's own email — what the campaigns to prospects read — and nothing ever deletes one.
 *
 * Nothing here can stop the signup: every function swallows its own failure into the log, and the sweep (task 6) picks
 * up whatever was left half done.
 */
import { OrgRole, Prisma } from '@prisma/client'
import logger from '../../config/logger'
import { canonicalPhoneE164 } from '../../utils/phone'
import prisma from '../../utils/prismaClient'
import { normalizeEmail } from '../marketing/emailSuppression.service'
import { getInitialStage, resetFirstMoneyTx } from './accounts.service'
import { notifyNewProspect, notifyReturningProspect, type NoticeContent } from './digest.service'
import { addEvent } from './timeline.service'

export const LANDING = 'LANDING'
const MAX_TEXT = 500
const MAX_LIST = 20
/** Long enough for any signup to finish: an entry younger than this without an outcome waits for the sweep. */
const SIGNUP_GRACE_MS = 5 * 60_000
/** Control characters and lone UTF-16 surrogates: PostgreSQL refuses `\u0000` and broken text in JSONB. */
const UNSAFE = /[\p{Cc}\p{Cs}]/gu

/** What the signup returned; `null` = it failed. The controller passes the real `LandingSignupResult` fields. */
export type SignupOutcome = { organizationId: string | null; alreadyExisted: boolean; yaEsCliente: boolean }

export type CleanEntry = Record<string, string | boolean | string[] | Record<string, string>>

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

// ── 1. The raw entry ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Also cleans every cell of the HubSpot import (task 8). */
export function cleanText(value: string): string {
  // Cutting at 500 can split an emoji in two: the second pass drops the half it leaves behind.
  return value.replace(UNSAFE, '').slice(0, MAX_TEXT).replace(UNSAFE, '').trim()
}

const asText = (value: unknown) =>
  cleanText(typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value))

/**
 * The form, safe to store: no NUL, control characters or lone surrogates, every text at most 500 characters and every
 * list (or nested object, like the UTMs) at most 20 items. Empty fields are dropped. A boolean stays a boolean: as the text
 * «true» the consent box would never be read.
 */
export function sanitizeEntry(raw: Record<string, unknown>): CleanEntry {
  const clean: CleanEntry = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'boolean') clean[cleanText(key)] = value
    else if (Array.isArray(value)) clean[cleanText(key)] = value.slice(0, MAX_LIST).map(asText)
    else if (typeof value === 'object') {
      clean[cleanText(key)] = Object.fromEntries(
        Object.entries(value)
          .slice(0, MAX_LIST)
          .map(([innerKey, inner]) => [cleanText(innerKey), asText(inner)]),
      )
    } else clean[cleanText(key)] = asText(value)
  }
  return clean
}

/**
 * Stores the cleaned form as the entry, keyed by the email normalized exactly as the signup does. One retry: a database
 * blip must not cost the entry, and a database that is down must not hold up the signup. Never throws; twice down →
 * `null`, and the clean form goes to the log (the internal email to onboarding is the other copy).
 */
export async function saveLandingEntry(payload: Record<string, unknown>): Promise<{ entryId: string } | null> {
  let entry: CleanEntry = {}
  try {
    entry = sanitizeEntry(payload)
    const externalKey = typeof entry.email === 'string' ? entry.email.toLowerCase().trim() : ''
    const write = () => prisma.crmInboundEntry.create({ data: { source: LANDING, externalKey, payload: entry }, select: { id: true } })
    const { id } = await write().catch(write)
    return { entryId: id }
  } catch (error) {
    logger.error('[CRM] The landing entry could not be saved; the internal email and this log keep the form', {
      payload: entry,
      error: errorText(error),
    })
    return null
  }
}

/** Writes down what the signup returned (`null` = it failed), so the entry can be applied without guessing. Never throws. */
export async function recordSignupOutcome(entryId: string, outcome: SignupOutcome | null): Promise<void> {
  try {
    await prisma.crmInboundEntry.update({
      where: { id: entryId },
      data: { signupOutcome: outcome ?? Prisma.DbNull, signupResolvedAt: new Date() },
    })
  } catch (error) {
    logger.error('[CRM] The signup outcome could not be written on the entry; the sweep resolves it by email', {
      entryId,
      error: errorText(error),
    })
  }
}

// ── 2. Who a person is: THE account and its people (landing, backfill, MCP and the HubSpot import) ───────────────────

export interface UpsertBySourceInput {
  source: string
  externalKey: string
  /** The account's fields if it has to be created. An account that already exists is returned untouched. */
  data: Omit<Prisma.CrmAccountCreateManyInput, 'source' | 'externalKey'>
  /** Its primary person, created only together with the account. */
  contact?: Omit<Prisma.CrmContactCreateManyInput, 'accountId'>
}

/**
 * Creates THE account of an entry key — (source, externalKey) is unique — inside the caller's transaction, or returns
 * the one already there: the landing by email, the HubSpot import by its id (task 8), WhatsApp by phone (task 10).
 *
 * `INSERT … ON CONFLICT DO NOTHING` (`skipDuplicates`) instead of upsert-and-retry-on-P2002: a unique violation aborts
 * the whole Postgres transaction, so a retry inside it could never run. Two callers at once: the second insert waits
 * for the first to commit, inserts nothing, and both read the same row. A clash on the OTHER unique key — the
 * Organization already has its account — returns that account, never a second one without it (Codex exhaustiva #6).
 * Writers go through `accountForTx`, which looks for the person first and resolves again after a clash.
 */
export async function upsertAccountBySource(
  tx: Prisma.TransactionClient,
  input: UpsertBySourceInput,
): Promise<{ account: { id: string; organizationId: string | null }; created: boolean }> {
  const { source, externalKey, contact, data } = input
  const select = { id: true, organizationId: true } as const
  const created = (await tx.crmAccount.createMany({ data: [{ ...data, source, externalKey }], skipDuplicates: true })).count === 1
  let account = await tx.crmAccount.findUnique({ where: { source_externalKey: { source, externalKey } }, select })
  if (!account && data.organizationId) account = await tx.crmAccount.findUnique({ where: { organizationId: data.organizationId }, select })
  if (!account) throw new Error(`The ${source} account was neither created nor found`)
  if (created && contact) await tx.crmContact.create({ data: { ...contact, accountId: account.id }, select: { id: true } })
  return { account, created }
}

/** Who an entry, a signup, an import row or a WhatsApp message is about (ruling 65 a). */
export interface Identity {
  /** The account of this source key: the landing's email, WhatsApp's phone, HubSpot's id. */
  key?: { source: string; externalKey: string }
  /** Exact emails (every writer stores them in lowercase) and canonical phones: one person's, or a HubSpot deal's people. */
  emails: string[]
  phones: string[]
  /** The Organization this person owns, or just created; null when none or unknown. */
  organizationId: string | null
}

/** How the account was found: its Organization, its source key, or one of its people by email or by phone. */
export type FoundVia = 'ORGANIZATION' | 'KEY' | 'EMAIL' | 'PHONE'
export type ResolvedAccount = { id: string; organizationId: string | null; via: FoundVia }

/** A resolution that keeps changing under it (a «Ganar» per try) gives up; the caller's transaction fails and is retried. */
const RESOLVE_TRIES = 3

/**
 * The account that already IS this person, by precedence (rulings 25, 48 and 65 a): the one its Organization holds (one
 * per Organization) — before its landing key, so an unlinked landing account never keeps the entry away from the
 * business a seller already linked (Codex exhaustiva #5); its source key; then a person of it with this email, before
 * one with this phone. Among people, the open one first (in the pipeline, not archived), then the newest touch, then the
 * id — each rule a `findFirst` with its order, so nothing is cut before it is ranked (Codex exhaustiva #4). An account
 * linked to ANOTHER Organization than the one this person owns is somebody else's business (a shared phone) and is never
 * a candidate. Phones are never unique and nothing is merged: two businesses may share a contact.
 */
async function candidateTx(tx: Prisma.TransactionClient, who: Identity): Promise<{ id: string; via: FoundVia } | null> {
  const select = { id: true } as const
  if (who.organizationId) {
    const holder = await tx.crmAccount.findUnique({ where: { organizationId: who.organizationId }, select })
    if (holder) return { id: holder.id, via: 'ORGANIZATION' }
  }
  if (who.key) {
    const own = await tx.crmAccount.findUnique({ where: { source_externalKey: who.key }, select })
    if (own) return { id: own.id, via: 'KEY' }
  }
  const compatible: Prisma.CrmAccountWhereInput = who.organizationId
    ? { OR: [{ organizationId: null }, { organizationId: who.organizationId }] }
    : {}
  const people: Array<[FoundVia, Prisma.CrmContactWhereInput | null]> = [
    ['EMAIL', who.emails.length ? { email: { in: who.emails } } : null],
    ['PHONE', who.phones.length ? { phoneE164: { in: who.phones } } : null],
  ]
  for (const [via, contact] of people) {
    if (!contact) continue
    for (const state of [{ archivedAt: null, stage: { kind: 'ABIERTA' } }, {}] satisfies Prisma.CrmAccountWhereInput[]) {
      const found = await tx.crmAccount.findFirst({
        where: { contacts: { some: contact }, ...compatible, ...state },
        select,
        orderBy: [{ lastTouchAt: 'desc' }, { id: 'desc' }],
      })
      if (found) return { id: found.id, via }
    }
  }
  return null
}

/**
 * The account of this person's own source key belongs, under its lock, to ANOTHER business than the one they own (a
 * seller won it for someone else, or it is their first business). Nothing may be written there (Codex autorización H1).
 * `accountForTx` answers it with the account of the person's own Organization (ruling 71); it only gets past that when
 * even that account belongs to another business — a conflict no retry can solve: the landing marks its entry done
 * without an account and logs it once, the backfill skips the signup.
 */
export class IdentityConflictError extends Error {
  constructor(accountId: string, organizationId: string) {
    super(`The CRM account ${accountId} of this person's key belongs to another Organization (${organizationId}); nothing applied`)
    this.name = 'IdentityConflictError'
  }
}

/**
 * THE identity resolver every writer shares (ruling 65 a): the account of this person (`candidateTx`), returned LOCKED
 * (`FOR UPDATE`, the order every writer locks in) and checked again under the lock — still there, still the holder of
 * its Organization, still compatible with this person's — before anything writes contacts or fields. What changed in
 * between (deleted, or linked elsewhere by a «Ganar») is resolved again; the account of the person's own key, which
 * nothing else can replace, linked to another business is an `IdentityConflictError`. Null when the CRM does not have
 * this person.
 */
export async function resolveAccountTx(tx: Prisma.TransactionClient, who: Identity): Promise<ResolvedAccount | null> {
  for (let tries = 0; tries < RESOLVE_TRIES; tries++) {
    const candidate = await candidateTx(tx, who)
    if (!candidate) return null
    const [locked] = await tx.$queryRaw<Array<{ id: string; organizationId: string | null }>>`
      SELECT "id", "organizationId" FROM "CrmAccount" WHERE "id" = ${candidate.id} FOR UPDATE`
    if (!locked) continue
    const compatible = !who.organizationId || !locked.organizationId || locked.organizationId === who.organizationId
    if (candidate.via === 'KEY' && !compatible) throw new IdentityConflictError(locked.id, locked.organizationId!)
    const still = candidate.via === 'ORGANIZATION' ? locked.organizationId === who.organizationId : compatible
    if (still) return { id: locked.id, organizationId: locked.organizationId, via: candidate.via }
  }
  throw new Error('The CRM account of this person kept changing while it was being resolved; the caller retries it')
}

/**
 * The key of a person's account for ONE of their businesses (ruling 71): their source key — the landing's email — with
 * that Organization's id. Deterministic, so a retry finds the same account; (source, externalKey) stays unique.
 */
export const organizationKey = (externalKey: string, organizationId: string) => `${externalKey}|${organizationId}`

/**
 * The account of a person, or a new one (ruling 65 a): resolved first (`resolveAccountTx`, its source key being the one
 * it would be created under); created only when the CRM has nobody, with `upsertAccountBySource`. A writer that creates
 * it — or takes its Organization — at the same instant makes the insert a no-op, and the person is resolved again,
 * under the lock. `via` is null for an account this call created.
 *
 * Ruling 71 — a second business: when the person's own key belongs to ANOTHER Organization than the one this entry
 * brings (a customer of X opening Y), the entry goes to the account of ITS Organization: the one that holds it, or a new
 * one under `organizationKey` and linked to it — never to X's, never a retry forever. Without an Organization there is no
 * conflict: the key's account takes it as always.
 */
export async function accountForTx(
  tx: Prisma.TransactionClient,
  who: Omit<Identity, 'key'>,
  create: UpsertBySourceInput,
): Promise<{ account: { id: string; organizationId: string | null }; created: boolean; via: FoundVia | null }> {
  let input = create
  let identity: Identity = { ...who, key: { source: create.source, externalKey: create.externalKey } }
  for (let tries = 0; tries < RESOLVE_TRIES; tries++) {
    let found: ResolvedAccount | null
    try {
      found = await resolveAccountTx(tx, identity)
    } catch (error) {
      if (!(error instanceof IdentityConflictError) || !who.organizationId || input !== create) throw error
      const externalKey = organizationKey(create.externalKey, who.organizationId)
      input = { ...create, externalKey, data: { ...create.data, organizationId: who.organizationId } }
      // Only this business: its holder or its own key — the person's other accounts belong to their other businesses.
      identity = { emails: [], phones: [], organizationId: who.organizationId, key: { source: create.source, externalKey } }
      continue
    }
    if (found) return { account: { id: found.id, organizationId: found.organizationId }, created: false, via: found.via }
    const upserted = await upsertAccountBySource(tx, input)
    if (upserted.created) return { ...upserted, via: null }
  }
  throw new Error('The CRM account of this person kept changing while it was being created; the caller retries it')
}

type Person = { name: string; email: string | null; phoneE164: string | null }

/** What incorporating a person would write: fill in the contact that has half of them, a new contact, or nothing. */
export type PersonGap = { update: string; data: { email: string } | { phoneE164: string } } | { create: Prisma.CrmContactCreateManyInput }

/**
 * Ruling 57, asked to the database (ruling 65 b, Codex r3 R3-2): what the account still lacks of this person — never
 * read from a page of its contacts, so a person who is its 51st contact is not added again. The contact that already
 * has their phone and no email gets the email (WhatsApp's phone-only person gets the landing's), and the other way
 * around; otherwise a new contact with whatever is missing, primary only on an account that had none. A person with
 * neither email nor phone (a HubSpot contact with only a name) is nobody the CRM can find again: a contact of their own.
 * Reads only; null when nothing is missing.
 */
export async function personGapTx(tx: Prisma.TransactionClient, accountId: string, person: Person): Promise<PersonGap | null> {
  return personGapWith(
    where =>
      tx.crmContact.findFirst({ where: { accountId, ...where }, select: { id: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    accountId,
    person,
  )
}

/** The rule of `personGapTx`, apart from where the contacts are read: `has` answers «does the account already have a contact like this?». */
export async function personGapWith(
  has: (where: Prisma.CrmContactWhereInput) => Promise<{ id: string } | null>,
  accountId: string,
  person: Person,
): Promise<PersonGap | null> {
  const { email, phoneE164 } = person
  const missingEmail = !!email && !(await has({ email }))
  const missingPhone = !!phoneE164 && !(await has({ phoneE164 }))
  if ((email || phoneE164) && !missingEmail && !missingPhone) return null
  if (missingEmail && !missingPhone && phoneE164) {
    const half = await has({ phoneE164, email: null })
    if (half) return { update: half.id, data: { email: email! } }
  }
  if (missingPhone && !missingEmail && email) {
    const half = await has({ email, phoneE164: null })
    if (half) return { update: half.id, data: { phoneE164: phoneE164! } }
  }
  const isPrimary = !(await has({}))
  return {
    create: { accountId, name: person.name, email: missingEmail ? email : null, phoneE164: missingPhone ? phoneE164 : null, isPrimary },
  }
}

/** Writes what `personGapTx` found missing. */
export async function writePersonGapTx(tx: Prisma.TransactionClient, gap: PersonGap): Promise<void> {
  if ('update' in gap) await tx.crmContact.update({ where: { id: gap.update }, data: gap.data, select: { id: true } })
  else await tx.crmContact.create({ data: gap.create, select: { id: true } })
}

/**
 * THE incorporation of a person into an account (ruling 65 b), the one every writer uses — landing, backfill, MCP and the
 * HubSpot import: the account that takes someone keeps their email and phone, or nothing would find it by them later,
 * and never a second contact with the same email or phone. The caller holds the account's row lock (or just created
 * it). True when it wrote.
 */
export async function addPersonTx(tx: Prisma.TransactionClient, accountId: string, person: Person): Promise<boolean> {
  const gap = await personGapTx(tx, accountId, person)
  if (gap) await writePersonGapTx(tx, gap)
  return gap !== null
}

// ── 3. Applying an entry ──────────────────────────────────────────────────────────────────────────────────────────────

/** What the landing asks and, until now, only reached the internal email and HubSpot (spec §5.3). */
type Qualification = { giro: string | null; ventasRango: string | null; sucursales: number | null; modulos: string[] }

const QUALIFICATION_FIELDS = ['giro', 'ventasRango', 'sucursales', 'modulos'] as const

const CUSTOMER_NOTE =
  'Ya es cliente y volvió a llenar el formulario de la landing. Casi siempre trae algo pendiente: vale la pena llamarle.'

interface LandingForm {
  name: string
  qualification: Qualification
  sourceDetail: Prisma.InputJsonObject | undefined
  contact: { name: string; phoneE164: string | null; email: string; isPrimary: true }
  /** The consent box, ticked: the version of the privacy notice the person saw. null = not ticked (never a withdrawal). */
  consent: { noticeVersion: string } | null
}

/** The privacy notice in force when the box was added; an entry that does not say which one it showed is read as this one. */
const DEFAULT_NOTICE_VERSION = '2026-10-02'

const textOf = (value: unknown) => (typeof value === 'string' && value.trim()) || null

/**
 * Where a landing account came from: the page, the UTMs and the campaign of a form — or of the signup's own mark
 * (`LANDING_SIGNUP_CREATED`), which the sweep's backfill reads. Empty fields are left out.
 */
export function sourceDetailOf(form: Prisma.JsonObject): Prisma.InputJsonObject | undefined {
  const detail = Object.entries({
    page: textOf(form.source),
    utm: form.utm && typeof form.utm === 'object' && !Array.isArray(form.utm) ? form.utm : null,
    launchCampaignCode: textOf(form.launchCampaignCode),
    pageUri: textOf(form.pageUri),
    pageName: textOf(form.pageName),
  }).filter(([, value]) => value !== null)
  return detail.length ? (Object.fromEntries(detail) as Prisma.InputJsonObject) : undefined
}

/** The CRM's reading of a stored form. */
function readForm(payload: Prisma.JsonValue, email: string): LandingForm {
  const form: Prisma.JsonObject = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
  const name = textOf(form.companyName) ?? email
  const modules = Array.isArray(form.modules) ? form.modules : typeof form.modules === 'string' ? form.modules.split(',') : []
  // The form calls it `employees` for historical reasons; what it carries is the number of branches. A range («2-5»)
  // does not fit the integer column: it stays in the entry.
  const branches = textOf(form.employees)
  const phone = textOf(form.phone)
  return {
    name,
    qualification: {
      giro: textOf(form.businessType),
      ventasRango: textOf(form.revenue),
      sucursales: branches && /^\d{1,4}$/.test(branches) ? Number(branches) : null,
      modulos: [...new Set(modules.map(textOf).filter((module): module is string => !!module))].slice(0, MAX_LIST),
    },
    sourceDetail: sourceDetailOf(form),
    contact: {
      name: [textOf(form.firstName), textOf(form.lastName)].filter(Boolean).join(' ') || name,
      phoneE164: phone ? canonicalPhoneE164(phone) : null,
      email,
      isPrimary: true,
    },
    // Only a real `true`: the schema lets nothing else through, and the text «true» is not a yes.
    consent: form.marketingConsent === true ? { noticeVersion: textOf(form.privacyNoticeVersion) ?? DEFAULT_NOTICE_VERSION } : null,
  }
}

function asOutcome(value: Prisma.JsonValue): SignupOutcome | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return {
    organizationId: typeof value.organizationId === 'string' ? value.organizationId : null,
    alreadyExisted: value.alreadyExisted === true,
    yaEsCliente: value.yaEsCliente === true,
  }
}

/**
 * The Organization a person OWNS: their active OWNER membership, the primary one first. One rule for applying an entry
 * and for the sweep's link (task 6).
 */
export const OWNED_ORGANIZATION = {
  where: { role: OrgRole.OWNER, isActive: true },
  select: { organization: { select: { id: true, createdAt: true } } },
  orderBy: [{ isPrimary: 'desc' }, { joinedAt: 'asc' }],
  take: 1,
} satisfies Prisma.Staff$organizationsArgs

/** The person with that exact email (the login's rule) and the Organization they OWN, if any. */
type Ownership = { createdAt: Date; hasPassword: boolean; organization: { id: string; createdAt: Date } | null }

async function ownershipOf(email: string): Promise<Ownership | null> {
  const staff = await prisma.staff.findUnique({
    where: { email },
    select: { active: true, password: true, createdAt: true, organizations: OWNED_ORGANIZATION },
  })
  if (!staff?.active) return null
  return { createdAt: staff.createdAt, hasPassword: staff.password !== null, organization: staff.organizations[0]?.organization ?? null }
}

/**
 * The signup never said how it went (its process died before `recordSignupOutcome`): what that email has now answers
 * (rulings 25 and 27). It already existed if the person is older than the form — even owning nothing, like an invited
 * employee: then it has nothing to link. A customer also had a password AND owned an Organization older than the form:
 * a new signup that confirmed its code within the 5 minutes already has a password and is still a new prospect. Nobody
 * with that email, or someone newer than the form who owns nothing → the signup failed.
 */
function outcomeFromOwnership(owner: Ownership | null, receivedAt: Date): SignupOutcome | null {
  if (!owner) return null
  const alreadyExisted = owner.createdAt < receivedAt
  if (!owner.organization) return alreadyExisted ? { organizationId: null, alreadyExisted, yaEsCliente: false } : null
  return {
    organizationId: owner.organization.id,
    alreadyExisted,
    yaEsCliente: alreadyExisted && owner.hasPassword && owner.organization.createdAt < receivedAt,
  }
}

/** The sales team's own Organization (ruling 14): never anybody's client. */
export async function teamOrganizationId(): Promise<string | null> {
  const team = await prisma.crmTeam.findUnique({ where: { key: 'default' }, select: { organizationId: true } })
  return team?.organizationId ?? null
}

async function linkable(organizationId: string | null): Promise<string | null> {
  if (!organizationId) return null
  return (await teamOrganizationId()) === organizationId ? null : organizationId
}

function signupBranch(outcome: SignupOutcome | null) {
  if (!outcome) return 'SIGNUP_FAILED'
  if (outcome.yaEsCliente) return 'CUSTOMER'
  return outcome.alreadyExisted ? 'EXISTING_ACCOUNT' : 'NEW_SIGNUP'
}

const sameValue = (a: unknown, b: unknown) =>
  Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every(item => b.includes(item)) : a === b

const isBlank = (value: Qualification[keyof Qualification]) => value === null || (Array.isArray(value) && !value.length)

/** What the form brings that the account does not have yet. A field the form left empty keeps what the account has. */
function qualificationChanges(current: Qualification, fresh: Qualification) {
  return QUALIFICATION_FIELDS.flatMap(field => {
    const to = fresh[field]
    if (isBlank(to) || sameValue(current[field], to)) return []
    return [{ field, from: current[field], to }]
  })
}

/**
 * Links an account that has no Organization yet; true when it did, false when the Organization is gone. 🔴 The caller
 * holds the account's row lock and knows it is still unlinked: `applyTx`, the backfill (through the resolver) and the
 * sweep's link (task 6) take it before calling, so the LINKED key goes in with the row already theirs.
 *
 * One CRM account per Organization: if another account took it after the caller resolved the person (a «Ganar» in that
 * instant), it THROWS — the caller's transaction rolls back and is retried, and the retry finds that account. A conflict
 * never ends as an entry applied to an account left unlinked (Codex exhaustiva #5).
 */
export async function linkTx(tx: Prisma.TransactionClient, accountId: string, organizationId: string): Promise<boolean> {
  const [holder, organization] = await Promise.all([
    tx.crmAccount.findUnique({ where: { organizationId }, select: { id: true } }),
    tx.organization.findUnique({ where: { id: organizationId }, select: { name: true } }),
  ])
  if (holder) throw new Error(`The Organization ${organizationId} got its CRM account (${holder.id}) meanwhile; retried`)
  if (!organization) {
    logger.warn('[CRM] Account left unlinked: its Organization is gone', { accountId, organizationId })
    return false
  }
  await tx.crmAccount.update({ where: { id: accountId }, data: { organizationId } })
  await resetFirstMoneyTx(tx, accountId, organizationId, null)
  // The same key as the sweep's link (task 6), one per account AND Organization: whoever gets there first writes it, and a
  // re-link after its Organization was deleted (`SetNull`) still leaves its own event (spec §5.10, M-4 of T6's review).
  await addEvent(tx, {
    accountId,
    kind: 'LINKED',
    actorStaffId: null,
    sourceKey: `link:${accountId}:${organizationId}`,
    data: { organizationId, organizationName: organization.name },
  })
  return true
}

const customerNote = (tx: Prisma.TransactionClient, accountId: string, entryId: string) =>
  addEvent(tx, { accountId, kind: 'NOTE', actorStaffId: null, data: { entryId, text: CUSTOMER_NOTE } })

/**
 * The ticked box «Quiero recibir novedades de Avoqado por correo»: the consent of THIS ENTRY'S email, normalized as the
 * campaigns' audience compares it — never the email of the account that took the entry (Brenda, who shares Ana's phone,
 * consents for Brenda). `accountId` is where the entry landed; `consentAt` is when the form was RECEIVED, not when the
 * sweep applied it. One row per email: a later consent brings the row up to date. Nothing here deletes a consent — an
 * entry without the box is not an opt-out, which only comes from the one-click link or the seller (task 3). The timeline
 * says THAT it was given, never by whom (no email), once per entry. The caller is the first run of the entry, inside its
 * transaction: the consent and its ENTRY_APPLIED are written together or not at all.
 */
async function consentTx(
  tx: Prisma.TransactionClient,
  entry: { id: string; externalKey: string; receivedAt: Date },
  form: LandingForm,
  accountId: string,
) {
  if (!form.consent) return
  const email = normalizeEmail(entry.externalKey)
  const data = { accountId, entryId: entry.id, consentAt: entry.receivedAt, source: LANDING, noticeVersion: form.consent.noticeVersion }
  await tx.crmEmailConsent.upsert({ where: { email }, create: { email, ...data }, update: data, select: { id: true } })
  await addEvent(tx, {
    accountId,
    kind: 'FIELD_CHANGE',
    actorStaffId: null,
    sourceKey: `consent:${entry.id}`,
    data: { campo: 'consentimiento' },
  })
}

/** What the team hears after the commit: a new prospect, one that came back from the archive (ruling 31), or nothing. */
type Notice = 'NEW' | 'RETURNED' | null

/** What applying an entry leaves to do after the commit: its notice, with the content fixed in its ENTRY_APPLIED. */
export type AppliedEntry = { accountId: string; notice: Notice; content?: NoticeContent }

/** The notice's words about the business, from an account or a form — never a phone or an email (spec §5.10). */
const noticeContentOf = (from: Qualification & { name: string; qualificationAvailable: boolean }): NoticeContent => ({
  name: from.name,
  giro: from.giro,
  ventasRango: from.ventasRango,
  sucursales: from.sucursales,
  modulos: from.modulos,
  qualificationAvailable: from.qualificationAvailable,
})

/** The content an ENTRY_APPLIED kept, or undefined when it kept none (or something unreadable): then the account is read. */
function savedNoticeContent(value: Prisma.JsonValue | undefined): NoticeContent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { name, giro, ventasRango, sucursales, modulos, qualificationAvailable } = value
  const textOrNull = (field: unknown) => field === null || typeof field === 'string'
  if (typeof name !== 'string' || !textOrNull(giro) || !textOrNull(ventasRango)) return undefined
  if (!(sucursales === null || typeof sucursales === 'number') || !Array.isArray(modulos)) return undefined
  return {
    name,
    giro: giro as string | null,
    ventasRango: ventasRango as string | null,
    sucursales: sucursales as number | null,
    modulos: modulos.filter((module): module is string => typeof module === 'string'),
    qualificationAvailable: qualificationAvailable !== false,
  }
}

/**
 * An entry a run already applied repeats THAT run, never a fresh lookup that may now lead elsewhere: its account, and its
 * notice again if it created a prospect's account or brought one back from the archive, with the content that run fixed
 * — the email's idempotency key keeps it from repeating (rulings 26 and 49). A customer is never announced. The sweep's
 * notice retry reads it too.
 */
export function repeatOf(previous: { accountId: string; data: Prisma.JsonValue }): AppliedEntry {
  const data: Prisma.JsonObject = previous.data && typeof previous.data === 'object' && !Array.isArray(previous.data) ? previous.data : {}
  if (data.signup === 'CUSTOMER') return { accountId: previous.accountId, notice: null }
  const notice: Notice = data.created === true ? 'NEW' : data.reactivated === true ? 'RETURNED' : null
  const content = notice ? savedNoticeContent(data.noticeContent) : undefined
  return { accountId: previous.accountId, notice, ...(content ? { content } : {}) }
}

async function applyTx(
  tx: Prisma.TransactionClient,
  entry: { id: string; externalKey: string; receivedAt: Date },
  form: LandingForm,
  outcome: SignupOutcome | null,
  organizationId: string | null,
  stageId: string,
): Promise<AppliedEntry> {
  const sourceKey = `entry:${entry.id}`
  const applied = { accountId: true, data: true } as const
  // Two runs of the SAME entry (the sweep and a slow request) queue here, so the second one finds the first one's
  // ENTRY_APPLIED below instead of crossing it halfway (ruling 48, T5-r2(a)).
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`crm:entry:${entry.id}`}))::text`
  // Read before anything is looked up or created: if the person stopped owning the Organization whose account a first
  // run used, a fresh lookup would create an orphan account (empty, never announced).
  const previous = await tx.crmTimelineEvent.findUnique({ where: { sourceKey }, select: applied })
  if (previous) return repeatOf(previous)

  const customer = outcome?.yaEsCliente === true
  // THE account of this entry, by the resolver every writer shares (ruling 65 a): the one its Organization already holds,
  // whatever its source (ruling 25); the landing one of this email; or — one per person (ruling 48) — the one of another
  // source that already has this email or phone. Returned locked and checked again under the lock. Only when there is
  // none is one created.
  const { account, created } = await accountForTx(
    tx,
    { emails: [entry.externalKey], phones: form.contact.phoneE164 ? [form.contact.phoneE164] : [], organizationId },
    {
      source: LANDING,
      externalKey: entry.externalKey,
      data: {
        name: form.name,
        ...form.qualification,
        sourceDetail: form.sourceDetail,
        stageId,
        organizationId,
        // Its qualification and its touch are THIS form's, sent at `receivedAt` — never «now» when the sweep repairs it
        // late (ruling 50).
        qualifiedAt: entry.receivedAt,
        lastTouchAt: entry.receivedAt,
      },
      contact: form.contact,
    },
  )
  const accountId = account.id
  /**
   * The proof the entry was applied, and the gate against a run at the same time: the second insert of this `sourceKey`
   * (unique) adds nothing, and that run repeats the first one. One set of events per entry. It keeps what a re-run or
   * the sweep's notice retry must repeat: whether it created or brought back a prospect, and the notice's content.
   */
  const proof = async (data: Prisma.InputJsonObject) => {
    const firstRun = await addEvent(tx, { accountId, kind: 'ENTRY_APPLIED', actorStaffId: null, sourceKey, data })
    if (firstRun) return null
    const winner = await tx.crmTimelineEvent.findUnique({ where: { sourceKey }, select: applied })
    return winner ? repeatOf(winner) : { accountId, notice: null }
  }
  const signup = signupBranch(outcome)

  if (created) {
    // A customer is not a new prospect: the note instead of «Nuevo prospecto» (ruling 23).
    const content = customer ? undefined : noticeContentOf({ name: form.name, ...form.qualification, qualificationAvailable: true })
    const repeated = await proof({ entryId: entry.id, signup, created, ...(content ? { noticeContent: { ...content } } : {}) })
    if (repeated) return repeated
    if (customer) await customerNote(tx, accountId, entry.id)
    await consentTx(tx, entry, form, accountId)
    return { accountId, notice: customer ? null : 'NEW', ...(content ? { content } : {}) }
  }

  // An account that was already there was locked by the resolver BEFORE its event is written: two entries of the same
  // person queue there instead of deadlocking between the event's foreign key and the touch (ruling 26). Everything
  // below reads it under the lock.
  const state = await tx.crmAccount.findUniqueOrThrow({
    where: { id: accountId },
    select: {
      name: true,
      giro: true,
      ventasRango: true,
      sucursales: true,
      modulos: true,
      qualificationAvailable: true,
      qualifiedAt: true,
      lastTouchAt: true,
      organizationId: true,
      archivedAt: true,
      stage: { select: { kind: true } },
    },
  })
  // Ruling 57: the account keeps this person's email and phone (an account of another source may lack them).
  const personGap = await personGapTx(tx, accountId, form.contact)
  // Ruling 31: an ARCHIVED account comes back with the entry — not a lost one, which stays lost (ruling 24).
  const reactivate = state.archivedAt !== null && state.stage.kind !== 'PERDIDA'
  // Ruling 50: the qualification is the NEWEST form's. An older one the sweep repaired late keeps its story in the
  // timeline and overwrites nothing. A customer's account is theirs: what they type does not overwrite it either.
  const carries = QUALIFICATION_FIELDS.some(field => !isBlank(form.qualification[field]))
  const newer = !state.qualifiedAt || entry.receivedAt > state.qualifiedAt
  const qualify = !customer && carries && newer
  const changes = qualify ? qualificationChanges(state, form.qualification) : []
  const fields = Object.fromEntries(changes.map(({ field, to }) => [field, to])) as Partial<Qualification>
  // Back from the archive, it is a prospect again for the team — a customer is not (rulings 23 and 27).
  const notice: Notice = reactivate && !customer ? 'RETURNED' : null
  const content = notice
    ? noticeContentOf({ ...state, ...fields, qualificationAvailable: changes.length ? true : state.qualificationAvailable })
    : undefined

  const repeated = await proof({
    entryId: entry.id,
    signup,
    created,
    ...(reactivate ? { reactivated: true } : {}),
    ...(!customer && carries && !newer ? { qualificationSkipped: true } : {}),
    ...(personGap ? { contactAdded: true } : {}),
    ...(content ? { noticeContent: { ...content } } : {}),
  })
  if (repeated) return repeated
  if (personGap) await writePersonGapTx(tx, personGap)

  // Coming back through the landing is a touch: «Estancado» restarts — from when the form was SENT, never earlier than
  // the touch it already has (ruling 50). Archived, it is back in the pipeline, in «Sin dueño» if nobody owns it.
  await tx.crmAccount.update({
    where: { id: accountId },
    data: {
      lastTouchAt: state.lastTouchAt > entry.receivedAt ? state.lastTouchAt : entry.receivedAt,
      ...(reactivate ? { archivedAt: null } : {}),
      ...(qualify ? { qualifiedAt: entry.receivedAt } : {}),
      ...(changes.length ? { ...fields, qualificationAvailable: true } : {}),
    },
  })
  if (reactivate) {
    await addEvent(tx, { accountId, kind: 'REACTIVATED', actorStaffId: null, data: { entryId: entry.id, via: LANDING } })
  }
  if (customer) await customerNote(tx, accountId, entry.id)
  else if (changes.length) {
    await addEvent(tx, { accountId, kind: 'FIELD_CHANGE', actorStaffId: null, data: { entryId: entry.id, changes } })
  }
  await consentTx(tx, entry, form, accountId)
  if (!state.organizationId && organizationId) await linkTx(tx, accountId, organizationId)
  return { accountId, notice, ...(content ? { content } : {}) }
}

/**
 * Sends an applied entry's notice — the same keys and the content its ENTRY_APPLIED fixed — and writes down how it went
 * (ruling 49): `noticeSentAt` only when it reached everyone; otherwise one more try, and the sweep retries it (up to 5,
 * within the 24 h of the entry). Never throws.
 */
export async function announceEntry(entryId: string, applied: AppliedEntry): Promise<void> {
  if (!applied.notice) return
  const sent =
    applied.notice === 'NEW'
      ? await notifyNewProspect(applied.accountId, applied.content)
      : await notifyReturningProspect(applied.accountId, entryId, applied.content)
  try {
    await prisma.crmInboundEntry.updateMany({
      where: { id: entryId, noticeSentAt: null },
      data: sent ? { noticeSentAt: new Date() } : { noticeAttempts: { increment: 1 } },
    })
  } catch (error) {
    logger.error('[CRM] How the entry’s notice went could not be written; the sweep may send it again (same keys)', {
      entryId,
      sent,
      error: errorText(error),
    })
  }
}

/**
 * Applies a saved entry to the CRM (spec §5.3, step 4), by the signup's outcome:
 * - new signup: the account is created, linked to its new Organization;
 * - an account that already existed: its qualification is updated, with a FIELD_CHANGE;
 * - a customer — the signup's «has a password» AND the person owns an Organization (ruling 27): only a note;
 * - the signup failed: nothing to link — unless the person owns an Organization after all (in a race, the signup of the
 *   other form created it).
 *
 * The Organization (ruling 25): a new signup's is the one it just created — the person is its OWNER by construction.
 * In every other case, failed signups included, only the Organization the person OWNS (never the primary membership
 * the signup returns, of any role); if it already has a CRM account, of any source, the entry goes to THAT account.
 * Without one, the account stays unlinked and the sweep links it when an Organization appears.
 *
 * The person (ruling 48): an account of another source — WhatsApp, HubSpot, by hand — that already has this email or
 * phone takes the entry as a return (touch, reactivation, link, qualification), never a second account.
 * The qualification (ruling 50) is the newest form's: an older entry the sweep repairs late overwrites nothing.
 *
 * With no account to apply to, one is created — «Sin dueño», in the first stage, with its primary person — and
 * announced to the team (`notifyNewProspect`), unless it is a customer's. Never throws: a failure stays on the entry
 * (`lastError`) and the sweep (task 6) runs this same function again.
 */
export async function applyEntry(entryId: string): Promise<void> {
  try {
    const entry = await prisma.crmInboundEntry.findUnique({
      where: { id: entryId },
      select: {
        id: true,
        externalKey: true,
        payload: true,
        receivedAt: true,
        signupOutcome: true,
        signupResolvedAt: true,
        appliedAt: true,
        noticeSentAt: true,
      },
    })
    if (!entry || entry.appliedAt) return
    // An email-less entry would merge every such form into one account.
    if (!entry.externalKey) throw new Error('The entry has no email')

    // No outcome yet and younger than 5 minutes: the signup is still running. Nothing is guessed; the sweep applies it.
    const resolved = entry.signupResolvedAt !== null
    if (!resolved && Date.now() - entry.receivedAt.getTime() < SIGNUP_GRACE_MS) return
    const recorded = resolved ? asOutcome(entry.signupOutcome) : null
    // Only a recorded new signup knows its Organization without asking; everyone else answers by what they OWN.
    const owner = recorded && !recorded.alreadyExisted ? null : await ownershipOf(entry.externalKey)
    // «Customer» for the CRM (ruling 27): the signup's «has a password» AND an Organization of their own — what the email
    // path decides too. An invited employee with a password, filling the form for a business of their own, is a prospect.
    const outcome = resolved
      ? recorded && { ...recorded, yaEsCliente: recorded.yaEsCliente && !!owner?.organization }
      : outcomeFromOwnership(owner, entry.receivedAt)
    const candidate = outcome && !outcome.alreadyExisted ? outcome.organizationId : (owner?.organization?.id ?? null)

    const [stage, organizationId] = await Promise.all([getInitialStage(), linkable(candidate)])
    const form = readForm(entry.payload, entry.externalKey)
    const applied = await prisma.$transaction(tx => applyTx(tx, entry, form, outcome, organizationId, stage.id))
    try {
      await prisma.crmInboundEntry.update({
        where: { id: entryId },
        data: { appliedAt: new Date(), accountId: applied.accountId, lastError: null },
      })
    } finally {
      // Announced even if the mark fails; and a re-run announces again what its first run created or brought back
      // (ruling 26), unless that run's notice already reached everyone — the same email keys, so the team gets each
      // notice once.
      if (!entry.noticeSentAt) await announceEntry(entry.id, applied)
    }
  } catch (error) {
    const message = errorText(error)
    // Ruling 71: even the account of the entry's own Organization belongs to another business. No retry changes that:
    // the entry is closed without an account — never retried forever — and said once, here.
    const permanent = error instanceof IdentityConflictError
    logger.error(
      permanent
        ? '[CRM] The landing entry cannot be applied: the accounts of this person belong to other businesses; closed without one'
        : '[CRM] The landing entry could not be applied; the sweep retries it',
      { entryId, error: message },
    )
    try {
      await prisma.crmInboundEntry.updateMany({
        where: { id: entryId },
        data: { lastError: message.slice(0, MAX_TEXT), ...(permanent ? { appliedAt: new Date() } : {}) },
      })
    } catch {
      // The log above already has it.
    }
  }
}
