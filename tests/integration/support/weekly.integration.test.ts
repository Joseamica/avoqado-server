import type { SupportNoticeKind, SupportNoticeStatus, SupportOutcome } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import type { EmailOptionsWithSender, EmailSendResult } from '@/services/email.service'
import * as knowledge from '@/services/support/knowledge.service'
import type { LibraryGuide } from '@/services/support/knowledge.service'
import { tryRouteSupport } from '@/services/support/router.service'
import { admitSupportMessage } from '@/services/support/store.service'
import { buildWeeklyEmail, type WeeklyReport } from '@/services/support/noticeEmails'
import { buildWeeklyReport, runSupportNotices, weeklyReportWindow } from '@/services/support/notices.service'
import * as catalogModule from '@/services/support/data/catalog'
import { dataCatalog } from '@/services/support/data/catalog'
import { fakeCapability } from '@tests/__helpers__/supportData'

const receiverId = `support-weekly-${Date.now()}`
// 49xx: no other support suite uses these numbers.
const phone = '+525500004901'
// Early 2021, isolated both ways. Ours → theirs: passes at a 2021 `now` take no row of another suite (theirs are due
// later) and count only our 2021 rows. Theirs → ours: our rows, while they exist, are due for any other suite's pass;
// every case deletes them afterwards, and the cloud gives each jest process its own database (CI_DB_POR_PROCESO=1).
// CDMX was on UTC-6 then too.
const MONDAY = new Date('2021-03-01T15:00:00.000Z') // Monday 1 March 2021, 09:00 in Mexico City
const KEY = 'weekly:2021-03-01'
const week = weeklyReportWindow(MONDAY, 9) // Monday 22 to Sunday 28 February
const inWeek = (minutes: number) => new Date(week.from.getTime() + minutes * 60_000)
const guide = (id: string, title: string): LibraryGuide => ({
  id,
  app: 'dashboard',
  title,
  summary: title,
  steps: [title],
  publicUrl: `https://avoqado.io/help/${id}`,
  requiredPermissions: [],
  keywords: [],
  body: title,
  general: false,
  internal: false,
  hash: '0'.repeat(64),
})
const products = guide('dashboard/menu/gestionar-productos', 'Crear productos')
/** The HTML carries every non-ASCII character as an entity; the checks read it back as text. */
const decoded = (html: string) => html.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))

type Reply = EmailSendResult | Error
const ok: EmailSendResult = { ok: true, resendId: 're_fixture', transient: false }
/** Fake Resend: `reply(n)` answers the n-th send of the same key. Nothing ever leaves the process. */
function transport(reply: (n: number) => Reply = () => ok) {
  const sent: EmailOptionsWithSender[] = []
  const mine = (id: string) => sent.filter(o => o.idempotencyKey === `support-notice:${id}`)
  const send = jest.fn(async (options: EmailOptionsWithSender): Promise<EmailSendResult> => {
    sent.push(options)
    const answer = reply(sent.filter(o => o.idempotencyKey === options.idempotencyKey).length)
    if (answer instanceof Error) throw answer
    return answer
  })
  return { send, mine }
}
const run = (t: ReturnType<typeof transport>, now: Date) => runSupportNotices(now, { send: t.send })
const weekly = () => prisma.supportNotice.findUniqueOrThrow({ where: { dedupeKey: KEY } })

let sequence = 0,
  serial = 0
const conversationId = `${receiverId}-conversation`
type EventSeed = { kind: SupportOutcome; app?: string | null; guideIds?: string[]; at?: Date; conversation?: string }
/** SupportEvent rows as the worker writes them (no text), dated in the week of the report unless `at` says otherwise. */
const seedEvents = (seeds: EventSeed[]) =>
  prisma.supportEvent.createMany({
    data: seeds.map(s => ({
      kind: s.kind,
      app: s.app === undefined ? 'dashboard' : s.app,
      guideIds: s.guideIds ?? [],
      conversationId: s.conversation ?? conversationId,
      generation: 1,
      sequence: ++sequence,
      day: '2021-02-24',
      createdAt: s.at ?? inWeek(60),
    })),
  })
type NoticeSeed = { kind?: SupportNoticeKind; status: SupportNoticeStatus; app?: string | null; reason?: string; at?: Date }
const seedNotices = (seeds: NoticeSeed[]) =>
  prisma.supportNotice.createMany({
    data: seeds.map(s => ({
      kind: s.kind ?? 'HANDOFF',
      dedupeKey: `seed:${receiverId}:${++serial}`,
      status: s.status,
      day: '2021-02-24',
      app: s.app === undefined ? 'dashboard' : s.app,
      reason: (s.kind ?? 'HANDOFF') === 'HANDOFF' ? (s.reason ?? 'REQUESTED') : null,
      createdAt: s.at ?? inWeek(60),
    })),
  })
const total = (rows: { count: number }[]) => rows.reduce((n, r) => n + r.count, 0)
/** How many seeds share each key: what the report must say. */
function tally<T>(rows: T[], key: (row: T) => string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1)
  return counts
}

let orgId: string, venueId: string, staffId: string
const input = (body: string) => ({
  receiverId,
  phone,
  wamid: `wamid.${receiverId}-${++serial}`,
  type: 'text',
  body,
  timestamp: String(Math.floor(Date.now() / 1000)),
})
async function clean() {
  const ids = (await prisma.supportConversation.findMany({ where: { receiverId }, select: { id: true }, take: 50 })).map(c => c.id)
  await prisma.supportEvent.deleteMany({ where: { OR: [{ conversationId: { in: ids } }, { conversationId: { startsWith: receiverId } }] } })
  await prisma.supportNotice.deleteMany({
    where: {
      OR: [
        { dedupeKey: { startsWith: `seed:${receiverId}:` } },
        { dedupeKey: { startsWith: 'weekly:2021-' } },
        { dedupeKey: { startsWith: 'daily:2021-' } },
      ],
    },
  })
  await prisma.supportAttempt.deleteMany({ where: { message: { conversation: { receiverId } } } })
  await prisma.supportMessage.deleteMany({ where: { conversation: { receiverId } } })
  await prisma.supportConversation.deleteMany({ where: { receiverId } })
  await prisma.whatsappInboundEvent.deleteMany({ where: { receiverId } })
  await prisma.supportBudget.deleteMany({ where: { key: { startsWith: `CONTROL:${receiverId}:` } } })
  if (staffId) await prisma.supportDataQuery.deleteMany({ where: { staffId } })
}
beforeAll(async () => {
  Object.assign(process.env, {
    SUPPORT_WHATSAPP_ENABLED: 'true',
    SUPPORT_WHATSAPP_PHONE_NUMBER_ID: receiverId,
    WHATSAPP_SALES_PHONE_NUMBER_ID: 'sales',
    SUPPORT_WHATSAPP_ENC_KEY: 'e'.repeat(64),
    WHATSAPP_ACCESS_TOKEN: 'fixture-never-used',
  })
  orgId = (await prisma.organization.create({ data: { name: 'Semanal fixture', email: `${receiverId}-org@test.local`, phone: '0' } })).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: 'Norte', slug: `${receiverId}-norte`, status: 'ACTIVE' } }))
    .id
  staffId = (
    await prisma.staff.create({
      data: { email: `${receiverId}-ana@test.local`, firstName: 'Ana', lastName: 'Semanal', emailVerified: true, phone },
    })
  ).id
  await prisma.staffVenue.create({ data: { staffId, venueId, role: 'VIEWER' } })
  await prisma.staffOrganization.create({ data: { staffId, organizationId: orgId, role: 'MEMBER' } })
})
beforeEach(async () => {
  await clean()
  Object.assign(process.env, {
    SUPPORT_WHATSAPP_FREE_TEXT_ENABLED: 'true',
    SUPPORT_WHATSAPP_HYBRID_ENABLED: 'true',
    SUPPORT_HANDOFF_EMAIL_TO: 'soporte@test.local',
    SUPPORT_WEEKLY_REPORT_HOUR: '9',
  })
  jest.spyOn(knowledge, 'loadSupportLibrary').mockReturnValue([products, guide('guia-24', 'Cambiar de sucursal')])
})
afterEach(async () => {
  jest.restoreAllMocks()
  // Each case leaves nothing behind: its WEEKLY_REPORT rows (`weekly:2021-…`), seeded events, notices and messages.
  await clean()
})
afterAll(async () => {
  if (!orgId) return
  await prisma.staffVenue.deleteMany({ where: { staffId } })
  await prisma.staffOrganization.deleteMany({ where: { staffId } })
  await prisma.staff.deleteMany({ where: { id: staffId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.delete({ where: { id: orgId } })
})

describe('the weekly row and its email', () => {
  it('two runs at once on Monday create one row and send one email', async () => {
    await seedEvents([{ kind: 'UNKNOWN', guideIds: [products.id] }])
    const t = transport()
    // At 08:59 the week that just closed is not reported yet.
    await run(t, new Date(MONDAY.getTime() - 60_000))
    expect(await prisma.supportNotice.findUnique({ where: { dedupeKey: KEY } })).toBeNull()
    await Promise.all([run(t, MONDAY), run(t, MONDAY)])
    const rows = await prisma.supportNotice.findMany({ where: { kind: 'WEEKLY_REPORT', day: '2021-03-01' }, take: 5 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ dedupeKey: KEY, status: 'SENT', meta: null, resendId: 're_fixture' })
    expect(t.mine(rows[0].id)).toHaveLength(1)
    // Later passes that Monday find it already there.
    await run(t, new Date(MONDAY.getTime() + 3_600_000))
    expect(t.mine(rows[0].id)).toHaveLength(1)
    expect(await prisma.supportNotice.count({ where: { kind: 'WEEKLY_REPORT', day: '2021-03-01' } })).toBe(1)
  })

  it('Resend down on Monday: retried with identical content and the same key, still one row', async () => {
    await seedEvents([{ kind: 'UNKNOWN', guideIds: [products.id] }, { kind: 'CLARIFIED' }])
    const t = transport(n => (n === 1 ? { ok: false, transient: true, errorCode: 'internal_server_error' } : ok))
    await run(t, MONDAY)
    const born = await weekly()
    expect(born).toMatchObject({ kind: 'WEEKLY_REPORT', day: '2021-03-01', status: 'PENDING', attempts: 1, firstAttemptAt: MONDAY })
    // Built when its week closed, with its dates as ISO strings: the email comes from here, on every attempt.
    const meta = born.meta as unknown as WeeklyReport
    expect(meta).toMatchObject({
      from: week.from.toISOString(),
      to: week.to.toISOString(),
      failures: [
        { app: 'dashboard', kind: 'UNKNOWN', count: 1 },
        { app: 'dashboard', kind: 'CLARIFIED', count: 1 },
      ],
    })
    // A row that lands in the closed week afterwards does not change what is sent.
    await seedEvents([{ kind: 'UNKNOWN', app: 'tpv' }])
    await run(t, new Date(MONDAY.getTime() + 61_000))
    const [first, retry] = t.mine(born.id)
    expect(retry).toEqual(first)
    expect(first).toEqual({ ...buildWeeklyEmail(meta, 'soporte@test.local'), idempotencyKey: `support-notice:${born.id}` })
    expect(await weekly()).toMatchObject({ status: 'SENT', meta: null })
    expect(await prisma.supportNotice.count({ where: { kind: 'WEEKLY_REPORT', day: '2021-03-01' } })).toBe(1)
  })

  it('empty week: «Nada que reportar esta semana.»', async () => {
    const t = transport()
    await run(t, MONDAY)
    const born = await weekly()
    const [mail] = t.mine(born.id)
    expect(decoded(mail.html!)).toContain('Nada que reportar esta semana.')
    expect(mail.text).toContain('Nada que reportar esta semana.')
    expect(mail.subject).toBe('Soporte · Lista semanal · 2021-02-22 al 2021-02-28')
    expect(born).toMatchObject({ status: 'SENT', meta: null })
  })

  it('the weekly email contains no message text (messages marked in the week)', async () => {
    const conversation = await prisma.supportConversation.create({
      data: { receiverId, phone, app: 'dashboard', noticeAcceptedAt: week.from, lastUserMessageAt: week.from, lastActivityAt: week.from },
    })
    const secrets = ['mi clave es verano123', 'mi código es AB12CD', 'mi CVV es 123']
    // Admitted as the router does (with its inbound event), then answered «no encontré» in the week.
    for (const [i, body] of secrets.entries()) {
      const { messageId } = await admitSupportMessage(input(body))
      await prisma.supportMessage.update({
        where: { id: messageId },
        data: { status: 'SENT', answer: `Respuesta: ${body}`, outcome: 'UNKNOWN', createdAt: inWeek(i) },
      })
    }
    const marked = await prisma.supportMessage.findMany({ where: { conversationId: conversation.id }, take: 5 })
    expect(marked.map(m => m.body).sort()).toEqual([...secrets].sort())
    await seedEvents(
      secrets.map((_, i) => ({ kind: 'UNKNOWN' as const, guideIds: [products.id], conversation: conversation.id, at: inWeek(i) })),
    )
    const t = transport()
    await run(t, MONDAY)
    const [mail] = t.mine((await weekly()).id)
    // What the assistant drafted with is there; what the person wrote is not.
    expect(decoded(mail.html!)).toContain(products.title)
    const haystacks = [decoded(mail.html!), mail.text!, mail.subject, JSON.stringify(await buildWeeklyReport(week.from, week.to))]
    for (const word of ['clave', 'verano123', 'código', 'codigo', 'AB12CD', 'CVV', '123', 'Respuesta'])
      for (const haystack of haystacks) expect(haystack).not.toMatch(new RegExp(`(^|[^\\p{L}\\p{N}])${word}($|[^\\p{L}\\p{N}])`, 'iu'))
  })
})

describe('the counts', () => {
  it('1,200 failure events and 150 handoffs in the week: every total is exact; guides show 20 and «y N más» (R1-12)', async () => {
    const apps = ['dashboard', 'android', 'windows', 'tpv', null]
    const kinds = ['UNKNOWN', 'JUDGE_LITERAL', 'CLARIFIED'] as const
    const id = (n: number) => `guia-${String(n).padStart(2, '0')}`
    // Guide k is drafted in 36 + k events (1,200 in all); the first 100 events also carry guia-00 when they did not.
    const drafted = Array.from({ length: 25 }, (_, k) => Array.from({ length: 36 + k }, () => id(k))).flat()
    const failures = drafted.map(
      (g, i): EventSeed => ({
        kind: kinds[i % 3],
        app: apps[i % 5],
        guideIds: i < 100 && g !== id(0) ? [g, id(0)] : [g],
        // The first one exactly when the week starts, the last one a millisecond before it ends.
        at: i === 0 ? week.from : i === 1199 ? new Date(week.to.getTime() - 1) : inWeek(i % (7 * 24 * 60)),
      }),
    )
    expect(failures).toHaveLength(1200)
    await seedEvents(failures)
    // Not a failure, or not in the week: none of them counts.
    await seedEvents([
      ...(['ANSWERED', 'LITERAL', 'FIXED', 'ASKED', 'OLD_VERSION', 'HANDOFF'] as const).flatMap(kind =>
        Array.from({ length: 50 }, () => ({ kind, guideIds: [id(24)] })),
      ),
      { kind: 'UNKNOWN', guideIds: [id(24)], at: week.to },
      { kind: 'UNKNOWN', guideIds: [id(24)], at: new Date(week.from.getTime() - 1) },
    ])
    const statuses = ['PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED', 'HELD', 'UNCERTAIN'] as const
    const reasons = ['REQUESTED', 'TWO_FAILURES', 'OLD_VERSION']
    const handoffs = Array.from(
      { length: 150 },
      (_, i): NoticeSeed => ({
        status: statuses[i % 7],
        reason: reasons[i % 3],
        app: apps[i % 5],
        at: inWeek(i * 60),
      }),
    )
    const others: NoticeSeed[] = [
      ...Array.from({ length: 3 }, (): NoticeSeed => ({ kind: 'DAILY_DIGEST', status: 'FAILED', app: null })),
      { kind: 'DAILY_DIGEST', status: 'SENT', app: null },
      { kind: 'WEEKLY_REPORT', status: 'UNCERTAIN', app: null },
    ]
    await seedNotices([
      ...handoffs,
      ...others,
      { status: 'FAILED', at: week.to },
      { status: 'SENT', at: new Date(week.from.getTime() - 1) },
    ])

    const report = await buildWeeklyReport(week.from, week.to)
    expect(new Map(report.failures.map(f => [`${f.app}|${f.kind}`, f.count]))).toEqual(tally(failures, f => `${f.app}|${f.kind}`))
    expect(total(report.failures)).toBe(1200)
    const perGuide = tally(
      failures.flatMap(f => f.guideIds!),
      g => g,
    )
    const top = [...perGuide].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1)).slice(0, 20)
    expect(report.guides).toEqual(top.map(([g, count]) => ({ id: g, title: g === id(24) ? 'Cambiar de sucursal' : g, count })))
    expect(report.guidesMore).toBe(5)
    expect(new Map(report.handoffs.map(h => [`${h.app}|${h.status}|${h.reason}`, h.count]))).toEqual(
      tally(handoffs, h => `${h.app}|${h.status}|${h.reason}`),
    )
    expect(total(report.handoffs)).toBe(150)
    const undelivered = [...handoffs, ...others].filter(n => ['FAILED', 'SKIPPED', 'UNCERTAIN'].includes(n.status))
    expect(new Map(report.undelivered.map(u => [`${u.kind}|${u.status}`, u.count]))).toEqual(
      tally(undelivered, n => `${n.kind ?? 'HANDOFF'}|${n.status}`),
    )

    const page = decoded(buildWeeklyEmail(report, 'soporte@test.local').html)
    expect(page).toContain(
      `1,200 preguntas que el asistente no contestó, 150 pasadas a una persona y ${undelivered.length} avisos no entregados.`,
    )
    expect(page).toContain('y 5 más')
    expect(page).toContain('Cambiar de sucursal')
  })

  it('every clarification counts as «pidió aclarar», separate from «no encontré» and «juez rechazó»', async () => {
    await seedEvents([
      ...Array.from({ length: 3 }, () => ({ kind: 'CLARIFIED' as const })),
      ...Array.from({ length: 2 }, () => ({ kind: 'UNKNOWN' as const })),
      { kind: 'JUDGE_LITERAL' },
    ])
    const report = await buildWeeklyReport(week.from, week.to)
    expect(report.failures).toEqual([
      { app: 'dashboard', kind: 'JUDGE_LITERAL', count: 1 },
      { app: 'dashboard', kind: 'UNKNOWN', count: 2 },
      { app: 'dashboard', kind: 'CLARIFIED', count: 3 },
    ])
    expect(decoded(buildWeeklyEmail(report, 'x@test.local').html)).toContain('no encontré: 2 · juez rechazó: 1 · pidió aclarar: 3')
  })

  it('a clarification followed by a change of topic answered with the same guide still raises the clarification count and nothing is marked resolved (R3-07)', async () => {
    // One conversation: «¿te refieres a…?» with a and b, the person changes topic and gets a, then asks something else.
    await seedEvents([
      { kind: 'CLARIFIED', guideIds: ['guia-a', 'guia-b'], at: inWeek(10) },
      { kind: 'ANSWERED', guideIds: ['guia-a'], at: inWeek(11) },
      { kind: 'CLARIFIED', guideIds: ['guia-a'], at: inWeek(12) },
    ])
    const report = await buildWeeklyReport(week.from, week.to)
    expect(report.failures).toEqual([{ app: 'dashboard', kind: 'CLARIFIED', count: 2 }])
    expect(report.guides).toEqual([
      { id: 'guia-a', title: 'guia-a', count: 2 },
      { id: 'guia-b', title: 'guia-b', count: 1 },
    ])
    // Counts only: no rule decides that a clarification was resolved.
    expect(Object.keys(report).sort()).toEqual(['data', 'failures', 'from', 'guides', 'guidesMore', 'handoffs', 'to', 'undelivered'])
    expect(decoded(buildWeeklyEmail(report, 'x@test.local').html)).not.toMatch(/resuel/i)
  })

  it('JUDGE_LITERAL counts, LITERAL does not', async () => {
    await seedEvents([
      { kind: 'JUDGE_LITERAL', guideIds: ['guia-juez'] },
      ...Array.from({ length: 4 }, () => ({ kind: 'LITERAL' as const, guideIds: ['guia-literal'] })),
    ])
    const report = await buildWeeklyReport(week.from, week.to)
    expect(report.failures).toEqual([{ app: 'dashboard', kind: 'JUDGE_LITERAL', count: 1 }])
    expect(report.guides).toEqual([{ id: 'guia-juez', title: 'guia-juez', count: 1 }])
  })

  it.each(['SALIR', 'APP'])('%s after a failure does not change the counts (R1-03)', async command => {
    const now = new Date()
    const conversation = await prisma.supportConversation.create({
      data: { receiverId, phone, app: 'dashboard', noticeAcceptedAt: now, lastUserMessageAt: now, lastActivityAt: now },
    })
    // The failure of this conversation, dated in the 2021 week: the report counts only our rows.
    await seedEvents([{ kind: 'UNKNOWN', guideIds: [products.id], conversation: conversation.id }])
    const before = await buildWeeklyReport(week.from, week.to)
    expect(before.failures).toEqual([{ app: 'dashboard', kind: 'UNKNOWN', count: 1 }])
    await tryRouteSupport(input(command))
    // The router did take it: the conversation moved to a new generation.
    const after = await prisma.supportConversation.findUniqueOrThrow({ where: { id: conversation.id } })
    expect(after.generation).toBeGreaterThan(conversation.generation)
    // Nothing deleted or changed in the week, and nothing added: the router runs on the real clock, so an event it wrote
    // would fall outside the week; the conversation's own count catches that.
    expect(await buildWeeklyReport(week.from, week.to)).toEqual(before)
    expect(await prisma.supportEvent.count({ where: { conversationId: conversation.id } })).toBe(1)
  })

  it('counts by capability and result, CHECK_FAILED included (case 28)', async () => {
    type Result = 'ANSWERED' | 'NEEDS_UNLOCK' | 'CHECK_FAILED' | 'NO_PERMISSION'
    const query = (capability: string, result: Result, at = inWeek(90)) => ({
      staffId,
      venueId,
      capability,
      paramsHmac: 'hmac-of-850',
      result,
      day: '2021-02-24',
      createdAt: at,
    })
    const inside = [
      ...Array.from({ length: 12 }, () => query('fake', 'ANSWERED')),
      ...Array.from({ length: 3 }, () => query('fake', 'NEEDS_UNLOCK')),
      query('fake', 'CHECK_FAILED', week.from),
      query('gone_key', 'NO_PERMISSION', new Date(week.to.getTime() - 1)),
    ]
    // Outside the week: none of them counts.
    const outside = [query('fake', 'ANSWERED', week.to), query('fake', 'CHECK_FAILED', new Date(week.from.getTime() - 1))]
    await prisma.supportDataQuery.createMany({ data: [...inside, ...outside] })
    // 'fake' is in the catalog while the week is built; 'gone_key' left it (its key is the label). T-B44: the real catalog is
    // frozen, so the module's export is swapped for a registered one, and put back below (and by restoreAllMocks).
    const swapped = jest.replaceProperty(catalogModule, 'DATA_CAPABILITIES', dataCatalog(fakeCapability))
    try {
      const report = await buildWeeklyReport(week.from, week.to)
      expect(report.data).toEqual([
        { capability: 'fake', label: 'dato de prueba', result: 'ANSWERED', count: 12 },
        { capability: 'fake', label: 'dato de prueba', result: 'NEEDS_UNLOCK', count: 3 },
        { capability: 'fake', label: 'dato de prueba', result: 'CHECK_FAILED', count: 1 },
        { capability: 'gone_key', label: 'gone_key', result: 'NO_PERMISSION', count: 1 },
      ])
      // Resend down on the first attempt: the row keeps its meta, labels included.
      const t = transport(n => (n === 1 ? { ok: false, transient: true, errorCode: 'internal_server_error' } : ok))
      await run(t, MONDAY)
      const born = await weekly()
      expect((born.meta as unknown as WeeklyReport).data).toEqual(report.data)
      // A deploy changes the catalog before the retry: the retry still sends exactly the same email, from meta.
      swapped.restore()
      await run(t, new Date(MONDAY.getTime() + 61_000))
      const [first, retry] = t.mine(born.id)
      expect(retry).toEqual(first)
      const page = decoded(first.html!)
      for (const value of [
        'Consultas de datos',
        'dato de prueba',
        'contestadas: 12 · sin el toque del día: 3 · falló el cotejo: 1',
        'gone_key',
        'sin permiso: 1',
      ])
        expect(page).toContain(value)
      expect(await weekly()).toMatchObject({ status: 'SENT', meta: null })
      // Labels and counts only: never the venue, the person, their ids or the fingerprint of what was asked.
      for (const haystack of [page, first.text!, first.subject, JSON.stringify(report.data)])
        for (const secret of ['Norte', 'Ana Semanal', staffId, venueId, 'hmac-of-850', '850']) expect(haystack).not.toContain(secret)
    } finally {
      swapped.restore()
    }
  })

  it('undelivered lists FAILED, SKIPPED and UNCERTAIN («aviso incierto») (R1-04)', async () => {
    await seedNotices([
      { status: 'FAILED' },
      { status: 'FAILED' },
      { status: 'SKIPPED' },
      { status: 'UNCERTAIN' },
      { status: 'SENT' },
      { status: 'PENDING' },
      { status: 'HELD' },
      { kind: 'DAILY_DIGEST', status: 'UNCERTAIN', app: null },
      { kind: 'DAILY_DIGEST', status: 'SENT', app: null },
      { kind: 'WEEKLY_REPORT', status: 'FAILED', app: null },
    ])
    const report = await buildWeeklyReport(week.from, week.to)
    expect(report.undelivered).toEqual([
      { kind: 'HANDOFF', status: 'FAILED', count: 2 },
      { kind: 'HANDOFF', status: 'SKIPPED', count: 1 },
      { kind: 'HANDOFF', status: 'UNCERTAIN', count: 1 },
      { kind: 'DAILY_DIGEST', status: 'UNCERTAIN', count: 1 },
      { kind: 'WEEKLY_REPORT', status: 'FAILED', count: 1 },
    ])
    // Every handoff of the week, whatever happened to it.
    expect(total(report.handoffs)).toBe(7)
    const page = decoded(buildWeeklyEmail(report, 'x@test.local').html)
    for (const value of ['2 · falló', '1 · no se mandó', '1 · aviso incierto', 'en el resumen del día', 'Resumen del día', 'Lista semanal'])
      expect(page).toContain(value)
  })
})
