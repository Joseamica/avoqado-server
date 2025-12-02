/**
 * Blumon E-commerce Service
 *
 * Handles Blumon Hosted Checkout integration for SDK payments.
 * This is DIFFERENT from the PAX terminal SDK in blumon-tpv.service.ts
 *
 * **Flow:**
 * 1. Client creates checkout session via Avoqado SDK
 * 2. Avoqado calls Blumon Hosted Checkout API to generate payment URL
 * 3. Customer redirected to Blumon payment page
 * 4. Customer enters card details on Blumon (PCI compliant)
 * 5. Blumon processes payment and sends webhook to Avoqado
 * 6. Avoqado updates checkout session and notifies client
 *
 * **API Documentation:**
 * - Sandbox: https://sandbox-ecommerce.blumonpay.net
 * - Production: https://ecommerce.blumonpay.net
 * - Docs: https://www.blumonpay.com/documentacion/
 *
 * @module services/sdk/blumon-ecommerce
 */

import axios, { AxiosInstance } from 'axios'
import logger from '@/config/logger'
import { BadRequestError } from '@/errors/AppError'
import {
  IBlumonEcommerceService,
  BlumonTokenizeRequest,
  BlumonTokenizeResponse,
  BlumonAuthorizeRequest,
  BlumonAuthorizeResponse,
} from './blumon-ecommerce.interface'

// ═══════════════════════════════════════════════════════════════════════════
// TYPES & INTERFACES
// ═══════════════════════════════════════════════════════════════════════════

// Card Tokenization and Authorization interfaces are imported from blumon-ecommerce.interface.ts
// This allows sharing between real and mock implementations

// ═══════════════════════════════════════════════════════════════════════════
// BLUMON ECOMMERCE SERVICE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Real Blumon E-commerce Service
 * Makes actual API calls to Blumon's sandbox/production servers
 */
export class BlumonEcommerceService implements IBlumonEcommerceService {
  private client: AxiosInstance
  private baseUrl: string
  private environment: 'SANDBOX' | 'PRODUCTION'

  constructor(environment: 'SANDBOX' | 'PRODUCTION' = 'SANDBOX') {
    this.environment = environment

    // Set base URL based on environment
    this.baseUrl = environment === 'PRODUCTION' ? 'https://ecommerce.blumonpay.net' : 'https://sandbox-ecommerce.blumonpay.net'

    // Create axios instance
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000, // 30 seconds
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    })

    // Request/response interceptors for logging
    this.client.interceptors.request.use(
      config => {
        logger.debug('Blumon Ecommerce API Request', {
          method: config.method?.toUpperCase(),
          url: config.url,
          // Don't log sensitive data (API keys)
        })
        return config
      },
      error => {
        logger.error('Blumon Ecommerce API Request Error', { error: error.message })
        return Promise.reject(error)
      },
    )

    this.client.interceptors.response.use(
      response => {
        logger.debug('Blumon Ecommerce API Response', {
          status: response.status,
          url: response.config.url,
        })
        return response
      },
      error => {
        logger.error('Blumon Ecommerce API Response Error', {
          status: error.response?.status,
          url: error.config?.url,
          message: error.response?.data?.message || error.message,
        })
        return Promise.reject(error)
      },
    )
  }

  /**
   * Tokenizes a card with Blumon
   * Converts sensitive PAN data into a secure token
   *
   * @param request - Card tokenization request
   * @returns Token, masked PAN, and card brand
   */
  async tokenizeCard(request: BlumonTokenizeRequest): Promise<BlumonTokenizeResponse> {
    try {
      logger.info('🔐 Tokenizing card with Blumon', {
        environment: this.environment,
        cardLast4: request.pan.slice(-4),
      })

      // Parse customer name
      const nameParts = request.holderName.split(' ')
      const firstName = nameParts[0] || 'Customer'
      const lastName = nameParts.slice(1).join(' ') || 'Avoqado'

      // Call Blumon tokenization API
      const response = await this.client.post(
        '/cardToken/add',
        {
          pan: request.pan,
          cvv: request.cvv,
          expMonth: request.expMonth,
          expYear: request.expYear, // Must be 4 digits (e.g., "2025")
          holderName: request.holderName,
          customerInformation: {
            email: request.customerEmail || 'customer@avoqado.io',
            phone: request.customerPhone || '+525512345678',
            firstName,
            lastName,
            address1: 'Av. Revolución 1234', // Required by Blumon
            city: 'Ciudad de México', // Required by Blumon
            country: 'MX', // Required by Blumon
            postalCode: '01000', // Optional
          },
        },
        {
          headers: {
            Authorization: `Bearer ${request.accessToken}`,
          },
        },
      )

      const data = response.data

      // Check if tokenization was successful
      if (!data.status || !data.dataResponse?.id) {
        const errorDesc = data.error?.description || data.message || 'Tokenization failed'
        throw new BadRequestError(errorDesc)
      }

      // Extract card token from response
      const cardToken = data.dataResponse.id
      const maskedPan = `${request.pan.substring(0, 6)}******${request.pan.slice(-4)}`
      const cardBrand = this.detectCardBrand(request.pan)

      logger.info('✅ Card tokenized successfully', {
        token: cardToken.substring(0, 20) + '...',
        maskedPan,
        cardBrand,
      })

      return {
        token: cardToken,
        maskedPan,
        cardBrand,
      }
    } catch (error: any) {
      logger.error('❌ Card tokenization failed', {
        error: error.message,
        statusCode: error.response?.status,
        responseData: JSON.stringify(error.response?.data || {}),
        fullError: JSON.stringify({
          message: error.message,
          status: error.response?.status,
          data: error.response?.data,
          url: error.config?.url,
        }),
      })

      throw new BadRequestError(error.response?.data?.message || error.message || 'Failed to tokenize card')
    }
  }

  /**
   * Authorizes a payment using a card token
   * Uses authorization/capture flow (2-step)
   *
   * @param request - Authorization request
   * @returns Authorization details
   */
  async authorizePayment(request: BlumonAuthorizeRequest): Promise<BlumonAuthorizeResponse> {
    try {
      logger.info('💳 Charging payment with Blumon', {
        environment: this.environment,
        rawAmount: request.amount,
        amountType: typeof request.amount,
        formattedAmount: parseFloat(request.amount.toFixed(2)),
        currency: request.currency,
      })

      // Build charge request payload (Blumon official format)
      // ⚠️ IMPORTANT: Only send fields documented in Blumon API
      // orderId, reference, merchantId are NOT part of the official spec
      // ⚠️ CRITICAL: Blumon expects amount as FLOAT (number), NOT string
      // toFixed(2) returns string "10.00", we need number 10.00
      const authPayload: any = {
        amount: parseFloat(request.amount.toFixed(2)),
        currency: request.currency,
        noPresentCardData: {
          cardToken: request.cardToken,
          cvv: request.cvv,
        },
      }

      // Call Blumon charge API (official endpoint)
      const response = await this.client.post('/ecommerce/charge', authPayload, {
        headers: {
          Authorization: `Bearer ${request.accessToken}`,
        },
      })

      const data = response.data

      // Log the full Blumon response for debugging
      logger.info('📥 Blumon charge response', {
        status: data.status,
        transactionId: data.id,
        authorization: data.dataResponse?.authorization,
        description: data.dataResponse?.description,
      })

      // Blumon uses "status" field (not "success")
      if (!data.status) {
        // Properly serialize error if it's an object
        const errorMessage = typeof data.error === 'object' ? JSON.stringify(data.error) : data.error || data.message || 'Charge failed'

        logger.error('❌ Blumon charge failed', {
          errorData: JSON.stringify(data.error || {}),
          message: data.message,
          fullResponse: JSON.stringify(data),
        })

        throw new BadRequestError(errorMessage)
      }

      logger.info('✅ Payment charged successfully', {
        transactionId: data.id,
        authorizationCode: data.dataResponse?.authorization,
        description: data.dataResponse?.description,
      })

      return {
        authorizationId: data.id, // Blumon's transaction ID
        transactionId: data.id,
        status: 'APPROVED',
        authorizationCode: data.dataResponse?.authorization,
      }
    } catch (error: any) {
      logger.error('❌ Payment charge failed', {
        error: error.message,
        statusCode: error.response?.status,
        responseData: JSON.stringify(error.response?.data || {}),
        fullError: JSON.stringify({
          message: error.message,
          status: error.response?.status,
          data: error.response?.data,
          url: error.config?.url,
        }),
      })

      throw new BadRequestError(error.response?.data?.message || error.message || 'Failed to charge payment')
    }
  }

  /**
   * Helper: Detect card brand from PAN
   * @private
   */
  private detectCardBrand(pan: string): string {
    const cleaned = pan.replace(/\s/g, '')

    if (/^4/.test(cleaned)) return 'VISA'
    if (/^5[1-5]/.test(cleaned)) return 'MASTERCARD'
    if (/^3[47]/.test(cleaned)) return 'AMEX'

    return 'UNKNOWN'
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SINGLETON INSTANCES
// ═══════════════════════════════════════════════════════════════════════════

import { BlumonEcommerceMockService } from './blumon-ecommerce.service.mock'

// Singleton instances
export const blumonEcommerceSandbox = new BlumonEcommerceService('SANDBOX')
export const blumonEcommerceProduction = new BlumonEcommerceService('PRODUCTION')
export const blumonEcommerceMock = new BlumonEcommerceMockService()

/**
 * Gets the appropriate Blumon service instance
 *
 * In development, you can use mock service by setting USE_BLUMON_MOCK=true
 * This allows unlimited testing without consuming sandbox API limits.
 *
 * @param sandboxMode - Whether to use sandbox or production environment
 * @returns Blumon service instance (real or mock)
 */
export function getBlumonEcommerceService(sandboxMode: boolean): IBlumonEcommerceService {
  // Check if mock is enabled (dev/testing)
  if (process.env.USE_BLUMON_MOCK === 'true') {
    logger.info('🎭 [BLUMON] Using MOCK service (USE_BLUMON_MOCK=true)')
    return blumonEcommerceMock
  }

  // Use real Blumon API
  return sandboxMode ? blumonEcommerceSandbox : blumonEcommerceProduction
}
