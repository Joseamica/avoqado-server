import { runStalePendingAlert } from '@/jobs/stalePendingAlert.job'
import logger from '@/config/logger'

import { prismaMock } from '../../__helpers__/setup'

describe('runStalePendingAlert', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('logs an admin alert for every PENDING inbound message stuck >60s', async () => {
    const oldDate = new Date(Date.now() - 90 * 1000)
    prismaMock.venueChatMessage.findMany.mockResolvedValue([
      { id: 'm1', sessionId: 's1', sendAttemptedAt: oldDate, createdAt: oldDate },
      { id: 'm2', sessionId: 's2', sendAttemptedAt: null, createdAt: oldDate },
    ])

    await runStalePendingAlert()

    expect(prismaMock.venueChatMessage.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        relayStatus: 'PENDING',
        direction: 'INBOUND_FROM_CUSTOMER',
      }),
      select: expect.any(Object),
    })
    expect(logger.error).toHaveBeenCalledTimes(2)
    expect(logger.error).toHaveBeenCalledWith(
      '[ADMIN ALERT] Stale PENDING relay (no auto-retry)',
      expect.objectContaining({ messageId: 'm1', sessionId: 's1' }),
    )
  })

  it('is a no-op when there are no stale rows', async () => {
    prismaMock.venueChatMessage.findMany.mockResolvedValue([])
    await runStalePendingAlert()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('uses createdAt as fallback when sendAttemptedAt is null', async () => {
    const oldDate = new Date(Date.now() - 120 * 1000)
    prismaMock.venueChatMessage.findMany.mockResolvedValue([{ id: 'm3', sessionId: 's3', sendAttemptedAt: null, createdAt: oldDate }])

    await runStalePendingAlert()

    expect(logger.error).toHaveBeenCalledWith(
      '[ADMIN ALERT] Stale PENDING relay (no auto-retry)',
      expect.objectContaining({ messageId: 'm3', since: oldDate }),
    )
  })
})
