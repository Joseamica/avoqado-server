import { violatesListRule } from '@/services/launchCampaigns/hybridPriceRule'

describe('violatesListRule (spec §4.4: initial price strictly below the list, renewal at most the list)', () => {
  it.each([
    [{ price: 479.2, renewal: { kind: 'SAME_PRICE' } }, 599, false],
    [{ price: 599, renewal: { kind: 'SAME_PRICE' } }, 599, true],
    [{ price: 80, renewal: { kind: 'REPRICE', price: 100 } }, 100, false],
    [{ price: 80, renewal: { kind: 'REPRICE', price: 100 } }, 90, true],
    [{ price: 80, renewal: { kind: 'END' } }, 90, false],
    // Decimal, not float: one cent decides, both ways.
    [{ price: 1158.83, renewal: { kind: 'SAME_PRICE' } }, 1158.84, false],
    [{ price: 1158.84, renewal: { kind: 'SAME_PRICE' } }, 1158.84, true],
    [{ price: 80, renewal: { kind: 'REPRICE', price: 90.01 } }, 90, true],
  ])('violatesListRule(%j, %d) = %s', (terms, list, expected) => expect(violatesListRule(terms, list)).toBe(expected))
})
