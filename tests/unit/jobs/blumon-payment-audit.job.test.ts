import { BlumonPaymentAuditJob } from '@/jobs/blumon-payment-audit.job'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $queryRaw: jest.fn(),
    payment: { update: jest.fn(), findUnique: jest.fn() },
  },
}))

const mockedRaw = prisma.$queryRaw as unknown as jest.Mock
const mockedUpdate = prisma.payment.update as jest.Mock
const mockedFindUnique = prisma.payment.findUnique as jest.Mock

const row = {
  id: 'pay_x',
  amount: '150.00',
  venueName: 'Mindform',
  createdAt: new Date('2026-07-18T10:00:00Z'),
  authorizationNumber: 'A1',
}

/**
 * The reconciliation job answers "webhook without Payment?". This one answers
 * the INVERSE — "card Payment whose Blumon webhook never arrived?" — which was
 * invisible until now (the Mindform $1,400 class).
 */
describe('BlumonPaymentAuditJob', () => {
  beforeEach(() => {
    ;[mockedRaw, mockedUpdate, mockedFindUnique].forEach(m => m.mockReset())
    mockedUpdate.mockResolvedValue({})
  })

  it('alerts once per webhook-less card payment and MERGES the antispam marker', async () => {
    mockedRaw.mockResolvedValue([row])
    mockedFindUnique.mockResolvedValue({ processorData: { existingKey: 'keep-me' } })

    const alerted = await new BlumonPaymentAuditJob().runOnce()

    expect(alerted).toBe(1)
    const written = mockedUpdate.mock.calls[0][0].data.processorData
    // processorData carries blumon* keys written by the webhook service —
    // a bare overwrite would wipe them.
    expect(written.existingKey).toBe('keep-me')
    expect(written.webhookAuditAlertedAt).toBeDefined()
  })

  it('quiet pass when nothing is missing', async () => {
    mockedRaw.mockResolvedValue([])

    expect(await new BlumonPaymentAuditJob().runOnce()).toBe(0)
    expect(mockedUpdate).not.toHaveBeenCalled()
  })

  it('a transient DB failure reports 0 without crashing the cron', async () => {
    mockedRaw.mockRejectedValue(new Error('connection lost'))

    await expect(new BlumonPaymentAuditJob().runOnce()).resolves.toBe(0)
  })

  it('stop() is safe to call before start()', () => {
    expect(() => new BlumonPaymentAuditJob().stop()).not.toThrow()
  })

  describe('reportWebhookGaps (daily merchant-level gap report)', () => {
    it('warns with the gap merchants when production merchants have card volume but no webhooks', async () => {
      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger)
      mockedRaw.mockResolvedValue([
        { merchant: 'Doña Simona', serial: '2840744168', posId: '7012', payments: 124, totalAmount: '76385.50', lastPayment: new Date() },
        { merchant: 'Berthe', serial: '28407441672', posId: '9494', payments: 2, totalAmount: '6532.50', lastPayment: new Date() },
      ])

      const gaps = await new BlumonPaymentAuditJob().reportWebhookGaps()

      expect(gaps).toBe(2)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[Blumon gap]'), expect.objectContaining({ merchantCount: 2 }))
      warnSpy.mockRestore()
    })

    it('reports 0 (no gap) when every production merchant is receiving webhooks', async () => {
      mockedRaw.mockResolvedValue([])
      expect(await new BlumonPaymentAuditJob().reportWebhookGaps()).toBe(0)
    })

    it('a transient DB failure reports 0 without crashing the daily report', async () => {
      mockedRaw.mockRejectedValue(new Error('connection lost'))
      await expect(new BlumonPaymentAuditJob().reportWebhookGaps()).resolves.toBe(0)
    })
  })
})
