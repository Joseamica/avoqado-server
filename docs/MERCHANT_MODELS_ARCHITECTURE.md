# MerchantAccount vs EcommerceMerchant - Architecture Decision

## Executive Summary

**Question**: Why do we have two separate models (`MerchantAccount` and `EcommerceMerchant`) for processing payments through Blumon?

**Answer**: Because Blumon offers **two completely different products** with incompatible APIs, credentials, and use cases:

1. **PAX Terminal SDK** → `MerchantAccount` (card-present, physical terminals)
2. **Hosted Checkout API** → `EcommerceMerchant` (card-not-present, e-commerce)

**Note**: Previously named `ExternalMerchant`, renamed to `EcommerceMerchant` on 2025-01-13 to better reflect that these are e-commerce
sales channels for existing venues, not external entities.

**These cannot be merged** due to incompatible credential structures, different relationships with venues, and distinct integration
patterns.

---

## Table of Contents

1. [Critical Discovery: Two Different Blumon Products](#1-critical-discovery-two-different-blumon-products)
2. [Side-by-Side Comparison](#2-side-by-side-comparison)
3. [Why "External"?](#3-why-external)
4. [Can They Be Merged Into One Model?](#4-can-they-be-merged-into-one-model)
5. [Stripe Analogy](#5-stripe-analogy)
6. [Architecture Diagram](#6-architecture-diagram)
7. [What Would Happen If We Merged Them?](#7-what-would-happen-if-we-merged-them)
8. [Naming Recommendations](#8-naming-recommendations)
9. [How to Explain to Other Developers](#9-how-to-explain-to-other-developers)
10. [Final Recommendation](#10-final-recommendation)

---

## 1. Critical Discovery: Two Different Blumon Products

After analyzing the codebase, we discovered that **Blumon offers TWO completely different APIs**:

### **Product #1: PAX Terminal SDK** (for MerchantAccount)

**Location**: `src/services/tpv/blumon-tpv.service.ts`

**API URLs**:

- Token Server: `https://sandbox-tokener.blumonpay.net`
- Core Server: `https://sandbox-core.blumonpay.net`

**Credentials Structure**:

```typescript
interface BlumonCredentials {
  oauthAccessToken: string // ← Expires every X hours
  oauthRefreshToken: string // ← To renew token
  rsaId: number // ← RSA key ID
  rsaKey: string // ← RSA public key (hex)
  dukptKsn: string // ← Key Serial Number
  dukptKey: string // ← Base Derivation Key for card encryption
}
```

**Authentication Flow (3 steps)**:

1. `getAccessToken(serialNumber, brand, model)` → OAuth Token
2. `getRSAKeys(token, posId)` → RSA Public Key
3. `getDUKPTKeys(token, posId, rsaKey)` → DUKPT Encryption Keys

**Use Case**: Physical PAX terminal in restaurant

- Customer **taps card** on terminal
- Terminal encrypts data with DUKPT
- Sends to Blumon with OAuth token
- Blumon processes and deposits to restaurant's bank account

---

### **Product #2: Hosted Checkout API** (for EcommerceMerchant)

**Location**: `src/services/sdk/blumon-ecommerce.service.ts`

**API URLs**:

- Sandbox: `https://sandbox-ecommerce.blumonpay.com`
- Production: `https://ecommerce.blumonpay.com`
- Docs: `https://developers.blumonpay.com/hosted-checkout`

**Credentials Structure**:

```typescript
interface BlumonHostedCheckoutRequest {
  merchantId: string // ← Merchant ID in Blumon
  apiKey: string // ← API Key (does NOT expire, NO OAuth)
  posId: string // ← Static POS ID
  amount: number
  successUrl: string // ← Redirect customer here on success
  cancelUrl: string // ← Redirect customer here on cancel
  webhookUrl: string // ← Notify our server
}
```

**Payment Flow (redirect)**:

1. `createHostedCheckout()` → Generates payment URL
2. Customer redirected to Blumon's payment page
3. Customer **enters card details on Blumon's site** (PCI compliant)
4. Blumon processes and sends webhook
5. Our app receives notification

**Use Case**: External online store using Avoqado SDK

- Customer shops on external website
- Redirects to Blumon payment page
- Customer enters card on Blumon
- Blumon deposits to external merchant's bank account

---

## 2. Side-by-Side Comparison

| Aspect                | MerchantAccount (TPV)                 | EcommerceMerchant (SDK)        |
| --------------------- | ------------------------------------- | ------------------------------ |
| **Blumon Product**    | PAX Terminal SDK                      | Hosted Checkout API            |
| **API URLs**          | tokener/core.blumonpay.net            | ecommerce.blumonpay.com        |
| **Authentication**    | OAuth 2.0 (3 steps)                   | Simple API Key                 |
| **Credentials**       | Token + RSA + DUKPT                   | API Key + Merchant ID + POS ID |
| **Expiration**        | Tokens expire (refresh)               | API Key permanent              |
| **Encryption**        | DUKPT (terminal-side)                 | Blumon handles (hosted)        |
| **Device**            | Physical PAX terminal                 | Browser (redirect)             |
| **Belongs to**        | Venue (restaurant)                    | External customer              |
| **DB Relation**       | VenuePaymentConfig                    | N/A (standalone)               |
| **Avoqado API Keys**  | NO                                    | pk_live_xxx / sk_live_xxx      |
| **User Flow**         | Tap card                              | Enter details online           |
| **Integration Point** | Android TPV app                       | JavaScript SDK (avoqado-v1.js) |
| **PCI Scope**         | Terminal handles (certified hardware) | Blumon handles (redirect)      |

---

## 3. Why "Ecommerce"? (formerly "External")

The name **EcommerceMerchant** means:

- **Ecommerce** = Online/web-based sales channel (card-not-present)
- **Merchant** = Venue's e-commerce merchant account

**⚠️ IMPORTANT CLARIFICATION (2025-01-13 Update)**:

- `EcommerceMerchant` **DOES belong to venues** (via `venueId` field)
- Same restaurant can have BOTH terminal and e-commerce channels
- Example: "Tacos El Güero" has:
  - `MerchantAccount` (physical terminal in restaurant)
  - `EcommerceMerchant` (online ordering website)

**Real-world examples**:

- **MerchantAccount**: "Tacos El Güero" physical terminal (card-present)
- **EcommerceMerchant**: "Tacos El Güero" online ordering (card-not-present)

**Key distinction**:

- `MerchantAccount` = **Physical terminal** (PAX device in venue)
- `EcommerceMerchant` = **Online channel** (website, mobile app, delivery platforms)

---

## 4. Can They Be Merged Into One Model?

**ANSWER: NO. Technical reasons:**

### **Reason #1: Incompatible Credentials**

```prisma
// MerchantAccount needs:
credentialsEncrypted: {
  oauthAccessToken: "abc123",
  oauthRefreshToken: "xyz789",
  rsaId: 123,
  rsaKey: "HEX...",
  dukptKsn: "key_serial...",
  dukptKey: "derivation_key..."
}

// EcommerceMerchant needs:
providerCredentials: {
  blumonMerchantId: "456",
  blumonApiKey: "simple_key",
  blumonPosId: "376",
  webhookSecret: "secret"
}

// ⚠️ These are COMPLETELY different structures
```

### **Reason #2: Different Payment Flow Integration**

```prisma
// MerchantAccount: Assigned to venue via VenuePaymentConfig
model MerchantAccount {
  venueConfigsPrimary   VenuePaymentConfig[]  @relation("PrimaryAccount")
  venueConfigsSecondary VenuePaymentConfig[]  @relation("SecondaryAccount")
  // ↑ Physical terminal assigned via payment config
}

// EcommerceMerchant: Direct venue ownership
model EcommerceMerchant {
  venueId String // ⚠️ UPDATED 2025-01-13: Now belongs to venue
  venue   Venue  @relation("VenueEcommerceMerchants", fields: [venueId], references: [id])
  // ↑ E-commerce channel for the same venue
}
```

### **Reason #3: Avoqado API Keys**

```prisma
// MerchantAccount: Does NOT need its own API keys
// (restaurant uses our dashboard, not direct API)

// EcommerceMerchant: DOES need API keys
model EcommerceMerchant {
  publicKey: "pk_live_abc123"   // For frontend calls
  secretKey: "sk_live_xyz789"   // For backend calls
  // ↑ Stripe pattern: external customers access via API
}
```

### **Reason #4: Different Business Models**

| Aspect            | MerchantAccount                 | EcommerceMerchant                |
| ----------------- | ------------------------------- | -------------------------------- |
| **Revenue Model** | Subscription + Transaction fees | Transaction fees only            |
| **Customer**      | Restaurant (our venue)          | External business                |
| **Support Scope** | Full POS + Payments             | Payments only                    |
| **Integration**   | Provided by us (Android app)    | Provided by them (their website) |
| **Relationship**  | Long-term (venue subscription)  | Transactional (per payment)      |

---

## 5. Stripe Analogy

To understand better, **Stripe has the same separation**:

| Avoqado               | Stripe Equivalent                   |
| --------------------- | ----------------------------------- |
| **MerchantAccount**   | Stripe Terminal (physical devices)  |
| **EcommerceMerchant** | Stripe Connect (external merchants) |

### **Stripe Terminal**:

- Physical devices (Verifone, PAX)
- Credentials: Device ID + Location ID
- For businesses using Stripe POS

### **Stripe Connect**:

- Platforms serving other merchants
- Credentials: API Keys + Account IDs
- For marketplaces, SaaS platforms

**Avoqado follows the same industry-standard pattern.**

---

## 6. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│ AVOQADO PAYMENT PROCESSING ARCHITECTURE                        │
└─────────────────────────────────────────────────────────────────┘

INTERNAL CLIENTS (Avoqado Restaurants)
├─ Use: Avoqado Dashboard + Android TPV
├─ Device: Physical PAX terminal
├─ DB Model: MerchantAccount
├─ Blumon Product: PAX Terminal SDK
├─ Credentials: OAuth + RSA + DUKPT
├─ Flow: Customer taps card → Terminal encrypts → Blumon processes
└─ Example: "Tacos El Güero" with PAX A910 terminal

EXTERNAL CLIENTS (E-commerce using our SDK)
├─ Use: Avoqado JavaScript SDK (avoqado-v1.js)
├─ Device: Browser (redirect to Blumon)
├─ DB Model: EcommerceMerchant
├─ Blumon Product: Hosted Checkout API
├─ Credentials: API Key + Merchant ID + POS ID
├─ Flow: Customer buys → Redirect to Blumon → Enter card → Webhook
└─ Example: "Shopify Store ABC" integrating payments with Avoqado

┌─────────────────────────────────────────────────────────────────┐
│ ⚠️ CRITICAL: NOT INTERCHANGEABLE                                │
│                                                                  │
│ MerchantAccount CANNOT use Hosted Checkout API                  │
│ EcommerceMerchant CANNOT use PAX Terminal SDK                    │
│                                                                  │
│ They are different Blumon products with incompatible APIs       │
└─────────────────────────────────────────────────────────────────┘
```

---

## 7. What Would Happen If We Merged Them?

**Hypothetical scenario: Single "Merchant" model**

```prisma
model Merchant {
  id String @id

  // Problem #1: Mutually exclusive fields
  terminalSerialNumber String?  // Only for TPV
  publicKey String?              // Only for SDK
  secretKey String?              // Only for SDK

  // Problem #2: Incompatible credentials
  credentials Json  // OAuth OR API Key? Impossible to know

  // Problem #3: Confusing relationships
  venueId String?  // Optional? When yes, when no?

  // Problem #4: Conditional logic EVERYWHERE
  type MerchantType // "TERMINAL" | "SDK" ← Constant checking
}

// ❌ Result: Bloated model with confusing optional fields
// ❌ Code full of if/else by merchant type
// ❌ Complex validations (some fields required depending on type)
// ❌ Violates Single Responsibility Principle
```

**VS current model (separated):**

```prisma
// ✅ MerchantAccount: All fields are relevant
// ✅ EcommerceMerchant: All fields are relevant
// ✅ No conditionals by type
// ✅ Each model has single responsibility
```

### **Code Complexity Comparison**

**Merged model (BAD)**:

```typescript
// Every function needs type checking
async function processPayment(merchant: Merchant) {
  if (merchant.type === 'TERMINAL') {
    // Use OAuth credentials
    const credentials = merchant.credentials as TerminalCredentials
    // 50 lines of terminal logic
  } else if (merchant.type === 'SDK') {
    // Use API key credentials
    const credentials = merchant.credentials as SDKCredentials
    // 50 lines of SDK logic
  }
  // This pattern repeats in EVERY payment function
}
```

**Separated models (GOOD)**:

```typescript
// Clear separation, no type checking needed
async function processTerminalPayment(account: MerchantAccount) {
  // Only terminal logic, all fields guaranteed to exist
}

async function processSDKPayment(merchant: EcommerceMerchant) {
  // Only SDK logic, all fields guaranteed to exist
}
```

---

## 8. Naming Recommendations

### **Current Names**:

- ✅ `EcommerceMerchant` - Clear that it's external
- ❌ `MerchantAccount` - Confusing (which merchant? internal or external?)

### **Alternative Naming Options**:

#### **Option A: Emphasize integration type**

```prisma
model TerminalMerchantAccount  // ← Physical terminals (TPV)
model SDKMerchant              // ← SDK/API external
```

#### **Option B: Emphasize ownership**

```prisma
model VenueMerchantAccount     // ← Belongs to venues
model EcommerceMerchant         // ← External customers (current)
```

#### **Option C: Emphasize Blumon product**

```prisma
model TerminalSDKAccount       // ← Blumon PAX Terminal SDK
model HostedCheckoutMerchant   // ← Blumon Hosted Checkout
```

### **MY RECOMMENDATION**:

Keep current names BUT add clear documentation comments:

```prisma
/// Terminal-based merchant accounts for card-present payments (PAX devices)
/// Used by Avoqado venues (restaurants) with physical payment terminals
/// Credentials: OAuth tokens, RSA keys, DUKPT encryption keys
/// Blumon Product: PAX Terminal SDK
/// Integration: Android TPV app with Blumon SDK
model MerchantAccount {
  // ... existing fields
}

/// SDK-based merchant accounts for card-not-present payments (e-commerce)
/// Used by external businesses integrating Avoqado payment gateway
/// Credentials: API keys for Hosted Checkout
/// Blumon Product: Hosted Checkout API
/// Integration: JavaScript SDK (avoqado-v1.js) with redirect flow
model EcommerceMerchant {
  // ... existing fields
}
```

---

## 9. How to Explain to Other Developers

### **Short Version (30 seconds)**:

> "We have 2 models because Blumon has 2 different products: PAX Terminal SDK (for physical terminals) and Hosted Checkout API (for
> e-commerce). Each has completely different credentials. MerchantAccount is for our restaurants with physical terminals. EcommerceMerchant
> is for external businesses using our SDK as a payment gateway."

### **Detailed Version (3 minutes)**:

> "Blumon offers two incompatible APIs:
>
> 1. **PAX Terminal SDK** - For physical devices. Requires OAuth (expiring token), RSA keys, and DUKPT keys to encrypt cards. Used by
>    `MerchantAccount` for terminals in Avoqado restaurants.
> 2. **Hosted Checkout API** - For e-commerce. Uses simple API Key (permanent), redirects customer to Blumon's page, and notifies via
>    webhook. Used by `EcommerceMerchant` for businesses integrating our SDK.
>
> They can't be merged because credential structures are incompatible, and use cases are different (internal vs external). It's like Stripe
> Terminal (physical devices) vs Stripe Connect (platform for other merchants)."

### **Technical Deep Dive (for senior engineers)**:

1. **Credentials**: OAuth + RSA + DUKPT vs API Key + Merchant ID
2. **APIs**: tokener/core.blumonpay.net vs ecommerce.blumonpay.com
3. **Flow**: Terminal encryption vs Hosted redirect
4. **Relationships**: Belongs to Venue vs Standalone
5. **Business Model**: Subscription + fees vs Fees only
6. **Integration**: We provide (Android) vs They provide (their site)

---

## 10. Final Recommendation

### **KEEP the 2 models separated.**

**Reasons**:

1. ✅ **Separation of Concerns** - Each model has single responsibility
2. ✅ **Industry Standard** - Follows Stripe Terminal vs Connect pattern
3. ✅ **Avoids Model Bloat** - No confusing optional fields
4. ✅ **Type Safety** - All fields guaranteed to exist
5. ✅ **Clear Relationships** - MerchantAccount → Venue, EcommerceMerchant → Standalone
6. ✅ **Incompatible Credentials** - Cannot share credential structure
7. ✅ **Future Extensibility** - Easy to add new payment methods per type

### **OPTIONAL: Add Documentation**

Update `prisma/schema.prisma` with clear comments:

```prisma
// ==========================================
// NOTE: PAYMENT MERCHANT ACCOUNTS
// ==========================================

/// Card-present payments via PAX physical terminals
/// Used by Avoqado restaurants with on-premise devices
/// Blumon Product: PAX Terminal SDK (OAuth + DUKPT encryption)
///
/// Key Fields:
/// - credentialsEncrypted: OAuth token + RSA keys + DUKPT keys
/// - blumonSerialNumber: Virtual serial for OAuth (e.g., "2841548417")
/// - blumonPosId: Momentum API position ID (e.g., "376")
///
/// Relationships:
/// - Belongs to Venue via VenuePaymentConfig
/// - Links to Terminal (physical device)
/// - Links to ProviderCostStructure (what provider charges us)
model MerchantAccount {
  // ... existing fields
}

// ==========================================
// NOTE: EXTERNAL MERCHANTS (SDK CLIENTS)
// ==========================================

/// Card-not-present payments via hosted checkout
/// Used by external e-commerce businesses integrating Avoqado SDK
/// Blumon Product: Hosted Checkout API (redirect flow + webhooks)
///
/// Key Fields:
/// - publicKey: "pk_live_xxx" or "pk_test_xxx" (for frontend)
/// - secretKeyEncrypted: "sk_live_xxx" (for backend)
/// - providerCredentials: API Key + Merchant ID + POS ID
///
/// Relationships:
/// - NO Venue (standalone external customers)
/// - Links to PaymentProvider
/// - Links to ProviderCostStructure (what provider charges us)
/// - Links to VenuePricingStructure (what we charge them)
model EcommerceMerchant {
  // ... existing fields
}
```

---

## Key Takeaways

1. **Two models = Two different Blumon products** with incompatible APIs
2. **MerchantAccount** = Physical terminals for Avoqado restaurants (OAuth + DUKPT)
3. **EcommerceMerchant** = Hosted checkout for external e-commerce (API Key + redirect)
4. **Cannot be merged** due to incompatible credentials, relationships, and business models
5. **Industry standard** pattern (see Stripe Terminal vs Connect)
6. **Keep separated** for clean architecture and type safety

---

## Related Documentation

- `docs/BLUMON_DOCUMENTATION_INDEX.md` - Complete Blumon integration guide
- `docs/BLUMON_ARCHITECTURE_SUMMARY.txt` - Multi-merchant payment routing
- `docs/BLUMON_MULTI_MERCHANT_ANALYSIS.md` - Detailed technical analysis
- `docs/SDK_PAYMENT_ARCHITECTURE.md` - SDK payment system overview (if exists)
- `prisma/schema.prisma:2008` - MerchantAccount model definition
- `prisma/schema.prisma:2069` - EcommerceMerchant model definition

---

## Change Log

- **2025-01-13**: Initial architecture decision (provider-based ExternalMerchant)
- **2025-01-13**: Documentation created explaining separation rationale
- **2025-01-13**: Renamed `ExternalMerchant` → `EcommerceMerchant` to better reflect that these are e-commerce sales channels for venues,
  not external entities
- **2025-01-13**: Added `venueId` field to `EcommerceMerchant` - now belongs to venues (same business, different sales channel)
