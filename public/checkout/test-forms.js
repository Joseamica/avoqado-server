/**
 * Test Forms - Client-side Logic
 *
 * Handles form submission and shows payment form in iframe (same page).
 * Extracted to external file for CSP compliance (script-src 'self').
 */

// Create iframe container (hidden by default)
const iframeContainer = document.createElement('div')
iframeContainer.id = 'iframe-container'
iframeContainer.style.cssText = `
  display: none;
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.8);
  z-index: 9999;
  padding: 40px;
  overflow: auto;
`

iframeContainer.innerHTML = `
  <div style="max-width: 600px; margin: 0 auto; position: relative;">
    <button id="close-iframe" style="
      position: absolute;
      top: -35px;
      right: 0;
      background: white;
      border: none;
      border-radius: 50%;
      width: 40px;
      height: 40px;
      font-size: 24px;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: bold;
      color: #333;
    ">✕</button>
    <iframe id="payment-iframe" style="
      width: 100%;
      height: 85vh;
      border: none;
      border-radius: 12px;
      background: white;
      box-shadow: 0 10px 40px rgba(0,0,0,0.3);
    "></iframe>
  </div>
`

document.body.appendChild(iframeContainer)

// Close button functionality
document.getElementById('close-iframe').addEventListener('click', () => {
  iframeContainer.style.display = 'none'
})

// Close on background click
iframeContainer.addEventListener('click', e => {
  if (e.target === iframeContainer) {
    iframeContainer.style.display = 'none'
  }
})

// Close on ESC key
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && iframeContainer.style.display === 'block') {
    iframeContainer.style.display = 'none'
  }
})

// Form submission handler
document.querySelectorAll('.payment-form').forEach(form => {
  form.addEventListener('submit', async e => {
    e.preventDefault()

    const cardNumber = form.querySelector('.card-number').value.replace(/\s/g, '')
    const expiry = form.querySelector('.expiry').value.replace(/\s/g, '')
    const cvv = form.querySelector('.cvv').value
    const name = form.querySelector('.name').value

    // Disable button while creating session
    const btn = form.querySelector('button[type="submit"]')
    const originalText = btn.textContent
    btn.disabled = true
    btn.textContent = 'Creando sesión...'

    try {
      // Create real checkout session via backend
      const sessionResponse = await fetch('/api/v1/sdk/test-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: 10.0,
          currency: 'MXN',
          description: 'Test payment - ' + originalText,
        }),
      })

      const sessionData = await sessionResponse.json()

      if (!sessionResponse.ok || !sessionData.success) {
        throw new Error(sessionData.error || 'Failed to create session')
      }

      const sessionId = sessionData.sessionId

      // Build payment URL with pre-filled data and real sessionId
      const paymentUrl = `/checkout/payment.html?sessionId=${sessionId}&amount=10&currency=MXN&prefill=${encodeURIComponent(
        JSON.stringify({
          cardNumber,
          expiry,
          cvv,
          name,
        }),
      )}`

      // Show iframe with payment form
      const iframe = document.getElementById('payment-iframe')
      iframe.src = paymentUrl
      iframeContainer.style.display = 'block'

      // Re-enable button
      btn.disabled = false
      btn.textContent = originalText
    } catch (error) {
      console.error('Error creating session:', error)
      alert('Error al crear la sesión de pago: ' + error.message)
      btn.disabled = false
      btn.textContent = originalText
    }
  })
})

// Add visual feedback on hover
document.querySelectorAll('button[type="submit"]').forEach(btn => {
  btn.addEventListener('mouseenter', () => {
    btn.style.transform = 'translateY(-2px)'
  })
  btn.addEventListener('mouseleave', () => {
    btn.style.transform = 'translateY(0)'
  })
})

// Listen for payment completion from iframe
window.addEventListener('message', e => {
  if (e.data.type === 'PAYMENT_COMPLETE') {
    // Close iframe after payment completes
    setTimeout(() => {
      iframeContainer.style.display = 'none'
    }, 500)
  }
})
