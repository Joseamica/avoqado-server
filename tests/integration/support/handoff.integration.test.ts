import crypto from 'crypto'
import type { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { aiInput } from '@tests/__helpers__/supportAiInput'
import * as dateKeys from '@/utils/venueDateKeys'
import { venueDayKey } from '@/utils/venueDateKeys'
import { LUNA_SUPPORT_PRICING as pricing, getSupportAiConfig, getSupportHandoffConfig } from '@/config/supportWhatsapp'
import * as store from '@/services/support/store.service'
import { admitSupportMessage, claimNext } from '@/services/support/store.service'
import { prepareSupportAnswer } from '@/services/support/worker.service'
import { tryRouteSupport } from '@/services/support/router.service'
import { buildHumanSummary } from '@/services/support/humanSummary.service'
import * as knowledge from '@/services/support/knowledge.service'
import { sourceRef, type LibraryGuide, type VerifiedSection } from '@/services/support/knowledge.service'
import { composeSupportAnswer, createSupportAiClient } from '@/services/support/answer.service'
import { literalSupportAnswer, type SupportDraft } from '@/services/support/hybrid.service'
import { requestSupportHandoff, secondFailureText, supportPhoneHash, type HandoffMeta } from '@/services/support/handoff.service'
import {
  SUPPORT_HANDOFF_OFFER,
  SUPPORT_HYBRID_UNKNOWN,
  SUPPORT_THANKS,
  SUPPORT_UNREGISTERED,
  SUPPORT_ASK_APP,
  SUPPORT_LINK,
  supportHandoffAlready,
  supportHandoffDone,
  supportOldVersion,
} from '@/services/support/texts'

const receiverId = `support-handoff-${Date.now()}`
// 76xx: no other support suite uses these numbers.
const phone = '+525500007601',
  cashierPhone = '+525500007602',
  adminPhone = '+525500007603',
  lonePhone = '+525500007604',
  sharedPhone = '+525500007605',
  unknownPhone = '+525500007609'
const NUMBER = '+52 56 4007 0001'
const DONE = supportHandoffDone(NUMBER),
  ALREADY = supportHandoffAlready(NUMBER)
const today = () => venueDayKey(new Date(), 'America/Mexico_City')
const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
const guide = (id: string, title: string, summary: string, body: string, extra: Partial<LibraryGuide> = {}): LibraryGuide => ({
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
  ...extra,
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
const tip = tpv(
  'tpv/propina/agregar-propina',
  'Agregar propina',
  'Para agregar propina toca Propina antes de cobrar y elige el porcentaje que te pide el cliente.',
  { versionMin: '2.19.0', task: 'agregar-propina' },
)
const library = [products, inventory, pax, tip]
const question = { kind: 'question', standalone: '¿Cómo creo un producto?', guideIds: [products.id] }
const tipQuestion = { kind: 'question', standalone: '¿Cómo agrego propina?', guideIds: [tip.id] }
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
const badQuote: SupportDraft = {
  covered: true,
  intro: null,
  steps: [{ text: 'Toca nuevo producto.', guideId: products.id, quote: 'esta frase no viene en la guía' }],
}
const uncovered = { covered: false, intro: null, steps: [] }
const supported = { supported: true, missing: [] },
  rejected = { supported: false }
const oldVersion = { app: 'tpv', appVersion: '2.18.0', deviceFamily: 'PAX' }

let serial = 0,
  outbound = 0
let orgId: string, northId: string, southId: string
let staffId: string, cashierId: string, adminId: string, loneId: string, sharedIds: string[]
const originalFetch = global.fetch
let meta: jest.Mock
const input = (body: string, from = phone) => ({
  receiverId,
  phone: from,
  wamid: `wamid.${receiverId}-${++serial}`,
  type: 'text',
  body,
  timestamp: String(Math.floor(Date.now() / 1000)),
})
type Reply = object | Error
/** Fake provider: one reply per model call, in order. */
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
const conversationIds = async () =>
  (await prisma.supportConversation.findMany({ where: { receiverId }, select: { id: true }, take: 500 })).map(c => c.id)
async function clean() {
  const ids = await conversationIds()
  await prisma.supportEvent.deleteMany({ where: { conversationId: { in: ids } } })
  await prisma.supportNotice.deleteMany({
    where: { OR: [{ conversationId: { in: ids } }, { dedupeKey: { startsWith: `handoff:${receiverId}` } }] },
  })
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
  orgId = (await prisma.organization.create({ data: { name: 'Handoff fixture', email: `${receiverId}-org@test.local`, phone: '0' } })).id
  northId = (await prisma.venue.create({ data: { organizationId: orgId, name: 'Norte', slug: `${receiverId}-norte`, status: 'ACTIVE' } }))
    .id
  southId = (await prisma.venue.create({ data: { organizationId: orgId, name: 'Sur', slug: `${receiverId}-sur`, status: 'ACTIVE' } })).id
  const staff = async (from: string, firstName: string, venues: [string, 'VIEWER' | 'CASHIER' | 'SUPERADMIN'][], pin?: string) => {
    const id = (
      await prisma.staff.create({
        data: { email: `${receiverId}-${firstName}@test.local`, firstName, lastName: 'Persona', emailVerified: true, phone: from },
      })
    ).id
    await prisma.staffVenue.createMany({ data: venues.map(([venueId, role]) => ({ staffId: id, venueId, role, ...(pin ? { pin } : {}) })) })
    return id
  }
  // A registered phone with two venues; a cashier who only signs in with a PIN; a superadmin; one switched off mid-test.
  staffId = await staff(phone, 'Aviso', [
    [northId, 'VIEWER'],
    [southId, 'VIEWER'],
  ])
  await prisma.staffOrganization.create({ data: { staffId, organizationId: orgId, role: 'MEMBER' } })
  cashierId = await staff(cashierPhone, 'Cajera', [[northId, 'CASHIER']], '4321')
  adminId = await staff(adminPhone, 'Super', [[northId, 'SUPERADMIN']])
  loneId = await staff(lonePhone, 'Sola', [[northId, 'VIEWER']])
  // One number saved on two profiles: the notice cannot pick the person.
  sharedIds = [
    await staff(sharedPhone, 'Compartida', [[northId, 'VIEWER']]),
    await staff(sharedPhone, 'Otra', [[southId, 'CASHIER']]),
  ].sort()
})
beforeEach(async () => {
  await clean()
  process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED = 'true'
  process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED = 'true'
  process.env.SUPPORT_HANDOFF_EMAIL_TO = 'soporte@test.local'
  meta = jest.fn(async () => new Response('{"success":true}', { status: 200 }))
  global.fetch = meta as unknown as typeof fetch
  // The router and the snapshot read the signed library themselves: here it is the fixture's.
  jest.spyOn(knowledge, 'loadSupportLibrary').mockReturnValue(library)
})
afterEach(async () => {
  global.fetch = originalFetch
  jest.restoreAllMocks()
  for (const key of [
    'SUPPORT_WHATSAPP_FREE_TEXT_ENABLED',
    'SUPPORT_WHATSAPP_HYBRID_ENABLED',
    'SUPPORT_HANDOFF_EMAIL_TO',
    'SUPPORT_HANDOFF_PHONE_DAILY_CAP',
    'SUPPORT_HANDOFF_DAILY_CAP',
    'SUPPORT_PUBLIC_HELP_ENABLED',
  ])
    delete process.env[key]
  await prisma.supportWhatsappLink.deleteMany({ where: { staffId } })
  await prisma.staff.update({ where: { id: loneId }, data: { active: true } })
})
afterAll(async () => {
  await clean()
  if (!orgId) return
  const ids = [staffId, cashierId, adminId, loneId, ...(sharedIds ?? [])].filter(Boolean)
  await prisma.staffVenue.deleteMany({ where: { staffId: { in: ids } } })
  await prisma.staffOrganization.deleteMany({ where: { staffId: { in: ids } } })
  await prisma.staff.deleteMany({ where: { id: { in: ids } } })
  await prisma.venue.deleteMany({ where: { id: { in: [northId, southId] } } })
  await prisma.organization.delete({ where: { id: orgId } })
})

const openOf = (from = phone) =>
  prisma.supportConversation.findFirstOrThrow({ where: { receiverId, phone: from, mode: { not: 'CLOSED' } } })
/** An open, consented conversation (the router then finds it). */
const openConversation = (from = phone, data: Partial<Prisma.SupportConversationUncheckedCreateInput> = {}) =>
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
async function personal(data: Partial<Prisma.SupportConversationUncheckedCreateInput> = {}) {
  const link = await prisma.supportWhatsappLink.create({
    data: { staffId, phone, verifiedAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 86400000) },
  })
  return openConversation(phone, { mode: 'PERSONAL', staffId, linkId: link.id, orgId, venueId: northId, ...data })
}
async function enqueue(body = '¿Cómo creo un producto?', from = phone, data: Prisma.SupportConversationUpdateManyMutationInput = {}) {
  const admitted = await admitSupportMessage(input(body, from))
  await prisma.supportConversation.updateMany({
    where: { receiverId, phone: from, mode: { not: 'CLOSED' } },
    data: { noticeAcceptedAt: new Date(), app: 'dashboard', lastUserMessageAt: new Date(), lastActivityAt: new Date(), ...data },
  })
  return admitted.messageId
}
const claim = () => claimNext(new Date(Date.now() + 10), receiverId)
const saved = (id: string) => prisma.supportMessage.findUniqueOrThrow({ where: { id } })
const reply = (event: { wamid: string }) => prisma.supportMessage.findFirstOrThrow({ where: { inboundEvent: { wamid: event.wamid } } })
const notices = async () =>
  prisma.supportNotice.findMany({ where: { conversationId: { in: await conversationIds() } }, orderBy: { createdAt: 'asc' }, take: 50 })
const events = async () =>
  prisma.supportEvent.findMany({ where: { conversationId: { in: await conversationIds() } }, orderBy: { createdAt: 'asc' }, take: 50 })
async function markSent(id: string) {
  await prisma.supportMessage.update({ where: { id }, data: { status: 'SENT', outboundWamid: `wamid.${receiverId}-out-${++outbound}` } })
}
/** One message through the worker with the injected library. */
async function ask(
  replies: Reply[],
  body?: string,
  options: {
    from?: string
    data?: Prisma.SupportConversationUpdateManyMutationInput
    lib?: LibraryGuide[]
    onCall?: (n: number) => Promise<void>
  } = {},
) {
  const id = await enqueue(body, options.from, options.data)
  const p = provider(replies, options.onCall)
  const result = await prepareSupportAnswer((await claim())!, { client: p.client, library: options.lib ?? library })
  return { id, p, result, message: await saved(id) }
}
/** Two failures in a row: the second carries the offer. */
async function offered() {
  const first = await ask([fixed('unknown')], '¿Puedo pagar la nómina con Avoqado?')
  await markSent(first.id)
  const second = await ask([question, goodDraft, rejected])
  return { first, second }
}
/** completeClaim always loses: as if the lease had run out just before it. */
function loseEveryClaim() {
  const real = store.completeClaim
  return jest.spyOn(store, 'completeClaim').mockImplementation((c, patch, _now, db) => real(c, patch, new Date(Date.now() + 3_600_000), db))
}

describe('PERSONA (router)', () => {
  it('PERSONA from a personal conversation: done text, one PENDING notice with its meta in the same transaction as the answer, outcome HANDOFF and its event', async () => {
    const conversation = await personal({ appVersion: '2.25.42-escritorio' })
    const before = await admitSupportMessage(input('¿Cómo creo un producto?'))
    await prisma.supportMessage.update({
      where: { id: before.messageId },
      data: { status: 'SENT', answer: 'Respuesta.', sourceIds: [sourceRef(products)] },
    })
    // A failure after the notice is written undoes both: they are one transaction.
    jest.spyOn(store, 'admitSupportMessage').mockRejectedValueOnce(new Error('fixture: admission failed'))
    await expect(tryRouteSupport(input('PERSONA'))).rejects.toMatchObject({ code: 'SUPPORT_ADMISSION_FAILED' })
    expect(await notices()).toEqual([])

    const event = input('PERSONA')
    expect(await tryRouteSupport(event)).toBe('QUEUED')
    const message = await reply(event)
    expect(message).toMatchObject({ status: 'ANSWER_READY', answer: DONE, outcome: 'HANDOFF' })
    const [notice, ...more] = await notices()
    expect(more).toEqual([])
    expect(notice).toMatchObject({
      kind: 'HANDOFF',
      status: 'PENDING',
      dedupeKey: `handoff:${conversation.id}:${conversation.generation}`,
      reason: 'REQUESTED',
      app: 'dashboard',
      conversationId: conversation.id,
      generation: conversation.generation,
      staffId,
      linkId: conversation.linkId,
      venueId: northId,
      phoneHash: supportPhoneHash(receiverId, phone),
      day: today(),
    })
    expect(notice.meta).toEqual({
      requestedAt: expect.any(String),
      reason: 'REQUESTED',
      phone,
      app: 'dashboard',
      // Normalized: nothing the person typed after the version reaches the notice (F-20).
      appVersion: '2.25.42',
      deviceFamily: null,
      multipleProfiles: false,
      people: [
        { staffId, name: 'Aviso Persona', role: 'VIEWER', venues: [{ id: northId, name: 'Norte' }], organization: 'Handoff fixture' },
      ],
      guides: [products.title],
    })
    expect(await events()).toEqual([
      expect.objectContaining({
        kind: 'HANDOFF',
        app: 'dashboard',
        guideIds: [],
        conversationId: conversation.id,
        generation: conversation.generation,
        sequence: message.sequence,
        day: today(),
      }),
    ])
  })

  it.each([
    ['a registered public cashier (PIN only)', cashierPhone, () => cashierId, 'CASHIER'],
    ['a superadmin phone', adminPhone, () => adminId, 'SUPERADMIN'],
  ])('PERSONA from %s: eligible', async (_label, from, id, role) => {
    const event = input('PERSONA', from)
    expect(await tryRouteSupport(event)).toBe('QUEUED')
    expect(await reply(event)).toMatchObject({ answer: DONE, outcome: 'HANDOFF' })
    const [notice] = await notices()
    expect(notice).toMatchObject({ status: 'PENDING', staffId: id(), linkId: null, venueId: null })
    const snapshot = notice.meta as unknown as HandoffMeta
    expect(snapshot).toMatchObject({ phone: from, multipleProfiles: false })
    // A superadmin shows only its own venues, never the first ones of the whole platform.
    expect(snapshot.people).toEqual([
      {
        staffId: id(),
        name: expect.stringContaining('Persona'),
        role,
        venues: [{ id: northId, name: 'Norte' }],
        organization: 'Handoff fixture',
      },
    ])
  })

  it('a public number saved on two profiles: no staffId on the notice, multipleProfiles and both people', async () => {
    const event = input('PERSONA', sharedPhone)
    await tryRouteSupport(event)
    expect(await reply(event)).toMatchObject({ answer: DONE, outcome: 'HANDOFF' })
    const [notice] = await notices()
    expect(notice).toMatchObject({ status: 'PENDING', staffId: null })
    const snapshot = notice.meta as unknown as HandoffMeta
    expect(snapshot.multipleProfiles).toBe(true)
    expect(snapshot.people.map(p => p.staffId)).toEqual(sharedIds)
  })

  it.each([
    ['fits', false],
    ['does not fit', true],
  ])("an ineligible phone gets today's summary plus how to link if it %s; FIXED and no row", async (_label, long) => {
    // With public help off, as before it (public-help.integration.test.ts covers it on).
    process.env.SUPPORT_PUBLIC_HELP_ENABLED = 'false'
    // Long titles fill the summary until the link no longer fits in 1,500. Measured with the real buildHumanSummary: 2 of
    // the 3 lines enter; repeat(34) = 1,343 characters, 1,527 with the link (repeat(28) = 1,371 fits; repeat(33) = 1,501).
    const titled = (n: number) =>
      guide(`dashboard/largas/guia-larga-${n}`, `${'Título largo '.repeat(34)}${n}`, 'Resumen.', `Cuerpo de la guía larga ${n}.`)
    const lib = [1, 2, 3].map(titled)
    jest.spyOn(knowledge, 'loadSupportLibrary').mockReturnValue(lib)
    const conversation = await openConversation(unknownPhone)
    if (long)
      for (const g of lib) {
        const { messageId } = await admitSupportMessage(input('¿Cómo hago esto?', unknownPhone))
        await prisma.supportMessage.update({
          where: { id: messageId },
          data: { status: 'SENT', answer: 'Respuesta.', sourceIds: [sourceRef(g)] },
        })
      }
    const summary = await buildHumanSummary(conversation.id, conversation.generation)
    expect(summary.length + 2 + SUPPORT_LINK.length > 1500).toBe(long)
    const result = await prisma.$transaction(tx =>
      requestSupportHandoff(tx, conversation, 'REQUESTED', new Date(), getSupportHandoffConfig()!),
    )
    expect(result).toEqual({ text: long ? summary : `${summary}\n\n${SUPPORT_LINK}`, outcome: 'FIXED' })
    // Without room the link is dropped, never the summary.
    expect(result.text.includes(SUPPORT_LINK)).toBe(!long)
    expect(result.text.length).toBeLessThanOrEqual(1500)
    expect(await notices()).toEqual([])
  })

  it('the snapshot is read before the global day lock: only the counts wait for it', async () => {
    const conversation = await openConversation()
    const order: string[] = []
    await prisma.$transaction(tx => {
      const traced = new Proxy(tx, {
        get(target, prop) {
          const value = (target as any)[prop]
          if (prop === '$executeRaw')
            return (strings: TemplateStringsArray, ...values: unknown[]) => {
              if (strings.join('').includes('support-handoff-day')) order.push('day lock')
              return (target as any).$executeRaw(strings, ...values)
            }
          if (prop === 'supportMessage')
            return new Proxy(value, {
              get(model, op) {
                const call = model[op]
                if (op === 'findMany') return (...args: unknown[]) => (order.push('snapshot'), call.apply(model, args))
                return typeof call === 'function' ? call.bind(model) : call
              },
            })
          return typeof value === 'function' ? value.bind(target) : value
        },
      }) as Prisma.TransactionClient
      return requestSupportHandoff(traced, conversation, 'REQUESTED', new Date(), getSupportHandoffConfig()!)
    })
    expect(order).toEqual(['snapshot', 'day lock'])
  })

  it('public help off: an unknown phone never creates a notice (router STATIC and worker fixedReply)', async () => {
    process.env.SUPPORT_PUBLIC_HELP_ENABLED = 'false'
    const event = input('PERSONA', unknownPhone)
    expect(await tryRouteSupport(event)).toBe('QUEUED')
    expect(await reply(event)).toMatchObject({ answer: SUPPORT_UNREGISTERED, outcome: null })
    await markSent((await reply(event)).id)
    // A phone that stops being registered after its message was queued: the fixed message, no model, no notice.
    const id = await enqueue('quiero hablar con una persona', lonePhone)
    await prisma.staff.update({ where: { id: loneId }, data: { active: false } })
    const p = provider([fixed('human')])
    expect(await prepareSupportAnswer((await claim())!, { client: p.client, library })).toBe('READY')
    expect(await saved(id)).toMatchObject({ answer: SUPPORT_UNREGISTERED, outcome: null })
    expect(p.fetcher).not.toHaveBeenCalled()
    expect(await notices()).toEqual([])
    expect(await events()).toEqual([])
  })

  it('the same wamid twice: one message, one notice', async () => {
    const event = input('PERSONA')
    expect(await tryRouteSupport(event)).toBe('QUEUED')
    expect(await tryRouteSupport(event)).toBe('QUEUED')
    expect(await prisma.supportMessage.count({ where: { conversation: { receiverId } } })).toBe(1)
    expect(await notices()).toHaveLength(1)
    expect(await events()).toHaveLength(1)
  })

  it('two PERSONA at once (different wamids, same phone): one notice', async () => {
    await openConversation()
    const [a, b] = [input('PERSONA'), input('PERSONA')]
    expect(await Promise.all([tryRouteSupport(a), tryRouteSupport(b)])).toEqual(['QUEUED', 'QUEUED'])
    expect([(await reply(a)).answer, (await reply(b)).answer].sort()).toEqual([ALREADY, DONE].sort())
    expect(await notices()).toHaveLength(1)
  })

  it('a second PERSONA in the same conversation: already text, no new notice', async () => {
    await openConversation()
    await tryRouteSupport(input('PERSONA'))
    const again = input('PERSONA')
    await tryRouteSupport(again)
    expect(await reply(again)).toMatchObject({ answer: ALREADY, outcome: 'HANDOFF' })
    expect(await notices()).toHaveLength(1)
    expect(await events()).toHaveLength(2)
  })

  it('after APP changes the generation, a new request is a new notice', async () => {
    const conversation = await openConversation()
    await tryRouteSupport(input('PERSONA'))
    const app = input('APP')
    await tryRouteSupport(app)
    expect(await reply(app)).toMatchObject({ answer: SUPPORT_ASK_APP })
    const next = input('PERSONA')
    await tryRouteSupport(next)
    expect(await reply(next)).toMatchObject({ answer: DONE })
    expect((await notices()).map(n => n.dedupeKey)).toEqual([
      `handoff:${conversation.id}:${conversation.generation}`,
      `handoff:${conversation.id}:${(await openOf()).generation}`,
    ])
  })

  it.each([
    ['the 4th request of the same phone in the day', { SUPPORT_HANDOFF_DAILY_CAP: '500' }],
    ['the 21st request overall in the day', { SUPPORT_HANDOFF_PHONE_DAILY_CAP: '50' }],
  ])('%s: HELD and the already text', async (label, env) => {
    Object.assign(process.env, env)
    // A day no other suite can use: their notices (created and deleted in parallel) never enter these counts.
    jest.spyOn(dateKeys, 'venueDayKey').mockReturnValue(`${receiverId}:${label.includes('same phone') ? 'phone' : 'all'}`)
    const mine = supportPhoneHash(receiverId, phone),
      other = supportPhoneHash(receiverId, '+520000000000')
    const counted = { kind: 'HANDOFF' as const, day: today(), status: { not: 'HELD' as const } }
    const missing = label.includes('same phone') ? 3 : Math.max(0, 20 - (await prisma.supportNotice.count({ where: counted })))
    await prisma.supportNotice.createMany({
      data: Array.from({ length: missing }, (_, i) => ({
        kind: 'HANDOFF' as const,
        dedupeKey: `handoff:${receiverId}:fixture:${i}`,
        day: today(),
        phoneHash: label.includes('same phone') ? mine : other,
      })),
    })
    await openConversation()
    const event = input('PERSONA')
    await tryRouteSupport(event)
    expect(await reply(event)).toMatchObject({ answer: ALREADY, outcome: 'HANDOFF' })
    expect(await notices()).toEqual([expect.objectContaining({ status: 'HELD', reason: 'REQUESTED' })])
  })

  it('meta never contains body or answer of any message', async () => {
    const MARK = 'MARCA-PRIVADA-7f3a'
    await openConversation()
    for (const sourceIds of [[sourceRef(products)], ['#clarify', sourceRef(products), sourceRef(inventory)]]) {
      const { messageId } = await admitSupportMessage(input(`Mi caso ${MARK}`))
      await prisma.supportMessage.update({ where: { id: messageId }, data: { status: 'SENT', answer: `Respuesta ${MARK}`, sourceIds } })
    }
    await tryRouteSupport(input('PERSONA'))
    const [notice] = await notices()
    // Titles of what the assistant tried, newest answer first (the clarification offered both).
    expect((notice.meta as unknown as HandoffMeta).guides).toEqual([products.title, inventory.title])
    expect(JSON.stringify(notice)).not.toContain(MARK)
    expect(JSON.stringify(await events())).not.toContain(MARK)
  })
})

describe('worker', () => {
  it('understand → human: handoff in the save transaction, no draft call', async () => {
    const { result, p, message } = await ask([fixed('human')], 'quiero hablar con alguien')
    expect(result).toBe('READY')
    expect(p.fetcher).toHaveBeenCalledTimes(1)
    expect(message).toMatchObject({ answer: DONE, outcome: 'HANDOFF', sourceIds: [], accessFingerprint: expect.any(String) })
    expect(await notices()).toEqual([expect.objectContaining({ status: 'PENDING', reason: 'REQUESTED', staffId })])
    expect(await events()).toEqual([expect.objectContaining({ kind: 'HANDOFF', sequence: message.sequence })])
  })

  it('completeClaim lost (lease expired): no notice left behind', async () => {
    loseEveryClaim()
    const { result, message } = await ask([fixed('human')], 'quiero hablar con alguien')
    expect(result).toBe('CANCELLED')
    expect(message).toMatchObject({ status: 'CLAIMED', answer: null, outcome: null })
    expect(await notices()).toEqual([])
    expect(await events()).toEqual([])
  })

  it('first failure: no offer; second failure in a row: the fixed short text, nearest guide and the offer, handoffOffered', async () => {
    const { first, second } = await offered()
    expect(first.message).toMatchObject({ answer: SUPPORT_HYBRID_UNKNOWN, outcome: 'UNKNOWN', handoffOffered: false })
    expect(second.p.fetcher).toHaveBeenCalledTimes(3)
    expect(second.message).toMatchObject({
      answer: secondFailureText(products),
      outcome: 'JUDGE_LITERAL',
      handoffOffered: true,
      sourceIds: [sourceRef(products)],
    })
    expect(await notices()).toEqual([])
  })

  it('second failure whose literal guide is ~1,500 chars still ends with the offer and fits', async () => {
    // T-F5: the literal prints the whole guide, so the long part is its body (its «## Pasos»), not only `steps`: ~1,412 chars.
    const steps = Array.from({ length: 6 }, (_, i) => `Paso ${i + 1}: ${'p'.repeat(180)}`)
    const long = { ...products, steps, body: `${products.body}\n\n## Pasos\n${steps.map((st, i) => `${i + 1}. ${st}`).join('\n')}` }
    const lib = [long, inventory]
    const first = await ask([question, goodDraft, rejected], undefined, { lib })
    expect(first.message.answer).toBe(literalSupportAnswer([long], null))
    expect(first.message.answer!.length).toBeGreaterThan(1300)
    await markSent(first.id)
    const { message } = await ask([question, goodDraft, rejected], undefined, { lib })
    expect(message.answer!.endsWith(SUPPORT_HANDOFF_OFFER)).toBe(true)
    expect(message.answer!.length).toBeLessThanOrEqual(1500)
    expect(message).toMatchObject({ handoffOffered: true })
  })

  it('a failure after a handoff already exists: no offer', async () => {
    await openConversation()
    const persona = input('PERSONA')
    await tryRouteSupport(persona)
    await markSent((await reply(persona)).id)
    const first = await ask([fixed('unknown')], '¿Puedo pagar la nómina?')
    await markSent(first.id)
    const { message } = await ask([question, goodDraft, rejected])
    expect(message).toMatchObject({ answer: literalSupportAnswer([products], null), outcome: 'JUDGE_LITERAL', handoffOffered: false })
    expect(await notices()).toHaveLength(1)
  })

  it('yes after the offer: handoff with reason TWO_FAILURES, zero model calls', async () => {
    const { second } = await offered()
    await markSent(second.id)
    const yes = await ask([], 'Sí, por favor')
    expect(yes.result).toBe('READY')
    expect(yes.p.fetcher).not.toHaveBeenCalled()
    expect(yes.message).toMatchObject({ answer: DONE, outcome: 'HANDOFF', sourceIds: [] })
    expect(await notices()).toEqual([expect.objectContaining({ status: 'PENDING', reason: 'TWO_FAILURES' })])
  })

  it('a yes after a normal answer runs the normal chain', async () => {
    const answer = await ask([question, goodDraft, supported])
    expect(answer.message).toMatchObject({ outcome: 'ANSWERED', handoffOffered: false })
    await markSent(answer.id)
    const yes = await ask([fixed('greeting')], 'sí')
    expect(yes.p.fetcher).toHaveBeenCalledTimes(1)
    expect(yes.message).toMatchObject({ answer: SUPPORT_THANKS, outcome: 'FIXED' })
    expect(await notices()).toEqual([])
  })

  it('«no» after the offer runs the normal chain', async () => {
    const { second } = await offered()
    await markSent(second.id)
    const no = await ask([fixed('greeting')], 'no')
    expect(no.p.fetcher).toHaveBeenCalledTimes(1)
    expect(no.message).toMatchObject({ answer: SUPPORT_THANKS, handoffOffered: false })
    expect(await notices()).toEqual([])
  })

  it('old-version reply carries the offer and fits 1,500; «sí» hands off with reason OLD_VERSION', async () => {
    const long = { ...tip, steps: Array.from({ length: 6 }, (_, i) => `Paso ${i + 1}: ${'p'.repeat(200)}`) }
    const lib = [products, inventory, pax, long]
    const { id, p, message } = await ask([tipQuestion], '¿Cómo agrego propina?', { data: oldVersion, lib })
    expect(p.fetcher).toHaveBeenCalledTimes(1)
    expect(message).toMatchObject({
      answer: literalSupportAnswer([long], null, `${supportOldVersion('2.19.0')}\n\n${SUPPORT_HANDOFF_OFFER}`),
      outcome: 'OLD_VERSION',
      handoffOffered: true,
      sourceIds: [sourceRef(long)],
    })
    expect(message.answer).toContain(SUPPORT_HANDOFF_OFFER)
    expect(message.answer!.length).toBeLessThanOrEqual(1500)
    // With the offer the steps no longer fit: the literal guide shrank to its summary.
    expect(message.answer).not.toContain('Paso 1:')
    await markSent(id)
    const yes = await ask([], 'sí', { data: oldVersion, lib })
    expect(yes.p.fetcher).not.toHaveBeenCalled()
    expect(yes.message).toMatchObject({ answer: DONE, outcome: 'HANDOFF' })
    expect(await notices()).toEqual([expect.objectContaining({ reason: 'OLD_VERSION' })])
  })

  it('public help off: old version from an unknown phone: no offer', async () => {
    process.env.SUPPORT_PUBLIC_HELP_ENABLED = 'false'
    // Registered when the message was queued, unknown by the time the answer is saved.
    const { message } = await ask([tipQuestion], '¿Cómo agrego propina?', {
      from: lonePhone,
      data: oldVersion,
      onCall: async n => {
        if (n === 1) await prisma.staff.update({ where: { id: loneId }, data: { active: false } })
      },
    })
    expect(message).toMatchObject({
      answer: literalSupportAnswer([tip], null, supportOldVersion('2.19.0')),
      outcome: 'OLD_VERSION',
      handoffOffered: false,
    })
    expect(message.answer).not.toContain(SUPPORT_HANDOFF_OFFER)
  })

  // Every row has its four values: with fewer, Jest would take the last parameter for `done`.
  it.each<[string, Reply[], string[], { app?: string; appVersion?: string; deviceFamily?: string }]>([
    ['ANSWERED', [question, goodDraft, supported], [products.id], {}],
    ['LITERAL', [question, badQuote], [products.id], {}],
    ['JUDGE_LITERAL', [question, goodDraft, rejected], [products.id], {}],
    // covered:false: the drafted guide is counted, though the answer cites none (T5-c1).
    ['UNKNOWN', [question, uncovered], [products.id], {}],
    ['CLARIFIED', [clarify(products.id, inventory.id)], [products.id, inventory.id], {}],
    ['FIXED', [fixed('greeting')], [], {}],
    ['ASKED', [{ kind: 'question', standalone: '¿Cómo cobro con tarjeta?', guideIds: [pax.id] }], [], { app: 'tpv' }],
    ['OLD_VERSION', [tipQuestion], [tip.id], oldVersion],
  ])('every hybrid answer writes one SupportEvent with its outcome and guide ids (%s)', async (outcome, replies, guideIds, data) => {
    const { result, message } = await ask(replies, undefined, { data })
    expect(result).toBe('READY')
    expect(message.outcome).toBe(outcome)
    expect(await events()).toEqual([
      expect.objectContaining({
        kind: outcome,
        app: data.app ?? 'dashboard',
        guideIds,
        conversationId: message.conversationId,
        generation: message.generation,
        sequence: message.sequence,
        day: today(),
      }),
    ])
  })

  it('an UNKNOWN from covered:false: the event names the drafted guide, the saved answer cites none (T5-c1)', async () => {
    const { message } = await ask([question, uncovered])
    expect(message).toMatchObject({ answer: SUPPORT_HYBRID_UNKNOWN, outcome: 'UNKNOWN', handoffOffered: false, sourceIds: [] })
    expect(await events()).toEqual([expect.objectContaining({ kind: 'UNKNOWN', guideIds: [products.id] })])
  })

  it('a second failure from covered:false offers a person, shows the drafted guide as «Lo más cercano», cites it and fits (R2-02, T5-c5)', async () => {
    const first = await ask([fixed('unknown')], '¿Puedo pagar la nómina?')
    await markSent(first.id)
    const { message } = await ask([question, uncovered])
    expect(message).toMatchObject({
      answer: secondFailureText(products),
      outcome: 'UNKNOWN',
      handoffOffered: true,
      sourceIds: [sourceRef(products)],
    })
    expect(message.answer).toContain(`Lo más cercano: ${products.title} ${products.publicUrl}`)
    expect(message.answer!.length).toBeLessThanOrEqual(1500)
    expect((await events()).map(e => e.guideIds)).toEqual([[], [products.id]])
  })

  // T-F5 (P3 on the handoff path): the second-failure text names only «Lo más cercano», the first guide tried, so that is its
  // only source (a later RECUPERAR never brings back a guide it did not show); the event still counts both guides tried.
  it('a second failure with two drafted guides cites only the nearest one it shows; the event still counts both (T-F5)', async () => {
    const first = await ask([fixed('unknown')], '¿Puedo pagar la nómina?')
    await markSent(first.id)
    const { message } = await ask([{ ...question, guideIds: [products.id, inventory.id] }, goodDraft, rejected])
    expect(message).toMatchObject({
      answer: secondFailureText(products),
      outcome: 'JUDGE_LITERAL',
      handoffOffered: true,
      sourceIds: [sourceRef(products)],
    })
    expect(message.answer).not.toContain(inventory.title)
    expect((await events()).map(e => e.guideIds)).toEqual([[], [products.id, inventory.id]])
  })

  it.each([
    ['set', true],
    ['unset', false],
  ])('an empty library goes through the second-failure rule, handoff email %s (T5-c2)', async (_label, configured) => {
    if (!configured) delete process.env.SUPPORT_HANDOFF_EMAIL_TO
    const first = await ask([], undefined, { lib: [] })
    expect(first.message).toMatchObject({ answer: SUPPORT_HYBRID_UNKNOWN, outcome: 'UNKNOWN', handoffOffered: false })
    await markSent(first.id)
    const second = await ask([], undefined, { lib: [] })
    expect(second.p.fetcher).not.toHaveBeenCalled()
    expect(second.message).toMatchObject(
      configured
        ? { answer: secondFailureText(null), outcome: 'UNKNOWN', handoffOffered: true, sourceIds: [] }
        : { answer: SUPPORT_HYBRID_UNKNOWN, outcome: 'UNKNOWN', handoffOffered: false, sourceIds: [] },
    )
    // Through finish: the claim is read again and the fingerprint is saved.
    expect(second.message.accessFingerprint).toEqual(expect.any(String))
  })

  it('no SupportEvent if completeClaim lost', async () => {
    loseEveryClaim()
    const { result } = await ask([question, goodDraft, supported])
    expect(result).toBe('CANCELLED')
    expect(await events()).toEqual([])
  })

  it('a message processed, then reclaimed and processed again, ends with one event', async () => {
    const id = await enqueue()
    const first = (await claim())!
    let retaken: string | undefined
    const p = provider([fixed('greeting')], async n => {
      if (n !== 1) return
      // Meanwhile its lease ran out and another worker retook the message and answered it.
      const second = { ...first, claimToken: 'retaken-by-another-worker', leaseUntil: new Date(Date.now() + 60_000) }
      await prisma.supportMessage.update({ where: { id }, data: { claimToken: second.claimToken, leaseUntil: second.leaseUntil } })
      retaken = await prepareSupportAnswer(second, { library: [] })
    })
    expect(await prepareSupportAnswer(first, { client: p.client, library })).toBe('CANCELLED')
    expect(retaken).toBe('READY')
    expect(await events()).toEqual([expect.objectContaining({ kind: 'UNKNOWN' })])
    // The ready answer claimed once more (delivery's turn) adds nothing either.
    expect(await prepareSupportAnswer((await claim())!, { library })).toBe('READY')
    expect(await events()).toHaveLength(1)
    expect(await saved(id)).toMatchObject({ answer: SUPPORT_HYBRID_UNKNOWN, outcome: 'UNKNOWN' })
  })
})

describe('without the handoff', () => {
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

  it("handoff email unset (hybrid on): PERSONA, human and failures send exactly today's texts, no notice rows, no offer", async () => {
    delete process.env.SUPPORT_HANDOFF_EMAIL_TO
    await openConversation()
    const persona = input('PERSONA')
    await tryRouteSupport(persona)
    const summary = await reply(persona)
    expect(summary.answer).toBe(await buildHumanSummary(summary.conversationId, summary.generation))
    expect(summary.outcome).toBeNull()
    await markSent(summary.id)
    const human = await ask([fixed('human')], 'quiero hablar con alguien')
    expect(human.message.answer).toBe(await buildHumanSummary(human.message.conversationId, human.message.generation, undefined, library))
    expect(human.message).toMatchObject({ outcome: 'FIXED', handoffOffered: false })
    await markSent(human.id)
    const first = await ask([fixed('unknown')], '¿Puedo pagar la nómina?')
    await markSent(first.id)
    const { message } = await ask([question, goodDraft, rejected])
    expect(message).toMatchObject({ answer: literalSupportAnswer([products], null), outcome: 'JUDGE_LITERAL', handoffOffered: false })
    expect(await notices()).toEqual([])
  })

  it('hybrid off: identical to today, no events', async () => {
    process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED = 'false'
    await openConversation()
    const persona = input('PERSONA')
    await tryRouteSupport(persona)
    const summary = await reply(persona)
    expect(summary).toMatchObject({ answer: await buildHumanSummary(summary.conversationId, summary.generation), outcome: null })
    await markSent(summary.id)
    const id = await enqueue('Crear productos')
    const p = provider([{ sectionIds: [section.id], needsClarification: false }])
    expect(await prepareSupportAnswer((await claim())!, { client: p.client, sections: [section], library })).toBe('READY')
    expect(await saved(id)).toMatchObject({ answer: composeSupportAnswer([section], null), outcome: null, handoffOffered: false })
    expect(await notices()).toEqual([])
    expect(await events()).toEqual([])
  })
})
