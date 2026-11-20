import { SupportOutcome, type Prisma, type SupportAttemptState, type SupportMessageStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { aiInput } from '@tests/__helpers__/supportAiInput'
import { admitSupportMessage, claimNext } from '@/services/support/store.service'
import { prepareSupportAnswer, replaceWithPublicNotice } from '@/services/support/worker.service'
import * as hybrid from '@/services/support/hybrid.service'
import * as dataLog from '@/services/support/data/log'
import { openDataEnvelope } from '@/services/support/data/answer.service'
import { dataCatalog } from '@/services/support/data/catalog'
import { changeSupportGeneration, tryRouteSupport } from '@/services/support/router.service'
import { deliverSupportMessage, recordSupportDeliveryFailure } from '@/services/support/delivery.service'
import { buildHandoffEmail } from '@/services/support/noticeEmails'
import type { HandoffMeta } from '@/services/support/handoff.service'
import { SUPPORT_HANDOFF_OFFER, SUPPORT_HYBRID_UNKNOWN, SUPPORT_OTHER_QUESTION, SUPPORT_SEND_RETRY_NOTICE } from '@/services/support/texts'
import {
  SUPPORT_DATA_LINK_FIRST,
  SUPPORT_DATA_NEEDS_UNLOCK,
  SUPPORT_DATA_OFF,
  SUPPORT_DATA_RETRY,
  SUPPORT_DATA_STALE,
  supportDataHistoryMark,
  supportDataOutOfCatalog,
} from '@/services/support/data/texts'
import {
  FAKE_SUPPORT_AI_ENV as ENV,
  fakeCapability,
  fakeSupportAi as provider,
  fixtureGuide as products,
  seedDataFixture,
  type DataFixture,
  type FakeAiReply as Reply,
} from '@tests/__helpers__/supportData'

/**
 * Task 9 de la B: la rama `data` del worker. «Entender» (de mentira) contesta `kind: 'data'`; la capacidad es la de mentira de
 * tests/__helpers__/supportData.ts, que siempre lee 12,345.60. Nada sale a un proveedor ni a WhatsApp: los dos `fetch` son de mentira.
 */
const FIGURE = '$12,345.60'
const DIGITS = '12,345' // la cifra como la imprime la plantilla: nunca en claro fuera del sobre cifrado
const QUESTION = '¿entró un cobro de 850?'
const MARK = supportDataHistoryMark('dato de prueba')

const fake = { ...fakeCapability, read: jest.fn(fakeCapability.read) }
const dataCapabilities = dataCatalog(fake)
const library = [products]
// With the catalog, the strict schema asks every kind for `data`; outside kind data it is «none».
const none = { capability: 'none', day: 'none', amount: '', time: '', otherVenue: false }
const asData = {
  kind: 'data',
  standalone: '',
  guideIds: [],
  data: { capability: 'fake', day: 'today', amount: '850', time: '', otherVenue: false },
}
const unknown = { kind: 'unknown', standalone: '', guideIds: [], data: none }
const question = { kind: 'question', standalone: '¿Cómo creo un producto?', guideIds: [products.id], data: none }
const goodDraft = {
  covered: true,
  intro: null,
  steps: [
    { text: 'Toca nuevo producto.', guideId: products.id, quote: 'toca nuevo producto' },
    {
      text: 'Escribe el nombre y el precio, y guarda.',
      guideId: products.id,
      quote: 'Escribe el nombre y el precio, y guarda los cambios',
    },
  ],
}
const supported = { supported: true, missing: [] }

let f: DataFixture, receiverId: string, phone: string
const originalFetch = global.fetch
let meta: jest.Mock
beforeAll(async () => {
  f = await seedDataFixture('support-data-worker')
  ;({ receiverId, phone } = await f.conversation())
  Object.assign(process.env, ENV)
})
beforeEach(async () => {
  await f.reset()
  await prisma.supportBudget.deleteMany({
    where: { OR: [{ key: { startsWith: 'AI:' } }, { key: { startsWith: `CONTROL:${receiverId}:` } }] },
  })
  fake.read.mockReset()
  fake.read.mockImplementation(fakeCapability.read)
  // Meta (typing indicator, and the one delivery below) never leaves the test.
  meta = jest.fn(
    async () => new Response(JSON.stringify({ success: true, messages: [{ id: `wamid.${receiverId}-meta` }] }), { status: 200 }),
  )
  global.fetch = meta as unknown as typeof fetch
})
afterEach(async () => {
  global.fetch = originalFetch
  jest.restoreAllMocks()
  process.env.SUPPORT_DATA_ENABLED = 'true'
  delete process.env.SUPPORT_HANDOFF_EMAIL_TO
  await prisma.supportNotice.deleteMany({ where: { staffId: f.staffId } })
})
afterAll(async () => {
  if (!f) return
  await prisma.supportNotice.deleteMany({ where: { staffId: f.staffId } })
  await prisma.supportBudget.deleteMany({ where: { key: { startsWith: `CONTROL:${receiverId}:` } } })
  await f.clean()
  for (const key of Object.keys(ENV)) delete process.env[key]
})

let serial = 0
const input = (body: string, options: { wamid?: string; contextId?: string } = {}) => ({
  receiverId,
  phone,
  wamid: options.wamid ?? `wamid.${receiverId}-${++serial}`,
  type: 'text',
  body,
  timestamp: String(Math.floor(Date.now() / 1000)),
  ...(options.contextId ? { contextId: options.contextId } : {}),
})
/** The message joins the open personal conversation of the fixture (created first if it does not exist yet). */
async function enqueue(body = QUESTION, options: { wamid?: string; contextId?: string } = {}) {
  await f.conversation()
  const { messageId } = await admitSupportMessage(input(body, options))
  await prisma.supportConversation.updateMany({
    where: { receiverId, phone, mode: { not: 'CLOSED' } },
    data: { lastUserMessageAt: new Date(), lastActivityAt: new Date() },
  })
  return messageId
}
const claim = () => claimNext(new Date(Date.now() + 10), receiverId)
const saved = (id: string) => prisma.supportMessage.findUniqueOrThrow({ where: { id } })
async function prepare(replies: Reply[], onCall?: (n: number) => Promise<void>) {
  const p = provider(replies, onCall)
  const result = await prepareSupportAnswer((await claim())!, { client: p.client, library, dataCapabilities })
  return { p, result }
}
async function ask(replies: Reply[], body = QUESTION, options: { contextId?: string; onCall?: (n: number) => Promise<void> } = {}) {
  const id = await enqueue(body, { contextId: options.contextId })
  const { p, result } = await prepare(replies, options.onCall)
  return { id, p, result, message: await saved(id) }
}
const logged = () => prisma.supportDataQuery.findMany({ where: { staffId: f.staffId }, orderBy: { createdAt: 'asc' }, take: 50 })
const dataRows = () =>
  prisma.supportMessage.findMany({ where: { conversation: { receiverId }, purpose: 'DATA' }, orderBy: { createdAt: 'asc' }, take: 50 })
const events = (conversationId: string) => prisma.supportEvent.findMany({ where: { conversationId }, take: 50 })
let outbound = 0
/** What delivery leaves behind; with `send`, its SEND attempt too (the one REINTENTAR looks at). */
async function markSent(id: string, status: SupportMessageStatus = 'SENT', send?: SupportAttemptState) {
  const outboundWamid = status === 'SENT' ? `wamid.${receiverId}-out-${++outbound}` : null
  await prisma.supportMessage.update({
    where: { id },
    data: { status, outboundWamid, ...(status === 'CANCELLED' ? { answerCipher: null } : {}) },
  })
  if (send)
    await prisma.supportAttempt.create({
      data: {
        messageId: id,
        kind: 'SEND',
        ordinal: 1,
        claimToken: 'fixture',
        state: send,
        requestId: outboundWamid,
        pricingVersion: 'whatsapp-service-v1',
      },
    })
  return outboundWamid
}
/** Every body that left through a fake `fetch` (the model and Meta). */
const sentBodies = (...mocks: jest.Mock[]) =>
  mocks.flatMap(m => m.mock.calls.map(c => String((c[1] as { body?: unknown } | undefined)?.body)))

describe('a data question', () => {
  it('a data question: one DATA message (answer null, a cipher that opens to the text, dataCapability «fake»), one ANSWERED log row and one SupportEvent, in one transaction; one model call', async () => {
    await f.unlock()
    const { id, p, result, message } = await ask([asData])
    expect(result).toBe('READY')
    expect(message).toMatchObject({
      status: 'ANSWER_READY',
      purpose: 'DATA',
      answer: null,
      dataCapability: 'fake',
      sourceIds: [],
      outcome: 'ANSWERED',
      handoffOffered: false,
      accessFingerprint: expect.any(String),
    })
    expect(openDataEnvelope(message.answerCipher)?.text).toMatch(/^Dato de prueba en Norte \(corte \d{2}:\d{2}\): \$12,345\.60 en Mesa 12$/)
    expect(await logged()).toEqual([expect.objectContaining({ capability: 'fake', result: 'ANSWERED', venueId: f.northId })])
    expect(await events(message.conversationId)).toEqual([expect.objectContaining({ kind: 'ANSWERED', sequence: message.sequence })])
    // Neither the drafter nor the judge: understand only.
    expect(p.fetcher).toHaveBeenCalledTimes(1)
    expect(fake.read).toHaveBeenCalledTimes(1)
    expect(id).toBe(message.id)
  })

  it('the log row is written in the transaction that saves the answer: when it fails, nothing is saved', async () => {
    await f.unlock()
    jest.spyOn(dataLog, 'recordSupportDataQuery').mockRejectedValue(new Error('fixture: the log write failed'))
    const id = await enqueue()
    await expect(prepare([asData])).rejects.toThrow('fixture: the log write failed')
    expect(await saved(id)).toMatchObject({ status: 'CLAIMED', purpose: 'HELP', answer: null, answerCipher: null, outcome: null })
    expect(await events((await saved(id)).conversationId)).toEqual([])
    expect(await logged()).toEqual([])
  })

  it('a data understanding with B on never calls hybridFixedReply', async () => {
    await f.unlock()
    const fixedReply = jest.spyOn(hybrid, 'hybridFixedReply')
    const { result } = await ask([asData])
    expect(result).toBe('READY')
    expect(fixedReply).not.toHaveBeenCalled()
  })

  it('B off never produces data: the catalog is not sent and a data-shaped reply is today’s «no sé»', async () => {
    await f.unlock()
    process.env.SUPPORT_DATA_ENABLED = 'false'
    const { p, message } = await ask([asData])
    const body = JSON.parse(p.bodies[0])
    expect(aiInput(body.input)).not.toHaveProperty('catalog')
    expect(body.instructions).toBe(hybrid.UNDERSTAND_INSTRUCTIONS)
    // T-F14: phase 1 asks for otherQuestion too; still no `data`.
    expect(Object.keys(body.text.format.schema.properties)).toEqual(['kind', 'standalone', 'guideIds', 'otherQuestion'])
    expect(message).toMatchObject({ purpose: 'HELP', answer: SUPPORT_HYBRID_UNKNOWN, dataCapability: null })
    expect(fake.read).not.toHaveBeenCalled()
    expect(await dataRows()).toEqual([])
    expect(await logged()).toEqual([])
  })

  it('the same wamid twice → one DATA row and one log row; two different wamids → two of each with the same figure', async () => {
    await f.unlock()
    const wamid = `wamid.${receiverId}-twice`
    const first = await enqueue(QUESTION, { wamid })
    expect(await enqueue(QUESTION, { wamid })).toBe(first)
    await prepare([asData])
    expect(await prisma.supportMessage.count({ where: { conversation: { receiverId } } })).toBe(1)
    expect(await dataRows()).toHaveLength(1)
    expect(await logged()).toHaveLength(1)

    await f.reset()
    await f.unlock()
    const a = await ask([asData])
    await markSent(a.id)
    await ask([asData])
    const rows = await dataRows()
    expect(rows).toHaveLength(2)
    expect(rows.map(r => openDataEnvelope(r.answerCipher)?.text)).toEqual([
      expect.stringContaining(FIGURE),
      expect.stringContaining(FIGURE),
    ])
    const two = await logged()
    expect(two.map(r => r.result)).toEqual(['ANSWERED', 'ANSWERED'])
    expect(two[1].paramsHmac).toBe(two[0].paramsHmac)
  })

  it('a claim lost between the read and the save leaves no log row; the next run leaves exactly one', async () => {
    await f.unlock()
    const id = await enqueue()
    fake.read.mockImplementationOnce(async (...args) => {
      // Lost while reading: the message is cancelled before the read returns.
      await prisma.supportMessage.update({ where: { id }, data: { status: 'CANCELLED', claimToken: null, leaseUntil: null } })
      return fakeCapability.read(...args)
    })
    expect((await prepare([asData])).result).toBe('CANCELLED')
    expect(await saved(id)).toMatchObject({ status: 'CANCELLED', purpose: 'HELP', answerCipher: null })
    expect(await logged()).toEqual([])
    expect(await dataRows()).toEqual([])
    const next = await ask([asData])
    expect(next.result).toBe('READY')
    expect(await logged()).toEqual([expect.objectContaining({ result: 'ANSWERED' })])
  })

  it('cancelling before the send and a late delivery failure from Meta do not change the log row', async () => {
    await f.unlock()
    const cancelled = await ask([asData])
    const rows = await logged()
    expect(rows).toHaveLength(1)
    await prisma.$transaction(async tx =>
      changeSupportGeneration(tx, await tx.supportConversation.findUniqueOrThrow({ where: { id: cancelled.message.conversationId } })),
    )
    expect(await saved(cancelled.id)).toMatchObject({ status: 'CANCELLED', answerCipher: null })
    expect(await logged()).toEqual(rows)

    const delivered = await ask([asData])
    const wamid = await markSent(delivered.id, 'SENT', 'SUCCEEDED')
    const both = await logged()
    expect(both).toHaveLength(2)
    expect(await recordSupportDeliveryFailure(wamid!, receiverId)).toBe(true)
    expect(await saved(delivered.id)).toMatchObject({ status: 'FAILED' })
    expect(await logged()).toEqual(both)
  })
})

describe('REINTENTAR after a data answer', () => {
  it.each<[string, SupportMessageStatus, SupportAttemptState]>([
    ['delivered normally (its SEND SUCCEEDED)', 'SENT', 'SUCCEEDED'],
    ['with an uncertain send (SEND UNKNOWN)', 'SEND_UNKNOWN', 'UNKNOWN'],
    ['cancelled at the second checkpoint', 'CANCELLED', 'DEFINITIVE_FAILURE'],
  ])('REINTENTAR right after a DATA answer %s → SUPPORT_DATA_RETRY', async (_label, status, send) => {
    await f.unlock()
    const data = await ask([asData])
    await markSent(data.id, status, send)
    const retry = await ask([asData], 'REINTENTAR')
    expect(retry.message).toMatchObject({ answer: SUPPORT_DATA_RETRY, retryOfId: null, purpose: 'HELP', dataCapability: null })
    expect(retry.p.fetcher).not.toHaveBeenCalled()
    expect(fake.read).toHaveBeenCalledTimes(1)
    expect(await logged()).toHaveLength(1)
    expect(await prisma.supportMessage.count({ where: { retryOfId: data.id } })).toBe(0)
    // Its delivery carries the fixed text and no figure.
    expect(await deliverSupportMessage((await claim())!, [], library)).toBe('SENT')
    const out = sentBodies(meta, retry.p.fetcher)
    expect(out.some(b => b.includes(SUPPORT_DATA_RETRY))).toBe(true)
    expect(out.filter(b => b.includes(DIGITS))).toEqual([])
  })

  it('an older guide answer with an uncertain send, then a DATA answer delivered, then REINTENTAR → SUPPORT_DATA_RETRY and the guide is not resent; a second REINTENTAR resends the guide as today', async () => {
    await f.unlock()
    const guide = await ask([question, goodDraft, supported], '¿Cómo creo un producto?')
    expect(guide.message.sourceIds).toEqual([`${products.id}@${products.hash.slice(0, 8)}`])
    await markSent(guide.id, 'SEND_UNKNOWN', 'UNKNOWN')
    const data = await ask([asData])
    await markSent(data.id, 'SENT', 'SUCCEEDED')
    const first = await ask([], 'REINTENTAR')
    expect(first.message).toMatchObject({ answer: SUPPORT_DATA_RETRY, retryOfId: null })
    await markSent(first.id)
    const second = await ask([], 'REINTENTAR')
    expect(second.message.retryOfId).toBe(guide.id)
    expect(second.message.answer).toContain(guide.message.answer!)
    expect(second.p.fetcher).not.toHaveBeenCalled()
    expect(fake.read).toHaveBeenCalledTimes(1)
  })

  it('a DATA answer with an uncertain send, then a guide answer delivered, then REINTENTAR → today’s «No hay otra consulta incierta…»: the retry lookup never returns a DATA row', async () => {
    await f.unlock()
    const data = await ask([asData])
    await markSent(data.id, 'SEND_UNKNOWN', 'UNKNOWN')
    const guide = await ask([question, goodDraft, supported], '¿Cómo creo un producto?')
    await markSent(guide.id, 'SENT', 'SUCCEEDED')
    const retry = await ask([], 'REINTENTAR')
    expect(retry.message.answer).toMatch(/^No hay otra consulta incierta que pueda repetir\./)
    expect(retry.message.retryOfId).toBeNull()
    const dataIds = (await dataRows()).map(r => r.id)
    expect(await prisma.supportMessage.count({ where: { retryOfId: { in: dataIds } } })).toBe(0)
    expect(fake.read).toHaveBeenCalledTimes(1)
  })

  it('RECUPERAR never brings back a DATA answer', async () => {
    await f.unlock()
    const data = await ask([asData])
    await markSent(data.id, 'SENT', 'SUCCEEDED')
    const closed = await prisma.supportConversation.update({ where: { id: data.message.conversationId }, data: { mode: 'CLOSED' } })
    const { linkId, staffId, orgId, venueId, app, noticeAcceptedAt } = closed
    await prisma.supportConversation.create({
      data: {
        receiverId,
        phone,
        mode: 'PERSONAL',
        linkId,
        staffId,
        orgId,
        venueId,
        app,
        noticeAcceptedAt,
        lastUserMessageAt: new Date(),
        lastActivityAt: new Date(),
      },
    })
    const id = (await admitSupportMessage(input('RECUPERAR'))).messageId
    const { p } = await prepare([])
    expect((await saved(id)).answer).toMatch(/^No encontré una guía guardada vigente para esa app\./)
    expect(p.fetcher).not.toHaveBeenCalled()
    expect(fake.read).toHaveBeenCalledTimes(1)
  })
})

describe('nothing on WhatsApp authorizes anything (case 4)', () => {
  it('«sí», «acepto» and «mi código es 482913» create and change no acceptance and no unlock', async () => {
    await f.accept() // accepted yesterday, not unlocked today
    const rows = async () => ({
      acceptances: await prisma.supportDataAcceptance.findMany({ where: { staffId: f.staffId }, take: 5 }),
      unlocks: await prisma.supportDataUnlock.findMany({ where: { staffId: f.staffId }, orderBy: { id: 'asc' }, take: 5 }),
    })
    const before = await rows()
    expect(before.acceptances).toHaveLength(1)
    expect(before.unlocks).toHaveLength(1)
    await f.conversation()
    for (const body of ['sí', 'acepto', 'mi código es 482913']) {
      const event = input(body)
      await tryRouteSupport(event)
      const reply = await prisma.supportMessage.findFirst({ where: { inboundEvent: { wamid: event.wamid } } })
      if (!reply) continue
      const queued = await claim()
      // The classifier even says «data»: still nothing is written but a «no puedo».
      if (queued && !reply.answer) await prepareSupportAnswer(queued, { client: provider([asData]).client, library, dataCapabilities })
      await markSent(reply.id)
    }
    expect(await rows()).toEqual(before)
    expect(fake.read).not.toHaveBeenCalled()
  })
})

describe('handing over to a person from a refusal (case 31)', () => {
  it('a refusal carries the offer when the conversation may hand off; «sí» hands off with reason DATA and «dato de prueba»; the notice meta and the email have no digit of the amount asked', async () => {
    process.env.SUPPORT_HANDOFF_EMAIL_TO = 'soporte@test.local'
    // Only fixed names: the seeded organization carries a timestamp, whose digits could be the amount by chance.
    await prisma.organization.update({ where: { id: f.orgId }, data: { name: 'Negocio de prueba' } })
    const refusal = await ask([asData]) // without the day's unlock
    expect(refusal.message).toMatchObject({
      purpose: 'HELP',
      answer: `${SUPPORT_DATA_NEEDS_UNLOCK}\n\n${SUPPORT_HANDOFF_OFFER}`,
      outcome: 'FIXED',
      handoffOffered: true,
      dataCapability: 'fake',
      accessFingerprint: expect.any(String),
    })
    expect(await logged()).toEqual([expect.objectContaining({ result: 'NEEDS_UNLOCK' })])
    await markSent(refusal.id)
    const yes = await ask([], 'sí')
    expect(yes.p.fetcher).not.toHaveBeenCalled()
    expect(yes.message.outcome).toBe('HANDOFF')
    const notice = await prisma.supportNotice.findFirstOrThrow({ where: { conversationId: refusal.message.conversationId } })
    expect(notice.reason).toBe('DATA')
    const handoff = notice.meta as unknown as HandoffMeta
    expect(handoff).toMatchObject({ reason: 'DATA', dataCapability: 'dato de prueba' })
    // Every field but the ids, the hour and the phone (their digits are not the amount, and could match it by chance).
    const shown = JSON.stringify(handoff, (key, value) => (['requestedAt', 'phone', 'staffId', 'id'].includes(key) ? undefined : value))
    expect(shown).toContain('dato de prueba')
    expect(shown).not.toContain('850')
    const { html, text } = buildHandoffEmail(handoff, 'soporte@test.local')
    const digits = phone.replace(/\D/g, '')
    for (const page of [html, text]) expect(page.split(digits).join('')).not.toContain('850')
    expect(text).toContain('Dato que intento: dato de prueba')
  })

  const handoffNotice = async (conversationId: string) => {
    const notice = await prisma.supportNotice.findFirstOrThrow({ where: { conversationId } })
    return { reason: notice.reason, meta: notice.meta as unknown as HandoffMeta }
  }

  it('a refusal out of the catalog (no capability) → «sí» hands off with reason DATA, and the email says «otro dato»', async () => {
    process.env.SUPPORT_HANDOFF_EMAIL_TO = 'soporte@test.local'
    await f.unlock()
    const other = { ...asData, data: { ...asData.data, capability: 'other' } }
    const refusal = await ask([other], '¿cuántas propinas hubo hoy?')
    expect(refusal.message).toMatchObject({
      purpose: 'HELP',
      answer: `${supportDataOutOfCatalog(['dato de prueba'])}\n\n${SUPPORT_HANDOFF_OFFER}`,
      handoffOffered: true,
      dataCapability: null,
    })
    await markSent(refusal.id)
    const yes = await ask([], 'sí')
    expect(yes.p.fetcher).not.toHaveBeenCalled()
    expect(yes.message.outcome).toBe('HANDOFF')
    const { reason, meta: handoff } = await handoffNotice(refusal.message.conversationId)
    expect({ reason, metaReason: handoff.reason, dataCapability: handoff.dataCapability ?? null }).toEqual({
      reason: 'DATA',
      metaReason: 'DATA',
      dataCapability: null,
    })
    const { html, text } = buildHandoffEmail(handoff, 'soporte@test.local')
    expect(text).toContain('Dato que intento: otro dato')
    expect(text).toContain('no pudo consultar un dato y acepto')
    expect(html).not.toContain('no encontr')
  })

  it('a refusal with its capability, resent once by REINTENTAR → the resend keeps the capability, and «sí» hands off with reason DATA and its label', async () => {
    process.env.SUPPORT_HANDOFF_EMAIL_TO = 'soporte@test.local'
    const refusal = await ask([asData]) // without the day's unlock
    expect(refusal.message).toMatchObject({ handoffOffered: true, dataCapability: 'fake', outcome: 'FIXED' })
    await markSent(refusal.id, 'SEND_UNKNOWN', 'UNKNOWN')
    const retry = await ask([], 'REINTENTAR')
    expect(retry.p.fetcher).not.toHaveBeenCalled()
    expect(retry.message).toMatchObject({
      retryOfId: refusal.id,
      answer: `${SUPPORT_SEND_RETRY_NOTICE}\n\n${refusal.message.answer}`,
      handoffOffered: true,
      outcome: 'FIXED',
      dataCapability: 'fake',
    })
    await markSent(retry.id)
    const yes = await ask([], 'sí')
    expect(yes.p.fetcher).not.toHaveBeenCalled()
    expect(yes.message.outcome).toBe('HANDOFF')
    const { reason, meta: handoff } = await handoffNotice(refusal.message.conversationId)
    expect({ reason, metaReason: handoff.reason, dataCapability: handoff.dataCapability }).toEqual({
      reason: 'DATA',
      metaReason: 'DATA',
      dataCapability: 'dato de prueba',
    })
  })
})

describe('the context the answer is prepared in', () => {
  it('a phone saved on two profiles: public help, read never called, no DATA row', async () => {
    await f.unlock()
    const twin = await prisma.staff.create({
      data: { email: `twin-${receiverId}@test.local`, firstName: 'Gemela', lastName: 'Prueba', phone, emailVerified: true },
    })
    await prisma.staffVenue.create({ data: { staffId: twin.id, venueId: f.siblingId, role: 'MANAGER' } })
    try {
      const { result, p, message } = await ask([asData])
      expect(result).toBe('CANCELLED')
      expect(message.answer).toMatch(/^Tu acceso cambió/)
      expect(p.fetcher).not.toHaveBeenCalled()
      expect(fake.read).not.toHaveBeenCalled()
      expect(await dataRows()).toEqual([])
      expect(await logged()).toEqual([])
    } finally {
      await prisma.staffVenue.deleteMany({ where: { staffId: twin.id } })
      await prisma.staff.delete({ where: { id: twin.id } })
    }
  })

  it.each<[string, Prisma.SupportConversationUncheckedUpdateInput]>([
    ['a public conversation', { mode: 'PUBLIC', staffId: null, linkId: null, orgId: null, venueId: null }],
    ['a personal conversation still choosing its venue', { orgId: null, venueId: null, pendingSelection: 'VENUE' }],
  ])('%s asking for data → SUPPORT_DATA_LINK_FIRST: no DATA row, no log row, nothing read', async (_name, data) => {
    await f.unlock()
    await prisma.supportConversation.update({ where: { id: (await f.conversation()).id }, data })
    const { result, message } = await ask([asData])
    expect(result).toBe('READY')
    expect(message).toMatchObject({
      purpose: 'HELP',
      answer: SUPPORT_DATA_LINK_FIRST,
      answerCipher: null,
      dataCapability: null,
      outcome: 'FIXED',
    })
    expect(await dataRows()).toEqual([])
    expect(await logged()).toEqual([])
    expect(fake.read).not.toHaveBeenCalled()
  })

  it('the history sent to the model carries the marker, never the answer', async () => {
    await f.unlock()
    const data = await ask([asData])
    await markSent(data.id)
    const { p } = await ask([unknown], '¿y la propina?')
    expect(p.inputs()[0].history).toEqual([
      { role: 'user', text: QUESTION },
      { role: 'assistant', text: MARK },
    ])
    expect(p.bodies.join('\n')).not.toContain(DIGITS)
  })

  it('a reply quoting a DATA answer sends no figure to the model', async () => {
    await f.unlock()
    const data = await ask([asData])
    const wamid = await markSent(data.id)
    const { p } = await ask([unknown], '¿y eso?', { contextId: wamid! })
    expect(p.inputs()[0]).not.toHaveProperty('replyingTo')
    expect(p.bodies.join('\n')).toContain(MARK)
    expect(p.bodies.join('\n')).not.toContain(DIGITS)
  })

  it('access changed between understanding and saving → today’s public notice and no DATA row', async () => {
    await f.unlock()
    const { result, message } = await ask([asData], QUESTION, {
      onCall: () => f.grant({ permissions: ['reports:read'], features: ['RESERVATIONS'] }),
    })
    expect(result).toBe('CANCELLED')
    expect(message).toMatchObject({ purpose: 'HELP', answer: expect.stringMatching(/^Tu acceso cambió/), answerCipher: null })
    expect(await dataRows()).toEqual([])
    expect(await logged()).toEqual([])
    expect(fake.read).not.toHaveBeenCalled()
  })

  it('the person loses the venue (StaffVenue.active = false, MEMBER membership still active) between understanding and saving → the same public notice, no DATA row, no log row, read never called', async () => {
    await f.unlock()
    const { result, message } = await ask([asData], QUESTION, {
      onCall: async () => {
        await prisma.staffVenue.updateMany({ where: { staffId: f.staffId, venueId: f.northId }, data: { active: false } })
      },
    })
    expect(result).toBe('CANCELLED')
    expect(message.answer).toMatch(/^Tu acceso cambió/)
    expect(await dataRows()).toEqual([])
    expect(await logged()).toEqual([])
    expect(fake.read).not.toHaveBeenCalled()
  })

  it('a public notice that replaces a DATA message leaves purpose HELP, no cipher and no dataCapability', async () => {
    await f.unlock()
    const { id, message } = await ask([asData])
    expect(message).toMatchObject({ purpose: 'DATA', answer: null, answerCipher: expect.any(String), dataCapability: 'fake' })
    const ready = await claim()
    expect(ready?.messageId).toBe(id)
    await replaceWithPublicNotice(ready!)
    expect(await saved(id)).toMatchObject({
      purpose: 'HELP',
      answerCipher: null,
      dataCapability: null,
      status: 'ANSWER_READY',
      answer: expect.stringMatching(/^Tu acceso cambió/),
    })
  })

  it.each<[string, boolean]>([
    ['an answered DATA message', true],
    ['a refusal that carries the offer of a person', false],
  ])(
    'the public notice that replaces %s offers no person and answers nothing: handoffOffered false, outcome FIXED',
    async (_name, unlocked) => {
      process.env.SUPPORT_HANDOFF_EMAIL_TO = 'soporte@test.local'
      if (unlocked) await f.unlock()
      const { id, message } = await ask([asData])
      expect(message).toMatchObject(unlocked ? { outcome: 'ANSWERED' } : { outcome: 'FIXED', handoffOffered: true })
      await replaceWithPublicNotice((await claim())!)
      expect(await saved(id)).toMatchObject({
        answer: expect.stringMatching(/^Tu acceso cambió/),
        handoffOffered: false,
        outcome: 'FIXED',
      })
    },
  )
})

describe('what is offered and how it is marked (case 51)', () => {
  it('the offer of a person is only in the refusals the worker writes: SUPPORT_DATA_STALE, SUPPORT_DATA_OFF from delivery and SUPPORT_DATA_RETRY never carry it', async () => {
    process.env.SUPPORT_HANDOFF_EMAIL_TO = 'soporte@test.local'
    for (const text of [SUPPORT_DATA_STALE, SUPPORT_DATA_OFF, SUPPORT_DATA_RETRY]) expect(text).not.toContain(SUPPORT_HANDOFF_OFFER)
    const refusal = await ask([asData])
    expect(refusal.message).toMatchObject({ handoffOffered: true, answer: expect.stringContaining(SUPPORT_HANDOFF_OFFER) })
    await markSent(refusal.id)
    await f.unlock()
    const data = await ask([asData])
    expect(data.message).toMatchObject({ purpose: 'DATA', handoffOffered: false })
    await markSent(data.id, 'SENT', 'SUCCEEDED')
    const retry = await ask([], 'REINTENTAR')
    expect(retry.message).toMatchObject({ answer: SUPPORT_DATA_RETRY, handoffOffered: false })
  })

  it('a data answer is marked ANSWERED and a refusal FIXED: no new outcome value', async () => {
    const refusal = await ask([asData])
    expect(refusal.message).toMatchObject({ outcome: 'FIXED', purpose: 'HELP', dataCapability: 'fake' })
    await markSent(refusal.id)
    await f.unlock()
    const data = await ask([asData])
    expect(data.message).toMatchObject({ outcome: 'ANSWERED', purpose: 'DATA' })
    expect((await events(data.message.conversationId)).map(e => e.kind).sort()).toEqual(['ANSWERED', 'FIXED'])
    expect(Object.values(SupportOutcome)).toEqual([
      'ANSWERED',
      'LITERAL',
      'JUDGE_LITERAL',
      'UNKNOWN',
      'CLARIFIED',
      'FIXED',
      'ASKED',
      'OLD_VERSION',
      'HANDOFF',
    ])
  })
})

// T-F14 (H-T15-1, the founder's own message): «¿quién abrió la caja hoy y cómo agrego un producto?». La B answers the data and the
// line goes after the sealed figures, inside the same envelope: the figures, the log row and the delivery stay as they were.
describe('T-F14: a data question that brings another one', () => {
  const marked = { ...asData, otherQuestion: true }
  it('the sealed text is the same figures plus the line; one ANSWERED log row; delivery sends exactly that', async () => {
    await f.unlock()
    const { message, p } = await ask([marked])
    expect(message).toMatchObject({ status: 'ANSWER_READY', purpose: 'DATA', answer: null, dataCapability: 'fake', outcome: 'ANSWERED' })
    const sealed = openDataEnvelope(message.answerCipher)!
    expect(sealed.text).toMatch(/^Dato de prueba en Norte \(corte \d{2}:\d{2}\): \$12,345\.60 en Mesa 12\n\n/)
    expect(sealed.text.endsWith(`\n\n${SUPPORT_OTHER_QUESTION}`)).toBe(true)
    expect(sealed.text.split(FIGURE)).toHaveLength(2)
    expect(await logged()).toEqual([expect.objectContaining({ capability: 'fake', result: 'ANSWERED', venueId: f.northId })])
    expect(await events(message.conversationId)).toEqual([expect.objectContaining({ kind: 'ANSWERED', sequence: message.sequence })])
    expect(p.fetcher).toHaveBeenCalledTimes(1)
    expect(fake.read).toHaveBeenCalledTimes(1)
    meta.mockClear()
    expect(await deliverSupportMessage((await claim())!, [], library, dataCapabilities)).toBe('SENT')
    const sent = meta.mock.calls.map(c => JSON.parse(String((c[1] as { body?: unknown }).body))).filter(b => b.type === 'text')
    expect(sent.map(b => b.text.body)).toEqual([sealed.text])
  })
  it('a refusal ends with the line too, and still logs its result', async () => {
    const { message } = await ask([marked]) // without the day's unlock
    expect(message).toMatchObject({
      purpose: 'HELP',
      answer: `${SUPPORT_DATA_NEEDS_UNLOCK}\n\n${SUPPORT_OTHER_QUESTION}`,
      outcome: 'FIXED',
      dataCapability: 'fake',
    })
    expect(await logged()).toEqual([expect.objectContaining({ result: 'NEEDS_UNLOCK' })])
  })
  it('without the mark the sealed text has no line', async () => {
    await f.unlock()
    const { message } = await ask([asData])
    expect(openDataEnvelope(message.answerCipher)?.text).not.toContain(SUPPORT_OTHER_QUESTION)
  })
})
