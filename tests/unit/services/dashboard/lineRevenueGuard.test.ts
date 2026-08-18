import * as fs from 'fs'
import * as path from 'path'

/**
 * Guardrail: nobody re-introduces "revenue = list price".
 *
 * Eight separate reports summed `unitPrice * quantity` and ignored
 * `OrderItem.discountAmount`, so every discounted line was billed at its menu
 * price. They were fixed one by one; without this test the ninth one just gets
 * written again — the expression is the obvious thing to type.
 *
 * The allowlist below is for the ONE place the gross figure is genuinely
 * wanted: the Sales-by-Item report shows gross, the giveaway and net as three
 * separate columns (Square parity — see `salesGiveaways.ts`). The list may
 * shrink, never grow silently.
 */

const SRC = path.join(__dirname, '../../../../src')

// `unitPrice * quantity` (or the reverse) inside a SUM — the fan-out shape.
const LIST_PRICE_SUM =
  /SUM\(\s*(?:oi|i)\.(?:"?unitPrice"?\s*\*\s*(?:oi|i)?\.?"?quantity"?|"?quantity"?\s*\*\s*(?:oi|i)?\.?"?unitPrice"?)\s*\)/gi

/**
 * file → how many gross sums are deliberate there.
 *
 * Empty, and it should stay that way. The Sales-by-Item report legitimately
 * shows a GROSS figure, but it gets it from the shared `lineGrossSql()` — which
 * is weight-aware and includes modifiers — so that `net = gross − discounts`
 * holds. A hand-written `SUM(unitPrice * quantity)` is always the old bug.
 */
const ALLOWED: Record<string, number> = {}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

describe('guardrail — item revenue is never summed at list price', () => {
  const offenders = new Map<string, number>()

  beforeAll(() => {
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file)
      if (rel === 'services/dashboard/lineRevenue.ts') continue
      const hits = (fs.readFileSync(file, 'utf8').match(LIST_PRICE_SUM) || []).length
      if (hits > 0) offenders.set(rel, hits)
    }
  })

  it('every SUM(unitPrice * quantity) in src/ is either fixed or explicitly allowed', () => {
    const unexpected = [...offenders.entries()]
      .filter(([file, hits]) => hits > (ALLOWED[file] ?? 0))
      .map(([file, hits]) => `${file}: ${hits} occurrence(s), ${ALLOWED[file] ?? 0} allowed`)

    expect(unexpected).toEqual([])
  })

  it('the allowlist is real — every entry still has the gross sums it claims', () => {
    // Stops the list from outliving the code and quietly covering a new site.
    const stale = Object.entries(ALLOWED)
      .filter(([file, expected]) => (offenders.get(file) ?? 0) !== expected)
      .map(([file, expected]) => `${file}: allowlist says ${expected}, found ${offenders.get(file) ?? 0}`)

    expect(stale).toEqual([])
  })
})

/**
 * 🔴 The discount report's correctness rests on an invariant that lives in a
 * DIFFERENT file, and it looks like a bug to anyone who meets it cold.
 *
 * When the TPV comps a line it writes the giveaway TWICE: `discountAmount` on
 * the line AND `Order.discountAmount` — while leaving `OrderItem.total` GROSS
 * (`total: decimalFromPesos(line.lineGrossPesos)`). A reader who "fixes" that
 * to net is not making a cosmetic change: `isItemLevelDiscount` decides whether
 * a line's giveaway is already counted at order level by testing exactly
 * `total === lineBase`. Flip the writer to net and every comped line starts
 * counting on BOTH sides — the discount total doubles on the spot (measured on
 * Chilanguita: 253 → 506).
 *
 * So this test is not about style. It pins the contract that makes the reader
 * correct, and fails loudly with the reason if someone changes it.
 */
describe('invariant — the TPV writes OrderItem.total GROSS', () => {
  const TPV_ORDER_SERVICE = path.join(SRC, 'services/tpv/order.tpv.service.ts')

  it('a comped/discounted line keeps its total at the GROSS amount', () => {
    const source = fs.readFileSync(TPV_ORDER_SERVICE, 'utf8')

    // The line write sets discountAmount AND a GROSS total.
    expect(source).toContain('total: decimalFromPesos(line.lineGrossPesos)')
    expect(source).toContain('discountAmount: decimalFromPesos(line.lineDiscountPesos)')

    // And it must NOT have quietly become net.
    expect(source).not.toContain('total: decimalFromPesos(line.lineNetPesos)')
  })
})
