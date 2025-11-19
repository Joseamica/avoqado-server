# 🥑 Avoqado SDK - New Client Onboarding Guide

**Last Updated**: 2025-01-17 (After O(1) hash migration)

---

## ⚠️ Prerequisites

Before onboarding a client, ensure:

1. ✅ Payment provider is configured (Blumon, Stripe, Square, etc.)
2. ✅ Provider cost structure exists in database
3. ✅ Client has Blumon credentials (merchantId, apiKey, posId) **OR** you're using mock mode
4. ✅ Database migration is applied (`npx prisma migrate deploy`)

---

## 📋 Step-by-Step Onboarding Process

### Step 1: Create E-commerce Merchant Account (Admin Side)

**Option A: Via Script** (Recommended for first few clients)

```bash
# Run onboarding script
npx ts-node -r tsconfig-paths/register scripts/onboard-external-merchant.ts

# Follow prompts:
# 1. Business Name: "Tacos El Güero"
# 2. RFC (optional): "ABCD123456XYZ"
# 3. Contact Email: "admin@tacoselguero.com"
# 4. Contact Phone: "+52 55 1234 5678"
# 5. Website: "https://tacoselguero.com"
# 6. Select Payment Provider: [1] Blumon
# 7. Blumon E-commerce Credentials (OAuth 2.0):
#    ⚠️  IMPORTANT: These are Blumon ACCOUNT credentials for e-commerce
#    ⚠️  NOT the Android SDK credentials (POS ID, Serial Number, etc.)
#    - Username (email): "jose@tacoselguero.com"
#    - Password: "your_blumon_account_password"
# 8. Webhook URL (optional): "https://tacoselguero.com/webhooks/avoqado"
```

**⚠️ Script output:**

```bash
✅ E-commerce Merchant Created Successfully!

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  🔑 API KEYS (SAVE THESE - SECRET SHOWN ONLY ONCE)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Public Key:  pk_test_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6

Secret Key:  sk_test_x9y8z7w6v5u4t3s2r1q0p9o8n7m6l5k4
             ⚠️ THIS IS THE ONLY TIME YOU'LL SEE THIS!
             Store it securely - it cannot be retrieved again.

Environment: SANDBOX (Test Mode)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📧 Send these keys to: admin@tacoselguero.com

⚠️  Important:
  • Secret key is hashed in database (SHA-256)
  • Cannot be retrieved - only regenerated
  • Share via secure channel (1Password, encrypted email)
```

---

**Option B: Via API** (For dashboard integration)

```typescript
// POST /api/v1/dashboard/ecommerce-merchants
const response = await fetch('https://api.avoqado.io/api/v1/dashboard/ecommerce-merchants', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: 'Bearer YOUR_ADMIN_TOKEN',
  },
  body: JSON.stringify({
    venueId: 'clxxx...', // Venue ID from your database
    channelName: 'Web Principal',
    businessName: 'Tacos El Güero',
    rfc: 'ABCD123456XYZ',
    contactEmail: 'admin@tacoselguero.com',
    contactPhone: '+52 55 1234 5678',
    website: 'https://tacoselguero.com',
    providerId: 'clyyy...', // Blumon provider ID
    providerCredentials: {
      blumonUsername: 'jose@tacoselguero.com', // Blumon account email
      blumonPassword: 'your_blumon_account_password', // Will be hashed with SHA-256
      webhookSecret: 'optional_webhook_secret_for_signature_verification',
    },
    sandboxMode: true, // Start in test mode
    active: true,
  }),
})

const { merchant, secretKey } = await response.json()

// ⚠️ CRITICAL: Store secretKey securely NOW
// Database only stores hash - you CANNOT retrieve this later
```

---

### Step 2: Send API Keys to Client (Secure Channel)

**Template Email:**

```
Subject: 🥑 Avoqado API Keys - Tacos El Güero

Hi Team,

Your Avoqado payment integration is ready!

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔑 API CREDENTIALS (Sandbox Environment)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Publishable Key: pk_test_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6
Secret Key:      sk_test_x9y8z7w6v5u4t3s2r1q0p9o8n7m6l5k4

⚠️ SECURITY WARNING:
• Never commit secret key to Git
• Never expose secret key in client-side code
• Store in environment variables (.env file)
• Rotate immediately if compromised

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📖 Integration Guide:
https://docs.avoqado.io/quickstart

💬 Support:
support@avoqado.io

Best regards,
Avoqado Team
```

---

### Step 3: Client Integration (Merchant Side)

**Client follows this guide:**

#### **3A. Backend Setup**

```javascript
// .env file (NEVER commit this!)
AVOQADO_SECRET_KEY = sk_test_x9y8z7w6v5u4t3s2r1q0p9o8n7m6l5k4
```

```javascript
// server.js (Node.js/Express example)
const express = require('express')
const app = express()

// Create checkout session endpoint
app.post('/create-checkout-session', async (req, res) => {
  const { amount, customerEmail } = req.body

  try {
    // Call Avoqado API to create checkout session
    const response = await fetch('https://api.avoqado.io/api/v1/sdk/checkout/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': process.env.AVOQADO_SECRET_KEY, // ← Secret key (server-side only!)
      },
      body: JSON.stringify({
        amount: parseFloat(amount),
        currency: 'MXN',
        description: `Orden de Tacos El Güero`,
        customerEmail: customerEmail,
        externalOrderId: `order_${Date.now()}`, // Your internal order ID
        successUrl: 'https://tacoselguero.com/success',
        cancelUrl: 'https://tacoselguero.com/cancel',
      }),
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.message || 'Failed to create checkout session')
    }

    const { sessionId } = await response.json()

    res.json({ sessionId })
  } catch (error) {
    console.error('Checkout session creation failed:', error)
    res.status(500).json({ error: error.message })
  }
})

app.listen(3000)
```

---

#### **3B. Frontend Setup**

```html
<!-- checkout.html -->
<!DOCTYPE html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <title>Checkout - Tacos El Güero</title>
    <style>
      #payment-container {
        max-width: 600px;
        margin: 50px auto;
        padding: 20px;
        border: 1px solid #ddd;
        border-radius: 8px;
      }
    </style>
  </head>
  <body>
    <h1>🌮 Checkout - Tacos El Güero</h1>

    <!-- Payment container -->
    <div id="payment-container"></div>

    <!-- Load Avoqado SDK -->
    <script src="https://api.avoqado.io/sdk/avoqado.js"></script>

    <!-- Your checkout logic -->
    <script>
      async function initializeCheckout() {
        // 1. Create checkout session (server-side)
        const response = await fetch('/create-checkout-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: 100.0,
            customerEmail: 'customer@example.com',
          }),
        })

        const { sessionId } = await response.json()

        // 2. Initialize Avoqado checkout (client-side)
        const checkout = new AvoqadoCheckout({
          sessionId: sessionId,
          amount: 100.0,
          currency: 'MXN',
          locale: 'es-MX',

          // Success callback (tokenization + charge completed)
          onSuccess: result => {
            console.log('✅ Payment successful!', result)
            // result.sessionId
            // result.authorizationId
            // result.transactionId
            // result.maskedPan (e.g., "4111 **** **** 1111")
            // result.cardBrand (e.g., "VISA")

            // Redirect to success page
            window.location.href = '/success?session_id=' + result.sessionId
          },

          // Error callback
          onError: error => {
            console.error('❌ Payment error:', error)
            alert('Error en el pago: ' + error.message)
          },

          // Cancel callback
          onCancel: () => {
            console.log('🚫 Payment cancelled')
            window.location.href = '/cancel'
          },
        })

        // 3. Mount checkout UI
        checkout.mount('#payment-container')
      }

      // Initialize on page load
      initializeCheckout()
    </script>
  </body>
</html>
```

---

### Step 4: Test Payment (Sandbox Mode)

**Test Card Numbers** (Blumon mock service):

| Card Number        | Brand      | Result                |
| ------------------ | ---------- | --------------------- |
| `4111111111111111` | VISA       | ✅ Success            |
| `5555555555554444` | Mastercard | ✅ Success            |
| `378282246310005`  | AMEX       | ✅ Success            |
| `4000000000000002` | VISA       | ❌ Card Declined      |
| `4000000000009995` | VISA       | ❌ Insufficient Funds |
| `4000000000000069` | VISA       | ❌ Expired Card       |
| `4000000000000127` | VISA       | ❌ Invalid CVV        |

**Test Data:**

- CVV: Any 3 digits (e.g., `123`)
- Expiration: Any future date (e.g., `12/25`)
- Name: Any name (e.g., `Juan Pérez`)

---

### Step 5: Production Migration

When client is ready for production:

1. **Get Production Blumon Credentials**

   - Production Blumon Account Username (email)
   - Production Blumon Account Password
   - Production Webhook Secret (optional)

2. **Update Merchant Account**

   ```bash
   # Via SQL or dashboard
   UPDATE "EcommerceMerchant"
   SET
     "sandboxMode" = false,
     "providerCredentials" = '{
       "blumonUsername": "jose@tacoselguero.com",
       "blumonPassword": "production_blumon_password",
       "webhookSecret": "production_webhook_secret"
     }'
   WHERE "contactEmail" = 'admin@tacoselguero.com';
   ```

3. **Regenerate API Keys** (Production mode)

   ```bash
   # Call regenerate endpoint
   POST /api/v1/dashboard/ecommerce-merchants/{merchantId}/regenerate-keys
   ```

   Returns:

   ```json
   {
     "publicKey": "pk_live_a1b2c3d4...",
     "secretKey": "sk_live_x9y8z7w6..." // ⚠️ Show only once!
   }
   ```

4. **Client Updates Environment Variables**

   ```bash
   # Production .env
   AVOQADO_SECRET_KEY=sk_live_x9y8z7w6... # ← New production key
   ```

5. **Test Production Payment**
   - Use real card (will be charged!)
   - Verify money settles in client's bank account

---

## 🔧 Troubleshooting

### Issue #1: "Invalid API key"

**Cause**: Secret key mismatch or incorrect format

**Solution**:

```bash
# Check merchant exists
SELECT "id", "publicKey", "secretKeyHash", "active", "sandboxMode"
FROM "EcommerceMerchant"
WHERE "contactEmail" = 'admin@tacoselguero.com';

# If secretKeyHash starts with "REGENERATE_REQUIRED_"
# → Merchant needs to regenerate keys
```

### Issue #2: "Checkout session creation failed"

**Cause**: Invalid successUrl/cancelUrl (XSS validation)

**Solution**: Ensure URLs start with `http://` or `https://`

```javascript
// ❌ WRONG
successUrl: 'javascript:alert("XSS")'
successUrl: 'data:text/html,<script>alert("XSS")</script>'

// ✅ CORRECT
successUrl: 'https://tacoselguero.com/success'
cancelUrl: 'https://tacoselguero.com/cancel'
```

### Issue #3: "Blumon authentication failed"

**Cause**: Invalid Blumon credentials in providerCredentials

**Solution**:

```bash
# Check provider credentials
SELECT "providerCredentials"
FROM "EcommerceMerchant"
WHERE "contactEmail" = 'admin@tacoselguero.com';

# Verify Blumon credentials are correct
# Test with: scripts/blumon-authenticate-master.ts
```

---

## 📊 Monitoring Client Payments

```bash
# Check recent checkout sessions
SELECT
  "sessionId",
  "amount",
  "currency",
  "status",
  "customerEmail",
  "createdAt"
FROM "CheckoutSession"
WHERE "ecommerceMerchantId" = (
  SELECT "id" FROM "EcommerceMerchant" WHERE "contactEmail" = 'admin@tacoselguero.com'
)
ORDER BY "createdAt" DESC
LIMIT 10;
```

---

## 🎯 Next Steps

After successful onboarding:

1. ✅ Monitor first 5-10 test payments
2. ✅ Review error logs for issues
3. ✅ Schedule production migration call
4. ✅ Configure webhook endpoint (if requested)
5. ✅ Add client to monthly usage report

---

**Questions?** Contact: support@avoqado.io
