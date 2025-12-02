# Blumon E-commerce OAuth 2.0 Implementation (Web Checkout Only)

## ⚠️ CRITICAL: Two Separate Blumon Integrations

**This documentation is for Blumon E-commerce Integration (Web Checkout ONLY)**

### 🚨 Are You in the Right Place?

Before reading further, confirm you need **Blumon E-commerce Integration**:

✅ **You're in the right place if:**

- You need **online payments** (web/mobile browser checkout)
- Customer **enters card details** on a web page
- You're integrating with a **web store** or **e-commerce site**
- Payment flow uses **webhooks** (asynchronous)
- You need a **hosted checkout page**
- You work with `EcommerceMerchant` and `CheckoutSession` models

❌ **You're in the WRONG place if:**

- You need **in-person payments** at a restaurant
- You have a **PAX Android terminal** (physical device)
- Payment happens via **card reader** (tap/swipe/chip)
- Payment is **synchronous** (immediate real-time response)
- You work with `MerchantAccount` and `Terminal` models
- → **Read `docs/BLUMON_MULTI_MERCHANT_ANALYSIS.md` instead!**

### 📖 Understanding the Two Integrations

⚠️ **MUST READ FIRST**: `docs/BLUMON_TWO_INTEGRATIONS.md` - Complete distinction between:

1. **Blumon E-commerce Integration** (Web Checkout) ← **THIS DOCUMENTATION**

   - Platform: Web browsers, mobile web
   - Models: `EcommerceMerchant` + `CheckoutSession`
   - Authentication: OAuth 2.0 Bearer tokens
   - API: `https://sandbox-ecommerce.blumonpay.net`
   - Service: `src/services/sdk/blumon-ecommerce.service.ts`

2. **Blumon Android SDK** (Physical Terminals) ← **DIFFERENT INTEGRATION**
   - Platform: Android TPV app (PAX terminals)
   - Models: `MerchantAccount` + `Terminal`
   - Authentication: Terminal credentials (POS ID + Serial)
   - API: `https://api-sbx.blumonpay.net`
   - Service: `src/services/tpv/blumon-tpv.service.ts`

**DO NOT confuse these two integrations!** They use:

- Different APIs
- Different database models
- Different authentication methods
- Different payment flows
- Different documentation

---

## 📋 Status: Authentication Complete, Checkout Integration Pending API Specification

---

## ✅ Completed Implementation (2025-11-14)

### 1. OAuth 2.0 Authentication Service

**File**: `src/services/blumon/blumonAuth.service.ts`

**Features Implemented**:

- ✅ Password-based OAuth 2.0 authentication (Password Grant)
- ✅ SHA-256 password hashing (Blumon requirement)
- ✅ Access token retrieval (3-hour validity)
- ✅ Refresh token support
- ✅ Token expiration checking with configurable buffer
- ✅ Sandbox and production environment support
- ✅ Comprehensive error handling and logging

**Authentication Endpoints**:

- **Sandbox**: `https://sandbox-tokener.blumonpay.net/oauth/token`
- **Production**: TBD (contact Blumon support)

**Credentials (Sandbox Master)**:

```typescript
{
  username: 'jose@avoqado.io',
  password: 'U!Sr{9DHN4-wKH|' // SHA-256 hashed before sending
}
```

**Token Response**:

```typescript
{
  accessToken: string,      // JWT Bearer token
  tokenType: 'bearer',      // Always 'bearer'
  expiresIn: 10799,         // 3 hours in seconds
  expiresAt: Date,          // Calculated expiration timestamp
  refreshToken: string,     // For token refresh
}
```

**JWT Payload Example**:

```json
{
  "userEntity": 462,
  "country": "mx",
  "business": 462,
  "user_name": "jose@avoqado.io",
  "corporation": 2,
  "sandbox": true,
  "userId": 768,
  "authorities": [
    "CANCELACIÓN ONLINE",
    "REVERSO ONLINE",
    "DEVOLUCIÓN ONLINE",
    "PAYMENTMETHOD CREDITO O DEBITO",
    "VENTA ONLINE",
    "AUTORIZACIÓN ONLINE",
    "CAPTURA ONLINE"
  ],
  "system": 6
}
```

---

### 2. Authentication Script

**File**: `scripts/blumon-authenticate-master.ts`

**Purpose**: Authenticate with Blumon master credentials and update all sandbox EcommerceMerchants with OAuth tokens.

**Usage**:

```bash
npx ts-node -r tsconfig-paths/register scripts/blumon-authenticate-master.ts
```

**What It Does**:

1. Authenticates with Blumon using master credentials
2. Obtains access token (3 hours validity) and refresh token
3. Finds all active Blumon sandbox EcommerceMerchants
4. Updates `providerCredentials` field with:
   - `accessToken`
   - `refreshToken`
   - `tokenType`
   - `expiresIn`
   - `expiresAt`
   - `authenticatedAt`
   - `authenticatedBy`

**Output Example**:

```
✅ Found 1 Blumon merchant(s)
✅ Updated: Tienda Web (Blumon) (Avoqado Full)

🔑 OAuth Tokens:
   Access Token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
   Expires At: 2025-11-14T18:27:31.121Z
   Valid For: 3 hours
```

---

### 3. EcommerceMerchant Seed Data

**File**: `prisma/seed.ts`

**Changes**:

- ✅ Added 3 e-commerce merchant samples (2 Menta, 1 Blumon)
- ✅ Blumon merchant with placeholder credentials structure
- ✅ API key generation and encryption helpers
- ✅ Proper cleanup in deleteMany section

**Blumon Merchant Structure**:

```typescript
{
  channelName: 'Tienda Web (Blumon)',
  businessName: 'Avoqado Full Blumon E-commerce',
  providerId: blumonProvider.id,
  providerCredentials: {
    merchantEmail: 'jose@avoqado.io',
    environment: 'SANDBOX',
    // OAuth tokens populated by authentication script:
    accessToken: '...',
    refreshToken: '...',
    expiresAt: '...',
  },
  sandboxMode: true,
  active: true,
}
```

---

### 4. Blumon E-commerce Service (Updated for OAuth 2.0)

**File**: `src/services/sdk/blumon-ecommerce.service.ts`

**Changes Made**:

- ✅ Replaced API key authentication with OAuth 2.0 Bearer tokens
- ✅ Updated `BlumonHostedCheckoutRequest` interface to use `accessToken`
- ✅ Updated all methods to use `Authorization: Bearer {token}` header
- ✅ Removed legacy HMAC signature generation (not needed with OAuth)
- ✅ Updated base URLs: `.blumonpay.net` (not `.com`)
- ✅ Comprehensive logging and error handling

**Authentication Pattern**:

```typescript
// Before (API key)
headers: {
  'X-API-Key': apiKey,
}

// After (OAuth 2.0)
headers: {
  Authorization: `Bearer ${accessToken}`,
}
```

---

### 5. Checkout Session Service Integration

**File**: `src/services/sdk/checkout-session.service.ts`

**Features Implemented**:

- ✅ Automatic token retrieval from EcommerceMerchant
- ✅ Token expiration checking before API calls
- ✅ Automatic token refresh if expired (5-minute buffer)
- ✅ Blumon checkout URL generation integration
- ✅ Checkout session status management
- ✅ Error handling with session rollback
- ✅ Metadata storage (Blumon checkout ID, success/cancel URLs)

**Flow**:

```
1. Create CheckoutSession in database
2. Retrieve EcommerceMerchant with OAuth credentials
3. Check if token is expired (5-min buffer)
4. Refresh token if needed → Update merchant
5. Call BlumonEcommerceService.createHostedCheckout()
6. Store Blumon checkout URL and metadata
7. Return checkout URL to client
```

**Token Refresh Logic**:

```typescript
if (blumonAuthService.isTokenExpired(expiresAt, 5)) {
  const refreshResult = await blumonAuthService.refreshToken(...)
  // Update merchant with new tokens
  await prisma.ecommerceMerchant.update(...)
  accessToken = refreshResult.accessToken
}
```

---

### 6. Test Scripts

#### Authentication Test

**File**: `scripts/check-blumon-merchant.ts`

**Purpose**: Verify Blumon merchants exist and have OAuth credentials.

**Usage**:

```bash
npx ts-node -r tsconfig-paths/register scripts/check-blumon-merchant.ts
```

#### Checkout Flow Test

**File**: `scripts/test-blumon-checkout-flow.ts`

**Purpose**: End-to-end test of OAuth flow with checkout session creation.

**Usage**:

```bash
npx ts-node -r tsconfig-paths/register scripts/test-blumon-checkout-flow.ts
```

**Test Coverage**:

1. ✅ Verify Blumon merchant exists
2. ✅ Verify OAuth credentials are present
3. ✅ Create checkout session
4. ⚠️ Generate Blumon checkout URL (pending API endpoint)
5. ✅ Verify metadata storage

---

## ⚠️ Pending Implementation

### Missing Blumon API Endpoint Specification

**Issue**: Blumon documentation mentions a "Checkout (Payment Link)" feature, but the exact endpoint specification is not publicly
documented.

**Attempted Endpoints**:

```
❌ POST /api/v1/checkout/create  (ENOTFOUND)
❓ POST /ecommerce/checkout       (Current guess)
❓ POST /checkout/create          (Alternative)
❓ POST /paymentLink/create       (Alternative)
```

**Known Working Endpoints**:

```
✅ POST /oauth/token              (Authentication)
✅ POST /cardToken/add            (Card tokenization)
✅ POST /ecommerce/charge         (Direct charge)
✅ POST /mpi/3ds-registry         (3D Secure)
```

**Next Steps**:

1. **Contact Blumon Support**: support@blumonpay.com

   - Request hosted checkout/payment link API specification
   - Ask for complete endpoint documentation
   - Request sandbox testing credentials for checkout feature

2. **Alternative Approach** (if hosted checkout unavailable):

   - Implement direct charge flow using `/ecommerce/charge`
   - Build custom checkout form on Avoqado frontend
   - Use card tokenization → charge pattern

3. **Developer Portal Access**:
   - Check if Blumon has a developer portal with full API docs
   - Request access if available

---

## 🔧 Configuration

### Environment Variables

Add to `.env`:

```bash
# Blumon OAuth 2.0 (already configured)
BLUMON_MASTER_USERNAME=jose@avoqado.io
BLUMON_MASTER_PASSWORD=U!Sr{9DHN4-wKH|

# Checkout URLs
FRONTEND_URL=https://app.avoqado.io
BACKEND_URL=https://api.avoqado.io

# Blumon Webhook URL
BLUMON_WEBHOOK_URL=${BACKEND_URL}/sdk/webhooks/blumon
```

### Prisma Schema

EcommerceMerchant fields:

```prisma
model EcommerceMerchant {
  id                   String   @id @default(cuid())
  venueId              String
  channelName          String
  businessName         String?
  providerId           String
  providerCredentials  Json     // Stores OAuth tokens
  sandboxMode          Boolean  @default(true)
  active               Boolean  @default(true)
  // ... other fields
}
```

**providerCredentials Structure**:

```json
{
  "merchantEmail": "jose@avoqado.io",
  "environment": "SANDBOX",
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "tokenType": "bearer",
  "expiresIn": 10799,
  "expiresAt": "2025-11-14T18:27:31.121Z",
  "authenticatedAt": "2025-11-14T15:27:32.156Z",
  "authenticatedBy": "jose@avoqado.io",
  "refreshedAt": "2025-11-14T16:30:00.000Z"
}
```

---

## 📚 API Documentation

### Blumon API Base URLs

| Environment    | Service        | URL                                       |
| -------------- | -------------- | ----------------------------------------- |
| **Sandbox**    | Authentication | `https://sandbox-tokener.blumonpay.net`   |
| **Sandbox**    | E-commerce     | `https://sandbox-ecommerce.blumonpay.net` |
| **Sandbox**    | Portal         | `https://sandbox-atom.blumonpay.net`      |
| **Production** | Authentication | TBD                                       |
| **Production** | E-commerce     | `https://ecommerce.blumonpay.net`         |

### Authentication Headers

All e-commerce API calls must include:

```http
Authorization: Bearer {access_token}
Content-Type: application/json
```

### Token Lifecycle

1. **Initial Authentication**:

   ```bash
   npx ts-node -r tsconfig-paths/register scripts/blumon-authenticate-master.ts
   ```

2. **Automatic Refresh** (checkout session service):

   - Checks expiration before API calls (5-minute buffer)
   - Refreshes token if expired
   - Updates EcommerceMerchant with new tokens

3. **Manual Refresh** (if needed):

   ```typescript
   import { blumonAuthService } from '@/services/blumon/blumonAuth.service'

   const result = await blumonAuthService.refreshToken(refreshToken, true)
   // Update merchant with result.accessToken, result.refreshToken, etc.
   ```

---

## 🧪 Testing

### 1. Verify Authentication Works

```bash
# Authenticate and store tokens
npx ts-node -r tsconfig-paths/register scripts/blumon-authenticate-master.ts

# Verify tokens are stored
npx ts-node -r tsconfig-paths/register scripts/check-blumon-merchant.ts
```

Expected output:

```
✅ Found 1 Blumon EcommerceMerchant(s):
   Tienda Web (Blumon) (Avoqado Full)
   Credentials: { accessToken: "...", expiresAt: "..." }
```

### 2. Test Checkout Flow (Pending API Endpoint)

```bash
npx ts-node -r tsconfig-paths/register scripts/test-blumon-checkout-flow.ts
```

Current result:

```
✅ OAuth credentials: Valid
✅ Checkout session created
❌ Blumon checkout URL: Pending endpoint specification
```

### 3. Test Token Refresh

Set `expiresAt` to past date in database, then run checkout test:

```sql
UPDATE "EcommerceMerchant"
SET "providerCredentials" = jsonb_set(
  "providerCredentials"::jsonb,
  '{expiresAt}',
  '"2025-01-01T00:00:00.000Z"'
)
WHERE "channelName" = 'Tienda Web (Blumon)';
```

Then run test → should see "Token expired, refreshing..." in logs.

---

## 🚨 Important Notes

### Sandbox Availability

**⚠️ Blumon sandbox is only available Monday-Friday, 8:00 AM - 2:00 AM CST**

If you get DNS errors outside these hours, this is expected.

### Production Credentials

- Sandbox credentials: `jose@avoqado.io` (already configured)
- Production credentials: Contact Blumon support for provisioning

### Security Considerations

1. **Token Storage**: OAuth tokens stored in database (encrypted via Prisma)
2. **Token Expiration**: 3 hours (auto-refresh implemented)
3. **Refresh Tokens**: Stored and used automatically
4. **Master Credentials**: Stored in script (move to env vars in production)

---

## 📞 Support Contacts

- **Blumon Technical Support**: support@blumonpay.com
- **API Documentation**: https://www.blumonpay.com/documentacion/
- **Sandbox Portal**: https://sandbox-atom.blumonpay.net

---

## 🎯 Next Actions

### Immediate (Required for Completion)

1. [ ] Contact Blumon support for hosted checkout endpoint specification
2. [ ] Update `blumon-ecommerce.service.ts` with correct endpoint
3. [ ] Test full checkout flow with real API
4. [ ] Implement webhook handler for payment completion
5. [ ] Test payment success/failure flows

### Future Enhancements

1. [ ] Implement 3D Secure authentication flow
2. [ ] Add card tokenization support
3. [ ] Create retry logic for failed payments
4. [ ] Add checkout session expiration cron job
5. [ ] Implement payment status polling (fallback if webhook fails)
6. [ ] Add production environment support
7. [ ] Move master credentials to environment variables

---

## 📝 Change Log

**2025-11-14 - Initial Implementation**

- ✅ Created BlumonAuthService with OAuth 2.0 support
- ✅ Implemented authentication script
- ✅ Updated seed data with Blumon merchant
- ✅ Converted BlumonEcommerceService to use OAuth tokens
- ✅ Integrated checkout session service with token management
- ✅ Created test scripts for verification
- ⚠️ Pending: Blumon hosted checkout endpoint specification

---

## 📖 References

- [Blumon Documentation](https://www.blumonpay.com/documentacion/)
- [OAuth 2.0 Password Grant RFC](https://datatracker.ietf.org/doc/html/rfc6749#section-4.3)
- [JWT Token Format](https://jwt.io/)

---

**Document Status**: ✅ Complete (Authentication) / ⚠️ Pending (Checkout API) **Last Updated**: 2025-11-14 **Author**: Claude Code + Avoqado
Team
