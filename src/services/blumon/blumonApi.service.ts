/**
 * Blumon API Service
 *
 * Client for interacting with Blumon payment processor API.
 *
 * **STATUS: PLACEHOLDER IMPLEMENTATION**
 *
 * This service provides stub methods for Blumon API integration.
 * Actual implementation requires:
 * 1. Blumon API documentation
 * 2. Authentication credentials (API keys, OAuth)
 * 3. Endpoint URLs for sandbox and production
 *
 * **TODO: Contact Edgardo or Blumon support for:**
 * - API documentation
 * - Sandbox credentials
 * - Endpoint URLs
 * - Authentication method (API key vs OAuth 2.0)
 *
 * @date 2025-11-05
 */

import axios, { AxiosInstance } from 'axios'
import { PrismaClient } from '@prisma/client'
import {
  BlumonTerminalConfig,
  BlumonPricingStructure,
  BlumonMerchantValidation,
  BlumonKYCRequest,
  BlumonKYCResponse,
  BlumonEnvironment,
  BlumonApiError,
} from './types'

const prisma = new PrismaClient()

/**
 * Blumon API Configuration
 *
 * TODO: Move to environment variables
 */
const BLUMON_CONFIG = {
  SANDBOX: {
    baseUrl: process.env.BLUMON_SANDBOX_URL || 'https://sandbox.blumon.com/api/v1',
    apiKey: process.env.BLUMON_SANDBOX_API_KEY || '',
  },
  PRODUCTION: {
    baseUrl: process.env.BLUMON_PROD_URL || 'https://api.blumon.com/api/v1',
    apiKey: process.env.BLUMON_PROD_API_KEY || '',
  },
}

export class BlumonApiService {
  private sandboxClient: AxiosInstance
  private productionClient: AxiosInstance

  constructor() {
    // Initialize HTTP clients for both environments
    this.sandboxClient = axios.create({
      baseURL: BLUMON_CONFIG.SANDBOX.baseUrl,
      headers: {
        'Content-Type': 'application/json',
        // TODO: Add authentication headers when API key is available
        // 'Authorization': `Bearer ${BLUMON_CONFIG.SANDBOX.apiKey}`,
      },
      timeout: 30000, // 30 seconds
    })

    this.productionClient = axios.create({
      baseURL: BLUMON_CONFIG.PRODUCTION.baseUrl,
      headers: {
        'Content-Type': 'application/json',
        // TODO: Add authentication headers
        // 'Authorization': `Bearer ${BLUMON_CONFIG.PRODUCTION.apiKey}`,
      },
      timeout: 30000,
    })
  }

  /**
   * Get HTTP client for specified environment
   */
  private getClient(environment: BlumonEnvironment): AxiosInstance {
    return environment === 'SANDBOX' ? this.sandboxClient : this.productionClient
  }

  /**
   * Get terminal configuration from Blumon API
   *
   * **TODO: IMPLEMENT WITH REAL BLUMON API**
   *
   * Expected endpoint: GET /terminals/:serialNumber
   *
   * @param serialNumber - Device serial number (e.g., "2841548417")
   * @param environment - SANDBOX or PRODUCTION
   * @returns Terminal configuration including posId, merchantId, credentials
   *
   * @example
   * ```typescript
   * const config = await blumonApi.getTerminalConfig("2841548417", "SANDBOX");
   * console.log(config.posId); // "376"
   * ```
   */
  async getTerminalConfig(serialNumber: string, environment: BlumonEnvironment = 'SANDBOX'): Promise<BlumonTerminalConfig> {
    console.log(`[BlumonAPI] Fetching config for serial: ${serialNumber} (${environment})`)

    // TODO: Replace with real API call
    // const client = this.getClient(environment);
    // const response = await client.get(`/terminals/${serialNumber}`);
    // return response.data;

    // ⚠️ PLACEHOLDER: Return mock data for development
    // REMOVE THIS when implementing real API
    return {
      serialNumber,
      posId: serialNumber === '2841548417' ? '376' : '378', // Mock data
      merchantId: `blumon_merchant_${serialNumber}`,
      status: 'ACTIVE',
      environment,
      brand: 'PAX',
      model: 'A910S',
      credentials: {
        clientId: 'mock_client_id',
        clientSecret: 'mock_client_secret',
        accessToken: 'mock_access_token',
        refreshToken: 'mock_refresh_token',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      },
    }
  }

  /**
   * Validate terminal serial number with Blumon
   *
   * **TODO: IMPLEMENT WITH REAL BLUMON API**
   *
   * Expected endpoint: POST /terminals/validate
   *
   * @param serialNumber - Device serial to validate
   * @param environment - SANDBOX or PRODUCTION
   * @returns Validation result with merchantId if valid
   */
  async validateSerial(serialNumber: string, environment: BlumonEnvironment = 'SANDBOX'): Promise<BlumonMerchantValidation> {
    console.log(`[BlumonAPI] Validating serial: ${serialNumber}`)

    // TODO: Replace with real API call
    // const client = this.getClient(environment);
    // const response = await client.post('/terminals/validate', { serialNumber });
    // return response.data;

    // ⚠️ PLACEHOLDER: Mock validation
    const knownSerials = ['2841548417', '2841548418'] // Sandbox test devices
    const valid = knownSerials.includes(serialNumber)

    return {
      valid,
      serialNumber,
      merchantId: valid ? `blumon_merchant_${serialNumber}` : undefined,
      message: valid ? 'Serial is valid and active' : 'Serial not found or inactive',
      errors: valid ? undefined : ['SERIAL_NOT_FOUND'],
    }
  }

  /**
   * Get pricing structure for a merchant
   *
   * **TODO: IMPLEMENT WITH REAL BLUMON API**
   *
   * Expected endpoint: GET /merchants/:merchantId/pricing
   *
   * @param merchantId - Blumon merchant identifier
   * @param environment - SANDBOX or PRODUCTION
   * @returns Pricing rates and fees
   */
  async getPricingStructure(merchantId: string, environment: BlumonEnvironment = 'SANDBOX'): Promise<BlumonPricingStructure> {
    console.log(`[BlumonAPI] Fetching pricing for merchant: ${merchantId}`)

    // TODO: Replace with real API call
    // const client = this.getClient(environment);
    // const response = await client.get(`/merchants/${merchantId}/pricing`);
    // return response.data;

    // ⚠️ PLACEHOLDER: Return typical Mexican payment processor rates
    return {
      merchantId,
      debitRate: 0.025, // 2.5%
      creditRate: 0.029, // 2.9%
      amexRate: 0.035, // 3.5%
      internationalRate: 0.04, // 4.0%
      fixedFeePerTransaction: 3.0, // 3.00 MXN
      monthlyFee: 500.0, // 500 MXN
      effectiveFrom: new Date(),
    }
  }

  /**
   * Submit KYC documentation to Blumon for merchant onboarding
   *
   * **TODO: IMPLEMENT WITH REAL BLUMON API**
   *
   * Expected endpoint: POST /kyc/submit
   *
   * @param kycData - Business and owner information
   * @param environment - SANDBOX or PRODUCTION
   * @returns KYC submission result
   */
  async submitKYC(kycData: BlumonKYCRequest, environment: BlumonEnvironment = 'SANDBOX'): Promise<BlumonKYCResponse> {
    console.log(`[BlumonAPI] Submitting KYC for: ${kycData.legalName}`)

    // TODO: Replace with real API call
    // const client = this.getClient(environment);
    // const response = await client.post('/kyc/submit', kycData);
    // return response.data;

    // ⚠️ PLACEHOLDER: Auto-approve in sandbox
    return {
      success: true,
      merchantId: `blumon_merchant_${Date.now()}`,
      status: environment === 'SANDBOX' ? 'APPROVED' : 'PENDING',
      message: environment === 'SANDBOX' ? 'Auto-approved in sandbox environment' : 'KYC submitted for review',
    }
  }

  /**
   * Fetch OAuth token for a merchant account
   *
   * **TODO: IMPLEMENT WITH REAL BLUMON API**
   *
   * Expected endpoint: POST /oauth/token
   *
   * @param merchantId - Blumon merchant identifier
   * @param environment - SANDBOX or PRODUCTION
   * @returns OAuth credentials
   */
  async getOAuthToken(
    merchantId: string,
    environment: BlumonEnvironment = 'SANDBOX',
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    console.log(`[BlumonAPI] Fetching OAuth token for: ${merchantId}`)

    // TODO: Replace with real OAuth flow
    // const client = this.getClient(environment);
    // const response = await client.post('/oauth/token', {
    //   grant_type: 'client_credentials',
    //   client_id: merchantId,
    //   client_secret: '...',
    // });
    // return response.data;

    // ⚠️ PLACEHOLDER: Mock token
    return {
      accessToken: `mock_access_token_${merchantId}`,
      refreshToken: `mock_refresh_token_${merchantId}`,
      expiresIn: 86400, // 24 hours
    }
  }
}

// Singleton instance
export const blumonApiService = new BlumonApiService()
