/**
 * Blumon E-commerce Mock Service
 *
 * Simulates Blumon API responses for development and testing.
 * Allows unlimited testing without consuming sandbox rate limits.
 *
 * **Test Card Numbers**:
 * - `4111111111111111` (VISA) - Success
 * - `5555555555554444` (Mastercard) - Success
 * - `378282246310005` (AMEX) - Success
 * - `4000000000000002` (VISA) - Card declined
 * - `4000000000009995` (VISA) - Insufficient funds
 * - `4000000000000069` (VISA) - Expired card
 * - `4000000000000127` (VISA) - Invalid CVV
 * - `5100000000000016` (Mastercard) - Monthly limit exceeded (TX_003)
 * - `4242424242424242` (VISA) - Transaction limit exceeded (TX_001)
 *
 * **Usage**:
 * Set `USE_BLUMON_MOCK=true` in .env to enable mock service
 *
 * @module services/sdk/blumon-ecommerce.mock
 */

import logger from '@/config/logger'
import { BadRequestError } from '@/errors/AppError'
import {
  IBlumonEcommerceService,
  BlumonTokenizeRequest,
  BlumonTokenizeResponse,
  BlumonAuthorizeRequest,
  BlumonAuthorizeResponse,
} from './blumon-ecommerce.interface'

/**
 * Helper: Simulate network delay
 */
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Test scenarios based on card numbers
 */
interface TestScenario {
  success: boolean
  error?: {
    code: string
    description: string
    httpStatusCode: number
  }
  tokenSuffix?: string
}

const TEST_SCENARIOS: Record<string, TestScenario> = {
  // ✅ SUCCESS SCENARIOS
  '4111111111111111': {
    success: true,
    tokenSuffix: 'visa_success',
  },
  '5555555555554444': {
    success: true,
    tokenSuffix: 'mc_success',
  },
  '378282246310005': {
    success: true,
    tokenSuffix: 'amex_success',
  },

  // ❌ ERROR SCENARIOS
  '4000000000000002': {
    success: false,
    error: {
      code: 'CARD_DECLINED',
      description: 'LA TARJETA FUE RECHAZADA',
      httpStatusCode: 400,
    },
  },
  '4000000000009995': {
    success: false,
    error: {
      code: 'INSUFFICIENT_FUNDS',
      description: 'FONDOS INSUFICIENTES',
      httpStatusCode: 400,
    },
  },
  '4000000000000069': {
    success: false,
    error: {
      code: 'EXPIRED_CARD',
      description: 'LA TARJETA HA EXPIRADO',
      httpStatusCode: 400,
    },
  },
  '4000000000000127': {
    success: false,
    error: {
      code: 'INVALID_CVV',
      description: 'EL CVV ES INVÁLIDO',
      httpStatusCode: 400,
    },
  },
  '5100000000000016': {
    success: false,
    error: {
      code: 'TX_003',
      description: 'LA TRANSACCIÓN EXCEDE EL MONTO MENSUAL PERMITIDO',
      httpStatusCode: 409,
    },
  },
  '4242424242424242': {
    success: false,
    error: {
      code: 'TX_001',
      description: 'LA TRANSACCIÓN EXCEDE EL MONTO PERMITIDO',
      httpStatusCode: 409,
    },
  },
}

/**
 * Blumon E-commerce Mock Service
 *
 * Simulates Blumon API behavior for development and testing.
 */
export class BlumonEcommerceMockService implements IBlumonEcommerceService {
  /**
   * Mock card tokenization
   *
   * @param request - Tokenization request
   * @returns Mocked tokenization response
   */
  async tokenizeCard(request: BlumonTokenizeRequest): Promise<BlumonTokenizeResponse> {
    logger.info('🔐 [MOCK] Tokenizing card', {
      cardLast4: request.pan.slice(-4),
      cardBrand: this.detectCardBrand(request.pan),
    })

    // Simulate API delay (500-800ms like real Blumon)
    await sleep(500 + Math.random() * 300)

    // Get test scenario for this card
    const scenario = TEST_SCENARIOS[request.pan] || TEST_SCENARIOS['4111111111111111']

    // Simulate tokenization failure
    if (!scenario.success && scenario.error) {
      logger.error('❌ [MOCK] Card tokenization failed', {
        cardLast4: request.pan.slice(-4),
        errorCode: scenario.error.code,
        description: scenario.error.description,
      })

      // Throw error matching Blumon API format
      throw new BadRequestError(scenario.error.description)
    }

    // Generate mock token
    const token = `mock_tok_${scenario.tokenSuffix}_${Date.now()}_${Math.random().toString(36).substring(7)}`
    const maskedPan = `${request.pan.substring(0, 6)}******${request.pan.slice(-4)}`
    const cardBrand = this.detectCardBrand(request.pan)

    logger.info('✅ [MOCK] Card tokenized successfully', {
      token: token.substring(0, 25) + '...',
      maskedPan,
      cardBrand,
    })

    return {
      token,
      maskedPan,
      cardBrand,
    }
  }

  /**
   * Mock payment authorization
   *
   * @param request - Authorization request
   * @returns Mocked authorization response
   */
  async authorizePayment(request: BlumonAuthorizeRequest): Promise<BlumonAuthorizeResponse> {
    logger.info('💳 [MOCK] Authorizing payment', {
      amount: request.amount,
      currency: request.currency,
      orderId: request.orderId,
      cardToken: request.cardToken.substring(0, 25) + '...',
    })

    // Simulate API delay (600-1000ms like real Blumon)
    await sleep(600 + Math.random() * 400)

    // Simulate authorization failures based on amount
    if (request.amount > 10000) {
      const error = {
        httpStatusCode: 409,
        code: 'TX_001',
        description: 'LA TRANSACCIÓN EXCEDE EL MONTO PERMITIDO',
        binInformation: {
          bin: '411111',
          bank: 'DEFAULT',
          product: 'DEFAULT',
          type: 'DEFAULT',
          brand: 'VISA',
        },
      }

      logger.error('❌ [MOCK] Payment authorization failed', {
        orderId: request.orderId,
        errorCode: error.code,
        description: error.description,
      })

      throw new BadRequestError(JSON.stringify(error))
    }

    // Check if token indicates a failing scenario
    if (request.cardToken.includes('card_declined')) {
      const error = {
        httpStatusCode: 400,
        code: 'CARD_DECLINED',
        description: 'LA TARJETA FUE RECHAZADA',
        binInformation: {
          bin: '400000',
          bank: 'DEFAULT',
          product: 'DEFAULT',
          type: 'DEBIT',
          brand: 'VISA',
        },
      }

      logger.error('❌ [MOCK] Payment authorization failed', {
        orderId: request.orderId,
        errorCode: error.code,
      })

      throw new BadRequestError(JSON.stringify(error))
    }

    // Generate mock authorization response
    const authorizationId = `mock_auth_${Date.now()}_${Math.random().toString(36).substring(7)}`
    const transactionId = `mock_tx_${Date.now()}_${Math.random().toString(36).substring(7)}`
    const authorizationCode = Math.floor(100000 + Math.random() * 900000).toString()

    logger.info('✅ [MOCK] Payment authorized successfully', {
      authorizationId,
      transactionId,
      authorizationCode,
      orderId: request.orderId,
    })

    return {
      authorizationId,
      transactionId,
      status: 'APPROVED',
      authorizationCode,
    }
  }

  /**
   * Detect card brand from PAN
   *
   * @param pan - Card number
   * @returns Card brand
   */
  private detectCardBrand(pan: string): string {
    const firstDigit = pan.charAt(0)
    const firstTwoDigits = pan.substring(0, 2)

    if (firstDigit === '4') {
      return 'VISA'
    } else if (parseInt(firstTwoDigits) >= 51 && parseInt(firstTwoDigits) <= 55) {
      return 'MASTERCARD'
    } else if (firstTwoDigits === '34' || firstTwoDigits === '37') {
      return 'AMEX'
    }

    return 'UNKNOWN'
  }
}
