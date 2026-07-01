/**
 * Tests for the external bank provider (QPay) auth service — the single
 * shared broker login used to look up balances for every Avoqado sucursal.
 *
 * Uses the established resetModules + dynamic-import pattern (see
 * tests/unit/services/resend.newVenueDigest.test.ts) since the service reads
 * its config through `@/config/env`, a module-level snapshot of process.env
 * taken at first import — only a fresh module registry picks up new values.
 */
import nock from 'nock'

const TEST_BASE = 'https://external-bank-test.example.com'
const SIGN_IN_PATH = '/api/auth/sign-in/merchant'

function setEnv(overrides: Partial<Record<string, string>> = {}) {
  delete process.env.EXTERNAL_BANK_EMAIL
  delete process.env.EXTERNAL_BANK_PASSWORD
  delete process.env.EXTERNAL_BANK_API_BASE
  delete process.env.EXTERNAL_BANK_MG_PLATFORM
  process.env.EXTERNAL_BANK_API_BASE = TEST_BASE
  process.env.EXTERNAL_BANK_MG_PLATFORM = 'MERCHANT'
  process.env.EXTERNAL_BANK_EMAIL = 'broker@avoqado.io'
  process.env.EXTERNAL_BANK_PASSWORD = 'super-secret'
  Object.assign(process.env, overrides)
}

async function loadFreshService() {
  jest.resetModules()
  const mod = await import('@/services/externalBank/externalBankAuth.service')
  return new mod.ExternalBankAuthService()
}

beforeAll(() => {
  nock.disableNetConnect()
})
afterAll(() => {
  nock.cleanAll()
  nock.enableNetConnect()
})
afterEach(() => {
  nock.cleanAll()
})

describe('ExternalBankAuthService', () => {
  it('throws if EXTERNAL_BANK_EMAIL/PASSWORD are not configured', async () => {
    setEnv({ EXTERNAL_BANK_EMAIL: '', EXTERNAL_BANK_PASSWORD: '' })
    const service = await loadFreshService()
    await expect(service.getValidToken()).rejects.toThrow(/EXTERNAL_BANK_EMAIL/)
  })

  it('authenticates against /sign-in/merchant and returns the token on success', async () => {
    setEnv()
    const scope = nock(TEST_BASE)
      .post(SIGN_IN_PATH)
      .reply(200, {
        signedIn: true,
        token: 'abc123',
        expiresIn: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })
    const service = await loadFreshService()

    const token = await service.getValidToken()

    expect(token).toBe('abc123')
    expect(scope.isDone()).toBe(true)
  })

  it('caches the token — a second call within expiry makes no new request', async () => {
    setEnv()
    const scope = nock(TEST_BASE)
      .post(SIGN_IN_PATH)
      .once()
      .reply(200, {
        signedIn: true,
        token: 'cached-token',
        expiresIn: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })
    const service = await loadFreshService()

    const first = await service.getValidToken()
    const second = await service.getValidToken()

    expect(first).toBe('cached-token')
    expect(second).toBe('cached-token')
    expect(scope.isDone()).toBe(true) // exactly one sign-in call, not two
  })

  it('re-authenticates once the cached token is past its expiry buffer', async () => {
    setEnv()
    nock(TEST_BASE)
      .post(SIGN_IN_PATH)
      .reply(200, {
        signedIn: true,
        token: 'soon-to-expire',
        // Already inside the 5-minute buffer → treated as expired immediately.
        expiresIn: new Date(Date.now() + 60 * 1000).toISOString(),
      })
    nock(TEST_BASE)
      .post(SIGN_IN_PATH)
      .reply(200, {
        signedIn: true,
        token: 'fresh-token',
        expiresIn: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })
    const service = await loadFreshService()

    const first = await service.getValidToken()
    const second = await service.getValidToken()

    expect(first).toBe('soon-to-expire')
    expect(second).toBe('fresh-token')
  })

  // Confirmed empirically against production: a token issued alongside
  // needTwoFactorAuth:true still works for GET /api/auth (the only thing
  // this service calls) — 2FA gates writes, not this read-only lookup.
  it('does NOT block on needTwoFactorAuth — still returns the token', async () => {
    setEnv()
    nock(TEST_BASE)
      .post(SIGN_IN_PATH)
      .reply(200, {
        signedIn: true,
        needTwoFactorAuth: true,
        token: 'token-despite-2fa-pending',
        expiresIn: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })
    const service = await loadFreshService()

    const token = await service.getValidToken()

    expect(token).toBe('token-despite-2fa-pending')
  })

  it('surfaces a clear error when the device needs validation', async () => {
    setEnv()
    nock(TEST_BASE).post(SIGN_IN_PATH).reply(200, { needDeviceValidation: true })
    const service = await loadFreshService()

    await expect(service.getValidToken()).rejects.toThrow(/identidad|dispositivo/i)
  })

  it('throws when signedIn is false even on a 200 response', async () => {
    setEnv()
    nock(TEST_BASE).post(SIGN_IN_PATH).reply(200, { signedIn: false, message: 'Credenciales inválidas' })
    const service = await loadFreshService()

    await expect(service.getValidToken()).rejects.toThrow('Credenciales inválidas')
  })

  // Tolerate the generic /sign-in endpoint's documented field name too, in
  // case a future response shape (or a different account type) uses it.
  it('falls back to isLoggedIn when signedIn is absent', async () => {
    setEnv()
    nock(TEST_BASE)
      .post(SIGN_IN_PATH)
      .reply(200, {
        isLoggedIn: true,
        token: 'legacy-field-token',
        expiresIn: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })
    const service = await loadFreshService()

    const token = await service.getValidToken()

    expect(token).toBe('legacy-field-token')
  })

  // QPay mixes casing across endpoints — confirmed empirically against
  // production: sign-in failures come back PascalCase ({Success, Message}).
  it('authenticates correctly when the success response is PascalCase', async () => {
    setEnv()
    nock(TEST_BASE)
      .post(SIGN_IN_PATH)
      .reply(200, {
        SignedIn: true,
        Token: 'pascal-token',
        ExpiresIn: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })
    const service = await loadFreshService()

    const token = await service.getValidToken()

    expect(token).toBe('pascal-token')
  })

  it('surfaces the real API message on a hard 400 (PascalCase body), not the generic axios error', async () => {
    setEnv()
    nock(TEST_BASE).post(SIGN_IN_PATH).reply(400, {
      Success: false,
      Message: 'Este usuario no tiene una cuenta.',
      HttpStatusCode: 400,
      IdOperacion: null,
    })
    const service = await loadFreshService()

    await expect(service.getValidToken()).rejects.toThrow('Este usuario no tiene una cuenta.')
  })

  it('invalidate() forces the next call to re-authenticate', async () => {
    setEnv()
    nock(TEST_BASE)
      .post(SIGN_IN_PATH)
      .twice()
      .reply(200, {
        signedIn: true,
        token: 'tok',
        expiresIn: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })
    const service = await loadFreshService()

    await service.getValidToken()
    service.invalidate()
    await service.getValidToken()

    expect(nock.pendingMocks()).toHaveLength(0)
  })
})
