/**
 * The send boundary must refuse provably-undeliverable recipients.
 *
 * Regression guard for the daily hard-bounce flow found on 2026-08-23: the
 * nightly jobs emailed demo/seed staff (`admin@admin.com`, `luis.castro@
 * avoqado-full.avoqado.io`, `tpv-…@internal.avoqado.io`) and every send came
 * back as a Permanent bounce ~14h later, burning the reputation that the real
 * transactional mail depends on.
 */

// The service captures `RESEND_API_KEY` at import time, so set it before requiring.
process.env.RESEND_API_KEY = 'test-key'

const sendMock = jest.fn().mockResolvedValue({ data: { id: 'resend-id' }, error: null })

jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: sendMock } })),
}))

import emailService from '@/services/email.service'

describe('emailService.sendEmail — undeliverable recipient guard', () => {
  beforeEach(() => sendMock.mockClear())

  const payload = { subject: 'Inventario bajo', html: '<p>hola</p>' }

  it.each([
    ['admin@admin.com', 'SEED_ACCOUNT'],
    ['owner@owner.com', 'SEED_ACCOUNT'],
    ['manager@manager.com', 'SEED_ACCOUNT'],
    ['luis.castro@avoqado-full.avoqado.io', 'PLACEHOLDER_DOMAIN'],
    ['tpv-keppler-1776271462836-3w4w0u@internal.avoqado.io', 'PLACEHOLDER_DOMAIN'],
    ['emilio-morayta@testarudo-cafe.pos.local', 'RESERVED_TLD'],
    ['test@example.com', 'RESERVED_DOMAIN'],
    ['garbage', 'MALFORMED'],
  ])('never hands %s to Resend (%s)', async to => {
    const sent = await emailService.sendEmail({ to, ...payload })

    expect(sendMock).not.toHaveBeenCalled()
    expect(sent).toBe(false)
  })

  it.each(['mindformhouse@gmail.com', 'isaac.mayoral@playtelecom.com', 'onboarding@avoqado.io'])(
    'still sends to the real recipient %s',
    async to => {
      const sent = await emailService.sendEmail({ to, ...payload })

      expect(sendMock).toHaveBeenCalledTimes(1)
      expect(sendMock.mock.calls[0][0].to).toBe(to)
      expect(sent).toBe(true)
    },
  )

  it('reports not-sent so the job counters stop over-reporting success', async () => {
    // `emailsSent` in the cron jobs increments on a truthy return. A blocked
    // recipient must therefore be falsy, or the job keeps claiming 16/16 sent.
    await expect(emailService.sendEmail({ to: 'admin@admin.com', ...payload })).resolves.toBe(false)
  })
})
