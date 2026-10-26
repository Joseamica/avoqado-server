import cuid from 'cuid'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { listExchangesForReview, markExchangeReviewed } from '@/services/dashboard/exchange.dashboard.service'
import { seedClothingSale } from './seedExchange'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.setTimeout(90000)
let s: Awaited<ReturnType<typeof seedClothingSale>>

beforeAll(() => {
  expect(['localhost', '127.0.0.1']).toContain(new URL(process.env.TEST_DATABASE_URL!).hostname)
  expect(new URL(process.env.TEST_DATABASE_URL!).pathname).toMatch(/^\/avoqado_(?:cambio_(?:fix_|r5_)?test_\d{8}|h1a_test_\d{8}(?:_\d+)?)$/)
})
beforeEach(async () => {
  s = await seedClothingSale()
})
afterEach(async () => {
  if (s?.venueId) await s.cleanup()
})
afterAll(async () => {
  await prisma.$disconnect()
})

async function seedReview(overrides: Partial<Prisma.ExchangeUncheckedCreateInput> = {}) {
  return prisma.exchange.create({
    data: {
      venueId: s.venueId,
      idempotencyKey: cuid(),
      requestHash: 'review-test',
      status: 'NEEDS_REVIEW',
      originalOrderId: s.order.id,
      originalPaymentId: s.payments[0].id,
      newOrderId: cuid(),
      returnedAmount: 500,
      takenAmount: 550,
      differenceAmount: 50,
      settlementKind: 'COLLECT',
      settlementMethod: 'CARD_TERMINAL',
      reviewReason: 'CHARGE_AMOUNT_MISMATCH',
      lines: {},
      staffId: s.staffId,
      ...overrides,
    },
  })
}
const review = (exchangeId: string, extra = {}) =>
  markExchangeReviewed({ venueId: s.venueId, exchangeId, staffId: s.staffId, note: 'Checked outside the system', ...extra })
async function financialSnapshot() {
  return {
    payments: await prisma.payment.findMany({ where: { venueId: s.venueId }, take: 100, orderBy: { id: 'asc' } }),
    postings: await prisma.inventoryPosting.findMany({ where: { venueId: s.venueId }, take: 100, orderBy: { id: 'asc' } }),
    events: await prisma.cashDrawerEvent.findMany({ where: { venueId: s.venueId }, take: 100, orderBy: { id: 'asc' } }),
    inventory: await prisma.inventory.findMany({ where: { venueId: s.venueId }, take: 100, orderBy: { id: 'asc' } }),
  }
}

describe('exchange review', () => {
  it('lists NEEDS_REVIEW not yet reviewed, newest first, any date, with exact total and max 100', async () => {
    const old = new Date('2020-01-01T00:00:00Z')
    const rows = []
    for (let i = 0; i < 102; i++) rows.push(await seedReview({ createdAt: old }))
    await seedReview({ status: 'COMPLETED' })
    await seedReview({ reviewedAt: new Date(), reviewedById: s.staffId, reviewNote: 'Already checked' })
    const first = await listExchangesForReview({ venueId: s.venueId, pendingReview: true, limit: 10000, offset: 0 })
    const sorted = rows
      .map(r => r.id)
      .sort()
      .reverse()
    expect(first.total).toBe(102)
    expect(first.items.map(r => r.id)).toEqual(sorted.slice(0, 100))
    expect(first.items[0]).toMatchObject({ differenceCents: 5000, reviewedAt: null, reviewedById: null, reviewNote: null })
    const next = await listExchangesForReview({ venueId: s.venueId, pendingReview: true, limit: 100, offset: 100 })
    expect(next.total).toBe(102)
    expect(next.items.map(r => r.id)).toEqual(sorted.slice(100))
    const all = await listExchangesForReview({ venueId: s.venueId })
    expect(all.total).toBe(104)
    expect(all.items).toHaveLength(25)
    expect((await listExchangesForReview({ venueId: s.venueId, pendingReview: true, offset: 104 })).items).toEqual([])
  })

  it('marks reviewed and audits in one tx, moves updatedAt and resultRevision, never money or inventory', async () => {
    const row = await seedReview({ updatedAt: new Date('2020-01-01T00:00:00Z'), resultRevision: 7 })
    const before = await financialSnapshot()
    const result = await review(row.id)
    expect(result).toMatchObject({
      id: row.id,
      status: 'NEEDS_REVIEW',
      reviewedAt: expect.any(Date),
      reviewedById: s.staffId,
      reviewNote: 'Checked outside the system',
    })
    const stored = await prisma.exchange.findFirstOrThrow({ where: { venueId: s.venueId, id: row.id } })
    expect(stored.resultRevision).toBe(8)
    expect(stored.updatedAt.getTime()).toBeGreaterThan(row.updatedAt.getTime())
    expect(stored.result).toEqual(row.result)
    const audits = await prisma.activityLog.findMany({
      where: { venueId: s.venueId, entityId: row.id, action: 'EXCHANGE_REVIEWED' },
      take: 10,
    })
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ staffId: s.staffId, data: expect.objectContaining({ note: result.reviewNote }) })
    expect(await financialSnapshot()).toEqual(before)
  })

  it('rolls back the marker if the audit (second write) cannot be persisted', async () => {
    const row = await seedReview()
    await expect(review(row.id, { staffId: cuid() })).rejects.toThrow()
    expect(await prisma.exchange.findFirstOrThrow({ where: { venueId: s.venueId, id: row.id } })).toMatchObject({
      reviewedAt: null,
      resultRevision: 0,
    })
    expect(await prisma.activityLog.count({ where: { venueId: s.venueId, entityId: row.id, action: 'EXCHANGE_REVIEWED' } })).toBe(0)
  })

  it('two concurrent reviews: one wins, the other is 409 EXCHANGE_ALREADY_REVIEWED, one audit row', async () => {
    const row = await seedReview()
    const results = await Promise.allSettled([review(row.id), review(row.id, { staffId: s.seller.id, note: 'Second manager checked' })])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { statusCode: 409, code: 'EXCHANGE_ALREADY_REVIEWED' } })
    expect(await prisma.activityLog.count({ where: { venueId: s.venueId, entityId: row.id, action: 'EXCHANGE_REVIEWED' } })).toBe(1)
  })

  it('a COMPLETED exchange is 409 EXCHANGE_NOT_IN_REVIEW', async () => {
    const row = await seedReview({ status: 'COMPLETED' })
    await expect(review(row.id)).rejects.toMatchObject({ statusCode: 409, code: 'EXCHANGE_NOT_IN_REVIEW' })
  })

  it('another venue cannot read or mark an exchange', async () => {
    const row = await seedReview()
    expect(await listExchangesForReview({ venueId: cuid(), pendingReview: true })).toEqual({ total: 0, items: [] })
    await expect(review(row.id, { venueId: cuid() })).rejects.toMatchObject({ statusCode: 404 })
  })
})
