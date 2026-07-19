import { BlumonPaymentAuditJob } from '@/jobs/blumon-payment-audit.job'
import prisma from '@/utils/prismaClient'

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
})
