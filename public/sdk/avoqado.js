/**
 * Avoqado Checkout SDK
 *
 * Embeddable payment checkout for Avoqado merchants.
 * Handles card tokenization and payment processing securely.
 *
 * Usage:
 * ```html
 * <script src="https://checkout.avoqado.io/sdk/avoqado.js"></script>
 * <script>
 *   const checkout = new AvoqadoCheckout({
 *     sessionId: 'cs_avoqado_xxx',
 *     amount: 100.00,
 *     currency: 'MXN',
 *     onSuccess: (result) => {
 *       console.log('Payment successful!', result);
 *       window.location.href = '/success';
 *     },
 *     onError: (error) => {
 *       console.error('Payment failed:', error);
 *       alert('Payment failed: ' + error.message);
 *     },
 *     onCancel: () => {
 *       console.log('Payment cancelled');
 *     }
 *   });
 *
 *   checkout.mount('#payment-container');
 * </script>
 * ```
 *
 * @version 1.0.0
 * @license MIT
 */

;(function (window) {
  'use strict'

  /**
   * Configuration defaults
   */
  const DEFAULTS = {
    baseUrl: window.location.origin, // Auto-detect base URL
    checkoutPath: '/checkout/payment.html',
    locale: 'es-MX',
    theme: 'light',
    height: '600px',
    width: '100%',
  }

  /**
   * AvoqadoCheckout Class
   *
   * @class AvoqadoCheckout
   * @param {Object} config - Checkout configuration
   * @param {string} config.sessionId - Checkout session ID (required)
   * @param {number} config.amount - Payment amount (required)
   * @param {string} config.currency - Currency code (default: MXN)
   * @param {Function} config.onSuccess - Success callback
   * @param {Function} config.onError - Error callback
   * @param {Function} config.onCancel - Cancel callback
   * @param {string} config.locale - Locale (default: es-MX)
   * @param {string} config.theme - Theme (light/dark)
   * @param {string} config.height - Iframe height
   * @param {string} config.width - Iframe width
   */
  function AvoqadoCheckout(config) {
    // Validate required fields
    if (!config.sessionId) {
      throw new Error('[Avoqado SDK] sessionId is required')
    }
    if (!config.amount || config.amount <= 0) {
      throw new Error('[Avoqado SDK] amount must be greater than 0')
    }

    // Merge config with defaults
    this.config = Object.assign({}, DEFAULTS, config)

    // State
    this.iframe = null
    this.container = null
    this.mounted = false

    // Bind methods
    this._handleMessage = this._handleMessage.bind(this)
    this._handleResize = this._handleResize.bind(this)

    console.log('[Avoqado SDK] Initialized', {
      sessionId: this.config.sessionId,
      amount: this.config.amount,
      currency: this.config.currency,
    })
  }

  /**
   * Mount checkout iframe to a DOM element
   *
   * @param {string|HTMLElement} elementOrSelector - DOM element or CSS selector
   */
  AvoqadoCheckout.prototype.mount = function (elementOrSelector) {
    try {
      // Get container element
      const container = typeof elementOrSelector === 'string' ? document.querySelector(elementOrSelector) : elementOrSelector

      if (!container) {
        throw new Error('[Avoqado SDK] Container element not found: ' + elementOrSelector)
      }

      this.container = container

      // Create iframe
      this._createIframe()

      // Add event listeners
      window.addEventListener('message', this._handleMessage)
      window.addEventListener('resize', this._handleResize)

      this.mounted = true
      console.log('[Avoqado SDK] Checkout mounted')
    } catch (error) {
      console.error('[Avoqado SDK] Mount failed:', error)
      if (this.config.onError) {
        this.config.onError(error)
      }
    }
  }

  /**
   * Unmount checkout iframe
   */
  AvoqadoCheckout.prototype.unmount = function () {
    if (!this.mounted) return

    // Remove iframe
    if (this.iframe && this.iframe.parentNode) {
      this.iframe.parentNode.removeChild(this.iframe)
    }

    // Remove event listeners
    window.removeEventListener('message', this._handleMessage)
    window.removeEventListener('resize', this._handleResize)

    // Reset state
    this.iframe = null
    this.container = null
    this.mounted = false

    console.log('[Avoqado SDK] Checkout unmounted')
  }

  /**
   * Create and configure iframe
   * @private
   */
  AvoqadoCheckout.prototype._createIframe = function () {
    // Build checkout URL
    const params = new URLSearchParams({
      sessionId: this.config.sessionId,
      amount: this.config.amount,
      currency: this.config.currency || 'MXN',
      locale: this.config.locale,
      theme: this.config.theme,
    })

    const checkoutUrl = this.config.baseUrl + this.config.checkoutPath + '?' + params.toString()

    // Create iframe element
    const iframe = document.createElement('iframe')
    iframe.src = checkoutUrl
    iframe.style.width = this.config.width
    iframe.style.height = this.config.height
    iframe.style.border = 'none'
    iframe.style.borderRadius = '8px'
    iframe.style.overflow = 'hidden'
    iframe.setAttribute('allow', 'payment') // Payment Request API
    // Security: allow-scripts + allow-same-origin is required for:
    // - allow-scripts: Run payment.js
    // - allow-same-origin: Fetch /sdk/tokenize endpoint
    // - allow-forms: Submit payment form
    // Trade-off: This combination allows iframe to escape sandbox, but acceptable because:
    // 1. Iframe content (/checkout/payment.html) is from same trusted domain
    // 2. Alternative would be separate subdomain (checkout.avoqado.io) for production
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms')

    // Append to container
    this.container.appendChild(iframe)
    this.iframe = iframe

    console.log('[Avoqado SDK] Iframe created:', checkoutUrl)
  }

  /**
   * Handle postMessage events from iframe
   * @private
   */
  AvoqadoCheckout.prototype._handleMessage = function (event) {
    // Verify origin (security check)
    const allowedOrigins = [this.config.baseUrl, window.location.origin]

    if (!allowedOrigins.includes(event.origin)) {
      console.warn('[Avoqado SDK] Ignored message from untrusted origin:', event.origin)
      return
    }

    const data = event.data

    // Ignore messages without type field (browser events, extensions, etc.)
    if (!data || typeof data !== 'object' || !data.type) {
      return
    }

    // Handle different message types
    switch (data.type) {
      case 'payment.success':
        console.log('[Avoqado SDK] Payment successful', data)
        if (this.config.onSuccess) {
          this.config.onSuccess({
            sessionId: data.sessionId,
            token: data.token,
            maskedPan: data.maskedPan,
            cardBrand: data.cardBrand,
            authorizationId: data.authorizationId,
            transactionId: data.transactionId,
          })
        }
        break

      case 'payment.error':
        console.error('[Avoqado SDK] Payment error', data)
        if (this.config.onError) {
          this.config.onError({
            message: data.message,
            code: data.code,
            sessionId: data.sessionId,
          })
        }
        break

      case 'payment.cancel':
        console.log('[Avoqado SDK] Payment cancelled', data)
        if (this.config.onCancel) {
          this.config.onCancel()
        }
        break

      case 'checkout.ready':
        console.log('[Avoqado SDK] Checkout ready')
        // Checkout iframe loaded successfully
        break

      case 'checkout.resize':
        // Handle dynamic height adjustment
        if (data.height && this.iframe) {
          this.iframe.style.height = data.height + 'px'
        }
        break

      default:
        console.log('[Avoqado SDK] Unknown message type:', data.type)
    }
  }

  /**
   * Handle window resize
   * @private
   */
  AvoqadoCheckout.prototype._handleResize = function () {
    // Adjust iframe if needed (for responsive design)
    if (this.iframe && this.config.width === '100%') {
      // Iframe will automatically resize with container
    }
  }

  /**
   * Send message to iframe
   * @private
   */
  AvoqadoCheckout.prototype._sendMessage = function (type, data) {
    if (!this.iframe || !this.iframe.contentWindow) {
      console.warn('[Avoqado SDK] Cannot send message: iframe not ready')
      return
    }

    this.iframe.contentWindow.postMessage(
      {
        type: type,
        ...data,
      },
      this.config.baseUrl,
    )
  }

  /**
   * Update checkout amount (if session allows)
   */
  AvoqadoCheckout.prototype.updateAmount = function (newAmount) {
    if (newAmount <= 0) {
      throw new Error('[Avoqado SDK] Amount must be greater than 0')
    }

    this.config.amount = newAmount
    this._sendMessage('checkout.updateAmount', { amount: newAmount })

    console.log('[Avoqado SDK] Amount updated:', newAmount)
  }

  /**
   * Check if checkout is mounted
   */
  AvoqadoCheckout.prototype.isMounted = function () {
    return this.mounted
  }

  // Export to global scope
  window.AvoqadoCheckout = AvoqadoCheckout

  console.log('[Avoqado SDK] Loaded successfully (v1.0.0)')
})(window)
