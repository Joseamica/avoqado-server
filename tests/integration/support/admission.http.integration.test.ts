import { createHmac } from 'crypto'
import request from 'supertest'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import * as supportRouter from '@/services/support/router.service'
import { sendServiceMessage } from '@/services/whatsapp.service'

jest.mock('@/services/venueChatEmail.service', () => ({ maybeSendVenueReplyEmail: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/whatsapp.service', () => ({
  sendServiceMessage: jest.fn().mockResolvedValue({ messageId: 'wamid.fake-only' }),
  WhatsappCloudApiError: class extends Error {},
}))

// T-F14 (ruling T-P1): the support has its own number; the central one (reservations, receipts, the relay) never reaches it.
const support = `support-http-${Date.now()}`,
  central = `${support}-central`,
  sales = `${support}-sales`,
  phone = '+525500003001',
  secret = 'support-http-fixture-only'
let orgId: string, venueId: string, sessionId: string
const message = (id: string, body: string, quote?: string) => ({
  id: `${support}-${id}`,
  from: phone.slice(1),
  type: 'text',
  text: { body },
  timestamp: String(Math.floor(Date.now() / 1000)),
  ...(quote ? { context: { id: quote } } : {}),
})
const change = (receiver: string, messages: unknown[]) => ({
  field: 'messages',
  value: { metadata: { phone_number_id: receiver }, messages },
})
const post = (changes: unknown[]) => {
  const body = JSON.stringify({ entry: [{ changes }] })
  return request(app)
    .post('/api/v1/webhooks/whatsapp')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`)
    .send(body)
}
beforeAll(async () => {
  process.env.WHATSAPP_APP_SECRET = secret
  process.env.SUPPORT_WHATSAPP_ENABLED = 'true'
  process.env.SUPPORT_WHATSAPP_ENC_KEY = 'e'.repeat(64)
  process.env.SUPPORT_WHATSAPP_PHONE_NUMBER_ID = support
  process.env.WHATSAPP_PHONE_NUMBER_ID = central
  process.env.WHATSAPP_SALES_PHONE_NUMBER_ID = sales
  orgId = (await prisma.organization.create({ data: { name: support, email: `${support}@test.local`, phone: '0000000000' } })).id
  venueId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: support, slug: support, whatsappContactMode: 'RELAY', whatsappOptInPhone: phone },
    })
  ).id
  sessionId = (
    await prisma.venueChatSession.create({
      data: { venueId, shortCode: 'QA01', customerName: 'Prueba', requestFingerprintHash: 'fake', accessTokenHash: 'fake' },
    })
  ).id
  await prisma.venueChatMessage.create({
    data: { sessionId, direction: 'INBOUND_FROM_CUSTOMER', body: 'Pregunta ficticia', whatsappMessageId: `${support}-relay` },
  })
})
beforeEach(async () => {
  jest.restoreAllMocks()
  jest.clearAllMocks()
  process.env.SUPPORT_WHATSAPP_ENABLED = 'true'
})
afterAll(async () => {
  delete process.env.SUPPORT_WHATSAPP_ENABLED
  delete process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED
  if (!orgId) return
  // Both numbers: a central message that wrongly reached support would leave rows behind (T-F14).
  const receivers = { receiverId: { in: [support, central] } }
  await prisma.supportAttempt.deleteMany({ where: { message: { conversation: receivers } } })
  await prisma.supportMessage.deleteMany({ where: { conversation: receivers } })
  await prisma.supportConversation.deleteMany({ where: receivers })
  await prisma.supportBudget.deleteMany({ where: { key: { startsWith: `CONTROL:${support}` } } })
  await prisma.whatsappInboundEvent.deleteMany({ where: { wamid: { startsWith: support } } })
  await prisma.crmWhatsappMessage.deleteMany({ where: { phoneNumberId: sales } })
  await prisma.whatsappContactWindow.deleteMany({ where: { phone } })
  if (sessionId) {
    await prisma.venueChatMessage.deleteMany({ where: { sessionId } })
    await prisma.venueChatSession.delete({ where: { id: sessionId } })
  }
  if (venueId) await prisma.venue.delete({ where: { id: venueId } })
  await prisma.organization.delete({ where: { id: orgId } })
})

it('a signed AYUDA commits a durable job and ACKs without any sender or legacy window write', async () => {
  const res = await post([change(support, [message('notice', 'AYUDA')])])
  expect(res.status).toBe(200)
  expect(
    await prisma.whatsappInboundEvent.findUnique({ where: { wamid: `${support}-notice` }, include: { supportMessage: true } }),
  ).toMatchObject({ routedAs: 'SUPPORT_QUEUED', supportMessage: { status: 'ANSWER_READY' } })
  expect(sendServiceMessage).not.toHaveBeenCalled()
  expect(await prisma.whatsappContactWindow.findUnique({ where: { phone } })).toBeNull()
})
it('natural-language credentials are omitted at the signed HTTP persistence boundary', async () => {
  const privateMessage = (id: string, body: string) => ({ ...message(id, body), from: '525500003002' })
  for (const [id, body] of [
    ['private-start', 'AYUDA'],
    ['private-consent', 'CONTINUAR'],
    ['private-app', '1'],
    ['private-password', 'Mi contraseña es Clave-Sintetica-Secreta-123'],
    ['private-pin', 'Mi PIN es 839104'],
    ['private-token', 'my token is Clave-Sintetica-Secreta-123'],
  ]) {
    expect((await post([change(support, [privateMessage(id, body)])])).status).toBe(200)
    if (!id.startsWith('private-') || ['private-start', 'private-consent', 'private-app'].includes(id)) continue
    const event = await prisma.whatsappInboundEvent.findUniqueOrThrow({
      where: { wamid: `${support}-${id}` },
      include: { supportMessage: true },
    })
    expect(event.supportMessage).toMatchObject({ body: '', status: 'ANSWER_READY' })
    expect(event.supportMessage?.answer).toContain('omití')
    expect(JSON.stringify(event.rawBody)).not.toMatch(/Clave-Sintetica|839104/)
  }
  expect(sendServiceMessage).not.toHaveBeenCalled()
})
it('omits sensitive text before a linked SUCURSAL search or selection writer can consume it', async () => {
  const phone = '+525500003003'
  const privateMessage = (id: string, body: string) => ({ ...message(id, body), from: phone.slice(1) })
  const staff = await prisma.staff.create({ data: { email: `private-search-${support}@test.local`, firstName: 'QA', lastName: 'Privacy' } })
  try {
    await prisma.staffOrganization.create({ data: { staffId: staff.id, organizationId: orgId, role: 'MEMBER' } })
    await prisma.staffVenue.create({ data: { staffId: staff.id, venueId, role: 'VIEWER' } })
    await prisma.supportWhatsappLink.create({ data: { staffId: staff.id, phone, expiresAt: new Date(Date.now() + 600000) } })
    // The matching venue makes the old search writer reachable with the partially scrubbed phrase.
    await prisma.venue.update({ where: { id: venueId }, data: { name: 'Mi [dato omitido] Valor-Sintetico-987' } })
    for (const [id, body] of [
      ['search-start', 'AYUDA'],
      ['search-consent', 'CONTINUAR'],
      ['private-search', 'SUCURSAL Mi contraseña es : Valor-Sintetico-987'],
    ]) {
      expect((await post([change(support, [privateMessage(id, body)])])).status).toBe(200)
    }
    const c = await prisma.supportConversation.findFirstOrThrow({ where: { receiverId: support, phone, mode: { not: 'CLOSED' } } })
    expect(JSON.stringify(c.selectionOptions)).not.toContain('Valor-Sintetico')
    expect(c.pendingSelection).toBe('APP')
    const event = await prisma.whatsappInboundEvent.findUniqueOrThrow({
      where: { wamid: `${support}-private-search` },
      include: { supportMessage: true },
    })
    expect(event.supportMessage).toMatchObject({ body: '', status: 'ANSWER_READY' })
    expect(event.supportMessage?.answer).toContain('https://dashboard.avoqado.io/auth/forgot-password')
  } finally {
    await prisma.venue.update({ where: { id: venueId }, data: { name: support } })
    await prisma.supportConversation.updateMany({ where: { receiverId: support, phone }, data: { staffId: null, linkId: null } })
    await prisma.supportWhatsappLink.deleteMany({ where: { staffId: staff.id } })
    await prisma.staff.delete({ where: { id: staff.id } })
  }
})
it.each(
  [
    'Mi contraseña es incorrecta, ¿cómo la cambio?',
    'Mi contraseña es inválida',
    '¿La contraseña es la misma que uso en el Dashboard?',
    '¿El PIN es el mismo de la terminal?',
    '¿El PIN es de cuatro o seis dígitos?',
    'My password is incorrect, how do I reset it?',
    'My token is expired, how can I renew it?',
    'El token es inválido, ¿cómo lo renuevo?',
    '¿Qué contraseña es necesaria para entrar?',
  ].map((question, index) => ({ question, index })),
)('gives public credential help without persisting an ambiguous question: $question', async ({ question, index }) => {
  const from = `525500005${String(index).padStart(3, '0')}`
  for (const [phase, body] of [
    ['start', 'AYUDA'],
    ['consent', 'CONTINUAR'],
    ['question', question],
  ]) {
    const id = `ambiguous-${index}-${phase}`
    expect((await post([change(support, [{ ...message(id, body), from }])])).status).toBe(200)
  }
  const event = await prisma.whatsappInboundEvent.findUniqueOrThrow({
    where: { wamid: `${support}-ambiguous-${index}-question` },
    include: { supportMessage: true },
  })
  expect(event.supportMessage).toMatchObject({ body: '', status: 'ANSWER_READY' })
  expect(event.supportMessage?.answer).toContain('https://dashboard.avoqado.io/auth/forgot-password')
  expect(event.supportMessage?.answer).toContain('https://avoqado.io/help')
  expect(event.supportMessage?.answer).toContain('hola@avoqado.io')
  expect(sendServiceMessage).not.toHaveBeenCalled()
})
it('a relay quote on the central number goes only to its old customer and keeps support history separate', async () => {
  const res = await post([change(central, [message('relay-answer', 'Respuesta al cliente.', `${support}-relay`)])])
  expect(res.status).toBe(200)
  expect(await prisma.venueChatMessage.findUnique({ where: { whatsappMessageId: `${support}-relay-answer` } })).toMatchObject({
    sessionId,
    body: 'Respuesta al cliente.',
  })
  expect(await prisma.supportMessage.count({ where: { inboundEvent: { wamid: `${support}-relay-answer` } } })).toBe(0)
  expect(sendServiceMessage).not.toHaveBeenCalled()
})
it('a transient failure does not skip the remaining relay or sales; replay keeps one owner per message', async () => {
  jest.spyOn(supportRouter, 'tryRouteSupport').mockRejectedValueOnce(new Error('injected support persistence failure'))
  const changes = [
    change(support, [message('fault', 'AYUDA')]),
    change(central, [message('after-fault', 'Otra respuesta al cliente.', `${support}-relay`)]),
    change(sales, [message('sale', 'AYUDA')]),
  ]
  expect((await post(changes)).status).toBe(500)
  expect(await prisma.venueChatMessage.count({ where: { whatsappMessageId: `${support}-after-fault` } })).toBe(1)
  expect(await prisma.crmWhatsappMessage.count({ where: { wamid: `${support}-sale` } })).toBe(1)
  expect((await post(changes)).status).toBe(200)
  expect(await prisma.venueChatMessage.count({ where: { whatsappMessageId: `${support}-after-fault` } })).toBe(1)
  expect(await prisma.crmWhatsappMessage.count({ where: { wamid: `${support}-sale` } })).toBe(1)
  expect(await prisma.supportMessage.count({ where: { inboundEvent: { wamid: `${support}-fault` } } })).toBe(1)
  expect(sendServiceMessage).not.toHaveBeenCalled()
})

it('turning support off suppresses support replies and still accepts a valid relay quote', async () => {
  process.env.SUPPORT_WHATSAPP_ENABLED = 'false'
  const res = await post([
    change(support, [message('disabled-support', '¿Cómo cobro?')]),
    change(central, [message('disabled-relay', 'Respuesta de relay con soporte apagado.', `${support}-relay`)]),
  ])
  expect(res.status).toBe(200)
  expect(sendServiceMessage).not.toHaveBeenCalled()
  expect(await prisma.whatsappInboundEvent.findUnique({ where: { wamid: `${support}-disabled-support` } })).toMatchObject({
    routedAs: 'SUPPORT_IGNORED',
  })
  expect(await prisma.venueChatMessage.findUnique({ where: { whatsappMessageId: `${support}-disabled-relay` } })).toMatchObject({
    sessionId,
  })
})

// T-F14 (finding behind ruling T-P1): a customer who answers a reservation message on the CENTRAL number is a customer of a
// business, not its staff. With the support on, in both modes, nothing of support happens: no router, no conversation, no notice.
it.each(['false', 'true'])(
  'T-F14: a reply to a reservation message on the central number never gets the support notice (free text %s)',
  async freeText => {
    process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED = freeText
    const routed = jest.spyOn(supportRouter, 'tryRouteSupport')
    const customer = `52550000${freeText === 'true' ? '4002' : '4001'}`
    const reply = { ...message(`reservation-reply-${freeText}`, 'Sí, ahí estaré', 'wamid.reservation-template'), from: customer }
    expect((await post([change(central, [reply])])).status).toBe(200)
    expect(routed).not.toHaveBeenCalled()
    expect(await prisma.supportConversation.count({ where: { phone: `+${customer}` } })).toBe(0)
    expect(await prisma.supportMessage.count({ where: { inboundEvent: { wamid: reply.id } } })).toBe(0)
    expect(await prisma.whatsappInboundEvent.findUnique({ where: { wamid: reply.id } })).toMatchObject({
      receiverId: central,
      routedAs: 'VENUE_REPLY_ORPHAN',
    })
    expect(sendServiceMessage).not.toHaveBeenCalled()
    await prisma.whatsappContactWindow.deleteMany({ where: { phone: `+${customer}` } })
    delete process.env.SUPPORT_WHATSAPP_FREE_TEXT_ENABLED
  },
)
