/**
 * Pure rules behind "which AngelPay login does this terminal get".
 * See src/services/tpv/angelpayPrimaryAccount.ts for the incident that motivated them.
 */
import { orderAngelPayAccountsForTerminal, orderMerchantsBySlot } from '@/services/tpv/angelpayPrimaryAccount'

const A = { accountId: 'apa-old' }
const B = { accountId: 'apa-new' }

describe('orderMerchantsBySlot', () => {
  it('restores the slot order regardless of how the DB returned the rows', () => {
    const rows = [{ id: 'm3' }, { id: 'm1' }, { id: 'm2' }]
    expect(orderMerchantsBySlot(rows, ['m1', 'm2', 'm3']).map(m => m.id)).toEqual(['m1', 'm2', 'm3'])
  })

  it('keeps the FIRST slot of a duplicated id (Codex round 2, P1)', () => {
    const rows = [{ id: 'ma-new' }, { id: 'ma-legacy' }]
    expect(orderMerchantsBySlot(rows, ['ma-legacy', 'ma-new', 'ma-legacy']).map(m => m.id)).toEqual(['ma-legacy', 'ma-new'])
  })

  it('sends ids missing from the slot list to the end, keeping their relative order, and never drops any', () => {
    const rows = [{ id: 'x' }, { id: 'm1' }, { id: 'y' }]
    expect(orderMerchantsBySlot(rows, ['m1']).map(m => m.id)).toEqual(['m1', 'x', 'y'])
  })

  it('does not mutate its input', () => {
    const rows = [{ id: 'm2' }, { id: 'm1' }]
    orderMerchantsBySlot(rows, ['m1', 'm2'])
    expect(rows.map(m => m.id)).toEqual(['m2', 'm1'])
  })
})

describe('orderAngelPayAccountsForTerminal', () => {
  it('leads with the account owning the FIRST AngelPay merchant in slot order', () => {
    const out = orderAngelPayAccountsForTerminal(
      [A, B],
      [
        { id: 'blu', providerCode: 'BLUMON', angelpayUserAccountId: null },
        { id: 'm-new', providerCode: 'ANGELPAY', angelpayUserAccountId: 'apa-new' },
        { id: 'm-old', providerCode: 'ANGELPAY', angelpayUserAccountId: 'apa-old' },
      ],
    )
    expect(out).toEqual([B, A])
  })

  it('does NOT skip ahead when the first AngelPay merchant is legacy (null account)', () => {
    const out = orderAngelPayAccountsForTerminal(
      [A, B],
      [
        { id: 'm-legacy', providerCode: 'ANGELPAY', angelpayUserAccountId: null },
        { id: 'm-new', providerCode: 'ANGELPAY', angelpayUserAccountId: 'apa-new' },
      ],
    )
    expect(out).toEqual([A, B])
  })

  it('does NOT skip ahead when the first AngelPay merchant names an unknown account', () => {
    const out = orderAngelPayAccountsForTerminal(
      [A, B],
      [
        { id: 'm-orphan', providerCode: 'ANGELPAY', angelpayUserAccountId: 'apa-gone' },
        { id: 'm-new', providerCode: 'ANGELPAY', angelpayUserAccountId: 'apa-new' },
      ],
    )
    expect(out).toEqual([A, B])
  })

  it('returns the input untouched when there is no AngelPay merchant at all', () => {
    expect(orderAngelPayAccountsForTerminal([A, B], [{ id: 'blu', providerCode: 'BLUMON' }])).toEqual([A, B])
  })

  it('never filters: every account survives, only the order changes', () => {
    const C = { accountId: 'apa-third' }
    const out = orderAngelPayAccountsForTerminal([A, B, C], [{ id: 'm', providerCode: 'ANGELPAY', angelpayUserAccountId: 'apa-third' }])
    expect(out).toEqual([C, A, B])
  })
})
