/**
 * Blumon API Types
 *
 * TypeScript interfaces for Blumon payment processor integration.
 *
 * **IMPORTANT: These are placeholder types**
 * Actual API response structure needs to be confirmed with Blumon documentation.
 *
 * @see Contact Edgardo or Blumon support for official API documentation
 * @date 2025-11-05
 */

/**
 * Blumon environment types
 */
export type BlumonEnvironment = 'SANDBOX' | 'PRODUCTION'

/**
 * Terminal configuration response from Blumon API
 *
 * TODO: Verify structure with actual Blumon API documentation
 */
export interface BlumonTerminalConfig {
  serialNumber: string // Device serial (e.g., "2841548417")
  posId: string // Momentum API posId (e.g., "376")
  merchantId: string // Blumon merchant identifier
  status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED'
  environment: BlumonEnvironment

  // Device information
  brand?: string // e.g., "PAX"
  model?: string // e.g., "A910S"

  // OAuth credentials (if provided by API)
  credentials?: {
    clientId?: string
    clientSecret?: string
    accessToken?: string
    refreshToken?: string
    expiresAt?: string
  }

  // DUKPT keys (if provided by API)
  dukptKeys?: {
    ksn?: string // Key Serial Number
    ipek?: string // Initial PIN Encryption Key
  }
}

/**
 * Merchant pricing structure from Blumon
 *
 * TODO: Verify pricing model with Blumon documentation
 */
export interface BlumonPricingStructure {
  merchantId: string

  // Transaction rates (what Blumon charges Avoqado)
  debitRate: number // e.g., 0.015 (1.5%)
  creditRate: number // e.g., 0.025 (2.5%)
  amexRate: number // e.g., 0.035 (3.5%)
  internationalRate: number // e.g., 0.040 (4.0%)

  // Fixed fees
  fixedFeePerTransaction: number // e.g., 0.50 MXN
  monthlyFee?: number // e.g., 500 MXN

  // Effective period
  effectiveFrom: Date
  effectiveTo?: Date
}

/**
 * Merchant validation response
 */
export interface BlumonMerchantValidation {
  valid: boolean
  serialNumber: string
  merchantId?: string
  message?: string
  errors?: string[]
}

/**
 * KYC submission request to Blumon
 *
 * TODO: Verify required fields with Blumon onboarding API
 */
export interface BlumonKYCRequest {
  // Business information
  legalName: string
  rfc: string // Mexican tax ID
  businessType: 'INDIVIDUAL' | 'CORPORATION' | 'LLC'

  // Contact information
  email: string
  phone: string
  address: {
    street: string
    city: string
    state: string
    postalCode: string
    country: string
  }

  // Bank account
  clabe: string // 18-digit CLABE number
  bankName: string
  accountHolder: string

  // Documents (URLs to uploaded files)
  documents?: {
    identificacion?: string // Government ID
    comprobanteDomicilio?: string // Proof of address
    actaConstitutiva?: string // Articles of incorporation (corporations)
    constanciaFiscal?: string // Tax document
  }
}

/**
 * KYC submission response
 */
export interface BlumonKYCResponse {
  success: boolean
  merchantId?: string
  status: 'PENDING' | 'APPROVED' | 'REJECTED'
  message?: string
  errors?: string[]
}

/**
 * API Error response
 */
export interface BlumonApiError {
  code: string
  message: string
  details?: any
}
