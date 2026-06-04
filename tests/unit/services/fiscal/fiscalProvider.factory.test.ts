jest.mock('facturapi', () => jest.fn().mockImplementation(() => ({})))
import { resolveFiscalProvider } from '../../../../src/services/fiscal/fiscalProvider.factory'
import { encryptProviderKey } from '../../../../src/services/fiscal/fiscalKey.service'

describe('resolveFiscalProvider', () => {
  beforeAll(() => {
    process.env.FISCAL_PROVIDER_KEY = 'b'.repeat(64)
    process.env.FACTURAPI_TEST_KEY = 'sk_test_env'
  })

  it('uses the emisor decrypted live key when present', () => {
    const emisor = { provider: 'FACTURAPI', providerKeyEnc: encryptProviderKey('sk_live_org') } as any
    const p = resolveFiscalProvider(emisor, { sandbox: false })
    expect(p.name).toBe('facturapi')
  })

  it('falls back to FACTURAPI_TEST_KEY in sandbox when emisor has no key', () => {
    const emisor = { provider: 'FACTURAPI', providerKeyEnc: null } as any
    const p = resolveFiscalProvider(emisor, { sandbox: true })
    expect(p.name).toBe('facturapi')
  })

  it('throws for an unknown provider', () => {
    expect(() => resolveFiscalProvider({ provider: 'SOMETHING', providerKeyEnc: null } as any, { sandbox: true })).toThrow()
  })
})
