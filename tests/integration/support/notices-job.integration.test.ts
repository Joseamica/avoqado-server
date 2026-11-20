import prisma from '@/utils/prismaClient'
import { getSupportHandoffConfig } from '@/config/supportWhatsapp'
import emailService, { type EmailSendResult } from '@/services/email.service'
import { tryRouteSupport } from '@/services/support/router.service'
import { requestSupportHandoff } from '@/services/support/handoff.service'
import { runSupportNotices } from '@/services/support/notices.service'
import { SupportWhatsappJob } from '@/jobs/support-whatsapp.job'

const receiverId = `support-notices-job-${Date.now()}`
// 79xx: no other support suite uses these numbers.
const staffPhone = '+525500007901',
  strangerPhone = '+525500007909'
const originalFetch = global.fetch
let orgId: string, venueId: string, staffId: string
let serial = 0
const input = (body: string, phone: string) => ({
  receiverId,
  phone,
  wamid: `wamid.${receiverId}-${++serial}`,
  type: 'text',
  body,
  timestamp: String(Math.floor(Date.now() / 1000)),
})
async function clean() {
  const ids = (await prisma.supportConversation.findMany({ where: { receiverId }, select: { id: true }, take: 50 })).map(c => c.id)
  await prisma.supportEvent.deleteMany({ where: { conversationId: { in: ids } } })
  await prisma.supportNotice.deleteMany({ where: { conversationId: { in: ids } } })
  await prisma.supportAttempt.deleteMany({ where: { message: { conversation: { receiverId } } } })
  await prisma.supportMessage.deleteMany({ where: { conversation: { receiverId } } })
  await prisma.supportConversation.deleteMany({ where: { receiverId } })
  await prisma.whatsappInboundEvent.deleteMany({ where: { receiverId } })
  await prisma.supportBudget.deleteMany({ where: { key: { startsWith: `CONTROL:${receiverId}:` } } })
}
beforeAll(async () => {
  Object.assign(process.env, {
    SUPPORT_WHATSAPP_ENABLED: 'true',
    SUPPORT_WHATSAPP_PHONE_NUMBER_ID: receiverId,
    WHATSAPP_SALES_PHONE_NUMBER_ID: 'sales',
    SUPPORT_WHATSAPP_ENC_KEY: 'e'.repeat(64),
    SUPPORT_WHATSAPP_FREE_TEXT_ENABLED: 'true',
    SUPPORT_WHATSAPP_HYBRID_ENABLED: 'true',
    SUPPORT_HANDOFF_EMAIL_TO: 'soporte@test.local',
    WHATSAPP_ACCESS_TOKEN: 'fixture-never-used',
  })
  orgId = (await prisma.organization.create({ data: { name: 'Avisos job fixture', email: `${receiverId}-org@test.local`, phone: '0' } })).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: 'Centro', slug: `${receiverId}-centro`, status: 'ACTIVE' } }))
    .id
  staffId = (
    await prisma.staff.create({
      data: { email: `${receiverId}-staff@test.local`, firstName: 'Caro', lastName: 'Avisos', emailVerified: true, phone: staffPhone },
    })
  ).id
  await prisma.staffVenue.create({ data: { staffId, venueId, role: 'VIEWER' } })
})
beforeEach(async () => {
  await clean()
  global.fetch = jest.fn(
    async () => new Response(JSON.stringify({ messages: [{ id: `wamid.${receiverId}-out-${++serial}` }] }), { status: 200 }),
  ) as unknown as typeof fetch
})
afterEach(() => jest.restoreAllMocks())
afterAll(async () => {
  global.fetch = originalFetch
  await clean()
  if (!orgId) return
  await prisma.staffVenue.deleteMany({ where: { staffId } })
  await prisma.staff.deleteMany({ where: { id: staffId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.delete({ where: { id: orgId } })
})

/** A PENDING notice exactly as Task 5 writes it, and someone else's message waiting for the WhatsApp job. */
async function scene() {
  const now = new Date()
  const conversation = await prisma.supportConversation.create({
    data: { receiverId, phone: staffPhone, app: 'dashboard', noticeAcceptedAt: now, lastUserMessageAt: now, lastActivityAt: now },
  })
  await prisma.$transaction(tx => requestSupportHandoff(tx, conversation, 'REQUESTED', now, getSupportHandoffConfig()!))
  const notice = await prisma.supportNotice.findUniqueOrThrow({
    where: { dedupeKey: `handoff:${conversation.id}:${conversation.generation}` },
  })
  // AYUDA: answered without any model.
  const event = input('AYUDA', strangerPhone)
  expect(await tryRouteSupport(event)).toBe('QUEUED')
  const question = await prisma.supportMessage.findFirstOrThrow({ where: { inboundEvent: { wamid: event.wamid } } })
  return { notice, question }
}
const notice = (id: string) => prisma.supportNotice.findUniqueOrThrow({ where: { id } })
const message = (id: string) => prisma.supportMessage.findUniqueOrThrow({ where: { id } })

it('SupportWhatsappJob never touches the email: with the real transport hanging, its tick ends in time, the WhatsApp message goes out and the notice is left as it was', async () => {
  const { notice: born, question } = await scene()
  const hanging = jest.spyOn(emailService, 'sendEmailWithResult').mockImplementation(() => new Promise<EmailSendResult>(() => {}))
  // Under the 15 s cut of the notices pass: had the WhatsApp tick sent the notice, it would still be waiting here.
  const tick = new SupportWhatsappJob().runNow().then(() => 'done')
  const limit = new Promise(resolve => setTimeout(() => resolve('hung'), 10_000).unref())
  expect(await Promise.race([tick, limit])).toBe('done')
  expect(hanging).not.toHaveBeenCalled()
  expect(await message(question.id)).toMatchObject({ status: 'SENT' })
  expect(await notice(born.id)).toMatchObject({ status: 'PENDING', reservedAt: null, attempts: 0, firstAttemptAt: null })
})

it('with the email transport hanging, a queued WhatsApp question is answered by SupportWhatsappJob in time; the notice ends PENDING with attempts 1 after timeoutMs', async () => {
  const { notice: born, question } = await scene()
  const hanging = jest.fn((): Promise<EmailSendResult> => new Promise(() => {}))
  const timeoutMs = 6000
  let noticesDone = false
  const notices = runSupportNotices(new Date(), { send: hanging, timeoutMs }).finally(() => (noticesDone = true))
  for (let i = 0; i < 250 && !hanging.mock.calls.length; i++) await new Promise(resolve => setTimeout(resolve, 20))
  expect(hanging).toHaveBeenCalledTimes(1)

  // The WhatsApp job never waits for the email: its own tick answers while the email request still hangs.
  await new SupportWhatsappJob().runNow()
  expect(noticesDone).toBe(false)
  expect(await message(question.id)).toMatchObject({ status: 'SENT' })

  await notices
  expect(await notice(born.id)).toMatchObject({ status: 'PENDING', attempts: 1, errorCode: 'TIMEOUT' })
})
