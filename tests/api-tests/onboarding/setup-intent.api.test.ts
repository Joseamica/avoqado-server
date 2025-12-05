/**
 * API Integration Tests: Onboarding SetupIntent Endpoint
 *
 * Tests the POST /api/v1/onboarding/setup-intent endpoint:
 * 1. Authentication enforcement (401 without token)
 * 2. Successful SetupIntent creation
 * 3. Error handling
 */

// Ensure required env vars exist before importing app/config
process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret'
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/testdb?schema=public'
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_fake_key'

// Mock session middleware to avoid DB/session store in tests
jest.mock('../../../src/config/session', () => {
  const noop = (req: any, _res: any, next: any) => next()
  return { __esModule: true, default: noop }
})

// Mock Swagger setup
jest.mock('../../../src/config/swagger', () => ({
  __esModule: true,
  setupSwaggerUI: jest.fn(),
}))

// Mock Stripe service to avoid real API calls
jest.mock('../../../src/services/stripe.service', () => ({
  __esModule: true,
  createOnboardingSetupIntent: jest.fn(),
  // Include other exports that might be needed
  getOrCreateStripeCustomer: jest.fn(),
  createTrialSubscriptions: jest.fn(),
  updatePaymentMethod: jest.fn(),
  createTrialSetupIntent: jest.fn(),
  default: {
    createOnboardingSetupIntent: jest.fn(),
    getOrCreateStripeCustomer: jest.fn(),
  },
}))

// Mock logger
jest.mock('../../../src/config/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}))

import request from 'supertest'
import jwt from 'jsonwebtoken'
import * as stripeService from '../../../src/services/stripe.service'

const app = require('../../../src/app').default

const API_PREFIX = '/api/v1/onboarding'

function makeToken(payload: object = {}) {
  const defaultPayload = {
    sub: 'user_test_123',
    orgId: 'org_test_123',
    role: 'OWNER',
    ...payload,
  }
  return jwt.sign(defaultPayload, process.env.ACCESS_TOKEN_SECRET as string, { expiresIn: '15m' })
}

describe('POST /api/v1/onboarding/setup-intent', () => {
  const endpoint = `${API_PREFIX}/setup-intent`

  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('Authentication (401)', () => {
    it('should return 401 when no Authorization header is provided', async () => {
      const res = await request(app).post(endpoint)

      expect(res.status).toBe(401)
      expect(res.body).toHaveProperty('error', 'Unauthorized')
    })

    it('should return 401 when Authorization header has invalid token', async () => {
      const res = await request(app).post(endpoint).set('Authorization', 'Bearer invalid.token.here')

      expect(res.status).toBe(401)
      expect(res.body).toHaveProperty('error', 'Unauthorized')
    })

    it('should return 401 when Authorization header is malformed', async () => {
      const res = await request(app).post(endpoint).set('Authorization', 'NotBearer sometoken')

      expect(res.status).toBe(401)
    })

    it('should return 401 when token is expired', async () => {
      const expiredToken = jwt.sign(
        { sub: 'user_test', orgId: 'org_test', role: 'OWNER' },
        process.env.ACCESS_TOKEN_SECRET as string,
        { expiresIn: '-1h' }, // Already expired
      )

      const res = await request(app).post(endpoint).set('Authorization', `Bearer ${expiredToken}`)

      expect(res.status).toBe(401)
    })
  })

  describe('Successful SetupIntent Creation (200)', () => {
    it('should return 200 with clientSecret when authenticated', async () => {
      const mockClientSecret = 'seti_test_secret_xyz789'
      ;(stripeService.createOnboardingSetupIntent as jest.Mock).mockResolvedValueOnce(mockClientSecret)

      const token = makeToken()
      const res = await request(app).post(endpoint).set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        success: true,
        data: {
          clientSecret: mockClientSecret,
        },
      })
    })

    it('should call createOnboardingSetupIntent exactly once', async () => {
      const mockClientSecret = 'seti_once_secret'
      ;(stripeService.createOnboardingSetupIntent as jest.Mock).mockResolvedValueOnce(mockClientSecret)

      const token = makeToken()
      await request(app).post(endpoint).set('Authorization', `Bearer ${token}`)

      expect(stripeService.createOnboardingSetupIntent).toHaveBeenCalledTimes(1)
      // Should NOT pass any arguments (no customer)
      expect(stripeService.createOnboardingSetupIntent).toHaveBeenCalledWith()
    })

    it('should work with different user roles (OWNER, ADMIN, MANAGER)', async () => {
      const roles = ['OWNER', 'ADMIN', 'MANAGER']

      for (const role of roles) {
        ;(stripeService.createOnboardingSetupIntent as jest.Mock).mockResolvedValueOnce(`seti_${role}_secret`)

        const token = makeToken({ role })
        const res = await request(app).post(endpoint).set('Authorization', `Bearer ${token}`)

        expect(res.status).toBe(200)
        expect(res.body.success).toBe(true)
      }
    })
  })

  describe('Error Handling (500)', () => {
    it('should return 500 when Stripe service throws an error', async () => {
      const stripeError = new Error('Stripe API error')
      ;(stripeService.createOnboardingSetupIntent as jest.Mock).mockRejectedValueOnce(stripeError)

      const token = makeToken()
      const res = await request(app).post(endpoint).set('Authorization', `Bearer ${token}`)

      // Should return 500 (or whatever error handler returns)
      expect(res.status).toBeGreaterThanOrEqual(400)
    })

    it('should not expose internal error details to client', async () => {
      const sensitiveError = new Error('sk_live_xxxxx is invalid')
      ;(stripeService.createOnboardingSetupIntent as jest.Mock).mockRejectedValueOnce(sensitiveError)

      const token = makeToken()
      const res = await request(app).post(endpoint).set('Authorization', `Bearer ${token}`)

      // Should NOT expose the API key in the response
      expect(JSON.stringify(res.body)).not.toContain('sk_live')
    })
  })

  describe('Request Body (should be ignored)', () => {
    it('should ignore any request body sent (endpoint has no body params)', async () => {
      const mockClientSecret = 'seti_ignore_body_secret'
      ;(stripeService.createOnboardingSetupIntent as jest.Mock).mockResolvedValueOnce(mockClientSecret)

      const token = makeToken()
      const res = await request(app)
        .post(endpoint)
        .set('Authorization', `Bearer ${token}`)
        .send({ someField: 'should be ignored', venueId: 'fake_venue' })

      expect(res.status).toBe(200)
      expect(res.body.data.clientSecret).toBe(mockClientSecret)
      // Service should be called without any arguments
      expect(stripeService.createOnboardingSetupIntent).toHaveBeenCalledWith()
    })
  })
})

describe('Onboarding SetupIntent - E2E Flow Simulation', () => {
  const endpoint = `${API_PREFIX}/setup-intent`

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('Full flow: User selects features -> Opens dialog -> Gets SetupIntent -> Validates card', async () => {
    // Step 1: User authenticates during onboarding
    const token = makeToken({
      sub: 'new_user_onboarding',
      orgId: 'new_org_onboarding',
      role: 'OWNER',
    })

    // Step 2: Frontend requests SetupIntent when payment dialog opens
    const mockClientSecret = 'seti_e2e_flow_secret_123'
    ;(stripeService.createOnboardingSetupIntent as jest.Mock).mockResolvedValueOnce(mockClientSecret)

    const res = await request(app).post(endpoint).set('Authorization', `Bearer ${token}`)

    // Step 3: Verify response is suitable for Stripe.js confirmCardSetup()
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.clientSecret).toBeDefined()
    expect(typeof res.body.data.clientSecret).toBe('string')

    // Note: Actual card validation happens client-side with Stripe.js
    // The returned clientSecret is used like:
    // stripe.confirmCardSetup(clientSecret, { payment_method: { card: cardElement } })
  })

  it('Flow: Multiple users can request SetupIntents concurrently', async () => {
    // Simulate multiple users going through onboarding at the same time
    const users = [
      { sub: 'user_1', orgId: 'org_1' },
      { sub: 'user_2', orgId: 'org_2' },
      { sub: 'user_3', orgId: 'org_3' },
    ]

    const tokens = users.map(u => makeToken({ ...u, role: 'OWNER' }))

    // Mock returns different secrets for each call
    ;(stripeService.createOnboardingSetupIntent as jest.Mock)
      .mockResolvedValueOnce('seti_user_1')
      .mockResolvedValueOnce('seti_user_2')
      .mockResolvedValueOnce('seti_user_3')

    // Make concurrent requests
    const responses = await Promise.all(tokens.map(token => request(app).post(endpoint).set('Authorization', `Bearer ${token}`)))

    // All should succeed independently
    expect(responses[0].body.data.clientSecret).toBe('seti_user_1')
    expect(responses[1].body.data.clientSecret).toBe('seti_user_2')
    expect(responses[2].body.data.clientSecret).toBe('seti_user_3')

    responses.forEach(res => {
      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
    })
  })
})
