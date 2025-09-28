import logger from '@/config/logger'

interface MentaTerminal {
  id: string // Menta's UUID
  customer_id: string
  serial_code: string
  hardware_version: string
  trade_mark: string
  model: string
  status: string
  color?: string
  imei1?: string
  imei2?: string
  mode?: string
  create_date: string
  update_date: string
  features: string[]
  _links: {
    self: {
      href: string
    }
  }
}

interface MentaTerminalsResponse {
  _embedded: {
    terminals: MentaTerminal[]
  }
  _links: {
    self: {
      href: string
    }
  }
  page: {
    size: number
    total_elements: number
    total_pages: number
    number: number
  }
}

// Removed MentaAuthResponse interface - using API key authentication instead

/**
 * Service for interacting with Menta API
 * Handles authentication and terminal management
 */
export class MentaApiService {
  private static instance: MentaApiService
  private accessToken: string | null = null
  private tokenExpiry: number = 0
  private merchantApiKey: string = ''

  private readonly MENTA_API_BASE = 'https://api.menta.global'
  private readonly AUTH_ENDPOINT = '/api/v1/auth/token'
  private readonly TERMINALS_ENDPOINT = '/api/v1/terminals'

  private constructor() {
    // Use correct merchant API key from demo SDK
    this.merchantApiKey = process.env.MENTA_MERCHANT_API_KEY || 'xEMb2GMrkCNLTEgElqETWGGyFnU6WFr9sLwMII7b76oBPfQJf6TcImTkCXZs1S0P'
  }

  static getInstance(): MentaApiService {
    if (!MentaApiService.instance) {
      MentaApiService.instance = new MentaApiService()
    }
    return MentaApiService.instance
  }

  /**
   * Get valid access token (refresh if needed)
   * Uses merchant API key to get access token similar to ExternalTokenData.getExternalToken
   */
  private async getAccessToken(): Promise<string> {
    const now = Date.now()

    // Return cached token if still valid
    if (this.accessToken && now < this.tokenExpiry) {
      return this.accessToken
    }

    logger.info('🔑 Getting Menta access token using merchant API key')

    try {
      const response = await fetch(`${this.MENTA_API_BASE}${this.AUTH_ENDPOINT}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          api_key: this.merchantApiKey,
        }),
      })

      if (!response.ok) {
        const errorText = await response.text()
        logger.error(`❌ Menta auth failed: ${response.status} ${response.statusText} - ${errorText}`)
        throw new Error(`Menta auth failed: ${response.status} ${response.statusText}`)
      }

      const authData = await response.json()
      logger.info('✅ Menta auth response received:', { hasToken: !!authData.access_token, tokenType: authData.token_type })

      // Cache token with 5-minute buffer before actual expiry
      this.accessToken = authData.access_token || authData.token || ''
      this.tokenExpiry = now + ((authData.expires_in || 3600) - 300) * 1000

      logger.info('✅ Menta API access token obtained successfully')
      return this.accessToken || ''
    } catch (error) {
      logger.error('❌ Failed to get Menta access token:', error)
      throw new Error(`Failed to authenticate with Menta API: ${error}`)
    }
  }

  /**
   * Get authorization headers for API requests
   */
  private async getAuthHeaders(): Promise<{ [key: string]: string }> {
    const token = await this.getAccessToken()
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    }
  }

  /**
   * Fetch all terminals from Menta API with pagination support
   */
  async fetchTerminals(page = 0, size = 100): Promise<MentaTerminal[]> {
    try {
      const url = new URL(`${this.MENTA_API_BASE}${this.TERMINALS_ENDPOINT}`)
      url.searchParams.set('page', page.toString())
      url.searchParams.set('size', size.toString())

      logger.info(`🔍 Fetching Menta terminals: page=${page}, size=${size}`)

      const headers = await this.getAuthHeaders()
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers,
      })

      if (!response.ok) {
        throw new Error(`Menta API error: ${response.status} ${response.statusText}`)
      }

      const data: MentaTerminalsResponse = await response.json()
      logger.info(`📊 Retrieved ${data._embedded.terminals.length} terminals from Menta`)

      return data._embedded.terminals
    } catch (error) {
      logger.error('❌ Failed to fetch terminals from Menta:', error)
      throw new Error(`Failed to fetch terminals from Menta API: ${error}`)
    }
  }

  /**
   * Find a specific terminal by serial code
   * This will search through all terminals until found
   */
  async findTerminalBySerialCode(serialCode: string): Promise<MentaTerminal | null> {
    logger.info(`🔍 Searching for terminal with serial code: ${serialCode}`)

    try {
      let page = 0
      const pageSize = 100

      while (true) {
        const terminals = await this.fetchTerminals(page, pageSize)

        // Search for matching serial code in current page
        const found = terminals.find(terminal => terminal.serial_code === serialCode)

        if (found) {
          logger.info(`✅ Found terminal in Menta: ID=${found.id}, serial=${found.serial_code}`)
          return found
        }

        // If we got fewer terminals than page size, we've reached the end
        if (terminals.length < pageSize) {
          break
        }

        page++
        logger.debug(`⏭️  Searching next page: ${page}`)
      }

      logger.warn(`⚠️  Terminal not found in Menta: serial_code=${serialCode}`)
      return null
    } catch (error) {
      logger.error('❌ Error searching for terminal:', error)
      throw error
    }
  }

  /**
   * Validate that a terminal exists and is active
   */
  async validateTerminal(serialCode: string): Promise<boolean> {
    try {
      const terminal = await this.findTerminalBySerialCode(serialCode)
      return terminal !== null && terminal.status === 'ACTIVE'
    } catch (error) {
      logger.error(`❌ Error validating terminal ${serialCode}:`, error)
      return false
    }
  }

  /**
   * Get terminal details by Menta terminal ID
   */
  async getTerminalById(mentaTerminalId: string): Promise<MentaTerminal | null> {
    try {
      const headers = await this.getAuthHeaders()
      const response = await fetch(`${this.MENTA_API_BASE}${this.TERMINALS_ENDPOINT}/${mentaTerminalId}`, {
        method: 'GET',
        headers,
      })

      if (response.status === 404) {
        return null
      }

      if (!response.ok) {
        throw new Error(`Menta API error: ${response.status} ${response.statusText}`)
      }

      const terminal: MentaTerminal = await response.json()
      return terminal
    } catch (error) {
      logger.error(`❌ Error fetching terminal ${mentaTerminalId}:`, error)
      throw error
    }
  }
}

// Export singleton instance
export const mentaApiService = MentaApiService.getInstance()
