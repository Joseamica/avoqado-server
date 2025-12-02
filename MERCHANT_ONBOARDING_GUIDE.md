# 🥑 Avoqado SDK - New Client Onboarding Guide

**Last Updated**: 2025-01-19 (Hierarchical Merchant Model with KYC)

---

## 🏗️ Business Model Architecture

Avoqado uses Blumon's **Hierarchical Merchant Model** (Option A) for e-commerce payment processing:

### Why Hierarchical Model?

**KYC Compliance**: Mexican regulations require each merchant accepting payments to be individually registered with KYC (Know Your Customer)
documentation. Using a single aggregator account without proper legal structure would violate compliance requirements.

**Payment Flow**:

```
┌─────────────────────────────────────────────────────────────┐
│ Customer                                                     │
│  └─> Makes payment on merchant's website                    │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ Avoqado Platform                                            │
│  └─> Routes payment to correct sub-merchant                 │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ Blumon (Master Account: Avoqado)                            │
│  ├─> Sub-merchant: Tacos El Güero (KYC-approved)            │
│  ├─> Sub-merchant: Pizza Roma (KYC-approved)                │
│  └─> Sub-merchant: Café Central (KYC-approved)              │
└─────────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────────┐
│ Bank Settlement                                             │
│  └─> Funds deposited directly to merchant's bank account    │
└─────────────────────────────────────────────────────────────┘
```

### Key Characteristics

- **Separate Credentials**: Each merchant gets unique Blumon OAuth 2.0 credentials (username/password) automatically after KYC approval
- **Dashboard Access**: Blumon automatically creates a panel for each merchant (e.g., "Comercio Juanita" or "Sucursal Juanita")
- **Avoqado Visibility**: Avoqado can see all merchant transactions in Blumon dashboard (as separate sub-accounts)
- **Independent Settlement**: Funds go directly to merchant's bank account (NOT Avoqado's)
- **Tax Compliance**: Revenue is NOT counted as Avoqado income (no tax implications for platform)
- **Avoqado Role**: Platform/facilitator, NOT payment recipient

### Dashboard Access Control (UX Decision)

**Technical Reality** (confirmed by Edgardo 2025-01-19):

- ✅ Blumon **DOES** create a dashboard panel for each merchant (automatic process)
- ✅ Merchants **DO** receive Blumon credentials (username/password)
- ✅ Avoqado **CAN** see merchant transactions in Blumon dashboard (as "sucursal" or "comercio")

**Avoqado's UX Decision**:

- Merchants see **everything** in Avoqado dashboard (analytics, transactions, reports)
- Avoqado **MAY CHOOSE** not to share Blumon credentials with merchants (simpler UX)
- Blumon dashboard access is **optional** for merchants (all data is in Avoqado)
- Credentials exist but can be kept private for Avoqado's internal use only

**Quote from Edgardo**: _"Aún así se genera mi panel para tu merch (por proceso). Verias una sucursal de juanita por ejemplo."_

### Payment Routing - How It Works Technically

**CRITICAL CLARIFICATION** (confirmed by Edgardo 2025-01-19):

Although each merchant receives Blumon credentials (username/password), **payment routing does NOT use separate credentials per merchant**.

**How Payment Routing Actually Works**:

1. **Avoqado uses MASTER credentials** (single OAuth 2.0 token) for ALL API calls
2. **Payment routing happens via `merchantId` field** in the authorization request
3. **Reference field** identifies the transaction in Blumon dashboard and webhook

**Technical Flow**:

```typescript
// ✅ CORRECT: Master credentials + merchantId routing
await blumonService.authorizePayment({
  accessToken: AVOQADO_MASTER_TOKEN, // ← Single token for all merchants
  amount: 100.0,
  currency: '484', // MXN
  cardToken: 'tok_abc123',
  cvv: '123',
  orderId: 'session_xyz',
  merchantId: 'BLUMON_MERCH_123', // ← Routes to Juanita's bank account
  reference: 'session_xyz', // ← Shows in Blumon dashboard
})
```

**What `merchantId` Does**:

- Routes payment to specific merchant's bank account
- Shows transaction under correct "sucursal" in Blumon dashboard
- Returned by Blumon after KYC approval (stored in `providerCredentials.blumonMerchantId`)

**What `reference` Does**:

- Identifies transaction in Blumon dashboard (visible to Avoqado)
- Returned in webhook payload for reconciliation
- Format: `session_{checkoutSessionId}` or custom identifier

**Quote from Edgardo**: _"Mejor así, y añade la referencia para ti. Tenemos más orden."_

**Why This Architecture**:

- ✅ Simpler for Avoqado (single OAuth token to manage)
- ✅ More complex for Blumon (backend routing by merchantId)
- ✅ Still KYC compliant (each merchant properly registered)
- ✅ Still separate settlements (funds go to merchant's bank)

### Alternative Model (Not Used)

**⚠️ Payment Aggregator Model (Option B) - NOT VIABLE**: Single master account where all payments go to Avoqado, then dispersed to
merchants. This model requires special legal structure (like Masterpay) and violates KYC compliance without proper licensing.

---

## ⚠️ Prerequisites

Before onboarding a client, ensure:

1. ✅ Payment provider is configured (Blumon account with Avoqado)
2. ✅ Provider cost structure exists in database
3. ✅ You have collected merchant's KYC documents (see KYC section below)
4. ✅ Database migration is applied (`npx prisma migrate deploy`)

**⚠️ IMPORTANT**: Merchants do NOT need to create their own Blumon accounts. Credentials are provided by Blumon after KYC approval.

---

## 📋 KYC Submission & Credential Workflow

**This is the FIRST step before using the onboarding script.**

### Step 0: Collect Merchant KYC Documents

Before submitting to Blumon, collect from merchant:

1. **Business Information**:

   - Legal business name (Razón Social)
   - RFC (Registro Federal de Contribuyentes)
   - Tax regime (Régimen Fiscal)
   - Business address
   - Contact person (name, email, phone)

2. **Bank Account Information**:

   - Bank name
   - Account holder name (must match business name)
   - Account number (CLABE for Mexico)
   - Account type (checking/savings)

3. **Legal Documents** (PDF/images):
   - Tax registration certificate (Cédula Fiscal)
   - Proof of address (Comprobante de Domicilio)
   - ID of legal representative (INE/Passport)
   - Bank account statement (Estado de Cuenta)

### Step 1: Submit KYC to Blumon

**Contact**: Blumon Integration Team

- **Edgardo Olvera** - edgardo@blumonpay.com
- **Carlos Aguilar** - carlos@blumonpay.com

**Submission Process**:

1. Email Blumon with subject: `Nuevo Sub-Merchant - [Business Name]`
2. Attach KYC documents (PDFs)
3. Include this information:

```
Nuevo Sub-Merchant para Avoqado:

Información del Negocio:
- Razón Social: Tacos El Güero S.A. de C.V.
- RFC: ABCD123456XYZ
- Régimen Fiscal: 601 - General de Ley Personas Morales
- Dirección: Av. Reforma 123, Col. Centro, CDMX, 06000
- Contacto: José García (jose@tacoselguero.com, +52 55 1234 5678)

Información Bancaria:
- Banco: BBVA México
- Titular: Tacos El Güero S.A. de C.V.
- CLABE: 012345678901234567
- Tipo: Cuenta de Cheques

Documentos adjuntos:
1. Cédula Fiscal (RFC)
2. Comprobante de Domicilio
3. INE del Representante Legal
4. Estado de Cuenta Bancario

Por favor crear sub-merchant bajo cuenta master de Avoqado.
```

3. **Wait for Approval** (typically 2-5 business days)

4. **Receive Credentials from Blumon**:
   - Blumon will respond with OAuth 2.0 credentials:
     - Username (email): e.g., `tacoselguero@avoqado.blumonpay.com`
     - Password: e.g., `Abc123!@#`
     - Webhook Secret (optional): For signature verification

**⚠️ CRITICAL**: Store these credentials securely. You'll need them for the onboarding script.

---

## 📋 Step-by-Step Onboarding Process

**⚠️ IMPORTANT**: This section is for **Avoqado staff only**, AFTER receiving Blumon credentials from KYC approval.

### Step 2: Create E-commerce Merchant Account (Avoqado Admin)

**Prerequisites**:

- ✅ Merchant's KYC has been approved by Blumon
- ✅ You have received OAuth 2.0 credentials from Blumon (via Edgardo/Carlos)

**Option A: Via Script** (Recommended for first few clients)

```bash
# Run onboarding script (Avoqado staff only)
npx ts-node -r tsconfig-paths/register scripts/onboard-external-merchant.ts

# Follow prompts:
# 1. Business Name: "Tacos El Güero"
# 2. RFC (optional): "ABCD123456XYZ"
# 3. Contact Email: "admin@tacoselguero.com"  # ← Merchant's contact
# 4. Contact Phone: "+52 55 1234 5678"
# 5. Website: "https://tacoselguero.com"
# 6. Select Payment Provider: [1] Blumon
#
# 7. Blumon E-commerce Credentials (OAuth 2.0):
#    ⚠️  CRITICAL: Use credentials PROVIDED BY BLUMON after KYC approval
#    ⚠️  These are NOT the merchant's personal credentials
#    ⚠️  These are NOT Android SDK credentials (POS ID, Serial Number, etc.)
#
#    Enter credentials from Blumon email:
#    - Username (email): "tacoselguero@avoqado.blumonpay.com"  # ← From Blumon
#    - Password: "Abc123!@#"  # ← From Blumon
#
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

### Step 3: Send API Keys to Client (Secure Channel)

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

### Step 4: Client Integration (Merchant Side)

**Client follows this guide:**

#### **4A. Backend Setup**

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

#### **4B. Frontend Setup**

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

### Step 5: Test Payment (Sandbox Mode)

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

### Step 6: Production Migration

When client is ready for production:

1. **Request Production Credentials from Blumon**

   **⚠️ IMPORTANT**: Production credentials come FROM Blumon, NOT from the merchant.

   - Email Blumon (Edgardo/Carlos): "Solicitud de credenciales de producción para [Business Name]"
   - Blumon will provide:
     - Production Blumon Account Username (email)
     - Production Blumon Account Password
     - Production Webhook Secret (optional)

2. **Update Merchant Account** (Avoqado Admin Only)

   ```bash
   # Via SQL or dashboard (Avoqado staff only)
   UPDATE "EcommerceMerchant"
   SET
     "sandboxMode" = false,
     "providerCredentials" = '{
       "blumonUsername": "tacoselguero-prod@avoqado.blumonpay.com",
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

## ❓ Frequently Asked Questions

### Q1: Do merchants get access to their own Blumon dashboard?

**Answer**: This depends on Blumon's sub-merchant configuration. Typically:

- **Transaction Visibility**: Merchants can see their transactions through **Avoqado's dashboard** (recommended)
- **Blumon Portal Access**: May be available if Blumon provides separate login credentials for the sub-merchant
- **Best Practice**: Use Avoqado as the single source of truth for transaction data, analytics, and reporting

**Action**: Confirm with Blumon (Edgardo/Carlos) whether sub-merchants receive individual dashboard access.

### Q2: Can merchants change their own Blumon credentials?

**Answer**: No. Since Blumon credentials are managed by Avoqado under the hierarchical model:

- Credentials are stored in Avoqado's database (`providerCredentials`)
- Only Avoqado staff can update credentials
- Merchants cannot directly access or modify their Blumon account settings

**If credentials need to change**: Contact Blumon support → Receive new credentials → Update via script or SQL

### Q3: What happens if a merchant wants to leave Avoqado?

**Answer**: Migration process:

1. Merchant requests to leave platform
2. Avoqado contacts Blumon to transfer sub-merchant ownership (if possible)
3. Alternative: Blumon creates a new independent merchant account for them
4. Merchant goes through standard Blumon onboarding independently

**Note**: Check with Blumon if sub-merchant portability is supported.

### Q4: How do I know which payments belong to which merchant?

**Answer**: Payments are tracked via:

- `EcommerceMerchant.id` (foreign key in `CheckoutSession` table)
- `EcommerceMerchant.contactEmail` (for querying)
- `CheckoutSession.externalOrderId` (merchant's internal order reference)

```sql
-- Example: Get all payments for a specific merchant
SELECT cs.*, em."businessName"
FROM "CheckoutSession" cs
JOIN "EcommerceMerchant" em ON cs."ecommerceMerchantId" = em.id
WHERE em."contactEmail" = 'admin@tacoselguero.com';
```

### Q5: Can one merchant have multiple Blumon accounts?

**Answer**: Yes, but typically not needed. Use cases:

- **Sandbox + Production**: Same merchant, different environments
- **Multiple Brands**: If merchant operates different brands with separate bank accounts
- **Multi-Currency**: If merchant needs separate accounts for different currencies (MXN vs USD)

Each would require separate KYC submission to Blumon.

### Q6: What's the difference between Blumon E-commerce vs Blumon Android SDK?

**Answer**: **TWO COMPLETELY DIFFERENT INTEGRATIONS** - do NOT confuse them!

| Aspect          | Blumon E-commerce (this guide)          | Blumon Android SDK (TPV)            |
| --------------- | --------------------------------------- | ----------------------------------- |
| **Use Case**    | Online payments (web checkout)          | In-person payments (terminals)      |
| **Model**       | `EcommerceMerchant` + `CheckoutSession` | `MerchantAccount` + `Terminal`      |
| **Auth**        | OAuth 2.0 (username/password)           | Terminal credentials                |
| **Credentials** | `blumonUsername`, `blumonPassword`      | `blumonPosId`, `blumonSerialNumber` |
| **Flow**        | Tokenize → Authorize (synchronous)      | Card reader → Real-time             |
| **Service**     | `blumon-ecommerce.service.ts`           | `blumon-tpv.service.ts`             |

**⚠️ CRITICAL**: Never use Android SDK credentials for e-commerce or vice versa!

---

**Questions?** Contact: support@avoqado.io
