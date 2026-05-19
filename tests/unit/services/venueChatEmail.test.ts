import emailService from '@/services/email.service'
import { maybeSendVenueReplyEmail } from '@/services/venueChatEmail.service'

import { prismaMock } from '../../__helpers__/setup'

jest.mock('@/services/email.service', () => ({
  __esModule: true,
  default: { sendEmail: jest.fn() },
}))

const SESSION_ID = 'sess-1'

function buildSession(overrides: Partial<any> = {}) {
  return {
    id: SESSION_ID,
    customerName: 'Juan',
    customerEmail: 'juan@example.com',
    lastCustomerSeenAt: null,
    lastEmailNotifiedAt: null,
    venue: { name: 'Estética Bella', slug: 'estetica-bella' },
    ...overrides,
  }
}

describe('maybeSendVenueReplyEmail', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('sends email and bumps lastEmailNotifiedAt when all preconditions hold', async () => {
    prismaMock.venueChatSession.findUnique.mockResolvedValue(buildSession())
    ;(emailService.sendEmail as jest.Mock).mockResolvedValue(true)
    prismaMock.venueChatSession.update.mockResolvedValue({} as any)

    await maybeSendVenueReplyEmail(SESSION_ID)

    expect(emailService.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'juan@example.com',
        subject: expect.stringContaining('Estética Bella'),
        html: expect.stringContaining('Estética Bella'),
        text: expect.stringContaining('Estética Bella'),
      }),
    )
    expect(prismaMock.venueChatSession.update).toHaveBeenCalledWith({
      where: { id: SESSION_ID },
      data: expect.objectContaining({ lastEmailNotifiedAt: expect.any(Date) }),
    })
  })

  it('skips when customerEmail is not set', async () => {
    prismaMock.venueChatSession.findUnique.mockResolvedValue(buildSession({ customerEmail: null }))
    await maybeSendVenueReplyEmail(SESSION_ID)
    expect(emailService.sendEmail).not.toHaveBeenCalled()
  })

  it('skips when customer was seen <90s ago (still viewing)', async () => {
    prismaMock.venueChatSession.findUnique.mockResolvedValue(buildSession({ lastCustomerSeenAt: new Date(Date.now() - 30_000) }))
    await maybeSendVenueReplyEmail(SESSION_ID)
    expect(emailService.sendEmail).not.toHaveBeenCalled()
  })

  it('sends when customer last seen >90s ago', async () => {
    prismaMock.venueChatSession.findUnique.mockResolvedValue(buildSession({ lastCustomerSeenAt: new Date(Date.now() - 120_000) }))
    ;(emailService.sendEmail as jest.Mock).mockResolvedValue(true)
    prismaMock.venueChatSession.update.mockResolvedValue({} as any)
    await maybeSendVenueReplyEmail(SESSION_ID)
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1)
  })

  it('skips when an email was already sent <4h ago', async () => {
    prismaMock.venueChatSession.findUnique.mockResolvedValue(buildSession({ lastEmailNotifiedAt: new Date(Date.now() - 1 * 3600 * 1000) }))
    await maybeSendVenueReplyEmail(SESSION_ID)
    expect(emailService.sendEmail).not.toHaveBeenCalled()
  })

  it('sends when last email is >4h old', async () => {
    prismaMock.venueChatSession.findUnique.mockResolvedValue(buildSession({ lastEmailNotifiedAt: new Date(Date.now() - 5 * 3600 * 1000) }))
    ;(emailService.sendEmail as jest.Mock).mockResolvedValue(true)
    prismaMock.venueChatSession.update.mockResolvedValue({} as any)
    await maybeSendVenueReplyEmail(SESSION_ID)
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1)
  })

  it('does not bump lastEmailNotifiedAt if sendEmail returns false', async () => {
    prismaMock.venueChatSession.findUnique.mockResolvedValue(buildSession())
    ;(emailService.sendEmail as jest.Mock).mockResolvedValue(false)
    await maybeSendVenueReplyEmail(SESSION_ID)
    expect(prismaMock.venueChatSession.update).not.toHaveBeenCalled()
  })

  it('swallows sendEmail thrown errors without crashing', async () => {
    prismaMock.venueChatSession.findUnique.mockResolvedValue(buildSession())
    ;(emailService.sendEmail as jest.Mock).mockRejectedValue(new Error('SMTP down'))
    await expect(maybeSendVenueReplyEmail(SESSION_ID)).resolves.toBeUndefined()
    expect(prismaMock.venueChatSession.update).not.toHaveBeenCalled()
  })

  it('skips silently when session does not exist', async () => {
    prismaMock.venueChatSession.findUnique.mockResolvedValue(null)
    await maybeSendVenueReplyEmail(SESSION_ID)
    expect(emailService.sendEmail).not.toHaveBeenCalled()
  })

  it('builds email link with #chat-resume URL fragment (no raw token)', async () => {
    prismaMock.venueChatSession.findUnique.mockResolvedValue(buildSession())
    ;(emailService.sendEmail as jest.Mock).mockResolvedValue(true)
    prismaMock.venueChatSession.update.mockResolvedValue({} as any)

    await maybeSendVenueReplyEmail(SESSION_ID)

    const arg = (emailService.sendEmail as jest.Mock).mock.calls[0][0]
    expect(arg.html).toContain(`#chat-resume=${SESSION_ID}`)
    expect(arg.text).toContain(`#chat-resume=${SESSION_ID}`)
    expect(arg.html).not.toMatch(/[?&]t=/) // no raw access token in URL
  })

  it('escapes HTML metacharacters in venue and customer names', async () => {
    prismaMock.venueChatSession.findUnique.mockResolvedValue(
      buildSession({
        customerName: '<script>',
        venue: { name: 'Bella & Co', slug: 'bella-co' },
      }),
    )
    ;(emailService.sendEmail as jest.Mock).mockResolvedValue(true)
    prismaMock.venueChatSession.update.mockResolvedValue({} as any)

    await maybeSendVenueReplyEmail(SESSION_ID)

    const arg = (emailService.sendEmail as jest.Mock).mock.calls[0][0]
    expect(arg.html).toContain('&lt;script&gt;')
    expect(arg.html).toContain('Bella &amp; Co')
    expect(arg.html).not.toContain('<script>')
  })
})
