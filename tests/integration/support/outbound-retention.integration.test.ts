import prisma from '@/utils/prismaClient'
import { admitSupportMessage, claimNext } from '@/services/support/store.service'
import { deliverSupportMessage, recordSupportDeliveryFailure } from '@/services/support/delivery.service'
import { purgeSupportBatch } from '@/services/support/retention.service'
import { supportCipher } from '@/services/support/link.service'
import { tryRouteSupport } from '@/services/support/router.service'

const receiverId = `support-outbound-retention-${Date.now()}`,
  phone = '+525500008009',
  day = 86400000,
  originalFetch = global.fetch
let serial = 0,
  staffId: string | null = null
async function clean() {
  await prisma.supportAttempt.deleteMany({ where: { message: { conversation: { receiverId } } } })
  await prisma.supportMessage.deleteMany({ where: { conversation: { receiverId } } })
  await prisma.supportLinkChallenge.deleteMany({ where: { conversation: { receiverId } } })
  await prisma.supportConversation.deleteMany({ where: { receiverId } })
  await prisma.whatsappInboundEvent.deleteMany({ where: { receiverId } })
  if (staffId) {
    await prisma.staff.delete({ where: { id: staffId } })
    staffId = null
  }
}
beforeEach(async () => {
  await clean()
  Object.assign(process.env, {
    SUPPORT_WHATSAPP_ENABLED: 'true',
    SUPPORT_WHATSAPP_PHONE_NUMBER_ID: receiverId,
    WHATSAPP_SALES_PHONE_NUMBER_ID: 'sales',
    SUPPORT_WHATSAPP_ENC_KEY: 'e'.repeat(64),
    WHATSAPP_ACCESS_TOKEN: 'fixture-no-network',
  })
})
afterEach(() => {
  global.fetch = originalFetch
})
afterAll(clean)
for (const purpose of ['HELP', 'LINK_CODE'] as const)
  it.each(['ack-before-purge', 'purge-before-ack', 'failed-purge-ack'] as const)(
    `${purpose}: %s preserves opaque ownership without recreating expired content`,
    async order => {
      const now = new Date(),
        expiresAt = new Date(now.getTime() + 5000),
        createdAt = new Date(expiresAt.getTime() - (purpose === 'HELP' ? 30 * day : 600000))
      const admitted = await admitSupportMessage({
        receiverId,
        phone,
        body: 'PRIVATE_QUESTION',
        type: 'text',
        timestamp: String(now.getTime() / 1000),
        wamid: `${receiverId}-${++serial}`,
      })
      const source = await prisma.supportMessage.findUniqueOrThrow({ where: { id: admitted.messageId } })
      await prisma.supportConversation.update({
        where: { id: source.conversationId },
        data: { app: 'dashboard', noticeAcceptedAt: now, lastActivityAt: now, lastUserMessageAt: now },
      })
      let targetId = source.id
      if (purpose === 'HELP') {
        await prisma.supportMessage.update({
          where: { id: targetId },
          data: { createdAt, expiresAt, status: 'ANSWER_READY', answer: 'PRIVATE_ANSWER' },
        })
        await prisma.whatsappInboundEvent.update({
          where: { id: source.inboundEventId! },
          data: { receivedAt: createdAt, supportTombstoneUntil: new Date(createdAt.getTime() + 90 * day) },
        })
      } else {
        await prisma.supportMessage.update({ where: { id: source.id }, data: { status: 'SENT' } })
        const staff = await prisma.staff.create({
          data: { email: `${receiverId}-${serial}@test.local`, firstName: 'OTP', lastName: 'Fixture', emailVerified: true },
        })
        staffId = staff.id
        const challenge = await prisma.supportLinkChallenge.create({
          data: { staffId, phone, conversationId: source.conversationId, operationKey: 'fixture', codeHash: 'hash', expiresAt, createdAt },
        })
        const code = await prisma.supportMessage.create({
          data: {
            purpose,
            challengeId: challenge.id,
            conversationId: source.conversationId,
            sequence: 2,
            generation: source.generation,
            createdAt,
            expiresAt,
            status: 'ANSWER_READY',
            answerCipher: supportCipher.encryptToBase64('123456'),
          },
        })
        targetId = code.id
      }
      const wamid = `wamid.late-ack-${purpose}-${serial}`
      const afterExpiry = new Date(expiresAt.getTime() + 1000)
      let failedCallbackResult: boolean | undefined
      global.fetch = jest.fn(async () => {
        if (order === 'failed-purge-ack') failedCallbackResult = await recordSupportDeliveryFailure(wamid, receiverId)
        if (order !== 'ack-before-purge') await purgeSupportBatch(afterExpiry)
        return new Response(JSON.stringify({ messages: [{ id: wamid }] }), { status: 200 })
      }) as typeof fetch
      const claim = (await claimNext(new Date(), receiverId))!
      expect(claim.messageId).toBe(targetId)
      expect(await deliverSupportMessage(claim)).toBe(order === 'failed-purge-ack' ? 'CANCELLED' : 'SENT')
      expect(global.fetch).toHaveBeenCalledTimes(1)
      if (order === 'failed-purge-ack') expect(failedCallbackResult).toBe(false)
      if (order === 'ack-before-purge') await purgeSupportBatch(afterExpiry)
      await purgeSupportBatch(new Date(now.getTime() + 31 * day))
      expect(await prisma.supportMessage.findUnique({ where: { id: targetId } })).toBeNull()
      expect(await prisma.supportConversation.findUnique({ where: { id: source.conversationId } })).toBeNull()
      process.env.SUPPORT_WHATSAPP_ENABLED = 'false'
      const quote = {
        receiverId,
        phone,
        body: 'PRIVATE_QUOTED_QUESTION',
        type: 'text',
        timestamp: String(Date.now() / 1000),
        wamid: `${receiverId}-quote-${serial}`,
        contextId: wamid,
        legacyRaw: { text: { body: 'PRIVATE_QUOTED_QUESTION' } },
      }
      expect(await tryRouteSupport(quote)).toBe('IGNORED')
      const tombstone = await prisma.whatsappInboundEvent.findFirstOrThrow({ where: { receiverId, replyWamid: wamid } })
      expect(tombstone).toMatchObject({ fromPhone: '', rawBody: {} })
      expect(tombstone.supportTombstoneUntil!.getTime()).toBe(createdAt.getTime() + 90 * day)
    },
  )
