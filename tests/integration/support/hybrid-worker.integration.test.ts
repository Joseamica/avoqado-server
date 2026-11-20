import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { LUNA_SUPPORT_PRICING as pricing, getSupportAiConfig } from '@/config/supportWhatsapp'
import { admitSupportMessage, claimNext } from '@/services/support/store.service'
import { prepareSupportAnswer } from '@/services/support/worker.service'
import * as budget from '@/services/support/budget.service'
import * as context from '@/services/support/context.service'
import * as knowledge from '@/services/support/knowledge.service'
import { sourceRef, type LibraryGuide, type VerifiedSection } from '@/services/support/knowledge.service'
import { composeSupportAnswer, createSupportAiClient } from '@/services/support/answer.service'
import {
  literalSupportAnswer,
  renderSupportAnswer,
  wholeGuide,
  UNDERSTAND_INDEX_CAP,
  UNDERSTAND_INSTRUCTIONS,
  type SupportDraft,
} from '@/services/support/hybrid.service'
import { dataCatalog } from '@/services/support/data/catalog'
import { fakeCapability } from '@tests/__helpers__/supportData'
import { aiInput } from '@tests/__helpers__/supportAiInput'
import { tryRouteSupport } from '@/services/support/router.service'
import {
  SUPPORT_GREETING,
  SUPPORT_HYBRID_UNKNOWN,
  SUPPORT_OFF_TOPIC,
  SUPPORT_REPHRASE,
  SUPPORT_CLARIFY,
  SUPPORT_CLARIFY_CLOSE,
  SUPPORT_THANKS,
  SUPPORT_ASK_DEVICE,
  SUPPORT_ASK_VERSION,
  SUPPORT_GUIDE_TOO_LONG,
  SUPPORT_OTHER_QUESTION,
  supportOldVersion,
} from '@/services/support/texts'

const receiverId = `support-hybrid-${Date.now()}`,
  phone = '+525500007301'
const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
const guide = (id: string, title: string, summary: string, body: string): LibraryGuide => ({
  id,
  app: 'dashboard',
  title,
  summary,
  steps: [summary],
  publicUrl: `https://avoqado.io/help/${id}`,
  requiredPermissions: [],
  keywords: [],
  body,
  general: false,
  internal: false,
  hash: hash(`${id}\n${body}`),
})
const products = guide(
  'dashboard/menu/gestionar-productos',
  'Crear productos',
  'Da de alta productos y sus precios.',
  'Para crear un producto abre el menú del panel y toca nuevo producto. Escribe el nombre y el precio, y guarda los cambios.',
)
const inventory = guide(
  'dashboard/inventario/inventario-avanzado',
  'Inventario avanzado',
  'Controla existencias por ingrediente.',
  'El inventario avanzado descuenta ingredientes de cada venta. Actívalo en la configuración del negocio y registra tus insumos.',
)
const branch = guide(
  'dashboard/sucursales/cambiar-sucursal',
  'Cambiar de sucursal',
  'Pasa de una sucursal a otra en el panel.',
  'Para cambiar de sucursal toca el nombre del negocio arriba a la izquierda y elige otra sucursal de la lista.',
)
const library = [products, inventory, branch]
const question = { kind: 'question', standalone: '¿Cómo creo un producto?', guideIds: [products.id] }
const clarify = (...ids: string[]) => ({ kind: 'clarify', standalone: '', guideIds: ids })
const fixed = (kind: string) => ({ kind, standalone: '', guideIds: [] })
const goodDraft: SupportDraft = {
  covered: true,
  intro: {
    text: 'Puedes crear un producto desde el menú del panel.',
    guideId: products.id,
    quote: 'Para crear un producto abre el menú del panel',
  },
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
const clarifyText = (options: LibraryGuide[]) =>
  [SUPPORT_CLARIFY, ...options.map(g => `• ${g.title}: ${g.publicUrl}`), SUPPORT_CLARIFY_CLOSE].join('\n')

let serial = 0
let staffId: string, orgId: string, northId: string, southId: string
const originalFetch = global.fetch
let meta: jest.Mock
const input = (body: string, contextId?: string) => ({
  receiverId,
  phone,
  wamid: `wamid.${receiverId}-${++serial}`,
  type: 'text',
  body,
  timestamp: String(Math.floor(Date.now() / 1000)),
  ...(contextId ? { contextId } : {}),
})
type Reply = object | Error
/** Fake provider: one reply per model call, in order; a missing reply means no call was configured. */
function provider(replies: Reply[], onCall?: (n: number) => Promise<void>) {
  const bodies: Record<string, any>[] = []
  const fetcher = jest.fn(async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body)))
    const n = bodies.length
    await onCall?.(n)
    const reply = replies[n - 1]
    if (!reply) throw new TypeError('fixture: no reply configured for this call')
    if (reply instanceof Error) throw reply
    return new Response(
      JSON.stringify({
        id: `resp_${n}`,
        status: 'completed',
        usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(reply), annotations: [] }] }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  })
  const inputs = () => bodies.map(b => aiInput(b.input))
  return { fetcher, inputs, client: createSupportAiClient(getSupportAiConfig()!, fetcher as unknown as typeof fetch) }
}
async function clean() {
  const ids = (await prisma.supportConversation.findMany({ where: { receiverId }, select: { id: true }, take: 200 })).map(c => c.id)
  await prisma.supportEvent.deleteMany({ where: { conversationId: { in: ids } } })
  await prisma.supportAttempt.deleteMany({ where: { message: { conversation: { receiverId } } } })
  await prisma.supportMessage.deleteMany({ where: { conversation: { receiverId } } })
  await prisma.supportConversation.deleteMany({ where: { receiverId } })
  await prisma.whatsappInboundEvent.deleteMany({ where: { receiverId } })
  await prisma.supportBudget.deleteMany({
    where: { OR: [{ key: { startsWith: 'AI:' } }, { key: { startsWith: `CONTROL:${receiverId}:` } }] },
  })
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
  const org = await prisma.organization.create({
    data: { name: 'Hybrid support fixture', email: `${receiverId}-org@test.local`, phone: '0' },
  })
  orgId = org.id
  northId = (await prisma.venue.create({ data: { organizationId: orgId, name: 'Norte', slug: `${receiverId}-norte`, status: 'ACTIVE' } }))
    .id
  southId = (await prisma.venue.create({ data: { organizationId: orgId, name: 'Sur', slug: `${receiverId}-sur`, status: 'ACTIVE' } })).id
  // A registered phone: free text (which hybrid needs) only answers business teams.
  const staff = await prisma.staff.create({
    data: { email: `${receiverId}-staff@test.local`, firstName: 'Híbrido', lastName: 'Prueba', emailVerified: true, phone },
  })
  staffId = staff.id
  await prisma.staffOrganization.create({ data: { staffId, organizationId: orgId, role: 'MEMBER' } })
  await prisma.staffVenue.createMany({
    data: [
      { staffId, venueId: northId, role: 'VIEWER' },
      { staffId, venueId: southId, role: 'VIEWER' },
    ],
  })
})
beforeEach(async () => {
  await clean()
  process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED = 'true'
  process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED = 'true'
  // Meta (typing indicator) never leaves the test.
  meta = jest.fn(async () => new Response('{"success":true}', { status: 200 }))
  global.fetch = meta as unknown as typeof fetch
})
afterEach(() => {
  global.fetch = originalFetch
  jest.restoreAllMocks()
  delete process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED
  delete process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED
})
afterAll(async () => {
  await clean()
  if (!staffId) return
  await prisma.supportWhatsappLink.deleteMany({ where: { staffId } })
  await prisma.staffVenue.deleteMany({ where: { staffId } })
  await prisma.staffOrganization.deleteMany({ where: { staffId } })
  await prisma.venue.deleteMany({ where: { id: { in: [northId, southId] } } })
  await prisma.organization.delete({ where: { id: orgId } })
  await prisma.staff.delete({ where: { id: staffId } })
})
async function enqueue(body = '¿Cómo creo un producto?', contextId?: string, data: Prisma.SupportConversationUpdateManyMutationInput = {}) {
  const admitted = await admitSupportMessage(input(body, contextId))
  await prisma.supportConversation.updateMany({
    where: { receiverId, phone, mode: { not: 'CLOSED' } },
    data: { noticeAcceptedAt: new Date(), app: 'dashboard', lastUserMessageAt: new Date(), lastActivityAt: new Date(), ...data },
  })
  return admitted.messageId
}
const claim = () => claimNext(new Date(Date.now() + 10), receiverId)
const saved = (id: string) => prisma.supportMessage.findUniqueOrThrow({ where: { id } })
const attempts = (id: string) =>
  prisma.supportAttempt.findMany({
    where: { messageId: id, kind: 'AI' },
    orderBy: { ordinal: 'asc' },
    select: { ordinal: true, state: true },
  })
/** One question through the worker with the injected library. */
async function ask(replies: Reply[], body?: string, options: { contextId?: string; onCall?: (n: number) => Promise<void> } = {}) {
  const id = await enqueue(body, options.contextId)
  const p = provider(replies, options.onCall)
  const result = await prepareSupportAnswer((await claim())!, { client: p.client, library })
  return { id, p, result, message: await saved(id) }
}
let outbound = 0
async function markSent(id: string, status: 'SENT' | 'SEND_UNKNOWN' = 'SENT') {
  const outboundWamid = status === 'SENT' ? `wamid.${receiverId}-out-${++outbound}` : null
  await prisma.supportMessage.update({ where: { id }, data: { status, outboundWamid } })
  return outboundWamid
}
const turns = (understandInput: { history: { role: string; text: string }[] }) => understandInput.history.map(t => t.text)
async function until(done: () => boolean) {
  for (let i = 0; !done(); i++) {
    if (i > 100) throw new Error('timed out waiting')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
async function waitForAdvisoryWaiter() {
  for (let i = 0; ; i++) {
    const [row] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND wait_event = 'advisory' AND query LIKE '%support-ai-budget%'`
    if (row.n > 0) return
    if (i > 100) throw new Error('the call never waited for the budget lock')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
/** Runs `run` while this test holds the budget lock; `change` commits together with the lock release. */
async function whileLocked<T>(run: () => Promise<T>, change: (tx: Prisma.TransactionClient) => Promise<unknown>): Promise<T> {
  let locked!: () => void, go!: () => void
  const held = new Promise<void>(resolve => (locked = resolve)),
    released = new Promise<void>(resolve => (go = resolve))
  const holder = prisma.$transaction(
    async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('support-ai-budget', 0))`
      locked()
      await released
      await change(tx)
    },
    { timeout: 20_000 },
  )
  await held
  const pending = run()
  await waitForAdvisoryWaiter()
  go()
  await holder
  return pending
}

const section: VerifiedSection = {
  id: 'dashboard/menu/gestionar-productos',
  app: 'dashboard',
  title: 'Crear productos',
  summary: 'Resumen verificado de prueba',
  steps: ['Paso uno verificado', 'Último paso verificado'],
  publicUrl: 'https://avoqado.io/help/dashboard/menu/gestionar-productos',
  keywords: ['productos'],
  requiredPermissions: [],
}
describe('flag off', () => {
  it.each([
    ['hybrid off', 'false', 'true'],
    ['free text off', 'true', 'false'],
  ])('flag off (%s): identical to today', async (_label, hybrid, freeText) => {
    process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED = hybrid
    process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED = freeText
    const id = await enqueue('Crear productos')
    const p = provider([{ sectionIds: [section.id], needsClarification: false }])
    expect(await prepareSupportAnswer((await claim())!, { client: p.client, sections: [section], library })).toBe('READY')
    expect(await saved(id)).toMatchObject({ answer: composeSupportAnswer([section], null), sourceIds: [section.id] })
    expect(await attempts(id)).toEqual([{ ordinal: 1, state: 'SUCCEEDED' }])
    expect(p.fetcher).toHaveBeenCalledTimes(1)
    expect(meta).not.toHaveBeenCalled()
  })
})

describe('data off (la B)', () => {
  it('data off: the request to the model and every saved answer are the ones of phase 1', async () => {
    delete process.env.SUPPORT_DATA_ENABLED
    const read = jest.fn(fakeCapability.read)
    const dataCapabilities = dataCatalog({ ...fakeCapability, read })
    const run = async (replies: Reply[]) => {
      const id = await enqueue('¿Cuánto vendí hoy?')
      const p = provider(replies)
      expect(await prepareSupportAnswer((await claim())!, { client: p.client, library, dataCapabilities })).toBe('READY')
      const sent = p.fetcher.mock.calls.map(c => JSON.parse(String((c[1] as { body?: unknown }).body)))
      await markSent(id)
      return { message: await saved(id), understand: sent[0] }
    }
    // A data-shaped reply does not fit phase 1's schema: today's «no sé».
    const looksLikeData = {
      kind: 'data',
      standalone: '',
      guideIds: [],
      data: { capability: 'fake', day: 'today', amount: '', time: '', otherVenue: false },
    }
    const asked = await run([looksLikeData])
    const answered = await run([question, goodDraft, supported])
    for (const { understand } of [asked, answered]) {
      expect(understand.instructions).toBe(UNDERSTAND_INSTRUCTIONS)
      expect(Object.keys(aiInput(understand.input))).toEqual(['index', 'app', 'history', 'message'])
      // T-F14: phase 1 asks for otherQuestion too (with and without la B); nothing else of its shape changes.
      expect(Object.keys(understand.text.format.schema.properties)).toEqual(['kind', 'standalone', 'guideIds', 'otherQuestion'])
      expect(understand.text.format.schema.required).toEqual(['kind', 'standalone', 'guideIds', 'otherQuestion'])
    }
    expect(asked.message).toMatchObject({ purpose: 'HELP', answer: SUPPORT_HYBRID_UNKNOWN, outcome: 'UNKNOWN', dataCapability: null })
    expect(answered.message).toMatchObject({
      purpose: 'HELP',
      answer: renderSupportAnswer(goodDraft, [products], null),
      sourceIds: [sourceRef(products)],
      outcome: 'ANSWERED',
      dataCapability: null,
    })
    expect(read).not.toHaveBeenCalled()
    expect(await prisma.supportMessage.count({ where: { conversation: { receiverId }, purpose: 'DATA' } })).toBe(0)
  })
})

describe('hybrid worker', () => {
  it.each([
    ['greeting', SUPPORT_GREETING],
    ['nonsense', SUPPORT_REPHRASE],
    ['off_topic', SUPPORT_OFF_TOPIC],
    ['unknown', SUPPORT_HYBRID_UNKNOWN],
    ['human', 'Puedes revisar y copiar este resumen'],
  ])('fixed kinds: one call, one attempt, their texts (%s)', async (kind, text) => {
    const { id, p, result, message } = await ask([fixed(kind)], 'hola')
    expect(result).toBe('READY')
    expect(message.answer).toEqual(kind === 'human' ? expect.stringContaining(text) : text)
    expect(message.sourceIds).toEqual([])
    expect(message.accessFingerprint).toEqual(expect.any(String))
    expect(p.fetcher).toHaveBeenCalledTimes(1)
    expect(await attempts(id)).toEqual([{ ordinal: 1, state: 'SUCCEEDED' }])
  })

  it("clarify: saves one message with each option's title and link (never its description, T-F6c), sourceIds ['#clarify', ...id@hash8]; the conversation row does not change", async () => {
    const id = await enqueue('inventario')
    const conversationBefore = await prisma.supportConversation.findFirstOrThrow({ where: { receiverId } })
    const p = provider([clarify(products.id, inventory.id, branch.id)])
    expect(await prepareSupportAnswer((await claim())!, { client: p.client, library })).toBe('READY')
    const message = await saved(id)
    expect(message.answer).toBe(clarifyText([products, inventory, branch]))
    expect(message.sourceIds).toEqual(['#clarify', `${products.id}@${products.hash.slice(0, 8)}`, sourceRef(inventory), sourceRef(branch)])
    expect(await prisma.supportConversation.findFirstOrThrow({ where: { receiverId } })).toEqual(conversationBefore)
    expect(await attempts(id)).toEqual([{ ordinal: 1, state: 'SUCCEEDED' }])
  })

  it('clarify: a long summary is never shown (T-F6c)', async () => {
    const long = (g: LibraryGuide) => ({ ...g, summary: 's'.repeat(600) })
    const id = await enqueue('inventario')
    const p = provider([clarify(products.id, inventory.id, branch.id)])
    const own = [long(products), long(inventory), long(branch)]
    expect(await prepareSupportAnswer((await claim())!, { client: p.client, library: own })).toBe('READY')
    expect((await saved(id)).answer).toBe(
      [SUPPORT_CLARIFY, ...own.map(g => `• ${g.title}: ${g.publicUrl}`), SUPPORT_CLARIFY_CLOSE].join('\n'),
    )
  })

  it('clarify: titles and links that still do not fit in 1,500 characters → SUPPORT_HYBRID_UNKNOWN, without #clarify', async () => {
    const own = [products, inventory, branch].map((g, i) => ({ ...g, title: 'abc'[i].repeat(500) }))
    const id = await enqueue('inventario')
    const p = provider([clarify(products.id, inventory.id, branch.id)])
    expect(await prepareSupportAnswer((await claim())!, { client: p.client, library: own })).toBe('READY')
    expect(await saved(id)).toMatchObject({ answer: SUPPORT_HYBRID_UNKNOWN, sourceIds: [] })
  })

  it.each([
    ['la segunda', { kind: 'question', standalone: '¿Cómo uso el inventario avanzado?', guideIds: [inventory.id] }, inventory],
    [
      'el de inventario avanzado',
      { kind: 'question', standalone: '¿Cómo uso el inventario avanzado?', guideIds: [inventory.id] },
      inventory,
    ],
    ['la segunda', fixed('unknown'), null],
  ] as const)(
    'the reply to a clarification («%s») is resolved by understand with the clarification in the history; no option parser runs',
    async (reply, understood, chosen) => {
      const first = await ask([clarify(products.id, inventory.id)], 'inventario')
      await markSent(first.id)
      const draft: SupportDraft = {
        covered: true,
        intro: null,
        steps: [
          { text: 'Actívalo en la configuración del negocio.', guideId: inventory.id, quote: 'Actívalo en la configuración del negocio' },
        ],
      }
      const { p, message } = await ask([understood, draft, supported], reply)
      const [understandInput] = p.inputs()
      expect(understandInput.message).toBe(reply)
      expect(turns(understandInput)).toEqual(['inventario', first.message.answer])
      // Whatever understand decided is what the person gets: nothing maps «la segunda» to an option by itself.
      expect(message.answer).toBe(chosen ? renderSupportAnswer(draft, [chosen], null) : SUPPORT_HYBRID_UNKNOWN)
      expect(message.sourceIds).toEqual(chosen ? [sourceRef(chosen)] : [])
    },
  )

  it('a third clarification in a row becomes SUPPORT_REPHRASE; two in a row are allowed', async () => {
    const one = await ask([clarify(products.id, inventory.id)], 'inventario')
    expect(one.message.sourceIds[0]).toBe('#clarify')
    await markSent(one.id)
    const two = await ask([clarify(inventory.id, branch.id)], 'no, otra')
    expect(two.message.sourceIds[0]).toBe('#clarify')
    await markSent(two.id, 'SEND_UNKNOWN')
    const three = await ask([clarify(products.id, branch.id)], 'tampoco')
    expect(three.message).toMatchObject({ answer: SUPPORT_REPHRASE, sourceIds: [] })
    expect(three.p.fetcher).toHaveBeenCalledTimes(1)
    expect(await attempts(three.id)).toEqual([{ ordinal: 1, state: 'SUCCEEDED' }])
  })

  it("two clarifications A and B; quoting A and writing «la segunda» sends A's text as quoted to understand", async () => {
    const a = await ask([clarify(products.id, inventory.id)], 'productos')
    const aWamid = await markSent(a.id)
    const b = await ask([clarify(inventory.id, branch.id)], 'sucursal')
    await markSent(b.id)
    const { p } = await ask([fixed('unknown')], 'la segunda', { contextId: aWamid! })
    const [understandInput] = p.inputs()
    expect(understandInput.replyingTo).toBe(a.message.answer)
    expect(understandInput.replyingTo).not.toBe(b.message.answer)
  })

  it('quoted is only our own HELP answer in this conversation and generation', async () => {
    const { p } = await ask([fixed('unknown')], 'la segunda', { contextId: 'wamid.not-ours' })
    expect(p.inputs()[0]).not.toHaveProperty('replyingTo')
  })

  it('a clarification whose send is SEND_UNKNOWN stays in the history; «la segunda» is understood against it', async () => {
    const first = await ask([clarify(products.id, inventory.id)], 'inventario')
    await markSent(first.id, 'SEND_UNKNOWN')
    const { p } = await ask([fixed('unknown')], 'la segunda')
    expect(turns(p.inputs()[0])).toEqual(['inventario', first.message.answer])
  })

  it('history includes previous clarification and «no sé» turns', async () => {
    const first = await ask([clarify(products.id, inventory.id)], 'inventario')
    await markSent(first.id)
    const second = await ask([fixed('unknown')], '¿y la nómina?')
    expect(second.message.answer).toBe(SUPPORT_HYBRID_UNKNOWN)
    await markSent(second.id)
    const { p } = await ask([fixed('greeting')], 'gracias')
    const history = turns(p.inputs()[0])
    expect(history).toEqual([
      'inventario',
      first.message.answer,
      '¿y la nómina?',
      expect.stringContaining('No encontré eso en nuestras guías'),
    ])
  })

  // T-F11 (ruling T-F11.3): since T-F10c the literal guide goes whole up to 3,500, and the history drops a turn over 2,000. The next
  // turn now sees what was sent as its title, never its text; the worker takes the titles from its library.
  it('T-F11: a whole literal guide over 2,000 reaches the next turn as its title, never its text', async () => {
    const steps = Array.from({ length: 19 }, (_, i) => `${i + 2}. ${'detalle de la liga de pago '.repeat(5)}`).join('\n')
    const long = guide(
      'dashboard/ventas/liga-larga',
      'Crear una liga larga',
      'Crea una liga de pago.',
      `## Pasos\n1. Abre la sección de ventas y crea la liga.\n${steps}`,
    )
    const run = async (replies: Reply[], body: string) => {
      const id = await enqueue(body)
      const p = provider(replies)
      await prepareSupportAnswer((await claim())!, { client: p.client, library: [long, ...library] })
      return { id, p, message: await saved(id) }
    }
    // An invalid draft falls back to the literal guide, whole.
    const question = { kind: 'question', standalone: '¿Cómo creo una liga de pago?', guideIds: [long.id] }
    const first = await run([question, {}], '¿Cómo creo una liga de pago?')
    expect(first.message.answer).toContain(wholeGuide(long.body))
    expect(first.message.answer!.length).toBeGreaterThan(2000)
    expect(first.message.sourceIds).toEqual([sourceRef(long)])
    await markSent(first.id)
    const { p } = await run([fixed('unknown')], '¿y cómo le cambio el monto?')
    expect(turns(p.inputs()[0])).toEqual(['¿Cómo creo una liga de pago?', '[Se mandó la guía «Crear una liga larga» completa]'])
    expect(JSON.stringify(p.inputs()[0].history)).not.toContain('detalle de la liga de pago')
  })

  it('«gracias» after an answer is thanked (SUPPORT_THANKS), not greeted again; one call', async () => {
    const first = await ask([question, goodDraft, supported])
    await markSent(first.id)
    const { id, p, message } = await ask([fixed('greeting')], 'gracias')
    expect(message).toMatchObject({ answer: SUPPORT_THANKS, sourceIds: [] })
    expect(p.fetcher).toHaveBeenCalledTimes(1)
    expect(await attempts(id)).toEqual([{ ordinal: 1, state: 'SUCCEEDED' }])
  })

  it.each([
    ['on', 'the earlier message that asked for it'],
    ['off', 'the newest uncertain message, as today'],
  ])('REINTENTAR with the flag %s picks %s, not an answer sent as literal after an uncertain call 2', async (flag, _label) => {
    // A: call 1 lost → SUPPORT_AI_UNCERTAIN invites REINTENTAR. B: call 2 lost → the literal guide went out.
    const a = await ask([new TypeError('fixture lost response')])
    expect(a.message.answer).toMatch(/REINTENTAR/)
    await markSent(a.id)
    const b = await ask([question, new TypeError('fixture lost response')])
    expect(b.message).toMatchObject({ answer: literalSupportAnswer([products], null), sourceIds: [sourceRef(products)] })
    expect(await attempts(b.id)).toEqual([
      { ordinal: 1, state: 'SUCCEEDED' },
      { ordinal: 2, state: 'UNKNOWN' },
    ])
    await markSent(b.id)
    process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED = flag === 'on' ? 'true' : 'false'
    const retry = await ask([fixed('unknown')], 'REINTENTAR')
    expect(retry.message.retryOfId).toBe(flag === 'on' ? a.id : b.id)
  })

  it('question: three calls, three attempts (only the first counts hour/day), rendered text saved with id@hash8 refs', async () => {
    const { id, p, result, message } = await ask([question, goodDraft, supported])
    expect(result).toBe('READY')
    expect(message.answer).toBe(renderSupportAnswer(goodDraft, [products], null))
    expect(message.sourceIds).toEqual([sourceRef(products)])
    expect(p.fetcher).toHaveBeenCalledTimes(3)
    expect(await attempts(id)).toEqual([
      { ordinal: 1, state: 'SUCCEEDED' },
      { ordinal: 2, state: 'SUCCEEDED' },
      { ordinal: 3, state: 'SUCCEEDED' },
    ])
    const counters = await prisma.supportBudget.findMany({
      where: { key: { startsWith: 'AI:PHONE_', contains: hash(phone) } },
      select: { callCount: true },
    })
    expect(counters.map(c => c.callCount)).toEqual([1, 1])
    // The judge reads the standalone question, and the draft is told the same.
    const [, draftInput, judgeInput] = p.inputs()
    expect(draftInput.question).toBe(question.standalone)
    expect(judgeInput.question).toBe(question.standalone)
  })

  it('review rejects → literal; the judge is not called (two attempts)', async () => {
    const invented = { ...goodDraft, steps: [{ text: 'Toca guardar.', guideId: products.id, quote: 'esta cita no está en la guía' }] }
    const { id, p, message } = await ask([question, invented, supported])
    expect(message).toMatchObject({ answer: literalSupportAnswer([products], null), sourceIds: [sourceRef(products)] })
    expect(p.fetcher).toHaveBeenCalledTimes(2)
    expect(await attempts(id)).toEqual([
      { ordinal: 1, state: 'SUCCEEDED' },
      { ordinal: 2, state: 'SUCCEEDED' },
    ])
  })

  it.each([
    ['judge rejects', { supported: false }],
    ['a true quote with a false intro («Tu dinero llegará mañana») is rejected by the judge', { supported: false }],
    ['no judge configured', undefined],
    ['judge times out', Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })],
  ])('%s → literal', async (label, verdict) => {
    const draft =
      label.includes('dinero') && goodDraft.intro
        ? { ...goodDraft, intro: { ...goodDraft.intro, text: 'Tu dinero llegará mañana.' } }
        : goodDraft
    const replies: Reply[] = [question, draft, ...(verdict ? [verdict] : [])]
    const { id, p, message } = await ask(replies)
    expect(message).toMatchObject({ answer: literalSupportAnswer([products], null), sourceIds: [sourceRef(products)] })
    expect(p.fetcher).toHaveBeenCalledTimes(3)
    const judged = (await attempts(id))[2]
    expect(judged).toEqual({ ordinal: 3, state: verdict && !(verdict instanceof Error) ? 'SUCCEEDED' : 'UNKNOWN' })
  })

  it('call 2 throws → its attempt UNKNOWN, literal saved', async () => {
    const { id, p, result, message } = await ask([question, new TypeError('fixture lost response')])
    expect(result).toBe('READY')
    expect(message).toMatchObject({ answer: literalSupportAnswer([products], null), sourceIds: [sourceRef(products)] })
    expect(p.fetcher).toHaveBeenCalledTimes(2)
    expect(await attempts(id)).toEqual([
      { ordinal: 1, state: 'SUCCEEDED' },
      { ordinal: 2, state: 'UNKNOWN' },
    ])
  })

  it('call 1 throws → SUPPORT_AI_UNCERTAIN and UNKNOWN, as today', async () => {
    const { id, result, message } = await ask([new TypeError('fixture lost response')])
    expect(result).toBe('UNKNOWN')
    expect(message.answer).toMatch(/^No pude confirmar la respuesta del asistente/)
    expect(await attempts(id)).toEqual([{ ordinal: 1, state: 'UNKNOWN' }])
  })

  it('covered:false → SUPPORT_HYBRID_UNKNOWN', async () => {
    const { id, message } = await ask([question, { covered: false, intro: null, steps: [] }])
    expect(message).toMatchObject({ answer: SUPPORT_HYBRID_UNKNOWN, sourceIds: [] })
    expect((await attempts(id)).length).toBe(2)
  })

  it('unsigned manifest → SUPPORT_HYBRID_UNKNOWN without calling the model', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid-manifest-'))
    const real = knowledge.loadSupportLibrary
    try {
      const manifest = path.join(dir, 'library-approved.json')
      const approved = JSON.parse(fs.readFileSync(path.join(knowledge.SUPPORT_HELP_DIRECTORY, 'library-approved.json'), 'utf8'))
      fs.writeFileSync(manifest, JSON.stringify({ ...approved, approvedBy: null, approvedAt: null }))
      // The guides themselves are fine: only the missing signature keeps them out.
      expect(real({ manifest, allowDraft: true }).length).toBeGreaterThan(0)
      const spy = jest.spyOn(knowledge, 'loadSupportLibrary').mockImplementation(() => real({ manifest }))
      const id = await enqueue()
      const p = provider([question, goodDraft, supported])
      expect(await prepareSupportAnswer((await claim())!, { client: p.client })).toBe('READY')
      expect(spy).toHaveBeenCalled()
      expect((await saved(id)).answer).toBe(SUPPORT_HYBRID_UNKNOWN)
      expect(p.fetcher).not.toHaveBeenCalled()
      expect(await attempts(id)).toEqual([])
      expect(meta).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('SALIR between call 1 and call 2 → call 2 never starts and nothing is sent to the model again', async () => {
    const { id, p, result, message } = await ask([question, goodDraft, supported], undefined, {
      onCall: async n => {
        if (n === 1) await tryRouteSupport(input('SALIR'))
      },
    })
    expect(result).toBe('CANCELLED')
    expect(p.fetcher).toHaveBeenCalledTimes(1)
    expect(message).toMatchObject({ status: 'CANCELLED', answer: null })
    expect(await attempts(id)).toEqual([{ ordinal: 1, state: 'SUCCEEDED' }])
  })

  describe('a personal conversation that loses the chosen venue (keeping another)', () => {
    async function personal() {
      const link = await prisma.supportWhatsappLink.create({
        data: { staffId, phone, verifiedAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 86400000) },
      })
      const id = await enqueue()
      await prisma.supportConversation.updateMany({
        where: { receiverId, phone, mode: { not: 'CLOSED' } },
        data: { mode: 'PERSONAL', staffId, linkId: link.id, orgId, venueId: northId },
      })
      return id
    }
    const loseNorth = (tx: Prisma.TransactionClient) =>
      tx.staffVenue.update({ where: { staffId_venueId: { staffId, venueId: northId } }, data: { active: false } })
    afterEach(async () => {
      await prisma.staffVenue.update({ where: { staffId_venueId: { staffId, venueId: northId } }, data: { active: true } })
      await prisma.supportWhatsappLink.deleteMany({ where: { staffId } })
    })
    it.each(['reservation', 'start'] as const)(
      'losing the chosen venue while call 2 waits for its %s lock → detected; call 2 never starts',
      async waiting => {
        const id = await personal()
        if (waiting === 'reservation') {
          const real = budget.reserveAiAttempt
          jest
            .spyOn(budget, 'reserveAiAttempt')
            .mockImplementation(async (...args: Parameters<typeof real>) =>
              args[3]?.call === 2 ? whileLocked(() => real(...args), loseNorth) : real(...args),
            )
        } else {
          const real = budget.startAiAttempt
          let starts = 0
          jest
            .spyOn(budget, 'startAiAttempt')
            .mockImplementation(async (...args: Parameters<typeof real>) =>
              ++starts === 2 ? whileLocked(() => real(...args), loseNorth) : real(...args),
            )
        }
        const p = provider([question, goodDraft, supported])
        expect(await prepareSupportAnswer((await claim())!, { client: p.client, library })).toBe('CANCELLED')
        expect(p.fetcher).toHaveBeenCalledTimes(1)
        expect((await saved(id)).answer).toMatch(/^Tu acceso cambió/)
        expect(await prisma.supportConversation.findFirstOrThrow({ where: { receiverId, phone } })).toMatchObject({
          mode: 'PUBLIC',
          staffId: null,
          venueId: null,
        })
        expect(await attempts(id)).toEqual([
          { ordinal: 1, state: 'SUCCEEDED' },
          { ordinal: 2, state: 'DEFINITIVE_FAILURE' },
        ])
        expect((await prisma.supportAttempt.findFirstOrThrow({ where: { messageId: id, ordinal: 2 } })).startedAt).toBeNull()
      },
    )
  })

  describe('a venue lost between the last check and a final read (getUserAccess throws a plain Error)', () => {
    it.each(['finish', 'notStarted'] as const)('%s → public notice; the batch does not fail', async where => {
      const real = context.readSupportContext
      let lost = false
      jest.spyOn(context, 'readSupportContext').mockImplementation(async (...args: Parameters<typeof real>) => {
        // finish reads with the gates of the cited guides; notStarted reads after a call that did not start.
        if (where === 'finish' ? !!args[1]?.length : lost) throw new Error(`User ${staffId} has no access to venue ${northId}`)
        return real(...args)
      })
      if (where === 'notStarted') {
        const start = budget.startAiAttempt
        let starts = 0
        jest.spyOn(budget, 'startAiAttempt').mockImplementation(async (...args: Parameters<typeof start>) => {
          if (++starts !== 2) return start(...args)
          lost = true
          return false
        })
      }
      const id = await enqueue()
      const p = provider([question, goodDraft, supported])
      expect(await prepareSupportAnswer((await claim())!, { client: p.client, library })).toBe('CANCELLED')
      expect((await saved(id)).answer).toMatch(/^Tu acceso cambió/)
    })

    it.each(['after the call', 'notStarted'] as const)('flag off: %s → public notice; the batch does not fail', async where => {
      process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED = 'false'
      const real = context.readSupportContext
      let lost = false
      jest.spyOn(context, 'readSupportContext').mockImplementation(async (...args: Parameters<typeof real>) => {
        // after the call: the reads with the sections; notStarted: its own read after a start that was refused.
        if (lost && (where === 'notStarted' || !!args[1]?.length)) throw new Error(`User ${staffId} has no access to venue ${northId}`)
        return real(...args)
      })
      if (where === 'notStarted')
        jest.spyOn(budget, 'startAiAttempt').mockImplementation(async () => {
          lost = true
          return false
        })
      const id = await enqueue('Crear productos')
      const p = provider([{ sectionIds: [section.id], needsClarification: false }], async () => {
        lost = true
      })
      expect(await prepareSupportAnswer((await claim())!, { client: p.client, sections: [section], library })).toBe('CANCELLED')
      expect(p.fetcher).toHaveBeenCalledTimes(where === 'notStarted' ? 0 : 1)
      expect((await saved(id)).answer).toMatch(/^Tu acceso cambió/)
    })
  })

  describe('typing indicator', () => {
    it('one POST after call 1 starts', async () => {
      let stateAtPost: string | undefined
      meta.mockImplementation(async () => {
        const first = await prisma.supportAttempt.findFirst({
          where: { message: { conversation: { receiverId } }, kind: 'AI', ordinal: 1 },
        })
        stateAtPost = first?.state
        return new Response('{"success":true}', { status: 200 })
      })
      const id = await enqueue()
      const wamid = (await prisma.supportMessage.findUniqueOrThrow({ where: { id }, include: { inboundEvent: true } })).inboundEvent!.wamid
      const p = provider([question, goodDraft, supported])
      expect(await prepareSupportAnswer((await claim())!, { client: p.client, library })).toBe('READY')
      await until(() => stateAtPost !== undefined)
      expect(meta).toHaveBeenCalledTimes(1)
      const [url, init] = meta.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe(`https://graph.facebook.com/v21.0/${receiverId}/messages`)
      expect(JSON.parse(String(init.body))).toEqual({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: wamid,
        typing_indicator: { type: 'text' },
      })
      expect(['STARTED', 'SUCCEEDED']).toContain(stateAtPost)
    })
    it('a failure does not stop the answer and logs no user text', async () => {
      meta.mockImplementation(async () => {
        throw new TypeError('fixture Meta is down')
      })
      const spies = [jest.spyOn(logger, 'warn'), jest.spyOn(logger, 'info'), jest.spyOn(logger, 'error')]
      // The test setup already mocks the logger: start from a clean record.
      spies.forEach(l => l.mockClear())
      const logs = spies.map(l => l.mock as unknown as { calls: unknown[][] })
      const { result, message } = await ask([question, goodDraft, supported], '¿Cómo creo un producto secreto-de-prueba?')
      expect(result).toBe('READY')
      expect(message.answer).toBe(renderSupportAnswer(goodDraft, [products], null))
      expect(meta).toHaveBeenCalledTimes(1)
      await until(() => logs[0].calls.some(c => String(c[0]).includes('typing')))
      expect(JSON.stringify(logs.map(l => l.calls))).not.toContain('secreto-de-prueba')
      // The worker logs what happened, never what was asked.
      expect(logs[1].calls.find(c => c[0] === 'Support hybrid answer')?.[1]).toEqual({
        kind: 'question',
        calls: 3,
        ms: expect.any(Number),
      })
    })
    it('never sent for fixed router replies', async () => {
      const event = input('AYUDA')
      expect(await tryRouteSupport(event)).toBe('QUEUED')
      const p = provider([question, goodDraft, supported])
      expect(await prepareSupportAnswer((await claim())!, { client: p.client, library })).toBe('READY')
      await new Promise(resolve => setImmediate(resolve))
      expect(p.fetcher).not.toHaveBeenCalled()
      expect(meta).not.toHaveBeenCalled()
    })
  })
})

describe('version and device in the hybrid (Task 2)', () => {
  const tpv = (id: string, title: string, body: string, extra: Partial<LibraryGuide>) => ({
    ...guide(id, title, title, body),
    app: 'tpv' as const,
    ...extra,
  })
  const pax = tpv(
    'tpv/cobro/cobrar-con-pax',
    'Cobrar con tarjeta en la PAX',
    'En la PAX toca Cobrar, escribe el monto y acerca la tarjeta al lector de la terminal.',
    { deviceFamily: 'PAX', task: 'cobrar-con-tarjeta' },
  )
  const nexgo = tpv(
    'tpv/cobro/cobrar-con-nexgo',
    'Cobrar con tarjeta en la Nexgo',
    'En la Nexgo toca Venta, escribe el monto y pide al cliente que inserte la tarjeta.',
    { deviceFamily: 'NEXGO', task: 'cobrar-con-tarjeta' },
  )
  const tip = tpv(
    'tpv/propina/agregar-propina',
    'Agregar propina',
    'Para agregar propina toca Propina antes de cobrar y elige el porcentaje que te pide el cliente.',
    { versionMin: '2.19.0', task: 'agregar-propina' },
  )
  const tpvLibrary = [...library, pax, nexgo, tip]
  const charge = { kind: 'question', standalone: '¿Cómo cobro con tarjeta?', guideIds: [pax.id] }
  const paxDraft: SupportDraft = {
    covered: true,
    intro: null,
    steps: [
      { text: 'Toca Cobrar y escribe el monto.', guideId: pax.id, quote: 'toca Cobrar, escribe el monto' },
      { text: 'Acerca la tarjeta al lector.', guideId: pax.id, quote: 'acerca la tarjeta al lector de la terminal' },
    ],
  }
  const indexIds = (understandInput: { index: { id: string }[] }) => understandInput.index.map(g => g.id)
  const terminals: string[] = []
  afterEach(async () => {
    await prisma.terminal.deleteMany({ where: { id: { in: terminals.splice(0) } } })
    await prisma.supportWhatsappLink.deleteMany({ where: { staffId } })
  })

  it('tpv conversation on a PAX-only venue: understand never sees Nexgo pages and nothing is asked', async () => {
    terminals.push(
      (
        await prisma.terminal.create({
          data: { venueId: northId, name: 'PAX', type: 'TPV_ANDROID', brand: 'PAX', version: '2.19.0', lastHeartbeat: new Date() },
        })
      ).id,
    )
    const link = await prisma.supportWhatsappLink.create({
      data: { staffId, phone, verifiedAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 86400000) },
    })
    const id = await enqueue('¿Cómo cobro con tarjeta?', undefined, { app: 'tpv' })
    await prisma.supportConversation.updateMany({
      where: { receiverId, phone, mode: { not: 'CLOSED' } },
      data: { mode: 'PERSONAL', staffId, linkId: link.id, orgId, venueId: northId },
    })
    const p = provider([charge, paxDraft, supported])
    expect(await prepareSupportAnswer((await claim())!, { client: p.client, library: tpvLibrary })).toBe('READY')
    const [understandInput] = p.inputs()
    expect(indexIds(understandInput)).toContain(pax.id)
    expect(indexIds(understandInput)).not.toContain(nexgo.id)
    expect(p.fetcher).toHaveBeenCalledTimes(3)
    expect(await saved(id)).toMatchObject({ sourceIds: [sourceRef(pax)] })
    expect((await saved(id)).answer).toContain('Acerca la tarjeta al lector.')
    expect(await prisma.supportConversation.findFirstOrThrow({ where: { receiverId, phone } })).toMatchObject({
      pendingSelection: null,
      deviceFamily: null,
    })
  })

  it('unknown family and a PAX page chosen: asks «¿Qué terminal usas?» once and saves the topic', async () => {
    // Public help and a phone with two venues: nothing is deduced, so both variants reach understand.
    const topic = '¿Cómo cobro con tarjeta?'
    const first = await enqueue(topic, undefined, { app: 'tpv' })
    const p1 = provider([charge, paxDraft, supported])
    expect(await prepareSupportAnswer((await claim())!, { client: p1.client, library: tpvLibrary })).toBe('READY')
    expect(indexIds(p1.inputs()[0])).toEqual(expect.arrayContaining([pax.id, nexgo.id]))
    expect(await saved(first)).toMatchObject({ answer: SUPPORT_ASK_DEVICE, sourceIds: [] })
    expect(p1.fetcher).toHaveBeenCalledTimes(1)
    expect(await attempts(first)).toEqual([{ ordinal: 1, state: 'SUCCEEDED' }])
    expect(await prisma.supportConversation.findFirstOrThrow({ where: { receiverId, phone } })).toMatchObject({
      pendingSelection: 'DEVICE',
      selectionOptions: {
        topic,
        items: [
          { value: 'PAX', label: 'PAX' },
          { value: 'NEXGO', label: 'Nexgo' },
        ],
      },
    })
    // The router takes «1» and queues the topic again; this time the family is known and nothing is asked.
    await markSent(first)
    expect(await tryRouteSupport(input('1'))).toBe('QUEUED')
    const again = (await claim())!
    const p2 = provider([charge, paxDraft, supported])
    expect(await prepareSupportAnswer(again, { client: p2.client, library: tpvLibrary })).toBe('READY')
    expect(await saved(again.messageId)).toMatchObject({ body: topic, sourceIds: [sourceRef(pax)] })
    expect(indexIds(p2.inputs()[0])).not.toContain(nexgo.id)
    expect(p2.fetcher).toHaveBeenCalledTimes(3)
    expect(await prisma.supportConversation.findFirstOrThrow({ where: { receiverId, phone } })).toMatchObject({
      deviceFamily: 'PAX',
      pendingSelection: null,
    })
  })

  it('version 2.18.0 and the chosen page starts at 2.19.0: old-version text + literal guide, two calls fewer', async () => {
    const id = await enqueue('¿Cómo agrego propina?', undefined, { app: 'tpv', appVersion: '2.18.0', deviceFamily: 'PAX' })
    const p = provider([{ kind: 'question', standalone: '¿Cómo agrego propina?', guideIds: [tip.id] }])
    expect(await prepareSupportAnswer((await claim())!, { client: p.client, library: tpvLibrary })).toBe('READY')
    expect(indexIds(p.inputs()[0])).toContain(tip.id)
    expect(indexIds(p.inputs()[0])).not.toContain(nexgo.id)
    expect(await saved(id)).toMatchObject({
      answer: literalSupportAnswer([tip], null, supportOldVersion('2.19.0')),
      sourceIds: [sourceRef(tip)],
    })
    expect((await saved(id)).answer).toMatch(/^Esta guía es para la versión 2\.19\.0 o más nueva; te recomiendo actualizar la app\./)
    expect(p.fetcher).toHaveBeenCalledTimes(1)
    expect(await attempts(id)).toEqual([{ ordinal: 1, state: 'SUCCEEDED' }])
  })

  it('understand picks a current page and an outdated one: the chain drafts with the current one and the old-version text never appears (T2-m1)', async () => {
    const id = await enqueue('¿Cómo cobro con tarjeta y agrego propina?', undefined, {
      app: 'tpv',
      appVersion: '2.18.0',
      deviceFamily: 'PAX',
    })
    const p = provider([
      { kind: 'question', standalone: '¿Cómo cobro con tarjeta y agrego propina?', guideIds: [pax.id, tip.id] },
      paxDraft,
      supported,
    ])
    expect(await prepareSupportAnswer((await claim())!, { client: p.client, library: tpvLibrary })).toBe('READY')
    expect(p.fetcher).toHaveBeenCalledTimes(3)
    // The draft and the judge only see the page that applies to 2.18.0.
    expect(p.inputs()[1].guides.map((g: { id: string }) => g.id)).toEqual([pax.id])
    const message = await saved(id)
    expect(message).toMatchObject({ sourceIds: [sourceRef(pax)], outcome: 'ANSWERED' })
    expect(message.answer).toContain('Acerca la tarjeta al lector.')
    expect(message.answer).not.toContain('Esta guía es para la versión')
  })

  // T-F5 (se quita la respuesta parcial de T-F2/T-F3): con la versión o la terminal sin saber, basta con que UNA guía elegida
  // dependa de ella para preguntar primero, como en la fase 1. Nada se redacta con la del panel sola.
  const bothDraft: SupportDraft = {
    covered: true,
    intro: null,
    steps: [
      { text: 'Toca nuevo producto.', guideId: products.id, quote: 'toca nuevo producto' },
      { text: 'Toca Propina antes de cobrar.', guideId: tip.id, quote: 'toca Propina antes de cobrar' },
    ],
  }
  const mixed = { kind: 'question', standalone: '¿Cómo creo un producto con propina?', guideIds: [tip.id, products.id] }
  it('T-F5: unknown version, a versioned page and a panel page chosen: asks the version once, before drafting; «2.25.7» then drafts and cites both', async () => {
    const topic = '¿Cómo creo un producto con propina?'
    const first = await enqueue(topic, undefined, { app: 'tpv', deviceFamily: 'PAX' })
    const p = provider([mixed])
    expect(await prepareSupportAnswer((await claim())!, { client: p.client, library: tpvLibrary })).toBe('READY')
    expect(p.fetcher).toHaveBeenCalledTimes(1)
    expect(await attempts(first)).toEqual([{ ordinal: 1, state: 'SUCCEEDED' }])
    expect(await saved(first)).toMatchObject({ answer: SUPPORT_ASK_VERSION, sourceIds: [], outcome: 'ASKED' })
    const conversation = await prisma.supportConversation.findFirstOrThrow({ where: { receiverId, phone } })
    expect(conversation).toMatchObject({ pendingSelection: 'VERSION', appVersion: null })
    // The plain question of phase 1: no offer mark.
    expect(conversation.selectionOptions).toEqual({ topic, items: [] })
    // «2.25.7»: the router keeps the version and queues the topic again; now both guides are drafted and cited.
    await markSent(first)
    expect(await tryRouteSupport(input('2.25.7'))).toBe('QUEUED')
    const again = (await claim())!
    const p2 = provider([mixed, bothDraft, supported])
    expect(await prepareSupportAnswer(again, { client: p2.client, library: tpvLibrary })).toBe('READY')
    expect(p2.inputs()[1].guides.map((g: { id: string }) => g.id)).toEqual([tip.id, products.id])
    expect(await saved(again.messageId)).toMatchObject({
      body: topic,
      sourceIds: [sourceRef(tip), sourceRef(products)],
      outcome: 'ANSWERED',
    })
    expect(await prisma.supportConversation.findFirstOrThrow({ where: { receiverId, phone } })).toMatchObject({
      appVersion: '2.25.7',
      pendingSelection: null,
    })
  })

  it('T-F5: unknown terminal, a PAX page and a panel page chosen: asks the terminal once, before drafting', async () => {
    const topic = '¿Cómo cobro con tarjeta y creo un producto?'
    const id = await enqueue(topic, undefined, { app: 'tpv', appVersion: '2.19.0' })
    const p = provider([{ kind: 'question', standalone: topic, guideIds: [pax.id, products.id] }])
    expect(await prepareSupportAnswer((await claim())!, { client: p.client, library: tpvLibrary })).toBe('READY')
    expect(p.fetcher).toHaveBeenCalledTimes(1)
    expect(await saved(id)).toMatchObject({ answer: SUPPORT_ASK_DEVICE, sourceIds: [], outcome: 'ASKED' })
    const conversation = await prisma.supportConversation.findFirstOrThrow({ where: { receiverId, phone } })
    expect(conversation).toMatchObject({ pendingSelection: 'DEVICE', deviceFamily: null })
    expect(conversation.selectionOptions).toEqual({
      topic,
      items: [
        { value: 'PAX', label: 'PAX' },
        { value: 'NEXGO', label: 'Nexgo' },
      ],
    })
  })

  // T-F5 (Codex r2-1): sólo una respuesta suelta contesta la pregunta de versión. Un mensaje que NOMBRA una versión («no tengo
  // la 2.25.7», «¿necesito instalar la 2.25.7?») no la guarda como la que tiene instalada; la pregunta sigue, como con «no sé».
  const pendingQuestion = (pending: 'VERSION' | 'DEVICE', topic: string, extra: object = {}) =>
    prisma.supportConversation.updateMany({
      where: { receiverId, phone, mode: { not: 'CLOSED' } },
      data: {
        pendingSelection: pending,
        selectionOptions: {
          topic,
          items:
            pending === 'VERSION'
              ? []
              : [
                  { value: 'PAX', label: 'PAX' },
                  { value: 'NEXGO', label: 'Nexgo' },
                ],
          ...extra,
        },
        selectionExpiresAt: new Date(Date.now() + 600000),
      },
    })
  const topic = '¿Cómo creo un producto con propina?'
  it.each([
    ['VERSION', 'uso la versión 2.25.7', { appVersion: '2.25.7' }],
    ['VERSION', '2.19.0 (130)', { appVersion: '2.19.0' }],
    // T-F6 (Codex H5): the bare version and «tengo la …» still answer it.
    ['VERSION', '2.25.7', { appVersion: '2.25.7' }],
    ['VERSION', 'tengo la 2.25.7', { appVersion: '2.25.7' }],
    ['DEVICE', '1', { deviceFamily: 'PAX' }],
    ['DEVICE', 'PAX', { deviceFamily: 'PAX' }],
  ] as const)('pending %s, «%s» answers it: saved, and the topic is asked again (T-F5)', async (pending, text, known) => {
    await markSent(await enqueue(topic, undefined, { app: 'tpv' }))
    await pendingQuestion(pending, topic)
    expect(await tryRouteSupport(input(text))).toBe('QUEUED')
    expect(await saved((await claim())!.messageId)).toMatchObject({ body: topic, answer: null })
    expect(await prisma.supportConversation.findFirstOrThrow({ where: { receiverId, phone } })).toMatchObject({
      pendingSelection: null,
      appVersion: null,
      deviceFamily: null,
      ...known,
    })
  })
  it.each([
    ['¿Cómo cobro en la 2.25.7?', {}],
    ['No tengo la 2.25.7', {}],
    ['¿Necesito instalar la 2.25.7?', {}],
    ['¿Cómo vendo 1.5 kg de queso?', {}],
    // T-F6 (Codex H5, his two repros): a question is never the reply, whatever its words; and «qué» is a question word, not
    // filler, so the same question without its signs is no reply either (nor, now, «creo que es la 2.25.7»).
    ['¿Qué es la versión 2.25.7?', {}],
    ['¿Ya tengo la 2.25.7?', {}],
    ['Qué es la versión 2.25.7', {}],
    ['creo que es la 2.25.7', {}],
    // An offer mark left by T-F3b no longer drops the question nor saves the version.
    ['¿Cómo cobro en la 2.25.7?', { afterAnswer: true }],
  ] as const)('pending VERSION, «%s» (%j) is no reply: nothing is saved and the question stays (T-F5, Codex r2-1)', async (text, extra) => {
    await markSent(await enqueue(topic, undefined, { app: 'tpv' }))
    await pendingQuestion('VERSION', topic, extra)
    const before = await prisma.supportConversation.findFirstOrThrow({ where: { receiverId, phone } })
    expect(await tryRouteSupport(input(text))).toBe('QUEUED')
    expect(await saved((await claim())!.messageId)).toMatchObject({
      status: 'CLAIMED',
      answer: 'No encontré esa opción. Responde con el número o el nombre:\n\nO escribe APP o SUCURSAL para cambiar.',
    })
    expect(await prisma.supportConversation.findFirstOrThrow({ where: { receiverId, phone } })).toMatchObject({
      pendingSelection: 'VERSION',
      appVersion: null,
      generation: before.generation,
    })
  })

  it('unknown version and every chosen page versioned: asks the version once and saves the topic (T-F2)', async () => {
    const topic = '¿Cómo agrego propina?'
    const id = await enqueue(topic, undefined, { app: 'tpv', deviceFamily: 'PAX' })
    const p = provider([{ kind: 'question', standalone: topic, guideIds: [tip.id] }])
    expect(await prepareSupportAnswer((await claim())!, { client: p.client, library: tpvLibrary })).toBe('READY')
    expect(p.fetcher).toHaveBeenCalledTimes(1)
    expect(await saved(id)).toMatchObject({ answer: SUPPORT_ASK_VERSION, sourceIds: [] })
    expect(await prisma.supportConversation.findFirstOrThrow({ where: { receiverId, phone } })).toMatchObject({
      pendingSelection: 'VERSION',
      selectionOptions: { topic, items: [] },
    })
  })

  // T-F3 (Codex P3): se guardan sólo las guías que cita la redacción (las que se muestran), no todas las que se le dieron.
  it('known version: both pages are drafted, but only the one the draft cites is saved as a source (T-F3)', async () => {
    const id = await enqueue('¿Cómo creo un producto con propina?', undefined, { app: 'tpv', appVersion: '2.19.0', deviceFamily: 'PAX' })
    const p = provider([mixed, goodDraft, supported])
    expect(await prepareSupportAnswer((await claim())!, { client: p.client, library: tpvLibrary })).toBe('READY')
    expect(p.inputs()[1].guides.map((g: { id: string }) => g.id)).toEqual([tip.id, products.id])
    const message = await saved(id)
    expect(message).toMatchObject({ sourceIds: [sourceRef(products)], outcome: 'ANSWERED' })
    expect(message.answer).toBe(renderSupportAnswer(goodDraft, [products], null))
    expect(await prisma.supportConversation.findFirstOrThrow({ where: { receiverId, phone } })).toMatchObject({ pendingSelection: null })
  })

  it.each([
    ['VERSION', { versionMin: '2.19.0' }, '¿Qué versión de la app usas? Escríbela como aparece en la app (por ejemplo, 2.10.1).', []],
    [
      'DEVICE',
      { deviceFamily: 'PAX' as const },
      '¿Qué terminal usas?\n1. PAX\n2. Nexgo',
      [
        { value: 'PAX', label: 'PAX' },
        { value: 'NEXGO', label: 'Nexgo' },
      ],
    ],
  ])('flag off: ASK_VERSION/ASK_DEVICE path identical to today (%s)', async (pending, extra, text, items) => {
    process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED = 'false'
    const card: VerifiedSection = {
      id: 'tpv/cobro/cobrar-con-tarjeta',
      app: 'tpv',
      title: 'Cobrar con tarjeta',
      summary: 'Cobra con tarjeta en la terminal.',
      steps: ['Toca Cobrar.'],
      publicUrl: 'https://avoqado.io/help/tpv/cobro/cobrar-con-tarjeta',
      keywords: ['tarjeta'],
      requiredPermissions: [],
      ...extra,
    }
    const id = await enqueue('Cobrar con tarjeta', undefined, { app: 'tpv' })
    const p = provider([{ sectionIds: [card.id], needsClarification: false }])
    expect(await prepareSupportAnswer((await claim())!, { client: p.client, sections: [card], library: tpvLibrary })).toBe('READY')
    expect(await saved(id)).toMatchObject({ answer: text, sourceIds: [], accessFingerprint: null })
    expect(await prisma.supportConversation.findFirstOrThrow({ where: { receiverId, phone } })).toMatchObject({
      pendingSelection: pending,
      selectionOptions: { topic: 'Cobrar con tarjeta', items },
      selectionExpiresAt: expect.any(Date),
    })
    expect(p.fetcher).not.toHaveBeenCalled()
    expect(await attempts(id)).toEqual([])
  })
})

describe('top-N before understand (Task 3)', () => {
  // 5 guías citadas, sin puntaje para el texto, y 15 más de propinas que el tope, que sí lo tienen (T-F1: el tope ya no es 40).
  const cited = [1, 2, 3, 4, 5].map(n =>
    guide(`dashboard/zz/citada-${n}`, `Guía citada ${n}`, 'Sin coincidencias.', `Contenido de la guía citada número ${n}.`),
  )
  const tips = Array.from({ length: UNDERSTAND_INDEX_CAP + 15 }, (_, i) =>
    guide(`dashboard/propinas/p${String(i).padStart(3, '0')}`, `Propinas ${i}`, 'Reparte las propinas.', 'Reparte las propinas del día.'),
  )
  const overCap = [...tips, ...cited]
  const indexIds = (understandInput: { index: { id: string }[] }) => understandInput.index.map(g => g.id)
  async function answered(n: number) {
    const id = await enqueue(`¿cómo reparto las propinas? (${n})`)
    const p = provider([fixed('unknown')])
    await prepareSupportAnswer((await claim())!, { client: p.client, library: overCap })
    // Lo que el worker guardó al contestar con la guía n (la respuesta citada no menciona su tema).
    await prisma.supportMessage.update({ where: { id }, data: { answer: `Respuesta ${n}.`, sourceIds: [sourceRef(cited[n - 1])] } })
    return markSent(id)
  }

  it('keeps the sources of a quoted old message', async () => {
    expect(overCap).toHaveLength(UNDERSTAND_INDEX_CAP + 20)
    const firstWamid = await answered(1)
    for (const n of [2, 3, 4, 5]) await answered(n)
    await enqueue('¿y ahora?', firstWamid!)
    const p = provider([fixed('unknown')])
    expect(await prepareSupportAnswer((await claim())!, { client: p.client, library: overCap })).toBe('READY')
    const [understandInput] = p.inputs()
    const ids = indexIds(understandInput)
    expect(understandInput.replyingTo).toBe('Respuesta 1.')
    expect(ids).toHaveLength(UNDERSTAND_INDEX_CAP)
    // La citada (la más vieja, fuera de las 4 del historial) y las dos últimas respuestas entran aunque no tengan puntaje.
    expect(ids).toEqual(expect.arrayContaining([cited[0].id, cited[3].id, cited[4].id]))
    expect(ids).not.toContain(cited[1].id)
    expect(ids).not.toContain(cited[2].id)
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)))
  })
})

// T-F14 (H-T15-1): «¿quién abrió la caja hoy y cómo agrego un producto?» contestaba una y la otra se perdía sin aviso. Entender lo
// marca (otherQuestion) y la respuesta, sea cual sea su forma, termina con la línea fija. Ninguna llamada de más al modelo.
describe('T-F14: another question in the same message', () => {
  const also = (text: string) => `${text}\n\n${SUPPORT_OTHER_QUESTION}`
  const marked = { ...question, otherQuestion: true }
  it('a drafted answer ends with the line; three model calls, as always', async () => {
    const { result, message, p } = await ask([marked, goodDraft, supported])
    expect(result).toBe('READY')
    expect(message).toMatchObject({ answer: also(renderSupportAnswer(goodDraft, [products], null)!), outcome: 'ANSWERED' })
    expect(p.fetcher).toHaveBeenCalledTimes(3)
  })
  it('the literal guide (the judge rejected the draft) ends with the line', async () => {
    const { message } = await ask([marked, goodDraft, { supported: false, missing: [] }])
    expect(message).toMatchObject({ answer: also(literalSupportAnswer([products], null)), outcome: 'JUDGE_LITERAL' })
  })
  it('a guide too long for WhatsApp goes as its card, and the card ends with the line', async () => {
    const long = guide('dashboard/menu/guia-larga', 'Guía larga', 'Una guía que no cabe.', 'Un paso largo de la guía. '.repeat(160))
    const id = await enqueue()
    const p = provider([{ ...marked, guideIds: [long.id] }, new TypeError('fixture: the draft call is lost')])
    expect(await prepareSupportAnswer((await claim())!, { client: p.client, library: [...library, long] })).toBe('READY')
    const message = await saved(id)
    expect(literalSupportAnswer([long], null)).toContain(SUPPORT_GUIDE_TOO_LONG)
    expect(message).toMatchObject({ answer: also(literalSupportAnswer([long], null)), outcome: 'LITERAL' })
  })
  it('a clarification ends with the line too', async () => {
    const { message } = await ask([{ ...clarify(products.id, branch.id), otherQuestion: true }])
    expect(message).toMatchObject({ answer: also(clarifyText([products, branch])), outcome: 'CLARIFIED' })
  })
  it.each([
    ['false', { ...question, otherQuestion: false }],
    ['missing', question],
  ])('without the mark (%s) nothing is added', async (_case, first) => {
    const { message } = await ask([first, goodDraft, supported])
    expect(message.answer).toBe(renderSupportAnswer(goodDraft, [products], null))
  })
})
