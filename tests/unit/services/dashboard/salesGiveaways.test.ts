/**
 * Square-style giveaway reporting for the Sales Summary.
 *
 * Square's model (researched live 2026-08-14, squareup.com/help + community):
 * Gross Sales = full catalog price, Discounts & Comps = its own line, and
 * Net Sales = gross − discounts. Our NET-convention flows (promotions and
 * mobile/TABLE_SERVICE cortesías write total already reduced, with NO
 * OrderDiscount row) made both sides invisible: a $200 combo sold at $99
 * reported $99 gross / $0 discounts — the $101 given away vanished from the
 * P&L entirely.
 *
 * foldGiveawaysIntoSummary adds the hidden giveaway to BOTH sides so
 * Net Sales — the number payments must reconcile against — never moves.
 */
import { foldGiveawaysIntoSummary } from '@/services/dashboard/salesGiveaways'

describe('foldGiveawaysIntoSummary — the giveaway shows on both sides of the P&L', () => {
  it('adds promo + comp giveaways to gross sales and discounts equally', () => {
    // $99 combo whose catalog price is $200 (promo discount 10100 cents) plus
    // a $50 comped item from the mobile flow, on top of a $30 manual discount.
    const folded = foldGiveawaysIntoSummary({ grossSales: 149, items: 149, discounts: 30 }, 10100, 50)

    expect(folded.grossSales).toBe(300) // 149 + 101 + 50
    expect(folded.items).toBe(300)
    expect(folded.discounts).toBe(181) // 30 + 101 + 50
  })

  it('🔴 Net Sales is invariant: both sides move by the same amount', () => {
    const base = { grossSales: 149, items: 149, discounts: 30 }
    const folded = foldGiveawaysIntoSummary(base, 10100, 50)

    expect(folded.grossSales! - folded.discounts!).toBe(base.grossSales - base.discounts)
  })

  it('with no giveaways the summary is untouched (identity)', () => {
    const folded = foldGiveawaysIntoSummary({ grossSales: 500, items: 500, discounts: 20 }, 0, 0)

    expect(folded).toEqual({ grossSales: 500, items: 500, discounts: 20 })
  })

  it('promo discount arrives in CENTS and is converted to pesos exactly', () => {
    // 1 centavo — must become 0.01 pesos, not 1 peso (money rule: pesos 1:1).
    const folded = foldGiveawaysIntoSummary({ grossSales: 100, items: 100, discounts: 0 }, 1, 0)

    expect(folded.grossSales).toBeCloseTo(100.01, 10)
    expect(folded.discounts).toBeCloseTo(0.01, 10)
  })

  it('null metrics stay null (payment-method filter hides order-derived rows)', () => {
    const folded = foldGiveawaysIntoSummary({ grossSales: null, items: null, discounts: null }, 10100, 50)

    expect(folded).toEqual({ grossSales: null, items: null, discounts: null })
  })

  it('rounds to cents so floating error never leaks into the report', () => {
    // 0.1 + 0.2 style drift: 3 promos of 3333 cents plus 0.07 comp.
    const folded = foldGiveawaysIntoSummary({ grossSales: 10.1, items: 10.1, discounts: 0.2 }, 9999, 0.07)

    expect(folded.grossSales).toBe(110.16) // 10.10 + 99.99 + 0.07
    expect(folded.discounts).toBe(100.26) // 0.20 + 99.99 + 0.07
  })
})
