/**
 * Blumon Authentication Service
 *
 * Handles OAuth 2.0 authentication for Blumon e-commerce API.
 *
 * **Documentation**: https://www.blumonpay.com/documentacion/
 *
 * **Authentication Flow**:
 * 1. Hash password with SHA-256
 * 2. Send OAuth 2.0 password grant request
 * 3. Receive access token (valid for 3 hours)
 * 4. Use token in Bearer header for API requests
 *
 * **Sandbox Environment**:
 * - Token Endpoint: https://sandbox-tokener.blumonpay.net/oauth/token
 * - Portal Registration: https://sandbox-atom.blumonpay.net/
 * - Availability: Monday-Friday, 8:00 AM - 2:00 AM
 *
 * @module services/blumon/blumonAuth
 */

import axios, { AxiosInstance } from 'axios'
import crypto from 'crypto'
import logger from '@/config/logger'
import { BadRequestError } from '@/errors/AppError'

// ═══════════════════════════════════════════════════════════════════════════
// TYPES & INTERFACES
// ═══════════════════════════════════════════════════════════════════════════

export interface BlumonAuthCredentials {
  username: string // User's email address
  password: string // Plain text password (will be hashed)
}

export interface BlumonTokenResponse {
  access_token: string
  token_type: 'Bearer'
  expires_in: number // Seconds (10800 = 3 hours)
  refresh_token?: string
  scope?: string
}

export interface BlumonAuthResult {
  accessToken: string
  tokenType: string
  expiresIn: number
  expiresAt: Date // Calculated expiration timestamp
  refreshToken?: string
}

// ═══════════════════════════════════════════════════════════════════════════
// BLUMON AUTH SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class BlumonAuthService {
  private sandboxClient: AxiosInstance
  private productionClient: AxiosInstance

  // Fixed Basic Auth credentials for Blumon API
  private readonly BASIC_AUTH_USERNAME = 'blumon_pay_ecommerce_api'
  private readonly BASIC_AUTH_PASSWORD = 'blumon_pay_ecommerce_api_password'

  // Token endpoints
  private readonly SANDBOX_TOKEN_URL = 'https://sandbox-tokener.blumonpay.net/oauth/token'
  private readonly PRODUCTION_TOKEN_URL = 'https://tokener.blumonpay.net/oauth/token' // TODO: Verify production URL

  constructor() {
    // Sandbox client
    this.sandboxClient = axios.create({
      baseURL: this.SANDBOX_TOKEN_URL,
      timeout: 30000, // 30 seconds
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    })

    // Production client
    this.productionClient = axios.create({
      baseURL: this.PRODUCTION_TOKEN_URL,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    })

    // Add request/response interceptors for logging
    this.setupInterceptors(this.sandboxClient, 'SANDBOX')
    this.setupInterceptors(this.productionClient, 'PRODUCTION')
  }

  /**
   * Setup axios interceptors for logging
   */
  private setupInterceptors(client: AxiosInstance, environment: string) {
    client.interceptors.request.use(
      config => {
        logger.debug(`[Blumon Auth ${environment}] Request`, {
          method: config.method?.toUpperCase(),
          url: config.url,
        })
        return config
      },
      error => {
        logger.error(`[Blumon Auth ${environment}] Request Error`, { error: error.message })
        return Promise.reject(error)
      },
    )

    client.interceptors.response.use(
      response => {
        logger.debug(`[Blumon Auth ${environment}] Response`, {
          status: response.status,
        })
        return response
      },
      error => {
        logger.error(`[Blumon Auth ${environment}] Response Error`, {
          status: error.response?.status,
          message: error.response?.data?.error_description || error.message,
        })
        return Promise.reject(error)
      },
    )
  }

  /**
   * Hash password with SHA-256 (required by Blumon)
   *
   * @param plainPassword - Plain text password
   * @returns SHA-256 hex-encoded password
   */
  private hashPassword(plainPassword: string): string {
    return crypto.createHash('sha256').update(plainPassword, 'utf8').digest('hex')
  }

  /**
   * Generate Basic Auth header
   *
   * @returns Base64-encoded Basic Auth string
   */
  private getBasicAuthHeader(): string {
    const credentials = `${this.BASIC_AUTH_USERNAME}:${this.BASIC_AUTH_PASSWORD}`
    return `Basic ${Buffer.from(credentials).toString('base64')}`
  }

  /**
   * Authenticate with Blumon using master credentials
   *
   * **OAuth 2.0 Password Grant Flow**
   *
   * @param credentials - User email and password
   * @param sandboxMode - Use sandbox (true) or production (false)
   * @returns Access token and metadata
   *
   * @example
   * ```typescript
   * const result = await blumonAuth.authenticate({
   *   username: 'jose@avoqado.io',
   *   password: 'Exitosoy777:)'
   * }, true);
   *
   * console.log(result.accessToken); // Use in Bearer header
   * console.log(result.expiresAt); // Token expiration time
   * ```
   */
  async authenticate(credentials: BlumonAuthCredentials, sandboxMode: boolean = true): Promise<BlumonAuthResult> {
    try {
      const client = sandboxMode ? this.sandboxClient : this.productionClient
      const environment = sandboxMode ? 'SANDBOX' : 'PRODUCTION'

      logger.info(`[Blumon Auth] Authenticating user in ${environment}`, {
        username: credentials.username,
      })

      // Hash password with SHA-256
      const hashedPassword = this.hashPassword(credentials.password)

      // Prepare OAuth 2.0 password grant request
      const requestBody = new URLSearchParams({
        grant_type: 'password',
        username: credentials.username,
        password: hashedPassword,
      })

      // Make authentication request
      const response = await client.post<BlumonTokenResponse>('', requestBody.toString(), {
        headers: {
          Authorization: this.getBasicAuthHeader(),
        },
      })

      const data = response.data

      // Validate response
      if (!data.access_token) {
        throw new BadRequestError('Invalid response from Blumon: missing access_token')
      }

      // Calculate expiration timestamp
      const expiresAt = new Date(Date.now() + data.expires_in * 1000)

      logger.info(`[Blumon Auth] Authentication successful`, {
        username: credentials.username,
        expiresIn: data.expires_in,
        expiresAt: expiresAt.toISOString(),
      })

      return {
        accessToken: data.access_token,
        tokenType: data.token_type,
        expiresIn: data.expires_in,
        expiresAt,
        refreshToken: data.refresh_token,
      }
    } catch (error: any) {
      logger.error('[Blumon Auth] Authentication failed', {
        error: error.message,
        username: credentials.username,
        statusCode: error.response?.status,
        errorData: error.response?.data,
      })

      // Extract error message from Blumon response
      const errorMessage =
        error.response?.data?.error_description || error.response?.data?.error || error.message || 'Authentication failed'

      throw new BadRequestError(`Blumon authentication failed: ${errorMessage}`)
    }
  }

  /**
   * Refresh an expired access token
   *
   * @param refreshToken - Refresh token from previous authentication
   * @param sandboxMode - Use sandbox (true) or production (false)
   * @returns New access token
   */
  async refreshToken(refreshToken: string, sandboxMode: boolean = true): Promise<BlumonAuthResult> {
    try {
      const client = sandboxMode ? this.sandboxClient : this.productionClient
      const environment = sandboxMode ? 'SANDBOX' : 'PRODUCTION'

      logger.info(`[Blumon Auth] Refreshing token in ${environment}`)

      const requestBody = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      })

      const response = await client.post<BlumonTokenResponse>('', requestBody.toString(), {
        headers: {
          Authorization: this.getBasicAuthHeader(),
        },
      })

      const data = response.data

      if (!data.access_token) {
        throw new BadRequestError('Invalid response from Blumon: missing access_token')
      }

      const expiresAt = new Date(Date.now() + data.expires_in * 1000)

      logger.info(`[Blumon Auth] Token refreshed successfully`, {
        expiresAt: expiresAt.toISOString(),
      })

      return {
        accessToken: data.access_token,
        tokenType: data.token_type,
        expiresIn: data.expires_in,
        expiresAt,
        refreshToken: data.refresh_token,
      }
    } catch (error: any) {
      logger.error('[Blumon Auth] Token refresh failed', {
        error: error.message,
        statusCode: error.response?.status,
        errorData: error.response?.data,
      })

      const errorMessage = error.response?.data?.error_description || error.response?.data?.error || error.message || 'Token refresh failed'

      throw new BadRequestError(`Blumon token refresh failed: ${errorMessage}`)
    }
  }

  /**
   * Check if access token is expired or will expire soon
   *
   * @param expiresAt - Token expiration timestamp
   * @param bufferMinutes - Consider expired if within this many minutes (default: 5)
   * @returns True if token is expired or expiring soon
   */
  isTokenExpired(expiresAt: Date, bufferMinutes: number = 5): boolean {
    const now = new Date()
    const bufferMs = bufferMinutes * 60 * 1000
    const expirationWithBuffer = new Date(expiresAt.getTime() - bufferMs)

    return now >= expirationWithBuffer
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════════════════

export const blumonAuthService = new BlumonAuthService()
