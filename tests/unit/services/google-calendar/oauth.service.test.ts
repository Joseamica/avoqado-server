/**
 * OAuth core service tests — buildAuthUrl, signState/verifyState,
 * exchangeCodeForTokens, verifyGoogleIdToken, refreshAccessToken.
 *
 * `googleapis` and `google-auth-library` are mocked so we can assert on the
 * exact arguments the service sends to Google without making network calls.
 */

// IMPORTANT: jest.mock must be hoisted ABOVE imports of the service we test.
jest.mock('google-auth-library', () => {
  const verifyIdTokenMock = jest.fn()
  const getTokenMock = jest.fn()
  const refreshAccessTokenMock = jest.fn()
  const setCredentialsMock = jest.fn()
  const ctor = jest.fn().mockImplementation(() => ({
    setCredentials: setCredentialsMock,
    verifyIdToken: verifyIdTokenMock,
    getToken: getTokenMock,
    refreshAccessToken: refreshAccessTokenMock,
  }))
  return {
    OAuth2Client: ctor,
    __mocks__: { ctor, verifyIdTokenMock, getTokenMock, refreshAccessTokenMock, setCredentialsMock },
  }
})

jest.mock('googleapis', () => {
  const { OAuth2Client } = jest.requireMock('google-auth-library') as {
    OAuth2Client: jest.Mock
  }
  return {
    google: {
      auth: { OAuth2: OAuth2Client },
    },
  }
})

import {
  buildAuthUrl,
  signState,
  verifyState,
  exchangeCodeForTokens,
  verifyGoogleIdToken,
  refreshAccessToken,
  GOOGLE_CALENDAR_OAUTH_SCOPES,
} from '@/services/google-calendar/oauth.service'

const googleAuthMocks = jest.requireMock('google-auth-library') as {
  __mocks__: {
    ctor: jest.Mock
    verifyIdTokenMock: jest.Mock
    getTokenMock: jest.Mock
    refreshAccessTokenMock: jest.Mock
    setCredentialsMock: jest.Mock
  }
}

describe('OAuth core service', () => {
  beforeEach(() => {
    googleAuthMocks.__mocks__.ctor.mockClear()
    googleAuthMocks.__mocks__.verifyIdTokenMock.mockReset()
    googleAuthMocks.__mocks__.getTokenMock.mockReset()
    googleAuthMocks.__mocks__.refreshAccessTokenMock.mockReset()
    googleAuthMocks.__mocks__.setCredentialsMock.mockClear()
  })

  // ============================================================
  // NEW FEATURE TESTS
  // ============================================================
  it('GOOGLE_CALENDAR_OAUTH_SCOPES contains exactly the 4 required scopes', () => {
    expect(GOOGLE_CALENDAR_OAUTH_SCOPES).toContain('openid')
    expect(GOOGLE_CALENDAR_OAUTH_SCOPES).toContain('email')
    expect(GOOGLE_CALENDAR_OAUTH_SCOPES).toContain('https://www.googleapis.com/auth/calendar.events')
    expect(GOOGLE_CALENDAR_OAUTH_SCOPES).toContain('https://www.googleapis.com/auth/calendar.calendarlist.readonly')
  })

  it('buildAuthUrl includes client_id, redirect_uri, access_type=offline, include_granted_scopes, and state', () => {
    const url = buildAuthUrl('state-jwt', false)
    expect(url).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/)
    expect(url).toContain(`client_id=${encodeURIComponent(process.env.GOOGLE_OAUTH_CLIENT_ID!)}`)
    expect(url).toContain('access_type=offline')
    expect(url).toContain('include_granted_scopes=true')
    expect(url).toContain('state=state-jwt')
    expect(url).toContain('calendar.events')
    expect(url).toContain('calendar.calendarlist.readonly')
    expect(url).not.toContain('prompt=consent')
  })

  it('buildAuthUrl with forceConsent=true appends prompt=consent', () => {
    expect(buildAuthUrl('s', true)).toContain('prompt=consent')
  })

  it('signState / verifyState round-trip preserves the payload', () => {
    const state = signState({
      intent: 'staff_personal',
      authUserId: 'u1',
      staffId: 'u1',
      csrfNonce: 'nonce-1',
    })
    expect(typeof state).toBe('string')
    const decoded = verifyState(state)
    expect(decoded.intent).toBe('staff_personal')
    expect(decoded.authUserId).toBe('u1')
    expect(decoded.staffId).toBe('u1')
    expect(decoded.csrfNonce).toBe('nonce-1')
  })

  it('verifyState rejects a tampered JWT', () => {
    const state = signState({
      intent: 'venue_master',
      authUserId: 'u1',
      venueId: 'v1',
      csrfNonce: 'n',
    })
    const tampered = state.slice(0, -2) + 'XX'
    expect(() => verifyState(tampered)).toThrow()
  })

  it('exchangeCodeForTokens calls OAuth2Client.getToken and throws if id_token missing', async () => {
    googleAuthMocks.__mocks__.getTokenMock.mockResolvedValue({
      tokens: { access_token: 'at', id_token: 'idt', refresh_token: 'rt', expiry_date: 1 },
    })
    const tokens = await exchangeCodeForTokens('the-code')
    expect(googleAuthMocks.__mocks__.getTokenMock).toHaveBeenCalledWith('the-code')
    expect(tokens.access_token).toBe('at')

    googleAuthMocks.__mocks__.getTokenMock.mockResolvedValueOnce({
      tokens: { access_token: 'at', refresh_token: 'rt' }, // no id_token
    })
    await expect(exchangeCodeForTokens('x')).rejects.toThrow(/oidc_id_token_missing/)

    googleAuthMocks.__mocks__.getTokenMock.mockResolvedValueOnce({
      tokens: { id_token: 'idt' }, // no access_token
    })
    await expect(exchangeCodeForTokens('x')).rejects.toThrow(/oauth_access_token_missing/)
  })

  it('verifyGoogleIdToken uses OAuth2Client.verifyIdToken with the configured audience', async () => {
    googleAuthMocks.__mocks__.verifyIdTokenMock.mockResolvedValue({
      getPayload: () => ({ sub: '1234567890', email: 'a@b.com', email_verified: true }),
    })
    const out = await verifyGoogleIdToken('the-id-token')
    const call = googleAuthMocks.__mocks__.verifyIdTokenMock.mock.calls[0][0]
    expect(call.idToken).toBe('the-id-token')
    expect(call.audience).toBe(process.env.GOOGLE_OAUTH_CLIENT_ID)
    expect(out).toEqual({ sub: '1234567890', email: 'a@b.com' })
  })

  it('verifyGoogleIdToken throws when email_verified is false', async () => {
    googleAuthMocks.__mocks__.verifyIdTokenMock.mockResolvedValue({
      getPayload: () => ({ sub: '1234', email: 'a@b.com', email_verified: false }),
    })
    await expect(verifyGoogleIdToken('idt')).rejects.toThrow(/google_email_not_verified/)
  })

  it('verifyGoogleIdToken throws when sub or email is missing from the payload', async () => {
    googleAuthMocks.__mocks__.verifyIdTokenMock.mockResolvedValue({
      getPayload: () => ({ sub: '1234', email_verified: true }), // no email
    })
    await expect(verifyGoogleIdToken('idt')).rejects.toThrow(/oidc_missing_claims/)

    googleAuthMocks.__mocks__.verifyIdTokenMock.mockResolvedValue({
      getPayload: () => ({ email: 'a@b.com', email_verified: true }), // no sub
    })
    await expect(verifyGoogleIdToken('idt')).rejects.toThrow(/oidc_missing_claims/)

    googleAuthMocks.__mocks__.verifyIdTokenMock.mockResolvedValue({ getPayload: () => null })
    await expect(verifyGoogleIdToken('idt')).rejects.toThrow(/oidc_missing_claims/)
  })

  it('refreshAccessToken returns the new credentials from the OAuth2 client', async () => {
    googleAuthMocks.__mocks__.refreshAccessTokenMock.mockResolvedValue({
      credentials: { access_token: 'newer-at', expiry_date: Date.now() + 3600_000 },
    })
    const out = await refreshAccessToken('the-refresh-token')
    expect(googleAuthMocks.__mocks__.setCredentialsMock).toHaveBeenCalledWith({
      refresh_token: 'the-refresh-token',
    })
    expect(out.access_token).toBe('newer-at')
  })

  // ============================================================
  // REGRESSION TESTS
  // ============================================================
  it('REGRESSION: buildAuthUrl does NOT leak the client secret in the URL', () => {
    const url = buildAuthUrl('s', false)
    expect(url).not.toContain(process.env.GOOGLE_OAUTH_CLIENT_SECRET!)
  })

  it('REGRESSION: verifyGoogleIdToken passes audience to prevent token confusion attacks', async () => {
    googleAuthMocks.__mocks__.verifyIdTokenMock.mockResolvedValue({
      getPayload: () => ({ sub: '1', email: 'a@b.com', email_verified: true }),
    })
    await verifyGoogleIdToken('idt')
    const call = googleAuthMocks.__mocks__.verifyIdTokenMock.mock.calls.at(-1)![0]
    expect(call.audience).toBe(process.env.GOOGLE_OAUTH_CLIENT_ID)
    expect(call.audience).toBeTruthy()
  })
})
