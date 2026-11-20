import prisma from '@/utils/prismaClient'
import { admitSupportMessage, claimNext } from '@/services/support/store.service'
import { runSupportBatch, SUPPORT_AI_UNCERTAIN } from '@/services/support/worker.service'
const receiverId = `support-batch-${Date.now()}`
let serial = 0
async function enqueue(phone = '+525500009001') {
  const admitted = await admitSupportMessage({
    receiverId,
    phone,
    wamid: `${receiverId}-${++serial}`,
    type: 'text',
    body: 'AYUDA',
    timestamp: String(Date.now() / 1000),
  })
  const message = await prisma.supportMessage.findUniqueOrThrow({ where: { id: admitted.messageId } })
  await prisma.supportConversation.update({
    where: { id: message.conversationId },
    data: { app: 'dashboard', lastUserMessageAt: new Date(), lastActivityAt: new Date() },
  })
  return message
}
async function clean() {
  await prisma.supportAttempt.deleteMany({ where: { message: { conversation: { receiverId } } } })
  await prisma.supportMessage.deleteMany({ where: { conversation: { receiverId } } })
  await prisma.supportConversation.deleteMany({ where: { receiverId } })
  await prisma.whatsappInboundEvent.deleteMany({ where: { receiverId } })
}
beforeAll(() =>
  Object.assign(process.env, {
    SUPPORT_WHATSAPP_ENABLED: 'true',
    SUPPORT_WHATSAPP_PHONE_NUMBER_ID: receiverId,
    WHATSAPP_SALES_PHONE_NUMBER_ID: 'sales',
    SUPPORT_WHATSAPP_ENC_KEY: 'e'.repeat(64),
    WHATSAPP_ACCESS_TOKEN: 'fixture-only',
  }),
)
beforeEach(clean)
afterAll(clean)
it('prepares and delivers the saved FIFO notices through the real store and fake transport', async () => {
  const first = await enqueue(),
    second = await enqueue()
  const sent: string[] = []
  global.fetch = jest.fn(async (_url, init) => {
    const rows = await prisma.supportMessage.findMany({
      where: { conversationId: first.conversationId },
      orderBy: { sequence: 'asc' },
      take: 2,
    })
    if (sent.length === 1) expect(rows[0].status).toBe('SENT')
    sent.push(JSON.parse(String(init!.body)).text.body)
    return new Response(JSON.stringify({ messages: [{ id: `wamid.fixture-batch-${sent.length}` }] }), { status: 200 })
  }) as typeof fetch
  const result = await runSupportBatch(new Date(), { sections: [] })
  expect(result).toEqual({ claimed: 4, completed: 2, unknown: 0 })
  expect(sent).toHaveLength(2)
  expect(await prisma.supportMessage.count({ where: { id: { in: [first.id, second.id] }, status: 'SENT' } })).toBe(2)
  expect(await prisma.supportAttempt.count({ where: { messageId: { in: [first.id, second.id] }, kind: 'AI' } })).toBe(0)
})
it('recovers a process death after AI STARTED to one fallback, retaining uncertainty and never calling AI again', async () => {
  const message = await enqueue()
  const claim = (await claimNext(new Date(Date.now() + 10), receiverId))!
  await prisma.supportAttempt.create({
    data: {
      messageId: message.id,
      claimToken: claim.claimToken,
      kind: 'AI',
      ordinal: 1,
      state: 'STARTED',
      reservedUsd: '0.5',
      pricingVersion: 'fixture',
      startedAt: new Date(),
    },
  })
  await prisma.supportMessage.update({ where: { id: message.id }, data: { leaseUntil: new Date(Date.now() - 1) } })
  global.fetch = jest.fn(async (_url, init) => {
    expect(JSON.parse(String(init!.body)).text.body).toBe(SUPPORT_AI_UNCERTAIN)
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.fixture-recovered' }] }), { status: 200 })
  }) as typeof fetch
  await runSupportBatch(new Date(), { sections: [] })
  await runSupportBatch(new Date(), { sections: [] })
  expect(global.fetch).toHaveBeenCalledTimes(1)
  expect(await prisma.supportMessage.findUniqueOrThrow({ where: { id: message.id } })).toMatchObject({
    status: 'SENT',
    answer: SUPPORT_AI_UNCERTAIN,
  })
  expect(await prisma.supportAttempt.findFirstOrThrow({ where: { messageId: message.id, kind: 'AI' } })).toMatchObject({
    state: 'UNKNOWN',
    reservedUsd: expect.objectContaining({}),
  })
  expect(await prisma.supportAttempt.count({ where: { messageId: message.id, kind: 'AI' } })).toBe(1)
})
it('does not let a later question pass the earlier recovered uncertainty notice', async () => {
  const first = await enqueue()
  const claim = (await claimNext(new Date(Date.now() + 10), receiverId))!
  const later = await enqueue()
  await prisma.supportMessage.update({ where: { id: later.id }, data: { status: 'ANSWER_READY', answer: 'Respuesta posterior' } })
  await prisma.supportAttempt.create({
    data: {
      messageId: first.id,
      claimToken: claim.claimToken,
      kind: 'AI',
      ordinal: 1,
      state: 'STARTED',
      reservedUsd: '0.5',
      pricingVersion: 'fixture',
      startedAt: new Date(),
    },
  })
  await prisma.supportMessage.update({ where: { id: first.id }, data: { leaseUntil: new Date(Date.now() - 1) } })
  const sent: string[] = []
  global.fetch = jest.fn(async (_url, init) => {
    sent.push(JSON.parse(String(init!.body)).text.body)
    return new Response(JSON.stringify({ messages: [{ id: `wamid.fixture-fifo-${sent.length}` }] }), { status: 200 })
  }) as typeof fetch
  await runSupportBatch(new Date(), { sections: [] })
  await runSupportBatch(new Date(), { sections: [] })
  expect(sent).toEqual([SUPPORT_AI_UNCERTAIN, 'Respuesta posterior'])
})
