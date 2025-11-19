/**
 * Blumon E-commerce Service Interface
 *
 * This interface defines the contract that both the real Blumon service
 * and the mock service must implement. This allows seamless switching
 * between real API calls and mocked responses for development.
 */

export interface BlumonTokenizeRequest {
  accessToken: string
  pan: string // Card number (no spaces)
  cvv: string
  expMonth: string // Expiration month (MM)
  expYear: string // Expiration year (YYYY - 4 digits)
  holderName: string // Cardholder name
  customerEmail?: string // Customer email (optional)
  customerPhone?: string // Customer phone (optional)
}

export interface BlumonTokenizeResponse {
  token: string // Card token
  maskedPan: string // e.g., "411111******1111"
  cardBrand: string // "VISA" | "MASTERCARD" | "AMEX"
}

export interface BlumonAuthorizeRequest {
  accessToken: string
  amount: number // Transaction amount
  currency: string // Currency code (e.g., "484" for MXN)
  cardToken: string // Token from tokenization
  cvv: string // CVV still required by Blumon
  orderId: string // Unique order/session ID
}

export interface BlumonAuthorizeResponse {
  authorizationId: string // Blumon authorization ID
  transactionId: string // Blumon transaction ID
  status: string // Payment status
  authorizationCode?: string // Authorization code (if approved)
}

/**
 * Blumon E-commerce Service Interface
 *
 * Implemented by:
 * - BlumonEcommerceService (real API calls)
 * - BlumonEcommerceMockService (mocked responses for dev/testing)
 */
export interface IBlumonEcommerceService {
  /**
   * Tokenize a credit/debit card
   *
   * Converts sensitive card data (PAN, CVV) into a secure token
   * that can be used for payment authorization.
   *
   * @param request - Card tokenization request
   * @returns Card token and metadata
   * @throws BadRequestError if tokenization fails
   */
  tokenizeCard(request: BlumonTokenizeRequest): Promise<BlumonTokenizeResponse>

  /**
   * Authorize a payment using a card token
   *
   * Charges the customer's card using the previously tokenized card.
   *
   * @param request - Payment authorization request
   * @returns Authorization result with transaction IDs
   * @throws BadRequestError if authorization fails
   */
  authorizePayment(request: BlumonAuthorizeRequest): Promise<BlumonAuthorizeResponse>
}
