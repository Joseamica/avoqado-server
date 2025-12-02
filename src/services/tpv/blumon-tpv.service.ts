/**
 * Blumon Payment Service
 *
 * Handles OAuth authentication and key management for Blumon PAX payment terminals.
 *
 * **Architecture:**
 * - OAuth Flow: 3-step process (Token → RSA Keys → DUKPT Keys)
 * - Environment Support: Sandbox and Production
 * - Security: AES-256-CBC encryption for stored credentials
 *
 * **API Endpoints:**
 * - Token Server: https://sandbox-tokener.blumonpay.net
 * - Core Server: https://sandbox-core.blumonpay.net
 *
 * @author Avoqado Team
 * @date 2025-01-30
 */

import logger from '@/config/logger'
import axios, { AxiosInstance } from 'axios'
import crypto from 'crypto'

// ═══════════════════════════════════════════════════════════════════════════
// TYPES & INTERFACES
// ═══════════════════════════════════════════════════════════════════════════

export interface BlumonCredentials {
  oauthAccessToken: string
  oauthRefreshToken: string
  oauthExpiresAt: string // ISO 8601
  rsaId: number
  rsaKey: string // Hex-encoded RSA public key
  dukptKsn?: string // Key Serial Number (optional - may not exist yet)
  dukptKey?: string // Base Derivation Key (optional - may not exist yet)
  dukptKeyCrc32?: string
  dukptKeyCheckValue?: string
}

export interface BlumonMerchantInfo {
  posId: string // Position ID (from JWT userId)
  serialNumber: string
  brand: string
  model: string
  credentials: BlumonCredentials
  dukptKeysAvailable: boolean // Indicates if DUKPT keys were successfully fetched
}

interface OAuthTokenResponse {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
  scope: string
  userId: number // ⭐ This is the posId
  business: number
  corporation: number
}

interface RSAKeysResponse {
  status: boolean
  requestId: string
  dataResponse: {
    rsaId: number
    rsa: string // Hex-encoded RSA public key
  }
}

interface DUKPTKeysResponse {
  status: boolean
  requestId: string
  dataResponse: {
    ksn: string
    key: string
    keyCrc32: string
    keyCheckValue: string
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BLUMON SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class BlumonTpvService {
  private tokenServerUrl: string
  private coreServerUrl: string
  private clientId = 'blumon_pay_core_api'
  private clientSecret = 'blumon_pay_core_api_password'

  private tokenClient: AxiosInstance
  private coreClient: AxiosInstance

  constructor(environment: 'SANDBOX' | 'PRODUCTION' = 'SANDBOX') {
    // Set base URLs based on environment
    this.tokenServerUrl = environment === 'PRODUCTION' ? 'https://tokener.blumonpay.net' : 'https://sandbox-tokener.blumonpay.net'

    this.coreServerUrl = environment === 'PRODUCTION' ? 'https://core.blumonpay.net' : 'https://sandbox-core.blumonpay.net'

    // Create axios instances
    this.tokenClient = axios.create({
      baseURL: this.tokenServerUrl,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    })

    this.coreClient = axios.create({
      baseURL: this.coreServerUrl,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
      },
    })

    logger.info(`[BlumonTpvService] Initialized for ${environment}`, {
      tokenServer: this.tokenServerUrl,
      coreServer: this.coreServerUrl,
    })
  }

  // ═════════════════════════════════════════════════════════════════════════
  // STEP 1: OAUTH TOKEN
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * Calculate Blumon OAuth password
   *
   * Formula: SHA256(serialNumber + brand + model)
   *
   * @param serialNumber Device serial (e.g., "2841548417")
   * @param brand Device brand (e.g., "PAX")
   * @param model Device model (e.g., "A910S")
   * @returns SHA-256 hash (64-character hex string)
   *
   * @example
   * calculatePassword("2841548417", "PAX", "A910S")
   * // Returns: "83b2cfa2865156653d1dd0a3b7f14cdae0667394084cf3c821f8a6d1424cdf4f"
   */
  private calculatePassword(serialNumber: string, brand: string, model: string): string {
    const input = `${serialNumber}${brand}${model}`
    return crypto.createHash('sha256').update(input).digest('hex')
  }

  /**
   * Get OAuth access token from Blumon Token Server
   *
   * **Endpoint:** POST /oauth/token
   * **Auth:** Basic Auth (clientId:clientSecret)
   * **Grant Type:** password
   *
   * @param serialNumber Device serial number
   * @param brand Device brand (PAX, Verifone, etc.)
   * @param model Device model (A910S, etc.)
   * @returns Access token, refresh token, and posId
   *
   * @throws Error if authentication fails
   */
  async getAccessToken(
    serialNumber: string,
    brand: string,
    model: string,
  ): Promise<{ accessToken: string; refreshToken: string; posId: string; expiresAt: string }> {
    try {
      const password = this.calculatePassword(serialNumber, brand, model)
      const authHeader = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')

      logger.info('[BlumonTpvService] Fetching OAuth token', {
        serialNumber,
        brand,
        model,
      })

      const response = await this.tokenClient.post<OAuthTokenResponse>(
        '/oauth/token',
        new URLSearchParams({
          grant_type: 'password',
          username: serialNumber,
          password: password,
        }).toString(),
        {
          headers: {
            Authorization: `Basic ${authHeader}`,
          },
        },
      )

      const data = response.data
      const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString()

      logger.info('[BlumonTpvService] OAuth token obtained successfully', {
        posId: data.userId.toString(),
        expiresIn: data.expires_in,
      })

      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        posId: data.userId.toString(), // ⭐ userId from JWT is the posId
        expiresAt,
      }
    } catch (error: any) {
      logger.error('[BlumonTpvService] OAuth token fetch failed', {
        error: error.response?.data || error.message,
        serialNumber,
      })
      throw new Error(`Failed to authenticate with Blumon: ${error.response?.data?.error_description || error.message}`)
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // STEP 2: RSA KEYS
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * Get RSA encryption keys from Blumon Core Server
   *
   * **Endpoint:** POST /device/getKey
   * **Auth:** Bearer token
   * **Purpose:** RSA public key for encrypting DUKPT key requests
   *
   * @param accessToken OAuth access token from step 1
   * @param posId Position ID (from OAuth JWT userId)
   * @returns RSA key ID and hex-encoded public key
   *
   * @throws Error if RSA key fetch fails
   */
  async getRSAKeys(accessToken: string, posId: string): Promise<{ rsaId: number; rsaKey: string }> {
    try {
      logger.info('[BlumonTpvService] Fetching RSA keys', { posId })

      const response = await this.coreClient.post<RSAKeysResponse>(
        '/device/getKey',
        { posId: parseInt(posId, 10) }, // ⚠️ CRITICAL: posId must be integer
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      )

      if (!response.data.status) {
        throw new Error('Blumon API returned status: false')
      }

      const { rsaId, rsa } = response.data.dataResponse

      logger.info('[BlumonTpvService] RSA keys obtained successfully', {
        rsaId,
        rsaKeyLength: rsa.length,
      })

      return { rsaId, rsaKey: rsa }
    } catch (error: any) {
      logger.error('[BlumonTpvService] RSA keys fetch failed', {
        error: error.response?.data || error.message,
        posId,
      })
      throw new Error(`Failed to fetch RSA keys: ${error.response?.data?.error?.description || error.message}`)
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // STEP 3: DUKPT KEYS
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * Initialize DUKPT keys from Blumon Core Server
   *
   * **Endpoint:** POST /device/initDukptKeys
   * **Auth:** Bearer token
   * **Purpose:** Download DUKPT encryption keys for card data encryption
   *
   * DUKPT (Derived Unique Key Per Transaction):
   * - KSN: Key Serial Number (unique identifier)
   * - BDK: Base Derivation Key (master key for transaction keys)
   *
   * @param accessToken OAuth access token from step 1
   * @param posId Position ID
   * @param rsaKey RSA public key from step 2
   * @returns DUKPT KSN, BDK, and validation values
   *
   * @throws Error if DUKPT key initialization fails
   */
  async getDUKPTKeys(
    accessToken: string,
    posId: string,
    rsaKey: string,
  ): Promise<{
    ksn: string
    key: string
    keyCrc32: string
    keyCheckValue: string
  }> {
    try {
      logger.info('[BlumonTpvService] Initializing DUKPT keys', { posId })

      const response = await this.coreClient.post<DUKPTKeysResponse>(
        '/device/initDukptKeys',
        {
          posId: parseInt(posId, 10), // ⚠️ CRITICAL: posId must be integer
          rsa: rsaKey,
          checkValue: '',
          crc32: '',
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      )

      if (!response.data.status) {
        logger.error('[BlumonTpvService] DUKPT API returned status false', {
          fullResponse: response.data,
        })
        throw new Error(`Blumon API returned status: false - ${JSON.stringify(response.data)}`)
      }

      const { ksn, key, keyCrc32, keyCheckValue } = response.data.dataResponse

      logger.info('[BlumonTpvService] DUKPT keys initialized successfully', {
        ksnLength: ksn.length,
        keyLength: key.length,
      })

      return {
        ksn,
        key,
        keyCrc32,
        keyCheckValue,
      }
    } catch (error: any) {
      logger.error('[BlumonTpvService] DUKPT keys initialization failed', {
        error: error.response?.data || error.message,
        posId,
      })
      throw new Error(`Failed to initialize DUKPT keys: ${error.response?.data?.error?.description || error.message}`)
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // COMPLETE AUTO-FETCH FLOW
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * Complete auto-fetch flow: OAuth → RSA → DUKPT
   *
   * **Usage:**
   * Superadmin provides only serialNumber, brand, model.
   * Backend automatically fetches all credentials from Blumon.
   *
   * @param serialNumber Device serial (e.g., "2841548417")
   * @param brand Device brand (e.g., "PAX")
   * @param model Device model (e.g., "A910S")
   * @returns Complete merchant info with encrypted credentials
   *
   * @example
   * const info = await blumonService.fetchMerchantCredentials("2841548417", "PAX", "A910S")
   * // Returns: { posId: "376", credentials: { oauthAccessToken, rsaKey, dukptKsn, ... } }
   */
  async fetchMerchantCredentials(serialNumber: string, brand: string, model: string): Promise<BlumonMerchantInfo> {
    try {
      logger.info('[BlumonTpvService] Starting complete auto-fetch flow', {
        serialNumber,
        brand,
        model,
      })

      // STEP 1: OAuth Token
      const { accessToken, refreshToken, posId, expiresAt } = await this.getAccessToken(serialNumber, brand, model)

      // STEP 2: RSA Keys
      const { rsaId, rsaKey } = await this.getRSAKeys(accessToken, posId)

      // STEP 3: DUKPT Keys (optional - may not be initialized yet)
      let dukptKeysAvailable = false
      let dukptData: { ksn?: string; key?: string; keyCrc32?: string; keyCheckValue?: string } = {}

      try {
        const { ksn, key, keyCrc32, keyCheckValue } = await this.getDUKPTKeys(accessToken, posId, rsaKey)
        dukptData = { ksn, key, keyCrc32, keyCheckValue }
        dukptKeysAvailable = true
        logger.info('[BlumonTpvService] DUKPT keys fetched successfully')
      } catch (error: any) {
        logger.warn('[BlumonTpvService] DUKPT keys not available (will be initialized on first payment)', {
          error: error.message,
          serialNumber,
        })
        // Continue without DUKPT keys - they'll be initialized by SDK on first payment
      }

      const credentials: BlumonCredentials = {
        oauthAccessToken: accessToken,
        oauthRefreshToken: refreshToken,
        oauthExpiresAt: expiresAt,
        rsaId,
        rsaKey,
        ...(dukptKeysAvailable && {
          dukptKsn: dukptData.ksn,
          dukptKey: dukptData.key,
          dukptKeyCrc32: dukptData.keyCrc32,
          dukptKeyCheckValue: dukptData.keyCheckValue,
        }),
      }

      logger.info('[BlumonTpvService] Auto-fetch completed successfully', {
        serialNumber,
        posId,
        dukptKeysAvailable,
      })

      return {
        posId,
        serialNumber,
        brand,
        model,
        credentials,
        dukptKeysAvailable,
      }
    } catch (error: any) {
      logger.error('[BlumonTpvService] Auto-fetch failed', {
        error: error.message,
        serialNumber,
      })
      throw error
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // TOKEN REFRESH (FUTURE)
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * Refresh expired OAuth token
   *
   * ⚠️ TODO: Implement when refresh token endpoint is documented
   *
   * @param refreshToken OAuth refresh token
   * @returns New access token and expiry
   */
  async refreshAccessToken(refreshToken: string): Promise<{
    accessToken: string
    expiresAt: string
  }> {
    throw new Error('Token refresh not implemented yet - awaiting Blumon API documentation')
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SINGLETON EXPORT
// ═══════════════════════════════════════════════════════════════════════════

// Export singleton instances for both environments
export const blumonTpvServiceSandbox = new BlumonTpvService('SANDBOX')
export const blumonTpvServiceProduction = new BlumonTpvService('PRODUCTION')

// Export factory function for custom environment
export function createBlumonTpvService(environment: 'SANDBOX' | 'PRODUCTION'): BlumonTpvService {
  return new BlumonTpvService(environment)
}
