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

interface MentaAuthResponse {
  access_token: string
  token_type: string
  expires_in: number
  scope: string
}

/**
 * Service for interacting with Menta API
 * Handles authentication and terminal management
 */
export class MentaApiService {
  private static instance: MentaApiService
  private accessToken: string | null = null
  private tokenExpiry: number = 0

  private readonly MENTA_API_BASE = 'https://api.menta.global'
  private readonly AUTH_ENDPOINT = '/auth/oauth/token'
  private readonly TERMINALS_ENDPOINT = '/api/v1/terminals'

  private constructor() {}

  static getInstance(): MentaApiService {
    if (!MentaApiService.instance) {
      MentaApiService.instance = new MentaApiService()
    }
    return MentaApiService.instance
  }

  /**
   * Get valid access token (refresh if needed)
   */
  private async getAccessToken(): Promise<string> {
    const now = Date.now()

    // Return cached token if still valid
    if (this.accessToken && now < this.tokenExpiry) {
      return this.accessToken
    }

    logger.info('🔑 Refreshing Menta API access token')

    try {
      // Get credentials from environment or merchant account
      const clientId = process.env.MENTA_CLIENT_ID || 'menta_demo_client'
      const clientSecret = process.env.MENTA_CLIENT_SECRET || 'menta_demo_secret'

      const response = await fetch(`${this.MENTA_API_BASE}${this.AUTH_ENDPOINT}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
        }),
      })

      if (!response.ok) {
        throw new Error(`Menta auth failed: ${response.status} ${response.statusText}`)
      }

      const authData: MentaAuthResponse = await response.json()

      // Cache token with 5-minute buffer before actual expiry
      this.accessToken = authData.access_token
      this.tokenExpiry = now + (authData.expires_in - 300) * 1000

      logger.info('✅ Menta API access token refreshed successfully')
      return this.accessToken
    } catch (error) {
      logger.error('❌ Failed to get Menta access token:', error)
      throw new Error(`Failed to authenticate with Menta API: ${error}`)
    }
  }

  /**
   * Fetch all terminals from Menta API with pagination support
   */
  async fetchTerminals(page = 0, size = 100): Promise<MentaTerminal[]> {
    try {
      const token = await this.getAccessToken()
      const url = new URL(`${this.MENTA_API_BASE}${this.TERMINALS_ENDPOINT}`)
      url.searchParams.set('page', page.toString())
      url.searchParams.set('size', size.toString())

      logger.info(`🔍 Fetching Menta terminals: page=${page}, size=${size}`)

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
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
      const token = await this.getAccessToken()
      const response = await fetch(`${this.MENTA_API_BASE}${this.TERMINALS_ENDPOINT}/${mentaTerminalId}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
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
