/**
 * watch-channel.service — events.watch / channels.stop wrappers.
 *
 * We mock googleapis to assert the EXACT shape we send Google. The two
 * load-bearing invariants are:
 *   1. params.ttl (string seconds) MUST be set; sending `expiration` instead
 *      makes Google ignore the TTL and use its default ~604800s anyway, but
 *      we lose the ability to ask for a shorter window in tests.
 *   2. We save the `expiration` Google RETURNS as `expiresAt` — never the TTL
 *      we requested. Google may shorten the window unilaterally.
 */
const watchMock = jest.fn()
const stopMock = jest.fn()
const setCredentialsMock = jest.fn()

jest.mock('googleapis', () => {
  return {
    google: {
      calendar: jest.fn().mockReturnValue({
        events: { watch: watchMock },
        channels: { stop: stopMock },
      }),
    },
  }
})

jest.mock('google-auth-library', () => {
  return {
    OAuth2Client: jest.fn().mockImplementation(() => ({
      setCredentials: setCredentialsMock,
    })),
  }
})

import { subscribeToCalendar, stopChannel } from '@/services/google-calendar/watch-channel.service'

describe('watch-channel.service', () => {
  beforeEach(() => {
    watchMock.mockReset()
    stopMock.mockReset()
    setCredentialsMock.mockClear()
  })

  // ============================================================
  // NEW FEATURE TESTS
  // ============================================================
  it('subscribeToCalendar sends params.ttl=604800 (string) and stores Google-returned expiration', async () => {
    const googleExpiration = String(Date.now() + 7 * 86_400_000)
    watchMock.mockResolvedValue({ data: { resourceId: 'res-1', expiration: googleExpiration } })

    const out = await subscribeToCalendar({
      accessToken: 'at',
      refreshToken: 'rt',
      calendarId: 'cal-1',
      webhookUrl: 'https://api.example.com/webhooks/google-calendar',
    })

    // channelId is a UUID we generate; token is 32 random bytes hex-encoded (64 chars).
    expect(out.channelId).toMatch(/^[0-9a-f-]{36}$/)
    expect(out.resourceId).toBe('res-1')
    expect(out.token).toHaveLength(64)
    expect(out.expiresAt).toBeInstanceOf(Date)
    expect(out.expiresAt.getTime()).toBe(Number(googleExpiration))

    // Assert request shape
    expect(watchMock).toHaveBeenCalledTimes(1)
    const arg = watchMock.mock.calls[0][0]
    expect(arg.calendarId).toBe('cal-1')
    expect(arg.requestBody.id).toBe(out.channelId)
    expect(arg.requestBody.type).toBe('web_hook')
    expect(arg.requestBody.address).toBe('https://api.example.com/webhooks/google-calendar')
    expect(arg.requestBody.token).toBe(out.token)
    expect(arg.requestBody.params).toEqual({ ttl: '604800' })
    // CRITICAL: must NOT send 'expiration' (it's response-only)
    expect(arg.requestBody).not.toHaveProperty('expiration')
  })

  it('subscribeToCalendar applies access + refresh tokens to the OAuth client', async () => {
    watchMock.mockResolvedValue({ data: { resourceId: 'r', expiration: String(Date.now() + 1000) } })
    await subscribeToCalendar({
      accessToken: 'AT',
      refreshToken: 'RT',
      calendarId: 'c',
      webhookUrl: 'https://x/y',
    })
    expect(setCredentialsMock).toHaveBeenCalledWith({ access_token: 'AT', refresh_token: 'RT' })
  })

  it('stopChannel sends channelId + resourceId to channels.stop', async () => {
    stopMock.mockResolvedValue({})
    await stopChannel({
      accessToken: 'at',
      refreshToken: 'rt',
      channelId: 'ch-1',
      resourceId: 'res-1',
    })
    expect(stopMock).toHaveBeenCalledWith({
      requestBody: { id: 'ch-1', resourceId: 'res-1' },
    })
  })

  // ============================================================
  // REGRESSION TESTS
  // ============================================================
  it('REGRESSION: subscribeToCalendar generates a fresh channelId on each call', async () => {
    watchMock.mockResolvedValue({ data: { resourceId: 'r', expiration: String(Date.now() + 1000) } })
    const a = await subscribeToCalendar({
      accessToken: 'at',
      refreshToken: 'rt',
      calendarId: 'c',
      webhookUrl: 'https://x/y',
    })
    const b = await subscribeToCalendar({
      accessToken: 'at',
      refreshToken: 'rt',
      calendarId: 'c',
      webhookUrl: 'https://x/y',
    })
    expect(a.channelId).not.toBe(b.channelId)
    expect(a.token).not.toBe(b.token)
  })
})
