import { PlanWinbackJob } from '@/jobs/plan-winback.job'
import prisma from '@/utils/prismaClient'
import emailService from '@/services/email.service'
import * as planNotification from '@/services/access/planNotification.service'

// Make retry transparent: just invoke the wrapped fn (deterministic, no backoff).
jest.mock('@/utils/retry', () => ({
  __esModule: true,
  retry: (fn: () => unknown) => fn(),
  shouldRetryDbConnectionError: jest.fn(),
}))

jest.mock('@/services/access/planNotification.service', () => ({
  __esModule: true,
  resolvePlanNotificationTarget: jest.fn(),
}))

const mockPrisma = prisma as unknown as {
  venueFeature: { findMany: jest.Mock; update: jest.Mock }
}

const vfRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'vf1',
  venueId: 'v1',
  venue: { slug: 'bar-slug' },
  ...overrides,
})

describe('PlanWinbackJob.runNow', () => {
  let sendSpy: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    sendSpy = jest.spyOn(emailService, 'sendPlanWinbackEmail').mockResolvedValue(true)
    ;(planNotification.resolvePlanNotificationTarget as jest.Mock).mockResolvedValue({
      email: 'owner@x.com',
      locale: 'es',
      venueName: 'Bar',
      ownerName: 'Ana',
    })
    mockPrisma.venueFeature.update.mockResolvedValue({})
  })

  afterEach(() => sendSpy.mockRestore())

  // The DB `where` does the date/suspension/dedup filtering. Assert the filter is
  // correct (this is the part the plan flagged for verification), then assert the
  // send behavior over the rows the query returns.
  it('filters: PLAN_PRO, suspended ~3 days ago, winbackSentAt null, still suspended (active:false)', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([])

    await new PlanWinbackJob().runNow()

    const arg = mockPrisma.venueFeature.findMany.mock.calls[0][0]
    expect(arg.where.feature).toEqual({ code: 'PLAN_PRO' })
    expect(arg.where.winbackSentAt).toBeNull()
    expect(arg.where.active).toBe(false)
    // suspendedAt window: not null, between 4 and 2 days ago
    expect(arg.where.suspendedAt.not).toBeNull()
    expect(arg.where.suspendedAt.gte).toBeInstanceOf(Date)
    expect(arg.where.suspendedAt.lte).toBeInstanceOf(Date)
    const fourDaysAgoMs = Date.now() - 4 * 86400000
    const twoDaysAgoMs = Date.now() - 2 * 86400000
    expect(Math.abs(arg.where.suspendedAt.gte.getTime() - fourDaysAgoMs)).toBeLessThan(5000)
    expect(Math.abs(arg.where.suspendedAt.lte.getTime() - twoDaysAgoMs)).toBeLessThan(5000)
  })

  // 1. NEW FEATURE TESTS
  it('suspended ~3 days ago & winbackSentAt null → sends + stamps winbackSentAt', async () => {
    // Query already encodes the window/dedup; returning a row means it matched.
    mockPrisma.venueFeature.findMany.mockResolvedValue([vfRow()])

    await new PlanWinbackJob().runNow()

    expect(sendSpy).toHaveBeenCalledTimes(1)
    const [to, data] = sendSpy.mock.calls[0]
    expect(to).toBe('owner@x.com')
    expect(data).toMatchObject({ locale: 'es', venueName: 'Bar' })
    expect(data.reactivateUrl).toContain('bar-slug')
    expect(data.reactivateUrl).toContain('winback=1')
    expect(mockPrisma.venueFeature.update).toHaveBeenCalledWith({
      where: { id: 'vf1' },
      data: { winbackSentAt: expect.any(Date) },
    })
  })

  it('sends to multiple eligible venues', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([
      vfRow({ id: 'vf1', venueId: 'v1', venue: { slug: 'a' } }),
      vfRow({ id: 'vf2', venueId: 'v2', venue: { slug: 'b' } }),
    ])

    await new PlanWinbackJob().runNow()

    expect(sendSpy).toHaveBeenCalledTimes(2)
    expect(mockPrisma.venueFeature.update).toHaveBeenCalledTimes(2)
  })

  // 2. SKIP / EDGE CASES — these are excluded by the DB query (empty result),
  // proving the job does nothing when the filter matches nothing.
  it('suspended ~10 days ago → excluded by window → no send', async () => {
    // Outside the 2-4 day window → query returns nothing.
    mockPrisma.venueFeature.findMany.mockResolvedValue([])

    await new PlanWinbackJob().runNow()

    expect(sendSpy).not.toHaveBeenCalled()
    expect(mockPrisma.venueFeature.update).not.toHaveBeenCalled()
  })

  it('winbackSentAt already set → excluded by dedup filter → no send', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([])

    await new PlanWinbackJob().runNow()

    expect(sendSpy).not.toHaveBeenCalled()
    // confirm the dedup filter is part of the query
    expect(mockPrisma.venueFeature.findMany.mock.calls[0][0].where.winbackSentAt).toBeNull()
  })

  it('reactivated venue (active:true) → excluded by active:false filter → no send', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([])

    await new PlanWinbackJob().runNow()

    expect(sendSpy).not.toHaveBeenCalled()
    expect(mockPrisma.venueFeature.findMany.mock.calls[0][0].where.active).toBe(false)
  })

  it('null recipient → skip, no throw, no stamp', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([vfRow()])
    ;(planNotification.resolvePlanNotificationTarget as jest.Mock).mockResolvedValue({
      email: null,
      locale: 'es',
      venueName: 'Bar',
      ownerName: null,
    })

    await expect(new PlanWinbackJob().runNow()).resolves.toBeUndefined()

    expect(sendSpy).not.toHaveBeenCalled()
    expect(mockPrisma.venueFeature.update).not.toHaveBeenCalled()
  })

  // REGRESSION: one failing row must not abort the batch
  it('isolates a per-venue email failure so the rest of the batch still sends', async () => {
    mockPrisma.venueFeature.findMany.mockResolvedValue([
      vfRow({ id: 'vf1', venueId: 'v1', venue: { slug: 'a' } }),
      vfRow({ id: 'vf2', venueId: 'v2', venue: { slug: 'b' } }),
    ])
    sendSpy.mockRejectedValueOnce(new Error('Resend 500')).mockResolvedValueOnce(true)

    await expect(new PlanWinbackJob().runNow()).resolves.toBeUndefined()

    expect(sendSpy).toHaveBeenCalledTimes(2)
    // only the successful one is stamped
    expect(mockPrisma.venueFeature.update).toHaveBeenCalledTimes(1)
    expect(mockPrisma.venueFeature.update).toHaveBeenCalledWith({
      where: { id: 'vf2' },
      data: { winbackSentAt: expect.any(Date) },
    })
  })
})
