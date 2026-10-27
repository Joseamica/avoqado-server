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
    $queryRaw: jest.fn(),
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

describe('cancelled payment evidence — opt-in y un snapshot de lectura', () => {
  const verifiedAt = new Date('2026-10-23T12:00:00.000Z')
  const row = {
    id: 'order-A',
    externalId: 'original-A',
    venueId: 'venue-A',
    orderStatus: 'CANCELLED',
    hasPayments: false,
    hasTerminalRequests: false,
    verifiedAt,
  }

  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma.order.findMany as jest.Mock).mockResolvedValue([{ id: row.id, externalId: row.externalId }])
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValue([row])
  })

  afterEach(() => {
    expect(prisma.order.create).not.toHaveBeenCalled()
    expect(prisma.order.update).not.toHaveBeenCalled()
    expect(prisma.payment.create).not.toHaveBeenCalled()
    expect(prisma.payment.update).not.toHaveBeenCalled()
  })

  test('sin opt-in conserva exactamente la respuesta y consulta anteriores', async () => {
    expect(await lookupSyncRecovery('venue-A', { externalOrderIds: ['original-A'] })).toEqual({
      intents: [],
      orders: [{ orderId: row.id, externalId: row.externalId }],
    })
    expect(prisma.$queryRaw).not.toHaveBeenCalled()
  })

  test('identidad, estado y ausencias se acreditan en un único SELECT acotado, sin N+1', async () => {
    const result = await lookupSyncRecovery('venue-A', { externalOrderIds: ['original-A'], includeCancelledPaymentEvidence: true })
    expect(result.orders).toEqual([
      {
        orderId: row.id,
        externalId: row.externalId,
        cancelledPaymentEvidence: {
          version: 1,
          venueId: row.venueId,
          orderId: row.id,
          externalId: row.externalId,
          orderStatus: 'CANCELLED',
          hasPayments: false,
          hasTerminalRequests: false,
          verifiedAt: verifiedAt.toISOString(),
        },
      },
    ])
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1)
    expect(prisma.order.findMany).not.toHaveBeenCalled()
    const sql = (prisma.$queryRaw as jest.Mock).mock.calls[0][0]
    expect(sql.text).toMatch(/SELECT[\s\S]*EXISTS[\s\S]*"Payment"[\s\S]*EXISTS[\s\S]*"TerminalPaymentRequest"/i)
    expect(sql.text).toMatch(/LIMIT/i)
    expect(sql.values).toEqual(expect.arrayContaining(['venue-A', 'original-A', 100]))
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  test.each([{ orderStatus: 'CONFIRMED' }, { hasPayments: true }, { hasTerminalRequests: true }])(
    'lo que impide revisar queda explícito, nunca acredita una cancelada sin dinero (%j)',
    async change => {
      ;(prisma.$queryRaw as jest.Mock).mockResolvedValue([{ ...row, ...change }])
      const result = await lookupSyncRecovery('venue-A', { externalOrderIds: ['original-A'], includeCancelledPaymentEvidence: true })
      expect(result.orders[0]).toHaveProperty('cancelledPaymentEvidence', expect.objectContaining(change))
    },
  )

  test.each([
    { orderStatus: 'CONFIRMED', hasPayments: false, hasTerminalRequests: false },
    { orderStatus: 'CANCELLED', hasPayments: true, hasTerminalRequests: false },
    { orderStatus: 'CANCELLED', hasPayments: false, hasTerminalRequests: true },
  ])('cruce D2/S3: reserva viva y evidencia adversa no se convierten en cancelación acreditada (%j)', async change => {
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValue([{ ...row, ...change, total: 110 }])
    ;(prisma.posSyncIntent.findMany as jest.Mock).mockResolvedValue([
      {
        idempotencyKey: 'cash-capture-zero',
        type: 'PAY_CASH',
        deviceId: 'device-original',
        seq: 9,
        localRef: 'local-original',
        status: 'PROCESSING',
        errorCode: null,
        resultJson: { protocolo: 'huella-v1', retomable: true, huella: { orderId: row.id, amount: 0 } },
      },
    ])
    const result = await lookupSyncRecovery('venue-A', {
      deviceId: 'device-original',
      intentIds: ['cash-capture-zero'],
      externalOrderIds: [row.externalId],
      includeCancelledPaymentEvidence: true,
    })
    expect(result.intents).toEqual([
      expect.objectContaining({ id: 'cash-capture-zero', status: 'PROCESSING', result: null, localRef: 'local-original' }),
    ])
    expect(result.orders).toEqual([
      {
        orderId: row.id,
        externalId: row.externalId,
        cancelledPaymentEvidence: {
          version: 1,
          venueId: row.venueId,
          orderId: row.id,
          externalId: row.externalId,
          ...change,
          verifiedAt: verifiedAt.toISOString(),
        },
      },
    ])
    expect(prisma.posSyncIntent.create).not.toHaveBeenCalled()
    expect(prisma.posSyncIntent.update).not.toHaveBeenCalled()
    expect(prisma.posSyncIntent.delete).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  test('una orden inexistente no recibe evidencia por el simple hecho de no haber pagos', async () => {
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValue([])
    const result = await lookupSyncRecovery('venue-A', { externalOrderIds: ['original-A'], includeCancelledPaymentEvidence: true })
    expect(result.orders).toEqual([])
  })

  test('100 folios se resuelven en el mismo snapshot y cada uno conserva su identidad exacta', async () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({ ...row, id: `order-${index}`, externalId: `folio-${index}` }))
    ;(prisma.$queryRaw as jest.Mock).mockResolvedValue(rows)
    const result = await lookupSyncRecovery('venue-A', {
      externalOrderIds: rows.map(item => item.externalId),
      includeCancelledPaymentEvidence: true,
    })
    expect(result.orders).toHaveLength(100)
    result.orders.forEach((item, index) =>
      expect(item).toMatchObject({
        orderId: rows[index].id,
        externalId: rows[index].externalId,
        cancelledPaymentEvidence: { orderId: rows[index].id, externalId: rows[index].externalId },
      }),
    )
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1)
    expect(prisma.order.findMany).not.toHaveBeenCalled()
  })

  test('el límite también rechaza un opt-in hostil antes de abrir el snapshot', async () => {
    await expect(
      lookupSyncRecovery('venue-A', {
        externalOrderIds: Array.from({ length: 101 }, (_, index) => `folio-${index}`),
        includeCancelledPaymentEvidence: true,
      }),
    ).rejects.toBeInstanceOf(BadRequestError)
    expect(prisma.$queryRaw).not.toHaveBeenCalled()
  })

  test.each(['true', 1, null, {}])('opt-in no booleano se rechaza antes de consultar (%j)', async includeCancelledPaymentEvidence => {
    await expect(
      lookupSyncRecovery('venue-A', { externalOrderIds: ['original-A'], includeCancelledPaymentEvidence }),
    ).rejects.toBeInstanceOf(BadRequestError)
    expect(prisma.$queryRaw).not.toHaveBeenCalled()
    expect(prisma.order.findMany).not.toHaveBeenCalled()
  })
})
