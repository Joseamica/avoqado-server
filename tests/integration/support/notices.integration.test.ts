import crypto from 'crypto'
import type { Prisma, SupportConversation, SupportNotice } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { venueDayKey } from '@/utils/venueDateKeys'
import { getSupportHandoffConfig } from '@/config/supportWhatsapp'
import type { EmailOptionsWithSender, EmailSendResult } from '@/services/email.service'
import { admitSupportMessage } from '@/services/support/store.service'
import { tryRouteSupport } from '@/services/support/router.service'
import * as knowledge from '@/services/support/knowledge.service'
import { sourceRef, type LibraryGuide } from '@/services/support/knowledge.service'
import { requestSupportHandoff, type HandoffMeta } from '@/services/support/handoff.service'
import { NOTICE_KEY_TTL_MS, runSupportNotices } from '@/services/support/notices.service'
import { buildWeeklyEmail, type WeeklyReport } from '@/services/support/noticeEmails'

const receiverId = `support-notices-${Date.now()}`
// 78xx: no other support suite uses these numbers.
const anaPhone = '+525500007801',
  betoPhone = '+525500007802'
const CDMX = 'America/Mexico_City'
const yesterday = venueDayKey(new Date(Date.now() - 86_400_000), CDMX)
const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
const products: LibraryGuide = {
  id: 'dashboard/menu/gestionar-productos',
  app: 'dashboard',
  title: 'Crear productos',
  summary: 'Da de alta productos y sus precios.',
  steps: ['Da de alta productos y sus precios.'],
  publicUrl: 'https://avoqado.io/help/dashboard/menu/gestionar-productos',
  requiredPermissions: [],
  keywords: [],
  body: 'Para crear un producto abre el menú del panel y toca nuevo producto.',
  general: false,
  internal: false,
  hash: hash('dashboard/menu/gestionar-productos'),
}
/** The HTML carries every non-ASCII character as an entity; the checks read it back as text. */
const decoded = (html: string) => html.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))

let serial = 0
let orgId: string, northId: string, southId: string, anaId: string, betoId: string
const input = (body: string, from = anaPhone) => ({
  receiverId,
  phone: from,
  wamid: `wamid.${receiverId}-${++serial}`,
  type: 'text',
  body,
  timestamp: String(Math.floor(Date.now() / 1000)),
})
type Reply = EmailSendResult | Error | 'hang'
const ok: EmailSendResult = { ok: true, resendId: 're_fixture', transient: false }
/** Fake Resend: `reply(n)` answers the n-th send of the same key. Nothing ever leaves the process. */
function transport(reply: (n: number) => Reply = () => ok) {
  const sent: EmailOptionsWithSender[] = []
  const mine = (id: string) => sent.filter(o => o.idempotencyKey === `support-notice:${id}`)
  const send = jest.fn(async (options: EmailOptionsWithSender): Promise<EmailSendResult> => {
    sent.push(options)
    const answer = reply(sent.filter(o => o.idempotencyKey === options.idempotencyKey).length)
    if (answer === 'hang') return new Promise<EmailSendResult>(() => {})
    if (answer instanceof Error) throw answer
    return answer
  })
  return { send, mine }
}
const run = (t: ReturnType<typeof transport>, now = new Date(), timeoutMs?: number) =>
  runSupportNotices(now, { send: t.send, ...(timeoutMs ? { timeoutMs } : {}) })
const conversationIds = async () =>
  (await prisma.supportConversation.findMany({ where: { receiverId }, select: { id: true }, take: 500 })).map(c => c.id)
const row = (id: string) => prisma.supportNotice.findUniqueOrThrow({ where: { id } })
const digest = () => prisma.supportNotice.findUnique({ where: { dedupeKey: `daily:${yesterday}` } })

async function clean() {
  const ids = await conversationIds()
  await prisma.supportEvent.deleteMany({ where: { conversationId: { in: ids } } })
  await prisma.supportNotice.deleteMany({ where: { OR: [{ conversationId: { in: ids } }, { dedupeKey: `daily:${yesterday}` }] } })
  await prisma.supportAttempt.deleteMany({ where: { message: { conversation: { receiverId } } } })
  await prisma.supportMessage.deleteMany({ where: { conversation: { receiverId } } })
  await prisma.supportConversation.deleteMany({ where: { receiverId } })
  await prisma.whatsappInboundEvent.deleteMany({ where: { receiverId } })
  await prisma.supportBudget.deleteMany({ where: { key: { startsWith: `CONTROL:${receiverId}:` } } })
  if (anaId) await prisma.supportWhatsappLink.deleteMany({ where: { staffId: { in: [anaId, betoId] } } })
}
beforeAll(async () => {
  Object.assign(process.env, {
    SUPPORT_WHATSAPP_ENABLED: 'true',
    SUPPORT_WHATSAPP_PHONE_NUMBER_ID: receiverId,
    WHATSAPP_SALES_PHONE_NUMBER_ID: 'sales',
    SUPPORT_WHATSAPP_ENC_KEY: 'e'.repeat(64),
    WHATSAPP_ACCESS_TOKEN: 'fixture-never-used',
  })
  orgId = (await prisma.organization.create({ data: { name: 'Avisos fixture', email: `${receiverId}-org@test.local`, phone: '0' } })).id
  northId = (await prisma.venue.create({ data: { organizationId: orgId, name: 'Norte', slug: `${receiverId}-norte`, status: 'ACTIVE' } }))
    .id
  southId = (await prisma.venue.create({ data: { organizationId: orgId, name: 'Sur', slug: `${receiverId}-sur`, status: 'ACTIVE' } })).id
  const staff = async (phone: string, firstName: string, venues: string[]) => {
    const id = (
      await prisma.staff.create({
        data: { email: `${receiverId}-${firstName}@test.local`, firstName, lastName: 'Avisos', emailVerified: true, phone },
      })
    ).id
    await prisma.staffVenue.createMany({ data: venues.map(venueId => ({ staffId: id, venueId, role: 'VIEWER' as const })) })
    await prisma.staffOrganization.create({ data: { staffId: id, organizationId: orgId, role: 'MEMBER' } })
    return id
  }
  // Ana: a registered phone with two venues. Beto: one venue.
  anaId = await staff(anaPhone, 'Ana', [northId, southId])
  betoId = await staff(betoPhone, 'Beto', [northId])
})
beforeEach(async () => {
  await clean()
  Object.assign(process.env, {
    SUPPORT_WHATSAPP_FREE_TEXT_ENABLED: 'true',
    SUPPORT_WHATSAPP_HYBRID_ENABLED: 'true',
    SUPPORT_HANDOFF_EMAIL_TO: 'soporte@test.local',
    // The caps are Task 5's; here every request is a PENDING notice.
    SUPPORT_HANDOFF_PHONE_DAILY_CAP: '50',
    SUPPORT_HANDOFF_DAILY_CAP: '500',
  })
  jest.spyOn(knowledge, 'loadSupportLibrary').mockReturnValue([products])
})
afterEach(async () => {
  jest.restoreAllMocks()
  await prisma.staffVenue.updateMany({ where: { staffId: { in: [anaId, betoId] } }, data: { active: true } })
  await prisma.staff.updateMany({ where: { id: { in: [anaId, betoId] } }, data: { active: true } })
  delete process.env.SUPPORT_PUBLIC_HELP_ENABLED
})
afterAll(async () => {
  await clean()
  if (!orgId) return
  await prisma.staffVenue.deleteMany({ where: { staffId: { in: [anaId, betoId] } } })
  await prisma.staffOrganization.deleteMany({ where: { staffId: { in: [anaId, betoId] } } })
  await prisma.staff.deleteMany({ where: { id: { in: [anaId, betoId] } } })
  await prisma.venue.deleteMany({ where: { id: { in: [northId, southId] } } })
  await prisma.organization.delete({ where: { id: orgId } })
})

const openConversation = (from = anaPhone, data: Partial<Prisma.SupportConversationUncheckedCreateInput> = {}) =>
  prisma.supportConversation.create({
    data: {
      receiverId,
      phone: from,
      app: 'dashboard',
      noticeAcceptedAt: new Date(),
      lastUserMessageAt: new Date(),
      lastActivityAt: new Date(),
      ...data,
    },
  })
async function personal() {
  const link = await prisma.supportWhatsappLink.create({
    data: { staffId: anaId, phone: anaPhone, verifiedAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 86_400_000) },
  })
  return openConversation(anaPhone, { mode: 'PERSONAL', staffId: anaId, linkId: link.id, orgId, venueId: northId })
}
/** The notice exactly as Task 5 writes it. */
async function handoff(conversation: SupportConversation, reason: HandoffMeta['reason'] = 'REQUESTED'): Promise<SupportNotice> {
  await prisma.$transaction(tx => requestSupportHandoff(tx, conversation, reason, new Date(), getSupportHandoffConfig()!))
  return prisma.supportNotice.findUniqueOrThrow({ where: { dedupeKey: `handoff:${conversation.id}:${conversation.generation}` } })
}
/** A notice the caps held (yesterday by default). Its conversation closes: nothing reads it again, and the phone can open another. */
async function held(conversation: SupportConversation, day = yesterday) {
  const notice = await prisma.supportNotice.update({ where: { id: (await handoff(conversation)).id }, data: { status: 'HELD', day } })
  await prisma.supportConversation.update({ where: { id: conversation.id }, data: { mode: 'CLOSED' } })
  return notice
}
const routedNotice = async () =>
  prisma.supportNotice.findFirstOrThrow({ where: { conversationId: { in: await conversationIds() }, kind: 'HANDOFF' } })
async function answered(body: string, from = anaPhone) {
  const { messageId } = await admitSupportMessage(input(body, from))
  await prisma.supportMessage.update({
    where: { id: messageId },
    data: { status: 'SENT', answer: `Respuesta a: ${body}`, sourceIds: [sourceRef(products)] },
  })
}
const removeVenue = (staffId: string, venueId: string) =>
  prisma.staffVenue.updateMany({ where: { staffId, venueId }, data: { active: false } })

describe('privacy', () => {
  it('the email and the notice row contain nothing the customer wrote', async () => {
    await openConversation()
    for (const body of ['mi clave es verano123', 'mi código es AB12CD', 'mi CVV es 123']) await answered(body)
    expect(await tryRouteSupport(input('PERSONA'))).toBe('QUEUED')
    const born = await routedNotice()
    const t = transport()
    await run(t)
    const [mail] = t.mine(born.id)
    expect(mail).toBeDefined()
    // What the assistant tried is in the email; what the person wrote is not.
    expect(decoded(mail.html!)).toContain(products.title)
    const haystacks = [decoded(mail.html!), mail.text!, mail.subject, JSON.stringify(born), JSON.stringify(await row(born.id))]
    for (const word of ['clave', 'verano123', 'código', 'codigo', 'AB12CD', 'CVV', '123'])
      for (const haystack of haystacks) expect(haystack).not.toMatch(new RegExp(`(^|[^\\p{L}\\p{N}])${word}($|[^\\p{L}\\p{N}])`, 'iu'))
  })

  it.each(['SALIR', 'APP'])(
    'PERSONA then %s before the first send: the email still goes out with the context of the request',
    async command => {
      await openConversation()
      await answered('¿Cómo creo un producto?')
      await tryRouteSupport(input('PERSONA'))
      await tryRouteSupport(input(command))
      const born = await routedNotice()
      const t = transport()
      await run(t)
      const page = decoded(t.mine(born.id)[0].html!)
      for (const value of [products.title, 'Ana Avisos', 'Avisos fixture', 'Norte', 'Sur', anaPhone]) expect(page).toContain(value)
      expect(await row(born.id)).toMatchObject({ status: 'SENT' })
    },
  )

  it.each([
    ['closed (SALIR)', () => tryRouteSupport(input('SALIR'))],
    [
      'idle (30 min)',
      async () => {
        const at = new Date(Date.now() - 31 * 60_000)
        await prisma.supportConversation.updateMany({ where: { receiverId }, data: { lastActivityAt: at, lastUserMessageAt: at } })
      },
    ],
  ])('%s conversation still sends', async (_label, after) => {
    const notice = await handoff(await openConversation())
    await after()
    const t = transport()
    await run(t)
    expect(t.mine(notice.id)).toHaveLength(1)
    expect(await row(notice.id)).toMatchObject({ status: 'SENT' })
  })
})

describe('delivery', () => {
  it('PENDING → SENT with resendId, meta cleared', async () => {
    const notice = await handoff(await personal())
    expect(notice).toMatchObject({ status: 'PENDING', meta: expect.any(Object) })
    const t = transport()
    const now = new Date()
    await run(t, now)
    const [mail, ...more] = t.mine(notice.id)
    expect(more).toEqual([])
    expect(mail).toMatchObject({ to: 'soporte@test.local', idempotencyKey: `support-notice:${notice.id}` })
    expect(mail.subject).toBe('Soporte · Avisos fixture · Dashboard web · pidió una persona')
    expect(await row(notice.id)).toMatchObject({
      status: 'SENT',
      resendId: 're_fixture',
      meta: null,
      finishedAt: now,
      firstAttemptAt: now,
      attempts: 0,
    })
    // A finished notice never goes out again.
    await run(t, new Date(now.getTime() + 3_600_000))
    expect(t.mine(notice.id)).toHaveLength(1)
  })

  it('transient failure → attempts 1, retried after 1 min; fifth failure → FAILED', async () => {
    const notice = await handoff(await personal())
    const t = transport(() => ({ ok: false, transient: true, errorCode: 'rate_limit_exceeded' }))
    let now = new Date()
    await run(t, now)
    expect(await row(notice.id)).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      errorCode: 'rate_limit_exceeded',
      nextAttemptAt: new Date(now.getTime() + 60_000),
      meta: expect.any(Object),
    })
    // Not before its time.
    await run(t, new Date(now.getTime() + 30_000))
    expect(t.mine(notice.id)).toHaveLength(1)
    for (const [attempts, minutes] of [
      [2, 5],
      [3, 15],
      [4, 60],
    ]) {
      now = (await row(notice.id)).nextAttemptAt
      await run(t, now)
      expect(await row(notice.id)).toMatchObject({ status: 'PENDING', attempts, nextAttemptAt: new Date(now.getTime() + minutes * 60_000) })
    }
    await run(t, (await row(notice.id)).nextAttemptAt)
    expect(await row(notice.id)).toMatchObject({ status: 'FAILED', attempts: 5, meta: null, errorCode: 'rate_limit_exceeded' })
    const sends = t.mine(notice.id)
    expect(sends).toHaveLength(5)
    // Every retry, the same key and the same email.
    for (const send of sends) expect(send).toEqual(sends[0])
  })

  it('permanent refusal → FAILED at once', async () => {
    const notice = await handoff(await personal())
    const t = transport(() => ({ ok: false, transient: false, errorCode: 'validation_error' }))
    const now = new Date()
    await run(t, now)
    expect(await row(notice.id)).toMatchObject({ status: 'FAILED', errorCode: 'validation_error', meta: null, finishedAt: now })
    await run(t, new Date(now.getTime() + 3_600_000))
    expect(t.mine(notice.id)).toHaveLength(1)
  })

  it.each(['invalid_idempotent_request', 'concurrent_idempotent_requests'])('an idempotency error → UNCERTAIN (%s)', async errorCode => {
    const notice = await handoff(await personal())
    const t = transport(() => ({ ok: false, transient: errorCode.startsWith('concurrent'), errorCode }))
    await run(t)
    expect(await row(notice.id)).toMatchObject({ status: 'UNCERTAIN', errorCode, meta: null })
    await run(t, new Date(Date.now() + 3_600_000))
    expect(t.mine(notice.id)).toHaveLength(1)
  })

  /** The state a process leaves when it dies after Resend accepted and before writing SENT. */
  async function diedAfterResendAccepted(notice: SupportNotice, t: ReturnType<typeof transport>, at: Date) {
    const real = prisma.supportNotice.updateMany.bind(prisma.supportNotice)
    const spy = jest
      .spyOn(prisma.supportNotice, 'updateMany')
      .mockImplementation(((args: Prisma.SupportNoticeUpdateManyArgs) =>
        args.data.status === 'SENT' ? Promise.reject(new Error('fixture: the process died here')) : real(args)) as never)
    await run(t, at)
    spy.mockRestore()
    expect(await row(notice.id)).toMatchObject({ status: 'SENDING', reservedAt: at, firstAttemptAt: at, meta: expect.any(Object) })
    expect(t.mine(notice.id)).toHaveLength(1)
  }

  it('a process dead after Resend accepted (SENDING, old reservedAt) is retaken within 23 h with the same key and identical content', async () => {
    const notice = await handoff(await openConversation())
    const t = transport()
    const t0 = new Date()
    await diedAfterResendAccepted(notice, t, t0)
    // Inside its lease nobody touches it.
    await run(t, new Date(t0.getTime() + 60_000))
    expect(t.mine(notice.id)).toHaveLength(1)
    await run(t, new Date(t0.getTime() + 22 * 3_600_000))
    const [first, retaken] = t.mine(notice.id)
    expect(retaken).toEqual(first)
    expect(await row(notice.id)).toMatchObject({ status: 'SENT', meta: null })
  })

  it('retaken after 23 h → UNCERTAIN, nothing sent', async () => {
    const notice = await handoff(await openConversation())
    const t = transport()
    const t0 = new Date()
    await diedAfterResendAccepted(notice, t, t0)
    await run(t, new Date(t0.getTime() + NOTICE_KEY_TTL_MS + 60_000))
    expect(t.mine(notice.id)).toHaveLength(1)
    expect(await row(notice.id)).toMatchObject({ status: 'UNCERTAIN', meta: null })
  })

  it('access removed between a transient failure and the retry: the retry sends identical content with the same key and the row is never SKIPPED', async () => {
    const notice = await handoff(await openConversation())
    const t = transport(n => (n === 1 ? { ok: false, transient: true, errorCode: 'internal_server_error' } : ok))
    const t0 = new Date()
    await run(t, t0)
    const frozen = (await row(notice.id)).meta
    await removeVenue(anaId, northId)
    await removeVenue(anaId, southId)
    await run(t, new Date(t0.getTime() + 61_000))
    const [first, retry] = t.mine(notice.id)
    expect(retry).toEqual(first)
    expect(frozen).toEqual(notice.meta)
    expect(await row(notice.id)).toMatchObject({ status: 'SENT' })
  })

  it('two runs at once send it once', async () => {
    const notice = await handoff(await personal())
    const t = transport()
    const now = new Date()
    await Promise.all([run(t, now), run(t, now)])
    expect(t.mine(notice.id)).toHaveLength(1)
    expect(await row(notice.id)).toMatchObject({ status: 'SENT' })
  })

  it('a send that never answers is cut at timeoutMs and retried with the same key', async () => {
    const notice = await handoff(await personal())
    const t = transport(n => (n === 1 ? 'hang' : ok))
    const t0 = new Date(),
      started = Date.now()
    await run(t, t0, 300)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(await row(notice.id)).toMatchObject({ status: 'PENDING', attempts: 1, errorCode: 'TIMEOUT' })
    await run(t, new Date(t0.getTime() + 61_000), 300)
    const [cut, retry] = t.mine(notice.id)
    expect(retry).toEqual(cut)
    expect(await row(notice.id)).toMatchObject({ status: 'SENT' })
  })

  it('a WEEKLY_REPORT row is sent from its meta as it is, once, with nothing revalidated', async () => {
    // As Task 7 stores it: counts only, dates as ISO strings.
    const report = {
      from: '2021-01-04T06:00:00.000Z',
      to: '2021-01-11T06:00:00.000Z',
      failures: [{ app: 'dashboard', kind: 'UNKNOWN', count: 3 }],
      guides: [{ id: products.id, title: products.title, count: 3 }],
      guidesMore: 0,
      handoffs: [{ app: 'dashboard', status: 'SENT', reason: 'REQUESTED', count: 1 }],
      undelivered: [],
    }
    const weekly = await prisma.supportNotice.create({
      data: { kind: 'WEEKLY_REPORT', dedupeKey: `weekly:${receiverId}`, day: '2021-01-11', meta: report },
    })
    try {
      const t = transport()
      await run(t, new Date(Date.now() + 3_600_000))
      expect(t.mine(weekly.id)).toEqual([
        { ...buildWeeklyEmail(report as unknown as WeeklyReport, 'soporte@test.local'), idempotencyKey: `support-notice:${weekly.id}` },
      ])
      expect(await row(weekly.id)).toMatchObject({ status: 'SENT', meta: null, resendId: 're_fixture' })
      await run(t, new Date(Date.now() + 7_200_000))
      expect(t.mine(weekly.id)).toHaveLength(1)
    } finally {
      await prisma.supportNotice.delete({ where: { id: weekly.id } })
    }
  })

  it('nothing runs without handoff config', async () => {
    const notice = await handoff(await personal())
    await held(await openConversation(betoPhone))
    delete process.env.SUPPORT_HANDOFF_EMAIL_TO
    const t = transport()
    expect(await run(t)).toEqual({ sent: 0, failed: 0, skipped: 0, uncertain: 0 })
    expect(t.send).not.toHaveBeenCalled()
    expect(await row(notice.id)).toMatchObject({ status: 'PENDING', reservedAt: null, attempts: 0 })
    expect(await digest()).toBeNull()
  })
})

describe('access at send time (R1-02, R2-01)', () => {
  it('access removed from the origin venue but kept in another → SKIPPED, nothing sent', async () => {
    const notice = await handoff(await personal())
    await removeVenue(anaId, northId)
    const t = transport()
    await run(t)
    expect(t.mine(notice.id)).toEqual([])
    expect(await row(notice.id)).toMatchObject({ status: 'SKIPPED', errorCode: 'REVOKED', meta: null })
  })

  it.each([
    ['link revoked', personal, () => prisma.supportWhatsappLink.deleteMany({ where: { staffId: anaId } })],
    ['person deactivated (linked)', personal, () => prisma.staff.update({ where: { id: anaId }, data: { active: false } })],
    ['person deactivated (public)', () => openConversation(), () => prisma.staff.update({ where: { id: anaId }, data: { active: false } })],
  ])('%s → SKIPPED', async (_label, open, revoke) => {
    // With public help off, as before it: a public phone that now belongs to nobody goes out as a number with no account
    // (public-help.integration.test.ts).
    process.env.SUPPORT_PUBLIC_HELP_ENABLED = 'false'
    const notice = await handoff(await open())
    await revoke()
    const t = transport()
    await run(t)
    expect(t.mine(notice.id)).toEqual([])
    expect(await row(notice.id)).toMatchObject({ status: 'SKIPPED', errorCode: 'REVOKED', meta: null })
  })

  it('public phone with venues A and B, A removed before sending: the email shows only B', async () => {
    const notice = await handoff(await openConversation())
    expect((notice.meta as unknown as HandoffMeta).people[0].venues.map(v => v.name)).toEqual(['Norte', 'Sur'])
    await removeVenue(anaId, northId)
    const t = transport()
    await run(t)
    const page = decoded(t.mine(notice.id)[0].html!)
    expect(page).toContain('Sur')
    expect(page).not.toContain('Norte')
    expect(await row(notice.id)).toMatchObject({ status: 'SENT' })
  })
})

describe('daily digest', () => {
  it('HELD rows of yesterday go out in one daily digest, once', async () => {
    // Today's held notice waits for tomorrow's digest.
    const today = await held(await openConversation(), venueDayKey(new Date(), CDMX))
    const ana = await held(await openConversation()),
      beto = await held(await openConversation(betoPhone))
    const t = transport()
    const now = new Date()
    await Promise.all([run(t, now), run(t, now)])
    await run(t, new Date(now.getTime() + 3_600_000))
    const daily = (await digest())!
    expect(daily).toMatchObject({ kind: 'DAILY_DIGEST', status: 'SENT', day: yesterday, meta: null })
    const [mail, ...more] = t.mine(daily.id)
    expect(more).toEqual([])
    expect(mail.subject).toContain(yesterday)
    const page = decoded(mail.html!)
    expect(page).toContain('Ana Avisos')
    expect(page).toContain('Beto Avisos')
    for (const held of [ana, beto]) expect(await row(held.id)).toMatchObject({ status: 'HELD', digestId: daily.id })
    // A held notice is never mailed on its own.
    expect(t.mine(ana.id)).toEqual([])
    expect(await row(today.id)).toMatchObject({ status: 'HELD', digestId: null })
  })

  it('a held digest row whose person lost the venue is left out and marked SKIPPED', async () => {
    process.env.SUPPORT_PUBLIC_HELP_ENABLED = 'false'
    const ana = await held(await openConversation()),
      beto = await held(await openConversation(betoPhone))
    await removeVenue(betoId, northId)
    const t = transport()
    await run(t)
    const daily = (await digest())!
    const page = decoded(t.mine(daily.id)[0].html!)
    expect(page).toContain('Ana Avisos')
    expect(page).not.toContain('Beto Avisos')
    expect(await row(beto.id)).toMatchObject({ status: 'SKIPPED', errorCode: 'REVOKED', meta: null, digestId: daily.id })
    expect(await row(ana.id)).toMatchObject({ status: 'HELD', digestId: daily.id })
  })

  it('a digest whose every row lost access is SKIPPED and nothing is sent', async () => {
    process.env.SUPPORT_PUBLIC_HELP_ENABLED = 'false'
    const beto = await held(await openConversation(betoPhone))
    await removeVenue(betoId, northId)
    const t = transport()
    await run(t)
    const daily = (await digest())!
    expect(daily).toMatchObject({ status: 'SKIPPED', errorCode: 'REVOKED' })
    expect(t.mine(daily.id)).toEqual([])
    expect(await row(beto.id)).toMatchObject({ status: 'SKIPPED' })
  })

  it('public phone with venues A and B, A removed before the digest: its row shows only B', async () => {
    await held(await openConversation())
    await removeVenue(anaId, northId)
    const t = transport()
    await run(t)
    const page = decoded(t.mine((await digest())!.id)[0].html!)
    expect(page).toContain('Sur')
    expect(page).not.toContain('Norte')
  })
})
