import { prismaMock } from '@tests/__helpers__/setup'
import {
  isItemLevelDiscount,
  lineBase,
  lineGross,
  lineGrossSql,
  lineRevenue,
  lineRevenueSql,
  lineUnits,
  lineUnitsSql,
} from '@/services/dashboard/lineRevenue'
import { getShiftById } from '@/services/dashboard/shift.dashboard.service'

/**
 * Seven reports summed `unitPrice * quantity` and ignored
 * `OrderItem.discountAmount`, so a combo line was billed at LIST price
 * (89 instead of 77.29). The SQL sites are proven end-to-end against a real
 * database — mocking `$queryRaw` would only echo the mock back:
 *  - tests/integration/dashboard/sales-report-accuracy.integration.test.ts
 *  - tests/integration/dashboard/generalStats-sql-aggregation.integration.test.ts
 *    (product-profitability moved there on 2026-09-01, when its aggregation
 *    moved from JavaScript-over-findMany to `SUM(lineRevenueSql())` in Postgres)
 *
 * The shift site below still does the arithmetic in JavaScript over rows Prisma
 * already returned, so a mocked client DOES exercise the real code path.
 */

// The line the whole bug report is about.
const COMBO_LINE = { quantity: 1, unitPrice: 89, discountAmount: 11.71, total: 77.29 }

describe('lineRevenue — one definition of what a line earned', () => {
  it('subtracts the line discount (the combo line: 77.29, not 89)', () => {
    expect(lineRevenue(COMBO_LINE)).toBeCloseTo(77.29, 2)
  })

  it('multiplies by quantity before subtracting', () => {
    expect(lineRevenue({ quantity: 3, unitPrice: 10, discountAmount: 5 })).toBe(25)
  })

  it('leaves an undiscounted line at list price', () => {
    expect(lineRevenue({ quantity: 2, unitPrice: 45, discountAmount: 0 })).toBe(90)
  })

  it('treats a missing discount as zero', () => {
    expect(lineRevenue({ quantity: 1, unitPrice: 40 })).toBe(40)
  })

  it('accepts Prisma Decimals (they arrive as objects, not numbers)', () => {
    expect(
      lineRevenue({ quantity: 1, unitPrice: { toString: () => '89' } as any, discountAmount: { toString: () => '11.71' } as any }),
    ).toBeCloseTo(77.29, 2)
  })

  // ── MODIFIERS (683 lines, $33,811 of real revenue) ────────────────────────
  // They live in their own table and `unitPrice` never contains them, so the
  // base formula simply lost this money.

  it("adds the line's modifiers — the 169 + 280 line really earned 449", () => {
    expect(
      lineRevenue({
        quantity: 1,
        unitPrice: 169,
        discountAmount: 0,
        modifiers: [
          { price: 250, quantity: 1 },
          { price: 30, quantity: 1 },
        ],
      }),
    ).toBe(449)
  })

  it('respects a modifier that was ordered more than once', () => {
    expect(lineRevenue({ quantity: 1, unitPrice: 100, modifiers: [{ price: 15, quantity: 3 }] })).toBe(145)
  })

  it('defaults a modifier without an explicit quantity to one', () => {
    expect(lineRevenue({ quantity: 1, unitPrice: 100, modifiers: [{ price: 15 }] })).toBe(115)
  })

  it('cannot double-count modifiers: the base is built from unitPrice, which never holds them', () => {
    // `OrderItem.total` is inconsistent here (502 lines exclude the modifiers,
    // 36 include them), which is exactly why revenue is NOT read from `total`.
    const line = { quantity: 1, unitPrice: 169, discountAmount: 0, modifiers: [{ price: 280, quantity: 1 }] }
    expect(lineBase(line)).toBe(169) // base never contains them
    expect(lineRevenue(line)).toBe(449) // added exactly once
  })

  // ── SOLD BY WEIGHT (16 lines, was over-reporting +117%) ───────────────────
  // `quantity` stays 1 and the kilos live in `weightQuantity`, so the old
  // formula charged a FULL kilo per weighing.

  it('charges kilos, not a whole unit — 240/kg × 0.435 kg = 104.40, not 240', () => {
    expect(lineRevenue({ quantity: 1, unitPrice: 240, discountAmount: 0, weightQuantity: 0.435 })).toBeCloseTo(104.4, 2)
  })

  it('keeps a non-weighted line on its quantity', () => {
    expect(lineUnits({ quantity: 3, weightQuantity: null })).toBe(3)
    expect(lineUnits({ quantity: 1, weightQuantity: 0.435 })).toBe(0.435)
  })

  it('emits SQL carrying all three terms, for the alias every report uses', () => {
    const sql = lineRevenueSql()

    expect(sql).toContain('COALESCE(oi."weightQuantity", oi."quantity")') // weight
    expect(sql).toContain('FROM "OrderItemModifier"') // modifiers
    expect(sql).toContain('- oi."discountAmount"') // discount
    expect(lineRevenueSql('x')).toContain('x."unitPrice"')
    expect(lineUnitsSql()).toBe('COALESCE(oi."weightQuantity", oi."quantity")')
  })

  it('SQL and JS agree — gross minus the discount, both including modifiers', () => {
    // The two implementations drift apart silently; pin the shape that makes
    // `net = gross − discounts` hold in the reports that show both.
    expect(lineRevenueSql()).toBe(`(${lineGrossSql()} - oi."discountAmount")`)
    const line = { quantity: 1, unitPrice: 169, discountAmount: 20, modifiers: [{ price: 280, quantity: 1 }] }
    expect(lineGross(line)).toBe(449)
    expect(lineRevenue(line)).toBe(429)
  })
})

describe('isItemLevelDiscount — only count a giveaway once', () => {
  it('counts a combo line, whose total is already net', () => {
    expect(isItemLevelDiscount(COMBO_LINE)).toBe(true)
  })

  it('counts a mobile cortesía (total 0, discount = the full list price)', () => {
    expect(isItemLevelDiscount({ quantity: 1, unitPrice: 280, discountAmount: 280, total: 0 })).toBe(true)
  })

  it('does NOT count a "Cobrar" cortesía whose line is still GROSS', () => {
    // total === unitPrice * quantity ⇒ the giveaway was booked on
    // Order.discountAmount instead. Counting it here would double it.
    expect(isItemLevelDiscount({ quantity: 1, unitPrice: 280, discountAmount: 280, total: 280 })).toBe(false)
  })

  it('ignores a line with no discount at all', () => {
    expect(isItemLevelDiscount({ quantity: 1, unitPrice: 50, discountAmount: 0, total: 50 })).toBe(false)
  })
})

describe('shift top products — revenue is net of the line discount', () => {
  const shiftRow = (items: any[]) => ({
    id: 'shift-1',
    venueId: 'venue-1',
    staffId: 'staff-1',
    startTime: new Date('2025-03-11T14:00:00.000Z'),
    endTime: new Date('2025-03-11T22:00:00.000Z'),
    startingCash: 0,
    endingCash: 0,
    staff: { id: 'staff-1', firstName: 'Ana', lastName: 'López', email: 'ana@example.test' },
    venue: { id: 'venue-1', name: 'Venue', timezone: 'America/Mexico_City' },
    payments: [],
    orders: [{ id: 'order-1', orderNumber: 'A-1', total: 77.29, subtotal: 89, createdAt: new Date(), payments: [], items }],
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('reports the discounted combo line at 77.29, not 89', async () => {
    prismaMock.shift.findFirst.mockResolvedValue(
      shiftRow([{ id: 'oi-1', ...COMBO_LINE, product: { id: 'p1', name: 'Tacos al Pastor' } }]) as any,
    )

    const shift = await getShiftById('venue-1', 'shift-1')
    const tacos = shift.topProducts.find((p: any) => p.name === 'Tacos al Pastor')

    expect(tacos.revenue).toBeCloseTo(77.29, 2)
    expect(tacos.quantity).toBe(1)
  })

  it('still reports an undiscounted line at full price (regression)', async () => {
    prismaMock.shift.findFirst.mockResolvedValue(
      shiftRow([{ id: 'oi-1', quantity: 2, unitPrice: 45, discountAmount: 0, total: 90, product: { id: 'p2', name: 'Cerveza' } }]) as any,
    )

    const shift = await getShiftById('venue-1', 'shift-1')
    const cerveza = shift.topProducts.find((p: any) => p.name === 'Cerveza')

    expect(cerveza.revenue).toBe(90)
    expect(cerveza.quantity).toBe(2)
  })

  it('counts the modifiers the customer paid for (169 + 280 = 449)', async () => {
    prismaMock.shift.findFirst.mockResolvedValue(
      shiftRow([
        {
          id: 'oi-1',
          quantity: 1,
          unitPrice: 169,
          discountAmount: 0,
          total: 449,
          modifiers: [
            { price: 250, quantity: 1 },
            { price: 30, quantity: 1 },
          ],
          product: { id: 'p3', name: 'Hamburguesa Doble' },
        },
      ]) as any,
    )

    const shift = await getShiftById('venue-1', 'shift-1')
    expect(shift.topProducts.find((p: any) => p.name === 'Hamburguesa Doble').revenue).toBe(449)
  })

  it('charges a weighed item by the kilo (240/kg × 0.435 = 104.40, not 240)', async () => {
    prismaMock.shift.findFirst.mockResolvedValue(
      shiftRow([
        {
          id: 'oi-1',
          quantity: 1,
          unitPrice: 240,
          discountAmount: 0,
          weightQuantity: 0.435,
          total: 104.4,
          product: { id: 'p4', name: 'QA Jamón por kg' },
        },
      ]) as any,
    )

    const shift = await getShiftById('venue-1', 'shift-1')
    expect(shift.topProducts.find((p: any) => p.name === 'QA Jamón por kg').revenue).toBeCloseTo(104.4, 2)
  })

  it('keeps the per-line `price` column showing the UNIT price, not the net line', async () => {
    prismaMock.shift.findFirst.mockResolvedValue(
      shiftRow([{ id: 'oi-1', ...COMBO_LINE, product: { id: 'p1', name: 'Tacos al Pastor' } }]) as any,
    )

    const shift = await getShiftById('venue-1', 'shift-1')
    expect(shift.orders[0].items[0].price).toBe(89)
  })
})
