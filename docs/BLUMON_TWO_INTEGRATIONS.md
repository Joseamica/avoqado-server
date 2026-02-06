# Blumon: Two Separate Integrations

## ⚠️ CRITICAL DISTINCTION

This codebase has **TWO completely different Blumon integrations** that serve different purposes. **DO NOT confuse them!**

| Aspect             | Blumon E-commerce Integration                              | Blumon Android SDK (TPV)                            |
| ------------------ | ---------------------------------------------------------- | --------------------------------------------------- |
| **Use Case**       | Online payments (web checkout)                             | In-person payments (physical terminal)              |
| **Platform**       | Web browsers, mobile web                                   | Android TPV app (PAX terminals)                     |
| **Model**          | `EcommerceMerchant` + `CheckoutSession`                    | `MerchantAccount` + `Terminal`                      |
| **Payment Flow**   | Hosted checkout page → Webhook                             | Direct card swipe/tap → Real-time response          |
| **Authentication** | OAuth 2.0 access tokens                                    | Terminal credentials (POS ID + Serial)              |
| **Card Data**      | Customer enters on Blumon page (PCI-compliant)             | Card reader on PAX terminal (hardware)              |
| **Service File**   | `src/services/sdk/blumon-ecommerce.service.ts`             | `src/services/tpv/blumon-tpv.service.ts`            |
| **API Base URL**   | `https://sandbox-ecommerce.blumonpay.net`                  | `https://api-sbx.blumonpay.net`                     |
| **Documentation**  | `docs/blumon-ecommerce/BLUMON_ECOMMERCE_IMPLEMENTATION.md` | `docs/blumon-tpv/BLUMON_MULTI_MERCHANT_ANALYSIS.md` |

---

## 1️⃣ Blumon E-commerce Integration (Web Payments)

> **Note**: The e-commerce integration was refactored from hosted checkout + webhooks to direct charge (tokenize + authorize). Webhook
> references below are historical. Current architecture: `docs/blumon-ecommerce/REFACTORING_COMPLETE.md`

### Purpose

Enable **online merchants** to accept credit/debit card payments through web checkout sessions.

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Customer Browser (Web/Mobile)                                  │
│  - Merchant's website/app                                      │
│  - Avoqado SDK embedded                                        │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Avoqado Backend (E-commerce API)                               │
│  POST /api/v1/sdk/checkout/create                              │
│  - Creates CheckoutSession                                      │
│  - Calls Blumon Hosted Checkout API                            │
│  - Returns checkout URL                                         │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Blumon Hosted Checkout Page                                    │
│  https://sandbox-ecommerce.blumonpay.net/checkout/xxx          │
│  - Customer enters card details                                │
│  - Blumon processes payment                                     │
│  - PCI-compliant (SAQ A)                                        │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Blumon → Avoqado Webhook                                       │
│  POST /api/v1/sdk/webhooks/blumon                              │
│  - payment.completed / payment.failed                           │
│  - Updates CheckoutSession status                               │
│  - Creates Payment record                                       │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Merchant's Website (Callback)                                  │
│  - Success URL: Show confirmation page                          │
│  - Cancel URL: Show cancellation page                           │
└─────────────────────────────────────────────────────────────────┘
```

### Database Models

```prisma
model EcommerceMerchant {
  id               String   @id @default(cuid())
  venueId          String
  providerId       String   // Links to PaymentProvider (Blumon)

  // Blumon E-commerce Credentials
  clientId         String   // OAuth 2.0 Client ID
  clientSecret     String   // OAuth 2.0 Client Secret (encrypted)
  webhookSecret    String?  // HMAC signature verification

  // Configuration
  sandboxMode      Boolean  @default(true)

  // Relations
  venue            Venue             @relation(...)
  provider         PaymentProvider   @relation(...)
  checkoutSessions CheckoutSession[]
}

model CheckoutSession {
  id                String   @id @default(cuid())
  sessionId         String   @unique // "cs_avoqado_xxx"

  ecommerceMerchantId String
  ecommerceMerchant   EcommerceMerchant @relation(...)

  amount            Decimal
  currency          String   @default("MXN")
  description       String?

  // Blumon checkout details
  blumonCheckoutId  String?  // ID from Blumon
  blumonCheckoutUrl String?  // Hosted page URL

  status            CheckoutStatus @default(PENDING)
  // PENDING → PROCESSING → COMPLETED / FAILED / EXPIRED

  // Payment result
  paymentId         String?  @unique
  payment           Payment? @relation(...)
}
```

### Key Files

| File                                                | Purpose                                  |
| --------------------------------------------------- | ---------------------------------------- |
| `src/services/sdk/blumon-ecommerce.service.ts`      | Real Blumon E-commerce API client        |
| `src/services/sdk/blumon-ecommerce.service.mock.ts` | Mock service for development             |
| `src/services/sdk/blumon-ecommerce.interface.ts`    | Shared interface (real + mock)           |
| `src/services/sdk/checkout-session.service.ts`      | Checkout session management              |
| `src/controllers/sdk/checkout.sdk.controller.ts`    | SDK checkout endpoints                   |
| `src/controllers/sdk/tokenize.sdk.controller.ts`    | Card tokenization (optional direct flow) |
| `src/routes/sdk/checkout.sdk.routes.ts`             | Checkout routes                          |
| `src/routes/sdk/webhooks.sdk.routes.ts`             | Webhook receiver                         |

### API Endpoints

```typescript
// Create checkout session
POST /api/v1/sdk/checkout/create
Headers: X-API-Key: {merchantApiKey}
Body: {
  merchantId: "cuid_xxx",
  amount: 250.00,
  currency: "MXN",
  description: "Order #123",
  customerEmail: "customer@example.com",
  successUrl: "https://merchant.com/success",
  cancelUrl: "https://merchant.com/cancel"
}
Response: {
  sessionId: "cs_avoqado_xxx",
  checkoutUrl: "https://sandbox-ecommerce.blumonpay.net/checkout/xxx",
  expiresAt: "2025-11-17T00:00:00Z"
}

// Webhook receiver
POST /api/v1/sdk/webhooks/blumon
Headers: X-Blumon-Signature: {hmac_signature}
Body: {
  event: "payment.completed",
  checkoutId: "blumon_checkout_xxx",
  orderId: "cs_avoqado_xxx",
  transactionId: "blumon_tx_xxx",
  status: "success"
}
```

### Documentation

- **Implementation Guide**: `docs/blumon-ecommerce/BLUMON_ECOMMERCE_IMPLEMENTATION.md`
- **SDK Integration Status**: `docs/blumon-ecommerce/BLUMON_SDK_INTEGRATION_STATUS.md`
- **Quick Integration Guide**: `docs/blumon-ecommerce/SDK_INTEGRATION_GUIDE.md`
- **PCI Compliance Guide**: `docs/blumon-ecommerce/SDK_SAQ_A_COMPLIANCE.md`
- **Mock Test Cards**: `docs/blumon-ecommerce/BLUMON_MOCK_TEST_CARDS.md`
- **Webhook Simulator**: `docs/blumon-ecommerce/WEBHOOK_SIMULATOR_GUIDE.md`

---

## 2️⃣ Blumon Android SDK (Physical Terminals)

### Purpose

Enable **restaurant TPV** (point-of-sale) to process in-person payments using PAX Android terminals.

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Android TPV App (PAX A910S Terminal)                           │
│  - Waiter creates order                                        │
│  - Customer ready to pay                                        │
│  - Waiter clicks "Process Payment"                             │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Blumon Android SDK (Native Library)                            │
│  - Initializes with merchant credentials                        │
│  - Activates card reader                                        │
│  - Customer taps/swipes card                                    │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Blumon Payment Gateway API                                     │
│  https://api-sbx.blumonpay.net                                  │
│  - Processes transaction                                        │
│  - Returns APPROVED / DECLINED                                  │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Android TPV → Avoqado Backend                                  │
│  POST /api/v1/tpv/payments                                      │
│  - Records payment in database                                  │
│  - Links to Order                                               │
│  - Broadcasts via Socket.IO                                     │
└─────────────────────────────────────────────────────────────────┘
```

### Database Models

```prisma
model MerchantAccount {
  id                 String   @id @default(cuid())
  terminalId         String   // Physical terminal ID
  venueId            String

  // Blumon SDK Credentials
  blumonPosId        String   // POS ID (e.g., "376")
  blumonSerialNumber String   // Virtual serial (e.g., "2841548417")
  blumonUsername     String   // SDK username
  blumonPassword     String   // SDK password (encrypted)

  // Configuration
  name               String   // "Main Dining" / "Ghost Kitchen"
  sandboxMode        Boolean  @default(true)

  // Relations
  venue              Venue               @relation(...)
  terminal           Terminal            @relation(...)
  costStructure      ProviderCostStructure?
}

model Terminal {
  id                String   @id @default(cuid())
  serialNumber      String   @unique // "AVQD-2841548417" (hardware)
  venueId           String

  status            TerminalStatus @default(INACTIVE)
  lastHeartbeat     DateTime?

  // Relations
  venue             Venue              @relation(...)
  merchantAccounts  MerchantAccount[]  // Multi-merchant support
}
```

### Key Files

| File                                             | Purpose                                         |
| ------------------------------------------------ | ----------------------------------------------- |
| `src/services/tpv/blumon-tpv.service.ts`         | Blumon Android SDK API client (NOT e-commerce!) |
| `src/services/tpv/payment.tpv.service.ts`        | TPV payment processing                          |
| `src/services/tpv/venue.tpv.service.ts`          | Terminal configuration for Android              |
| `src/controllers/tpv/payment.tpv.controller.ts`  | TPV payment endpoints                           |
| `src/controllers/tpv/terminal.tpv.controller.ts` | Terminal management                             |
| `src/routes/tpv.routes.ts`                       | TPV routes                                      |

### API Endpoints

```typescript
// Get terminal configuration (for Android app)
GET /api/v1/tpv/venues/{venueSlug}/config
Headers: Authorization: Bearer {tpvJwtToken}
Response: {
  merchantAccounts: [
    {
      id: "cuid_xxx",
      name: "Main Dining",
      blumonPosId: "376",
      blumonSerialNumber: "2841548417",
      blumonUsername: "user_xxx",
      blumonPassword: "pass_xxx",  // Encrypted
      sandboxMode: true
    }
  ]
}

// Record payment from Android
POST /api/v1/tpv/payments
Headers: Authorization: Bearer {tpvJwtToken}
Body: {
  orderId: "cuid_xxx",
  amount: 250.00,
  method: "CREDIT_CARD",
  merchantAccountId: "cuid_merchant_xxx",
  blumonTransactionId: "tx_xxx",  // From SDK response
  authorizationCode: "123456"     // From SDK response
}
```

### Documentation

- **Multi-Merchant Architecture**: `docs/blumon-tpv/BLUMON_MULTI_MERCHANT_ANALYSIS.md`
- **Quick Reference**: `docs/blumon-tpv/BLUMON_QUICK_REFERENCE.md`
- **Architecture Summary**: `docs/blumon-tpv/BLUMON_ARCHITECTURE_SUMMARY.txt`
- **Documentation Index**: `docs/blumon-tpv/BLUMON_DOCUMENTATION_INDEX.md`
- **Payment Architecture**: `docs/PAYMENT_ARCHITECTURE.md`
- **Merchant Models**: `docs/MERCHANT_MODELS_ARCHITECTURE.md`

---

## 🚨 Critical Differences Summary

### When to Use E-commerce Integration

✅ **Use E-commerce** if:

- Customer is paying **online** (web/mobile browser)
- Merchant doesn't have a physical terminal
- Payment happens on merchant's website/app
- Customer **enters card details manually**
- You need a **hosted payment page**
- Payment is **asynchronous** (webhooks)

### When to Use Android SDK Integration

✅ **Use Android SDK** if:

- Customer is paying **in-person** at a restaurant
- Merchant has a **PAX Android terminal**
- Payment happens via **card reader** (tap/swipe/chip)
- Customer **presents physical card**
- You need **real-time** payment response
- Payment is **synchronous** (immediate result)

---

## 🔐 Authentication Differences

### E-commerce: OAuth 2.0

```typescript
// Step 1: Get access token
POST https://sandbox-ecommerce.blumonpay.net/oauth/token
Body: {
  grant_type: "client_credentials",
  client_id: "your_client_id",
  client_secret: "your_client_secret"
}
Response: {
  access_token: "eyJhbGc...",
  expires_in: 10800  // 3 hours
}

// Step 2: Use token in API calls
POST https://sandbox-ecommerce.blumonpay.net/ecommerce/checkout
Headers: {
  Authorization: "Bearer eyJhbGc..."
}
```

### Android SDK: Terminal Credentials

```typescript
// Stored in MerchantAccount
{
  blumonPosId: "376",               // POS terminal ID
  blumonSerialNumber: "2841548417", // Virtual serial number
  blumonUsername: "user_276",       // SDK username
  blumonPassword: "pass_276"        // SDK password
}

// Android SDK initialization
BlumonSDK.initialize(
  posId: "376",
  serialNumber: "2841548417",
  username: "user_276",
  password: "pass_276"
)
```

---

## 📁 File Organization

```
src/
├── services/
│   ├── sdk/                          # E-COMMERCE INTEGRATION
│   │   ├── blumon-ecommerce.service.ts
│   │   ├── blumon-ecommerce.service.mock.ts
│   │   ├── blumon-ecommerce.interface.ts
│   │   └── checkout-session.service.ts
│   │
│   └── tpv/                          # ANDROID SDK INTEGRATION
│       ├── blumon-tpv.service.ts      # ← Android SDK client
│       ├── payment.tpv.service.ts
│       └── venue.tpv.service.ts
│
├── controllers/
│   ├── sdk/                          # E-COMMERCE CONTROLLERS
│   │   ├── checkout.sdk.controller.ts
│   │   ├── tokenize.sdk.controller.ts
│   │   └── webhook-simulator.sdk.controller.ts
│   │
│   └── tpv/                          # ANDROID SDK CONTROLLERS
│       ├── payment.tpv.controller.ts
│       └── terminal.tpv.controller.ts
│
└── routes/
    ├── sdk.routes.ts                 # E-COMMERCE ROUTES
    └── tpv.routes.ts                 # ANDROID SDK ROUTES
```

---

## 🧪 Testing

### E-commerce Mock Service

```bash
# Enable mock (SOLO para E-commerce, NO aplica a TPV)
USE_BLUMON_MOCK=true

# Test cards
4111111111111111  # Success
4000000000000002  # Card declined
```

**⚠️ IMPORTANTE:** `USE_BLUMON_MOCK` solo controla el servicio E-commerce. **NO tiene ningún efecto** en el SDK de Android/TPV.

### Android SDK Testing

```bash
# El ambiente de TPV se controla con el BUILD VARIANT del APK:
# - assembleSandboxDebug/Release → sandbox-tokener.blumonpay.net
# - assembleProductionRelease → tokener.blumonpay.net

# USE_BLUMON_MOCK NO APLICA aquí - el APK se conecta directo a Blumon
# Test with physical PAX terminal or emulator
```

---

## 🎯 Common Confusion Points (DON'T MIX THESE!)

| ❌ WRONG                                                | ✅ CORRECT                                |
| ------------------------------------------------------- | ----------------------------------------- |
| Using `blumon-ecommerce.service.ts` in TPV payment flow | Use `blumon-tpv.service.ts` for TPV       |
| Using `MerchantAccount` for e-commerce merchants        | Use `EcommerceMerchant` for e-commerce    |
| Expecting webhooks from Android SDK                     | Android SDK returns synchronous responses |
| Using OAuth tokens for Android SDK                      | Android SDK uses POS credentials          |
| Trying to use PAX terminal for web checkout             | Use hosted checkout page instead          |
| Using hosted checkout in Android app                    | Use Blumon Android SDK library            |

---

## 📖 Quick Reference

**Need e-commerce/web payments?** → Read: `docs/blumon-ecommerce/BLUMON_ECOMMERCE_IMPLEMENTATION.md` → Use: `EcommerceMerchant` +
`CheckoutSession` → Service: `src/services/sdk/blumon-ecommerce.service.ts`

**Need in-person/terminal payments?** → Read: `docs/blumon-tpv/BLUMON_MULTI_MERCHANT_ANALYSIS.md` → Use: `MerchantAccount` + `Terminal` →
Service: `src/services/tpv/blumon-tpv.service.ts`

---

## ⚠️ Future Development Guidelines

1. **Always specify which integration** when discussing Blumon

   - ✅ "Blumon E-commerce API" or "Blumon Android SDK"
   - ❌ Just "Blumon" (ambiguous!)

2. **Keep files separate**

   - E-commerce code in `/sdk/` directories
   - TPV code in `/tpv/` directories

3. **Use different models**

   - E-commerce: `EcommerceMerchant` + `CheckoutSession`
   - TPV: `MerchantAccount` + `Terminal`

4. **Different API endpoints**

   - E-commerce: `/api/v1/sdk/*`
   - TPV: `/api/v1/tpv/*`

5. **Document clearly**
   - Always mention which integration in commit messages
   - Tag issues with `blumon-ecommerce` or `blumon-sdk-android`

---

**Last Updated**: 2025-11-16 **Maintainer**: This distinction is CRITICAL for system integrity. Update this doc when either integration
changes.
