import {
  summarizeSales,
  rankTopProducts,
  rankTopStaff,
  rankCategories,
  summarizeByPaymentMethod,
  rankChannels,
  summarizePeakHours,
  summarizeTipsByDay,
} from '../../../src/mcp/tools/sales'
import { auditTerminalConfig } from '../../../src/mcp/tools/terminals'

// Avoid ts-jest compiling the huge access.service graph (the tool modules import it
// transitively via the guard). The pure functions under test don't use it.
jest.mock('@/services/access/access.service', () => ({
  hasPermission: () => true,
  getUserAccess: jest.fn(),
  createAccessCache: jest.fn(() => ({})),
}))

describe('summarizeSales', () => {
  const rows = [
    { amount: 100, method: 'CASH', type: 'REGULAR', status: 'COMPLETED' },
    { amount: 200, method: 'CREDIT_CARD', type: 'REGULAR', status: 'COMPLETED' },
    { amount: 50, method: 'CASH', type: 'FAST', status: 'COMPLETED' },
    { amount: 999, method: 'CASH', type: 'REGULAR', status: 'FAILED' }, // excluded
  ]
  it('totals only COMPLETED payments', () => {
    const s = summarizeSales(rows)
    expect(s.completedCount).toBe(3)
    expect(s.gross).toBe(350)
  })
  it('breaks down by method and type', () => {
    const s = summarizeSales(rows)
    expect(s.byMethod.CASH).toBe(150)
    expect(s.byMethod.CREDIT_CARD).toBe(200)
    expect(s.byType.REGULAR).toBe(300)
    expect(s.byType.FAST).toBe(50)
  })
  it('handles empty', () => {
    expect(summarizeSales([])).toEqual({ completedCount: 0, gross: 0, byMethod: {}, byType: {}, byMerchantAccount: {} })
  })
  it('breaks down card payments by merchant account (skips cash/null)', () => {
    const s = summarizeSales([
      { amount: 200, method: 'CREDIT_CARD', type: 'REGULAR', status: 'COMPLETED', merchantAccountId: 'ma-A' },
      { amount: 300, method: 'DEBIT_CARD', type: 'REGULAR', status: 'COMPLETED', merchantAccountId: 'ma-A' },
      { amount: 100, method: 'CASH', type: 'REGULAR', status: 'COMPLETED', merchantAccountId: null },
    ])
    expect(s.byMerchantAccount).toEqual({ 'ma-A': 500 })
  })
})

describe('auditTerminalConfig', () => {
  it('merges config.settings with configOverrides (override wins)', () => {
    const r = auditTerminalConfig({
      name: 'T1',
      serialNumber: 'A1',
      status: 'ACTIVE',
      config: { settings: { showCheckout: true, showQuickPayment: true } },
      configOverrides: { showQuickPayment: false },
    })
    expect(r.settings.showCheckout).toBe(true)
    expect(r.settings.showQuickPayment).toBe(false)
  })
  it('flags checkout-on / quickpay-off', () => {
    const r = auditTerminalConfig({
      name: 'T2',
      serialNumber: null,
      status: 'ACTIVE',
      config: { settings: { showCheckout: true, showQuickPayment: false } },
      configOverrides: null,
    })
    expect(r.flags).toContain('checkout_on_quickpay_off')
  })
  it('handles null config without throwing', () => {
    const r = auditTerminalConfig({ name: 'T3', serialNumber: null, status: 'INACTIVE', config: null, configOverrides: null })
    expect(r.flags).toEqual([])
  })
})

describe('rankTopProducts', () => {
  const products = [
    { id: 'p1', name: 'Tacos', type: 'FOOD', quantity: 5, price: 30 },
    { id: 'p2', name: 'Carnitas', type: 'FOOD', quantity: 20, price: 120 },
    { id: 'p3', name: 'Agua', type: 'BEVERAGE', quantity: 12, price: 25 },
  ]
  it('ranks by units sold (desc) and reshapes to name/unitsSold/unitPrice/type', () => {
    const top = rankTopProducts(products)
    expect(top.map(p => p.name)).toEqual(['Carnitas', 'Agua', 'Tacos'])
    expect(top[0]).toEqual({ name: 'Carnitas', unitsSold: 20, unitPrice: 120, type: 'FOOD' })
  })
  it('applies the limit', () => {
    expect(rankTopProducts(products, 2).map(p => p.name)).toEqual(['Carnitas', 'Agua'])
  })
  it('does not mutate the input array', () => {
    const copy = [...products]
    rankTopProducts(products)
    expect(products).toEqual(copy)
  })
  it('handles empty', () => {
    expect(rankTopProducts([])).toEqual([])
  })
})

describe('rankTopStaff', () => {
  const rows = [
    { name: 'Ana', revenue: 1000, orders: 3, tips: 50, averageTicket: 333.3333 },
    { name: 'Beto', revenue: 3000, orders: 20, tips: 120, averageTicket: 150 },
    { name: 'Cata', revenue: 2000, orders: 8, tips: 80.126, averageTicket: 250 },
  ]
  it('ranks by revenue (desc) and applies the limit', () => {
    expect(rankTopStaff(rows, 2).map(s => s.name)).toEqual(['Beto', 'Cata'])
  })
  it('rounds money fields to 2 decimals', () => {
    expect(rankTopStaff([rows[0]])[0].averageTicket).toBe(333.33)
    expect(rankTopStaff([rows[2]])[0].tips).toBe(80.13)
  })
  it('passes name/orders through and does not mutate input', () => {
    const copy = JSON.parse(JSON.stringify(rows))
    const top = rankTopStaff(rows)
    expect(top.find(s => s.name === 'Beto')).toEqual({ name: 'Beto', revenue: 3000, orders: 20, tips: 120, averageTicket: 150 })
    expect(rows).toEqual(copy)
  })
  it('handles empty', () => {
    expect(rankTopStaff([])).toEqual([])
  })
})

describe('rankCategories', () => {
  const rows = [
    { category: 'Bebidas', revenue: 500.126, quantity: 40, percentage: 25.004 },
    { category: 'Tacos', revenue: 1500, quantity: 100, percentage: 75 },
  ]
  it('ranks by revenue (desc) and applies the limit', () => {
    const out = rankCategories(rows, 1)
    expect(out).toHaveLength(1)
    expect(out[0].category).toBe('Tacos')
  })
  it('rounds revenue + percentage to 2 decimals', () => {
    const [bebidas] = rankCategories([rows[0]])
    expect(bebidas.revenue).toBe(500.13)
    expect(bebidas.percentage).toBe(25)
    expect(bebidas.quantity).toBe(40)
  })
  it('handles empty', () => expect(rankCategories([])).toEqual([]))
})

describe('summarizeByPaymentMethod', () => {
  const payments = [
    { amount: 100, method: 'CASH' },
    { amount: 200, method: 'CREDIT_CARD' },
    { amount: 50.5, method: 'CASH' },
    { amount: 25, method: '' }, // empty method → UNKNOWN
  ]
  it('aggregates total + count per method', () => {
    const out = summarizeByPaymentMethod(payments)
    expect(out.find(m => m.method === 'CASH')).toEqual({ method: 'CASH', total: 150.5, count: 2 })
    expect(out.find(m => m.method === 'CREDIT_CARD')).toEqual({ method: 'CREDIT_CARD', total: 200, count: 1 })
    expect(out.find(m => m.method === 'UNKNOWN')).toEqual({ method: 'UNKNOWN', total: 25, count: 1 })
  })
  it('ranks methods by total (desc)', () => {
    expect(summarizeByPaymentMethod(payments).map(m => m.method)).toEqual(['CREDIT_CARD', 'CASH', 'UNKNOWN'])
  })
  it('accepts Decimal-like amounts (toString)', () => {
    const out = summarizeByPaymentMethod([{ amount: { toString: () => '99.99' }, method: 'CASH' }])
    expect(out[0].total).toBe(99.99)
  })
  it('handles empty', () => expect(summarizeByPaymentMethod([])).toEqual([]))
})

describe('rankChannels', () => {
  const rows = [
    { channel: 'TAKEOUT', revenue: 300.126, count: 12, percentage: 30.004 },
    { channel: 'DINE_IN', revenue: 700, count: 40, percentage: 70 },
  ]
  it('ranks by revenue (desc), limits, rounds revenue + percentage', () => {
    const out = rankChannels(rows, 1)
    expect(out).toHaveLength(1)
    expect(out[0].channel).toBe('DINE_IN')
  })
  it('rounds money + percentage, passes count through', () => {
    const [takeout] = rankChannels([rows[0]])
    expect(takeout.revenue).toBe(300.13)
    expect(takeout.percentage).toBe(30)
    expect(takeout.count).toBe(12)
  })
  it('handles empty', () => expect(rankChannels([])).toEqual([]))
})

describe('summarizePeakHours', () => {
  const rows = [
    { hour: 14, sales: 500.126, transactions: 20 },
    { hour: 9, sales: 200, transactions: 8 },
    { hour: 21, sales: 350, transactions: 15 },
  ]
  it('orders by hour ascending and rounds sales', () => {
    const out = summarizePeakHours(rows)
    expect(out.map(h => h.hour)).toEqual([9, 14, 21])
    expect(out.find(h => h.hour === 14)).toEqual({ hour: 14, sales: 500.13, transactions: 20 })
  })
  it('does not mutate input and handles empty', () => {
    const copy = JSON.parse(JSON.stringify(rows))
    summarizePeakHours(rows)
    expect(rows).toEqual(copy)
    expect(summarizePeakHours([])).toEqual([])
  })
})

describe('summarizeTipsByDay', () => {
  const tz = 'America/Mexico_City' // UTC-6, no DST → chosen times bucket the same either way
  const payments = [
    { createdAt: '2026-06-04T02:00:00.000Z', tips: [{ amount: 20 }] }, // 2026-06-03 local
    { createdAt: '2026-06-04T18:00:00.000Z', tips: [{ amount: 30 }] }, // 2026-06-04 local
    { createdAt: '2026-06-04T19:00:00.000Z', tips: [{ amount: 10.5 }] }, // 2026-06-04 local
    { createdAt: '2026-06-04T20:00:00.000Z', tips: [{ amount: 0 }] }, // no tip → skipped
  ]
  it('buckets tips by venue-local day, totals, and counts tipped txns only', () => {
    const r = summarizeTipsByDay(payments, tz)
    expect(r.total).toBe(60.5)
    expect(r.count).toBe(3)
    expect(r.byDay).toEqual([
      { date: '2026-06-03', tips: 20, count: 1 },
      { date: '2026-06-04', tips: 40.5, count: 2 },
    ])
  })
  it('treats null tip amounts as zero', () => {
    expect(summarizeTipsByDay([{ createdAt: '2026-06-04T18:00:00.000Z', tips: [{ amount: null }] }], tz)).toEqual({
      total: 0,
      count: 0,
      byDay: [],
    })
  })
  it('handles empty', () => expect(summarizeTipsByDay([], tz)).toEqual({ total: 0, count: 0, byDay: [] }))
})
