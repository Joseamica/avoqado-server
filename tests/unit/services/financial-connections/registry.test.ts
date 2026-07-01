import { getFinancialProviderClient } from '@/services/financial-connections/registry'

describe('financial provider registry', () => {
  it('resolves EXTERNAL_BANK to a client with the full interface', () => {
    const c = getFinancialProviderClient('EXTERNAL_BANK')
    expect(c).toBeDefined()
    for (const m of ['connect', 'validateDevice', 'refresh', 'revoke', 'listAccounts', 'getBalance']) {
      expect(typeof (c as any)[m]).toBe('function')
    }
  })
  it('returns undefined for unknown codes', () => {
    expect(getFinancialProviderClient('NOPE')).toBeUndefined()
  })
})
