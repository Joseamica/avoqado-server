/**
 * Avoqado Payment Form - Client-side Logic
 *
 * This file contains the payment form JavaScript, extracted to comply with CSP.
 * The inline script was moved here to satisfy: script-src 'self'
 *
 * Features:
 * - Card number formatting (4 digit groups)
 * - Card brand detection (Visa, Mastercard, Amex)
 * - Luhn algorithm validation
 * - Paste event handling
 * - Expiry date auto-formatting (MM / YY)
 * - CVV numeric-only input
 * - Cardholder name auto-uppercase
 * - Form validation
 * - PostMessage communication with parent window
 */

const params = new URLSearchParams(location.search)
const sid = params.get('sessionId')
const amt = parseFloat(params.get('amount') || 0)
const cur = params.get('currency') || 'MXN'

const fmtAmt = new Intl.NumberFormat('es-MX', { style: 'currency', currency: cur }).format(amt)
document.getElementById('amount').textContent = fmtAmt
document.getElementById('btnamt').textContent = fmtAmt

const cardnum = document.getElementById('cardnum')
const expiry = document.getElementById('expiry')
const cvv = document.getElementById('cvv')
const name = document.getElementById('name')
const form = document.getElementById('form')
const error = document.getElementById('error')
const btn = document.getElementById('btn')

// Card number formatting function
const formatCardNumber = input => {
  let v = input.value.replace(/\D/g, '').slice(0, 16) // Max 16 digits
  let formatted = v.match(/.{1,4}/g)?.join(' ') || v
  input.value = formatted

  // Detect brand
  document.querySelectorAll('.brand').forEach(b => b.classList.remove('active'))
  let isAmex = false

  if (/^4/.test(v)) {
    document.getElementById('visa').classList.add('active')
  } else if (/^5[1-5]/.test(v)) {
    document.getElementById('mc').classList.add('active')
  } else if (/^3[47]/.test(v)) {
    document.getElementById('amex').classList.add('active')
    isAmex = true
  }

  // Update CVV field based on card type (AMEX = 4 digits, others = 3 digits)
  if (isAmex) {
    cvv.setAttribute('maxlength', '4')
    cvv.setAttribute('placeholder', '1234')
  } else {
    cvv.setAttribute('maxlength', '3')
    cvv.setAttribute('placeholder', '123')
  }

  // Luhn validation
  if (v.length >= 13) {
    let sum = 0,
      alt = false
    for (let i = v.length - 1; i >= 0; i--) {
      let n = parseInt(v.charAt(i))
      if (alt) {
        n *= 2
        if (n > 9) n -= 9
      }
      sum += n
      alt = !alt
    }
    input.className = sum % 10 === 0 ? 'valid' : 'invalid'
  } else {
    input.className = ''
  }
}

// Card number input
cardnum.addEventListener('input', e => formatCardNumber(e.target))

// Card number paste (handle paste events)
cardnum.addEventListener('paste', e => {
  e.preventDefault()
  const pastedText = (e.clipboardData || window.clipboardData).getData('text')
  cardnum.value = pastedText.replace(/\D/g, '').slice(0, 16)
  formatCardNumber(cardnum)
})

// Expiry formatting (Stripe-like behavior)
let expiryPrevValue = ''
expiry.addEventListener('input', e => {
  let v = e.target.value.replace(/\D/g, '') // Remove non-digits
  let formatted = ''

  // Format based on length
  if (v.length === 0) {
    formatted = ''
  } else if (v.length === 1) {
    formatted = v
  } else if (v.length === 2) {
    formatted = v
  } else if (v.length === 3) {
    formatted = v.slice(0, 2) + ' / ' + v.slice(2)
  } else {
    formatted = v.slice(0, 2) + ' / ' + v.slice(2, 4)
  }

  e.target.value = formatted
  expiryPrevValue = formatted
})

// CVV - only numbers
cvv.addEventListener('input', e => {
  e.target.value = e.target.value.replace(/\D/g, '')
})

// Name - uppercase
name.addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase()
})

// Submit
form.addEventListener('submit', async e => {
  e.preventDefault()
  error.classList.remove('show')

  const cn = cardnum.value.replace(/\s/g, '')
  const ex = expiry.value.replace(/\s/g, '')
  const cv = cvv.value
  const nm = name.value.trim()

  const errs = []
  if (!cn || cn.length < 13) errs.push('Tarjeta incompleta')
  if (!ex.match(/^\d{2}\/\d{2}$/)) errs.push('Fecha inválida')

  // CVV validation: AMEX requires 4 digits, others require 3
  const isAmexCard = /^3[47]/.test(cn)
  const requiredCvvLength = isAmexCard ? 4 : 3
  if (!cv || cv.length !== requiredCvvLength) {
    errs.push(`CVV debe tener ${requiredCvvLength} dígitos`)
  }

  if (!nm || nm.length < 3) errs.push('Nombre requerido')

  if (errs.length) {
    error.textContent = errs.join('. ')
    error.classList.add('show')
    return
  }

  btn.disabled = true
  btn.textContent = 'Procesando...'

  const [m, y] = ex.split('/')

  try {
    // Step 1: Tokenize card with Blumon
    const tokenResponse = await fetch('/api/v1/sdk/tokenize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: sid,
        cardData: {
          pan: cn,
          cvv: cv,
          expMonth: m,
          expYear: '20' + y,
          cardholderName: nm,
        },
      }),
    })

    const tokenData = await tokenResponse.json()

    if (!tokenResponse.ok || !tokenData.success) {
      throw new Error(tokenData.error || tokenData.message || 'Error al tokenizar la tarjeta')
    }

    // Step 2: Charge with token
    const chargeResponse = await fetch('/api/v1/sdk/charge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: sid,
        cvv: cv,
      }),
    })

    const chargeData = await chargeResponse.json()

    if (!chargeResponse.ok || !chargeData.success) {
      throw new Error(chargeData.error || chargeData.message || 'Error al procesar el pago')
    }

    // Success!
    btn.textContent = '✅ ¡Pago Exitoso!'
    btn.style.background = '#0fda6a'

    // Auto-close after 2 seconds
    setTimeout(() => {
      if (window.parent !== window) {
        window.parent.postMessage({ type: 'PAYMENT_COMPLETE' }, '*')
      }
    }, 2000)
  } catch (err) {
    error.textContent = err.message || 'Error al procesar el pago'
    error.classList.add('show')
    btn.disabled = false
    btn.innerHTML = 'Pagar ' + fmtAmt
  }
})

window.parent.postMessage({ type: 'IFRAME_READY' }, '*')

// Pre-fill data from URL (for test forms)
// This runs AFTER all event listeners and formatCardNumber are defined
const prefillData = params.get('prefill')
if (prefillData) {
  try {
    const data = JSON.parse(decodeURIComponent(prefillData))

    // Pre-fill card number and trigger formatting
    if (data.cardNumber) {
      cardnum.value = data.cardNumber
      formatCardNumber(cardnum)
    }

    // Pre-fill expiry
    if (data.expiry) {
      expiry.value = data.expiry
    }

    // Pre-fill CVV
    if (data.cvv) {
      cvv.value = data.cvv
    }

    // Pre-fill name (uppercase)
    if (data.name) {
      name.value = data.name.toUpperCase()
    }
  } catch (e) {
    console.warn('Failed to parse prefill data:', e)
  }
}
