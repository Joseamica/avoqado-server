/**
 * B4Bit Crypto Payment Types
 *
 * Types for the B4Bit crypto payment gateway integration.
 * Documentation: https://dev-pay.b4bit.com/docs
 */

/**
 * B4Bit API Environment Configuration
 *
 * DEV:  baseUrl=https://dev-payments.b4bit.com, loginUrl=https://dev-pay.b4bit.com
 * PROD: baseUrl=https://pos.b4bit.com, loginUrl=https://pay.b4bit.com
 */
/**
 * Global B4Bit config (from environment - shared across all venues)
 */
export interface B4BitGlobalConfig {
  baseUrl: string // API server (dev-payments.b4bit.com or pos.b4bit.com)
  loginUrl: string // Frontend/login server (dev-pay.b4bit.com or pay.b4bit.com)
  username: string // B4Bit account email
  password: string // B4Bit account password
}

/**
 * Per-venue B4Bit device config (from database)
 */
export interface B4BitVenueConfig {
  deviceId: string // Device identifier (API Key UUID)
  secretKey?: string | null // Webhook secret key
}

/**
 * @deprecated Use B4BitGlobalConfig + B4BitVenueConfig instead
 */
export interface B4BitConfig {
  baseUrl: string
  loginUrl: string
  username: string
  password: string
  deviceId: string
  webhookSecret?: string
}

/**
 * Request to create a crypto payment order
 */
export interface B4BitCreateOrderRequest {
  fiat_amount: number // Amount in fiat currency (e.g., 55.00 MXN)
  fiat_currency: string // "MXN", "USD", etc.
  crypto_symbol?: string // Optional: specific crypto (e.g., "BTC", "ETH", "USDC")
  identifier?: string // Our internal reference (payment ID)
  success_url?: string // Redirect URL on success
  fail_url?: string // Redirect URL on failure
  notify_merchant_url?: string // Webhook URL for status updates
}

/**
 * Response from B4Bit order creation
 */
export interface B4BitCreateOrderResponse {
  success: boolean
  data?: {
    request_id: string // B4Bit unique identifier for this order
    payment_url: string // URL where customer pays (generate QR from this)
    crypto_address?: string // Wallet address if direct payment
    crypto_amount?: string // Amount in crypto (e.g., "0.00123")
    crypto_symbol?: string // Crypto currency symbol
    expires_at: string // ISO timestamp when order expires
    expires_in_seconds: number // Seconds until expiration
  }
  error?: {
    code: string
    message: string
  }
}

/**
 * B4Bit webhook payload for payment status updates
 */
export interface B4BitWebhookPayload {
  // Payment identification
  identifier: string // B4Bit's internal UUID for this order
  reference: string // Our internal payment ID (what we passed when creating the order)
  request_id?: string // B4Bit request ID (same as identifier)

  // Amounts
  fiat_amount: number // Amount in fiat (e.g., 55.00)
  fiat_currency: string // "MXN"
  crypto_amount: string // Amount paid in crypto (e.g., "0.00123")
  currency: string // Crypto currency (e.g., "BTC", "ETH")

  // Confirmation tracking
  unconfirmed_amount?: string // Amount detected but not yet confirmed
  confirmed_amount?: string // Amount with blockchain confirmations

  // Status
  status: B4BitPaymentStatus

  // Transaction details
  tx_hash?: string // Blockchain transaction hash
  block_number?: number // Block number when confirmed
  confirmations?: number // Number of blockchain confirmations

  // Metadata
  timestamp?: string // ISO timestamp of the webhook
}

/**
 * B4Bit Payment Status Codes
 */
export type B4BitPaymentStatus =
  | 'PE' // Pending - Waiting for payment
  | 'AC' // Awaiting Completion - Payment detected, waiting for confirmations
  | 'CO' // Completed - Payment confirmed
  | 'OC' // Out of Condition - Insufficient amount or other issue
  | 'EX' // Expired - Order timed out without payment

/**
 * Human-readable status descriptions
 */
export const B4BitStatusDescriptions: Record<B4BitPaymentStatus, string> = {
  PE: 'Esperando pago',
  AC: 'Pago detectado, esperando confirmaciones',
  CO: 'Pago confirmado',
  OC: 'Monto insuficiente o fuera de condiciones',
  EX: 'Orden expirada sin pago',
}

/**
 * Supported cryptocurrencies by B4Bit
 */
export const B4BitSupportedCryptos = [
  'BTC', // Bitcoin
  'BTCL', // Bitcoin Lightning
  'ETH', // Ethereum
  'USDT', // Tether (multiple chains)
  'USDC', // USD Coin (multiple chains)
  'DAI', // DAI Stablecoin
  'SOL', // Solana
  'AVAX', // Avalanche
  'XRP', // Ripple
  'TRX', // Tron
  'ALGO', // Algorand
  'DASH', // Dash
  'BCH', // Bitcoin Cash
] as const

export type B4BitCrypto = (typeof B4BitSupportedCryptos)[number]

/**
 * Internal types for our system
 */

export interface InitiateCryptoPaymentParams {
  venueId: string
  orgId: string
  amount: number // In centavos (e.g., 5500 = $55.00 MXN)
  tip?: number // In centavos
  staffId: string
  shiftId?: string
  orderId?: string
  orderNumber?: string
  deviceSerialNumber?: string
  rating?: number
}

export interface InitiateCryptoPaymentResult {
  success: boolean
  requestId: string // B4Bit request ID for tracking
  paymentId: string // Our internal payment ID
  paymentUrl: string // URL for QR code
  expiresAt: string // ISO timestamp
  expiresInSeconds: number
  cryptoSymbol?: string
  cryptoAddress?: string
}

export interface ProcessWebhookResult {
  success: boolean
  action: 'CONFIRMED' | 'AWAITING_CONFIRMATION' | 'FAILED' | 'EXPIRED' | 'NOT_FOUND' | 'ERROR'
  message: string
  paymentId?: string
  details?: {
    status: B4BitPaymentStatus
    cryptoAmount?: string
    cryptoCurrency?: string
    txHash?: string
    confirmations?: number
  }
}
