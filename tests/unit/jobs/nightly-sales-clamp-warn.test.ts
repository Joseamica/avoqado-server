import logger from '@/config/logger'
import { prismaMock } from '@tests/__helpers__/setup'
import { getOrderSourcesBreakdown } from '@/jobs/nightly-sales-summary.job'

/**
 * The nightly email clamps a single order's net sales at zero, because 3 orders
 * in live data carry giveaways larger than their own subtotal (one has
 * `subtotal 0` with a `discountAmount 300`). Reporting a negative there would
 * quietly cancel out a real sale in the same bucket.
 *
 * But a clamp that corrects in SILENCE is how that row stays broken forever:
 * the email reads fine, so nobody ever learns the order needs fixing. These
 * tests pin the warning, not the arithmetic.
 */

const SOURCES_ROW = { source: 'TPV', orders: 3, net_sales: 500 }

/** The real damaged order: Avoqado Wellness / ORD-1779465117373. */
const DAMAGED = {
  id: 'order-damaged',
  orderNumber: 'ORD-1779465117373',
  subtotal: 0,
  discounts: 300,
  net_sales: -300,
}

const warnCalls = () => (logger.warn as jest.Mock).mock.calls.filter(([msg]) => String(msg).includes('net sales negativo'))

beforeEach(() => {
  jest.clearAllMocks()
})

describe('nightly summary — the clamp is never silent', () => {
  it('warns with venue, order and BOTH amounts when an order gets clamped', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([SOURCES_ROW]).mockResolvedValueOnce([DAMAGED])

    await getOrderSourcesBreakdown('venue-1', new Date('2025-03-11T06:00:00Z'), new Date('2025-03-12T05:59:59Z'))

    const calls = warnCalls()
    expect(calls).toHaveLength(1)

    const [message, meta] = calls[0]
    // ⚠️ (data damage), never 🚨 — the sale was already clamped to 0, so no
    // money is at risk; someone just has to go fix the row.
    expect(message).toContain('⚠️')
    expect(message).not.toContain('🚨')
    expect(meta).toMatchObject({
      venueId: 'venue-1',
      orderId: 'order-damaged',
      orderNumber: 'ORD-1779465117373',
      subtotal: 0,
      discounts: 300,
      netSalesBeforeClamp: -300,
    })
  })

  it('stays quiet when nothing was clamped', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([SOURCES_ROW]).mockResolvedValueOnce([])

    await getOrderSourcesBreakdown('venue-1', new Date('2025-03-11T06:00:00Z'), new Date('2025-03-12T05:59:59Z'))

    expect(warnCalls()).toHaveLength(0)
  })

  it('reports a COUNT instead of 20+ lines when the damage is widespread', async () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ ...DAMAGED, id: `order-${i}` }))
    prismaMock.$queryRaw.mockResolvedValueOnce([SOURCES_ROW]).mockResolvedValueOnce(many)

    await getOrderSourcesBreakdown('venue-1', new Date('2025-03-11T06:00:00Z'), new Date('2025-03-12T05:59:59Z'))

    const calls = warnCalls()
    expect(calls).toHaveLength(1) // one summary line, not 21
    expect(calls[0][1]).toMatchObject({ venueId: 'venue-1', clampedOrders: '20+' })
  })

  it('a failure in the diagnostic NEVER breaks the email', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([SOURCES_ROW]).mockRejectedValueOnce(new Error('boom'))

    const rows = await getOrderSourcesBreakdown('venue-1', new Date('2025-03-11T06:00:00Z'), new Date('2025-03-12T05:59:59Z'))

    // The breakdown still comes back — the owner's summary is the product.
    expect(rows).toHaveLength(1)
    expect(rows[0].netSales).toBe(500)
    expect((logger.warn as jest.Mock).mock.calls.some(([m]) => String(m).includes('No se pudo revisar'))).toBe(true)
  })
})
