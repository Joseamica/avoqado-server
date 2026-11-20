import crypto from 'crypto'
import type { Prisma, SupportConversation } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { LUNA_SUPPORT_PRICING as pricing, getSupportAiConfig } from '@/config/supportWhatsapp'
import { admitSupportMessage, claimNext } from '@/services/support/store.service'
import { prepareSupportAnswer } from '@/services/support/worker.service'
import { createSupportAiClient } from '@/services/support/answer.service'
import * as dataAnswer from '@/services/support/data/answer.service'
import { dataCatalog } from '@/services/support/data/catalog'
import * as router from '@/services/support/router.service'
import { deliverSupportMessage } from '@/services/support/delivery.service'
import type { LibraryGuide } from '@/services/support/knowledge.service'
import {
  SUPPORT_DATA_NEEDS_UNLOCK,
  SUPPORT_DATA_NOTICE,
  SUPPORT_DATA_OFF,
  SUPPORT_DATA_RETRY,
  SUPPORT_DATA_STALE,
} from '@/services/support/data/texts'
import * as venueDateKeys from '@/utils/venueDateKeys'
import { changeSupportDataNotice, fakeCapability, seedDataFixture, type DataFixture } from '@tests/__helpers__/supportData'

/**
 * Task 10 de la B: la entrega de una respuesta de datos. El worker la prepara con la capacidad de mentira (que siempre lee 12,345.60);
 * antes de mandarla, la entrega la revisa dos veces con checkDataDelivery. Nada sale a un proveedor ni a WhatsApp: «Entender» y Meta
 * son `fetch` de mentira. «Nunca sale» = ningún cuerpo mandado a Meta trae la cifra.
 */
const FIGURE = '$12,345.60'
const DIGITS = '12,345'
const QUESTION = '¿entró un cobro de 850?'
const NOTICE = 'Tu acceso cambió o esta selección ya no está vigente.'
const DAY_MS = 86_400_000

const dataCapabilities = dataCatalog(fakeCapability)
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
  body: 'Para crear un producto abre el menú del panel y toca nuevo producto. Escribe el nombre y el precio, y guarda los cambios.',
  general: false,
  internal: false,
  hash: '',
}
products.hash = hash(`${products.id}\n${products.body}`)
const library = [products]
const asData = {
  kind: 'data',
  standalone: '',
  guideIds: [],
  data: { capability: 'fake', day: 'today', amount: '850', time: '', otherVenue: false },
}

/** «Entender» de mentira: contesta `kind: 'data'` a la única llamada. */
function understanding() {
  const fetcher = jest.fn(
    async () =>
      new Response(
        JSON.stringify({
          id: 'resp_1',
          status: 'completed',
          usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
          output: [
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(asData), annotations: [] }] },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  )
  return createSupportAiClient(getSupportAiConfig()!, fetcher as unknown as typeof fetch)
}

let f: DataFixture, receiverId: string, phone: string
/** Meta: lo único que puede salir a WhatsApp (y el «escribiendo…» del worker, que no lleva texto). */
let send: jest.Mock
const originalFetch = global.fetch
/** El reloj que ve checkDataDelivery: «los 10 minutos se acabaron» lo adelanta. */
let shift = 0
/** El cambio que se mete justo después de la PRIMERA revisión (Caso 50: entre las dos revisiones). */
let between: (() => Promise<unknown>) | null = null
const realCheck = dataAnswer.checkDataDelivery
const ENV: Record<string, string> = {
  SUPPORT_AI_ENABLED: 'true',
  SUPPORT_AI_MODEL: pricing.model,
  SUPPORT_AI_PRICING_VERSION: pricing.version,
  SUPPORT_AI_MONTHLY_USD_LIMIT: '10',
  SUPPORT_OPENAI_API_KEY: 'fixture-never-used',
  WHATSAPP_ACCESS_TOKEN: 'fixture-never-used',
}
beforeAll(async () => {
  f = await seedDataFixture('support-data-delivery')
  ;({ receiverId, phone } = await f.conversation())
  Object.assign(process.env, ENV)
})
beforeEach(async () => {
  await f.reset()
  await prisma.supportBudget.deleteMany({
    where: { OR: [{ key: { startsWith: 'AI:' } }, { key: { startsWith: `CONTROL:${receiverId}:` } }] },
  })
  shift = 0
  between = null
  jest
    .spyOn(dataAnswer, 'checkDataDelivery')
    .mockImplementation(async (conversation, savedAccessFingerprint, envelope, now = new Date(), capabilities) => {
      const verdict = await realCheck(conversation, savedAccessFingerprint, envelope, new Date(now.getTime() + shift), capabilities)
      const change = between
      between = null
      await change?.()
      return verdict
    })
  send = jest.fn(async () => new Response(JSON.stringify({ messages: [{ id: `wamid.${receiverId}-out-${++serial}` }] }), { status: 200 }))
  global.fetch = send as unknown as typeof fetch
})
afterEach(() => {
  global.fetch = originalFetch
  jest.restoreAllMocks()
  process.env.SUPPORT_DATA_ENABLED = 'true'
})
afterAll(async () => {
  if (!f) return
  await prisma.supportBudget.deleteMany({ where: { key: { startsWith: `CONTROL:${receiverId}:` } } })
  await f.clean()
  for (const key of Object.keys(ENV)) delete process.env[key]
})

let serial = 0
const input = (body: string) => ({
  receiverId,
  phone,
  wamid: `wamid.${receiverId}-${++serial}`,
  type: 'text',
  body,
  timestamp: String(Math.floor(Date.now() / 1000)),
})
/** The message joins the open conversation of the fixture (its personal one in Norte is created first if it does not exist). */
async function enqueue(body = QUESTION) {
  await f.conversation()
  const { messageId } = await admitSupportMessage(input(body))
  await prisma.supportConversation.updateMany({
    where: { receiverId, phone, mode: { not: 'CLOSED' } },
    data: { lastUserMessageAt: new Date(), lastActivityAt: new Date() },
  })
  return messageId
}
const claim = () => claimNext(new Date(Date.now() + 10), receiverId)
const saved = (id: string) => prisma.supportMessage.findUniqueOrThrow({ where: { id }, include: { attempts: true } })
/** The SEND attempt of a message (the AI attempt of «Entender» is there too). */
const sends = (row: { attempts: { kind: string }[] }) => row.attempts.filter(a => a.kind === 'SEND')
const conversationOf = async (id: string) =>
  prisma.supportConversation.findUniqueOrThrow({ where: { id: (await saved(id)).conversationId } })
/** The question, prepared by the worker with the fake capability. Meta's record starts empty after it. */
async function ask(body = QUESTION) {
  const id = await enqueue(body)
  expect(await prepareSupportAnswer((await claim())!, { client: understanding(), library, dataCapabilities })).toBe('READY')
  send.mockClear()
  return id
}
/** A sealed DATA answer, ready to go out. */
async function prepared() {
  await f.unlock()
  const id = await ask()
  expect(await saved(id)).toMatchObject({ purpose: 'DATA', status: 'ANSWER_READY', answer: null, dataCapability: 'fake' })
  return id
}
/** Every text that went out to WhatsApp, in order. */
const bodies = () =>
  send.mock.calls
    .map(call => JSON.parse(String((call as unknown as [unknown, { body?: unknown }])[1]?.body)) as { text?: { body?: string } })
    .flatMap(sent => (sent.text?.body !== undefined ? [sent.text.body] : []))
const deliver = async () => {
  const next = await claim()
  return next ? deliverSupportMessage(next, [], library, dataCapabilities) : null
}
/** Delivers what is pending, in order, until nothing is left. */
async function drain() {
  for (let i = 0; i < 10; i++) if ((await deliver()) === null) return
  throw new Error('drain: still delivering after 10 rounds')
}
const neverTheFigure = () => expect(bodies().filter(b => b.includes(DIGITS) || b.includes(FIGURE))).toEqual([])

// ─── Los cambios: los diez del caso 50 que dejan la plática personal, y los cinco que la quitan ───────────────────────────
const KEEPS_PERSONAL = [
  'a permission removed',
  'ADMIN → MANAGER with the same permissions',
  'the plan removed',
  'the day changed',
  'the timezone changed',
  'the unlock deleted',
  'the notice text changed',
  'the verification withdrawn',
  'the switch turned off',
  'the 10 minutes ran out',
]
const GONE = [
  'the link expires',
  'the link is deleted',
  'the link is replaced',
  'the person loses the venue (StaffVenue.active = false, MEMBER membership still active)',
  'the org membership is deactivated',
]
/** A permission, the role or the plan: the first checkpoint answers with today's public notice. */
const ACCESS_CHANGES = ['a permission removed', 'ADMIN → MANAGER with the same permissions', 'the plan removed']
/** The text each change gets when it lands before the first checkpoint ('notice' = today's public notice). */
const textBeforeFirst = (name: string) =>
  ACCESS_CHANGES.includes(name) || GONE.includes(name) ? 'notice' : name === 'the switch turned off' ? SUPPORT_DATA_OFF : SUPPORT_DATA_STALE

/** What the case changes. 'the day changed' moves the venue's calendar to another day; 'the 10 minutes ran out', the clock. */
function change(name: string): () => Promise<unknown> {
  const { staffId, northId, cancunId, orgId } = f
  const changes: Record<string, () => Promise<unknown>> = {
    'a permission removed': () => f.grant({ permissions: [], features: ['RESERVATIONS'] }),
    'ADMIN → MANAGER with the same permissions': () =>
      f.grant({ permissions: ['reports:read'], role: 'MANAGER', features: ['RESERVATIONS'] }),
    'the plan removed': () => prisma.venueFeature.deleteMany({ where: { venueId: { in: [northId, cancunId] } } }),
    'the day changed': async () => jest.spyOn(venueDateKeys, 'venueDayKey').mockReturnValue('2099-01-01'),
    'the timezone changed': () => prisma.venue.update({ where: { id: northId }, data: { timezone: 'America/Cancun' } }),
    'the unlock deleted': () => prisma.supportDataUnlock.deleteMany({ where: { staffId } }),
    'the notice text changed': async () => {
      changeSupportDataNotice(`${SUPPORT_DATA_NOTICE.es} Cambió.`, `${SUPPORT_DATA_NOTICE.en} Changed.`)
    },
    'the verification withdrawn': () => prisma.venue.update({ where: { id: northId }, data: { kycStatus: 'IN_REVIEW' } }),
    'the switch turned off': async () => {
      process.env.SUPPORT_DATA_ENABLED = 'false'
    },
    'the 10 minutes ran out': async () => {
      shift = 11 * 60_000
    },
    'the link expires': () =>
      prisma.supportWhatsappLink.updateMany({ where: { staffId }, data: { expiresAt: new Date(Date.now() - 1000) } }),
    'the link is deleted': () => prisma.supportWhatsappLink.deleteMany({ where: { staffId } }),
    'the link is replaced': async () => {
      await prisma.supportWhatsappLink.deleteMany({ where: { staffId } })
      await prisma.supportWhatsappLink.create({
        data: { staffId, phone, verifiedAt: new Date(), expiresAt: new Date(Date.now() + 30 * DAY_MS) },
      })
    },
    'the person loses the venue (StaffVenue.active = false, MEMBER membership still active)': () =>
      prisma.staffVenue.updateMany({ where: { staffId, venueId: northId }, data: { active: false } }),
    'the org membership is deactivated': () =>
      prisma.staffOrganization.update({ where: { staffId_organizationId: { staffId, organizationId: orgId } }, data: { isActive: false } }),
  }
  if (!changes[name]) throw new Error(`change: unknown case ${name}`)
  return changes[name]
}
/** The state a change needs when the answer is prepared: 'ADMIN → MANAGER…' prepares as ADMIN. */
async function arrange(name: string) {
  if (name === 'ADMIN → MANAGER with the same permissions')
    await f.grant({ permissions: ['reports:read'], role: 'ADMIN', features: ['RESERVATIONS'] })
}
/** The change lands between preparing and delivering: the first checkpoint decides, and what it saves goes out next. */
async function changedBeforeFirst(name: string) {
  await arrange(name)
  const id = await prepared()
  const before = await conversationOf(id)
  await change(name)()
  expect(await deliver()).toBe('CANCELLED')
  const replaced = await saved(id)
  await drain()
  return { id, replaced, before, conversation: await conversationOf(id) }
}
/** The change lands after the first checkpoint passed and before the second one. */
async function changedBetween(name: string) {
  await arrange(name)
  const id = await prepared()
  const before = await conversationOf(id)
  const reset = jest.spyOn(router, 'resetSupportConversation')
  between = change(name)
  const result = await deliver()
  expect(between).toBeNull() // the first checkpoint ran and made the change
  return { result, row: await saved(id), before, conversation: await conversationOf(id), reset }
}
const personalAs = (before: SupportConversation) => ({
  mode: 'PERSONAL',
  staffId: before.staffId,
  linkId: before.linkId,
  orgId: before.orgId,
  venueId: before.venueId,
  generation: before.generation,
})
const PUBLIC = { mode: 'PUBLIC', staffId: null, linkId: null, orgId: null, venueId: null }

describe('a prepared DATA answer', () => {
  it('a prepared DATA answer goes out with the exact text; answer stays null and the cipher stays after SENT', async () => {
    const id = await prepared()
    const { answerCipher, accessFingerprint } = await saved(id)
    const envelope = dataAnswer.openDataEnvelope(answerCipher)!
    expect(envelope.text).toContain(FIGURE)
    send.mockImplementationOnce(async () => {
      // Right before the POST: the SEND attempt is persisted and nothing is in clear (nor its fingerprint rewritten).
      const row = await saved(id)
      expect(row).toMatchObject({ status: 'CLAIMED', answer: null, answerCipher, accessFingerprint })
      expect(sends(row)).toMatchObject([{ kind: 'SEND', state: 'STARTED' }])
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.fixture-data' }] }), { status: 200 })
    })
    expect(await deliver()).toBe('SENT')
    expect(bodies()).toEqual([envelope.text])
    const row = await saved(id)
    expect(row).toMatchObject({
      status: 'SENT',
      purpose: 'DATA',
      answer: null,
      accessFingerprint,
      outboundWamid: 'wamid.fixture-data',
      claimToken: null,
    })
    expect(sends(row)).toMatchObject([{ kind: 'SEND', state: 'SUCCEEDED', requestId: 'wamid.fixture-data' }])
    expect(dataAnswer.openDataEnvelope(row.answerCipher)).toEqual(envelope)
    // Both checkpoints ran, each with the saved access fingerprint and the sealed envelope.
    expect(dataAnswer.checkDataDelivery).toHaveBeenCalledTimes(2)
    for (const call of (dataAnswer.checkDataDelivery as jest.Mock).mock.calls) {
      expect(call[1]).toBe(accessFingerprint)
      expect(call[2]).toEqual(envelope)
      expect(call[4]).toBe(dataCapabilities)
    }
  })

  it('a permission removed between preparing and sending → today’s public notice; cipher erased, purpose HELP (case 8)', async () => {
    const { replaced, conversation } = await changedBeforeFirst('a permission removed')
    expect(replaced).toMatchObject({ purpose: 'HELP', answerCipher: null, dataCapability: null, sourceIds: [], accessFingerprint: null })
    expect(replaced.answer).toContain(NOTICE)
    expect(bodies()).toEqual([replaced.answer])
    expect(conversation).toMatchObject(PUBLIC)
    neverTheFigure()
  })

  it('ADMIN → MANAGER with the same permissions between preparing and sending → the public notice (case 8)', async () => {
    const { replaced, conversation } = await changedBeforeFirst('ADMIN → MANAGER with the same permissions')
    expect(replaced).toMatchObject({ purpose: 'HELP', answerCipher: null })
    expect(bodies()).toEqual([expect.stringContaining(NOTICE)])
    expect(conversation).toMatchObject(PUBLIC)
    neverTheFigure()
  })

  it('the venue changes from Mexico City to Cancún between preparing and sending → «Ese dato ya cambió; vuelve a preguntar.» goes out, never the figure, and the conversation stays PERSONAL (case 9)', async () => {
    const { replaced, before, conversation } = await changedBeforeFirst('the timezone changed')
    expect(replaced).toMatchObject({ purpose: 'HELP', answer: SUPPORT_DATA_STALE, answerCipher: null, sourceIds: [] })
    expect(bodies()).toEqual([SUPPORT_DATA_STALE])
    expect(SUPPORT_DATA_STALE).toBe('Ese dato ya cambió; vuelve a preguntar.')
    expect(conversation).toMatchObject(personalAs(before))
    neverTheFigure()
  })

  it.each(['unlock deleted', 'notice text changed', 'prepared 11 minutes ago'])(
    '%s → SUPPORT_DATA_STALE, never the figure (cases 10 and 16)',
    async name => {
      const id = await prepared()
      const before = await conversationOf(id)
      if (name === 'unlock deleted') await change('the unlock deleted')()
      if (name === 'notice text changed') await change('the notice text changed')()
      if (name === 'prepared 11 minutes ago') {
        const envelope = dataAnswer.openDataEnvelope((await saved(id)).answerCipher)!
        const preparedAt = new Date(Date.now() - 11 * 60_000).toISOString()
        await prisma.supportMessage.update({
          where: { id },
          data: { answerCipher: dataAnswer.sealDataEnvelope({ ...envelope, preparedAt }) },
        })
      }
      expect(await deliver()).toBe('CANCELLED')
      await drain()
      expect(bodies()).toEqual([SUPPORT_DATA_STALE])
      expect(await conversationOf(id)).toMatchObject(personalAs(before))
    },
  )

  it.each(['the link is deleted', 'the link is replaced'])(
    'unlinked between preparing and sending (%s) → the public notice or nothing goes out, never the figure and never «Ese dato ya cambió; vuelve a preguntar.»; after relinking, the same question gets SUPPORT_DATA_NEEDS_UNLOCK (case 15)',
    async name => {
      const { conversation } = await changedBeforeFirst(name)
      expect(conversation).toMatchObject(PUBLIC)
      const first = bodies()
      expect(first).toEqual([expect.stringContaining(NOTICE)])
      expect(first.filter(b => b.includes(SUPPORT_DATA_STALE))).toEqual([])
      neverTheFigure()
      // Relinking: a new link (another id) and the conversation personal again in Norte. The acceptance was for the old link.
      await prisma.supportWhatsappLink.deleteMany({ where: { staffId: f.staffId } })
      const link = await prisma.supportWhatsappLink.create({
        data: { staffId: f.staffId, phone, verifiedAt: new Date(), expiresAt: new Date(Date.now() + 30 * DAY_MS) },
      })
      await prisma.supportConversation.update({
        where: { id: conversation.id },
        data: {
          mode: 'PERSONAL',
          staffId: f.staffId,
          linkId: link.id,
          orgId: f.orgId,
          venueId: f.northId,
          app: 'dashboard',
          noticeAcceptedAt: new Date(),
        },
      })
      const again = await ask()
      expect(await saved(again)).toMatchObject({ purpose: 'HELP', answer: SUPPORT_DATA_NEEDS_UNLOCK, answerCipher: null })
      await drain()
      expect(bodies()).toEqual([SUPPORT_DATA_NEEDS_UNLOCK])
    },
  )

  it('the switch turned off between preparing and sending → SUPPORT_DATA_OFF, never the figure (case 33)', async () => {
    const { replaced, before, conversation } = await changedBeforeFirst('the switch turned off')
    expect(replaced).toMatchObject({ purpose: 'HELP', answer: SUPPORT_DATA_OFF, answerCipher: null, handoffOffered: false })
    // The constant as it is: no offer of a person, nothing in front.
    expect(bodies()).toEqual([SUPPORT_DATA_OFF])
    expect(conversation).toMatchObject(personalAs(before))
  })

  it('SUCURSAL to another venue before the send → the figure of the first venue never goes out; the same question there gets SUPPORT_DATA_NEEDS_UNLOCK (case 11)', async () => {
    const id = await prepared()
    await router.tryRouteSupport(input('SUCURSAL'))
    const choosing = await conversationOf(id)
    expect(choosing).toMatchObject({ mode: 'PERSONAL', pendingSelection: 'VENUE', venueId: null })
    const options = (choosing.selectionOptions as unknown as { items: { value: string }[] }).items
    await router.tryRouteSupport(input(String(options.findIndex(o => o.value === f.cancunId) + 1)))
    expect(await conversationOf(id)).toMatchObject({ mode: 'PERSONAL', venueId: f.cancunId, pendingSelection: null })
    await drain()
    expect(await saved(id)).toMatchObject({ status: 'CANCELLED', answerCipher: null })
    neverTheFigure()
    const before = bodies()
    const there = await ask()
    expect(await saved(there)).toMatchObject({ purpose: 'HELP', answer: SUPPORT_DATA_NEEDS_UNLOCK, answerCipher: null })
    await drain()
    expect([...before, ...bodies()]).toContain(SUPPORT_DATA_NEEDS_UNLOCK)
    neverTheFigure()
  })
})

describe('the case 50 changes', () => {
  it.each(KEEPS_PERSONAL)(
    'between the two checkpoints: %s → no message goes out, neither the figure nor a text; the cipher is not delivered and the conversation stays PERSONAL (cases 7, 8, 9, 10, 33, 40 and 50)',
    async name => {
      const { result, row, before, conversation, reset } = await changedBetween(name)
      expect(result).toBe('CANCELLED')
      expect(send).not.toHaveBeenCalled()
      expect(row).toMatchObject({ status: 'CANCELLED', purpose: 'DATA', answer: null, answerCipher: null, claimToken: null })
      expect(sends(row)).toMatchObject([{ kind: 'SEND', state: 'DEFINITIVE_FAILURE' }])
      expect(conversation).toMatchObject(personalAs(before))
      expect(reset).not.toHaveBeenCalled()
      expect(dataAnswer.checkDataDelivery).toHaveBeenCalledTimes(2)
      // Each checkpoint reads its own clock: a clock reused from the first one would never see the 10 minutes run out.
      const [first, second] = (dataAnswer.checkDataDelivery as jest.Mock).mock.calls
      expect(second[3]).toBeInstanceOf(Date)
      expect(second[3]).not.toBe(first[3])
      // Nothing is left to go out later either.
      await drain()
      expect(send).not.toHaveBeenCalled()
    },
  )

  it.each(GONE)(
    'between the two checkpoints: %s → nothing goes out and the conversation returns to public help (cases 15 and 50)',
    async name => {
      const { result, row, before, conversation, reset } = await changedBetween(name)
      expect(result).toBe('CANCELLED')
      expect(send).not.toHaveBeenCalled()
      expect(row).toMatchObject({ status: 'CANCELLED', answerCipher: null, claimToken: null })
      expect(sends(row)).toMatchObject([{ kind: 'SEND', state: 'DEFINITIVE_FAILURE' }])
      expect(conversation).toMatchObject({ ...PUBLIC, generation: before.generation + 1 })
      expect(reset).toHaveBeenCalledTimes(1)
      await drain()
      expect(send).not.toHaveBeenCalled()
    },
  )

  it.each(GONE)(
    'the same five before the first checkpoint: %s → today’s public notice goes out, never the figure and never «vuelve a preguntar», and the conversation is PUBLIC',
    async name => {
      const { replaced, conversation } = await changedBeforeFirst(name)
      expect(replaced).toMatchObject({ purpose: 'HELP', answerCipher: null, dataCapability: null })
      expect(bodies()).toEqual([expect.stringContaining(NOTICE)])
      expect(bodies().filter(b => b.includes(SUPPORT_DATA_STALE))).toEqual([])
      expect(conversation).toMatchObject(PUBLIC)
      neverTheFigure()
    },
  )

  it.each(KEEPS_PERSONAL)('the same ten changes before the first checkpoint: %s → its own text (case 50)', async name => {
    const { replaced, before, conversation } = await changedBeforeFirst(name)
    const expected = textBeforeFirst(name)
    expect(replaced).toMatchObject({ purpose: 'HELP', answerCipher: null, sourceIds: [], accessFingerprint: null })
    if (expected === 'notice') {
      expect(bodies()).toEqual([expect.stringContaining(NOTICE)])
      expect(conversation).toMatchObject(PUBLIC)
    } else {
      expect(bodies()).toEqual([expected])
      expect(conversation).toMatchObject(personalAs(before))
      // Not an answered data question any more: a fixed text, like a «no puedo» of la B, with no capability.
      expect(replaced).toMatchObject({ dataCapability: null, outcome: 'FIXED' })
    }
    neverTheFigure()
  })
})

describe('a conversation without a personal venue', () => {
  // checkDataDelivery does not throw for them: STALE without an envelope, ACCESS with one, OFF with the switch off. None of those
  // texts is for them: «vuelve a preguntar» is meant for a linked person in a venue.
  const choosing: Prisma.SupportConversationUncheckedUpdateInput = {
    orgId: null,
    venueId: null,
    pendingSelection: 'VENUE',
    selectionOptions: { items: [], nextCursor: null },
    selectionExpiresAt: new Date(Date.now() + 3_600_000),
  }
  it.each<[string, Prisma.SupportConversationUncheckedUpdateInput, boolean]>([
    ['PUBLIC, with its envelope', { mode: 'PUBLIC', staffId: null, linkId: null, orgId: null, venueId: null }, false],
    ['PUBLIC, with an unreadable cipher', { mode: 'PUBLIC', staffId: null, linkId: null, orgId: null, venueId: null }, true],
    ['still choosing its venue, with its envelope', choosing, false],
    ['still choosing its venue, with an unreadable cipher', choosing, true],
  ])('%s → today’s public notice, never «vuelve a preguntar»', async (_name, patch, unreadable) => {
    const id = await prepared()
    const { conversationId } = await saved(id)
    await prisma.supportConversation.update({ where: { id: conversationId }, data: patch })
    if (unreadable) await prisma.supportMessage.update({ where: { id }, data: { answerCipher: 'not-a-sealed-envelope' } })
    expect(await deliver()).toBe('CANCELLED')
    expect(await saved(id)).toMatchObject({ purpose: 'HELP', answerCipher: null, answer: expect.stringContaining(NOTICE) })
    await drain()
    expect(bodies()).toEqual([expect.stringContaining(NOTICE)])
    expect(bodies().filter(b => b.includes(SUPPORT_DATA_STALE))).toEqual([])
    neverTheFigure()
  })

  it('PUBLIC with the switch off → today’s public notice, not SUPPORT_DATA_OFF', async () => {
    const id = await prepared()
    await prisma.supportConversation.update({
      where: { id: (await saved(id)).conversationId },
      data: { mode: 'PUBLIC', staffId: null, linkId: null, orgId: null, venueId: null },
    })
    process.env.SUPPORT_DATA_ENABLED = 'false'
    expect(await deliver()).toBe('CANCELLED')
    await drain()
    expect(bodies()).toEqual([expect.stringContaining(NOTICE)])
  })
})

describe('never twice, never lost', () => {
  it('a delivery retried after an uncertain send never sends the figure twice (case 10)', async () => {
    const id = await prepared()
    const first = (await claim())!
    send.mockImplementationOnce(async () => {
      throw new TypeError('fixture timeout after POST')
    })
    expect(await deliverSupportMessage(first, [], library, dataCapabilities)).toBe('UNKNOWN')
    expect(await saved(id)).toMatchObject({ status: 'SEND_UNKNOWN', answer: null, claimToken: null })
    expect(sends(await saved(id))).toMatchObject([{ kind: 'SEND', state: 'UNKNOWN' }])
    // Nothing takes it again, and the same claim delivered again sends nothing.
    expect(await claim()).toBeNull()
    expect(await deliverSupportMessage(first, [], library, dataCapabilities)).toBe('CANCELLED')
    expect(send).toHaveBeenCalledTimes(1)
    expect(bodies().filter(b => b.includes(FIGURE))).toHaveLength(1)
  })

  it('two workers with the same claim send the figure once', async () => {
    const id = await prepared()
    const both = (await claim())!
    const results = await Promise.all([
      deliverSupportMessage(both, [], library, dataCapabilities),
      deliverSupportMessage(both, [], library, dataCapabilities),
    ])
    expect(results.filter(r => r === 'SENT')).toHaveLength(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(await prisma.supportAttempt.count({ where: { messageId: id, kind: 'SEND' } })).toBe(1)
    expect(await saved(id)).toMatchObject({ status: 'SENT', purpose: 'DATA' })
  })
})

describe('REINTENTAR after «vuelve a preguntar» with an uncertain send', () => {
  // The DATA answer became a fixed HELP text at the first checkpoint; that text went out through today's HELP delivery and its
  // send was left uncertain. REINTENTAR answers with the fixed text of la B: nothing is resent and no public notice goes out.
  it.each<[string, string, string]>([
    ['the unlock deleted', SUPPORT_DATA_STALE, 'nothing else changes'],
    ['the switch turned off', SUPPORT_DATA_OFF, 'nothing else changes'],
    // A permission removed after the uncertain send: only a lost link or venue returns the conversation to public help (T-B10).
    ['the unlock deleted', SUPPORT_DATA_STALE, 'a permission removed'],
  ])(
    '%s → «%s» with its send uncertain; then %s; REINTENTAR → SUPPORT_DATA_RETRY and the conversation stays personal',
    async (name, text, later) => {
      const id = await prepared()
      const before = await conversationOf(id)
      await change(name)()
      expect(await deliver()).toBe('CANCELLED')
      expect(await saved(id)).toMatchObject({ purpose: 'HELP', answer: text, status: 'ANSWER_READY' })
      send.mockImplementationOnce(async () => {
        throw new TypeError('fixture timeout after POST')
      })
      expect(await deliver()).toBe('UNKNOWN')
      expect(await saved(id)).toMatchObject({ status: 'SEND_UNKNOWN', answer: text })
      expect(sends(await saved(id))).toMatchObject([{ kind: 'SEND', state: 'UNKNOWN' }])
      if (later !== 'nothing else changes') await change(later)()
      const retry = await enqueue('REINTENTAR')
      const result = await prepareSupportAnswer((await claim())!, { client: understanding(), library, dataCapabilities })
      const row = await saved(retry)
      send.mockClear()
      await drain()
      expect({ result, answer: row.answer, retryOfId: row.retryOfId, sent: bodies(), mode: (await conversationOf(id)).mode }).toEqual({
        result: 'READY',
        answer: SUPPORT_DATA_RETRY,
        retryOfId: null,
        sent: [SUPPORT_DATA_RETRY],
        mode: 'PERSONAL',
      })
      expect(await conversationOf(id)).toMatchObject(personalAs(before))
      neverTheFigure()
    },
  )
})
