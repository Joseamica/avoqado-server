// La salida del aviso al equipo de Avoqado por correo: durable en la fila SupportNotice (sobrevive a un reinicio), con la
// llave de Resend por fila, y el correo armado sólo de `meta` (nunca se relee la conversación ni sale texto del cliente).
import { randomUUID } from 'crypto'
import { Prisma, type SupportNotice } from '@prisma/client'
import { fromZonedTime } from 'date-fns-tz'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { getSupportHandoffConfig, type SupportHandoffConfig } from '@/config/supportWhatsapp'
import { ForbiddenError } from '@/errors/AppError'
import { runWithContext } from '@/observability/executionContext'
import { conNegocio } from '@/services/demo/candadoDemo'
import emailService, { type EmailOptionsWithSender, type EmailSendResult } from '@/services/email.service'
import { retry, shouldRetryDbConnectionError } from '@/utils/retry'
import { utcTs } from '@/utils/sqlDates'
import { venueDayKey } from '@/utils/venueDateKeys'
import { listSupportVenues } from './access.service'
import { DATA_CAPABILITIES, dataLabel } from './data/catalog'
import type { HandoffMeta } from './handoff.service'
import { loadSupportLibrary } from './knowledge.service'
import { usableLink } from './link.service'
import { buildHandoffEmail, buildHeldDigestEmail, buildWeeklyEmail, type EmailContent, type WeeklyReport } from './noticeEmails'
import { listRegisteredSupportStaff } from './registeredPhone.service'

export const NOTICE_BACKOFF_MINUTES = [1, 5, 15, 60]
export const NOTICE_MAX_ATTEMPTS = 5
export const NOTICE_LEASE_MS = 600_000
/** Resend guarda la llave 24 h (R1-04): pasado esto, un reenvío podría duplicar el correo. */
export const NOTICE_KEY_TTL_MS = 23 * 3_600_000
/** Tiempo máximo por petición a Resend (R2-08). */
export const NOTICE_SEND_TIMEOUT_MS = 15_000
export interface NoticeDependencies {
  /** Default: emailService.sendEmailWithResult. */
  send?: (options: EmailOptionsWithSender) => Promise<EmailSendResult>
  timeoutMs?: number
}
type Outcome = 'sent' | 'failed' | 'skipped' | 'uncertain'

const CDMX = 'America/Mexico_City'
// ponytail: un resumen del día muestra hasta 100 avisos; los demás quedan SKIPPED (DIGEST_FULL) y la lista semanal los cuenta.
const DIGEST_ITEMS = 100
const entryRead = (context: string) => ({ retries: 2, initialDelay: 1500, shouldRetry: shouldRetryDbConnectionError, context })
const keyOf = (id: string) => `support-notice:${id}`
const asMeta = (value: Prisma.JsonValue | null) => value as unknown as HandoffMeta | null
/** P2002: the row of that dedupeKey already exists (another pass got there first). */
const alreadyThere = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'

async function venueStillAllowed(tx: Prisma.TransactionClient, staffId: string, venueId: string): Promise<boolean> {
  try {
    return (await listSupportVenues(staffId, { limit: 1, venueId }, tx)).total > 0
  } catch (err) {
    if (err instanceof ForbiddenError) return false
    throw err
  }
}

/**
 * ¿La persona sigue pudiendo pedir ayuda, y en qué sucursales? (R1-02, R2-01). Con vínculo: ese vínculo sigue usable y es de
 * esa persona; sin él: el teléfono todavía la registra. Después, cada sucursal del correo se revalida: la que perdió acceso
 * sale, y la persona que las perdió todas también. Nadie → null.
 */
export async function stillAllowed(tx: Prisma.TransactionClient, row: SupportNotice, meta: HandoffMeta): Promise<HandoffMeta | null> {
  let people = meta.people
  if (row.linkId) {
    const link = await tx.supportWhatsappLink.findUnique({ where: { id: row.linkId }, select: { staffId: true, phone: true } })
    const usable = link && link.staffId === row.staffId ? await usableLink(tx, link.phone) : null
    if (usable?.id !== row.linkId) return null
    people = people.filter(p => p.staffId === row.staffId)
  } else {
    const registered = await listRegisteredSupportStaff(meta.phone, tx)
    people = people.filter(p => registered.includes(p.staffId))
  }
  const kept: HandoffMeta['people'] = []
  for (const person of people) {
    const venues: HandoffMeta['people'][number]['venues'] = []
    for (const venue of person.venues) if (await venueStillAllowed(tx, person.staffId, venue.id)) venues.push(venue)
    // One shown without a venue (a link still choosing it) stays: there was nothing to lose.
    if (venues.length || !person.venues.length) kept.push({ ...person, venues })
  }
  return kept.length ? { ...meta, people: kept, multipleProfiles: kept.length > 1 } : null
}

/** Los HELD de cada día anterior a hoy (CDMX) van a un solo resumen de ese día. */
async function bundleHeldDays(now: Date): Promise<void> {
  const held = { kind: 'HANDOFF' as const, status: 'HELD' as const, digestId: null }
  const days = await retry(
    () =>
      prisma.supportNotice.groupBy({
        by: ['day'],
        where: { ...held, day: { lt: venueDayKey(now, CDMX) } },
        orderBy: { day: 'asc' },
        take: 10,
      }),
    entryRead('support-notices.held'),
  )
  for (const { day } of days) {
    const dedupeKey = `daily:${day}`
    const digest = await prisma.supportNotice
      // Due in this same pass.
      .create({ data: { kind: 'DAILY_DIGEST', dedupeKey, day, nextAttemptAt: now }, select: { id: true } })
      .catch(err => {
        // It already existed (another pass, or HELD rows that arrived after it).
        if (alreadyThere(err)) return prisma.supportNotice.findUniqueOrThrow({ where: { dedupeKey }, select: { id: true } })
        throw err
      })
    // ponytail: a HELD notice whose clock read 23:59:59 and that commits after its digest's first attempt is linked but not
    // mailed (a window of milliseconds). One digest per pass if that ever shows up in the weekly list.
    await prisma.supportNotice.updateMany({ where: { ...held, day }, data: { digestId: digest.id } })
  }
}

/** The calendar day `days` after `day` (yyyy-mm-dd). */
const plusDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
const cdmx = (day: string, hour = 0) => fromZonedTime(`${day}T${String(hour).padStart(2, '0')}:00:00`, CDMX)

/**
 * La semana de la lista: el lunes más reciente a `hour` (CDMX) que ya pasó. `to` = ese lunes 00:00 CDMX, `from` = el lunes
 * anterior; key `weekly:<ese lunes>`. Antes de la hora, el lunes sigue siendo el de la semana pasada.
 */
export function weeklyReportWindow(now: Date, hour: number): { key: string; from: Date; to: Date } {
  const today = venueDayKey(now, CDMX)
  // A civil date at UTC midnight gives its weekday; (day + 6) % 7 = days since Monday.
  let monday = plusDays(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7))
  if (now < cdmx(monday, hour)) monday = plusDays(monday, -7)
  return { key: `weekly:${monday}`, from: cdmx(plusDays(monday, -7)), to: cdmx(monday) }
}

const WEEKLY_FAILURES: WeeklyReport['failures'][number]['kind'][] = ['UNKNOWN', 'JUDGE_LITERAL', 'CLARIFIED']
const UNDELIVERED: WeeklyReport['undelivered'][number]['status'][] = ['FAILED', 'SKIPPED', 'UNCERTAIN']
const WEEKLY_GUIDES = 20
// ponytail: a few dozen groups at most (5 apps × 3 kinds; 5 apps × 7 states × 3 reasons; la B: 8 capabilities × 9 results). The
// cap only bounds the read.
const GROUPS = 500

/**
 * Los conteos de la semana [from, to), todos en la base (COUNT/GROUP BY), sin texto: las fallas (`no encontré`, `juez
 * rechazó`, `pidió aclarar`, cada una aparte; no se decide si una aclaración «se resolvió», R3-07), las guías de esas fallas
 * (las 20 primeras con su título y cuántas más), los avisos de pasar a una persona, los avisos que no se entregaron y, de la B,
 * las consultas de datos por capacidad y resultado.
 */
export async function buildWeeklyReport(from: Date, to: Date): Promise<WeeklyReport> {
  // ponytail: a snapshot at the Monday hour (T7-c1): a notice of the closed week that turns FAILED, SKIPPED or UNCERTAIN
  // afterwards is not recounted in any list. Count by finishedAt if that is ever needed.
  const createdAt = { gte: from, lt: to }
  // T-F6 (Codex H6): the delivery never edits an event; when what goes out is something else (a «no encontré» instead of an
  // answer), it appends a correcting one. Each message counts once, by its latest event in the week (index SupportEvent
  // [createdAt, id] for the range; the DISTINCT ON sorts only that week).
  const latest = Prisma.sql`SELECT DISTINCT ON (e."conversationId", e.generation, e.sequence) e.id, e.app, e.kind, e."guideIds"
    FROM "SupportEvent" e WHERE e."createdAt" >= ${utcTs(from)} AND e."createdAt" < ${utcTs(to)}
    ORDER BY e."conversationId", e.generation, e.sequence, e."createdAt" DESC, e.id DESC`
  const failures = await prisma.$queryRaw<{ app: string | null; kind: string; count: number }[]>`
    WITH latest AS (${latest})
    SELECT l.app, l.kind::text AS kind, COUNT(*)::int AS count FROM latest l
    WHERE l.kind::text IN (${Prisma.join(WEEKLY_FAILURES)})
    GROUP BY l.app, l.kind ORDER BY l.app, l.kind LIMIT ${GROUPS}`
  // `total` = how many distinct guides, before the LIMIT.
  const guides = await prisma.$queryRaw<{ id: string; count: number; total: number }[]>`
    WITH latest AS (${latest})
    SELECT g.id, COUNT(DISTINCT e.id)::int AS count, (COUNT(*) OVER ())::int AS total
    FROM latest e CROSS JOIN LATERAL unnest(e."guideIds") AS g(id)
    WHERE e.kind::text IN (${Prisma.join(WEEKLY_FAILURES)})
    GROUP BY g.id
    ORDER BY 2 DESC, 1
    LIMIT ${WEEKLY_GUIDES}`
  const handoffs = await prisma.supportNotice.groupBy({
    by: ['app', 'status', 'reason'],
    where: { kind: 'HANDOFF', createdAt },
    _count: { _all: true },
    orderBy: [{ app: 'asc' }, { status: 'asc' }, { reason: 'asc' }],
    take: GROUPS,
  })
  const undelivered = await prisma.supportNotice.groupBy({
    by: ['kind', 'status'],
    where: { createdAt, status: { in: UNDELIVERED } },
    _count: { _all: true },
    orderBy: [{ kind: 'asc' }, { status: 'asc' }],
    take: GROUPS,
  })
  // La B: cuántas consultas de datos hubo, por capacidad y resultado. Sólo llaves y conteos: ni sucursal, ni persona, ni cifras.
  // Índice SupportDataQuery [createdAt, id].
  const data = await prisma.supportDataQuery.groupBy({
    by: ['capability', 'result'],
    where: { createdAt },
    _count: { _all: true },
    orderBy: [{ capability: 'asc' }, { result: 'asc' }],
    take: GROUPS,
  })
  const library = guides.length ? loadSupportLibrary() : []
  return {
    from,
    to,
    failures: failures.map(f => ({ app: f.app, kind: f.kind as WeeklyReport['failures'][number]['kind'], count: f.count })),
    guides: guides.map(g => ({ id: g.id, title: library.find(l => l.id === g.id)?.title ?? g.id, count: g.count })),
    guidesMore: Math.max(0, (guides[0]?.total ?? 0) - guides.length),
    handoffs: handoffs.map(h => ({ app: h.app, status: h.status, reason: h.reason ?? '', count: h._count._all })),
    undelivered: undelivered.map(u => ({
      kind: u.kind,
      status: u.status as WeeklyReport['undelivered'][number]['status'],
      count: u._count._all,
    })),
    // The label is resolved now and saved in meta: every attempt sends the same email, whatever a later deploy says.
    data: data.map(d => ({
      capability: d.capability,
      label: dataLabel(DATA_CAPABILITIES, d.capability) ?? d.capability,
      result: d.result,
      count: d._count._all,
    })),
  }
}

/**
 * En cada pasada (sólo con config): si la semana que ya cerró no tiene su lista, la arma y la deja PENDING, debida ya. Al
 * encender la función sale la semana anterior al último lunes. P2002 = ya estaba.
 */
export async function ensureWeeklyReport(now: Date, config: SupportHandoffConfig): Promise<void> {
  const { key: dedupeKey, from, to } = weeklyReportWindow(now, config.weeklyHour)
  // One indexed read per pass; the counts run once a week.
  const born = await retry(
    () => prisma.supportNotice.findUnique({ where: { dedupeKey }, select: { id: true } }),
    entryRead('support-notices.weekly'),
  )
  if (born) return
  const report = await buildWeeklyReport(from, to)
  const meta = { ...report, from: from.toISOString(), to: to.toISOString() }
  await prisma.supportNotice
    .create({
      data: {
        kind: 'WEEKLY_REPORT',
        dedupeKey,
        day: dedupeKey.slice('weekly:'.length),
        nextAttemptAt: now,
        meta: meta as unknown as Prisma.InputJsonObject,
      },
    })
    .catch(err => {
      if (!alreadyThere(err)) throw err
    })
}

/** Primer intento: se revalida y se congela lo que el correo muestra; cada reintento manda exactamente esto. */
async function freezeMeta(row: SupportNotice, now: Date, mine: Prisma.SupportNoticeWhereInput): Promise<object | null> {
  const revoked = { status: 'SKIPPED' as const, errorCode: 'REVOKED', meta: Prisma.DbNull, finishedAt: now }
  // Plain reads, outside a transaction: a day's digest can take a while, and nothing here needs a lock.
  const allowedOf = (notice: SupportNotice) => {
    const meta = asMeta(notice.meta)
    return meta ? stillAllowed(prisma, notice, meta) : null
  }
  if (row.kind === 'HANDOFF') {
    const allowed = await allowedOf(row)
    const frozen = await prisma.supportNotice.updateMany({
      where: mine,
      data: allowed ? { firstAttemptAt: now, meta: allowed as unknown as Prisma.InputJsonObject } : revoked,
    })
    if (!frozen.count) throw new Error('SUPPORT_NOTICE_LEASE_LOST')
    return allowed
  }
  if (row.kind === 'WEEKLY_REPORT') {
    // Counts only, built when its window closed (Task 7): its `meta` is sent as it is.
    const frozen = await prisma.supportNotice.updateMany({ where: mine, data: { firstAttemptAt: now } })
    if (!frozen.count) throw new Error('SUPPORT_NOTICE_LEASE_LOST')
    return row.meta as object | null
  }
  // DAILY_DIGEST: every row by itself; the ones that no longer pass are left out and marked SKIPPED.
  const rows = await prisma.supportNotice.findMany({
    where: { digestId: row.id, status: 'HELD' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: DIGEST_ITEMS,
  })
  const items: HandoffMeta[] = [],
    dropped: string[] = []
  for (const heldRow of rows) {
    const allowed = await allowedOf(heldRow)
    if (allowed) items.push(allowed)
    else dropped.push(heldRow.id)
  }
  await prisma.$transaction(async tx => {
    if (dropped.length) await tx.supportNotice.updateMany({ where: { id: { in: dropped }, status: 'HELD' }, data: revoked })
    await tx.supportNotice.updateMany({
      where: { digestId: row.id, status: 'HELD', id: { notIn: rows.map(r => r.id) } },
      data: { ...revoked, errorCode: 'DIGEST_FULL' },
    })
    const frozen = await tx.supportNotice.updateMany({
      where: mine,
      data: items.length ? { firstAttemptAt: now, meta: { items } as unknown as Prisma.InputJsonObject } : revoked,
    })
    if (!frozen.count) throw new Error('SUPPORT_NOTICE_LEASE_LOST')
  })
  return items.length ? { items } : null
}

function emailOf(row: SupportNotice, meta: object, to: string): EmailContent {
  if (row.kind === 'HANDOFF') return buildHandoffEmail(meta as HandoffMeta, to)
  if (row.kind === 'DAILY_DIGEST') return buildHeldDigestEmail(row.day, (meta as { items: HandoffMeta[] }).items, to)
  return buildWeeklyEmail(meta as unknown as WeeklyReport, to)
}

class SendTimeout extends Error {}
/** A request that never answers is cut: it counts as transient, and the same key protects the retry. */
export async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new SendTimeout()), ms)))])
  } finally {
    clearTimeout(timer)
  }
}

async function sendOne(row: SupportNotice, now: Date, to: string, dependencies: NoticeDependencies): Promise<Outcome | null> {
  const won = await prisma.supportNotice.updateMany({
    where: { id: row.id, status: row.status, reservedAt: row.reservedAt },
    data: { status: 'SENDING', reservedAt: now },
  })
  if (!won.count) return null
  const mine = { id: row.id, status: 'SENDING' as const, reservedAt: now }
  const finish = async (status: 'SENT' | 'FAILED' | 'SKIPPED' | 'UNCERTAIN', data: Prisma.SupportNoticeUpdateManyMutationInput = {}) => {
    await prisma.supportNotice.updateMany({ where: mine, data: { status, meta: Prisma.DbNull, finishedAt: now, ...data } })
  }
  if (row.firstAttemptAt && now.getTime() - row.firstAttemptAt.getTime() > NOTICE_KEY_TTL_MS) {
    // Resend no longer recognizes the key: whether the first one went out is unknown, so it is never sent again (R1-04).
    await finish('UNCERTAIN', { errorCode: 'KEY_EXPIRED' })
    return 'uncertain'
  }
  const meta = row.firstAttemptAt ? (row.meta as object | null) : await freezeMeta(row, now, mine)
  if (!meta) {
    // Revoked at the first attempt (already SKIPPED), or a meta the 30-day purge cleared.
    if (row.firstAttemptAt) await finish('SKIPPED', { errorCode: 'NO_META' })
    return 'skipped'
  }
  const email = emailOf(row, meta, to)
  let result: EmailSendResult
  try {
    const send = dependencies.send ?? (options => emailService.sendEmailWithResult(options))
    result = await within(send({ ...email, idempotencyKey: keyOf(row.id) }), dependencies.timeoutMs ?? NOTICE_SEND_TIMEOUT_MS)
  } catch (err) {
    result = { ok: false, transient: true, errorCode: err instanceof SendTimeout ? 'TIMEOUT' : 'SEND_ERROR' }
  }
  if (result.ok) {
    await finish('SENT', { resendId: result.resendId ?? null })
    return 'sent'
  }
  const attempts = row.attempts + 1,
    errorCode = result.errorCode ?? 'SEND_ERROR'
  if (errorCode.toLowerCase().includes('idempot')) {
    await finish('UNCERTAIN', { attempts, errorCode })
    return 'uncertain'
  }
  if (!result.transient || attempts >= NOTICE_MAX_ATTEMPTS) {
    await finish('FAILED', { attempts, errorCode })
    return 'failed'
  }
  await prisma.supportNotice.updateMany({
    where: mine,
    data: {
      status: 'PENDING',
      attempts,
      errorCode,
      nextAttemptAt: new Date(now.getTime() + NOTICE_BACKOFF_MINUTES[attempts - 1] * 60_000),
    },
  })
  return 'failed'
}

/**
 * Una pasada del job (sólo con config): arma los resúmenes de los días que ya pasaron y manda hasta 20 avisos debidos, cada
 * uno con su negocio de origen en el contexto. `failed` cuenta los intentos que no salieron (se reintentan o quedan FAILED).
 */
export async function runSupportNotices(
  now = new Date(),
  dependencies: NoticeDependencies = {},
): Promise<{ sent: number; failed: number; skipped: number; uncertain: number }> {
  const result = { sent: 0, failed: 0, skipped: 0, uncertain: 0 }
  const config = getSupportHandoffConfig()
  if (!config) return result
  await bundleHeldDays(now)
  // A bug in the counts never holds back the handoff notices of this pass.
  // Its queries read only counts, ids and codes: the message carries no customer text.
  await ensureWeeklyReport(now, config).catch(err =>
    logger.error('Support weekly report not built', {
      code: 'SUPPORT_WEEKLY_REPORT_FAILED',
      error: err instanceof Error ? err.message : String(err),
    }),
  )
  const due = await retry(
    () =>
      prisma.supportNotice.findMany({
        where: {
          attempts: { lt: NOTICE_MAX_ATTEMPTS },
          OR: [
            { status: 'PENDING', nextAttemptAt: { lte: now } },
            { status: 'SENDING', reservedAt: { lt: new Date(now.getTime() - NOTICE_LEASE_MS) } },
          ],
        },
        orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
        take: 20,
      }),
    entryRead('support-notices.due'),
  )
  for (const row of due) {
    try {
      const outcome = await runWithContext({ correlationId: randomUUID(), source: 'job', entrypoint: 'support-notices.send' }, () =>
        // Candado demo, capa 3: cada aviso lleva su negocio de origen, nunca el del aviso anterior.
        conNegocio(row.venueId ?? null, () => sendOne(row, now, config.to, dependencies)),
      )
      if (outcome) result[outcome]++
    } catch {
      // The row stays as it was (a SENDING row is retaken after its lease). The log says nothing of its content.
      logger.error('Support notice not processed', { code: 'SUPPORT_NOTICE_FAILED', noticeId: row.id })
    }
  }
  return result
}
