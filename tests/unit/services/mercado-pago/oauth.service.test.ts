import jwt from 'jsonwebtoken'
import nock from 'nock'
import { signState, verifyState, buildAuthUrl, exchangeCodeForTokens, refreshAccessToken } from '@/services/mercado-pago/oauth.service'
import type { MercadoPagoOAuthState } from '@/services/mercado-pago/types'

// Guarantee NO real HTTP calls leak from these tests (would hit MP for real)
beforeAll(() => {
  nock.disableNetConnect()
})
afterAll(() => {
  nock.cleanAll()
  nock.enableNetConnect()
})

describe('MP OAuth state helpers', () => {
  const payload: MercadoPagoOAuthState = {
    intent: 'connect_merchant',
    ecommerceMerchantId: 'em_abc',
    venueId: 'v_1',
    staffId: 's_1',
  }

  it('roundtrips a state payload', () => {
    const token = signState(payload)
    const decoded = verifyState(token)
    expect(decoded.ecommerceMerchantId).toBe('em_abc')
    expect(decoded.venueId).toBe('v_1')
    expect(decoded.staffId).toBe('s_1')
    expect(decoded.intent).toBe('connect_merchant')
  })

  it('rejects a tampered token', () => {
    const token = signState(payload)
    // Flip the last char to invalidate the signature
    const tampered = token.slice(0, -2) + (token.endsWith('a') ? 'b' : 'a') + token.slice(-1)
    expect(() => verifyState(tampered)).toThrow()
  })

  it('rejects an expired token', () => {
    // Sign a token whose exp is already in the past
    const expired = jwt.sign({ ...payload, exp: Math.floor(Date.now() / 1000) - 60 }, process.env.OAUTH_STATE_SECRET!)
    expect(() => verifyState(expired)).toThrow(/expired/i)
  })

  it('rejects a token signed with a different secret', () => {
    const other = jwt.sign(payload, 'a-different-secret')
    expect(() => verifyState(other)).toThrow()
  })
})

describe('MP OAuth - buildAuthUrl', () => {
  it('uses MP_AUTH_BASE_URL host + all required params', () => {
    const url = buildAuthUrl('state-jwt-xyz')
    const parsed = new URL(url)
    expect(parsed.origin).toBe('https://auth.mercadopago.com.mx')
    expect(parsed.pathname).toBe('/authorization')
    expect(parsed.searchParams.get('client_id')).toBe('test-mp-client-id')
    expect(parsed.searchParams.get('response_type')).toBe('code')
    expect(parsed.searchParams.get('platform_id')).toBe('mp')
    expect(parsed.searchParams.get('state')).toBe('state-jwt-xyz')
    expect(parsed.searchParams.get('redirect_uri')).toBe(process.env.MP_REDIRECT_URI)
  })
})

describe('MP OAuth - exchangeCodeForTokens', () => {
  beforeEach(() => nock.cleanAll())

  it('POSTs to /oauth/token with authorization_code grant', async () => {
    nock('https://api.mercadopago.com')
      .post('/oauth/token', body => {
        return (
          body.client_id === 'test-mp-client-id' &&
          body.client_secret === 'test-mp-client-secret' &&
          body.grant_type === 'authorization_code' &&
          body.code === 'auth-code-123' &&
          body.redirect_uri === process.env.MP_REDIRECT_URI
        )
      })
      .reply(200, {
        access_token: 'APP_USR-access-xyz',
        token_type: 'bearer',
        expires_in: 15552000,
        scope: 'offline_access read write',
        user_id: 12345678,
        refresh_token: 'TG-refresh-abc',
        public_key: 'APP_USR-pk-xyz',
        live_mode: false,
      })

    const tokens = await exchangeCodeForTokens('auth-code-123')
    expect(tokens.access_token).toBe('APP_USR-access-xyz')
    expect(tokens.refresh_token).toBe('TG-refresh-abc')
    expect(tokens.user_id).toBe(12345678)
    expect(tokens.expires_in).toBe(15552000)
    expect(tokens.public_key).toBe('APP_USR-pk-xyz')
  })

  it('surfaces MP error_description when MP rejects the exchange', async () => {
    nock('https://api.mercadopago.com').post('/oauth/token').reply(400, { error: 'invalid_grant', error_description: 'code has expired' })

    await expect(exchangeCodeForTokens('expired-code')).rejects.toThrow(/invalid_grant|code has expired/i)
  })
})

describe('MP OAuth - refreshAccessToken', () => {
  beforeEach(() => nock.cleanAll())

  it('POSTs to /oauth/token with grant_type=refresh_token', async () => {
    nock('https://api.mercadopago.com')
      .post('/oauth/token', body => {
        return body.grant_type === 'refresh_token' && body.refresh_token === 'old-refresh-token' && body.client_id === 'test-mp-client-id'
      })
      .reply(200, {
        access_token: 'NEW-access',
        token_type: 'bearer',
        expires_in: 15552000,
        scope: 'offline_access read write',
        user_id: 12345678,
        refresh_token: 'NEW-refresh',
        public_key: 'APP_USR-pk',
        live_mode: false,
      })

    const tokens = await refreshAccessToken('old-refresh-token')
    expect(tokens.access_token).toBe('NEW-access')
    expect(tokens.refresh_token).toBe('NEW-refresh')
  })

  it('surfaces error when refresh token is invalid', async () => {
    nock('https://api.mercadopago.com')
      .post('/oauth/token')
      .reply(400, { error: 'invalid_grant', error_description: 'refresh_token not found' })

    await expect(refreshAccessToken('bad-token')).rejects.toThrow(/invalid_grant|refresh_token not found/i)
  })
})
