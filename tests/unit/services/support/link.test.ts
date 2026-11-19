import prisma from '@/utils/prismaClient'
import * as linkService from '@/services/support/link.service'
import { createTokenCipher } from '@/lib/token-encryption'

const db = prisma as any
const strongAuthAt = new Date()
const requestLink = (staffId: string, input: { phone: string; operationKey: string }) =>
  linkService.requestLink(staffId, input, { strongAuthAt })
const verifyLink = (staffId: string, input: { challengeId: string; code: string }) =>
  linkService.verifyLink(staffId, input, { strongAuthAt })
const unlink = (staffId: string, venueId?: string) => linkService.unlink(staffId, { strongAuthAt, venueId })
const phone = '+525511112222'
const now = new Date()
const conversation = {
  id: 'c123456789012345678901234',
  phone,
  receiverId: 'support-number',
  generation: 2,
  nextSequence: 3,
  lastUserMessageAt: now,
  mode: 'PUBLIC',
}
beforeEach(() => {
  process.env.SUPPORT_WHATSAPP_ENABLED = 'true'
  process.env.SUPPORT_WHATSAPP_ENC_KEY = 'e'.repeat(64)
  process.env.SUPPORT_WHATSAPP_PHONE_NUMBER_ID = 'support-number'
  process.env.WHATSAPP_PHONE_NUMBER_ID = 'central'
  process.env.WHATSAPP_SALES_PHONE_NUMBER_ID = 'sales'
  db.$executeRaw.mockResolvedValue(0)
  db.staff.findUnique.mockResolvedValue({ active: true, lastPasswordReset: null, sessionsRevokedAt: null })
  db.supportConversation.findFirst.mockResolvedValue(conversation)
  db.supportConversation.update.mockResolvedValue({ ...conversation, nextSequence: 4 })
  db.supportWhatsappLink.findFirst.mockResolvedValue(null)
  db.supportWhatsappLink.findUnique.mockResolvedValue(null)
  db.supportLinkChallenge.findUnique.mockResolvedValue(null)
  db.supportLinkChallenge.count.mockResolvedValue(0)
  db.supportLinkChallenge.findFirst.mockResolvedValue(null)
  db.supportLinkChallenge.create.mockImplementation(({ data }: any) => ({ ...data, createdAt: now }))
})
afterEach(() => {
  delete process.env.SUPPORT_WHATSAPP_ENABLED
})

// T-F15: the panel's card shows the support's own number, only while the support is on.
describe('T-F15: the status carries the support number', () => {
  const status = () => linkService.getLinkStatus('staff-test')
  afterEach(() => {
    delete process.env.SUPPORT_WHATSAPP_DISPLAY_NUMBER
  })
  it('a valid number: its display and wa.me link', async () => {
    process.env.SUPPORT_WHATSAPP_DISPLAY_NUMBER = '+1 555 788 4728'
    expect(await status()).toMatchObject({
      enabled: true,
      supportNumber: { display: '+1 555 788 4728', waMe: 'https://wa.me/15557884728' },
    })
  })
  it.each([
    ['unset', undefined],
    ['invalid', 'llámanos'],
  ])('%s: null', async (_case, value) => {
    if (value !== undefined) process.env.SUPPORT_WHATSAPP_DISPLAY_NUMBER = value
    expect(await status()).toMatchObject({ enabled: true, supportNumber: null })
  })
  it('with the support off: null, even with a number set', async () => {
    process.env.SUPPORT_WHATSAPP_DISPLAY_NUMBER = '+1 555 788 4728'
    process.env.SUPPORT_WHATSAPP_ENABLED = 'false'
    expect(await status()).toMatchObject({ enabled: false, supportNumber: null })
  })
})

// T-F14 (ruling T-P1): the code is asked for on the support number's chat, under the router's lock key for that number.
it('T-F14: a challenge locks and looks up the chat of the support number, never the central one', async () => {
  await requestLink('staff-test', { phone, operationKey: 'tf14-support-number' })
  const keys = db.$executeRaw.mock.calls.flatMap((call: unknown[]) => call.slice(1))
  expect(keys).toContain(`support-phone:support-number:${phone}`)
  expect(JSON.stringify(keys)).not.toContain('central')
  expect(db.supportConversation.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({ where: expect.objectContaining({ phone, receiverId: 'support-number' }) }),
  )
})

describe('support account ownership', () => {
  it('rechecks credential cuts after acquiring the identity row, before granting a challenge', async () => {
    db.$executeRaw.mockImplementation(async (sql: TemplateStringsArray) => {
      if (sql.join('').includes('FROM "Staff"'))
        db.staff.findUnique.mockResolvedValue({ active: true, sessionsRevokedAt: new Date(), lastPasswordReset: null })
      return 0
    })
    await expect(requestLink('staff-test', { phone, operationKey: 'cut-between-guard-and-write' })).rejects.toMatchObject({
      code: 'SUPPORT_ACCESS_REVOKED',
    })
    expect(db.supportLinkChallenge.create).not.toHaveBeenCalled()
  })

  it('queues one encrypted challenge after the same phone opened the conversation; never uses Staff.phone as proof', async () => {
    const result = await requestLink('staff-test', { phone: '+5215511112222', operationKey: 'operation-1' })
    expect(result.challengeId).toMatch(/^c[a-z0-9]{24}$/)
    const challenge = db.supportLinkChallenge.create.mock.calls[0][0].data
    const message = db.supportMessage.create.mock.calls[0][0].data
    expect(challenge.phone).toBe(phone)
    expect(message).toMatchObject({
      purpose: 'LINK_CODE',
      body: '',
      conversationId: conversation.id,
      generation: 2,
      sequence: 4,
      status: 'ANSWER_READY',
    })
    expect(message.answer).toBeUndefined()
    expect(createTokenCipher('SUPPORT_WHATSAPP_ENC_KEY').decryptFromBase64(message.answerCipher)).toMatch(/^\d{6}$/)
    expect(challenge.codeHash).not.toContain(message.answerCipher)
  })
  it('does not create a challenge before a recent inbound, while disabled or for an occupied number', async () => {
    db.supportConversation.findFirst.mockResolvedValueOnce(null)
    await expect(requestLink('staff-test', { phone, operationKey: 'a' })).rejects.toMatchObject({ code: 'SUPPORT_OPEN_CHAT_FIRST' })
    delete process.env.SUPPORT_WHATSAPP_ENABLED
    await expect(requestLink('staff-test', { phone, operationKey: 'b' })).rejects.toMatchObject({ code: 'SUPPORT_UNAVAILABLE' })
    process.env.SUPPORT_WHATSAPP_ENABLED = 'true'
    db.supportWhatsappLink.findFirst.mockResolvedValueOnce({ staffId: 'other' })
    await expect(requestLink('staff-test', { phone, operationKey: 'c' })).rejects.toMatchObject({ code: 'SUPPORT_PHONE_UNAVAILABLE' })
    expect(db.supportLinkChallenge.create).not.toHaveBeenCalled()
  })
  it('a consumed confirmation cannot recreate a link after unlink', async () => {
    db.supportLinkChallenge.findUnique.mockResolvedValue({ staffId: 'staff-test', consumedAt: now, phone, createdAt: now })
    await expect(verifyLink('staff-test', { challengeId: conversation.id, code: '123456' })).resolves.toEqual({ linked: false })
    expect(db.supportWhatsappLink.create).not.toHaveBeenCalled()
  })
  it('unlink is idempotent and invalidates the conversation generation and queued personal output', async () => {
    db.supportWhatsappLink.findUnique.mockResolvedValueOnce({ id: conversation.id, staffId: 'staff-test', phone })
    await unlink('staff-test')
    expect(db.supportMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED', answer: null, answerCipher: null }) }),
    )
    expect(db.supportConversation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ generation: { increment: 1 }, staffId: null, venueId: null }),
      }),
    )
    expect(db.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'SUPPORT_WHATSAPP_UNLINKED', staffId: 'staff-test' }) }),
    )
    await unlink('staff-test')
    expect(db.supportWhatsappLink.delete).toHaveBeenCalledTimes(1)
  })
})
