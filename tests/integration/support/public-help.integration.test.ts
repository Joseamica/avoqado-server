// Ayuda pública (22-nov): un número que no es de ninguna cuenta recibe el aviso, guías públicas y «persona», con cuatro topes:
// 10 preguntas por hora y 20 al día por número, 3 mensajes sin sentido o fuera de tema seguidos = 24 h de silencio (7 días si
// reincide), US$1 al día de IA entre todos y el tope del mes de hoy. Quien está registrado no nota nada.
import crypto from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { LUNA_SUPPORT_PRICING as pricing, getSupportAiConfig } from '@/config/supportWhatsapp'
import { admitSupportMessage, claimNext } from '@/services/support/store.service'
import { prepareSupportAnswer } from '@/services/support/worker.service'
import * as knowledge from '@/services/support/knowledge.service'
import { type LibraryGuide } from '@/services/support/knowledge.service'
import { createSupportAiClient } from '@/services/support/answer.service'
import { type SupportDraft } from '@/services/support/hybrid.service'
import { tryRouteSupport } from '@/services/support/router.service'
import { deliverSupportMessage } from '@/services/support/delivery.service'
import { runSupportNotices } from '@/services/support/notices.service'
import { mexicoDay as publicDayStart, publicDayKey, publicPhoneCaps } from '@/services/support/publicHelp.service'
import { finishAiAttempt, reserveAiAttempt, startAiAttempt } from '@/services/support/budget.service'
import { aiInput } from '@tests/__helpers__/supportAiInput'
import {
  SUPPORT_ASK_APP,
  SUPPORT_NOTICE_FREE_TEXT,
  SUPPORT_OFF_TOPIC,
  SUPPORT_PUBLIC_DAY_LIMIT,
  SUPPORT_PUBLIC_HOUR_LIMIT,
  SUPPORT_REPHRASE,
  SUPPORT_UNREGISTERED,
  supportHandoffAlready,
  supportHandoffDone,
  supportPublicNotice,
  supportPublicPause,
} from '@/services/support/texts'

const receiverId = `support-public-${Date.now()}`,
  unknown = '+525500009401',
  member = '+525500009402'
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
const cdmxDay = (at: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(at)
const yesterday = cdmxDay(new Date(Date.now() - 86_400_000))
const guide = (id: string, title: string, body: string, extra: Partial<LibraryGuide> = {}): LibraryGuide => ({
  id,
  app: 'dashboard',
  title,
  summary: title,
  steps: [title],
  publicUrl: `https://avoqado.io/help/${id}`,
  requiredPermissions: [],
  keywords: [],
  body,
  general: false,
  internal: false,
  hash: sha(`${id}\n${body}`),
  ...extra,
})
const branch = guide(
  'dashboard/sucursales/cambiar-sucursal',
  'Cambiar de sucursal',
  'Para cambiar de sucursal toca el nombre del negocio arriba a la izquierda y elige otra sucursal de la lista.',
)
// A page of the internal manual: never offered to a number with no account.
const manual = guide('dashboard/caja/cerrar-caja', 'Cerrar la caja', 'Para cerrar la caja abre Turnos y toca cerrar.', {
  publicUrl: '',
  internal: true,
})
const library = [branch, manual]
const question = { kind: 'question', standalone: '¿Cómo cambio de sucursal?', guideIds: [branch.id] }
const fixed = (kind: string) => ({ kind, standalone: '', guideIds: [] })
const draft: SupportDraft = {
  covered: true,
  intro: { text: 'Cambias de sucursal desde el nombre del negocio.', guideId: branch.id, quote: 'toca el nombre del negocio' },
  steps: [{ text: 'Elige otra sucursal de la lista.', guideId: branch.id, quote: 'elige otra sucursal de la lista' }],
}
const supported = { supported: true, missing: [] }

let serial = 0,
  outbound = 0,
  staffId: string,
  orgId: string,
  venueId: string
const originalFetch = global.fetch
const input = (body: string, from = unknown, extra = {}) => ({
  receiverId,
  phone: from,
  wamid: `wamid.${receiverId}-${++serial}`,
  type: 'text',
  body,
  timestamp: String(Math.floor(Date.now() / 1000)),
  ...extra,
})
type Reply = object | Error
function provider(replies: Reply[], onCall?: (n: number) => Promise<void>) {
  const bodies: Record<string, any>[] = []
  const fetcher = jest.fn(async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body)))
    await onCall?.(bodies.length)
    const reply = replies[bodies.length - 1]
    if (!reply) throw new TypeError('fixture: no reply configured for this call')
    if (reply instanceof Error) throw reply
    return new Response(
      JSON.stringify({
        id: `resp_${bodies.length}`,
        status: 'completed',
        usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(reply), annotations: [] }] }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  })
  return {
    fetcher,
    inputs: () => bodies.map(b => aiInput(b.input)),
    client: createSupportAiClient(getSupportAiConfig()!, fetcher as never),
  }
}
const conversationIds = async () =>
  (await prisma.supportConversation.findMany({ where: { receiverId }, select: { id: true }, take: 500 })).map(c => c.id)
async function clean() {
  const ids = await conversationIds()
  await prisma.supportEvent.deleteMany({ where: { conversationId: { in: ids } } })
  await prisma.supportNotice.deleteMany({ where: { conversationId: { in: ids } } })
  await prisma.supportAttempt.deleteMany({ where: { message: { conversation: { receiverId } } } })
  await prisma.supportMessage.deleteMany({ where: { conversation: { receiverId } } })
  await prisma.supportConversation.deleteMany({ where: { receiverId } })
  await prisma.whatsappInboundEvent.deleteMany({ where: { receiverId } })
  await prisma.supportBudget.deleteMany({
    where: { OR: [{ key: { startsWith: 'AI:' } }, { key: { startsWith: `CONTROL:${receiverId}:` } }] },
  })
  await prisma.supportNotice.deleteMany({
    where: { OR: [{ dedupeKey: { startsWith: `held:${receiverId}:` } }, { dedupeKey: `daily:${yesterday}` }] },
  })
}
const reply = (event: { wamid: string }) => prisma.supportMessage.findFirstOrThrow({ where: { inboundEvent: { wamid: event.wamid } } })
const open = (from = unknown) => prisma.supportConversation.findFirst({ where: { receiverId, phone: from, mode: { not: 'CLOSED' } } })
/** What the router answered is delivered (a «sí» only accepts a notice that was shown). */
const deliver = () =>
  prisma.supportMessage.updateMany({
    where: { conversation: { receiverId }, status: 'ANSWER_READY' },
    data: { status: 'SENT', outboundWamid: null },
  })
async function send(body: string, from = unknown) {
  const event = input(body, from)
  const routed = await tryRouteSupport(event)
  return { routed, event }
}
/** The worker takes the next message with the fake provider and the fixture library. */
async function work(replies: Reply[], onCall?: (n: number) => Promise<void>) {
  const p = provider(replies, onCall)
  const claim = await claimNext(new Date(Date.now() + 10), receiverId)
  if (!claim) return { p, result: null, message: null }
  const result = await prepareSupportAnswer(claim, { client: p.client, library })
  const message = await prisma.supportMessage.findUniqueOrThrow({ where: { id: claim.messageId } })
  if (message.status === 'ANSWER_READY')
    await prisma.supportMessage.update({ where: { id: message.id }, data: { status: 'SENT', outboundWamid: `wamid.out-${++outbound}` } })
  return { p, result, message }
}
/** Capa 1: what this phone has spent of its day and its hour (in that order). */
async function capCounts(from = unknown) {
  const caps = publicPhoneCaps(receiverId, from, new Date())
  const rows = await prisma.supportBudget.findMany({ where: { key: { in: caps.map(c => c.key) } } })
  return caps.map(c => rows.find(r => r.key === c.key)?.callCount ?? 0)
}
/** An unknown phone that already accepted the notice and chose the dashboard. */
async function ready(from = unknown) {
  await send('hola', from)
  await deliver()
  await send('sí', from)
  await deliver()
  await send('1', from)
  await deliver()
}

beforeAll(async () => {
  Object.assign(process.env, {
    SUPPORT_WHATSAPP_ENABLED: 'true',
    SUPPORT_WHATSAPP_PHONE_NUMBER_ID: receiverId,
    WHATSAPP_SALES_PHONE_NUMBER_ID: 'sales',
    SUPPORT_WHATSAPP_ENC_KEY: 'e'.repeat(64),
    SUPPORT_AI_ENABLED: 'true',
    SUPPORT_AI_MODEL: pricing.model,
    SUPPORT_AI_PRICING_VERSION: pricing.version,
    SUPPORT_AI_MONTHLY_USD_LIMIT: '10',
    SUPPORT_OPENAI_API_KEY: 'fixture-never-used',
    WHATSAPP_ACCESS_TOKEN: 'fixture-never-used',
  })
  orgId = (await prisma.organization.create({ data: { name: 'Public help fixture', email: `${receiverId}-org@test.local`, phone: '0' } }))
    .id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: 'Norte', slug: `${receiverId}-norte`, status: 'ACTIVE' } }))
    .id
  staffId = (
    await prisma.staff.create({
      data: { email: `${receiverId}-staff@test.local`, firstName: 'Registrada', lastName: 'Prueba', emailVerified: true, phone: member },
    })
  ).id
  await prisma.staffVenue.create({ data: { staffId, venueId, role: 'VIEWER' } })
})
beforeEach(async () => {
  await clean()
  process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED = 'true'
  process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED = 'true'
  process.env.SUPPORT_HANDOFF_EMAIL_TO = 'soporte@test.local'
  global.fetch = jest.fn(async () => new Response('{"success":true}', { status: 200 })) as unknown as typeof fetch
  jest.spyOn(knowledge, 'loadSupportLibrary').mockReturnValue(library)
})
afterEach(() => {
  global.fetch = originalFetch
  jest.restoreAllMocks()
  for (const key of [
    'SUPPORT_WHATSAPP_FREE_TEXT_ENABLED',
    'SUPPORT_WHATSAPP_HYBRID_ENABLED',
    'SUPPORT_HANDOFF_EMAIL_TO',
    'SUPPORT_PUBLIC_HELP_ENABLED',
    'SUPPORT_PUBLIC_HELP_DAILY_USD',
  ])
    delete process.env[key]
})
afterAll(async () => {
  await clean()
  if (!orgId) return
  await prisma.staffVenue.deleteMany({ where: { staffId } })
  await prisma.staff.delete({ where: { id: staffId } })
  await prisma.venue.delete({ where: { id: venueId } })
  await prisma.organization.delete({ where: { id: orgId } })
})

describe('the way in', () => {
  it('«hola» from an unknown phone gets the public notice, not the fixed message; nothing reaches the model', async () => {
    const { routed, event } = await send('hola')
    expect(routed).toBe('QUEUED')
    expect(await reply(event)).toMatchObject({ answer: supportPublicNotice(), status: 'ANSWER_READY' })
    expect(await open()).toMatchObject({ mode: 'PUBLIC', staffId: null, noticeAcceptedAt: null })
  })
  it('a question before the notice waits for the «sí» (never to the model before it), then the app, then a public guide', async () => {
    const asked = await send('¿Cómo cambio de sucursal?')
    expect(await reply(asked.event)).toMatchObject({ answer: supportPublicNotice() })
    await deliver()
    expect(await prisma.supportAttempt.count({ where: { message: { conversation: { receiverId } } } })).toBe(0)
    const yes = await send('sí')
    expect(await reply(yes.event)).toMatchObject({ answer: SUPPORT_ASK_APP })
    await deliver()
    const app = await send('1')
    expect(await reply(app.event)).toMatchObject({ status: 'QUEUED', body: '¿Cómo cambio de sucursal?' })
    const { p, result, message } = await work([question, draft, supported])
    expect(result).toBe('READY')
    expect(message?.sourceIds).toEqual([knowledge.sourceRef(branch)])
    // The same library as the public mode of today: the internal manual included (founder, 22-nov, «a»).
    expect(p.inputs()[0].index.map((g: { id: string }) => g.id)).toEqual([manual.id, branch.id])
  })
  it('the switch off: exactly today (the fixed message, once a day)', async () => {
    process.env.SUPPORT_PUBLIC_HELP_ENABLED = 'false'
    const first = await send('hola')
    expect(await reply(first.event)).toMatchObject({ answer: SUPPORT_UNREGISTERED })
    expect((await send('¿Cómo cambio de sucursal?')).routed).toBe('IGNORED')
  })
  it('AYUDA shows the public notice; RECUPERAR never reaches a guide of another conversation', async () => {
    // A guide sent to this phone in a conversation that is now closed.
    const old = await admitSupportMessage(input('¿Cómo cierro la caja?'))
    await prisma.supportMessage.update({
      where: { id: old.messageId },
      data: { status: 'SENT', answer: 'guía', sourceIds: [knowledge.sourceRef(manual)] },
    })
    await prisma.supportConversation.updateMany({
      where: { receiverId, phone: unknown },
      data: { mode: 'CLOSED', app: 'dashboard', lastActivityAt: new Date(Date.now() - 3_600_000) },
    })
    const help = await send('AYUDA')
    expect(await reply(help.event)).toMatchObject({ answer: supportPublicNotice() })
    await deliver()
    await send('sí')
    await deliver()
    await send('1')
    await deliver()
    await send('RECUPERAR')
    const { p, message } = await work([])
    expect(p.fetcher).not.toHaveBeenCalled()
    expect(message?.sourceIds).toEqual([])
    expect(message?.answer).toMatch(/^No encontré una guía guardada/)
  })
})

describe('capa 1: 10 respuestas por hora y 20 al día por número', () => {
  const caps = () => publicPhoneCaps(receiverId, unknown, new Date())
  async function seed(window: 'HOUR' | 'DAY') {
    const cap = caps().find(c => c.window === window)!
    await prisma.supportBudget.upsert({
      where: { key: cap.key },
      create: { key: cap.key, windowStart: cap.start, callCount: cap.maximum },
      update: { callCount: cap.maximum },
    })
  }
  const counts = async () => {
    const rows = await prisma.supportBudget.findMany({ where: { key: { in: caps().map(c => c.key) } } })
    return caps().map(c => rows.find(r => r.key === c.key)?.callCount ?? 0)
  }
  it.each([
    ['DAY', SUPPORT_PUBLIC_DAY_LIMIT],
    ['HOUR', SUPPORT_PUBLIC_HOUR_LIMIT],
  ] as const)('over the %s cap: its notice once, then silence («persona» included); what it queued still goes', async (window, text) => {
    await ready()
    const queued = await send('¿Cómo cambio de sucursal?')
    await seed(window)
    const before = await counts()
    const over = await send('¿Y en la terminal?')
    expect(await reply(over.event)).toMatchObject({ answer: text, status: 'ANSWER_READY' })
    expect((await send('¿y ahora?')).routed).toBe('IGNORED')
    expect((await send('persona')).routed).toBe('IGNORED')
    // In the same conversation, behind what it already queued (never cancelled); the refused ones are not counted.
    expect(await reply(queued.event)).toMatchObject({ status: 'QUEUED' })
    expect((await reply(over.event)).conversationId).toBe((await reply(queued.event)).conversationId)
    expect(await counts()).toEqual(before)
  })
  it('SALIR quoting a message it cannot identify gets that answer, so it counts', async () => {
    await ready()
    const quoted = input('SALIR', unknown, { contextId: 'wamid.not-ours' })
    expect(await tryRouteSupport(quoted)).toBe('QUEUED')
    expect((await reply(quoted)).answer).toMatch(/^No puedo identificar esa respuesta/)
    expect(await capCounts()).toEqual([4, 4])
  })
  it('every message it answers counts once, also the ones the router answers; SALIR does not; the AI caps of today are not used', async () => {
    expect(caps().map(c => [c.window, c.maximum])).toEqual([
      ['DAY', 20],
      ['HOUR', 10],
    ])
    await ready()
    expect(await counts()).toEqual([3, 3])
    await send('¿Cómo cambio de sucursal?')
    await work([question, draft, supported])
    expect(await counts()).toEqual([4, 4])
    await send('SALIR')
    expect(await counts()).toEqual([4, 4])
    expect(await prisma.supportBudget.count({ where: { key: { startsWith: `AI:PHONE_` } } })).toBe(0)
  })
})

describe('capa 2: tres mensajes sin sentido o fuera de tema seguidos', () => {
  const pauseKey = `CONTROL:${receiverId}:${sha(unknown)}:PAUSE`
  async function strikes(kinds: string[]) {
    const answers: (string | null)[] = []
    for (const kind of kinds) {
      await send(kind === 'question' ? '¿Cómo cambio de sucursal?' : 'asdfgh')
      answers.push((await work(kind === 'question' ? [question, draft, supported] : [fixed(kind)])).message?.answer ?? null)
    }
    return answers
  }
  it('the third one in a row pauses 24 h, said once; then everything is ignored, AYUDA, «persona» and SALIR included', async () => {
    await ready()
    expect(await strikes(['nonsense', 'off_topic', 'nonsense'])).toEqual([SUPPORT_REPHRASE, SUPPORT_OFF_TOPIC, supportPublicPause(1)])
    for (const body of ['¿Cómo cambio de sucursal?', 'AYUDA', 'persona']) expect((await send(body)).routed).toBe('IGNORED')
    await send('SALIR')
    expect((await send('hola')).routed).toBe('IGNORED')
  })
  it('a valid question in between starts the count again; a greeting does not', async () => {
    await ready()
    expect(await strikes(['nonsense', 'nonsense', 'question', 'nonsense', 'greeting', 'nonsense'])).not.toContain(supportPublicPause(1))
    expect((await strikes(['off_topic'])).at(-1)).toBe(supportPublicPause(1))
  })
  it('after the 24 h it answers again; three more within 7 days of the end are 7 days', async () => {
    await ready()
    await strikes(['nonsense', 'nonsense', 'nonsense'])
    // The 24 h passed.
    await prisma.supportBudget.update({ where: { key: pauseKey }, data: { windowStart: new Date(Date.now() - 25 * 3_600_000) } })
    const back = await send('hola')
    expect(back.routed).toBe('QUEUED')
    await deliver()
    expect((await strikes(['nonsense', 'off_topic', 'nonsense'])).at(-1)).toBe(supportPublicPause(7))
  })
  it('the pause cancels what this phone left in line', async () => {
    await ready()
    await strikes(['nonsense', 'nonsense'])
    await send('asdf')
    await send('hola')
    expect(await capCounts()).toEqual([7, 7])
    await work([fixed('nonsense')])
    expect(await prisma.supportMessage.count({ where: { conversation: { receiverId }, status: { in: ['QUEUED', 'ANSWER_READY'] } } })).toBe(
      0,
    )
    // «hola» was counted and never answered: its place comes back.
    expect(await capCounts()).toEqual([6, 6])
  })
  it('a registered phone never strikes', async () => {
    await send('hola', member)
    await deliver()
    await send('sí', member)
    await deliver()
    await send('1', member)
    await deliver()
    for (let i = 0; i < 3; i++) {
      await send('asdfgh', member)
      expect((await work([fixed('nonsense')])).message?.answer).toBe(SUPPORT_REPHRASE)
    }
    const control = `CONTROL:${receiverId}:${sha(member)}:`
    expect(await prisma.supportBudget.count({ where: { key: { in: [`${control}STRIKES`, `${control}PAUSE`] } } })).toBe(0)
  })
})

describe('capa 3: US$1 al día de IA entre todos los no registrados', () => {
  it('spent: a question gets the fixed message once a day, then silence; the conversation, the notice and «persona» go on', async () => {
    await ready()
    process.env.SUPPORT_PUBLIC_HELP_DAILY_USD = '0'
    expect((await send('¿Cómo cambio de sucursal?')).routed).toBe('QUEUED')
    const first = await work([question])
    expect(first.message).toMatchObject({ answer: SUPPORT_UNREGISTERED })
    expect(first.p.fetcher).not.toHaveBeenCalled()
    expect(await capCounts()).toEqual([4, 4])
    await send('¿Y en la terminal?')
    expect((await work([question])).message).toMatchObject({ status: 'CANCELLED' })
    // Cancelled in silence: it does not spend the 20 of the day.
    expect(await capCounts()).toEqual([4, 4])
    // The same conversation, with its notice accepted: «persona» still reaches the team.
    expect(await open()).toMatchObject({ noticeAcceptedAt: expect.any(Date) })
    const asked = await send('persona')
    expect(await reply(asked.event)).toMatchObject({ outcome: 'HANDOFF' })
    const registered = await send('hola', member)
    expect(await reply(registered.event)).toMatchObject({ answer: SUPPORT_NOTICE_FREE_TEXT })
  })
  it('each public call adds its observed cost to the day; a registered call does not', async () => {
    await ready()
    await send('¿Cómo cambio de sucursal?')
    await work([question, draft, supported])
    const day = await prisma.supportBudget.findUniqueOrThrow({ where: { key: publicDayKey(new Date()) } })
    const calls = await prisma.supportAttempt.findMany({ where: { message: { conversation: { receiverId } }, kind: 'AI' } })
    expect(calls).toHaveLength(3)
    expect(day.spentUsd.toString()).toBe(calls.reduce((sum, a) => sum.plus(a.actualUsd!), new Prisma.Decimal(0)).toString())
    expect(day.spentUsd.gt(0)).toBe(true)
    // Every call settled: nothing stays held; the month held only the public hold of each call, never the full reserve.
    expect(day.heldUsd.toString()).toBe('0')
    expect(calls.map(c => c.reservedUsd.toString())).toEqual(['0.0685', '0.0685', '0.0685'])
  })
  it('an uncertain public call keeps its hold on the day it started, also when it was reserved the day before', async () => {
    await ready()
    await send('¿Cómo cambio de sucursal?')
    const claim = (await claimNext(new Date(Date.now() + 10), receiverId))!
    const config = getSupportAiConfig()!
    // Reserved before midnight of yesterday (CDMX); it starts now.
    const before = new Date(publicDayStart(new Date()).getTime() - 1000)
    const attempt = (await reserveAiAttempt(claim, config, before, { call: 1, publicHelp: true }))!
    expect(await startAiAttempt(attempt.id, claim, new Date(), { requestBytes: 1000 })).toBe(true)
    await finishAiAttempt(attempt.id, null)
    const today = await prisma.supportBudget.findUniqueOrThrow({ where: { key: publicDayKey(new Date()) } })
    expect(today.heldUsd.toString()).toBe('0.0685')
    expect((await prisma.supportBudget.findUnique({ where: { key: publicDayKey(before) } }))?.heldUsd.toString()).toBe('0')
  })
  it('a public request bigger than its proven bound never starts', async () => {
    await ready()
    await send('¿Cómo cambio de sucursal?')
    const claim = (await claimNext(new Date(Date.now() + 10), receiverId))!
    const attempt = (await reserveAiAttempt(claim, getSupportAiConfig()!, new Date(), { call: 1, publicHelp: true }))!
    expect(await startAiAttempt(attempt.id, claim, new Date(), { requestBytes: pricing.longContextAfter + 1 })).toBe(false)
    expect(await startAiAttempt(attempt.id, claim, new Date())).toBe(false)
  })
  it('spent in the worker: a queued question gets the fixed message, without the model', async () => {
    await ready()
    await send('¿Cómo cambio de sucursal?')
    process.env.SUPPORT_PUBLIC_HELP_DAILY_USD = '0'
    const { p, message } = await work([question])
    expect(message).toMatchObject({ answer: SUPPORT_UNREGISTERED })
    expect(p.fetcher).not.toHaveBeenCalled()
  })
})

describe('«persona» from an unknown phone', () => {
  it('creates the notice and the email says it is a number with no account', async () => {
    await ready()
    const asked = await send('persona')
    expect(await reply(asked.event)).toMatchObject({ answer: supportHandoffDone('+52 56 4007 0001'), outcome: 'HANDOFF' })
    const [notice] = await prisma.supportNotice.findMany({ where: { conversationId: { in: await conversationIds() } } })
    expect(notice).toMatchObject({ status: 'PENDING', staffId: null, linkId: null, venueId: null })
    expect(notice.meta).toMatchObject({ unregistered: true, people: [] })
    const sent: { subject: string; text: string }[] = []
    const result = await runSupportNotices(new Date(Date.now() + 1000), {
      send: async options => {
        sent.push({ subject: options.subject, text: String(options.text) })
        return { ok: true, resendId: 're_1', transient: false }
      },
    })
    expect(result.sent).toBeGreaterThanOrEqual(1)
    const mine = sent.find(e => e.subject.startsWith('Soporte · Número no registrado'))
    expect(mine?.text).toContain('Persona: Numero no registrado')
    expect(mine?.text).toContain(`https://wa.me/${unknown.slice(1)}`)
  })
  it('the worker («human») hands off too', async () => {
    await ready()
    await send('quiero hablar con alguien')
    const { message } = await work([fixed('human')])
    expect(message).toMatchObject({ outcome: 'HANDOFF' })
    expect(await prisma.supportNotice.count({ where: { conversationId: { in: await conversationIds() } } })).toBe(1)
  })
})

describe('privacy order and the internal manual', () => {
  it('a voice note or PUBLICA as the first message get the notice too', async () => {
    const voice = await tryRouteSupport(input('', unknown, { type: 'audio' }))
    expect(voice).toBe('QUEUED')
    expect(
      await prisma.supportMessage.findFirstOrThrow({
        where: { conversation: { receiverId, phone: unknown } },
        orderBy: { sequence: 'desc' },
      }),
    ).toMatchObject({
      answer: supportPublicNotice(),
    })
    const publica = await send('PUBLICA')
    expect(await reply(publica.event)).toMatchObject({ answer: supportPublicNotice() })
  })
  it('CONTINUAR or «persona» as the first message never skip the notice', async () => {
    const go = await send('CONTINUAR')
    expect(await reply(go.event)).toMatchObject({ answer: supportPublicNotice() })
    expect(await open()).toMatchObject({ noticeAcceptedAt: null })
    const person = await send('persona')
    expect(await reply(person.event)).toMatchObject({ answer: supportPublicNotice() })
    expect(await prisma.supportNotice.count({ where: { conversationId: { in: await conversationIds() } } })).toBe(0)
  })
  it('a conversation used while the phone was of an account goes on in public, like PUBLICA today: the manual answers with its warning', async () => {
    await send('hola', member)
    await deliver()
    await send('sí', member)
    await deliver()
    await send('1', member)
    await deliver()
    const used = (await open(member))!
    await prisma.staff.update({ where: { id: staffId }, data: { active: false } })
    try {
      const asked = await send('¿Cómo cierro la caja?', member)
      expect((await reply(asked.event)).conversationId).toBe(used.id)
      const { message } = await work([{ kind: 'question', standalone: '¿Cómo cierro la caja?', guideIds: [manual.id] }, {}])
      expect(message?.sourceIds).toEqual([knowledge.sourceRef(manual)])
      expect(message?.answer).toContain('Ayuda pública: tus permisos y funciones pueden variar.')
    } finally {
      await prisma.staff.update({ where: { id: staffId }, data: { active: true } })
    }
  })
})

describe('«persona» and the caps of today', () => {
  it("with the day's US$ spent, «persona» after the notice still reaches the team", async () => {
    await ready()
    process.env.SUPPORT_PUBLIC_HELP_DAILY_USD = '0'
    const asked = await send('persona')
    expect(await reply(asked.event)).toMatchObject({ outcome: 'HANDOFF' })
  })
  it('unknown phones have their own daily pool: when it is full they wait, and a registered phone is not pushed out', async () => {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date())
    const key = `CONTROL:${receiverId}:HANDOFF_PUBLIC:${day}`
    await prisma.supportBudget.create({ data: { key, windowStart: new Date(), callCount: 20 } })
    await ready()
    const unknownAsked = await send('persona')
    expect(await reply(unknownAsked.event)).toMatchObject({ answer: supportHandoffAlready('+52 56 4007 0001') })
    await send('hola', member)
    await deliver()
    await send('sí', member)
    await deliver()
    const memberAsked = await send('persona', member)
    expect(await reply(memberAsked.event)).toMatchObject({ answer: supportHandoffDone('+52 56 4007 0001') })
    const notices = await prisma.supportNotice.findMany({
      where: { conversationId: { in: await conversationIds() } },
      orderBy: { createdAt: 'asc' },
    })
    expect(notices.map(n => n.status)).toEqual(['HELD', 'PENDING'])
  })
})

describe('round 2 of the audit', () => {
  it('a phone that registers during the third classification gets no pause, and nothing it queued is cancelled', async () => {
    await ready()
    for (let i = 0; i < 2; i++) {
      await send('asdfgh')
      await work([fixed('nonsense')])
    }
    await send('asdfgh')
    const other = await prisma.staff.create({
      data: { email: `${receiverId}-late@test.local`, firstName: 'Tarde', lastName: 'Prueba', emailVerified: true },
    })
    await prisma.staffVenue.create({ data: { staffId: other.id, venueId, role: 'VIEWER' } })
    try {
      const { message } = await work([fixed('nonsense')], async () => {
        await prisma.staff.update({ where: { id: other.id }, data: { phone: unknown } })
      })
      expect(message?.answer).toBe(SUPPORT_REPHRASE)
      expect(await prisma.supportBudget.count({ where: { key: `CONTROL:${receiverId}:${sha(unknown)}:PAUSE` } })).toBe(0)
    } finally {
      await prisma.staffVenue.deleteMany({ where: { staffId: other.id } })
      await prisma.staff.delete({ where: { id: other.id } })
    }
  })
  it('switched off: an answer public help prepared with the model does not go out, nor its email to the team', async () => {
    await ready()
    await send('¿Cómo cambio de sucursal?')
    const p = provider([question, draft, supported])
    const claim = (await claimNext(new Date(Date.now() + 10), receiverId))!
    expect(await prepareSupportAnswer(claim, { client: p.client, library })).toBe('READY')
    const asked = await send('persona')
    expect(await reply(asked.event)).toMatchObject({ outcome: 'HANDOFF' })
    process.env.SUPPORT_PUBLIC_HELP_ENABLED = 'false'
    const out = (await claimNext(new Date(Date.now() + 10), receiverId))!
    expect(out.messageId).toBe(claim.messageId)
    expect(await deliverSupportMessage(out, undefined, library)).toBe('CANCELLED')
    expect(await prisma.supportMessage.findUniqueOrThrow({ where: { id: claim.messageId } })).toMatchObject({ status: 'CANCELLED' })
    const sent: string[] = []
    await runSupportNotices(new Date(Date.now() + 1000), {
      send: async options => {
        sent.push(options.subject)
        return { ok: true, resendId: 're_2', transient: false }
      },
    })
    expect(sent.filter(subject => subject.includes('Número no registrado'))).toEqual([])
    const [notice] = await prisma.supportNotice.findMany({ where: { conversationId: { in: await conversationIds() } } })
    expect(notice).toMatchObject({ status: 'SKIPPED', errorCode: 'REVOKED' })
  })
  it('three public notices of a phone never hold its first one once it is registered', async () => {
    const day = cdmxDay(new Date())
    const phoneHash = sha(`${receiverId}:${member}`)
    // Today this phone already asked three times as a number with no account.
    await prisma.supportBudget.createMany({
      data: [
        { key: `CONTROL:${receiverId}:HANDOFF_PUBLIC:${day}`, windowStart: new Date(), callCount: 3 },
        { key: `CONTROL:${receiverId}:HANDOFF_PUBLIC:${day}:${phoneHash}`, windowStart: new Date(), callCount: 3 },
      ],
    })
    const ghost = await prisma.supportConversation.create({ data: { receiverId, phone: member, mode: 'CLOSED' } })
    await prisma.supportNotice.createMany({
      data: [1, 2, 3].map(n => ({
        kind: 'HANDOFF' as const,
        dedupeKey: `handoff:${ghost.id}:${n}`,
        day,
        conversationId: ghost.id,
        generation: n,
        phoneHash,
      })),
    })
    await send('hola', member)
    await deliver()
    await send('sí', member)
    await deliver()
    const asked = await send('persona', member)
    expect(await reply(asked.event)).toMatchObject({ answer: supportHandoffDone('+52 56 4007 0001') })
  })
  it('the daily digest puts registered notices first: 100 public ones never push one out', async () => {
    const conversation = await prisma.supportConversation.create({ data: { receiverId, phone: unknown, mode: 'CLOSED' } })
    const meta = (extra: object) => ({
      requestedAt: new Date(Date.now() - 86_400_000).toISOString(),
      reason: 'REQUESTED',
      phone: unknown,
      app: 'dashboard',
      appVersion: null,
      deviceFamily: null,
      multipleProfiles: false,
      people: [],
      guides: [],
      ...extra,
    })
    await prisma.supportNotice.createMany({
      data: Array.from({ length: 100 }, (_, n) => ({
        kind: 'HANDOFF' as const,
        status: 'HELD' as const,
        dedupeKey: `held:${receiverId}:public-${n}`,
        day: yesterday,
        conversationId: conversation.id,
        meta: meta({ unregistered: true }),
        createdAt: new Date(Date.now() - 86_400_000 + n),
      })),
    })
    const registered = await prisma.supportNotice.create({
      data: {
        kind: 'HANDOFF',
        status: 'HELD',
        dedupeKey: `held:${receiverId}:registered`,
        day: yesterday,
        conversationId: conversation.id,
        staffId,
        meta: meta({
          phone: member,
          people: [{ staffId, name: 'Registrada Prueba', role: 'VIEWER', venues: [{ id: venueId, name: 'Norte' }], organization: null }],
        }),
        createdAt: new Date(Date.now() - 1000),
      },
    })
    const sent: { subject: string; html: string }[] = []
    await runSupportNotices(new Date(), {
      send: async options => {
        sent.push({ subject: options.subject, html: String(options.html) })
        return { ok: true, resendId: 're_3', transient: false }
      },
    })
    expect(await prisma.supportNotice.findUniqueOrThrow({ where: { id: registered.id } })).toMatchObject({
      status: 'HELD',
      digestId: expect.any(String),
    })
    expect(
      await prisma.supportNotice.count({ where: { dedupeKey: { startsWith: `held:${receiverId}:public-` }, errorCode: 'DIGEST_FULL' } }),
    ).toBe(1)
  })
})

describe('exhaustive pass after round 2 of the audit', () => {
  it('a sensitive or too long first message gets the notice, and its text is kept out', async () => {
    const secret = await send('mi contraseña es 4321')
    expect(await reply(secret.event)).toMatchObject({ answer: supportPublicNotice(), body: '' })
    const long = await send(`¿Cómo cobro? ${'a'.repeat(2001)}`)
    expect(await reply(long.event)).toMatchObject({ answer: supportPublicNotice(), body: '' })
    // Nothing waits for the «sí»: neither text is kept as the pending question.
    expect((await open())?.selectionOptions ?? null).toBeNull()
  })
  it('with the day spent, a «sí» to the offer of a person still reaches the team (no model)', async () => {
    await ready()
    const offered = await admitSupportMessage(input('¿Cómo hago algo raro?'))
    await prisma.supportMessage.update({
      where: { id: offered.messageId },
      data: { status: 'SENT', answer: 'No encontré eso.', outcome: 'UNKNOWN', handoffOffered: true },
    })
    process.env.SUPPORT_PUBLIC_HELP_DAILY_USD = '0'
    await send('sí')
    const { p, message } = await work([])
    expect(p.fetcher).not.toHaveBeenCalled()
    expect(message).toMatchObject({ outcome: 'HANDOFF' })
  })
  it("switched off after a failed first attempt: the retry of an unknown phone's email does not go out", async () => {
    await ready()
    await send('persona')
    const fail = async () => ({ ok: false, transient: true, errorCode: 'SEND_ERROR' })
    await runSupportNotices(new Date(Date.now() + 1000), { send: fail })
    const [notice] = await prisma.supportNotice.findMany({ where: { conversationId: { in: await conversationIds() } } })
    expect(notice).toMatchObject({ status: 'PENDING', firstAttemptAt: expect.any(Date) })
    process.env.SUPPORT_PUBLIC_HELP_ENABLED = 'false'
    const sent: string[] = []
    await runSupportNotices(new Date(Date.now() + 120_000), {
      send: async options => {
        sent.push(options.subject)
        return { ok: true, resendId: 're_4', transient: false }
      },
    })
    expect(sent.filter(subject => subject.includes('Número no registrado'))).toEqual([])
    expect(await prisma.supportNotice.findUniqueOrThrow({ where: { id: notice.id } })).toMatchObject({ status: 'SKIPPED' })
  })
})
