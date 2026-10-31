import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import * as orders from '@/services/mobile/order.mobile.service'

type Proof = Record<string, any>
const lookup = (venueId: string, key: string): Promise<Proof | null> =>
  (orders as unknown as { getCashPaymentByKey: (venueId: string, key: string) => Promise<Proof | null> }).getCashPaymentByKey(venueId, key)
const venueId = 'c0000000000000000000000001'
const orderId = 'c0000000000000000000000002'
const key = 'exact-original-key'
const decimal = (amount: string) => new Prisma.Decimal(amount)
const payment = (extra: Record<string, unknown> = {}) => ({
  id: 'c0000000000000000000000003',
  venueId,
  idempotencyKey: key,
  orderId,
  type: 'REGULAR',
  status: 'COMPLETED',
  method: 'CASH',
  fundsFlow: 'CASH_DRAWER',
  tenderTypeId: null,
  tenderRevision: null,
  splitType: 'FULLPAYMENT',
  amount: decimal('19.99'),
  tipAmount: decimal('0.01'),
  thirdPartyCashAmount: null,
  order: { id: orderId, venueId, externalId: 'local-original-order', thirdPartyCashDue: null },
  processorData: { private: 'do-not-return' },
  receiptAccessKey: 'do-not-return',
  ...extra,
})

describe('cash payment exact-key recovery — read-only canonical evidence', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.mocked(prisma.payment.findUnique).mockResolvedValue(payment() as never)
    jest.mocked(prisma.order.findUnique).mockResolvedValue({
      id: orderId,
      venueId,
      externalId: 'local-original-order',
      thirdPartyCashDue: null,
      paymentStatus: 'PARTIAL',
      total: decimal('40.00'),
      paidAmount: decimal('20.00'),
      remainingBalance: decimal('20.00'),
    } as never)
  })

  afterEach(() => {
    // No business writes, payment responders, table release, receipts or outbox processing.
    for (const model of [
      'payment',
      'order',
      'table',
      'digitalReceipt',
      'paymentEffect',
      'activityLog',
      'posSyncIntent',
      'inventoryPosting',
    ] as const) {
      const delegate = (prisma as any)[model]
      for (const operation of ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']) {
        if (delegate?.[operation]) expect(delegate[operation]).not.toHaveBeenCalled()
      }
    }
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(prisma.$executeRaw).not.toHaveBeenCalled()
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled()
  })

  it.each(['REGULAR', 'FAST'])('returns the exact persisted identity and cents for completed pure CASH %s', async type => {
    jest.mocked(prisma.payment.findUnique).mockResolvedValue(payment({ type }) as never)
    const result = await lookup(venueId, key)
    expect(result).toMatchObject({
      venueId,
      idempotencyKey: key,
      paymentId: 'c0000000000000000000000003',
      orderId,
      orderExternalId: 'local-original-order',
      type,
      status: 'COMPLETED',
      method: 'CASH',
      tenderTypeId: null,
      amountCents: 1999,
      tipCents: 1,
      cashRetainedCents: 2000,
      splitType: 'FULLPAYMENT',
    })
    expect(prisma.payment.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { venueId_idempotencyKey: { venueId, idempotencyKey: key } },
        select: expect.any(Object),
      }),
    )
    const query = jest.mocked(prisma.payment.findUnique).mock.calls[0][0]!
    expect(query).not.toHaveProperty('include')
    for (const field of ['processorData', 'processedBy', 'merchantAccount', 'receipts', 'receiptAccessKey', 'authorizationNumber']) {
      expect((query as any).select).not.toHaveProperty(field)
      expect(result).not.toHaveProperty(field)
    }
    expect(result).not.toHaveProperty('changeCents')
    expect(result).not.toHaveProperty('deliveryCashAllocation')
  })

  it.each([
    ['0.00', 0],
    ['0.01', 1],
    ['19.99', 1999],
    ['0.29', 29],
    ['0.55', 55],
  ] as const)('serializes %s pesos as %i integer cents', async (amount, cents) => {
    jest.mocked(prisma.payment.findUnique).mockResolvedValue(payment({ amount: decimal(amount), tipAmount: decimal('0') }) as never)
    expect(await lookup(venueId, key)).toMatchObject({ amountCents: cents, tipCents: 0, cashRetainedCents: cents })
  })

  it('returns null for no payment or a key stored only in another venue', async () => {
    jest.mocked(prisma.payment.findUnique).mockResolvedValue(payment() as never)
    expect(await lookup('c0000000000000000000000009', key)).toBeNull()
    jest.mocked(prisma.payment.findUnique).mockResolvedValue(null)
    expect(await lookup(venueId, 'absent-key')).toBeNull()
  })

  it.each(['', ' ', 'x'.repeat(65)])('rejects an invalid key before any payment lookup: %p', async invalid => {
    await expect(lookup(venueId, invalid)).rejects.toMatchObject({ statusCode: 400 })
    expect(prisma.payment.findUnique).not.toHaveBeenCalled()
  })

  it.each([
    { type: 'TEST' },
    { type: 'REFUND' },
    { type: 'ADJUSTMENT' },
    { type: null },
    { venueId: 'foreign' },
    { idempotencyKey: 'different-key' },
    { status: 'PENDING' },
    { status: 'PROCESSING' },
    { status: 'FAILED' },
    { status: 'REFUNDED' },
    { method: 'CREDIT_CARD' },
    { method: 'BANK_TRANSFER' },
    { method: 'OTHER', tenderCountsAsCash: true },
    { fundsFlow: 'EXTERNAL' },
    { fundsFlow: null, tenderCountsAsCash: false },
    { tenderTypeId: 'custom-tender' },
    { order: null },
    { order: { id: orderId, venueId: 'foreign', externalId: 'private', thirdPartyCashDue: 10 } },
    { order: { id: 'different-order', venueId, externalId: null } },
  ])('does not certify ineligible evidence: %j', async extra => {
    jest.mocked(prisma.payment.findUnique).mockResolvedValue(payment(extra) as never)
    expect(await lookup(venueId, key)).toBeNull()
  })

  it('preserves Rappi allocation from stored money, including partial and later overpayment', async () => {
    for (const [sale, tip, third, retained] of [
      ['175', '20', '10', 20500],
      ['70', '20', '10', 10000],
      ['205', '0', '0', 20500],
    ] as const) {
      jest.mocked(prisma.payment.findUnique).mockResolvedValue(
        payment({
          amount: decimal(sale),
          tipAmount: decimal(tip),
          thirdPartyCashAmount: decimal(third),
          order: { id: orderId, venueId, externalId: 'RAPPI:original', thirdPartyCashDue: decimal('10') },
        }) as never,
      )
      const result = await lookup(venueId, key)
      expect(result).toMatchObject({
        cashRetainedCents: retained,
        deliveryCashAllocation: { saleCents: Number(sale) * 100, tipCents: Number(tip) * 100, thirdPartyCents: Number(third) * 100 },
      })
    }
  })

  it('keeps current remaining balance and paid status, but never reports current totals as historical payment totals', async () => {
    const before = await lookup(venueId, key)
    jest.mocked(prisma.order.findUnique).mockResolvedValue({
      paymentStatus: 'PAID',
      total: decimal('40'),
      paidAmount: decimal('40'),
      remainingBalance: decimal('0'),
    } as never)
    const after = await lookup(venueId, key)
    expect(before).toMatchObject({ amountCents: 1999, remainingBalanceCents: 2000, orderPaymentStatus: 'PARTIAL' })
    expect(after).toMatchObject({ amountCents: 1999, remainingBalanceCents: 0, orderPaymentStatus: 'PAID' })
    for (const field of ['orderTotalCents', 'totalPaidCents']) {
      expect(after).not.toHaveProperty(field)
    }
    for (const [query] of jest.mocked(prisma.order.findUnique).mock.calls) {
      expect(query?.where).toMatchObject({ id: orderId, venueId })
    }
  })

  it('does not certify evidence without the required current balance', async () => {
    jest.mocked(prisma.order.findUnique).mockResolvedValue(null)
    expect(await lookup(venueId, key)).toBeNull()
  })

  it('recognizes a persisted third-party allocation even when its stored amount is zero and the order marker is missing', async () => {
    jest.mocked(prisma.payment.findUnique).mockResolvedValue(payment({ thirdPartyCashAmount: decimal('0') }) as never)
    expect(await lookup(venueId, key)).toMatchObject({
      cashRetainedCents: 2000,
      deliveryCashAllocation: { saleCents: 1999, tipCents: 1, thirdPartyCents: 0 },
    })
  })

  it('preserves a frozen Rappi channel tender, including a zero third-party allocation', async () => {
    const tenderTypeId = 'c0000000000000000000000008'
    for (const thirdPartyCashAmount of [decimal('0'), decimal('10')]) {
      jest.mocked(prisma.payment.findUnique).mockResolvedValue(payment({ tenderTypeId, tenderRevision: 3, thirdPartyCashAmount }) as never)
      expect(await lookup(venueId, key)).toMatchObject({
        tenderTypeId,
        tenderRevision: 3,
        fundsFlow: 'CASH_DRAWER',
        deliveryCashAllocation: { saleCents: 1999, tipCents: 1, thirdPartyCents: Number(thirdPartyCashAmount) * 100 },
      })
    }
    expect(prisma.venueTenderType.findUnique).not.toHaveBeenCalled()
    expect(prisma.venueTenderType.findFirst).not.toHaveBeenCalled()
  })

  it.each([
    { type: 'FAST' },
    { thirdPartyCashAmount: null },
    { tenderRevision: null },
    { tenderRevision: 0 },
    { tenderRevision: 1.5 },
    { tenderTypeId: '' },
    { fundsFlow: null },
    { fundsFlow: 'EXTERNAL' },
    { method: 'OTHER' },
  ])('does not extend frozen-channel admission to another tender: %j', async extra => {
    jest.mocked(prisma.payment.findUnique).mockResolvedValue(
      payment({
        tenderTypeId: 'c0000000000000000000000008',
        tenderRevision: 1,
        thirdPartyCashAmount: decimal('0'),
        ...extra,
      }) as never,
    )
    expect(await lookup(venueId, key)).toBeNull()
  })

  it('never infers an allocation from current order marks when the payment did not store it', async () => {
    jest.mocked(prisma.payment.findUnique).mockResolvedValue(
      payment({
        order: { id: orderId, venueId, externalId: 'RAPPI:legacy', thirdPartyCashDue: decimal('10') },
      }) as never,
    )
    expect(await lookup(venueId, key)).not.toHaveProperty('deliveryCashAllocation')
  })

  it('preserves legacy cash semantics only when the canonical predicate counts it as drawer cash', async () => {
    jest.mocked(prisma.payment.findUnique).mockResolvedValue(payment({ fundsFlow: null, tenderCountsAsCash: null }) as never)
    expect(await lookup(venueId, key)).toMatchObject({ method: 'CASH', fundsFlow: null, amountCents: 1999 })
  })

  it('does not invent an external order identity for an order that has none', async () => {
    jest.mocked(prisma.payment.findUnique).mockResolvedValue(
      payment({
        order: { id: orderId, venueId, externalId: null, thirdPartyCashDue: null },
      }) as never,
    )
    expect(await lookup(venueId, key)).toMatchObject({ orderExternalId: null })
  })
})
