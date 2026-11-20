import cuid from 'cuid'
import { SupportDataResult } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { admitSupportMessage } from '@/services/support/store.service'

const receiverId = `support-data-schema-${Date.now()}`
const staffId = cuid()
const venueId = cuid()
const input = (wamid: string) => ({
  receiverId,
  wamid: `${receiverId}-${wamid}`,
  phone: '+525500009001',
  type: 'text',
  body: '¿Cuánto vendí hoy?',
  timestamp: String(Math.floor(Date.now() / 1000)),
})

afterAll(async () => {
  await prisma.supportMessage.deleteMany({ where: { conversation: { receiverId } } })
  await prisma.supportConversation.deleteMany({ where: { receiverId } })
  await prisma.whatsappInboundEvent.deleteMany({ where: { receiverId } })
  await prisma.supportDataAcceptance.deleteMany({ where: { staffId } })
  await prisma.supportDataUnlock.deleteMany({ where: { staffId } })
  await prisma.supportDataQuery.deleteMany({ where: { staffId } })
})

it('one acceptance per person; one unlock per person, venue and day', async () => {
  const acceptance = { staffId, linkId: cuid(), noticeHash: 'a'.repeat(64), acceptedAt: new Date() }
  await prisma.supportDataAcceptance.create({ data: acceptance })
  await expect(prisma.supportDataAcceptance.create({ data: { ...acceptance, linkId: cuid() } })).rejects.toMatchObject({
    code: 'P2002',
  })

  const unlock = { staffId, venueId, day: '2026-11-16', linkId: cuid(), unlockedAt: new Date() }
  expect(await prisma.supportDataUnlock.create({ data: unlock })).toMatchObject({ id: expect.stringMatching(/^c[a-z0-9]{24}$/) })
  await expect(prisma.supportDataUnlock.create({ data: { ...unlock, linkId: cuid() } })).rejects.toMatchObject({ code: 'P2002' })
  // Another day, or another venue, is another unlock.
  await expect(prisma.supportDataUnlock.create({ data: { ...unlock, day: '2026-11-17' } })).resolves.toMatchObject({ day: '2026-11-17' })
  await expect(prisma.supportDataUnlock.create({ data: { ...unlock, venueId: cuid() } })).resolves.toMatchObject({ staffId })
})

it('SupportMessage.dataCapability is null by default and purpose accepts DATA', async () => {
  const { messageId } = await admitSupportMessage(input('data'))
  expect(await prisma.supportMessage.findUniqueOrThrow({ where: { id: messageId } })).toMatchObject({
    purpose: 'HELP',
    dataCapability: null,
  })
  // How the worker saves an answer with data: no answer in clear, the text only in the cipher.
  const ready = {
    purpose: 'DATA' as const,
    status: 'ANSWER_READY' as const,
    answer: null,
    answerCipher: 'sealed',
    dataCapability: 'sales_today',
  }
  expect(await prisma.supportMessage.update({ where: { id: messageId }, data: ready })).toMatchObject(ready)
  // Sent, and later erased (a change of venue, unlinking): still a valid DATA row.
  await prisma.supportMessage.update({ where: { id: messageId }, data: { status: 'SENT', answerCipher: null, body: '' } })
})

it.each([
  ['an answer in clear', { answer: '$12,345.60' }],
  ['a pending answer without its cipher', { answerCipher: null }],
])('the table refuses a DATA message with %s', async (_label, bad) => {
  const { messageId } = await admitSupportMessage(input(`bad-${Object.keys(bad)[0]}`))
  await expect(
    prisma.supportMessage.update({
      where: { id: messageId },
      data: { purpose: 'DATA', status: 'ANSWER_READY', answer: null, answerCipher: 'sealed', ...bad },
    }),
  ).rejects.toThrow(/SupportMessage_purpose_check/)
})

it('a query row keeps no figures and takes every result of the enum', async () => {
  for (const result of Object.values(SupportDataResult)) {
    expect(
      await prisma.supportDataQuery.create({
        data: { staffId, venueId, capability: 'deposits_week', paramsHmac: 'b'.repeat(64), result, day: '2026-11-16' },
      }),
    ).toMatchObject({ result, createdAt: expect.any(Date) })
  }
})
