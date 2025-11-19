# Avoqado SDK - Quick Integration Guide (E-commerce Web Checkout)

## ⚠️ CRITICAL: Which Blumon Integration Is This?

**This documentation is for Blumon E-commerce Integration (Web Checkout)**

This guide covers **online payments** via web browsers and mobile web. If you need **in-person payments** via physical PAX terminals, you're
in the wrong place!

### 📖 Read This First: Two Separate Blumon Integrations

⚠️ **IMPORTANT**: `docs/BLUMON_TWO_INTEGRATIONS.md` - This codebase has TWO different Blumon integrations:

1. **Blumon E-commerce Integration (Web Checkout)** ← **THIS GUIDE**

   - Use case: Online payments, web store checkout
   - Platform: Web browsers, mobile web
   - Models: `EcommerceMerchant` + `CheckoutSession`
   - Authentication: OAuth 2.0 Bearer tokens
   - Documentation: This file + `BLUMON_ECOMMERCE_IMPLEMENTATION.md`

2. **Blumon Android SDK (Physical Terminals)** ← **NOT THIS GUIDE**
   - Use case: In-person payments, restaurant POS
   - Platform: Android TPV app (PAX terminals)
   - Models: `MerchantAccount` + `Terminal`
   - Authentication: Terminal credentials (POS ID + Serial)
   - Documentation: `BLUMON_MULTI_MERCHANT_ANALYSIS.md`

**DO NOT confuse these two integrations!** They use different APIs, models, and authentication methods.

### Quick Decision Tree

- ✅ **Use this guide** if:

  - Customer is paying online (web/mobile browser)
  - You're building a web store checkout
  - Customer enters card details manually on a web page
  - Payment is asynchronous (webhooks)

- ❌ **Wrong guide** if:
  - Customer is paying in-person at a restaurant
  - You have a PAX Android terminal
  - Payment happens via card reader (tap/swipe)
  - Payment is synchronous (real-time response)
  - → Read `docs/BLUMON_MULTI_MERCHANT_ANALYSIS.md` instead

---

## 🚀 5-Minute Setup

### Step 1: Include the SDK

```html
<!DOCTYPE html>
<html>
  <head>
    <title>My Store Checkout</title>
  </head>
  <body>
    <div id="payment-container"></div>

    <!-- Load Avoqado SDK -->
    <script src="https://checkout.avoqado.io/sdk/avoqado.js"></script>
    <script src="/checkout.js"></script>
  </body>
</html>
```

---

### Step 2: Create Checkout Session (Backend)

```typescript
// Node.js/Express example
app.post('/create-checkout', async (req, res) => {
  const { amount, customerEmail } = req.body

  // Create checkout session with Avoqado API
  const response = await fetch('https://api.avoqado.io/api/v1/sdk/checkout/sessions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': process.env.AVOQADO_SECRET_KEY, // sk_live_xxx or sk_test_xxx
    },
    body: JSON.stringify({
      amount: amount,
      currency: 'MXN',
      description: 'Orden #12345',
      customerEmail: customerEmail,
      successUrl: 'https://mystore.com/success',
      cancelUrl: 'https://mystore.com/cancel',
    }),
  })

  const { sessionId } = await response.json()

  res.json({ sessionId })
})
```

---

### Step 3: Initialize Checkout (Frontend)

```javascript
// checkout.js
async function initializeCheckout() {
  // Get session ID from your backend
  const response = await fetch('/create-checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: 100.0,
      customerEmail: 'customer@example.com',
    }),
  })

  const { sessionId } = await response.json()

  // Initialize Avoqado checkout
  const checkout = new AvoqadoCheckout({
    sessionId: sessionId,
    amount: 100.0,
    currency: 'MXN',

    // Success callback
    onSuccess: result => {
      console.log('Payment successful!', result)
      // result.sessionId
      // result.token
      // result.maskedPan
      // result.cardBrand

      window.location.href = '/success?session_id=' + result.sessionId
    },

    // Error callback
    onError: error => {
      console.error('Payment error:', error)
      alert('Error: ' + error.message)
    },

    // Cancel callback
    onCancel: () => {
      console.log('Payment cancelled')
      window.location.href = '/cancel'
    },
  })

  // Mount the checkout
  checkout.mount('#payment-container')
}

// Initialize on page load
initializeCheckout()
```

---

## 🎯 Complete Example

### HTML (index.html)

```html
<!DOCTYPE html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Mi Tienda - Checkout</title>
    <style>
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        max-width: 800px;
        margin: 50px auto;
        padding: 20px;
      }
      #payment-container {
        min-height: 600px;
        border: 1px solid #ddd;
        border-radius: 8px;
        padding: 20px;
      }
      .order-summary {
        background: #f5f5f5;
        padding: 20px;
        border-radius: 8px;
        margin-bottom: 30px;
      }
    </style>
  </head>
  <body>
    <h1>🛒 Checkout</h1>

    <!-- Order Summary -->
    <div class="order-summary">
      <h2>Resumen de Orden</h2>
      <p>Producto: Tacos de Pastor (x3)</p>
      <p><strong>Total: $100.00 MXN</strong></p>
    </div>

    <!-- Payment Container -->
    <div id="payment-container"></div>

    <!-- Avoqado SDK -->
    <script src="https://checkout.avoqado.io/sdk/avoqado.js"></script>

    <script>
      // Initialize checkout
      async function initCheckout() {
        try {
          // Call your backend to create session
          const res = await fetch('/api/create-checkout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              amount: 100.0,
              items: [{ name: 'Tacos de Pastor', quantity: 3, price: 33.33 }],
            }),
          })

          const { sessionId } = await res.json()

          // Initialize Avoqado checkout
          const checkout = new AvoqadoCheckout({
            sessionId: sessionId,
            amount: 100.0,
            currency: 'MXN',

            onSuccess: result => {
              console.log('✅ Payment successful!', result)
              window.location.href = '/success.html?session_id=' + result.sessionId
            },

            onError: error => {
              console.error('❌ Payment failed:', error)
              alert('Error al procesar el pago: ' + error.message)
            },

            onCancel: () => {
              console.log('⚠️ Payment cancelled')
              window.location.href = '/cancel.html'
            },
          })

          checkout.mount('#payment-container')
        } catch (error) {
          console.error('Failed to initialize checkout:', error)
          alert('Error al cargar el checkout. Intente nuevamente.')
        }
      }

      // Run on page load
      initCheckout()
    </script>
  </body>
</html>
```

---

### Backend (Node.js/Express)

```javascript
// server.js
const express = require('express')
const app = express()

app.use(express.json())
app.use(express.static('public')) // Serve HTML files

// Create checkout session
app.post('/api/create-checkout', async (req, res) => {
  try {
    const { amount, items } = req.body

    // Call Avoqado API
    const response = await fetch('https://api.avoqado.io/api/v1/sdk/checkout/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': process.env.AVOQADO_SECRET_KEY, // Your secret key
      },
      body: JSON.stringify({
        amount: amount,
        currency: 'MXN',
        description: `Orden - ${items.length} producto(s)`,
        metadata: {
          items: items,
        },
      }),
    })

    const data = await response.json()

    if (data.success) {
      res.json({ sessionId: data.sessionId })
    } else {
      res.status(400).json({ error: data.error })
    }
  } catch (error) {
    console.error('Error creating checkout:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Webhook endpoint (for payment notifications)
app.post('/webhooks/avoqado', async (req, res) => {
  const signature = req.headers['x-avoqado-signature']
  const event = req.body

  // Verify signature (TODO: implement verification)
  // const isValid = avoqado.webhooks.verify(event, signature, webhookSecret);

  if (event.type === 'payment.success') {
    console.log('Payment successful:', event.data)

    // Update order in your database
    await updateOrder(event.data.sessionId, {
      status: 'paid',
      paymentToken: event.data.token,
    })
  }

  res.json({ received: true })
})

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000')
})
```

---

## 📝 Environment Variables

Create a `.env` file:

```bash
# Avoqado API Keys
AVOQADO_PUBLIC_KEY=pk_test_abc123xyz
AVOQADO_SECRET_KEY=sk_test_abc123xyz
AVOQADO_WEBHOOK_SECRET=whsec_abc123xyz

# Your database, etc.
DATABASE_URL=postgresql://...
```

**⚠️ IMPORTANT:**

- Use `pk_test_*` and `sk_test_*` for testing
- Use `pk_live_*` and `sk_live_*` for production
- NEVER commit API keys to version control

---

## 🔒 Security Checklist

Before going live:

- [ ] ✅ HTTPS enabled (SSL certificate)
- [ ] ✅ Using production API keys (`pk_live_*`, `sk_live_*`)
- [ ] ✅ Webhook signature verification enabled
- [ ] ✅ CORS properly configured
- [ ] ✅ Environment variables for secrets (not hardcoded)
- [ ] ✅ Error handling implemented
- [ ] ✅ Test with real cards in production mode

---

## 🧪 Testing

### Test Cards (Blumon Sandbox)

| Card Type  | Number              | CVV  | Exp   |
| ---------- | ------------------- | ---- | ----- |
| Visa       | 4111 1111 1111 1111 | 123  | 12/25 |
| Mastercard | 5500 0000 0000 0004 | 123  | 12/25 |
| Amex       | 3400 0000 0000 009  | 1234 | 12/25 |

### Test Flow

1. **Open example page:**

   ```
   https://checkout.avoqado.io/sdk/example.html
   ```

2. **Enter test card details**
3. **Click "Pagar"**
4. **Verify success callback fires**
5. **Check database for token (not card data)**

---

## 📊 API Reference

### Create Checkout Session

**Endpoint:** `POST /api/v1/sdk/checkout/sessions`

**Headers:**

```
Content-Type: application/json
X-API-Key: sk_test_abc123xyz
```

**Request:**

```json
{
  "amount": 100.0,
  "currency": "MXN",
  "description": "Orden #12345",
  "customerEmail": "customer@example.com",
  "metadata": {
    "orderId": "12345",
    "customField": "value"
  }
}
```

**Response:**

```json
{
  "success": true,
  "sessionId": "cs_avoqado_abc123xyz",
  "expiresAt": "2025-01-14T12:00:00Z"
}
```

---

### Tokenize Card

**Endpoint:** `POST /sdk/tokenize`

**⚠️ This is called automatically by the SDK. You should NOT call it directly.**

**Request:**

```json
{
  "sessionId": "cs_avoqado_abc123xyz",
  "cardData": {
    "pan": "4111111111111111",
    "cvv": "123",
    "expMonth": "12",
    "expYear": "2025",
    "cardholderName": "John Doe"
  }
}
```

**Response:**

```json
{
  "success": true,
  "token": "tok_abc123...",
  "maskedPan": "411111******1111",
  "cardBrand": "visa"
}
```

---

### Charge with Token

**Endpoint:** `POST /sdk/charge`

**Request:**

```json
{
  "sessionId": "cs_avoqado_abc123xyz",
  "cvv": "123"
}
```

**Response:**

```json
{
  "success": true,
  "authorizationId": "auth_abc123",
  "transactionId": "txn_abc123"
}
```

---

## 🎨 Customization

### Update Amount Dynamically

```javascript
checkout.updateAmount(150.0)
```

### Destroy Checkout

```javascript
checkout.unmount()
```

### Check if Mounted

```javascript
if (checkout.isMounted()) {
  console.log('Checkout is active')
}
```

---

## 🐛 Troubleshooting

### Error: "Session not found"

**Cause:** Invalid or expired `sessionId` **Solution:** Create a new session

### Error: "Too many requests"

**Cause:** Rate limit exceeded (10 req/min) **Solution:** Wait 1 minute and retry

### Error: "Invalid card number"

**Cause:** Luhn validation failed **Solution:** Customer should re-enter card number

### Checkout not loading

**Cause:** SDK script not loaded **Solution:** Check browser console, verify SDK URL

---

## 📚 Resources

- **Live Demo:** https://checkout.avoqado.io/sdk/example.html
- **API Documentation:** https://docs.avoqado.io/api
- **SAQ A Guide:** `SDK_SAQ_A_COMPLIANCE.md`
- **Support:** support@avoqado.io

---

**Happy Coding! 🥑**
