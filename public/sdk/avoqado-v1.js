/**
 * Avoqado Payment SDK v1.0
 *
 * A Stripe-like JavaScript SDK for accepting payments with Avoqado.
 * Merchants embed this script in their website to process payments via Blumon.
 *
 * **Usage:**
 * ```html
 * <script src="https://sdk.avoqado.com/v1/avoqado-v1.js"></script>
 * <script>
 *   const avoqado = Avoqado('pk_test_abc123xyz') // or pk_live_...
 *
 *   // Create checkout session
 *   avoqado.checkout.create({
 *     amount: 100.50,
 *     currency: 'MXN',
 *     description: 'Premium Plan Subscription',
 *     customerEmail: 'customer@example.com',
 *     successUrl: 'https://yoursite.com/success',
 *     cancelUrl: 'https://yoursite.com/cancel'
 *   }).then(session => {
 *     // Redirect to Blumon checkout
 *     window.location.href = session.checkoutUrl
 *   }).catch(error => {
 *     console.error('Payment error:', error)
 *   })
 * </script>
 * ```
 *
 * @version 1.0.0
 * @author Avoqado Team
 * @license MIT
 */

;(function (window) {
  'use strict'

  // ═══════════════════════════════════════════════════════════════════════════
  // CONFIGURATION
  // ═══════════════════════════════════════════════════════════════════════════

  const API_BASE_URL = 'https://api.avoqado.com/api/v1/sdk'
  const SDK_VERSION = '1.0.0'

  // ═══════════════════════════════════════════════════════════════════════════
  // MAIN AVOQADO CLASS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Creates an Avoqado SDK instance
   * @param {string} publishableKey - Public API key (pk_live_xxx or pk_test_xxx)
   * @param {object} options - Optional configuration
   */
  function Avoqado(publishableKey, options = {}) {
    // Validate API key
    if (!publishableKey || typeof publishableKey !== 'string') {
      throw new Error('Avoqado: publishableKey is required')
    }

    if (!publishableKey.startsWith('pk_live_') && !publishableKey.startsWith('pk_test_')) {
      throw new Error('Avoqado: publishableKey must start with pk_live_ or pk_test_')
    }

    // Store configuration
    const config = {
      publishableKey,
      apiBaseUrl: options.apiBaseUrl || API_BASE_URL,
      locale: options.locale || 'es-MX',
    }

    // ═════════════════════════════════════════════════════════════════════════
    // HELPER FUNCTIONS
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Makes an authenticated API request
     * @private
     */
    async function apiRequest(endpoint, method = 'GET', body = null) {
      const url = `${config.apiBaseUrl}${endpoint}`

      const headers = {
        Authorization: `Bearer ${config.publishableKey}`,
        'Content-Type': 'application/json',
        'X-Avoqado-SDK-Version': SDK_VERSION,
      }

      const options = {
        method,
        headers,
      }

      if (body && method !== 'GET') {
        options.body = JSON.stringify(body)
      }

      try {
        const response = await fetch(url, options)

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}))
          throw new Error(errorData.message || `API error: ${response.status}`)
        }

        return await response.json()
      } catch (error) {
        throw new Error(`Avoqado API error: ${error.message}`)
      }
    }

    /**
     * Validates required fields in an object
     * @private
     */
    function validateRequired(obj, requiredFields) {
      for (const field of requiredFields) {
        if (!obj[field]) {
          throw new Error(`Avoqado: ${field} is required`)
        }
      }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // CHECKOUT API
    // ═════════════════════════════════════════════════════════════════════════

    const checkout = {
      /**
       * Creates a new checkout session
       *
       * @param {object} params
       * @param {number} params.amount - Amount in MXN (e.g., 100.50)
       * @param {string} params.successUrl - URL to redirect on success
       * @param {string} params.cancelUrl - URL to redirect on cancel
       * @param {string} [params.currency='MXN'] - Currency code
       * @param {string} [params.description] - Payment description
       * @param {string} [params.customerEmail] - Customer email
       * @param {string} [params.customerPhone] - Customer phone
       * @param {string} [params.customerName] - Customer name
       * @param {string} [params.externalOrderId] - Your internal order ID
       * @param {object} [params.metadata] - Custom metadata
       * @returns {Promise<object>} Checkout session with checkoutUrl
       */
      create: async function (params) {
        // Validate required fields
        validateRequired(params, ['amount', 'successUrl', 'cancelUrl'])

        // Validate amount
        if (typeof params.amount !== 'number' || params.amount <= 0) {
          throw new Error('Avoqado: amount must be a positive number')
        }

        // Build request body
        const body = {
          amount: params.amount,
          currency: params.currency || 'MXN',
          description: params.description,
          customerEmail: params.customerEmail,
          customerPhone: params.customerPhone,
          customerName: params.customerName,
          externalOrderId: params.externalOrderId,
          metadata: params.metadata,
          successUrl: params.successUrl,
          cancelUrl: params.cancelUrl,
        }

        // Make API request
        const session = await apiRequest('/checkout/sessions', 'POST', body)

        return {
          id: session.id,
          sessionId: session.sessionId,
          checkoutUrl: session.checkoutUrl,
          status: session.status,
          amount: session.amount,
          currency: session.currency,
          expiresAt: session.expiresAt,
        }
      },

      /**
       * Retrieves a checkout session by ID
       *
       * @param {string} sessionId - Checkout session ID (cs_avoqado_xxx or cs_test_xxx)
       * @returns {Promise<object>} Checkout session details
       */
      retrieve: async function (sessionId) {
        if (!sessionId || typeof sessionId !== 'string') {
          throw new Error('Avoqado: sessionId is required')
        }

        const session = await apiRequest(`/checkout/sessions/${sessionId}`, 'GET')

        return session
      },

      /**
       * Redirects the current page to the checkout URL
       * Convenience method to create session and redirect in one call
       *
       * @param {object} params - Same as checkout.create()
       */
      redirectToCheckout: async function (params) {
        const session = await this.create(params)

        // Redirect to checkout URL
        window.location.href = session.checkoutUrl
      },
    }

    // ═════════════════════════════════════════════════════════════════════════
    // RETURN PUBLIC API
    // ═════════════════════════════════════════════════════════════════════════

    return {
      checkout,
      _config: config, // Exposed for debugging only
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EXPORT TO WINDOW
  // ═══════════════════════════════════════════════════════════════════════════

  // Export as global
  window.Avoqado = Avoqado

  // UMD support
  if (typeof define === 'function' && define.amd) {
    define(function () {
      return Avoqado
    })
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = Avoqado
  }
})(window)

/**
 * EXAMPLE USAGE:
 *
 * 1. Basic checkout redirect:
 *
 * ```html
 * <button id="checkout-btn">Pay $100.50 MXN</button>
 * <script>
 *   const avoqado = Avoqado('pk_test_abc123xyz')
 *
 *   document.getElementById('checkout-btn').addEventListener('click', async () => {
 *     try {
 *       await avoqado.checkout.redirectToCheckout({
 *         amount: 100.50,
 *         description: 'Premium Subscription',
 *         customerEmail: 'customer@example.com',
 *         successUrl: window.location.origin + '/success',
 *         cancelUrl: window.location.origin + '/cancel'
 *       })
 *     } catch (error) {
 *       alert('Error: ' + error.message)
 *     }
 *   })
 * </script>
 * ```
 *
 * 2. Create session and handle manually:
 *
 * ```javascript
 * const session = await avoqado.checkout.create({
 *   amount: 250.00,
 *   customerEmail: 'customer@example.com',
 *   externalOrderId: 'order_12345',
 *   metadata: { userId: '123', plan: 'premium' },
 *   successUrl: 'https://yoursite.com/success',
 *   cancelUrl: 'https://yoursite.com/cancel'
 * })
 *
 * console.log('Session created:', session.sessionId)
 * console.log('Checkout URL:', session.checkoutUrl)
 *
 * // Redirect manually
 * window.location.href = session.checkoutUrl
 * ```
 *
 * 3. Retrieve session status (on return from checkout):
 *
 * ```javascript
 * // On success page, get session ID from URL query param
 * const urlParams = new URLSearchParams(window.location.search)
 * const sessionId = urlParams.get('session_id')
 *
 * if (sessionId) {
 *   const session = await avoqado.checkout.retrieve(sessionId)
 *
 *   if (session.status === 'COMPLETED') {
 *     console.log('Payment successful!', session)
 *   } else {
 *     console.log('Payment not completed:', session.status)
 *   }
 * }
 * ```
 */
