import { lookupSyncRecovery } from '@/services/mobile/sync-recovery.mobile.service'
import prisma from '@/utils/prismaClient'
import { BadRequestError } from '@/errors/AppError'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    posSyncIntent: { findMany: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
    order: { findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
    payment: { create: jest.fn(), update: jest.fn() },
    $transaction: jest.fn(),
  },
}))

describe('Q16 readonly recovery before any pricing effect', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.posSyncIntent.findMany as jest.Mock).mockResolvedValue([])
    ;(prisma.order.findMany as jest.Mock).mockResolvedValue([])
  })
  afterEach(() => {
    expect(prisma.posSyncIntent.create).not.toHaveBeenCalled()
    expect(prisma.posSyncIntent.update).not.toHaveBeenCalled()
    expect(prisma.posSyncIntent.delete).not.toHaveBeenCalled()
    expect(prisma.order.create).not.toHaveBeenCalled()
    expect(prisma.order.update).not.toHaveBeenCalled()
    expect(prisma.payment.create).not.toHaveBeenCalled()
    expect(prisma.payment.update).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  test('returns the original terminal result under the original venue/device identity', async () => {
    const result = { orderId: 'server-A', paymentId: 'paid-A', amount: 4000, tipAmount: 500 }
    ;(prisma.posSyncIntent.findMany as jest.Mock).mockResolvedValue([
      {
        idempotencyKey: 'op-A',
        type: 'PAY_CASH',
        deviceId: 'device-A',
        seq: 42,
        localRef: 'local-A',
        status: 'ACKED',
        errorCode: null,
        resultJson: result,
      },
    ])
    expect(await lookupSyncRecovery('venue-A', { deviceId: 'device-A', intentIds: ['op-A'] })).toEqual({
      intents: [
        { id: 'op-A', type: 'PAY_CASH', deviceId: 'device-A', seq: 42, localRef: 'local-A', status: 'ACKED', errorCode: null, result },
      ],
      orders: [],
    })
    expect(prisma.posSyncIntent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          venueId: 'venue-A',
          deviceId: 'device-A',
          idempotencyKey: { in: ['op-A'] },
          type: { in: ['OPEN_TABLE', 'ADD_ITEMS', 'PAY_CASH'] },
        },
        take: 100,
      }),
    )
    expect(prisma.order.findMany).not.toHaveBeenCalled()
  })

  test('an old PROCESSING result stays uncertain without expiring or reexecuting it', async () => {
    ;(prisma.posSyncIntent.findMany as jest.Mock).mockResolvedValue([
      {
        idempotencyKey: 'op-A',
        type: 'ADD_ITEMS',
        deviceId: 'device-A',
        seq: null,
        localRef: 'local-A',
        status: 'PROCESSING',
        errorCode: null,
        resultJson: null,
      },
    ])
    const recovered = await lookupSyncRecovery('venue-A', { deviceId: 'device-A', intentIds: ['op-A'] })
    expect(recovered.intents).toEqual([expect.objectContaining({ id: 'op-A', status: 'PROCESSING', result: null })])
  })

  test('recovers only the existing order ID and never reapplies the reward or catalog', async () => {
    ;(prisma.order.findMany as jest.Mock).mockResolvedValue([{ id: 'server-A', externalId: 'original-A' }])
    expect(await lookupSyncRecovery('venue-A', { externalOrderIds: ['original-A'] })).toEqual({
      intents: [],
      orders: [{ orderId: 'server-A', externalId: 'original-A' }],
    })
    expect(prisma.order.findMany).toHaveBeenCalledWith({
      where: { venueId: 'venue-A', externalId: { in: ['original-A'] } },
      take: 100,
      select: { id: true, externalId: true },
    })
    expect(prisma.posSyncIntent.findMany).not.toHaveBeenCalled()
  })

  test('missing identities remain missing, never create a replacement', async () => {
    expect(
      await lookupSyncRecovery('venue-A', { deviceId: 'device-A', intentIds: ['missing-op'], externalOrderIds: ['missing-order'] }),
    ).toEqual({ intents: [], orders: [] })
    expect(prisma.posSyncIntent.findMany).toHaveBeenCalledTimes(1)
    expect(prisma.order.findMany).toHaveBeenCalledTimes(1)
  })

  test.each([
    null,
    [],
    'bad',
    {},
    { intentIds: ['op'] },
    { deviceId: ' ', intentIds: ['op'] },
    { deviceId: 'd'.repeat(65), intentIds: ['op'] },
    { intentIds: null },
    { externalOrderIds: null },
    { deviceId: 'd', intentIds: [true] },
    { externalOrderIds: [''] },
    { externalOrderIds: [' '.repeat(2)] },
    { deviceId: 'd', intentIds: ['x'.repeat(65)] },
    { externalOrderIds: ['x'.repeat(257)] },
    { externalOrderIds: Array.from({ length: 101 }, (_, i) => `e-${i}`) },
    {
      deviceId: 'd',
      intentIds: Array.from({ length: 51 }, (_, i) => `i-${i}`),
      externalOrderIds: Array.from({ length: 50 }, (_, i) => `e-${i}`),
    },
  ])('rejects invalid/unbounded input before reading any tenant (%j)', async body => {
    await expect(lookupSyncRecovery('venue-A', body)).rejects.toBeInstanceOf(BadRequestError)
    expect(prisma.posSyncIntent.findMany).not.toHaveBeenCalled()
    expect(prisma.order.findMany).not.toHaveBeenCalled()
  })

  test.each([undefined, null, '', ' '])('rejects a missing tenant before any query (%j)', async venueId => {
    await expect(
      lookupSyncRecovery(venueId as unknown as string, { deviceId: 'device-A', intentIds: ['op-A'], externalOrderIds: ['order-A'] }),
    ).rejects.toBeInstanceOf(BadRequestError)
    expect(prisma.posSyncIntent.findMany).not.toHaveBeenCalled()
    expect(prisma.order.findMany).not.toHaveBeenCalled()
  })

  test('100 requested identities are all queryable; the limit does not silently hide a match', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `e-${i}`)
    const rows = ids.map((externalId, i) => ({ externalId, id: `server-${i}` }))
    ;(prisma.order.findMany as jest.Mock).mockResolvedValue(rows)
    const result = await lookupSyncRecovery('venue-A', { externalOrderIds: ids })
    expect(result.orders).toEqual(rows.map(row => ({ externalId: row.externalId, orderId: row.id })))
    expect(result.orders).toHaveLength(100)
  })
})
