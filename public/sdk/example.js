/**
 * Avoqado SDK - Example Page Logic
 *
 * This file contains the demo page JavaScript, extracted to comply with CSP.
 * The inline script was moved here to satisfy: script-src 'self'
 */

let checkout = null

// Wait for DOM to be ready
document.addEventListener('DOMContentLoaded', () => {
  // DOM elements
  const sessionIdInput = document.getElementById('session-id')
  const amountInput = document.getElementById('amount')
  const currencySelect = document.getElementById('currency')
  const localeSelect = document.getElementById('locale')
  const initButton = document.getElementById('init-checkout')
  const updateButton = document.getElementById('update-amount')
  const destroyButton = document.getElementById('destroy-checkout')
  const statusMessage = document.getElementById('status-message')

  // Auto-populate from URL query parameters
  const urlParams = new URLSearchParams(window.location.search)
  if (urlParams.has('sessionId')) {
    sessionIdInput.value = urlParams.get('sessionId')
  }
  if (urlParams.has('amount')) {
    amountInput.value = urlParams.get('amount')
  }
  if (urlParams.has('currency')) {
    currencySelect.value = urlParams.get('currency')
  }
  if (urlParams.has('locale')) {
    localeSelect.value = urlParams.get('locale')
  }

  // Auto-initialize if sessionId is provided in URL
  if (urlParams.has('sessionId')) {
    console.log('📋 Auto-initializing with URL parameters:', {
      sessionId: urlParams.get('sessionId'),
      amount: urlParams.get('amount'),
      currency: urlParams.get('currency'),
    })
    // Trigger initialization automatically after a short delay
    setTimeout(() => {
      initButton.click()
    }, 500)
  }

  // Initialize checkout
  initButton.addEventListener('click', () => {
    if (checkout) {
      checkout.unmount()
    }

    checkout = new AvoqadoCheckout({
      sessionId: sessionIdInput.value,
      amount: parseFloat(amountInput.value),
      currency: currencySelect.value,
      locale: localeSelect.value,

      onSuccess: result => {
        console.log('✅ Payment Success:', result)
        showStatus('success', `¡Pago exitoso! Token: ${result.token.substring(0, 20)}...`)
      },

      onError: error => {
        console.error('❌ Payment Error:', error)
        showStatus('error', `Error: ${error.message}`)
      },

      onCancel: () => {
        console.log('⚠️ Payment Cancelled')
        showStatus('error', 'Pago cancelado por el usuario')
      },
    })

    checkout.mount('#payment-container')
    document.getElementById('payment-container').classList.add('loaded')

    showStatus('success', 'Checkout inicializado correctamente')
  })

  // Update amount
  updateButton.addEventListener('click', () => {
    if (!checkout) {
      alert('Primero inicializa el checkout')
      return
    }

    const newAmount = parseFloat(amountInput.value)
    checkout.updateAmount(newAmount)
    showStatus('success', `Monto actualizado a $${newAmount.toFixed(2)}`)
  })

  // Destroy checkout
  destroyButton.addEventListener('click', () => {
    if (!checkout) {
      alert('No hay checkout activo')
      return
    }

    checkout.unmount()
    checkout = null
    document.getElementById('payment-container').classList.remove('loaded')
    document.getElementById('payment-container').textContent = 'Haz clic en "Inicializar Checkout" para cargar el formulario de pago'

    showStatus('success', 'Checkout destruido')
  })

  // Show status message
  function showStatus(type, message) {
    statusMessage.className = 'status ' + type
    statusMessage.textContent = message

    setTimeout(() => {
      statusMessage.className = 'status'
    }, 5000)
  }
})
