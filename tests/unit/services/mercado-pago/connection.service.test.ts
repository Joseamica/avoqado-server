import { persistTokens, loadCredentials, clearCredentials, refreshIfExpiring } from '@/services/mercado-pago/connection.service'
import { createTokenCipher } from '@/lib/token-encryption'
import prisma from '@/utils/prismaClient'
import * as oauthService from '@/services/mercado-pago/oauth.service'
import type { MercadoPagoTokenResponse } from '@/services/mercado-pago/types'

jest.mock('@/services/mercado-pago/oauth.service')

const cipher = createTokenCipher('MERCADO_PAGO_TOKEN_KEY')

const mockPrisma = prisma as unknown as {
  ecommerceMerchant: { findUnique: jest.Mock; update: jest.Mock }
}

const sampleTokens: MercadoPagoTokenResponse = {
  access_token: 'APP_USR-access-xyz',
  refresh_token: 'TG-refresh-abc',
  token_type: 'bearer',
  expires_in: 15552000,
  scope: 'offline_access read write',
  user_id: 12345678,
  public_key: 'APP_USR-pk-xyz',
  live_mode: false,
}

describe('persistTokens', () => {
  beforeEach(() => jest.clearAllMocks())

  it('MERGES with existing providerCredentials (preserves unrelated keys)', async () => {
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue({
      id: 'em_1',
      providerCredentials: {
        unrelatedField: 'keep-me',
        someOtherSetting: { nested: true },
        // Old MP fields that should be overwritten
        mpUserId: 'old-99',
        scope: 'OLD',
      },
    })
    mockPrisma.ecommerceMerchant.update.mockResolvedValue({ id: 'em_1' })

    await persistTokens('em_1', sampleTokens)

    expect(mockPrisma.ecommerceMerchant.update).toHaveBeenCalledTimes(1)
    const updateArgs = mockPrisma.ecommerceMerchant.update.mock.calls[0][0]
    const creds = updateArgs.data.providerCredentials

    // Preserved
    expect(creds.unrelatedField).toBe('keep-me')
    expect(creds.someOtherSetting).toEqual({ nested: true })

    // Updated to new values
    expect(creds.mpUserId).toBe('12345678')
    expect(creds.scope).toBe('offline_access read write')

    // Envelope versions
    expect(creds.schemaVersion).toBe(1)
    expect(creds.keyVersion).toBe(1)

    // Encrypted tokens decrypt back
    expect(cipher.decryptFromBase64(creds.accessTokenCiphertext)).toBe('APP_USR-access-xyz')
    expect(cipher.decryptFromBase64(creds.refreshTokenCiphertext)).toBe('TG-refresh-abc')

    // Provider merchant id mirrored
    expect(updateArgs.data.providerMerchantId).toBe('12345678')

    // Public key persisted (Brick needs it)
    expect(creds.publicKey).toBe('APP_USR-pk-xyz')

    // expiresAt is set to ~now + expires_in
    const expiresAtMs = new Date(creds.expiresAt).getTime()
    expect(expiresAtMs).toBeGreaterThan(Date.now())
    expect(expiresAtMs).toBeLessThanOrEqual(Date.now() + sampleTokens.expires_in * 1000 + 1000)
  })

  it('works when providerCredentials is empty', async () => {
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue({
      id: 'em_1',
      providerCredentials: {},
    })
    mockPrisma.ecommerceMerchant.update.mockResolvedValue({ id: 'em_1' })

    await persistTokens('em_1', sampleTokens)

    const updateArgs = mockPrisma.ecommerceMerchant.update.mock.calls[0][0]
    const creds = updateArgs.data.providerCredentials
    expect(creds.mpUserId).toBe('12345678')
    expect(creds.accessTokenCiphertext).toBeTruthy()
  })

  it('works when providerCredentials is null/undefined', async () => {
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue({
      id: 'em_1',
      providerCredentials: null,
    })
    mockPrisma.ecommerceMerchant.update.mockResolvedValue({ id: 'em_1' })

    await persistTokens('em_1', sampleTokens)

    expect(mockPrisma.ecommerceMerchant.update).toHaveBeenCalled()
  })

  it('records lastRefreshedAt on every persist', async () => {
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue({ id: 'em_1', providerCredentials: {} })
    mockPrisma.ecommerceMerchant.update.mockResolvedValue({ id: 'em_1' })

    const before = Date.now()
    await persistTokens('em_1', sampleTokens)
    const after = Date.now()

    const updateArgs = mockPrisma.ecommerceMerchant.update.mock.calls[0][0]
    const lastRefreshedAt = new Date(updateArgs.data.providerCredentials.lastRefreshedAt).getTime()
    expect(lastRefreshedAt).toBeGreaterThanOrEqual(before)
    expect(lastRefreshedAt).toBeLessThanOrEqual(after + 100)
  })
})

describe('loadCredentials', () => {
  beforeEach(() => jest.clearAllMocks())

  it('returns null when merchant does not exist', async () => {
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue(null)
    expect(await loadCredentials('em_nope')).toBeNull()
  })

  it('returns null when providerCredentials lacks MP fields', async () => {
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue({
      id: 'em_1',
      providerCredentials: { unrelated: 'x' },
    })
    expect(await loadCredentials('em_1')).toBeNull()
  })

  it('decrypts and returns credentials', async () => {
    const providerCredentials = {
      schemaVersion: 1,
      keyVersion: 1,
      mpUserId: '12345678',
      accessTokenCiphertext: cipher.encryptToBase64('APP_USR-access-xyz'),
      refreshTokenCiphertext: cipher.encryptToBase64('TG-refresh-abc'),
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
      scope: 'offline_access read write',
      liveMode: false,
      publicKey: 'APP_USR-pk-xyz',
      lastRefreshedAt: new Date().toISOString(),
    }
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue({
      id: 'em_1',
      providerCredentials,
    })

    const result = await loadCredentials('em_1')
    expect(result).not.toBeNull()
    expect(result!.mpUserId).toBe('12345678')
    expect(result!.accessToken).toBe('APP_USR-access-xyz')
    expect(result!.refreshToken).toBe('TG-refresh-abc')
    expect(result!.publicKey).toBe('APP_USR-pk-xyz')
    expect(result!.scope).toBe('offline_access read write')
    expect(result!.liveMode).toBe(false)
    expect(result!.expiresAt).toBeInstanceOf(Date)
    expect(result!.lastRefreshedAt).toBeInstanceOf(Date)
  })
})

describe('clearCredentials', () => {
  beforeEach(() => jest.clearAllMocks())

  it('removes only MP keys, keeps unrelated fields intact', async () => {
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue({
      id: 'em_1',
      providerCredentials: {
        unrelatedField: 'keep-me',
        otherProviderConfig: { foo: 'bar' },
        // MP fields to be removed
        schemaVersion: 1,
        keyVersion: 1,
        mpUserId: '12345678',
        accessTokenCiphertext: 'some-b64',
        refreshTokenCiphertext: 'some-b64',
        expiresAt: '2026-11-19T00:00:00.000Z',
        scope: 'offline_access',
        liveMode: true,
        publicKey: 'APP_USR-pk',
        lastRefreshedAt: '2026-05-20T00:00:00.000Z',
      },
    })
    mockPrisma.ecommerceMerchant.update.mockResolvedValue({ id: 'em_1' })

    await clearCredentials('em_1')

    const updateArgs = mockPrisma.ecommerceMerchant.update.mock.calls[0][0]
    const creds = updateArgs.data.providerCredentials

    // Preserved
    expect(creds.unrelatedField).toBe('keep-me')
    expect(creds.otherProviderConfig).toEqual({ foo: 'bar' })

    // MP fields removed
    expect(creds.mpUserId).toBeUndefined()
    expect(creds.accessTokenCiphertext).toBeUndefined()
    expect(creds.refreshTokenCiphertext).toBeUndefined()
    expect(creds.expiresAt).toBeUndefined()
    expect(creds.scope).toBeUndefined()
    expect(creds.liveMode).toBeUndefined()
    expect(creds.publicKey).toBeUndefined()
    expect(creds.lastRefreshedAt).toBeUndefined()
    expect(creds.schemaVersion).toBeUndefined()
    expect(creds.keyVersion).toBeUndefined()

    // providerMerchantId nulled
    expect(updateArgs.data.providerMerchantId).toBeNull()
  })

  it('is safe when providerCredentials is already empty', async () => {
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue({
      id: 'em_1',
      providerCredentials: {},
    })
    mockPrisma.ecommerceMerchant.update.mockResolvedValue({ id: 'em_1' })

    await clearCredentials('em_1')

    expect(mockPrisma.ecommerceMerchant.update).toHaveBeenCalled()
    const updateArgs = mockPrisma.ecommerceMerchant.update.mock.calls[0][0]
    expect(updateArgs.data.providerCredentials).toEqual({})
    expect(updateArgs.data.providerMerchantId).toBeNull()
  })
})

describe('refreshIfExpiring', () => {
  /**
   * The advisory lock uses prisma.$transaction → tx.$executeRaw. The global
   * mock prismaMock.$transaction is already wired in setup.ts to invoke the
   * callback with prismaMock itself, so we just need to make tx.$executeRaw
   * resolvable. The tx parameter inside the transaction will be the same
   * mockPrisma, so we stub tx.findUnique / tx.update on that shared mock.
   */
  const mockTx = mockPrisma as unknown as {
    ecommerceMerchant: { findUnique: jest.Mock; update: jest.Mock }
    $executeRaw: jest.Mock
  }

  beforeEach(() => {
    jest.clearAllMocks()
    ;(prisma as any).$executeRaw = jest.fn().mockResolvedValue(1)
    mockTx.$executeRaw = (prisma as any).$executeRaw
  })

  it('returns "merchant_not_found" when merchant does not exist', async () => {
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue(null)
    expect(await refreshIfExpiring('em_nope', 30)).toBe('merchant_not_found')
  })

  it('returns "no_credentials" when merchant has no MP creds', async () => {
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue({
      id: 'em_1',
      venueId: 'v_1',
      providerCredentials: { unrelated: 'x' },
    })
    expect(await refreshIfExpiring('em_1', 30)).toBe('no_credentials')
  })

  it('returns "not_needed" when expiry is far in the future', async () => {
    const farFuture = new Date(Date.now() + 100 * 86400_000).toISOString() // 100 days out
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue({
      id: 'em_1',
      venueId: 'v_1',
      providerCredentials: {
        schemaVersion: 1,
        keyVersion: 1,
        mpUserId: '1',
        accessTokenCiphertext: cipher.encryptToBase64('access'),
        refreshTokenCiphertext: cipher.encryptToBase64('refresh'),
        expiresAt: farFuture,
        scope: 'offline_access',
        liveMode: false,
        publicKey: 'APP_USR-pk',
      },
    })

    expect(await refreshIfExpiring('em_1', 30)).toBe('not_needed')
    expect(oauthService.refreshAccessToken).not.toHaveBeenCalled()
  })

  it('refreshes when expiry is within the threshold', async () => {
    const expiresSoon = new Date(Date.now() + 10 * 86400_000).toISOString() // 10 days out (within 30-day threshold)

    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue({
      id: 'em_1',
      venueId: 'v_1',
      providerCredentials: {
        schemaVersion: 1,
        keyVersion: 1,
        mpUserId: '12345678',
        accessTokenCiphertext: cipher.encryptToBase64('OLD-access'),
        refreshTokenCiphertext: cipher.encryptToBase64('OLD-refresh'),
        expiresAt: expiresSoon,
        scope: 'offline_access',
        liveMode: false,
        publicKey: 'APP_USR-pk-old',
      },
    })
    ;(oauthService.refreshAccessToken as jest.Mock).mockResolvedValue({
      access_token: 'NEW-access',
      refresh_token: 'NEW-refresh',
      token_type: 'bearer',
      expires_in: 15552000,
      scope: 'offline_access read write',
      user_id: 12345678,
      public_key: 'APP_USR-pk-NEW',
      live_mode: false,
    })
    mockPrisma.ecommerceMerchant.update.mockResolvedValue({ id: 'em_1' })

    const result = await refreshIfExpiring('em_1', 30)

    expect(result).toBe('refreshed')

    // Refresh API called with the decrypted OLD refresh token
    expect(oauthService.refreshAccessToken).toHaveBeenCalledWith('OLD-refresh')

    // Update was called with new encrypted values
    expect(mockPrisma.ecommerceMerchant.update).toHaveBeenCalledTimes(1)
    const updateArgs = mockPrisma.ecommerceMerchant.update.mock.calls[0][0]
    const creds = updateArgs.data.providerCredentials
    expect(cipher.decryptFromBase64(creds.accessTokenCiphertext)).toBe('NEW-access')
    expect(cipher.decryptFromBase64(creds.refreshTokenCiphertext)).toBe('NEW-refresh')
    expect(creds.publicKey).toBe('APP_USR-pk-NEW')
    expect(updateArgs.data.providerMerchantId).toBe('12345678')
  })

  it('acquires per-venue advisory lock via pg_advisory_xact_lock', async () => {
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue({
      id: 'em_1',
      venueId: 'v_HASH_ME',
      providerCredentials: {
        schemaVersion: 1,
        keyVersion: 1,
        mpUserId: '1',
        accessTokenCiphertext: cipher.encryptToBase64('a'),
        refreshTokenCiphertext: cipher.encryptToBase64('r'),
        expiresAt: new Date(Date.now() + 86400_000).toISOString(),
        scope: 'offline_access',
        liveMode: false,
        publicKey: 'pk',
      },
    })
    ;(oauthService.refreshAccessToken as jest.Mock).mockResolvedValue({
      access_token: 'N',
      refresh_token: 'NR',
      token_type: 'bearer',
      expires_in: 15552000,
      scope: 'offline_access',
      user_id: 1,
      public_key: 'pk',
      live_mode: false,
    })
    mockPrisma.ecommerceMerchant.update.mockResolvedValue({})

    await refreshIfExpiring('em_1', 30)

    // Verify pg_advisory_xact_lock was called (we don't care about the literal
    // template here — the mock receives a template-literal call)
    expect(mockTx.$executeRaw).toHaveBeenCalled()
    const lockCall = mockTx.$executeRaw.mock.calls[0]
    // First arg is the TemplateStringsArray
    const sql = lockCall[0]?.raw?.join('') || ''
    expect(sql).toMatch(/pg_advisory_xact_lock/i)
  })

  it('runs inside prisma.$transaction so the advisory lock auto-releases', async () => {
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue(null)
    await refreshIfExpiring('em_x', 30)
    expect((prisma as any).$transaction).toHaveBeenCalled()
  })

  it('preserves unrelated providerCredentials keys during refresh (MERGE)', async () => {
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue({
      id: 'em_1',
      venueId: 'v_1',
      providerCredentials: {
        unrelatedField: 'keep-me',
        schemaVersion: 1,
        keyVersion: 1,
        mpUserId: '12345678',
        accessTokenCiphertext: cipher.encryptToBase64('OLD'),
        refreshTokenCiphertext: cipher.encryptToBase64('OLD-r'),
        expiresAt: new Date(Date.now() + 86400_000).toISOString(),
        scope: 'offline_access',
        liveMode: false,
        publicKey: 'OLD-pk',
      },
    })
    ;(oauthService.refreshAccessToken as jest.Mock).mockResolvedValue({
      access_token: 'NEW',
      refresh_token: 'NEW-r',
      token_type: 'bearer',
      expires_in: 15552000,
      scope: 'offline_access',
      user_id: 12345678,
      public_key: 'NEW-pk',
      live_mode: false,
    })
    mockPrisma.ecommerceMerchant.update.mockResolvedValue({})

    await refreshIfExpiring('em_1', 30)

    const updateArgs = mockPrisma.ecommerceMerchant.update.mock.calls[0][0]
    expect(updateArgs.data.providerCredentials.unrelatedField).toBe('keep-me')
  })
})
