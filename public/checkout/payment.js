/**
 * Avoqado Payment Form - Client-side Logic
 *
 * Stripe-like checkout experience with:
 * - Card number formatting (4 digit groups, AMEX 4-6-5)
 * - Card brand detection (Visa, Mastercard, Amex) with SVG icons
 * - Luhn algorithm validation
 * - Paste event handling
 * - Expiry date auto-formatting (MM / YY)
 * - CVV numeric-only input (3 digits, AMEX 4)
 * - Cardholder name auto-uppercase
 * - Form validation with inline errors
 * - Loading spinner + success state on button
 * - PostMessage communication with parent window
 */

// ═══════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════

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
const errorEl = document.getElementById('error')
const errorText = document.getElementById('error-text')
const btn = document.getElementById('btn')
const cardGroupBox = document.getElementById('card-group-box')

// ═══════════════════════════════════════════════
// ERROR HANDLING
// ═══════════════════════════════════════════════

function showError(msg) {
  errorText.textContent = msg
  errorEl.classList.add('show')
}

function hideError() {
  errorEl.classList.remove('show')
}

// ═══════════════════════════════════════════════
// CARD NUMBER FORMATTING & VALIDATION
// ═══════════════════════════════════════════════

const formatCardNumber = input => {
  let v = input.value.replace(/\D/g, '').slice(0, 16)
  let formatted = v.match(/.{1,4}/g)?.join(' ') || v
  input.value = formatted

  // Detect brand
  document.querySelectorAll('.brand').forEach(b => b.classList.remove('active'))
  let isAmex = false

  if (/^4/.test(v)) {
    document.getElementById('visa').classList.add('active')
  } else if (/^5[1-5]/.test(v) || /^2[2-7]/.test(v)) {
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
    cvv.setAttribute('placeholder', 'CVC')
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
    const isValid = sum % 10 === 0
    input.className = isValid ? 'valid' : 'invalid'
    if (isValid) {
      cardGroupBox.classList.remove('has-error')
    } else {
      cardGroupBox.classList.add('has-error')
    }
  } else {
    input.className = ''
    cardGroupBox.classList.remove('has-error')
  }
}

// Card number input
cardnum.addEventListener('input', e => formatCardNumber(e.target))

// Card number paste
cardnum.addEventListener('paste', e => {
  e.preventDefault()
  const pastedText = (e.clipboardData || window.clipboardData).getData('text')
  cardnum.value = pastedText.replace(/\D/g, '').slice(0, 16)
  formatCardNumber(cardnum)
})

// Auto-advance from card number to expiry
cardnum.addEventListener('input', () => {
  const digits = cardnum.value.replace(/\D/g, '')
  if (digits.length === 16 && cardnum.className === 'valid') {
    expiry.focus()
  }
})

// ═══════════════════════════════════════════════
// EXPIRY FORMATTING
// ═══════════════════════════════════════════════

expiry.addEventListener('input', e => {
  let v = e.target.value.replace(/\D/g, '')
  let formatted = ''

  if (v.length === 0) {
    formatted = ''
  } else if (v.length <= 2) {
    formatted = v
  } else if (v.length === 3) {
    formatted = v.slice(0, 2) + ' / ' + v.slice(2)
  } else {
    formatted = v.slice(0, 2) + ' / ' + v.slice(2, 4)
  }

  e.target.value = formatted

  // Auto-advance to CVV
  if (v.length === 4) {
    cvv.focus()
  }
})

// ═══════════════════════════════════════════════
// CVV
// ═══════════════════════════════════════════════

cvv.addEventListener('input', e => {
  e.target.value = e.target.value.replace(/\D/g, '')

  // Auto-advance to name
  const maxLen = parseInt(cvv.getAttribute('maxlength'))
  if (e.target.value.length === maxLen) {
    name.focus()
  }
})

// ═══════════════════════════════════════════════
// NAME
// ═══════════════════════════════════════════════

name.addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase()
})

// ═══════════════════════════════════════════════
// FORM SUBMISSION
// ═══════════════════════════════════════════════

form.addEventListener('submit', async e => {
  e.preventDefault()
  hideError()

  const cn = cardnum.value.replace(/\s/g, '')
  const ex = expiry.value.replace(/\s/g, '')
  const cv = cvv.value
  const nm = name.value.trim()

  // Validation
  const errs = []
  if (!cn || cn.length < 13) errs.push('Numero de tarjeta incompleto')
  if (!ex.match(/^\d{2}\/\d{2}$/)) errs.push('Fecha de vencimiento invalida')

  const isAmexCard = /^3[47]/.test(cn)
  const requiredCvvLength = isAmexCard ? 4 : 3
  if (!cv || cv.length !== requiredCvvLength) {
    errs.push(`CVC debe tener ${requiredCvvLength} digitos`)
  }

  if (!nm || nm.length < 3) errs.push('Nombre del titular requerido')

  if (errs.length) {
    showError(errs.join('. '))
    return
  }

  // Set loading state
  btn.disabled = true
  btn.classList.add('loading')

  const [m, y] = ex.split('/')

  try {
    // Step 1: Tokenize card
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

    // Success state
    btn.classList.remove('loading')
    btn.classList.add('success')

    // Notify parent after short delay
    setTimeout(() => {
      if (window.parent !== window) {
        window.parent.postMessage({ type: 'PAYMENT_COMPLETE' }, '*')
      }
    }, 2000)
  } catch (err) {
    showError(err.message || 'Error al procesar el pago')
    btn.disabled = false
    btn.classList.remove('loading')
  }
})

// ═══════════════════════════════════════════════
// IFRAME READY
// ═══════════════════════════════════════════════

window.parent.postMessage({ type: 'IFRAME_READY' }, '*')

// ═══════════════════════════════════════════════
// PRE-FILL (for test forms)
// ═══════════════════════════════════════════════

const prefillData = params.get('prefill')
if (prefillData) {
  try {
    const data = JSON.parse(decodeURIComponent(prefillData))

    if (data.cardNumber) {
      cardnum.value = data.cardNumber
      formatCardNumber(cardnum)
    }

    if (data.expiry) {
      expiry.value = data.expiry
    }

    if (data.cvv) {
      cvv.value = data.cvv
    }

    if (data.name) {
      name.value = data.name.toUpperCase()
    }
  } catch (e) {
    console.warn('Failed to parse prefill data:', e)
  }
}
