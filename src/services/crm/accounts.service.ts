/**
 * The CRM's accounts (spec 2026-10-30 §5.2–5.4): ONE record from prospect to client, the pipeline it moves through, its
 * traffic light, «Estancado», losing, winning and «Mis pendientes» — plus the catalogs the pipeline stands on: stages and
 * lost reasons.
 *
 * 🔴 Every change to an account starts with the same UPDATE (`touchTx`): it checks the caller may change it, takes the
 * row's lock — two sellers on the same account queue there, so no change and no timeline event is lost — and moves
 * `lastTouchAt`, because every note, activity and change is a touch and «Estancado» counts from it.
 *
 * «Today» is Mexico City's day for the whole team: it is where Avoqado sells, whatever zone the server runs in.
 */
import { OrgRole, Prisma } from '@prisma/client'
import { ConflictError, ForbiddenError, InternalServerError, NotFoundError, ValidationError } from '../../errors/AppError'
import type { Semaforo } from '../../schemas/crm.schema'
import { DEFAULT_TIMEZONE, venueEndOfDay, venueStartOfDay } from '../../utils/datetime'
import { canonicalPhoneE164 } from '../../utils/phone'
import prisma from '../../utils/prismaClient'
import { logAction } from '../dashboard/activity-log.service'
import { normalizeEmail } from '../marketing/emailSuppression.service'
import { getCrmAccess, scopeWhere, type CrmAccess } from './access.service'
import { movePendingActivitiesTx, type OwnerChangeReason } from './ownership'
import { addEvent } from './timeline.service'

type Db = Prisma.TransactionClient | typeof prisma

const DAY_MS = 86_400_000
const DEFAULT_PAGE = 50
const MAX_PAGE = 100
const PENDING_CAP = 50
const DUPLICATES_CAP = 10
const SEARCH_CAP = 10
/** Stages and lost reasons are a handful each; the cap is a guard, never reached. */
const CATALOG_CAP = 100
const DEFAULTS_LOCK = 'crm:defaults'

// ── Stages and lost reasons ───────────────────────────────────────────────────────────────────────────────────────────

/** The pipeline the team already works with (spec §5.4). Created once, while the table is still empty. */
const DEFAULT_STAGES: Prisma.CrmStageCreateManyInput[] = [
  { name: 'Prospecto', order: 1, kind: 'ABIERTA', staleDays: 2 },
  { name: 'Contacto inicial', order: 2, kind: 'ABIERTA', staleDays: 3 },
  { name: 'Calificado', order: 3, kind: 'ABIERTA', staleDays: 5 },
  { name: 'Demo', order: 4, kind: 'ABIERTA', staleDays: 5 },
  { name: 'Negociación', order: 5, kind: 'ABIERTA', staleDays: 7 },
  { name: 'Ganado', order: 6, kind: 'GANADA', staleDays: null },
  { name: 'Perdido', order: 7, kind: 'PERDIDA', staleDays: null },
]
const DEFAULT_LOST_REASONS = ['Dijo que no', 'Eligió a otro', 'No es para nosotros', '14 días sin contestar', 'Precio']

/**
 * Seeds the stages and the lost reasons, each table ONLY while it is empty: an admin who renames «Prospecto» never gets
 * it back. Every CRM read that needs them calls it first; once they exist it costs two counts of a tiny table.
 */
export async function ensureCrmDefaults(): Promise<void> {
  const [stages, reasons] = await Promise.all([prisma.crmStage.count(), prisma.crmLostReason.count()])
  if (stages > 0 && reasons > 0) return

  await prisma.$transaction(async tx => {
    // Two first calls at once: the second waits here, then finds the tables filled and creates nothing.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${DEFAULTS_LOCK}))::text`
    if ((await tx.crmStage.count()) === 0) await tx.crmStage.createMany({ data: DEFAULT_STAGES })
    if ((await tx.crmLostReason.count()) === 0) {
      await tx.crmLostReason.createMany({ data: DEFAULT_LOST_REASONS.map(name => ({ name })) })
    }
  })
}

const STAGE_SELECT = { id: true, name: true, order: true, kind: true, staleDays: true } satisfies Prisma.CrmStageSelect
const LOST_REASON_SELECT = { id: true, name: true, active: true } satisfies Prisma.CrmLostReasonSelect

export async function listStages() {
  await ensureCrmDefaults()
  return prisma.crmStage.findMany({ select: STAGE_SELECT, orderBy: [{ order: 'asc' }, { id: 'asc' }], take: CATALOG_CAP })
}

export async function listLostReasons() {
  await ensureCrmDefaults()
  return prisma.crmLostReason.findMany({ select: LOST_REASON_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: CATALOG_CAP })
}

/**
 * A new stage is always an OPEN one: there is one «Ganado» and one «Perdido». The defaults go in first (M-3): on a new
 * database a stage created before them would leave the table non-empty forever, with no way to win or lose.
 */
export async function createStage(actor: CrmAccess, input: { name: string; order: number; staleDays?: number | null }) {
  await ensureCrmDefaults()
  const stage = await prisma.crmStage
    .create({ data: { name: input.name, order: input.order, staleDays: input.staleDays ?? null, kind: 'ABIERTA' }, select: STAGE_SELECT })
    .catch(nameTaken)
  void logAction({
    staffId: actor.staffId,
    venueId: null,
    action: 'CRM_STAGE_CREATED',
    entity: 'CrmStage',
    entityId: stage.id,
    data: stage,
  })
  return stage
}

/**
 * Renames, reorders or changes the days for «Estancado». The kind is never written, whatever slips into the input, and
 * nothing is deleted in phase 1: a stage with accounts is renamed.
 */
export async function updateStage(actor: CrmAccess, id: string, input: { name?: string; order?: number; staleDays?: number | null }) {
  const before = await prisma.crmStage.findUnique({ where: { id }, select: STAGE_SELECT })
  if (!before) throw new NotFoundError('Esa etapa no existe', 'CRM_STAGE_NOT_FOUND')
  const data: Prisma.CrmStageUpdateInput = {}
  if (input.name !== undefined) data.name = input.name
  if (input.order !== undefined) data.order = input.order
  if (input.staleDays !== undefined) data.staleDays = input.staleDays
  const stage = await prisma.crmStage.update({ where: { id }, data, select: STAGE_SELECT }).catch(nameTaken)
  void logAction({
    staffId: actor.staffId,
    venueId: null,
    action: 'CRM_STAGE_UPDATED',
    entity: 'CrmStage',
    entityId: id,
    data: { before, after: stage },
  })
  return stage
}

/** Like `createStage`: the five default reasons go in first, or a first reason would keep them out forever (M-3). */
export async function createLostReason(actor: CrmAccess, input: { name: string }) {
  await ensureCrmDefaults()
  const reason = await prisma.crmLostReason.create({ data: { name: input.name }, select: LOST_REASON_SELECT }).catch(nameTaken)
  void logAction({
    staffId: actor.staffId,
    venueId: null,
    action: 'CRM_LOST_REASON_CREATED',
    entity: 'CrmLostReason',
    entityId: reason.id,
    data: reason,
  })
  return reason
}

/** Renames or turns a reason off. Never deleted: lost accounts keep pointing at it. */
export async function updateLostReason(actor: CrmAccess, id: string, input: { name?: string; active?: boolean }) {
  const before = await prisma.crmLostReason.findUnique({ where: { id }, select: LOST_REASON_SELECT })
  if (!before) throw new NotFoundError('Ese motivo no existe', 'CRM_LOST_REASON_NOT_FOUND')
  const data: Prisma.CrmLostReasonUpdateInput = {}
  if (input.name !== undefined) data.name = input.name
  if (input.active !== undefined) data.active = input.active
  const reason = await prisma.crmLostReason.update({ where: { id }, data, select: LOST_REASON_SELECT }).catch(nameTaken)
  void logAction({
    staffId: actor.staffId,
    venueId: null,
    action: 'CRM_LOST_REASON_UPDATED',
    entity: 'CrmLostReason',
    entityId: id,
    data: { before, after: reason },
  })
  return reason
}

function nameTaken(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new ConflictError('Ya hay uno con ese nombre', 'CRM_NOMBRE_REPETIDO')
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
    throw new NotFoundError('Ya no existe', 'CRM_NOT_FOUND')
  }
  throw error
}

/** Where a new account starts: the first open stage. The landing, WhatsApp and the HubSpot import start there too. */
export async function getInitialStage(): Promise<{ id: string; name: string }> {
  await ensureCrmDefaults()
  const stage = await prisma.crmStage.findFirst({
    where: { kind: 'ABIERTA' },
    orderBy: [{ order: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true },
  })
  if (!stage) throw new InternalServerError('El CRM no tiene ninguna etapa abierta')
  return stage
}

async function closedStage(kind: 'GANADA' | 'PERDIDA'): Promise<{ id: string; name: string }> {
  await ensureCrmDefaults()
  const stage = await prisma.crmStage.findFirst({
    where: { kind },
    orderBy: [{ order: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true },
  })
  if (!stage) throw new InternalServerError(`El CRM no tiene la etapa de ${kind === 'GANADA' ? 'Ganado' : 'Perdido'}`)
  return stage
}

// ── The traffic light and «Estancado» ─────────────────────────────────────────────────────────────────────────────────

const teamDay = (now: Date) => ({ start: venueStartOfDay(DEFAULT_TIMEZONE, now), end: venueEndOfDay(DEFAULT_TIMEZONE, now) })

/** Pipedrive's light: 🔴 overdue (before today) · 🟢 due today · ⚪ later · 🟡 no next step. */
export function semaforo(row: { nextActivityAt: Date | null }, now: Date): Semaforo {
  if (!row.nextActivityAt) return 'amarillo'
  const { start, end } = teamDay(now)
  if (row.nextActivityAt < start) return 'rojo'
  return row.nextActivityAt <= end ? 'verde' : 'gris'
}

/**
 * «Estancado · N días»: whole days since the last touch, once they are MORE than the stage's limit. Null for an account
 * that is not stale, or cannot be: won, lost, archived, or in a stage without a limit.
 */
export function estancadoDias(
  row: { lastTouchAt: Date; archivedAt?: Date | null },
  stage: { kind: string; staleDays: number | null },
  now: Date,
): number | null {
  if (stage.kind !== 'ABIERTA' || !stage.staleDays || row.archivedAt) return null
  const idle = now.getTime() - row.lastTouchAt.getTime()
  return idle > stage.staleDays * DAY_MS ? Math.floor(idle / DAY_MS) : null
}

// ── Rows ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

const ROW_SELECT = {
  id: true,
  name: true,
  giro: true,
  ventasRango: true,
  source: true,
  ownerStaffId: true,
  owner: { select: { id: true, firstName: true, lastName: true } },
  stageId: true,
  stage: { select: { id: true, name: true, kind: true, staleDays: true } },
  nextActivityAt: true,
  lastTouchAt: true,
  firstMoneyAt: true,
  organizationId: true,
  archivedAt: true,
  createdAt: true,
} satisfies Prisma.CrmAccountSelect

type AccountRecord = Prisma.CrmAccountGetPayload<{ select: typeof ROW_SELECT }>

const NEXT_ACTIVITY_SELECT = {
  id: true,
  accountId: true,
  type: true,
  title: true,
  dueAt: true,
  assigneeStaffId: true,
} satisfies Prisma.CrmActivitySelect

type NextActivity = Omit<Prisma.CrmActivityGetPayload<{ select: typeof NEXT_ACTIVITY_SELECT }>, 'accountId'>

/** In the pipeline: open and not archived. The light and «Estancado» only mean something there. */
const LIVE: Prisma.CrmAccountWhereInput = { archivedAt: null, stage: { kind: 'ABIERTA' } }

const fullName = (person: { firstName: string; lastName: string }) => `${person.firstName} ${person.lastName}`.trim()

/** One account as every list shows it. `nextActivity` is its earliest pending one: what the card says and «Hecha» completes. */
function toRow(account: AccountRecord, nextActivity: NextActivity | null, now: Date) {
  const live = account.stage.kind === 'ABIERTA' && !account.archivedAt
  return {
    id: account.id,
    name: account.name,
    giro: account.giro,
    ventasRango: account.ventasRango,
    source: account.source,
    owner: account.owner ? { id: account.owner.id, name: fullName(account.owner) } : null,
    stage: { id: account.stage.id, name: account.stage.name, kind: account.stage.kind },
    nextActivityAt: account.nextActivityAt,
    nextActivity,
    semaforo: live ? semaforo(account, now) : null,
    estancadoDias: estancadoDias(account, account.stage, now),
    firstMoneyAt: account.firstMoneyAt,
    organizationId: account.organizationId,
    archivedAt: account.archivedAt,
    createdAt: account.createdAt,
  }
}

export type AccountRow = ReturnType<typeof toRow>

/** The rows of a page, with the next activity of every one of them in ONE query. */
async function toRows(db: Db, accounts: AccountRecord[], now: Date): Promise<AccountRow[]> {
  const scheduled = accounts.filter(account => account.nextActivityAt)
  const pending = scheduled.length
    ? await db.crmActivity.findMany({
        // `nextActivityAt` IS the earliest pending dueAt (`recomputeNext`), so each row asks for exactly that instant.
        where: { doneAt: null, OR: scheduled.map(account => ({ accountId: account.id, dueAt: account.nextActivityAt ?? undefined })) },
        select: NEXT_ACTIVITY_SELECT,
        orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
        // ponytail: room for 4 activities due at the very same instant per row; past that a row could lose its card.
        take: scheduled.length * 4,
      })
    : []
  const first = new Map<string, NextActivity>()
  for (const { accountId, ...activity } of pending) if (!first.has(accountId)) first.set(accountId, activity)
  return accounts.map(account => toRow(account, first.get(account.id) ?? null, now))
}

async function rowTx(db: Db, id: string, now: Date): Promise<AccountRow> {
  const account = await db.crmAccount.findUniqueOrThrow({ where: { id }, select: ROW_SELECT })
  const [row] = await toRows(db, [account], now)
  return row
}

const accountNotFound = () => new NotFoundError('No encontramos ese negocio', 'CRM_ACCOUNT_NOT_FOUND')

/**
 * A touch that never moves «Estancado» back (ruling 65 e, Codex exhaustiva #10): `lastTouchAt` becomes the later of the
 * one it has and this one. A writer that took its «now» before waiting for the row's lock — while another writer
 * touched it later — leaves the later touch. The caller holds the row's lock.
 */
export function touchNoEarlierTx(tx: Prisma.TransactionClient, id: string, at: Date) {
  return tx.crmAccount.updateMany({ where: { id, lastTouchAt: { lt: at } }, data: { lastTouchAt: at } })
}

/**
 * The first statements of every change to an account: checks the scope and takes the row's lock — at once — then
 * touches it (`touchNoEarlierTx`). 404 when the caller cannot even see it (a «propios» seller never learns someone
 * else's account exists); 403 when they see it but may not change it.
 */
async function touchTx(tx: Prisma.TransactionClient, access: CrmAccess, id: string, scope: Prisma.CrmAccountWhereInput, now: Date) {
  const { count } = await tx.crmAccount.updateMany({ where: { AND: [{ id }, scope] }, data: { updatedAt: now } })
  if (count === 0) {
    const visible = await tx.crmAccount.findFirst({ where: { AND: [{ id }, scopeWhere(access, 'ver')] }, select: { id: true } })
    if (visible) throw new ForbiddenError('Sólo puedes cambiar tus negocios y los que no tienen dueño', 'CRM_NO_ES_TUYO')
    throw accountNotFound()
  }
  await touchNoEarlierTx(tx, id, now)
  return tx.crmAccount.findUniqueOrThrow({ where: { id }, select: ROW_SELECT })
}

/** `touchTx` with the caller's «Editar» scope: notes, activities, stage changes, losing and winning. */
export function touchEditableTx(tx: Prisma.TransactionClient, access: CrmAccess, id: string, now: Date) {
  return touchTx(tx, access, id, scopeWhere(access, 'editar'), now)
}

// ── Lists ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface AccountFilters {
  stageId?: string
  ownerStaffId?: string
  source?: string
  semaforo?: Semaforo
  sinDueno?: boolean
  estancados?: boolean
  q?: string
  /** A person with exactly this email (any capitals). Unlike `q`, it never matches by name or by phone digits. */
  email?: string
  cursor?: string
  limit?: number
}

function semaforoWhere(color: Semaforo, now: Date): Prisma.CrmAccountWhereInput {
  const { start, end } = teamDay(now)
  switch (color) {
    case 'rojo':
      return { nextActivityAt: { lt: start } }
    case 'verde':
      return { nextActivityAt: { gte: start, lte: end } }
    case 'gris':
      return { nextActivityAt: { gt: end } }
    case 'amarillo':
      return { nextActivityAt: null }
  }
}

/** «Estancado» over these stages, as a filter — the same rule as `estancadoDias`. Stages that cannot go stale are skipped. */
export function staleWhereFor(
  stages: Array<{ id: string; kind?: string; staleDays: number | null }>,
  now: Date,
): Prisma.CrmAccountWhereInput {
  const limited = stages.filter(stage => (stage.kind ?? 'ABIERTA') === 'ABIERTA' && stage.staleDays)
  if (!limited.length) return { id: { in: [] } }
  return {
    OR: limited.map(stage => ({ stageId: stage.id, lastTouchAt: { lt: new Date(now.getTime() - (stage.staleDays ?? 0) * DAY_MS) } })),
  }
}

/** «Estancado», asked to the database stage by stage. */
async function staleWhere(now: Date): Promise<Prisma.CrmAccountWhereInput> {
  const stages = await prisma.crmStage.findMany({
    where: { kind: 'ABIERTA', staleDays: { gt: 0 } },
    select: { id: true, staleDays: true },
    take: CATALOG_CAP,
  })
  return staleWhereFor(stages, now)
}

/** By the account's name, or its people's name, email or phone (digits only, any format). */
function searchWhere(q: string): Prisma.CrmAccountWhereInput {
  const term = q.trim()
  const digits = term.replace(/\D/g, '')
  const text = { contains: term, mode: 'insensitive' as const }
  const people: Prisma.CrmContactWhereInput[] = [{ name: text }, { email: text }]
  if (digits.length >= 4) people.push({ phoneE164: { contains: digits } })
  return { OR: [{ name: text }, { contacts: { some: { OR: people } } }] }
}

/**
 * What the pipeline list — and its CSV export — shows for these filters, within the caller's scope. Archived accounts are
 * out of it, but a search finds them (to reactivate them).
 */
export async function accountsWhere(access: CrmAccess, filters: AccountFilters, now: Date): Promise<Prisma.CrmAccountWhereInput> {
  const and: Prisma.CrmAccountWhereInput[] = [scopeWhere(access, 'ver')]
  if (!filters.q && !filters.email) and.push({ archivedAt: null })
  if (filters.stageId) and.push({ stageId: filters.stageId })
  if (filters.ownerStaffId) and.push({ ownerStaffId: filters.ownerStaffId })
  // «Sin dueño» is work to take: only open stages — a won or lost account nobody owns is history (m-6).
  if (filters.sinDueno) and.push({ ownerStaffId: null, stage: { kind: 'ABIERTA' } })
  if (filters.source) and.push({ source: filters.source })
  if (filters.semaforo) and.push(LIVE, semaforoWhere(filters.semaforo, now))
  if (filters.estancados) and.push(LIVE, await staleWhere(now))
  if (filters.q) and.push(searchWhere(filters.q))
  if (filters.email) and.push({ contacts: { some: { email: { equals: filters.email.trim().toLowerCase(), mode: 'insensitive' } } } })
  return { AND: and }
}

/**
 * The pipeline as a list, a page at a time: filters and search run in the database, the server caps the page at 100, and
 * the total is the real one.
 */
export async function listAccounts(access: CrmAccess, filters: AccountFilters = {}, now = new Date()) {
  const limit = Math.min(Math.max(filters.limit ?? DEFAULT_PAGE, 1), MAX_PAGE)
  const where = await accountsWhere(access, filters, now)

  const [found, total] = await Promise.all([
    prisma.crmAccount.findMany({
      where,
      select: ROW_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // One more than the page says whether there is a next one.
      take: limit + 1,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
    }),
    prisma.crmAccount.count({ where }),
  ])
  const page = found.slice(0, limit)
  return {
    rows: await toRows(prisma, page, now),
    nextCursor: found.length > limit ? page[page.length - 1].id : null,
    total,
  }
}

/** The pending activity of mine that put an account in «Vencidas» or «Hoy» (ruling 61). */
export type MiActividad = Pick<NextActivity, 'id' | 'type' | 'title' | 'dueAt'>

export interface PendingSection {
  /** `miActividad` only in «Vencidas» and «Hoy»: `nextActivity` can be someone else's, on an account nobody owns yet. */
  rows: Array<AccountRow & { miActividad?: MiActividad | null }>
  total: number
}

/** My first pending activity on each account — by due date, then id — in ONE query (≤ 100 ids: two sections of 50). */
async function myFirstActivities(staffId: string, accountIds: string[]): Promise<Map<string, MiActividad>> {
  if (!accountIds.length) return new Map()
  const found = await prisma.$queryRaw<Array<MiActividad & { accountId: string }>>`
    SELECT DISTINCT ON ("accountId") "id", "accountId", "type", "title", "dueAt"
    FROM "CrmActivity"
    WHERE "accountId" = ANY(${accountIds}::text[]) AND "assigneeStaffId" = ${staffId} AND "doneAt" IS NULL
    ORDER BY "accountId", "dueAt", "id"`
  return new Map(found.map(({ accountId, ...activity }) => [accountId, activity]))
}

export type Pending = Record<'vencidas' | 'hoy' | 'sinSiguientePaso' | 'estancados' | 'nuevosSinDueno', PendingSection>

/**
 * «Mis pendientes» (spec §5.4), where the CRM opens: what I owe from before today, what I owe today, mine with nothing
 * scheduled, mine gone stale, and what nobody owns yet. Every section is capped at 50 with its real total; the daily
 * digest (task 7) sends the same thing.
 *
 * «Owe» = a pending activity assigned to me. Pending activities follow their account's owner (ruling 12), so that is
 * the owner's — or, on an account nobody owns yet, whoever scheduled it.
 */
export async function getPending(access: CrmAccess, now = new Date()): Promise<Pending> {
  await ensureCrmDefaults()
  const { start, end } = teamDay(now)
  const me = access.staffId
  const mine = { assigneeStaffId: me, doneAt: null }
  const base = [scopeWhere(access, 'ver'), LIVE]
  const stale = await staleWhere(now)
  const soonest: Prisma.CrmAccountOrderByWithRelationInput[] = [{ nextActivityAt: 'asc' }, { id: 'asc' }]
  const forgotten: Prisma.CrmAccountOrderByWithRelationInput[] = [{ lastTouchAt: 'asc' }, { id: 'asc' }]
  const sections: Array<[keyof Pending, Prisma.CrmAccountWhereInput[], Prisma.CrmAccountOrderByWithRelationInput[]]> = [
    ['vencidas', [{ activities: { some: { ...mine, dueAt: { lt: start } } } }], soonest],
    [
      'hoy',
      // Once: an account I already owe from before stays in «Vencidas».
      [{ activities: { some: { ...mine, dueAt: { gte: start, lte: end } } } }, { activities: { none: { ...mine, dueAt: { lt: start } } } }],
      soonest,
    ],
    ['sinSiguientePaso', [{ ownerStaffId: me, nextActivityAt: null }], forgotten],
    ['estancados', [{ ownerStaffId: me }, stale], forgotten],
    ['nuevosSinDueno', [{ ownerStaffId: null }], [{ createdAt: 'desc' }, { id: 'desc' }]],
  ]

  const found = await Promise.all(
    sections.map(async ([key, filters, orderBy]) => {
      const where: Prisma.CrmAccountWhereInput = { AND: [...base, ...filters] }
      const [accounts, total] = await Promise.all([
        prisma.crmAccount.findMany({ where, select: ROW_SELECT, orderBy, take: PENDING_CAP }),
        prisma.crmAccount.count({ where }),
      ])
      return { key, accounts, total }
    }),
  )
  // An account can sit in two sections (no next step AND stale): its row is built once, with one activities query.
  const unique = new Map(found.flatMap(({ accounts }) => accounts.map(account => [account.id, account] as const)))
  const owes = (key: keyof Pending) => key === 'vencidas' || key === 'hoy'
  const owed = new Set(found.flatMap(({ key, accounts }) => (owes(key) ? accounts.map(account => account.id) : [])))
  const [rows, mineFirst] = await Promise.all([
    toRows(prisma, [...unique.values()], now).then(built => new Map(built.map(row => [row.id, row]))),
    myFirstActivities(me, [...owed]),
  ])
  const pending = {} as Pending
  for (const { key, accounts, total } of found) {
    pending[key] = {
      rows: accounts.flatMap(account => {
        const row = rows.get(account.id)
        // A copy: the same row can also sit in a section that owes nothing.
        return !row ? [] : owes(key) ? [{ ...row, miActividad: mineFirst.get(account.id) ?? null }] : [row]
      }),
      total,
    }
  }
  return pending
}

// ── One account ───────────────────────────────────────────────────────────────────────────────────────────────────────

const DETAIL_SELECT = {
  ...ROW_SELECT,
  sucursales: true,
  modulos: true,
  sourceDetail: true,
  referidoPor: true,
  stageEnteredAt: true,
  lostReason: { select: { id: true, name: true } },
  lostNote: true,
  wonAt: true,
  lostAt: true,
  firstMoneySource: true,
  consentMarketing: true,
  consentAt: true,
  consentSource: true,
  qualificationAvailable: true,
  contacts: {
    select: { id: true, name: true, phoneE164: true, email: true, role: true, isPrimary: true },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
    take: 50,
  },
} satisfies Prisma.CrmAccountSelect

const ACTIVITIES_CAP = 50
// ponytail: the ficha shows the newest 100 events and says how many there are; a «ver anteriores» page by cursor when an
// account's history outgrows it.
const TIMELINE_CAP = 100
const EMAIL_KINDS = new Set(['EMAIL_SENT', 'EMAIL_RECEIVED'])

/** The `messageId` an email event carries, as a one-or-none list. */
function messageIdOf(data: Prisma.JsonValue): string[] {
  const messageId = data && typeof data === 'object' && !Array.isArray(data) ? data.messageId : undefined
  return typeof messageId === 'string' ? [messageId] : []
}

/** Names of these people in one query. */
export async function staffNames(ids: Array<string | null>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))]
  if (!unique.length) return new Map()
  const people = await prisma.staff.findMany({
    where: { id: { in: unique } },
    select: { id: true, firstName: true, lastName: true },
    take: unique.length,
  })
  return new Map(people.map(person => [person.id, fullName(person)]))
}

/**
 * The ficha: the account, its people, its pending activities (with whoever is in charge — or nobody, ruling 12) and its
 * newest timeline events. Each list is capped and says its total. What is live in Avoqado comes from task 9.
 */
export async function getAccount(access: CrmAccess, id: string, now = new Date()) {
  const account = await prisma.crmAccount.findFirst({ where: { AND: [{ id }, scopeWhere(access, 'ver')] }, select: DETAIL_SELECT })
  if (!account) throw accountNotFound()

  // Each contact's consent comes from `CrmEmailConsent`, by the person's email (Codex plan r2 H4): ONE query for this
  // account's contacts. `CrmAccount.consent*` is still returned as it was (no field leaves an API response).
  const contactEmails = [...new Set(account.contacts.flatMap(contact => (contact.email?.trim() ? [normalizeEmail(contact.email)] : [])))]
  const [activities, activitiesTotal, events, eventsTotal, consents] = await Promise.all([
    prisma.crmActivity.findMany({
      where: { accountId: id, doneAt: null },
      select: { id: true, type: true, title: true, dueAt: true, assigneeStaffId: true },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      take: ACTIVITIES_CAP,
    }),
    prisma.crmActivity.count({ where: { accountId: id, doneAt: null } }),
    prisma.crmTimelineEvent.findMany({
      where: { accountId: id },
      select: { id: true, kind: true, actorStaffId: true, data: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: TIMELINE_CAP,
    }),
    prisma.crmTimelineEvent.count({ where: { accountId: id } }),
    contactEmails.length
      ? prisma.crmEmailConsent.findMany({
          where: { email: { in: contactEmails } },
          select: { email: true, consentAt: true, noticeVersion: true },
          take: contactEmails.length,
        })
      : [],
  ])
  // The page's email events carry only ids (Codex plan r1 #11): their subject, snippet and status come from
  // `CrmEmailMessage`, in ONE query bounded by the page.
  const emailIds = [...new Set(events.flatMap(event => (EMAIL_KINDS.has(event.kind) ? messageIdOf(event.data) : [])))]
  const [names, emails] = await Promise.all([
    staffNames([...activities.map(activity => activity.assigneeStaffId), ...events.map(event => event.actorStaffId)]),
    emailIds.length
      ? prisma.crmEmailMessage.findMany({
          where: { id: { in: emailIds }, accountId: id },
          select: { id: true, subject: true, snippet: true, direction: true, status: true, error: true, fromEmail: true },
          take: emailIds.length,
        })
      : [],
  ])
  const emailById = new Map(emails.map(({ id: messageId, ...email }) => [messageId, email]))
  const consentByEmail = new Map(consents.map(consent => [consent.email, consent]))
  const person = (staffId: string | null) => (staffId ? { id: staffId, name: names.get(staffId) ?? null } : null)

  const { sucursales, modulos, sourceDetail, referidoPor, stageEnteredAt, lostReason, lostNote, wonAt, lostAt, firstMoneySource } = account
  return {
    ...toRow(account, activities[0] ?? null, now),
    sucursales,
    modulos,
    sourceDetail,
    referidoPor,
    stageEnteredAt,
    lostReason,
    lostNote,
    wonAt,
    lostAt,
    firstMoneySource,
    consent: {
      marketing: account.consentMarketing,
      at: account.consentAt,
      source: account.consentSource,
    },
    qualificationAvailable: account.qualificationAvailable,
    contacts: account.contacts.map(contact => {
      const consent = contact.email?.trim() ? consentByEmail.get(normalizeEmail(contact.email)) : undefined
      return { ...contact, consentAt: consent?.consentAt ?? null, noticeVersion: consent?.noticeVersion ?? null }
    }),
    activities: {
      rows: activities.map(({ assigneeStaffId, ...activity }) => ({ ...activity, assignee: person(assigneeStaffId) })),
      total: activitiesTotal,
    },
    timeline: {
      events: events.map(({ actorStaffId, ...event }) => {
        const [messageId] = EMAIL_KINDS.has(event.kind) ? messageIdOf(event.data) : []
        const email = messageId ? emailById.get(messageId) : undefined
        return { ...event, actor: person(actorStaffId), ...(email ? { email } : {}) }
      }),
      total: eventsTotal,
    },
  }
}

// ── Creating by hand ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Accounts that already have a person with this phone or email (spec §5.2: they warn, they are not unique). A «propios»
 * seller learns WHOSE another seller's account is, so they can ask — never which one or its name.
 */
export async function findDuplicates(access: CrmAccess, contact: { phone?: string | null; email?: string | null }) {
  const phoneE164 = contact.phone ? canonicalPhoneE164(contact.phone) : null
  const email = contact.email?.trim().toLowerCase() || null
  const by: Prisma.CrmContactWhereInput[] = []
  if (phoneE164) by.push({ phoneE164 })
  if (email) by.push({ email: { equals: email, mode: 'insensitive' } })
  if (!by.length) return []

  const accounts = await prisma.crmAccount.findMany({
    where: { contacts: { some: { OR: by } } },
    select: { id: true, name: true, ownerStaffId: true, owner: { select: { firstName: true, lastName: true } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: DUPLICATES_CAP,
  })
  return accounts.map(account => {
    const ownerName = account.owner ? fullName(account.owner) : null
    const visible = access.ver === 'todos' || account.ownerStaffId === null || account.ownerStaffId === access.staffId
    return visible ? { id: account.id, name: account.name, ownerName } : { ownerName }
  })
}

export interface ManualAccountInput {
  name: string
  giro?: string
  ventasRango?: string
  sucursales?: number
  source?: 'MANUAL' | 'REFERIDO' | 'OTRO'
  referidoPor?: string
  contact?: { name: string; phone?: string; email?: string; role?: string }
}

/**
 * «Nuevo prospecto»: the seller's own, in the first open stage. A hand-made account has no external key, so a person
 * already known by phone or email stops it with a 409 and the list of whose they are, until the seller confirms
 * «es otro negocio».
 */
export async function createManual(access: CrmAccess, input: ManualAccountInput, opts: { confirmarOtroNegocio?: boolean } = {}) {
  const contact = input.contact && {
    name: input.contact.name,
    phoneE164: input.contact.phone ? canonicalPhoneE164(input.contact.phone) : null,
    email: input.contact.email?.trim().toLowerCase() || null,
    role: input.contact.role || null,
    isPrimary: true,
  }
  if (contact && !opts.confirmarOtroNegocio) {
    const duplicates = await findDuplicates(access, { phone: contact.phoneE164, email: contact.email })
    if (duplicates.length) {
      throw new ConflictError('Ya hay un negocio con ese teléfono o correo', 'CRM_POSIBLE_DUPLICADO', { duplicates })
    }
  }
  const stage = await getInitialStage()
  const source = input.source ?? 'MANUAL'
  const now = new Date()

  return prisma.$transaction(async tx => {
    const { id } = await tx.crmAccount.create({
      data: {
        name: input.name,
        giro: input.giro || null,
        ventasRango: input.ventasRango || null,
        sucursales: input.sucursales ?? null,
        // A seller's qualification is newer than any landing form still pending for this person (ruling 65 e).
        ...(input.giro || input.ventasRango || input.sucursales != null ? { qualifiedAt: now } : {}),
        source,
        referidoPor: input.referidoPor || null,
        ownerStaffId: access.staffId,
        stageId: stage.id,
        ...(contact ? { contacts: { create: [contact] } } : {}),
      },
      select: { id: true },
    })
    await addEvent(tx, { accountId: id, kind: 'SYSTEM', actorStaffId: access.staffId, data: { event: 'CREATED', source } })
    return rowTx(tx, id, now)
  })
}

// ── Owners ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * «Tomar»: compare-and-set on «nobody owns it», so two sellers at once leave ONE owner and the other one hears «alguien
 * más ya lo tomó» (409). Taking it again when it is already mine changes nothing.
 */
export async function takeAccount(access: CrmAccess, id: string) {
  const now = new Date()
  return prisma.$transaction(async tx => {
    const { count } = await tx.crmAccount.updateMany({
      where: { AND: [{ id, ownerStaffId: null }, scopeWhere(access, 'editar')] },
      data: { ownerStaffId: access.staffId },
    })
    if (count === 0) {
      const current = await tx.crmAccount.findUnique({ where: { id }, select: { ownerStaffId: true } })
      if (!current) throw accountNotFound()
      if (current.ownerStaffId !== access.staffId) throw new ConflictError('Alguien más ya lo tomó', 'CRM_YA_TIENE_DUENO')
      return rowTx(tx, id, now)
    }
    await touchNoEarlierTx(tx, id, now)
    await movePendingActivitiesTx(tx, [id], access.staffId)
    const reason: OwnerChangeReason = 'TAKEN'
    await addEvent(tx, {
      accountId: id,
      kind: 'OWNER_CHANGE',
      actorStaffId: access.staffId,
      data: { fromStaffId: null, toStaffId: access.staffId, reason },
    })
    return rowTx(tx, id, now)
  })
}

/**
 * What a reassignment answers: the whole row to whoever sees the account, and only its new owner to whoever does not. An
 * admin of the team without «Ver negocios» changes owners from «Equipo de ventas», but never sees an account (M-1).
 */
async function reassignedView(tx: Prisma.TransactionClient, access: CrmAccess, id: string, staffId: string | null, now: Date) {
  const visible = await tx.crmAccount.findFirst({ where: { AND: [{ id }, scopeWhere(access, 'ver')] }, select: ROW_SELECT })
  if (visible) {
    const [row] = await toRows(tx, [visible], now)
    return row
  }
  const owner = staffId
    ? await tx.staff.findUnique({ where: { id: staffId }, select: { id: true, firstName: true, lastName: true } })
    : null
  return { id, owner: owner ? { id: owner.id, name: fullName(owner) } : null }
}

/**
 * Gives the account to someone on the team, or to nobody (`null`). Only with «Editar: todos» or «Equipo y llaves» (L6),
 * who reach every account. The new owner must be able to EDIT accounts — with only «Ver» they would own accounts they cannot touch,
 * frozen until someone reassigns them (m-3). Its pending activities go with it (ruling 12).
 */
export async function reassign(access: CrmAccess, id: string, staffId: string | null) {
  if (!(access.equipo || access.editar === 'todos')) {
    throw new ForbiddenError('Sólo quien edita todos los negocios o maneja el equipo puede cambiar el dueño', 'CRM_NO_PUEDE_REASIGNAR')
  }
  if (staffId && !(await getCrmAccess(staffId))?.editar) {
    throw new ValidationError(
      'El nuevo dueño tiene que estar en el equipo de ventas y poder editar negocios',
      'CRM_REASSIGN_TARGET_INVALID',
    )
  }
  const now = new Date()
  const { row, fromStaffId } = await prisma.$transaction(async tx => {
    const account = await touchTx(tx, access, id, {}, now)
    if (account.ownerStaffId !== staffId) {
      await tx.crmAccount.update({ where: { id }, data: { ownerStaffId: staffId } })
      await movePendingActivitiesTx(tx, [id], staffId)
      const reason: OwnerChangeReason = 'REASSIGNED'
      await addEvent(tx, {
        accountId: id,
        kind: 'OWNER_CHANGE',
        actorStaffId: access.staffId,
        data: { fromStaffId: account.ownerStaffId, toStaffId: staffId, reason },
      })
    }
    return { row: await reassignedView(tx, access, id, staffId, now), fromStaffId: account.ownerStaffId }
  })
  // Who owns an account decides which «propios» sellers see it: an access change, so it goes to the audit trail too.
  if (fromStaffId !== staffId) {
    void logAction({
      staffId: access.staffId,
      venueId: null,
      action: 'CRM_ACCOUNT_REASSIGNED',
      entity: 'CrmAccount',
      entityId: id,
      data: { fromStaffId, toStaffId: staffId },
    })
  }
  return row
}

// ── The pipeline ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * «Cerrar negocios» (L9): ganar, perder y reabrir. La ruta ya la pide; aquí también, porque el MCP pierde por `lose` y
 * reabrir por `moveStage` sólo se sabe con la fila bloqueada. `cerrar` ya viene apagada sin «Editar» (`effectiveKeys`).
 */
function assertCierra(access: CrmAccess, message = 'No tienes la llave «Cerrar negocios»') {
  if (!access.cerrar) throw new ForbiddenError(message, 'CRM_FORBIDDEN')
}

/**
 * Moves an account to another OPEN stage. «Ganado» and «Perdido» go through `win` and `lose`, which ask for the
 * Organization and the reason. Moving a won or lost account back to an open stage reopens it.
 *
 * `expectedStageId` (the MCP's «sólo avanza»): the stage the caller decided from. If the account is in another one by the
 * time its row is locked — someone won, lost or moved it meanwhile — 409, and nothing is reopened.
 */
export async function moveStage(access: CrmAccess, id: string, stageId: string, expectedStageId?: string) {
  const target = await prisma.crmStage.findUnique({ where: { id: stageId }, select: { id: true, name: true, kind: true } })
  if (!target) throw new ValidationError('Esa etapa no existe', 'CRM_STAGE_NOT_FOUND')
  if (target.kind === 'GANADA') throw new ValidationError('Para ganarlo usa «Ganar»: pide ligarlo a su cuenta de Avoqado', 'CRM_USA_GANAR')
  if (target.kind === 'PERDIDA') throw new ValidationError('Para perderlo usa «Perder»: pide el motivo', 'CRM_USA_PERDER')

  const now = new Date()
  return prisma.$transaction(async tx => {
    const account = await touchEditableTx(tx, access, id, now)
    assertExpectedStage(account.stageId, expectedStageId)
    if (account.stageId !== target.id) {
      // Mover uno GANADO o PERDIDO a una etapa abierta lo reabre: es deshacer un cierre (L9).
      if (account.stage.kind !== 'ABIERTA') assertCierra(access, 'Para reabrir un negocio cerrado necesitas la llave «Cerrar negocios»')
      const reopened = account.stage.kind === 'ABIERTA' ? {} : { wonAt: null, lostAt: null, lostReasonId: null, lostNote: null }
      await tx.crmAccount.update({ where: { id }, data: { stageId: target.id, stageEnteredAt: now, ...reopened } })
      await addEvent(tx, {
        accountId: id,
        kind: 'STAGE_CHANGE',
        actorStaffId: access.staffId,
        data: { fromStageId: account.stageId, fromStageName: account.stage.name, toStageId: target.id, toStageName: target.name },
      })
    }
    return rowTx(tx, id, now)
  })
}

/** 409 when the account is no longer in the stage the caller decided from (see `moveStage`). */
function assertExpectedStage(current: string, expected: string | undefined) {
  if (expected && current !== expected) {
    throw new ConflictError('El negocio cambió de etapa mientras tanto: vuelve a leerlo antes de moverlo', 'CRM_ETAPA_CAMBIO')
  }
}

/**
 * «Perder» asks for a reason from the list (422 without one) so the report says why accounts are lost, not just how many.
 * `expectedStageId`, like in `moveStage`: a business won meanwhile is not turned into a lost one.
 */
export async function lose(access: CrmAccess, id: string, input: { lostReasonId?: string; note?: string; expectedStageId?: string }) {
  assertCierra(access)
  if (!input.lostReasonId) throw new ValidationError('Elige por qué se perdió', 'CRM_FALTA_MOTIVO')
  const [reason, lostStage] = await Promise.all([
    prisma.crmLostReason.findUnique({ where: { id: input.lostReasonId }, select: { id: true, name: true, active: true } }),
    closedStage('PERDIDA'),
  ])
  if (!reason?.active) throw new ValidationError('Ese motivo no existe o ya no se usa', 'CRM_MOTIVO_INVALIDO')

  const now = new Date()
  const note = input.note || null
  return prisma.$transaction(async tx => {
    const account = await touchEditableTx(tx, access, id, now)
    assertExpectedStage(account.stageId, input.expectedStageId)
    await tx.crmAccount.update({
      where: { id },
      data: { stageId: lostStage.id, stageEnteredAt: now, lostReasonId: reason.id, lostNote: note, lostAt: now, wonAt: null },
    })
    await addEvent(tx, {
      accountId: id,
      kind: 'LOST',
      actorStaffId: access.staffId,
      data: { fromStageId: account.stageId, lostReasonId: reason.id, lostReasonName: reason.name, note },
    })
    return rowTx(tx, id, now)
  })
}

const orgTaken = () => new ConflictError('Esa cuenta de Avoqado ya está ligada a otro negocio del CRM', 'CRM_ORG_YA_LIGADA')

/**
 * A new link starts the first money over (ruling 65 g, Codex exhaustiva #13): the date and its source were the
 * Organization's the account had before (deleted, so `SetNull` unlinked it), never the new one's. They are cleared —
 * `fillFirstMoney` computes them again for the new Organization — and the old fact stays in the timeline. Every link
 * calls it after setting the new Organization: the sweep, the landing and the backfill (`linkTx`) and «Ganar».
 */
export async function resetFirstMoneyTx(
  tx: Prisma.TransactionClient,
  accountId: string,
  organizationId: string,
  actorStaffId: string | null,
): Promise<void> {
  const before = await tx.crmAccount.findUniqueOrThrow({
    where: { id: accountId },
    select: { firstMoneyAt: true, firstMoneySource: true },
  })
  if (!before.firstMoneyAt) return
  await tx.crmAccount.update({ where: { id: accountId }, data: { firstMoneyAt: null, firstMoneySource: null } })
  await addEvent(tx, {
    accountId,
    kind: 'SYSTEM',
    actorStaffId,
    data: {
      event: 'FIRST_MONEY_RESET',
      previousAt: before.firstMoneyAt.toISOString(),
      previousSource: before.firstMoneySource,
      organizationId,
    },
  })
}

/**
 * «Ganar» links the account to its real Organization — one CRM account per Organization — and closes it as «Ganado».
 * Without `organizationId`, the one it is already linked to (it came from the landing). The sales team's own
 * organization is never anybody's client. An account nobody owns is won by whoever wins it (I-3, like Pipedrive: who
 * closes it keeps it): in the same transaction it becomes theirs, with its pending activities and its OWNER_CHANGE —
 * spec §5.4 keeps the owner of a won account, and the CRM exists so every sale has one.
 */
export async function win(access: CrmAccess, id: string, input: { organizationId?: string }) {
  assertCierra(access)
  const wonStage = await closedStage('GANADA')
  const now = new Date()
  try {
    return await prisma.$transaction(async tx => {
      const account = await touchEditableTx(tx, access, id, now)
      const organizationId = input.organizationId ?? account.organizationId
      if (!organizationId) throw new ValidationError('Para ganarlo, lígalo a su cuenta de Avoqado', 'CRM_FALTA_ORGANIZACION')
      if (account.organizationId && account.organizationId !== organizationId) {
        throw new ValidationError('Este negocio ya está ligado a otra cuenta de Avoqado', 'CRM_YA_LIGADO_A_OTRA')
      }
      const linking = account.organizationId !== organizationId
      let organizationName: string | null = null
      if (linking) {
        const [organization, team, holder] = await Promise.all([
          tx.organization.findUnique({ where: { id: organizationId }, select: { id: true, name: true } }),
          tx.crmTeam.findUnique({ where: { key: 'default' }, select: { organizationId: true } }),
          tx.crmAccount.findUnique({ where: { organizationId }, select: { id: true } }),
        ])
        if (!organization || team?.organizationId === organizationId) {
          throw new ValidationError('Esa cuenta de Avoqado no existe', 'CRM_ORGANIZACION_NO_EXISTE')
        }
        if (holder) throw orgTaken()
        organizationName = organization.name
      } else if (account.stage.kind === 'GANADA') {
        return rowTx(tx, id, now)
      }

      const takes = account.ownerStaffId === null
      await tx.crmAccount.update({
        where: { id },
        data: {
          organizationId,
          stageId: wonStage.id,
          stageEnteredAt: now,
          wonAt: now,
          lostAt: null,
          lostReasonId: null,
          lostNote: null,
          ...(takes ? { ownerStaffId: access.staffId } : {}),
        },
      })
      if (takes) {
        await movePendingActivitiesTx(tx, [id], access.staffId)
        const reason: OwnerChangeReason = 'TAKEN'
        await addEvent(tx, {
          accountId: id,
          kind: 'OWNER_CHANGE',
          actorStaffId: access.staffId,
          data: { fromStaffId: null, toStaffId: access.staffId, reason },
        })
      }
      if (linking) {
        await resetFirstMoneyTx(tx, id, organizationId, access.staffId)
        await addEvent(tx, { accountId: id, kind: 'LINKED', actorStaffId: access.staffId, data: { organizationId, organizationName } })
      }
      await addEvent(tx, {
        accountId: id,
        kind: 'WON',
        actorStaffId: access.staffId,
        data: { fromStageId: account.stageId, organizationId },
      })
      return rowTx(tx, id, now)
    })
  } catch (error) {
    // Two wins at once both pass the check above; the unique index on `organizationId` refuses the second one.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw orgTaken()
    throw error
  }
}

/** Out of the pipeline, the reminders and the reports; a search still finds it. */
export async function archive(access: CrmAccess, id: string) {
  const now = new Date()
  return prisma.$transaction(async tx => {
    const account = await touchEditableTx(tx, access, id, now)
    if (!account.archivedAt) {
      await tx.crmAccount.update({ where: { id }, data: { archivedAt: now } })
      await addEvent(tx, { accountId: id, kind: 'ARCHIVED', actorStaffId: access.staffId, data: {} })
    }
    return rowTx(tx, id, now)
  })
}

/** Back into the pipeline, freshly touched: it does not come back already stale. Pide «Cerrar negocios» (L9). */
export async function reactivate(access: CrmAccess, id: string) {
  assertCierra(access)
  const now = new Date()
  return prisma.$transaction(async tx => {
    const account = await touchEditableTx(tx, access, id, now)
    if (account.archivedAt) {
      await tx.crmAccount.update({ where: { id }, data: { archivedAt: null } })
      await addEvent(tx, { accountId: id, kind: 'REACTIVATED', actorStaffId: access.staffId, data: {} })
    }
    return rowTx(tx, id, now)
  })
}

export async function addNote(access: CrmAccess, id: string, input: { text: string }) {
  const now = new Date()
  return prisma.$transaction(async tx => {
    await touchEditableTx(tx, access, id, now)
    await addEvent(tx, { accountId: id, kind: 'NOTE', actorStaffId: access.staffId, data: { text: input.text } })
    return rowTx(tx, id, now)
  })
}

// ── Organizations ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What «Ganar» links to: at most 10 Organizations by their name, email or phone, or their owner's. Only the id, the name
 * and a city — never the business's contact data. The sales team's own organization is left out by its `CrmTeam` id,
 * never by its name or slug (ruling 14).
 */
export async function searchOrganizations(_access: CrmAccess, q: string) {
  const term = q.trim()
  if (term.length < 3) return []
  const team = await prisma.crmTeam.findUnique({ where: { key: 'default' }, select: { organizationId: true } })
  const digits = term.replace(/\D/g, '')
  const byPhone = digits.length >= 4
  const text = { contains: term, mode: 'insensitive' as const }
  const owner = (staff: Prisma.StaffWhereInput): Prisma.OrganizationWhereInput => ({
    staffOrganizations: { some: { role: OrgRole.OWNER, isActive: true, staff } },
  })
  const matches: Prisma.OrganizationWhereInput[] = [{ name: text }, { email: text }]
  if (byPhone) matches.push({ phone: { contains: digits } })
  matches.push(owner({ OR: [{ firstName: text }, { lastName: text }, { email: text }] }))
  if (byPhone) matches.push(owner({ phone: { contains: digits } }))

  const and: Prisma.OrganizationWhereInput[] = []
  if (team) and.push({ id: { not: team.organizationId } })
  and.push({ OR: matches })

  const organizations = await prisma.organization.findMany({
    where: { AND: and },
    select: { id: true, name: true, venues: { select: { city: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 1 } },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    take: SEARCH_CAP,
  })
  return organizations.map(organization => ({ id: organization.id, name: organization.name, city: organization.venues[0]?.city ?? null }))
}
