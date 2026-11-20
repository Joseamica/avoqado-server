import prisma from '@/utils/prismaClient'
import { closeIdleSupport, inheritSupportMemory, tryRouteSupport } from '@/services/support/router.service'
import { admitSupportMessage, claimNext, completeClaim } from '@/services/support/store.service'
import crypto from 'crypto'
import { deliverSupportMessage } from '@/services/support/delivery.service'
import { requestLink, verifyLink } from '@/services/support/link.service'
import { resolveRegisteredSupportPhone } from '@/services/support/registeredPhone.service'
import {
  SUPPORT_ASK_APP,
  SUPPORT_GREETING,
  SUPPORT_LINK,
  SUPPORT_NOTICE,
  SUPPORT_NOTICE_DATA_FREE_TEXT,
  SUPPORT_NOTICE_FREE_TEXT,
  SUPPORT_UNREGISTERED,
  supportNotice,
} from '@/services/support/texts'

const receiverId = `support-admission-${Date.now()}`
const phone = '+525500002001'
const input = (id: string, body: string, extra = {}) => ({
  receiverId,
  wamid: `${receiverId}-${id}`,
  phone,
  body,
  type: 'text',
  timestamp: String(Math.floor(Date.now() / 1000)),
  ...extra,
})
beforeAll(() => {
  process.env.SUPPORT_WHATSAPP_ENABLED = 'true'
  process.env.SUPPORT_WHATSAPP_ENC_KEY = 'e'.repeat(64)
  process.env.SUPPORT_WHATSAPP_PHONE_NUMBER_ID = receiverId
  process.env.WHATSAPP_SALES_PHONE_NUMBER_ID = 'sales-only'
})
beforeEach(async () => {
  await prisma.supportBudget.deleteMany({ where: { key: { startsWith: `CONTROL:${receiverId}:` } } })
  await prisma.supportAttempt.deleteMany({ where: { message: { conversation: { receiverId } } } })
  await prisma.supportMessage.deleteMany({ where: { conversation: { receiverId } } })
  await prisma.supportConversation.deleteMany({ where: { receiverId } })
  await prisma.whatsappInboundEvent.deleteMany({ where: { receiverId } })
})
afterAll(async () => {
  delete process.env.SUPPORT_WHATSAPP_ENABLED
  await prisma.supportAttempt.deleteMany({ where: { message: { conversation: { receiverId } } } })
  await prisma.supportMessage.deleteMany({ where: { conversation: { receiverId } } })
  await prisma.supportConversation.deleteMany({ where: { receiverId } })
  await prisma.whatsappInboundEvent.deleteMany({ where: { receiverId } })
  await prisma.supportBudget.deleteMany({ where: { key: { startsWith: `CONTROL:${receiverId}:` } } })
})
const conversation = () => prisma.supportConversation.findFirstOrThrow({ where: { receiverId, phone, mode: { not: 'CLOSED' } } })

it('queues consent notice before returning, stores only minimal event data and keeps legacy contact-window untouched', async () => {
  const event = input('notice', 'AYUDA')
  expect(await tryRouteSupport(event)).toBe('QUEUED')
  const stored = await prisma.whatsappInboundEvent.findUniqueOrThrow({ where: { wamid: event.wamid }, include: { supportMessage: true } })
  expect(stored).toMatchObject({ routedAs: 'SUPPORT_QUEUED', rawBody: { id: event.wamid, type: 'text', timestamp: event.timestamp } })
  expect(stored.rawBody).not.toHaveProperty('body')
  expect(stored.supportMessage).toMatchObject({ status: 'ANSWER_READY', answer: expect.stringContaining('CONTINUAR') })
  expect(await conversation()).toMatchObject({ noticeAcceptedAt: null, mode: 'PUBLIC', staffId: null })
  expect(await prisma.whatsappContactWindow.findUnique({ where: { phone } })).toBeNull()
})
it('requires consent and an explicit app choice; never interprets an ordinary number as a business id', async () => {
  await tryRouteSupport(input('start', 'AYUDA'))
  await tryRouteSupport(input('before-consent', '¿Cómo cobro?'))
  expect(
    (await prisma.supportMessage.findFirstOrThrow({ where: { inboundEvent: { wamid: `${receiverId}-before-consent` } } })).status,
  ).toBe('ANSWER_READY')
  await tryRouteSupport(input('consent', 'CONTINUAR'))
  expect(await conversation()).toMatchObject({ pendingSelection: 'APP', noticeAcceptedAt: expect.any(Date) })
  await tryRouteSupport(input('app', '2'))
  expect(await conversation()).toMatchObject({ app: 'android', pendingSelection: null })
  await tryRouteSupport(input('question', '¿Cómo cobro?'))
  expect((await prisma.supportMessage.findFirstOrThrow({ where: { inboundEvent: { wamid: `${receiverId}-question` } } })).status).toBe(
    'QUEUED',
  )
  await tryRouteSupport(input('normal-number', '123456789'))
  expect(await conversation()).toMatchObject({ venueId: null, app: 'android' })
})

it('persists an APP selector when a linked person chooses a venue before choosing an app', async () => {
  const org = await prisma.organization.create({
    data: { name: 'Selector fixture', email: `${receiverId}-order@test.local`, phone: '0000000000' },
  })
  const venue = await prisma.venue.create({
    data: { organizationId: org.id, name: 'Sucursal fixture', slug: `${receiverId}-order`, status: 'ACTIVE' },
  })
  const staff = await prisma.staff.create({ data: { email: `${receiverId}-order@test.local`, firstName: 'Selector', lastName: 'Prueba' } })
  try {
    await prisma.staffVenue.create({ data: { staffId: staff.id, venueId: venue.id, role: 'VIEWER' } })
    await prisma.supportWhatsappLink.create({ data: { staffId: staff.id, phone, expiresAt: new Date(Date.now() + 86400000) } })
    await tryRouteSupport(input('order-start', 'AYUDA'))
    await tryRouteSupport(input('order-continue', 'CONTINUAR'))
    await tryRouteSupport(input('order-venue', 'SUCURSAL'))
    await tryRouteSupport(input('order-choice', '1'))
    expect(await conversation()).toMatchObject({
      app: null,
      venueId: venue.id,
      pendingSelection: 'APP',
      selectionOptions: { items: expect.any(Array) },
      selectionExpiresAt: expect.any(Date),
    })
    await tryRouteSupport(input('order-app', '2'))
    expect(await conversation()).toMatchObject({ app: 'android' })
  } finally {
    await prisma.supportMessage.deleteMany({ where: { conversation: { receiverId } } })
    await prisma.supportConversation.deleteMany({ where: { receiverId } })
    await prisma.supportWhatsappLink.deleteMany({ where: { staffId: staff.id } })
    await prisma.staffVenue.deleteMany({ where: { staffId: staff.id } })
    await prisma.staff.delete({ where: { id: staff.id } })
    await prisma.venue.delete({ where: { id: venue.id } })
    await prisma.organization.delete({ where: { id: org.id } })
  }
})
it('SALIR is an immediate generation barrier for a previously claimed answer', async () => {
  await tryRouteSupport(input('start', 'AYUDA'))
  const first = await claimNext(new Date(Date.now() + 1_000), receiverId)
  expect(first).not.toBeNull()
  await tryRouteSupport(input('exit', 'SALIR'))
  expect(await completeClaim(first!, { status: 'SENT' })).toBe(false)
  const closed = await prisma.supportConversation.findFirstOrThrow({ where: { receiverId, phone } })
  expect(closed).toMatchObject({ mode: 'CLOSED', staffId: null, linkId: null })
  expect(
    await prisma.supportMessage.count({ where: { conversationId: closed.id, status: { in: ['QUEUED', 'CLAIMED', 'ANSWER_READY'] } } }),
  ).toBe(0)
})
it('a replay never refreshes the service clock or changes its committed destination', async () => {
  const event = input('duplicate', 'AYUDA', { timestamp: String(Math.floor((Date.now() - 60_000) / 1000)) })
  await tryRouteSupport(event)
  const before = await conversation()
  await tryRouteSupport({ ...event, timestamp: String(Math.floor(Date.now() / 1000)), body: 'SALIR' })
  expect(await conversation()).toMatchObject({ lastUserMessageAt: before.lastUserMessageAt, generation: before.generation, mode: 'PUBLIC' })
  expect(await prisma.supportMessage.count({ where: { conversationId: before.id } })).toBe(1)
})
it('old or invalid timestamps cannot reopen a support window, and unsupported content never queues AI', async () => {
  expect(await tryRouteSupport(input('old', 'AYUDA', { timestamp: String(Math.floor((Date.now() - 31 * 86400_000) / 1000)) }))).toBe(
    'IGNORED',
  )
  await tryRouteSupport(input('invalid', 'AYUDA', { timestamp: 'nonsense' }))
  expect((await conversation()).lastUserMessageAt).toBeNull()
  await tryRouteSupport(input('reaction', '', { type: 'reaction' }))
  await tryRouteSupport(input('audio', '', { type: 'audio' }))
  const audio = await prisma.supportMessage.findFirstOrThrow({ where: { inboundEvent: { wamid: `${receiverId}-audio` } } })
  expect(audio.status).toBe('ANSWER_READY')
  expect(await prisma.supportMessage.count({ where: { conversation: { receiverId }, status: 'QUEUED' } })).toBe(0)
})
// T-F15: on the support's own number ACTIVAR is plain text (without free text and without a conversation: ignored and recorded);
// an event this number already stored under a non-support route keeps answering what it stored (idempotency).
it('T-F15: ACTIVAR is plain text on the support number; an already-owned legacy event keeps its route', async () => {
  expect(await tryRouteSupport(input('activation', 'ACTIVAR ABCDEF123456'))).toBe('IGNORED')
  expect(await prisma.whatsappInboundEvent.findUnique({ where: { wamid: `${receiverId}-activation` } })).toMatchObject({
    routedAs: 'SUPPORT_IGNORED',
    rawBody: { id: `${receiverId}-activation`, type: 'text' },
  })
  await prisma.whatsappInboundEvent.create({
    data: {
      wamid: `${receiverId}-legacy`,
      fromPhone: phone,
      receiverId,
      messageType: 'text',
      rawBody: {},
      routedAs: 'VENUE_REPLY_NO_CONTEXT',
    },
  })
  expect(await tryRouteSupport(input('legacy', 'AYUDA'))).toBe('LEGACY')
  expect(await prisma.supportMessage.count({ where: { conversation: { receiverId } } })).toBe(0)
})
it('support quotes from a different phone cannot borrow its personal context', async () => {
  const old = await admitSupportMessage(input('private', 'Pregunta'))
  await prisma.supportMessage.update({
    where: { id: old.messageId },
    data: { outboundWamid: `${receiverId}-outbound`, status: 'SENT', answer: 'Respuesta pública' },
  })
  expect(await tryRouteSupport(input('foreign-quote', 'Sí', { phone: '+525500002002', contextId: `${receiverId}-outbound` }))).toBe(
    'QUEUED',
  )
  const foreign = await prisma.supportConversation.findFirstOrThrow({
    where: { receiverId, phone: '+525500002002', mode: { not: 'CLOSED' } },
  })
  expect(foreign).toMatchObject({ staffId: null, venueId: null, noticeAcceptedAt: null })
  expect((await prisma.supportMessage.findFirstOrThrow({ where: { conversationId: foreign.id } })).answer).toContain('AYUDA')
})

it('caps responses at ten per minute, keeps ignored dedupe, and SALIR still closes the chat', async () => {
  await tryRouteSupport(input('limit-start', 'AYUDA'))
  await tryRouteSupport(input('limit-consent', 'CONTINUAR'))
  await tryRouteSupport(input('limit-app', '2'))
  for (let i = 0; i < 8; i++) await tryRouteSupport(input(`limit-${i}`, '¿Cómo cobro?'))
  expect(await prisma.supportMessage.count({ where: { conversation: { receiverId } } })).toBe(10)
  expect(await prisma.whatsappInboundEvent.findUnique({ where: { wamid: `${receiverId}-limit-7` } })).toMatchObject({
    routedAs: 'SUPPORT_IGNORED',
  })
  await tryRouteSupport(input('limit-exit', 'SALIR'))
  expect(await prisma.supportConversation.count({ where: { receiverId, phone, mode: 'CLOSED' } })).toBe(1)
})

it('expired choices are not applied and changing app fences all old work', async () => {
  await tryRouteSupport(input('choice-start', 'AYUDA'))
  await tryRouteSupport(input('choice-consent', 'CONTINUAR'))
  const before = await conversation()
  await prisma.supportConversation.update({ where: { id: before.id }, data: { selectionExpiresAt: new Date(Date.now() - 1) } })
  await tryRouteSupport(input('choice-expired', '2'))
  expect(await conversation()).toMatchObject({ app: null, pendingSelection: null })
  await tryRouteSupport(input('choice-reset', 'APP'))
  expect((await conversation()).generation).toBeGreaterThan(before.generation)
  expect(
    await prisma.supportMessage.count({
      where: { conversationId: before.id, generation: before.generation, status: { in: ['QUEUED', 'CLAIMED', 'ANSWER_READY'] } },
    }),
  ).toBe(0)
})

it('accepting a new app choice fences any old claimed output, including the preceding selector', async () => {
  await tryRouteSupport(input('app-fence-start', 'AYUDA'))
  await tryRouteSupport(input('app-fence-consent', 'CONTINUAR'))
  const before = await conversation()
  const claim = await claimNext(new Date(Date.now() + 1_000), receiverId)
  expect(claim).not.toBeNull()
  await tryRouteSupport(input('app-fence-choice', '2'))
  expect(await completeClaim(claim!, { status: 'SENT' })).toBe(false)
  expect((await conversation()).generation).toBeGreaterThan(before.generation)
})

it('idle closure preserves a saved public guide for explicit recovery, while starting a fresh conversation', async () => {
  const admitted = await admitSupportMessage(input('idle-saved', 'Pregunta'))
  const before = await conversation()
  await prisma.supportMessage.update({
    where: { id: admitted.messageId },
    data: { status: 'SENT', answer: 'Guía guardada', sourceIds: ['dashboard/inicio/iniciar-sesion'] },
  })
  await prisma.supportConversation.update({ where: { id: before.id }, data: { lastActivityAt: new Date(Date.now() - 1801_000) } })
  await tryRouteSupport(input('idle-new', 'AYUDA'))
  expect((await conversation()).id).not.toBe(before.id)
  expect(await prisma.supportMessage.findUnique({ where: { id: admitted.messageId } })).toMatchObject({
    answer: 'Guía guardada',
    sourceIds: ['dashboard/inicio/iniciar-sesion'],
  })
  expect(await prisma.supportConversation.findUnique({ where: { id: before.id } })).toMatchObject({ mode: 'CLOSED' })
})

describe('free text without commands (SUPPORT_WHATSAPP_FREE_TEXT_ENABLED)', () => {
  const employee = '+525500002011'
  let orgId: string, venueId: string, staffId: string, unphonedId: string
  const relayVenueIds: string[] = []
  let accessToken: string | undefined
  const reply = (id: string) => prisma.supportMessage.findFirstOrThrow({ where: { inboundEvent: { wamid: `${receiverId}-${id}` } } })
  const open = (p: string) => prisma.supportConversation.findFirst({ where: { receiverId, phone: p, mode: { not: 'CLOSED' } } })
  const attempts = () => prisma.supportAttempt.count({ where: { message: { conversation: { receiverId } } } })
  const hash = (p: string) => crypto.createHash('sha256').update(p).digest('hex')
  const as = (p: string, extra = {}) => ({ phone: p, ...extra })
  async function relay(status?: 'OPEN' | 'CLOSED_BY_INACTIVITY') {
    const venue = await prisma.venue.create({
      data: {
        organizationId: orgId,
        name: 'Relay fixture',
        slug: `${receiverId}-relay-${relayVenueIds.length}`,
        status: 'ACTIVE',
        whatsappContactMode: 'RELAY',
        whatsappOptInPhone: employee,
      },
    })
    relayVenueIds.push(venue.id)
    if (status)
      await prisma.venueChatSession.create({
        data: {
          venueId: venue.id,
          shortCode: `R${relayVenueIds.length}`,
          customerName: 'Cliente',
          requestFingerprintHash: 'fake',
          accessTokenHash: 'fake',
          status,
          ...(status === 'OPEN' ? {} : { closedAt: new Date() }),
        },
      })
  }
  async function seedMinuteCap(p: string) {
    const minute = Math.floor(Date.now() / 60_000) * 60_000
    for (const start of [minute, minute + 60_000]) {
      const key = `CONTROL:${receiverId}:${hash(p)}:${new Date(start).toISOString()}`
      await prisma.supportBudget.upsert({
        where: { key },
        create: { key, windowStart: new Date(start), callCount: 10 },
        update: { callCount: 10 },
      })
    }
    return `CONTROL:${receiverId}:${hash(p)}:${new Date(minute).toISOString()}`
  }
  // A prepared notice only counts as shown once it was delivered.
  const delivered = () =>
    prisma.supportMessage.updateMany({
      where: {
        conversation: { receiverId },
        status: 'ANSWER_READY',
        answer: { in: [SUPPORT_NOTICE, SUPPORT_NOTICE_FREE_TEXT, SUPPORT_NOTICE_DATA_FREE_TEXT] },
      },
      data: { status: 'SENT' },
    })
  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'Free text', email: `${receiverId}-free@test.local`, phone: '0000000000' },
    })
    orgId = org.id
    venueId = (
      await prisma.venue.create({ data: { organizationId: orgId, name: 'Sucursal', slug: `${receiverId}-free`, status: 'ACTIVE' } })
    ).id
    staffId = (await prisma.staff.create({ data: { email: `${receiverId}-free@test.local`, firstName: 'Equipo', lastName: 'Prueba' } })).id
    unphonedId = (
      await prisma.staff.create({ data: { email: `${receiverId}-nophone@test.local`, firstName: 'Sin', lastName: 'Teléfono' } })
    ).id
    await prisma.staffVenue.createMany({
      data: [
        { staffId, venueId, role: 'VIEWER' },
        { staffId: unphonedId, venueId, role: 'VIEWER' },
      ],
    })
  })
  beforeEach(async () => {
    process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED = 'true'
    await prisma.staff.update({ where: { id: staffId }, data: { phone: employee } })
  })
  afterEach(async () => {
    delete process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED
    global.fetch = originalFetch
    await prisma.supportAttempt.deleteMany({ where: { message: { conversation: { receiverId } } } })
    await prisma.supportMessage.deleteMany({ where: { conversation: { receiverId } } })
    await prisma.supportLinkChallenge.deleteMany({ where: { conversation: { receiverId } } })
    await prisma.supportWhatsappLink.deleteMany({ where: { staffId: { in: [staffId, unphonedId] } } })
    await prisma.activityLog.deleteMany({ where: { staffId: { in: [staffId, unphonedId] } } })
    await prisma.venueChatSession.deleteMany({ where: { venueId: { in: relayVenueIds } } })
    await prisma.venue.deleteMany({ where: { id: { in: relayVenueIds } } })
    relayVenueIds.length = 0
  })
  afterAll(async () => {
    if (accessToken === undefined) delete process.env.WHATSAPP_ACCESS_TOKEN
    else process.env.WHATSAPP_ACCESS_TOKEN = accessToken
    if (!orgId) return
    await prisma.staffVenue.deleteMany({ where: { staffId: { in: [staffId, unphonedId] } } })
    await prisma.staff.deleteMany({ where: { id: { in: [staffId, unphonedId] } } })
    await prisma.venue.deleteMany({ where: { organizationId: orgId } })
    await prisma.organization.delete({ where: { id: orgId } })
  })
  const originalFetch = global.fetch
  const fakeSend = () =>
    (global.fetch = jest.fn(
      async () => new Response(JSON.stringify({ messages: [{ id: `wamid.${Date.now()}` }] }), { status: 200 }),
    ) as typeof fetch)
  beforeAll(() => {
    accessToken = process.env.WHATSAPP_ACCESS_TOKEN
    process.env.WHATSAPP_ACCESS_TOKEN = 'fixture-never-used'
  })

  describe('the answer to the version question (R2-07)', () => {
    const topic = '¿Cómo agrego propina?'
    const versionPending = () =>
      prisma.supportConversation.create({
        data: {
          receiverId,
          phone: employee,
          app: 'tpv',
          noticeAcceptedAt: new Date(),
          lastUserMessageAt: new Date(),
          pendingSelection: 'VERSION',
          selectionOptions: { items: [], topic },
          selectionExpiresAt: new Date(Date.now() + 600_000),
        },
      })
    afterEach(() => {
      delete process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED
    })
    it('the router accepts «2.19.0 (130)» as the answer to the version question: appVersion 2.19.0 and the topic is queued again', async () => {
      process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED = 'true'
      const before = await versionPending()
      expect(await tryRouteSupport(input('version-hybrid', '2.19.0 (130)', as(employee)))).toBe('QUEUED')
      expect(await open(employee)).toMatchObject({
        id: before.id,
        appVersion: '2.19.0',
        pendingSelection: null,
        generation: before.generation + 1,
      })
      expect(await reply('version-hybrid')).toMatchObject({ status: 'QUEUED', answer: null, body: topic })
    })
    it("flag off: «2.19.0 (130)» gets today's answer", async () => {
      await versionPending()
      await tryRouteSupport(input('version-off', '2.19.0 (130)', as(employee)))
      expect(await open(employee)).toMatchObject({ appVersion: null, pendingSelection: 'VERSION' })
      expect(await reply('version-off')).toMatchObject({
        status: 'ANSWER_READY',
        answer: 'No encontré esa opción. Responde con el número o el nombre:\n\nO escribe APP o SUCURSAL para cambiar.',
      })
      // And what today accepts is still saved as it was typed.
      await tryRouteSupport(input('version-off-ok', '2.10.1-beta', as(employee)))
      expect(await open(employee)).toMatchObject({ appVersion: '2.10.1-beta', pendingSelection: null })
      expect(await reply('version-off-ok')).toMatchObject({ status: 'QUEUED', body: topic })
    })
  })
  it('T-F15: flag off: free text without a conversation is ignored and stays recorded, with no support rows', async () => {
    delete process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED
    expect(await tryRouteSupport(input('off', '¿Cómo cobro?', as(employee)))).toBe('IGNORED')
    expect(await prisma.whatsappInboundEvent.findUnique({ where: { wamid: `${receiverId}-off` } })).toMatchObject({
      routedAs: 'SUPPORT_IGNORED',
      processedAt: expect.any(Date),
    })
    expect(await prisma.supportConversation.count({ where: { receiverId } })).toBe(0)
    expect(await prisma.supportMessage.count({ where: { conversation: { receiverId } } })).toBe(0)
  })
  it('a registered employee writing free text opens support at the notice', async () => {
    expect(await tryRouteSupport(input('registered', '¿Cómo cobro?', as(employee)))).toBe('QUEUED')
    expect(await open(employee)).toMatchObject({ noticeAcceptedAt: null, staffId: null })
    expect(await reply('registered')).toMatchObject({ answer: SUPPORT_NOTICE_FREE_TEXT, status: 'ANSWER_READY' })
  })
  it('an unknown phone gets the fixed message without AI', async () => {
    expect(await tryRouteSupport(input('unknown', '¿Cómo cobro?'))).toBe('QUEUED')
    expect(await reply('unknown')).toMatchObject({ answer: SUPPORT_UNREGISTERED, status: 'ANSWER_READY', body: '' })
    expect(await attempts()).toBe(0)
  })
  it('an unknown phone gets the fixed message once per day', async () => {
    await tryRouteSupport(input('unknown-1', 'Hola'))
    expect(await tryRouteSupport(input('unknown-2', '¿Me ayudas?'))).toBe('IGNORED')
    expect(await prisma.supportMessage.count({ where: { conversation: { receiverId } } })).toBe(1)
  })
  it('a second message before delivery is ignored without closing, and the pending fixed message is sent once', async () => {
    await tryRouteSupport(input('pending-1', 'Hola'))
    const before = (await open(phone))!
    expect(await tryRouteSupport(input('pending-2', 'Hola otra vez'))).toBe('IGNORED')
    expect((await open(phone))?.id).toBe(before.id)
    fakeSend()
    expect(await deliverSupportMessage((await claimNext(new Date(Date.now() + 1_000), receiverId))!)).toBe('SENT')
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String((global.fetch as jest.Mock).mock.calls[0][1].body)).text.body).toBe(SUPPORT_UNREGISTERED)
    expect(await claimNext(new Date(Date.now() + 1_000), receiverId)).toBeNull()
  })
  // T-F15 (Codex T-F14, P2): whoever also answers customer chats is one more person on the support number.
  it.each([undefined, 'OPEN', 'CLOSED_BY_INACTIVITY'] as const)(
    'T-F15: a registered relay operator (session %s) writing a question enters support at the notice',
    async status => {
      await relay(status)
      expect(await tryRouteSupport(input('relay-text', '¿Cómo agrego un producto?', as(employee)))).toBe('QUEUED')
      expect(await open(employee)).toMatchObject({ noticeAcceptedAt: null })
      expect(await reply('relay-text')).toMatchObject({ answer: SUPPORT_NOTICE_FREE_TEXT, status: 'ANSWER_READY' })
    },
  )
  // T-F15b (Codex T-F15, P2): a shared contact and an «unsupported» message (a poll, a view-once…) are a person writing: the same
  // media answer and the same caps. A reaction and the other system types stay ignored on purpose.
  it('T-F15b: a registered phone without a conversation sharing a contact gets the media answer', async () => {
    expect(await tryRouteSupport(input('contact', '', as(employee, { type: 'contacts' })))).toBe('QUEUED')
    expect(await reply('contact')).toMatchObject({
      status: 'ANSWER_READY',
      body: '',
      answer: expect.stringMatching(/^Por ahora sólo puedo ayudarte con texto/),
    })
  })
  it('T-F15b: an unknown phone sending «unsupported» gets the fixed message, once a day', async () => {
    expect(await tryRouteSupport(input('unsupported-1', '', { type: 'unsupported' }))).toBe('QUEUED')
    expect(await reply('unsupported-1')).toMatchObject({ answer: SUPPORT_UNREGISTERED, body: '' })
    expect(await tryRouteSupport(input('unsupported-2', '', { type: 'contacts' }))).toBe('IGNORED')
    expect(await prisma.supportMessage.count({ where: { conversation: { receiverId } } })).toBe(1)
  })
  it.each(['reaction', 'system', 'button', 'interactive', 'order', 'request_welcome'])(
    'T-F15b: «%s» stays ignored on purpose and opens nothing',
    async type => {
      expect(await tryRouteSupport(input(`ignored-${type}`, '', as(employee, { type })))).toBe('IGNORED')
      expect(await prisma.supportConversation.count({ where: { receiverId } })).toBe(0)
    },
  )
  it('T-F15: a voice note from a registered phone without a conversation gets the media answer', async () => {
    expect(await tryRouteSupport(input('voice', '', as(employee, { type: 'audio' })))).toBe('QUEUED')
    expect(await reply('voice')).toMatchObject({
      status: 'ANSWER_READY',
      body: '',
      answer: expect.stringMatching(/^Por ahora sólo puedo ayudarte con texto/),
    })
  })
  it('T-F15: a voice note from an unknown phone gets the fixed message, once a day', async () => {
    expect(await tryRouteSupport(input('voice-1', '', { type: 'audio' }))).toBe('QUEUED')
    expect(await reply('voice-1')).toMatchObject({ answer: SUPPORT_UNREGISTERED, body: '' })
    expect(await tryRouteSupport(input('voice-2', '', { type: 'audio' }))).toBe('IGNORED')
    expect(await prisma.supportMessage.count({ where: { conversation: { receiverId } } })).toBe(1)
  })
  it.each([phone, employee])('T-F15: a reaction without a conversation opens nothing and spends no fixed message (%s)', async from => {
    expect(await tryRouteSupport(input('reaction', '👍', as(from, { type: 'reaction' })))).toBe('IGNORED')
    expect(await prisma.supportConversation.count({ where: { receiverId } })).toBe(0)
    if (from === phone) {
      expect(await tryRouteSupport(input('after-reaction', 'Hola'))).toBe('QUEUED')
      expect(await reply('after-reaction')).toMatchObject({ answer: SUPPORT_UNREGISTERED })
    }
  })
  it('T-F15: a quote of an old relay message is handled like any quote the support does not know', async () => {
    await relay('OPEN')
    const session = await prisma.venueChatSession.findFirstOrThrow({ where: { venueId: relayVenueIds[0] } })
    await prisma.venueChatMessage.create({
      data: {
        sessionId: session.id,
        direction: 'INBOUND_FROM_CUSTOMER',
        body: 'Pregunta ficticia',
        whatsappMessageId: `${receiverId}-relay-msg`,
      },
    })
    try {
      expect(await tryRouteSupport(input('relay-quote', 'Ya va su pedido', as(employee, { contextId: `${receiverId}-relay-msg` })))).toBe(
        'QUEUED',
      )
      expect((await reply('relay-quote')).answer).toMatch(/^No puedo identificar esa respuesta/)
      expect(await prisma.venueChatMessage.count({ where: { sessionId: session.id } })).toBe(1)
    } finally {
      // The session cleanup below cannot delete a session that still has messages.
      await prisma.venueChatMessage.deleteMany({ where: { sessionId: session.id } })
    }
  })
  it('T-F15: support switched off: a question without a conversation is ignored and stays recorded', async () => {
    process.env.SUPPORT_WHATSAPP_ENABLED = 'false'
    try {
      expect(await tryRouteSupport(input('switched-off', '¿Cómo cobro?', as(employee)))).toBe('IGNORED')
      expect(await prisma.whatsappInboundEvent.findUnique({ where: { wamid: `${receiverId}-switched-off` } })).toMatchObject({
        routedAs: 'SUPPORT_IGNORED',
      })
      expect(await prisma.supportConversation.count({ where: { receiverId } })).toBe(0)
    } finally {
      process.env.SUPPORT_WHATSAPP_ENABLED = 'true'
    }
  })
  it('media from an unknown phone with an open conversation closes it and gets the fixed message', async () => {
    await tryRouteSupport(input('media-help', 'AYUDA'))
    const before = (await open(phone))!
    expect(await tryRouteSupport(input('media-photo', '', { type: 'image' }))).toBe('QUEUED')
    expect(await prisma.supportConversation.findUniqueOrThrow({ where: { id: before.id } })).toMatchObject({ mode: 'CLOSED' })
    expect(await reply('media-photo')).toMatchObject({ answer: SUPPORT_UNREGISTERED, body: '' })
  })
  it.each(['PERSONA', 'REINTENTAR'])('an unknown phone sending %s gets the fixed message without AI', async command => {
    await tryRouteSupport(input('cmd-help', 'AYUDA'))
    expect(await tryRouteSupport(input('cmd', command))).toBe('QUEUED')
    expect(await reply('cmd')).toMatchObject({ answer: SUPPORT_UNREGISTERED, status: 'ANSWER_READY' })
    expect(await attempts()).toBe(0)
  })
  it.each(['CONTINUAR', 'sí'])('an unknown phone accepting the notice with %s gets the link text, without an app selector', async word => {
    await tryRouteSupport(input('accept-help', 'AYUDA'))
    expect(await open(phone)).toMatchObject({ pendingSelection: null })
    expect(await reply('accept-help')).toMatchObject({ answer: SUPPORT_NOTICE_FREE_TEXT })
    await delivered()
    expect(await tryRouteSupport(input('accept', word))).toBe('QUEUED')
    expect(await open(phone)).toMatchObject({ noticeAcceptedAt: expect.any(Date), pendingSelection: null })
    expect(await reply('accept')).toMatchObject({ answer: SUPPORT_LINK })
    expect(await attempts()).toBe(0)
  })
  it.each(['ok', 'CONTINUAR'])('%s after the fixed message is not accepting a notice that was never shown', async word => {
    await tryRouteSupport(input('unseen-first', 'Hola'))
    expect(await tryRouteSupport(input('unseen-accept', word))).toBe('IGNORED')
    expect(await open(phone)).toMatchObject({ noticeAcceptedAt: null, pendingSelection: null })
    expect(await prisma.supportMessage.count({ where: { conversation: { receiverId } } })).toBe(1)
  })
  it('ok after the fixed message, on a day whose cap is free again, gets the fixed message, not the link', async () => {
    await tryRouteSupport(input('unseen-day-first', 'Hola'))
    await prisma.supportBudget.deleteMany({
      where: { key: { contains: ':STATIC:' }, AND: { key: { startsWith: `CONTROL:${receiverId}:` } } },
    })
    expect(await tryRouteSupport(input('unseen-day-accept', 'ok'))).toBe('QUEUED')
    expect(await reply('unseen-day-accept')).toMatchObject({ answer: SUPPORT_UNREGISTERED })
    expect(await open(phone)).toMatchObject({ noticeAcceptedAt: null })
  })
  it('CONTINUAR from an unknown phone without an open conversation gets the fixed message', async () => {
    expect(await tryRouteSupport(input('continue-cold', 'CONTINUAR'))).toBe('QUEUED')
    expect(await reply('continue-cold')).toMatchObject({ answer: SUPPORT_UNREGISTERED })
  })
  it('an unknown employee who accepted the notice can receive a panel code and becomes registered', async () => {
    await tryRouteSupport(input('code-help', 'AYUDA'))
    await delivered()
    await tryRouteSupport(input('code-accept', 'CONTINUAR'))
    await prisma.supportMessage.update({ where: { id: (await reply('code-accept')).id }, data: { status: 'SENT' } })
    const challenge = await requestLink(unphonedId, { phone, operationKey: 'free-text-code' }, { strongAuthAt: new Date() })
    fakeSend()
    expect(await deliverSupportMessage((await claimNext(new Date(Date.now() + 1_000), receiverId))!)).toBe('SENT')
    const sent = JSON.parse(String((global.fetch as jest.Mock).mock.calls[0][1].body)).text.body as string
    const code = sent.match(/\d{6}/)![0]
    expect(await verifyLink(unphonedId, { challengeId: challenge.challengeId, code }, { strongAuthAt: new Date() })).toEqual({
      linked: true,
    })
    expect(await prisma.$transaction(tx => resolveRegisteredSupportPhone(phone, tx))).toMatchObject({ registered: true })
    await tryRouteSupport(input('code-question', '¿Cómo cobro?'))
    expect((await reply('code-question')).answer).not.toBe(SUPPORT_UNREGISTERED)
  })
  it('an unknown phone that accepted the notice and asks a question is closed and gets the fixed message', async () => {
    await tryRouteSupport(input('ask-help', 'AYUDA'))
    await delivered()
    await tryRouteSupport(input('ask-accept', 'sí'))
    const before = (await open(phone))!
    expect(await tryRouteSupport(input('ask', '¿Cómo cobro?'))).toBe('QUEUED')
    expect(await prisma.supportConversation.findUniqueOrThrow({ where: { id: before.id } })).toMatchObject({ mode: 'CLOSED' })
    expect(await reply('ask')).toMatchObject({ answer: SUPPORT_UNREGISTERED, body: '' })
    expect(await attempts()).toBe(0)
  })
  it('an unknown phone that already got the fixed message cannot ask for a person', async () => {
    await tryRouteSupport(input('person-first', 'Hola'))
    const before = (await open(phone))!
    expect(await tryRouteSupport(input('person', 'PERSONA'))).toBe('IGNORED')
    expect(await open(phone)).toMatchObject({ id: before.id, pendingSelection: null })
    expect(await prisma.supportMessage.count({ where: { conversation: { receiverId } } })).toBe(1)
  })
  it('an open public conversation of a phone that stopped being registered is closed and gets the fixed message', async () => {
    await tryRouteSupport(input('gone-help', 'AYUDA', as(employee)))
    const before = (await open(employee))!
    await prisma.staff.update({ where: { id: staffId }, data: { phone: null } })
    expect(await tryRouteSupport(input('gone', '¿Cómo cobro?', as(employee)))).toBe('QUEUED')
    expect(await prisma.supportConversation.findUniqueOrThrow({ where: { id: before.id } })).toMatchObject({ mode: 'CLOSED' })
    expect(await reply('gone')).toMatchObject({ answer: SUPPORT_UNREGISTERED })
  })
  it.each(['ACTIVAR ABCDEF123456', 'DESACTIVAR'])(
    'T-F15: «%s» on the support number is plain support text and the open conversation stays open',
    async body => {
      await tryRouteSupport(input('activate-help', 'AYUDA', as(employee)))
      const before = (await open(employee))!
      expect(await tryRouteSupport(input('activate', body, as(employee)))).toBe('QUEUED')
      expect(await open(employee)).toMatchObject({ id: before.id, mode: 'PUBLIC' })
      expect(await reply('activate')).toMatchObject({ answer: SUPPORT_NOTICE_FREE_TEXT, status: 'ANSWER_READY' })
    },
  )
  it('a relay operator with support opened by AYUDA stays in support', async () => {
    await relay('OPEN')
    await tryRouteSupport(input('relay-open-help', 'AYUDA', as(employee)))
    const before = (await open(employee))!
    expect(await tryRouteSupport(input('relay-open-text', '¿Cómo cobro?', as(employee)))).toBe('QUEUED')
    expect((await open(employee))?.id).toBe(before.id)
  })
  it('a registered relay operator quoting an old support reply is told it cannot be identified', async () => {
    await relay('OPEN')
    const old = await admitSupportMessage(input('old-reply', 'Pregunta', as(employee)))
    await prisma.supportMessage.update({ where: { id: old.messageId }, data: { outboundWamid: `${receiverId}-old-out`, status: 'SENT' } })
    await prisma.supportConversation.updateMany({ where: { receiverId, phone: employee }, data: { mode: 'CLOSED' } })
    expect(await tryRouteSupport(input('old-quote', 'Sí', as(employee, { contextId: `${receiverId}-old-out` })))).toBe('QUEUED')
    expect((await reply('old-quote')).answer).toMatch(/^No puedo identificar esa respuesta/)
  })
  it('SALIR with ten messages already counted this minute still closes and erases memory, without counting', async () => {
    await tryRouteSupport(input('cap-help', 'AYUDA'))
    const before = (await open(phone))!
    const key = await seedMinuteCap(phone)
    expect(await tryRouteSupport(input('cap-exit', 'SALIR'))).toBe('IGNORED')
    expect(await prisma.supportConversation.findUniqueOrThrow({ where: { id: before.id } })).toMatchObject({ mode: 'CLOSED' })
    expect(await prisma.supportMessage.findMany({ where: { conversationId: before.id } })).toEqual([
      expect.objectContaining({ body: '', answer: null }),
    ])
    expect((await prisma.supportBudget.findUniqueOrThrow({ where: { key } })).callCount).toBe(10)
  })
  it('T-F15: flag off: after SALIR a question without a conversation is ignored', async () => {
    delete process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED
    await tryRouteSupport(input('old-cap-help', 'AYUDA'))
    await seedMinuteCap(phone)
    await tryRouteSupport(input('old-cap-exit', 'SALIR'))
    expect(await open(phone)).toBeNull()
    expect(await tryRouteSupport(input('old-cap-text', '¿Cómo cobro?'))).toBe('IGNORED')
  })
  it('SALIR without an open conversation is ignored, creates nothing and erases the last closed memory', async () => {
    const old = await admitSupportMessage(input('memory', 'Pregunta'))
    await prisma.supportMessage.update({
      where: { id: old.messageId },
      data: { status: 'SENT', answer: 'Guía guardada', sourceIds: ['dashboard/inicio/iniciar-sesion'] },
    })
    const closed = (await open(phone))!
    await prisma.supportConversation.update({
      where: { id: closed.id },
      data: { mode: 'CLOSED', app: 'dashboard', noticeAcceptedAt: new Date() },
    })
    expect(await tryRouteSupport(input('cold-exit', 'SALIR'))).toBe('IGNORED')
    expect(await prisma.supportConversation.count({ where: { receiverId, phone } })).toBe(1)
    expect(await prisma.supportConversation.findUniqueOrThrow({ where: { id: closed.id } })).toMatchObject({
      mode: 'CLOSED',
      app: null,
      noticeAcceptedAt: null,
    })
    expect(await prisma.supportMessage.findUniqueOrThrow({ where: { id: old.messageId } })).toMatchObject({ answer: null, sourceIds: [] })
  })
  it('T-F15: SALIR without an open conversation from a relay operator is ignored like anyone else', async () => {
    await relay()
    expect(await tryRouteSupport(input('relay-exit', 'SALIR', as(employee)))).toBe('IGNORED')
  })
  it('SALIR after more than 30 idle minutes leaves nothing for the next question to inherit', async () => {
    const old = await admitSupportMessage(input('idle-memory', 'Pregunta', as(employee)))
    await prisma.supportMessage.update({
      where: { id: old.messageId },
      data: { status: 'SENT', answer: 'Guía guardada', sourceIds: ['dashboard/inicio/iniciar-sesion'] },
    })
    const idle = (await open(employee))!
    await prisma.supportConversation.update({
      where: { id: idle.id },
      data: { noticeAcceptedAt: new Date(), app: 'dashboard', venueId, lastActivityAt: new Date(Date.now() - 1801_000) },
    })
    expect(await tryRouteSupport(input('idle-exit', 'SALIR', as(employee)))).toBe('IGNORED')
    expect(await tryRouteSupport(input('idle-next', '¿Cómo cobro?', as(employee)))).toBe('QUEUED')
    expect(await open(employee)).toMatchObject({ noticeAcceptedAt: null, app: null, venueId: null })
    expect(await reply('idle-next')).toMatchObject({ answer: SUPPORT_NOTICE_FREE_TEXT })
    expect(await prisma.supportConversation.findUniqueOrThrow({ where: { id: idle.id } })).toMatchObject({
      app: null,
      venueId: null,
      noticeAcceptedAt: null,
    })
    expect(await prisma.supportMessage.findUniqueOrThrow({ where: { id: old.messageId } })).toMatchObject({ answer: null, sourceIds: [] })
  })
  it('an unknown phone can still accept a notice shown before the flag was turned on', async () => {
    delete process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED
    await tryRouteSupport(input('old-notice', 'AYUDA'))
    expect(await reply('old-notice')).toMatchObject({ answer: SUPPORT_NOTICE })
    process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED = 'true'
    await delivered()
    expect(await tryRouteSupport(input('old-notice-yes', 'sí'))).toBe('QUEUED')
    expect(await reply('old-notice-yes')).toMatchObject({ answer: SUPPORT_LINK })
  })
  it.each(['ANSWER_READY', 'FAILED'] as const)('«sí» to a notice still %s does not accept it', async status => {
    await tryRouteSupport(input('unsent-q', '¿Cómo cobro?', as(employee)))
    await tryRouteSupport(input('unsent-help', 'AYUDA'))
    await prisma.supportMessage.updateMany({ where: { conversation: { receiverId } }, data: { status } })
    // A registered phone is shown the notice again.
    expect(await tryRouteSupport(input('unsent-yes', 'sí', as(employee)))).toBe('QUEUED')
    expect(await reply('unsent-yes')).toMatchObject({ answer: SUPPORT_NOTICE_FREE_TEXT })
    expect(await open(employee)).toMatchObject({ noticeAcceptedAt: null })
    // An unknown phone gets the fixed message.
    expect(await tryRouteSupport(input('unsent-unknown-yes', 'sí'))).toBe('QUEUED')
    expect(await reply('unsent-unknown-yes')).toMatchObject({ answer: SUPPORT_UNREGISTERED })
  })
  it('a reaction from an unknown phone is ignored without spending the fixed message, and its «sí» still accepts', async () => {
    await tryRouteSupport(input('react-help', 'AYUDA'))
    const before = (await open(phone))!
    expect(await tryRouteSupport(input('react', '👍', { type: 'reaction' }))).toBe('IGNORED')
    expect((await open(phone))?.id).toBe(before.id)
    await delivered()
    expect(await tryRouteSupport(input('react-yes', 'sí'))).toBe('QUEUED')
    expect(await reply('react-yes')).toMatchObject({ answer: SUPPORT_LINK })
  })
  it.each([
    ['a relay operator text', employee, 'text'],
    ['media', phone, 'image'],
  ])('T-F15: %s without a conversation past the per-minute cap is ignored and counted like any message', async (_label, from, type) => {
    if (from === employee) await relay('OPEN')
    const key = await seedMinuteCap(from)
    expect(await tryRouteSupport(input('capped-legacy', 'Ya va su pedido', as(from, { type })))).toBe('IGNORED')
    expect((await prisma.supportBudget.findUniqueOrThrow({ where: { key } })).callCount).toBe(11)
  })
  it('asking for a code after the fixed message says the notice is missing and creates no code', async () => {
    await tryRouteSupport(input('fixed-code', 'Hola'))
    await expect(requestLink(unphonedId, { phone, operationKey: 'after-fixed' }, { strongAuthAt: new Date() })).rejects.toMatchObject({
      code: 'SUPPORT_OPEN_CHAT_FIRST',
      message: expect.stringContaining('acepta el aviso'),
    })
    expect(await prisma.supportLinkChallenge.count({ where: { staffId: unphonedId } })).toBe(0)
  })

  describe('the notice once, and the question survives', () => {
    const day = 86400_000
    // Each reply prepared before the next message was delivered.
    const ask = async (id: string, body: string) => {
      await delivered()
      return tryRouteSupport(input(id, body, as(employee)))
    }
    const expire = () =>
      prisma.supportConversation.updateMany({
        where: { receiverId, phone: employee, mode: { not: 'CLOSED' } },
        data: { selectionExpiresAt: new Date(Date.now() - 1) },
      })
    // An open conversation already past the 30-minute idle limit, so the next message closes it.
    const remembered = (data: Record<string, unknown>) =>
      prisma.supportConversation.create({
        data: { receiverId, phone: employee, lastActivityAt: new Date(Date.now() - 3600_000), ...data },
      })

    it('the notice ends asking for SÍ', () => {
      expect(SUPPORT_NOTICE_FREE_TEXT).toContain('Responde SÍ para continuar o SALIR para terminar.')
      expect(SUPPORT_NOTICE_FREE_TEXT).not.toContain('CONTINUAR')
    })
    it('the first question survives the notice and the app choice, then is queued as the body', async () => {
      await ask('topic-q', '¿cómo cambio de sucursal?')
      expect(await reply('topic-q')).toMatchObject({ answer: SUPPORT_NOTICE_FREE_TEXT, status: 'ANSWER_READY' })
      const waiting = (await open(employee))!
      expect(waiting).toMatchObject({ pendingSelection: 'NOTICE', selectionOptions: { items: [], topic: '¿cómo cambio de sucursal?' } })
      expect(waiting.selectionExpiresAt!.getTime() - Date.now()).toBeGreaterThan(590_000)
      await ask('topic-yes', 'SÍ')
      expect(await reply('topic-yes')).toMatchObject({ answer: SUPPORT_ASK_APP })
      expect(await open(employee)).toMatchObject({ pendingSelection: 'APP', selectionOptions: { topic: '¿cómo cambio de sucursal?' } })
      await ask('topic-app', '1')
      expect(await reply('topic-app')).toMatchObject({ status: 'QUEUED', answer: null, body: '¿cómo cambio de sucursal?' })
      expect(await open(employee)).toMatchObject({ app: 'dashboard', pendingSelection: null, staffId: null })
    })
    it.each(['sí', 'si', 'acepto', 'ok', 'CONTINUAR'])('%s accepts the notice and keeps the question', async word => {
      await ask('word-q', '¿Cómo cobro?')
      await ask('word', word)
      expect(await reply('word')).toMatchObject({ answer: SUPPORT_ASK_APP })
      expect(await open(employee)).toMatchObject({
        noticeAcceptedAt: expect.any(Date),
        pendingSelection: 'APP',
        selectionOptions: { topic: '¿Cómo cobro?' },
      })
    })
    it('a «sí» to the OLD general notice is still an acceptance after data is turned on', async () => {
      await ask('old-general-q', '¿Cómo cobro?')
      expect(await reply('old-general-q')).toMatchObject({ answer: SUPPORT_NOTICE_FREE_TEXT })
      await delivered()
      // The old notice is SENT, and then the B is turned on.
      process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED = 'true'
      process.env.SUPPORT_DATA_ENABLED = 'true'
      try {
        // The B really is on: a notice shown now would be the new one.
        expect(supportNotice()).toBe(SUPPORT_NOTICE_DATA_FREE_TEXT)
        await ask('old-general-yes', 'sí')
        expect(await open(employee)).toMatchObject({ noticeAcceptedAt: expect.any(Date) })
      } finally {
        delete process.env.SUPPORT_DATA_ENABLED
        delete process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED
      }
    })
    it.each([
      ['with data still on', false],
      ['after data is turned off', true],
    ])('a «sí» to the NEW general notice is an acceptance, %s', async (_name, turnOff) => {
      process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED = 'true'
      process.env.SUPPORT_DATA_ENABLED = 'true'
      try {
        await ask('new-general-q', '¿Cómo cobro?')
        expect(await reply('new-general-q')).toMatchObject({ answer: SUPPORT_NOTICE_DATA_FREE_TEXT })
        await delivered()
        if (turnOff) {
          delete process.env.SUPPORT_DATA_ENABLED
          // The B really is off: a notice shown now would be the one of phase 1.
          expect(supportNotice()).toBe(SUPPORT_NOTICE_FREE_TEXT)
        }
        await ask('new-general-yes', 'sí')
        expect(await reply('new-general-yes')).toMatchObject({ answer: SUPPORT_ASK_APP })
        expect(await open(employee)).toMatchObject({ noticeAcceptedAt: expect.any(Date), pendingSelection: 'APP' })
      } finally {
        delete process.env.SUPPORT_DATA_ENABLED
        delete process.env.SUPPORT_WHATSAPP_HYBRID_ENABLED
      }
    })
    it('a sentence starting with sí does not accept, and becomes the pending question', async () => {
      await ask('sentence-q', '¿Cómo cobro?')
      await ask('sentence', 'sí quiero saber cómo cobrar')
      expect(await reply('sentence')).toMatchObject({ answer: SUPPORT_NOTICE_FREE_TEXT })
      expect(await open(employee)).toMatchObject({
        noticeAcceptedAt: null,
        pendingSelection: 'NOTICE',
        selectionOptions: { topic: 'sí quiero saber cómo cobrar' },
      })
    })
    it('accepting after the pending question expired asks to repeat it and never processes the old one', async () => {
      await ask('stale-q', '¿Cómo cobro?')
      await expire()
      await ask('stale-yes', 'sí')
      const asked = (await reply('stale-yes')).answer!
      expect(asked).toContain('Escríbela otra vez')
      expect(asked).toContain(SUPPORT_ASK_APP)
      expect((await open(employee))!.selectionOptions).toEqual({ items: expect.any(Array) })
      await ask('stale-app', '1')
      expect(await reply('stale-app')).toMatchObject({ status: 'ANSWER_READY', body: '1' })
      expect(await prisma.supportMessage.count({ where: { conversation: { receiverId }, status: 'QUEUED' } })).toBe(0)
      expect(await prisma.supportMessage.count({ where: { conversation: { receiverId }, body: '¿Cómo cobro?' } })).toBe(0)
    })
    it('after an idle closure the next question skips the notice and keeps the app, never the identity', async () => {
      const accepted = new Date(Date.now() - day)
      const old = await remembered({ noticeAcceptedAt: accepted, app: 'android', staffId, orgId, venueId })
      await ask('inherit', '¿Cómo cobro?')
      expect(await prisma.supportConversation.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({
        mode: 'CLOSED',
        noticeAcceptedAt: accepted,
      })
      expect(await open(employee)).toMatchObject({
        noticeAcceptedAt: accepted,
        app: 'android',
        staffId: null,
        linkId: null,
        orgId: null,
        venueId: null,
      })
      expect(await reply('inherit')).toMatchObject({ status: 'QUEUED', answer: null, body: '¿Cómo cobro?' })
      expect(await prisma.$transaction(tx => inheritSupportMemory(tx, receiverId, employee, new Date()))).toEqual({
        noticeAcceptedAt: accepted,
        app: 'android',
        staffId,
        linkId: null,
        orgId,
        venueId,
      })
    })
    it('a remembered notice without an app asks for the app and keeps the question', async () => {
      await remembered({ noticeAcceptedAt: new Date(Date.now() - day) })
      await ask('inherit-noapp', '¿Cómo cobro?')
      expect(await reply('inherit-noapp')).toMatchObject({ answer: SUPPORT_ASK_APP })
      await ask('inherit-noapp-choice', '2')
      expect(await reply('inherit-noapp-choice')).toMatchObject({ status: 'QUEUED', answer: null, body: '¿Cómo cobro?' })
    })
    it('a notice accepted more than 30 days ago is shown again', async () => {
      await remembered({ noticeAcceptedAt: new Date(Date.now() - 31 * day), app: 'android' })
      await ask('old-consent', '¿Cómo cobro?')
      expect(await reply('old-consent')).toMatchObject({ answer: SUPPORT_NOTICE_FREE_TEXT })
      expect(await open(employee)).toMatchObject({ noticeAcceptedAt: null, pendingSelection: 'NOTICE' })
    })
    it('AYUDA starts over, and once that conversation closes nothing older is inherited', async () => {
      await remembered({ noticeAcceptedAt: new Date(Date.now() - day), app: 'android', lastActivityAt: new Date(Date.now() - 7200_000) })
      await ask('help-reset', 'AYUDA')
      const helped = (await open(employee))!
      expect(helped).toMatchObject({ noticeAcceptedAt: null, app: null })
      await prisma.supportConversation.update({ where: { id: helped.id }, data: { lastActivityAt: new Date(Date.now() - 1801_000) } })
      await ask('help-next', '¿Cómo cobro?')
      expect(await open(employee)).toMatchObject({ noticeAcceptedAt: null, app: null })
      expect(await reply('help-next')).toMatchObject({ answer: SUPPORT_NOTICE_FREE_TEXT })
    })
    it('idle closure, reopening and SALIR: the next question does not reach the older conversation', async () => {
      const accepted = new Date(Date.now() - day)
      const oldest = await remembered({ noticeAcceptedAt: accepted, app: 'android' })
      await ask('chain-reopen', '¿Cómo cobro?')
      expect(await open(employee)).toMatchObject({ noticeAcceptedAt: accepted, app: 'android' })
      expect(await ask('chain-exit', 'SALIR')).toBe('IGNORED')
      await ask('chain-next', '¿Y para facturar?')
      expect(await open(employee)).toMatchObject({ noticeAcceptedAt: null, app: null })
      expect(await reply('chain-next')).toMatchObject({ answer: SUPPORT_NOTICE_FREE_TEXT })
      expect(await prisma.supportConversation.findUniqueOrThrow({ where: { id: oldest.id } })).toMatchObject({ noticeAcceptedAt: accepted })
    })
    it.each([
      ['sensitive', 'Mi contraseña es abc12345'],
      ['too long', 'a'.repeat(2001)],
    ])('a %s first message stores no question', async (_, text) => {
      await ask('private-q', text)
      expect((await reply('private-q')).answer).not.toBe(SUPPORT_NOTICE_FREE_TEXT)
      expect(await open(employee)).toMatchObject({ pendingSelection: null, selectionOptions: null })
      // The sensitive reply is not the notice, so «sí» cannot accept it yet: the notice is shown first.
      await ask('private-yes', 'sí')
      expect(await reply('private-yes')).toMatchObject({ answer: SUPPORT_NOTICE_FREE_TEXT })
      expect(await open(employee)).toMatchObject({ noticeAcceptedAt: null, selectionOptions: null })
    })
    it('a first «ok» never accepts a notice that was not shown', async () => {
      await ask('blind-ok', 'ok')
      expect(await reply('blind-ok')).toMatchObject({ answer: SUPPORT_NOTICE_FREE_TEXT })
      expect(await open(employee)).toMatchObject({ noticeAcceptedAt: null, selectionOptions: null })
      await ask('seen-ok', 'ok')
      expect(await reply('seen-ok')).toMatchObject({ answer: SUPPORT_ASK_APP })
      expect(await open(employee)).toMatchObject({ noticeAcceptedAt: expect.any(Date), selectionOptions: { items: expect.any(Array) } })
    })
    it.each(['APP', 'SIGUIENTE', 'SUCURSAL centro', '2', 'Hola', '¡Buenas tardes!'])(
      '%s before accepting is not kept as the question',
      async word => {
        await ask('menu-word', word)
        expect(await reply('menu-word')).toMatchObject({ answer: SUPPORT_NOTICE_FREE_TEXT })
        expect(await open(employee)).toMatchObject({ pendingSelection: null, selectionOptions: null })
      },
    )
    it('the app list takes a name, and an unclear one shows the list again keeping the question', async () => {
      await ask('app-name-q', '¿Cómo cobro?')
      await ask('app-name-yes', 'sí')
      await ask('app-name-pos', 'pos')
      expect((await reply('app-name-pos')).answer).toBe(`No encontré esa opción. ${SUPPORT_ASK_APP}`)
      expect(await open(employee)).toMatchObject({ pendingSelection: 'APP', selectionOptions: { topic: '¿Cómo cobro?' } })
      await ask('app-name-win', 'el de windos')
      expect(await reply('app-name-win')).toMatchObject({ status: 'QUEUED', answer: null, body: '¿Cómo cobro?' })
      expect(await open(employee)).toMatchObject({ app: 'windows', pendingSelection: null })
    })
    it('APP with a live selection keeps the pending question', async () => {
      await ask('app-live-q', '¿Cómo cobro?')
      await ask('app-live-yes', 'sí')
      await ask('app-live', 'APP')
      expect(await open(employee)).toMatchObject({ pendingSelection: 'APP', selectionOptions: { topic: '¿Cómo cobro?' } })
      await ask('app-live-choice', '2')
      expect(await reply('app-live-choice')).toMatchObject({ status: 'QUEUED', answer: null, body: '¿Cómo cobro?' })
    })
    it('APP with an expired selection drops the question and gives it no new deadline', async () => {
      await ask('app-old-q', '¿Cómo cobro?')
      await ask('app-old-yes', 'sí')
      await expire()
      await ask('app-old', 'APP')
      expect((await open(employee))!.selectionOptions).toEqual({ items: expect.any(Array) })
      await ask('app-old-choice', '2')
      expect(await reply('app-old-choice')).toMatchObject({ status: 'ANSWER_READY', body: '2' })
      expect(await prisma.supportMessage.count({ where: { conversation: { receiverId }, status: 'QUEUED' } })).toBe(0)
    })
    it('flag off: an idle closure still forgets the accepted notice', async () => {
      delete process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED
      const old = await remembered({ noticeAcceptedAt: new Date(), app: 'android' })
      await prisma.$transaction(tx => closeIdleSupport(tx, old))
      expect(await prisma.supportConversation.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({
        mode: 'CLOSED',
        noticeAcceptedAt: null,
        app: 'android',
      })
    })
  })

  describe('the venue without asking more', () => {
    const q = '¿Cómo cobro?'
    const extra: string[] = []
    // Each reply prepared before the next message was delivered.
    const ask = async (id: string, body: string) => {
      await delivered()
      return tryRouteSupport(input(id, body, as(employee)))
    }
    const link = (data: { staffId?: string; expiresAt?: Date } = {}) =>
      prisma.supportWhatsappLink.create({
        data: { staffId, phone: employee, verifiedAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 86400000), ...data },
      })
    async function venues(...names: string[]) {
      const created = []
      for (const name of names) {
        const venue = await prisma.venue.create({
          data: { organizationId: orgId, name, slug: `${receiverId}-extra-${extra.length}`, status: 'ACTIVE' },
        })
        extra.push(venue.id)
        await prisma.staffVenue.create({ data: { staffId, venueId: venue.id, role: 'VIEWER' } })
        created.push(venue.id)
      }
      return created
    }
    // An open conversation already past the 30-minute idle limit, so the next message closes it and inherits from it.
    const remembered = (data: Record<string, unknown>) =>
      prisma.supportConversation.create({
        data: { receiverId, phone: employee, lastActivityAt: new Date(Date.now() - 3600_000), noticeAcceptedAt: new Date(), ...data },
      })
    const toQuestion = async (prefix: string) => {
      await ask(`${prefix}-q`, q)
      await ask(`${prefix}-yes`, 'sí')
      await ask(`${prefix}-app`, '1')
    }
    // A registered person without a link gets a public guide, then links with the real panel code.
    const publicGuideThenLink = async (prefix: string) => {
      await toQuestion(prefix)
      const guided = await reply(`${prefix}-app`)
      expect(guided).toMatchObject({ status: 'QUEUED', body: q })
      expect(await open(employee)).toMatchObject({ mode: 'PUBLIC', staffId: null })
      await prisma.supportMessage.update({ where: { id: guided.id }, data: { status: 'SENT', answer: 'Guía pública' } })
      const challenge = await requestLink(staffId, { phone: employee, operationKey: `from-public-${prefix}` }, { strongAuthAt: new Date() })
      fakeSend()
      expect(await deliverSupportMessage((await claimNext(new Date(Date.now() + 1_000), receiverId))!)).toBe('SENT')
      const code = (JSON.parse(String((global.fetch as jest.Mock).mock.calls[0][1].body)).text.body as string).match(/\d{6}/)![0]
      expect(await verifyLink(staffId, { challengeId: challenge.challengeId, code }, { strongAuthAt: new Date() })).toEqual({
        linked: true,
      })
    }
    afterEach(async () => {
      await prisma.supportAttempt.deleteMany({ where: { message: { conversation: { receiverId } } } })
      await prisma.supportMessage.deleteMany({ where: { conversation: { receiverId } } })
      await prisma.supportLinkChallenge.deleteMany({ where: { conversation: { receiverId } } })
      await prisma.supportConversation.deleteMany({ where: { receiverId } })
      await prisma.staff.updateMany({ where: { id: unphonedId }, data: { phone: null } })
      await prisma.staffVenue.deleteMany({ where: { venueId: { in: extra } } })
      await prisma.venue.deleteMany({ where: { id: { in: extra } } })
      extra.length = 0
    })

    it.each(['one account', 'one account after an idle closure', 'two accounts'])(
      'linking from a public reply: with %s for the phone, the next question is personal only for one',
      async kind => {
        await publicGuideThenLink('pub')
        if (kind === 'two accounts') await prisma.staff.update({ where: { id: unphonedId }, data: { phone: employee } })
        if (kind.endsWith('idle closure'))
          await prisma.supportConversation.updateMany({
            where: { receiverId, phone: employee, mode: { not: 'CLOSED' } },
            data: { lastActivityAt: new Date(Date.now() - 1801_000) },
          })
        await ask('pub-next', '¿Y para facturar?')
        expect(await reply('pub-next')).toMatchObject({ status: 'QUEUED', answer: null, body: '¿Y para facturar?' })
        expect(await open(employee)).toMatchObject(
          kind !== 'two accounts'
            ? { mode: 'PERSONAL', staffId, orgId, venueId, app: 'dashboard', noticeAcceptedAt: expect.any(Date) }
            : { mode: 'PUBLIC', staffId: null, venueId: null },
        )
      },
    )
    it('PUBLICA after linking keeps public help: the next question shows no venue list', async () => {
      await venues('Segunda')
      await publicGuideThenLink('publica')
      await ask('publica-cmd', 'PUBLICA')
      await ask('publica-next', '¿Y para facturar?')
      expect(await open(employee)).toMatchObject({ mode: 'PUBLIC', staffId: null, venueId: null })
      expect((await reply('publica-next')).answer).toBe(SUPPORT_ASK_APP)
    })
    it('a late webhook cannot move the last activity back and undo PUBLICA', async () => {
      await venues('Segunda')
      await publicGuideThenLink('late')
      await ask('late-cmd', 'PUBLICA')
      // PUBLICA was processed after the code was confirmed; a webhook that took its clock earlier finishes now.
      const after = new Date(Date.now() + 120_000)
      await prisma.supportConversation.updateMany({
        where: { receiverId, phone: employee, mode: { not: 'CLOSED' } },
        data: { lastActivityAt: after },
      })
      await ask('late-old', '¿Y el corte?')
      expect((await open(employee))!.lastActivityAt.getTime()).toBe(after.getTime())
      expect(await open(employee)).toMatchObject({ mode: 'PUBLIC', staffId: null, venueId: null })
    })
    it('a linked person with one venue is not asked and gets that venue', async () => {
      await link()
      await toQuestion('one')
      expect(await reply('one-app')).toMatchObject({ status: 'QUEUED', answer: null, body: q })
      expect(await open(employee)).toMatchObject({ mode: 'PERSONAL', staffId, orgId, venueId, pendingSelection: null })
    })
    it('a linked person with several venues keeps the last one that still has access', async () => {
      const own = await link()
      const [second] = await venues('Segunda')
      await remembered({ app: 'android', staffId, linkId: own.id, orgId, venueId: second })
      await ask('last', q)
      expect(await open(employee)).toMatchObject({ mode: 'PERSONAL', staffId, linkId: own.id, orgId, venueId: second, app: 'android' })
      expect(await reply('last')).toMatchObject({ status: 'QUEUED', answer: null, body: q })
    })
    it('a last venue without access asks the list, without its data, and choosing processes the question', async () => {
      const own = await link()
      const [gone] = await venues('Cerrada', 'Norte')
      await prisma.staffVenue.deleteMany({ where: { staffId, venueId: gone } })
      await remembered({ app: 'android', staffId, linkId: own.id, orgId, venueId: gone })
      await ask('gone', q)
      const list = (await reply('gone')).answer!
      expect(list).toMatch(/^Elige sucursal de las 2 disponibles/)
      expect(list).not.toContain('Cerrada')
      expect(await open(employee)).toMatchObject({ orgId: null, venueId: null, pendingSelection: 'VENUE', selectionOptions: { topic: q } })
      await ask('gone-choice', '1')
      expect(await reply('gone-choice')).toMatchObject({ status: 'QUEUED', answer: null, body: q })
      expect(await open(employee)).toMatchObject({ mode: 'PERSONAL', venueId: extra[1] })
    })
    it.each(['expired', 'other', 'none'])('a remembered identity with a %s link stays in public help', async kind => {
      const own =
        kind === 'none' ? null : await link(kind === 'expired' ? { expiresAt: new Date(Date.now() - 1) } : { staffId: unphonedId })
      await remembered({ app: 'android', staffId, linkId: own?.id ?? null, orgId, venueId })
      await ask('stale-link', q)
      expect(await open(employee)).toMatchObject({ mode: 'PUBLIC', staffId: null, linkId: null, orgId: null, venueId: null })
      expect(await reply('stale-link')).toMatchObject({ status: 'QUEUED', body: q })
    })
    it('a phone of two accounts linked by one: no inheritance and no automatic choice, public help', async () => {
      const own = await link()
      await prisma.staff.update({ where: { id: unphonedId }, data: { phone: employee } })
      await remembered({ app: 'android', staffId, linkId: own.id, orgId, venueId, lastActivityAt: new Date(Date.now() - 7200_000) })
      await ask('shared-memory', q)
      expect(await open(employee)).toMatchObject({ mode: 'PUBLIC', staffId: null, venueId: null })
      await prisma.supportMessage.deleteMany({ where: { conversation: { receiverId } } })
      await prisma.supportConversation.deleteMany({ where: { receiverId } })
      await toQuestion('shared')
      expect(await reply('shared-app')).toMatchObject({ status: 'QUEUED', answer: null, body: q })
      expect(await open(employee)).toMatchObject({ mode: 'PUBLIC', staffId: null, venueId: null, pendingSelection: null })
    })
    it('more than ten venues: SIGUIENTE and SUCURSAL <name> keep the question, and choosing processes it', async () => {
      await link()
      const zones = await venues(...Array.from({ length: 11 }, (_, i) => `Zona ${String(i + 1).padStart(2, '0')}`))
      await toQuestion('many')
      expect((await reply('many-app')).answer).toContain('SIGUIENTE')
      expect(await open(employee)).toMatchObject({ pendingSelection: 'VENUE', selectionOptions: { topic: q } })
      await ask('many-next', 'SIGUIENTE')
      expect(await open(employee)).toMatchObject({ pendingSelection: 'VENUE', selectionOptions: { topic: q } })
      await ask('many-search', 'SUCURSAL Zona 1')
      expect(await open(employee)).toMatchObject({ pendingSelection: 'VENUE', selectionOptions: { search: 'Zona 1', topic: q } })
      await ask('many-choice', '2')
      expect(await reply('many-choice')).toMatchObject({ status: 'QUEUED', answer: null, body: q })
      expect(await open(employee)).toMatchObject({ mode: 'PERSONAL', venueId: zones[10] })
    })
    it('an expired venue selector not yet purged: SUCURSAL Centro searches without the question and choosing does not process it', async () => {
      await link()
      await venues('Centro')
      await toQuestion('old')
      expect(await open(employee)).toMatchObject({ pendingSelection: 'VENUE', selectionOptions: { topic: q } })
      await prisma.supportConversation.updateMany({
        where: { receiverId, phone: employee, mode: { not: 'CLOSED' } },
        data: { selectionExpiresAt: new Date(Date.now() - 1) },
      })
      await ask('old-search', 'SUCURSAL Centro')
      const selector = (await open(employee))!
      expect(selector).toMatchObject({ pendingSelection: 'VENUE', selectionOptions: { search: 'Centro' } })
      expect(selector.selectionOptions).not.toHaveProperty('topic')
      await ask('old-choice', '1')
      expect(await reply('old-choice')).toMatchObject({ status: 'ANSWER_READY', body: '1' })
      expect(await prisma.supportMessage.count({ where: { conversation: { receiverId }, status: 'QUEUED' } })).toBe(0)
    })
    // «suursal norte» is what a real phone sent on 10-nov; «SUCURSAL norte» stays a search, as the list says.
    it.each(['Norte', 'la nrte', 'suursal norte'])('the venue list takes the name «%s» and processes the question', async word => {
      await link()
      await venues('Norte')
      await toQuestion('name')
      expect(await open(employee)).toMatchObject({ pendingSelection: 'VENUE', selectionOptions: { topic: q } })
      await ask('name-pick', word)
      expect(await reply('name-pick')).toMatchObject({ status: 'QUEUED', answer: null, body: q })
      expect(await open(employee)).toMatchObject({ mode: 'PERSONAL', venueId: extra[0] })
    })
    // Codex C5: an extra word names nothing; a typo close to two names names nothing; an exact name beats a typo of another.
    it.each([
      ['Centro Sur', ['Centro', 'Norte'], -1],
      ['nrte', ['Norte', 'Norte Dos'], -1],
      ['Centro', ['Centro', 'Central'], 0],
    ] as const)('«%s» with the list %j picks option %i (-1 shows the list again)', async (word, names, picked) => {
      await link()
      await venues(...names)
      await toQuestion('codex')
      await ask('codex-pick', word)
      if (picked < 0) {
        expect((await reply('codex-pick')).answer).toMatch(/^No encontré esa opción\./)
        expect(await open(employee)).toMatchObject({ pendingSelection: 'VENUE', venueId: null, selectionOptions: { topic: q } })
      } else expect(await open(employee)).toMatchObject({ venueId: extra[picked], pendingSelection: null })
    })
    it('an exact name wins over a longer one, and a name matching several shows the list again', async () => {
      await link()
      await venues('Norte', 'Norte Dos', 'Norte Tres')
      await toQuestion('several')
      await ask('several-dos', 'dos')
      expect(await open(employee)).toMatchObject({ venueId: extra[1] })
      await ask('several-list', 'SUCURSAL')
      await ask('several-norte', 'norte')
      expect(await open(employee)).toMatchObject({ venueId: extra[0] })
      await prisma.venue.update({ where: { id: extra[0] }, data: { name: 'Norte Uno' } })
      await ask('several-list-2', 'SUCURSAL')
      await ask('several-vague', 'norte')
      const again = (await reply('several-vague')).answer!
      expect(again).toMatch(/^No encontré esa opción\. Responde con el número o el nombre:\n1\. /)
      expect(again).toContain('Norte Tres')
      expect(await open(employee)).toMatchObject({ pendingSelection: 'VENUE', venueId: null })
    })
    it('choosing a venue with no pending question says which venue is now in use', async () => {
      const own = await link()
      await venues('Norte')
      await remembered({ app: 'dashboard', staffId, linkId: own.id, orgId, venueId, lastActivityAt: new Date() })
      await ask('confirm-list', 'SUCURSAL')
      await ask('confirm-pick', 'nrte')
      expect((await reply('confirm-pick')).answer).toBe(
        'Listo: viendo Norte. Ya puedes preguntar. Antes de cada respuesta comprobaré tu acceso actual.',
      )
    })
    it('a greeting after the app is known gets a short prompt instead of a guide search', async () => {
      await link()
      await toQuestion('greet')
      await ask('greet-hi', 'Hola, buenas tardes')
      expect(await reply('greet-hi')).toMatchObject({ status: 'ANSWER_READY', answer: SUPPORT_GREETING })
      await ask('greet-real', 'hola, ¿cómo cobro?')
      expect(await reply('greet-real')).toMatchObject({ status: 'QUEUED', answer: null, body: 'hola, ¿cómo cobro?' })
    })
    it('flag off: a typed name is not an option and a greeting is not answered differently', async () => {
      await link()
      await venues('Norte')
      await toQuestion('off-name')
      delete process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED
      await ask('off-name-pick', 'Norte')
      expect((await reply('off-name-pick')).answer).toBe(
        'Responde con una de las opciones indicadas o escribe APP o SUCURSAL para cambiar.',
      )
    })
    it.each(['also', 'moves'])('a personal conversation of A whose phone %s to B: the next message stays in public help', async kind => {
      const own = await link()
      await prisma.supportConversation.create({
        data: {
          receiverId,
          phone: employee,
          mode: 'PERSONAL',
          staffId,
          linkId: own.id,
          orgId,
          venueId,
          app: 'dashboard',
          noticeAcceptedAt: new Date(),
          lastUserMessageAt: new Date(),
        },
      })
      await prisma.staff.update({ where: { id: unphonedId }, data: { phone: employee } })
      if (kind === 'moves') await prisma.staff.update({ where: { id: staffId }, data: { phone: null } })
      await ask('moved', q)
      expect(await open(employee)).toMatchObject({
        mode: 'PUBLIC',
        staffId: null,
        linkId: null,
        venueId: null,
        app: 'dashboard',
        noticeAcceptedAt: expect.any(Date),
      })
      expect(await reply('moved')).toMatchObject({ status: 'QUEUED', answer: null, body: q })
    })
  })
})
