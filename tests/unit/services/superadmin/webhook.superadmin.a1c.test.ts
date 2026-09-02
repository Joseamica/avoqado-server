jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    webhookEvent: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
      aggregate: jest.fn(),
      groupBy: jest.fn(),
      update: jest.fn(),
    },
    activityLog: {
      upsert: jest.fn(),
    },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import prisma from '@/utils/prismaClient'
import { getWebhookEventDetails, getWebhookMetrics, listWebhookEvents } from '@/services/superadmin/webhook.superadmin.service'

const webhookEventDb = prisma.webhookEvent as unknown as {
  findMany: jest.Mock
  findUnique: jest.Mock
  count: jest.Mock
  aggregate: jest.Mock
  groupBy: jest.Mock
  update: jest.Mock
}
const due = new Date('2999-08-23T20:00:00.000Z')

function eventSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: 'webhook-1',
    stripeEventId: 'evt_1',
    eventType: 'invoice.payment_failed',
    status: 'FAILED',
    effectAttempts: 4,
    retryCount: 4,
    effectNextAttemptAt: due,
    classificationState: 'CLASSIFIED',
    classificationAttempts: 2,
    classificationNextAttemptAt: null,
    ownerKind: 'LEGACY',
    routeKey: 'LEGACY_SUBSCRIPTION_LIFECYCLE',
    subjectKind: 'VENUE_FEATURE',
    subjectId: 'feature-1',
    claimPhase: null,
    claimToken: null,
    claimedBy: null,
    claimedAt: null,
    claimExpiresAt: null,
    venueId: 'venue-1',
    ...overrides,
  }
}

describe('P3-1A1c-c Superadmin webhook reads', () => {
  beforeEach(() => jest.clearAllMocks())

  it('adds authority and phase filters without changing existing status filters or pagination', async () => {
    webhookEventDb.findMany.mockResolvedValue([])
    webhookEventDb.count.mockResolvedValue(0)

    await listWebhookEvents({
      eventType: 'invoice',
      status: 'FAILED' as never,
      venueId: 'venue-1',
      classificationState: 'CLASSIFIED' as never,
      ownerKind: 'LEGACY' as never,
      routeKey: 'LEGACY_SUBSCRIPTION_LIFECYCLE' as never,
      claimPhase: 'EFFECT' as never,
      limit: 20,
      offset: 40,
    } as never)

    const query = webhookEventDb.findMany.mock.calls[0][0]
    expect(query.where).toMatchObject({
      eventType: { contains: 'invoice' },
      status: 'FAILED',
      venueId: 'venue-1',
      classificationState: 'CLASSIFIED',
      ownerKind: 'LEGACY',
      routeKey: 'LEGACY_SUBSCRIPTION_LIFECYCLE',
      claimPhase: 'EFFECT',
    })
    expect(query).toMatchObject({ take: 20, skip: 40, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
    expect(webhookEventDb.count).toHaveBeenCalledWith({ where: query.where })
  })

  it('includes immutable bindings in detail while retaining all durable phase fields', async () => {
    const snapshot = eventSnapshot({
      stripeObjectBindings: [
        {
          objectType: 'INVOICE',
          stripeObjectId: 'in_1',
          ownerKind: 'LEGACY',
          routeKey: 'LEGACY_SUBSCRIPTION_LIFECYCLE',
          subjectKind: 'VENUE_FEATURE',
          subjectId: 'feature-1',
        },
      ],
    })
    webhookEventDb.findUnique.mockResolvedValue(snapshot)

    await expect(getWebhookEventDetails('webhook-1')).resolves.toEqual(snapshot)
    expect(webhookEventDb.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'webhook-1' },
        include: expect.objectContaining({ stripeObjectBindings: true }),
      }),
    )
  })

  it('adds classificationSummary and effectSummary as siblings without renaming legacy metrics', async () => {
    webhookEventDb.count.mockResolvedValueOnce(10).mockResolvedValueOnce(7).mockResolvedValueOnce(2).mockResolvedValueOnce(1)
    webhookEventDb.aggregate.mockResolvedValue({ _avg: { processingTime: 42 } })
    webhookEventDb.groupBy
      .mockResolvedValueOnce([{ eventType: 'invoice.paid', _count: { id: 6 } }])
      .mockResolvedValueOnce([{ classificationState: 'CLASSIFIED', _count: { id: 8 } }])
      .mockResolvedValueOnce([
        { status: 'SUCCESS', _count: { id: 7 } },
        { status: 'FAILED', _count: { id: 2 } },
      ])
    webhookEventDb.findMany.mockResolvedValue([{ id: 'failing-1' }])

    const metrics = await getWebhookMetrics({
      startDate: new Date('2026-08-01T00:00:00.000Z'),
      endDate: new Date('2026-08-23T23:59:59.999Z'),
    })

    expect(metrics).toMatchObject({
      summary: {
        totalEvents: 10,
        successCount: 7,
        failedCount: 2,
        pendingCount: 1,
        successRate: 70,
        avgProcessingTime: 42,
      },
      eventsByType: [{ type: 'invoice.paid', count: 6 }],
      failingEvents: [{ id: 'failing-1' }],
      classificationSummary: [{ state: 'CLASSIFIED', count: 8 }],
      effectSummary: [
        { status: 'SUCCESS', count: 7 },
        { status: 'FAILED', count: 2 },
      ],
    })
  })
})
