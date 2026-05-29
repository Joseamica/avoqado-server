import { summarizeSales } from '../../../scripts/mcp/tools/sales'

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

  it('breaks down by payment method', () => {
    const s = summarizeSales(rows)
    expect(s.byMethod.CASH).toBe(150)
    expect(s.byMethod.CREDIT_CARD).toBe(200)
  })

  it('breaks down by payment type (flags FAST volume)', () => {
    const s = summarizeSales(rows)
    expect(s.byType.REGULAR).toBe(300)
    expect(s.byType.FAST).toBe(50)
  })

  it('handles an empty set', () => {
    const s = summarizeSales([])
    expect(s.completedCount).toBe(0)
    expect(s.gross).toBe(0)
    expect(s.byMethod).toEqual({})
  })
})
