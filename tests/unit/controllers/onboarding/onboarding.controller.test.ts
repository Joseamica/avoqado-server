/**
 * Onboarding Controller Tests
 *
 * Tests for onboarding-specific endpoints:
 * 1. createSetupIntent - Creates Stripe SetupIntent for card validation during onboarding
 */

import { Request, Response, NextFunction } from 'express'
import { createSetupIntent } from '../../../../src/controllers/onboarding.controller'
import * as stripeService from '../../../../src/services/stripe.service'

// Mock Stripe service
jest.mock('../../../../src/services/stripe.service', () => ({
  __esModule: true,
  createOnboardingSetupIntent: jest.fn(),
}))

// Mock logger
jest.mock('../../../../src/config/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}))

describe('Onboarding Controller', () => {
  let mockRequest: Partial<Request>
  let mockResponse: Partial<Response>
  let mockNext: NextFunction

  beforeEach(() => {
    jest.clearAllMocks()

    mockRequest = {
      authContext: {
        userId: 'user_123',
        orgId: 'org_123',
        venueId: '', // Empty during onboarding - venue doesn't exist yet
        role: 'OWNER',
      },
    }

    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    }

    mockNext = jest.fn()
  })

  describe('POST /api/v1/onboarding/setup-intent', () => {
    describe('createSetupIntent()', () => {
      it('should create SetupIntent and return client secret', async () => {
        const mockClientSecret = 'seti_test_secret_123'
        ;(stripeService.createOnboardingSetupIntent as jest.Mock).mockResolvedValueOnce(mockClientSecret)

        await createSetupIntent(mockRequest as Request, mockResponse as Response, mockNext)

        expect(stripeService.createOnboardingSetupIntent).toHaveBeenCalledTimes(1)
        expect(mockResponse.status).toHaveBeenCalledWith(200)
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: true,
          data: {
            clientSecret: mockClientSecret,
          },
        })
        expect(mockNext).not.toHaveBeenCalled()
      })

      it('should call next with error when Stripe service fails', async () => {
        const mockError = new Error('Stripe API error')
        ;(stripeService.createOnboardingSetupIntent as jest.Mock).mockRejectedValueOnce(mockError)

        await createSetupIntent(mockRequest as Request, mockResponse as Response, mockNext)

        expect(stripeService.createOnboardingSetupIntent).toHaveBeenCalledTimes(1)
        expect(mockNext).toHaveBeenCalledWith(mockError)
        expect(mockResponse.status).not.toHaveBeenCalled()
        expect(mockResponse.json).not.toHaveBeenCalled()
      })

      it('should handle rate limiting errors from Stripe', async () => {
        const rateLimitError = new Error('Rate limit exceeded')
        ;(rateLimitError as any).type = 'rate_limit_error'
        ;(stripeService.createOnboardingSetupIntent as jest.Mock).mockRejectedValueOnce(rateLimitError)

        await createSetupIntent(mockRequest as Request, mockResponse as Response, mockNext)

        expect(mockNext).toHaveBeenCalledWith(rateLimitError)
      })

      it('should handle invalid API key errors from Stripe', async () => {
        const authError = new Error('Invalid API key')
        ;(authError as any).type = 'authentication_error'
        ;(stripeService.createOnboardingSetupIntent as jest.Mock).mockRejectedValueOnce(authError)

        await createSetupIntent(mockRequest as Request, mockResponse as Response, mockNext)

        expect(mockNext).toHaveBeenCalledWith(authError)
      })

      it('should work without authContext (though route requires auth)', async () => {
        // The endpoint requires auth middleware, but controller doesn't use authContext
        // This test verifies the controller doesn't crash if authContext is missing
        const requestWithoutAuth: Partial<Request> = {}
        const mockClientSecret = 'seti_no_auth_secret'
        ;(stripeService.createOnboardingSetupIntent as jest.Mock).mockResolvedValueOnce(mockClientSecret)

        await createSetupIntent(requestWithoutAuth as Request, mockResponse as Response, mockNext)

        expect(mockResponse.status).toHaveBeenCalledWith(200)
        expect(mockResponse.json).toHaveBeenCalledWith({
          success: true,
          data: { clientSecret: mockClientSecret },
        })
      })
    })
  })
})

describe('Onboarding SetupIntent - Integration Scenarios', () => {
  let mockRequest: Partial<Request>
  let mockResponse: Partial<Response>
  let mockNext: NextFunction

  beforeEach(() => {
    jest.clearAllMocks()

    mockRequest = {
      authContext: {
        userId: 'user_integration_test',
        orgId: 'org_integration_test',
        venueId: '', // Empty during onboarding
        role: 'OWNER',
      },
    }

    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    }

    mockNext = jest.fn()
  })

  describe('Onboarding Flow Scenarios', () => {
    it('Scenario 1: User selects features, gets SetupIntent for card validation', async () => {
      // Simulates: User selected CHATBOT + ANALYTICS, dialog opens, needs SetupIntent
      const mockClientSecret = 'seti_features_selected_secret'
      ;(stripeService.createOnboardingSetupIntent as jest.Mock).mockResolvedValueOnce(mockClientSecret)

      await createSetupIntent(mockRequest as Request, mockResponse as Response, mockNext)

      // Frontend will use this clientSecret with Stripe.js to validate card
      expect(mockResponse.json).toHaveBeenCalledWith({
        success: true,
        data: { clientSecret: mockClientSecret },
      })
    })

    it('Scenario 2: Multiple SetupIntent requests (user reopens dialog)', async () => {
      // User might close and reopen the payment dialog multiple times
      // Each time a new SetupIntent should be created
      const secrets = ['seti_first', 'seti_second', 'seti_third']

      for (const secret of secrets) {
        ;(stripeService.createOnboardingSetupIntent as jest.Mock).mockResolvedValueOnce(secret)

        await createSetupIntent(mockRequest as Request, mockResponse as Response, mockNext)

        expect(mockResponse.json).toHaveBeenCalledWith({
          success: true,
          data: { clientSecret: secret },
        })
      }

      expect(stripeService.createOnboardingSetupIntent).toHaveBeenCalledTimes(3)
    })

    it('Scenario 3: Stripe temporarily unavailable, should propagate error', async () => {
      // Stripe has occasional outages - frontend should handle gracefully
      const stripeDownError = new Error('Stripe service temporarily unavailable')
      ;(stripeDownError as any).type = 'api_connection_error'
      ;(stripeService.createOnboardingSetupIntent as jest.Mock).mockRejectedValueOnce(stripeDownError)

      await createSetupIntent(mockRequest as Request, mockResponse as Response, mockNext)

      // Error should be passed to error handler middleware
      expect(mockNext).toHaveBeenCalledWith(stripeDownError)
      // Response should NOT have been sent
      expect(mockResponse.status).not.toHaveBeenCalled()
    })
  })
})
