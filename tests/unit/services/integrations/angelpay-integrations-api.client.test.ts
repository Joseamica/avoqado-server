/**
 * AngelPay Integrations API client tests.
 *
 * Mocks `axios` at the module level. `angelpay-integrations-api.client.ts`
 * calls `axios.create(...)` ONCE at module-load time (like `deliverect.client.ts`),
 * so the mock factory builds the fake http instance itself and exposes its
 * jest.fn()s on the mocked module (`__mockInstance`) — the standard workaround
 * for Jest's "no out-of-scope variables in a jest.mock factory" restriction
 * (variables would otherwise need a `mock`-prefixed name and still race the
 * hoisted `jest.mock` call).
 *
 * Spec: 2026-07-21 AngelPay connect-via-apiKey.
 */
import axios from 'axios'

jest.mock('axios', () => {
  const mockInstance = {
    post: jest.fn(),
    get: jest.fn(),
    delete: jest.fn(),
  }
  return {
    __esModule: true,
    // esModuleInterop maps `import axios from 'axios'` to this `default` —
    // `__mockInstance` must live INSIDE it (not on the outer module object)
    // for the test file's `axios.__mockInstance` access below to resolve.
    default: {
      create: jest.fn(() => mockInstance),
      __mockInstance: mockInstance,
    },
  }
})

import { angelPayIntegrationsApiClient, AngelPayIntegrationsApiError } from '@/services/integrations/angelpay-integrations-api.client'

const mockHttp = (axios as unknown as { __mockInstance: { post: jest.Mock; get: jest.Mock; delete: jest.Mock } }).__mockInstance

/** Builds a syntactically-valid (unsigned) JWT with the given payload, matching what AngelPay returns. */
function fakeJwt(payload: Record<string, unknown>): string {
  const base64url = Buffer.from(JSON.stringify(payload)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `x.${base64url}.y`
}

function axiosError(status: number, data: unknown = {}): unknown {
  return {
    message: `Request failed with status code ${status}`,
    response: { status, data },
  }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('angelPayIntegrationsApiClient', () => {
  describe('auth()', () => {
    it('decodes merchant_id (JWT payload.sub) from the access_token on success', async () => {
      const token = fakeJwt({ sub: '990' })
      mockHttp.post.mockResolvedValue({
        status: 200,
        data: { access_token: token, token_type: 'bearer', expires_in: 3600 },
      })

      const result = await angelPayIntegrationsApiClient.auth('valid-key', 'QA')

      expect(result).toEqual({ accessToken: token, merchantId: '990' })
    })

    it('calls POST /auth/token with the apiKey body against the QA base URL', async () => {
      mockHttp.post.mockResolvedValue({
        status: 200,
        data: { access_token: fakeJwt({ sub: '1' }), token_type: 'bearer', expires_in: 3600 },
      })

      await angelPayIntegrationsApiClient.auth('my-key', 'QA')

      expect(mockHttp.post).toHaveBeenCalledWith(
        '/auth/token',
        { apiKey: 'my-key' },
        expect.objectContaining({ baseURL: expect.any(String) }),
      )
      const [, , config] = mockHttp.post.mock.calls[0]
      expect(config.baseURL).toBe(angelPayIntegrationsApiClient.baseUrlFor('QA'))
    })

    it('uses the PROD base URL when environment is PROD', async () => {
      mockHttp.post.mockResolvedValue({
        status: 200,
        data: { access_token: fakeJwt({ sub: '1' }), token_type: 'bearer', expires_in: 3600 },
      })

      await angelPayIntegrationsApiClient.auth('my-key', 'PROD')

      const [, , config] = mockHttp.post.mock.calls[0]
      expect(config.baseURL).toBe(angelPayIntegrationsApiClient.baseUrlFor('PROD'))
      expect(config.baseURL).not.toBe(angelPayIntegrationsApiClient.baseUrlFor('QA'))
    })

    it('throws AngelPayIntegrationsApiError with status=401 on an invalid apiKey (non-200)', async () => {
      mockHttp.post.mockRejectedValue(axiosError(401, { message: 'invalid api key' }))

      await expect(angelPayIntegrationsApiClient.auth('bad-key', 'QA')).rejects.toThrow(AngelPayIntegrationsApiError)
      await expect(angelPayIntegrationsApiClient.auth('bad-key', 'QA')).rejects.toMatchObject({ status: 401 })
    })

    it('throws AngelPayIntegrationsApiError with status=undefined on a network/timeout failure', async () => {
      mockHttp.post.mockRejectedValue({ message: 'timeout of 15000ms exceeded' })

      await expect(angelPayIntegrationsApiClient.auth('any-key', 'QA')).rejects.toMatchObject({ status: undefined })
    })

    it('throws when a resolved response is not status 200 (e.g. 204 with no body)', async () => {
      mockHttp.post.mockResolvedValue({ status: 204, data: undefined })

      await expect(angelPayIntegrationsApiClient.auth('any-key', 'QA')).rejects.toThrow(AngelPayIntegrationsApiError)
    })
  })

  describe('registerWebhook()', () => {
    const params = { url: 'https://api.avoqado.io/api/v1/webhooks/angelpay/m1', events: ['send_transaction'] }

    it('creates a new endpoint and returns {endpointId, secret} when none exists yet', async () => {
      mockHttp.get.mockResolvedValue({ status: 200, data: [] })
      mockHttp.post.mockResolvedValue({
        status: 200,
        data: { id: 'ep_new', id_merchant: '990', url: params.url, secret: 'whsec_abc123', is_active: true, events: params.events },
      })

      const result = await angelPayIntegrationsApiClient.registerWebhook('token-abc', 'PROD', params)

      expect(result).toEqual({ endpointId: 'ep_new', secret: 'whsec_abc123' })
      expect(mockHttp.delete).not.toHaveBeenCalled()
      expect(mockHttp.post).toHaveBeenCalledWith(
        '/api/v1/webhooks/endpoints',
        { url: params.url, description: undefined, events: params.events },
        expect.objectContaining({ headers: { Authorization: 'Bearer token-abc' } }),
      )
    })

    it('deletes the pre-existing endpoint with the same url before creating (create-once secret constraint)', async () => {
      mockHttp.get.mockResolvedValue({ status: 200, data: [{ id: 'ep_old', url: params.url }] })
      mockHttp.delete.mockResolvedValue({ status: 204, data: {} })
      mockHttp.post.mockResolvedValue({
        status: 201,
        data: { id: 'ep_new', url: params.url, secret: 'whsec_fresh', is_active: true, events: params.events },
      })

      const result = await angelPayIntegrationsApiClient.registerWebhook('token-abc', 'PROD', params)

      expect(mockHttp.delete).toHaveBeenCalledWith(
        '/api/v1/webhooks/endpoints/ep_old',
        expect.objectContaining({ headers: { Authorization: 'Bearer token-abc' } }),
      )
      expect(result).toEqual({ endpointId: 'ep_new', secret: 'whsec_fresh' })
    })

    it('does not delete endpoints whose url differs', async () => {
      mockHttp.get.mockResolvedValue({
        status: 200,
        data: [{ id: 'ep_other', url: 'https://api.avoqado.io/api/v1/webhooks/angelpay/OTHER' }],
      })
      mockHttp.post.mockResolvedValue({ status: 201, data: { id: 'ep_new', url: params.url, secret: 'whsec_x' } })

      await angelPayIntegrationsApiClient.registerWebhook('token-abc', 'QA', params)

      expect(mockHttp.delete).not.toHaveBeenCalled()
    })

    it('throws AngelPayIntegrationsApiError when the create response is missing id/secret', async () => {
      mockHttp.get.mockResolvedValue({ status: 200, data: [] })
      mockHttp.post.mockResolvedValue({ status: 200, data: { id: 'ep_new' /* no secret */ } })

      await expect(angelPayIntegrationsApiClient.registerWebhook('token-abc', 'QA', params)).rejects.toThrow(AngelPayIntegrationsApiError)
    })

    it('propagates a network failure as AngelPayIntegrationsApiError', async () => {
      mockHttp.get.mockRejectedValue({ message: 'ECONNREFUSED' })

      await expect(angelPayIntegrationsApiClient.registerWebhook('token-abc', 'QA', params)).rejects.toThrow(AngelPayIntegrationsApiError)
    })
  })
})
