import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { listPaymentEffects } from '@/services/tpv/paymentEffectsRead.service'

const fixture = 'effect-read-' + randomUUID()
const at = new Date('2026-09-09T12:00:00Z')
const venues: string[] = []
let paymentId: string

beforeAll(async () => {
  const url = new URL(process.env.TEST_DATABASE_URL ?? '')
  expect(['localhost', '127.0.0.1']).toContain(url.hostname)
  expect(url.pathname).toMatch(/^\/codex_testarudo_test_/)
  await prisma.organization.create({ data: { id: fixture, name: fixture, email: fixture + '@example.test', phone: '5500000000' } })
  for (let n = 0; n < 2; n++) {
    const venue = await prisma.venue.create({ data: { organizationId: fixture, name: fixture + n, slug: fixture + n } })
    venues.push(venue.id)
    const order = await prisma.order.create({
      data: { venueId: venue.id, orderNumber: fixture + n, subtotal: 100, taxAmount: 0, total: 100 },
    })
    const payment = await prisma.payment.create({
      data: {
        venueId: venue.id,
        orderId: order.id,
        amount: 100,
        feePercentage: 0,
        feeAmount: 0,
        netAmount: 100,
        tipAmount: 0,
        method: 'CASH',
        status: 'COMPLETED',
        source: 'TPV',
        splitType: 'FULLPAYMENT',
      },
    })
    if (n === 0) paymentId = payment.id
    await prisma.paymentEffect.createMany({
      data: Array.from({ length: n === 0 ? 103 : 1 }, (_, i) => ({
        id: `${fixture}-${n}-${String(i).padStart(3, '0')}`,
        venueId: venue.id,
        orderId: order.id,
        paymentId: payment.id,
        kind: 'REVIEW',
        dedupeKey: `review-${i}`,
        payload: { rating: 5, privateSnapshot: 'do-not-expose' },
        status: 'PENDING',
        createdAt: at,
        nextAttemptAt: at,
        claimToken: 'private-worker-token',
      })),
    })
    await prisma.paymentEffect.create({
      data: {
        venueId: venue.id,
        orderId: order.id,
        paymentId: payment.id,
        kind: 'RECEIPT',
        dedupeKey: 'receipt',
        payload: {},
        status: 'DEAD_LETTER',
        attempts: 6,
        lastError: 'PAYMENT_EFFECT_EXECUTION_FAILED',
        createdAt: at,
      },
    })
  }
})

afterAll(async () => {
  await prisma.paymentEffect.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.payment.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.order.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.venue.deleteMany({ where: { id: { in: venues } } })
  await prisma.organization.deleteMany({ where: { id: fixture } })
})

describe('payment effects operator visibility', () => {
  it('clamps a hostile limit, reports the full filtered total and reaches the remainder by cursor', async () => {
    const first = await listPaymentEffects({ venueId: venues[0], limit: 1000000 })
    expect(first.total).toBe(103)
    expect(first.items).toHaveLength(100)
    expect(first.hasMore).toBe(true)
    expect(first.nextCursor).toBeTruthy()
    expect(first.items[0].id).toBe(`${fixture}-0-102`)
    const last = await listPaymentEffects({ venueId: venues[0], limit: 1000000, cursor: first.nextCursor! })
    expect(last.total).toBe(103)
    expect(last.items).toHaveLength(3)
    expect(last.hasMore).toBe(false)
    expect(last.nextCursor).toBeNull()
    expect(new Set([...first.items, ...last.items].map(row => row.id)).size).toBe(103)
  })
  it('uses a bounded default and deterministic ties without exposing frozen policy or lease tokens', async () => {
    const page = await listPaymentEffects({ venueId: venues[0] })
    expect(page.items).toHaveLength(50)
    expect(page.items[0]).toMatchObject({ paymentId, status: 'PENDING', kind: 'REVIEW', attempts: 0 })
    expect(JSON.stringify(page)).not.toContain('do-not-expose')
    expect(JSON.stringify(page)).not.toContain('private-worker-token')
  })
  it('applies status, effect and exact payment filters before count and pagination', async () => {
    const page = await listPaymentEffects({ venueId: venues[0], status: 'DEAD_LETTER', kind: 'RECEIPT', paymentId })
    expect(page.total).toBe(1)
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({ attempts: 6, lastError: 'PAYMENT_EFFECT_EXECUTION_FAILED' })
    const empty = await listPaymentEffects({ venueId: venues[0], status: 'DEAD_LETTER', kind: 'REVIEW' })
    expect(empty).toMatchObject({ total: 0, items: [], hasMore: false, nextCursor: null })
  })
  it('scopes every page and rejects a cursor belonging to another venue', async () => {
    const own = await listPaymentEffects({ venueId: venues[1], limit: 2 })
    expect(own.total).toBe(1)
    expect(own.items).toHaveLength(1)
    await expect(listPaymentEffects({ venueId: venues[0], cursor: `${fixture}-1-000` })).rejects.toThrow()
  })

  it('continues a pending page if the worker completes its cursor row between reads', async () => {
    const first = await listPaymentEffects({ venueId: venues[0], limit: 1 })
    expect(first.nextCursor).toBeTruthy()
    const cursor = first.nextCursor!
    try {
      await prisma.paymentEffect.updateMany({ where: { id: cursor, venueId: venues[0] }, data: { status: 'DONE' } })
      const next = await listPaymentEffects({ venueId: venues[0], cursor, limit: 2 })
      expect(next.items).toHaveLength(2)
      expect(next.items.map(row => row.id)).not.toContain(cursor)
      expect(next.total).toBe(102)
    } finally {
      await prisma.paymentEffect.updateMany({ where: { id: cursor, venueId: venues[0] }, data: { status: 'PENDING' } })
    }
  })
})
