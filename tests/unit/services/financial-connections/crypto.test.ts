describe('financial-connections crypto', () => {
  const KEY = 'a'.repeat(64) // 32 bytes en hex

  afterEach(() => {
    jest.resetModules()
    delete process.env.FINANCIAL_CONNECTION_KEY
  })

  it('roundtrips a grant object', async () => {
    process.env.FINANCIAL_CONNECTION_KEY = KEY
    const { encryptGrant, decryptGrant } = await import('@/services/financial-connections/crypto')
    const grant = { refreshToken: 'r-123', expiresAt: '2026-07-01T00:00:00Z' }
    const enc = encryptGrant(grant)
    expect(typeof enc).toBe('string')
    expect(enc).not.toContain('r-123') // cifrado, no texto plano
    expect(decryptGrant(enc)).toEqual(grant)
  })

  it('fails closed when the key is missing (no default fallback)', async () => {
    // sin FINANCIAL_CONNECTION_KEY
    const { encryptGrant } = await import('@/services/financial-connections/crypto')
    expect(() => encryptGrant({ refreshToken: 'x' })).toThrow()
  })
})
