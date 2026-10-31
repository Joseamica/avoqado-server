/**
 * Every landing submission lands in the CRM without ever risking the signup (spec 2026-10-30 §5.3).
 *
 * 1. `saveLandingEntry` — the FIRST thing the controller does: the raw form, cleaned, as a `CrmInboundEntry`.
 * 2. The signup (`signupFromLanding`) runs exactly as before; `recordSignupOutcome` writes down what it really returned.
 * 3. `applyEntry` applies the entry to the ONE account it belongs to — the landing account of that email, the account
 *    the Organization the person owns already has (one per Organization), or the account of another source that already
 *    has this person by email or phone (one per person) — and creates it only when there is none; the timeline event
 *    `entry:<id>` proves it was applied. It never throws, and running it again — the sweep after a crash, or both at
 *    once — changes nothing.
 *
 * Nothing here can stop the signup: every function swallows its own failure into the log, and the sweep (task 6) picks
 * up whatever was left half done.
 */
import { OrgRole, Prisma } from '@prisma/client'
import logger from '../../config/logger'
import { canonicalPhoneE164 } from '../../utils/phone'
import prisma from '../../utils/prismaClient'
import { getInitialStage } from './accounts.service'
import { notifyNewProspect, notifyReturningProspect, type NoticeContent } from './digest.service'
import { addEvent } from './timeline.service'

export const LANDING = 'LANDING'
const MAX_TEXT = 500
const MAX_LIST = 20
// ponytail: the accounts that already have this person; past 20 (never seen) the newest-touched 20 are ranked.
const PERSON_CANDIDATES = 20
// ponytail: the people of an account read when an entry or a signup lands on it; the ficha shows the same 50.
const ACCOUNT_CONTACTS = 50
/** Long enough for any signup to finish: an entry younger than this without an outcome waits for the sweep. */
const SIGNUP_GRACE_MS = 5 * 60_000
/** Control characters and lone UTF-16 surrogates: PostgreSQL refuses `\u0000` and broken text in JSONB. */
const UNSAFE = /[\p{Cc}\p{Cs}]/gu

/** What the signup returned; `null` = it failed. The controller passes the real `LandingSignupResult` fields. */
export type SignupOutcome = { organizationId: string | null; alreadyExisted: boolean; yaEsCliente: boolean }

export type CleanEntry = Record<string, string | string[] | Record<string, string>>

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
 * list (or nested object, like the UTMs) at most 20 items. Empty fields are dropped.
 */
export function sanitizeEntry(raw: Record<string, unknown>): CleanEntry {
  const clean: CleanEntry = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) clean[cleanText(key)] = value.slice(0, MAX_LIST).map(asText)
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

// ── 2. The account of an entry key (shared with the HubSpot import and WhatsApp) ─────────────────────────────────────

export interface UpsertBySourceInput {
  source: string
  externalKey: string
  /** The account's fields if it has to be created. An account that already exists is returned untouched. */
  data: Omit<Prisma.CrmAccountCreateManyInput, 'source' | 'externalKey'>
  /** Its primary person, created only together with the account. */
  contact?: Omit<Prisma.CrmContactCreateManyInput, 'accountId'>
}

/**
 * Finds or creates THE account of an entry key — (source, externalKey) is unique — inside the caller's transaction:
 * the landing by email, the HubSpot import by its id (task 8), WhatsApp by phone (task 10).
 *
 * `INSERT … ON CONFLICT DO NOTHING` (`skipDuplicates`) instead of upsert-and-retry-on-P2002: a unique violation aborts
 * the whole Postgres transaction, so a retry inside it could never run. Two callers at once: the second insert waits
 * for the first to commit, inserts nothing, and both read the same row.
 */
export async function upsertAccountBySource(
  tx: Prisma.TransactionClient,
  input: UpsertBySourceInput,
): Promise<{ account: { id: string; organizationId: string | null }; created: boolean }> {
  const { source, externalKey, contact } = input
  const insert = async (data: UpsertBySourceInput['data']) =>
    (await tx.crmAccount.createMany({ data: [{ ...data, source, externalKey }], skipDuplicates: true })).count === 1
  const find = () =>
    tx.crmAccount.findUnique({ where: { source_externalKey: { source, externalKey } }, select: { id: true, organizationId: true } })

  let created = await insert(input.data)
  let account = await find()
  if (!account && input.data.organizationId) {
    // DO NOTHING also skipped a clash on the OTHER unique key: that Organization already has its CRM account. Retried
    // once without it — the account is created unlinked, and the caller sees `organizationId: null`.
    created = await insert({ ...input.data, organizationId: null })
    account = await find()
  }
  if (!account) throw new Error(`The ${source} account was neither created nor found`)
  if (created && contact) await tx.crmContact.create({ data: { ...contact, accountId: account.id }, select: { id: true } })
  return { account, created }
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
}

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
 * Links an account that has no Organization yet, unless another account already holds it (one per Organization); true
 * when it did. 🔴 The caller holds the account's row lock and knows it is still unlinked: `applyTx` and the sweep's link
 * (task 6) both take it before calling, so the LINKED key goes in with the row already theirs.
 */
export async function linkTx(tx: Prisma.TransactionClient, accountId: string, organizationId: string): Promise<boolean> {
  const [holder, organization] = await Promise.all([
    tx.crmAccount.findUnique({ where: { organizationId }, select: { id: true } }),
    tx.organization.findUnique({ where: { id: organizationId }, select: { name: true } }),
  ])
  if (holder || !organization) {
    logger.warn('[CRM] Landing account left unlinked: its Organization is gone or already has a CRM account', {
      accountId,
      organizationId,
      heldBy: holder?.id ?? null,
    })
    return false
  }
  await tx.crmAccount.update({ where: { id: accountId }, data: { organizationId } })
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

/**
 * Ruling 48 — one account per PERSON, whatever source met them first: the accounts with a contact of this exact email or
 * canonical phone (every writer stores them so; both are indexed). The email beats the phone; then the open one touched
 * most recently; with none open, the one touched most recently; the id breaks the last tie, so the choice never
 * depends on the run. An account linked to ANOTHER Organization than the one this person just got is somebody else's
 * business — a shared phone — and never takes the entry.
 */
export async function accountOfPerson(
  tx: Prisma.TransactionClient,
  email: string,
  phoneE164: string | null,
  organizationId: string | null,
): Promise<{ id: string; organizationId: string | null } | null> {
  const found = await tx.crmAccount.findMany({
    where: { contacts: { some: { OR: [{ email }, ...(phoneE164 ? [{ phoneE164 }] : [])] } } },
    select: {
      id: true,
      organizationId: true,
      archivedAt: true,
      stage: { select: { kind: true } },
      // Non-empty when it was found by the EMAIL.
      contacts: { where: { email }, select: { id: true }, take: 1 },
    },
    orderBy: [{ lastTouchAt: 'desc' }, { id: 'desc' }],
    take: PERSON_CANDIDATES,
  })
  const rank = (account: (typeof found)[number]) =>
    (account.contacts.length ? 2 : 0) + (account.stage.kind === 'ABIERTA' && !account.archivedAt ? 1 : 0)
  // `sort` is stable: equal ranks keep the database's order — newest touch, then id.
  const [best] = found
    .filter(account => !organizationId || !account.organizationId || account.organizationId === organizationId)
    .sort((a, b) => rank(b) - rank(a))
  return best ? { id: best.id, organizationId: best.organizationId } : null
}

/** An account's people, as `addPersonTx` needs them. */
export const PERSON_CONTACTS = {
  select: { id: true, email: true, phoneE164: true },
  orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  take: ACCOUNT_CONTACTS,
} satisfies Prisma.CrmAccount$contactsArgs

type PersonContact = { id: string; email: string | null; phoneE164: string | null }
type Person = { name: string; email: string | null; phoneE164: string | null }

/** Whether the account still lacks this person's email or phone (ruling 57). */
export const lacksPerson = (contacts: PersonContact[], person: Person) =>
  (!!person.email && !contacts.some(contact => contact.email === person.email)) ||
  (!!person.phoneE164 && !contacts.some(contact => contact.phoneE164 === person.phoneE164))

/**
 * Ruling 57: the account that takes someone's entry — or signup — keeps their email and phone, or nothing would find it
 * by them later (the sweep's late link reads the entry; a seller searches by email). Never a second contact with the same
 * email or phone: the contact that already has one of them and lacks the other gets it (WhatsApp's phone-only person
 * gets the landing's email); otherwise a new contact, primary only on an account that had none. The caller holds the
 * account's row lock. True when it wrote.
 */
export async function addPersonTx(tx: Prisma.TransactionClient, accountId: string, contacts: PersonContact[], person: Person) {
  const missingEmail = !!person.email && !contacts.some(contact => contact.email === person.email)
  const missingPhone = !!person.phoneE164 && !contacts.some(contact => contact.phoneE164 === person.phoneE164)
  if (!missingEmail && !missingPhone) return false
  const half = contacts.find(contact =>
    missingEmail
      ? !missingPhone && contact.phoneE164 === person.phoneE164 && !contact.email
      : contact.email === person.email && !contact.phoneE164,
  )
  if (half) {
    await tx.crmContact.update({ where: { id: half.id }, data: missingEmail ? { email: person.email } : { phoneE164: person.phoneE164 } })
  } else {
    await tx.crmContact.create({
      data: {
        accountId,
        name: person.name,
        email: missingEmail ? person.email : null,
        phoneE164: missingPhone ? person.phoneE164 : null,
        isPrimary: contacts.length === 0,
      },
      select: { id: true },
    })
  }
  return true
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
  const select = { id: true, organizationId: true } as const
  // THE account of this entry: the landing one of this email; or — one CRM account per Organization (ruling 25) — the
  // one its Organization already has, whatever its source; or — one per person (ruling 48) — the one of another source
  // that already has this email or phone. Only when there is none is one created.
  let account = await tx.crmAccount.findUnique({
    where: { source_externalKey: { source: LANDING, externalKey: entry.externalKey } },
    select,
  })
  if (!account && organizationId) account = await tx.crmAccount.findUnique({ where: { organizationId }, select })
  if (!account) account = await accountOfPerson(tx, entry.externalKey, form.contact.phoneE164, organizationId)
  let created = false
  if (!account) {
    const upserted = await upsertAccountBySource(tx, {
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
    })
    account = upserted.account
    created = upserted.created
    // ponytail: only if an Organization gets its CRM account between the lookup above and this insert (a «Ganar» in the
    // same instant): the account is created unlinked — and announced, unless it is a customer's — and the sweep's link
    // logs it.
    if (created && organizationId && account.organizationId !== organizationId) {
      logger.warn('[CRM] New landing account created unlinked: its Organization already has a CRM account', {
        accountId: account.id,
        organizationId,
      })
    }
  }
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
    return { accountId, notice: customer ? null : 'NEW', ...(content ? { content } : {}) }
  }

  // An account that was already there is locked BEFORE its event is written: two entries of the same email queue here
  // instead of deadlocking between the event's foreign key and the touch (ruling 26). Everything below reads it under the
  // lock.
  await tx.$queryRaw`SELECT "id" FROM "CrmAccount" WHERE "id" = ${accountId} FOR UPDATE`
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
      contacts: PERSON_CONTACTS,
    },
  })
  // Ruling 57: the account keeps this person's email and phone (an account of another source may lack them).
  const addsPerson = lacksPerson(state.contacts, form.contact)
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
    ...(addsPerson ? { contactAdded: true } : {}),
    ...(content ? { noticeContent: { ...content } } : {}),
  })
  if (repeated) return repeated
  if (addsPerson) await addPersonTx(tx, accountId, state.contacts, form.contact)

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
    logger.error('[CRM] The landing entry could not be applied; the sweep retries it', { entryId, error: message })
    try {
      await prisma.crmInboundEntry.updateMany({ where: { id: entryId }, data: { lastError: message.slice(0, MAX_TEXT) } })
    } catch {
      // The log above already has it.
    }
  }
}
