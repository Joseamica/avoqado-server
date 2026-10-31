/**
 * Every landing submission lands in the CRM without ever risking the signup (spec 2026-10-30 §5.3).
 *
 * 1. `saveLandingEntry` — the FIRST thing the controller does: the raw form, cleaned, as a `CrmInboundEntry`.
 * 2. The signup (`signupFromLanding`) runs exactly as before; `recordSignupOutcome` writes down what it really returned.
 * 3. `applyEntry` turns the entry into THE account of that email: one upsert by (LANDING, email) plus the timeline event
 *    that proves the entry was applied. It never throws, and running it again — the sweep after a crash, or both at
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
import { notifyNewProspect } from './digest.service'
import { addEvent } from './timeline.service'

const LANDING = 'LANDING'
const MAX_TEXT = 500
const MAX_LIST = 20
/** Long enough for any signup to finish: an entry younger than this without an outcome waits for the sweep. */
const SIGNUP_GRACE_MS = 5 * 60_000
/** Control characters and lone UTF-16 surrogates: PostgreSQL refuses `\u0000` and broken text in JSONB. */
const UNSAFE = /[\p{Cc}\p{Cs}]/gu

/** What the signup returned; `null` = it failed. The controller passes the real `LandingSignupResult` fields. */
export type SignupOutcome = { organizationId: string | null; alreadyExisted: boolean; yaEsCliente: boolean }

export type CleanEntry = Record<string, string | string[] | Record<string, string>>

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

// ── 1. The raw entry ──────────────────────────────────────────────────────────────────────────────────────────────────

function cleanText(value: string): string {
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

/** The CRM's reading of a stored form. */
function readForm(payload: Prisma.JsonValue, email: string): LandingForm {
  const form: Prisma.JsonObject = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
  const name = textOf(form.companyName) ?? email
  const modules = Array.isArray(form.modules) ? form.modules : typeof form.modules === 'string' ? form.modules.split(',') : []
  // The form calls it `employees` for historical reasons; what it carries is the number of branches. A range («2-5»)
  // does not fit the integer column: it stays in the entry.
  const branches = textOf(form.employees)
  const phone = textOf(form.phone)
  const detail = Object.entries({
    page: textOf(form.source),
    utm: form.utm && typeof form.utm === 'object' && !Array.isArray(form.utm) ? form.utm : null,
    launchCampaignCode: textOf(form.launchCampaignCode),
    pageUri: textOf(form.pageUri),
    pageName: textOf(form.pageName),
  }).filter(([, value]) => value !== null)
  return {
    name,
    qualification: {
      giro: textOf(form.businessType),
      ventasRango: textOf(form.revenue),
      sucursales: branches && /^\d{1,4}$/.test(branches) ? Number(branches) : null,
      modulos: [...new Set(modules.map(textOf).filter((module): module is string => !!module))].slice(0, MAX_LIST),
    },
    sourceDetail: detail.length ? (Object.fromEntries(detail) as Prisma.InputJsonObject) : undefined,
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
 * The signup never said how it went (its process died before `recordSignupOutcome`): the account that email has now
 * answers. An active OWNER of an Organization counts as an account that already existed — a customer if it has a
 * password, the signup's own rule — and nobody means the signup failed.
 */
async function outcomeByEmail(email: string): Promise<SignupOutcome | null> {
  const staff = await prisma.staff.findUnique({
    where: { email },
    select: {
      active: true,
      password: true,
      organizations: {
        where: { role: OrgRole.OWNER, isActive: true },
        select: { organizationId: true },
        orderBy: [{ isPrimary: 'desc' }, { joinedAt: 'asc' }],
        take: 1,
      },
    },
  })
  if (!staff?.active || !staff.organizations.length) return null
  return { organizationId: staff.organizations[0].organizationId, alreadyExisted: true, yaEsCliente: staff.password !== null }
}

/** The Organization the account may link to. The sales team's own is never anybody's client (ruling 14). */
async function linkableOrganization(outcome: SignupOutcome | null): Promise<string | null> {
  if (!outcome?.organizationId) return null
  const team = await prisma.crmTeam.findUnique({ where: { key: 'default' }, select: { organizationId: true } })
  return team?.organizationId === outcome.organizationId ? null : outcome.organizationId
}

function signupBranch(outcome: SignupOutcome | null) {
  if (!outcome) return 'SIGNUP_FAILED'
  if (outcome.yaEsCliente) return 'CUSTOMER'
  return outcome.alreadyExisted ? 'EXISTING_ACCOUNT' : 'NEW_SIGNUP'
}

const sameValue = (a: unknown, b: unknown) =>
  Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every(item => b.includes(item)) : a === b

/** What the form brings that the account does not have yet. A field the form left empty keeps what the account has. */
function qualificationChanges(current: Qualification, fresh: Qualification) {
  return QUALIFICATION_FIELDS.flatMap(field => {
    const to = fresh[field]
    if (to === null || (Array.isArray(to) && !to.length) || sameValue(current[field], to)) return []
    return [{ field, from: current[field], to }]
  })
}

/** Links an account that has no Organization yet, unless another account already holds it (one per Organization). */
async function linkTx(tx: Prisma.TransactionClient, accountId: string, organizationId: string) {
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
    return
  }
  await tx.crmAccount.update({ where: { id: accountId }, data: { organizationId } })
  // Same key as the sweep's link (task 6): an account is linked once, whoever gets there first.
  await addEvent(tx, {
    accountId,
    kind: 'LINKED',
    actorStaffId: null,
    sourceKey: `link:${accountId}`,
    data: { organizationId, organizationName: organization.name },
  })
}

async function applyTx(
  tx: Prisma.TransactionClient,
  entry: { id: string; externalKey: string },
  form: LandingForm,
  outcome: SignupOutcome | null,
  organizationId: string | null,
  stageId: string,
): Promise<{ accountId: string; created: boolean }> {
  const { account, created } = await upsertAccountBySource(tx, {
    source: LANDING,
    externalKey: entry.externalKey,
    data: { name: form.name, ...form.qualification, sourceDetail: form.sourceDetail, stageId, organizationId },
    contact: form.contact,
  })
  if (created && organizationId && account.organizationId !== organizationId) {
    logger.warn('[CRM] New landing account created unlinked: its Organization already has a CRM account', {
      accountId: account.id,
      organizationId,
    })
  }
  // The proof the entry was applied. A second run inserts nothing here (`sourceKey` is unique) and stops: one set of
  // events per entry, even after a crash before `appliedAt`.
  const firstRun = await addEvent(tx, {
    accountId: account.id,
    kind: 'ENTRY_APPLIED',
    actorStaffId: null,
    sourceKey: `entry:${entry.id}`,
    data: { entryId: entry.id, signup: signupBranch(outcome), created },
  })
  if (!firstRun || created) return { accountId: account.id, created: created && firstRun }

  // The account was already there. Touching it takes its row lock — two entries on one account apply one after the
  // other — and returns what the other one left. Coming back through the landing is a touch: «Estancado» restarts.
  const current = await tx.crmAccount.update({
    where: { id: account.id },
    data: { lastTouchAt: new Date() },
    select: { giro: true, ventasRango: true, sucursales: true, modulos: true, organizationId: true },
  })
  if (outcome?.yaEsCliente) {
    // A customer's account is theirs: what they type in the form does not overwrite it.
    await addEvent(tx, { accountId: account.id, kind: 'NOTE', actorStaffId: null, data: { entryId: entry.id, text: CUSTOMER_NOTE } })
  } else {
    const changes = qualificationChanges(current, form.qualification)
    if (changes.length) {
      const data: Prisma.CrmAccountUpdateInput = { qualificationAvailable: true }
      for (const { field, to } of changes) Object.assign(data, { [field]: to })
      await tx.crmAccount.update({ where: { id: account.id }, data })
      await addEvent(tx, { accountId: account.id, kind: 'FIELD_CHANGE', actorStaffId: null, data: { entryId: entry.id, changes } })
    }
  }
  if (!current.organizationId && organizationId) await linkTx(tx, account.id, organizationId)
  return { accountId: account.id, created: false }
}

/**
 * Applies a saved entry to the CRM (spec §5.3, step 4), by the signup's outcome:
 * - new signup: the account is created, linked to its new Organization;
 * - an account that already existed: its qualification is updated, with a FIELD_CHANGE;
 * - already a customer: only a note;
 * - the signup failed: the account stays without an Organization (the sweep links it when one appears).
 *
 * Whatever the outcome, a missing account is created — «Sin dueño», in the first stage, with its primary person — and
 * a new one is announced to the team (`notifyNewProspect`). Never throws: a failure stays on the entry (`lastError`)
 * and the sweep (task 6) runs this same function again.
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
      },
    })
    if (!entry || entry.appliedAt) return
    // An email-less entry would merge every such form into one account.
    if (!entry.externalKey) throw new Error('The entry has no email')

    // No outcome yet and younger than 5 minutes: the signup is still running. Nothing is guessed; the sweep applies it.
    if (!entry.signupResolvedAt && Date.now() - entry.receivedAt.getTime() < SIGNUP_GRACE_MS) return
    const outcome = entry.signupResolvedAt ? asOutcome(entry.signupOutcome) : await outcomeByEmail(entry.externalKey)

    const [stage, organizationId] = await Promise.all([getInitialStage(), linkableOrganization(outcome)])
    const form = readForm(entry.payload, entry.externalKey)
    const applied = await prisma.$transaction(tx => applyTx(tx, entry, form, outcome, organizationId, stage.id))
    try {
      await prisma.crmInboundEntry.update({
        where: { id: entryId },
        data: { appliedAt: new Date(), accountId: applied.accountId, lastError: null },
      })
    } finally {
      // Announced even if the mark fails: a re-run would find the account and never announce it.
      if (applied.created) await notifyNewProspect(applied.accountId)
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
