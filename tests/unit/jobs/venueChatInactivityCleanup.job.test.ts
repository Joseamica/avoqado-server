import { runVenueChatInactivityCleanup } from '@/jobs/venueChatInactivityCleanup.job'
import logger from '@/config/logger'

import { prismaMock } from '../../__helpers__/setup'

describe('runVenueChatInactivityCleanup', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('closes OPEN sessions inactive for >7 days and logs the count', async () => {
    prismaMock.venueChatSession.updateMany.mockResolvedValue({ count: 4 })

    await runVenueChatInactivityCleanup()

    expect(prismaMock.venueChatSession.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        status: 'OPEN',
        lastActivityAt: expect.objectContaining({ lt: expect.any(Date) }),
      }),
      data: expect.objectContaining({
        status: 'CLOSED_BY_INACTIVITY',
        closedAt: expect.any(Date),
      }),
    })

    const call = (prismaMock.venueChatSession.updateMany as jest.Mock).mock.calls[0][0]
    const cutoff: Date = call.where.lastActivityAt.lt
    const expectedMs = Date.now() - 7 * 24 * 3600 * 1000
    expect(Math.abs(cutoff.getTime() - expectedMs)).toBeLessThan(5_000)

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Closed 4 venue chat session(s)'))
  })

  it('does not log when no sessions were closed', async () => {
    prismaMock.venueChatSession.updateMany.mockResolvedValue({ count: 0 })
    await runVenueChatInactivityCleanup()
    expect(logger.info).not.toHaveBeenCalled()
  })
})
