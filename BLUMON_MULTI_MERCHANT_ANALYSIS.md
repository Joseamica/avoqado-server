# Blumon Multi-Merchant Routing System - Complete Architecture Analysis

## Executive Summary

Avoqado's multi-merchant system enables a **single physical PAX terminal** to process payments for **multiple merchant accounts** by leveraging Blumon's ability to assign different "virtual serial numbers" to a single device. This is a **clever workaround** that uses Blumon's credential model to route payments to different accounts within the Momentum API.

---

## 1. Physical vs Virtual Serial Numbers (The Workaround)

### Physical Device
- **PAX A910S Terminal**: Serial number `AVQD-2841548417` (fixed, built-in)
- **Asset**: Single hardware device sitting on the restaurant counter
- **Represents**: One physical payment terminal

### Virtual Serial Numbers (Blumon Workaround)
Blumon allows registering the same physical device **twice** with different credential sets:

| Virtual Serial | Device ID | Purpose | Merchant | Momentum API posId |
|---|---|---|---|---|
| `2841548417` | First registration | Main restaurant | Merchant Account A | `376` |
| `2841548418` | Second registration | Ghost kitchen | Merchant Account B | `378` |

**Key Insight**: These are NOT separate devices—they're the **same physical device registered twice with different credentials**.

---

## 2. Database Architecture

### Core Models

#### A. Terminal Model (Physical Device)
```prisma
model Terminal {
  id              String @id
  serialNumber    String @unique          // Physical serial: "AVQD-2841548417"
  venueId         String
  assignedMerchantIds String[] @default([])  // Array of MerchantAccount IDs
  
  // These merchants handle all payments for this venue
  // Routing logic in Android determines which merchant to use
}
```

**Example**:
```
Terminal(serialNumber="AVQD-2841548417")
├── assignedMerchantIds = ["merchant_001", "merchant_002"]
│   ├── Merchant Account A (Main Restaurant)
│   └── Merchant Account B (Ghost Kitchen)
```

---

#### B. MerchantAccount Model (Virtual Routing)
```prisma
model MerchantAccount {
  id                String @id
  
  // Core routing fields
  providerId        String            // Always "BLUMON" for payment
  externalMerchantId String           // Blumon's merchant ID
  
  // 🆕 Blumon-Specific Multi-Merchant Fields (NEW 2025-11-05)
  blumonSerialNumber String?          // VIRTUAL serial: "2841548417" or "2841548418"
  blumonPosId        String?          // Momentum API position ID: "376" or "378"
  blumonEnvironment  String?          // "SANDBOX" or "PRODUCTION"
  blumonMerchantId   String?          // Blumon's internal merchant identifier
  
  // Encrypted credentials (per merchant account)
  credentialsEncrypted Json           // OAuth tokens + DUKPT keys (PER ACCOUNT)
  providerConfig     Json?            // Flexible provider config
  
  // UI/Business
  displayName        String?          // "Main Account", "Ghost Kitchen", "Facturación"
  alias              String?
  active             Boolean @default(true)
  displayOrder       Int
  
  // Relations
  costStructures     ProviderCostStructure[]
  venueConfigsPrimary   VenuePaymentConfig[] @relation("PrimaryAccount")
  venueConfigsSecondary VenuePaymentConfig[] @relation("SecondaryAccount")
}
```

**Critical Fields for Multi-Merchant**:
- `blumonSerialNumber`: Acts as OAuth username (different per merchant)
- `blumonPosId`: Routes payment to specific Momentum API position
- `credentialsEncrypted`: Each account has SEPARATE OAuth tokens + DUKPT keys

---

#### C. ProviderCostStructure Model (Cost Per Merchant)
```prisma
model ProviderCostStructure {
  id                String @id
  
  // ⭐ CRITICAL: Costs are PER MERCHANT ACCOUNT
  merchantAccountId String           // Links to specific MerchantAccount
  merchantAccount   MerchantAccount  @relation(fields: [merchantAccountId])
  
  // Cost breakdown (what Blumon charges Avoqado)
  debitRate         Decimal          // e.g., 0.015 (1.5%)
  creditRate        Decimal          // e.g., 0.025 (2.5%)
  amexRate          Decimal          // e.g., 0.035 (3.5%)
  internationalRate Decimal          // e.g., 0.040 (4.0%)
  fixedCostPerTransaction Decimal?   // e.g., 0.50 MXN
  
  // Period
  effectiveFrom     DateTime
  effectiveTo       DateTime?
  active            Boolean
  
  @@unique([merchantAccountId, effectiveFrom])
}
```

**Cost Structure Answer**: ✅ **Costs are PER MERCHANT ACCOUNT**
- Two merchant accounts = potentially different rates
- Each merchant's `ProviderCostStructure` is independent
- Blumon negotiates rates **per posId** (virtual serial), not per physical device

---

### The Mapping Relationship

```
┌─────────────────────────────────────────────────────────┐
│ Physical Device (Terminal)                              │
│ Serial: AVQD-2841548417                                 │
└──────────────────────────┬────────────────────────────────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
          ▼                ▼                ▼
    ┌──────────┐      ┌──────────┐      ┌──────────┐
    │ Merchant │      │ Merchant │      │ Merchant │
    │Account A │      │Account B │      │Account C │
    │          │      │          │      │          │
    │ Virtual  │      │ Virtual  │      │ Virtual  │
    │Serial:   │      │Serial:   │      │Serial:   │
    │2841548417│      │2841548418│      │2841548419│
    │          │      │          │      │          │
    │PosId:376 │      │PosId:378 │      │PosId:380 │
    │          │      │          │      │          │
    │Creds:A   │      │Creds:B   │      │Creds:C   │
    │Rate:1.5% │      │Rate:1.8% │      │Rate:2.0% │
    └──────────┘      └──────────┘      └──────────┘
         │                  │                  │
         └──────────────────┴──────────────────┘
               All route to different
            Momentum API positions on
               same physical device
```

---

## 3. Data Flow: Request to Payment

### Step 1: Terminal Configuration Fetch (Android App Startup)

**Endpoint**: `GET /api/v1/tpv/terminals/AVQD-2841548417/config`

**Backend Logic** (terminal.tpv.controller.ts):
```typescript
// 1. Find terminal by physical serial
const terminal = await prisma.terminal.findFirst({
  where: { serialNumber: "AVQD-2841548417" }
});

// 2. Fetch assigned merchant accounts
const merchantAccounts = await prisma.merchantAccount.findMany({
  where: {
    id: { in: terminal.assignedMerchantIds }  // ["merchant_001", "merchant_002"]
  },
  select: {
    id,
    displayName,
    blumonSerialNumber,      // "2841548417", "2841548418"
    blumonPosId,             // "376", "378"
    blumonEnvironment,       // "SANDBOX"
    blumonMerchantId,
    credentialsEncrypted,    // Encrypted OAuth + DUKPT keys
    providerConfig
  }
});

// 3. Return transformed for Android
return {
  terminal: {
    serialNumber: "AVQD-2841548417",
    brand: "PAX",
    model: "A910S"
  },
  merchantAccounts: [
    {
      id: "merchant_001",
      displayName: "Main Account",
      serialNumber: "2841548417",        // ← Virtual serial
      posId: "376",                      // ← Momentum API ID
      environment: "SANDBOX",
      credentials: {...encrypted...}    // ← Per-merchant credentials
    },
    {
      id: "merchant_002",
      displayName: "Ghost Kitchen",
      serialNumber: "2841548418",        // ← Different virtual serial
      posId: "378",                      // ← Different Momentum API ID
      environment: "SANDBOX",
      credentials: {...encrypted...}    // ← Different credentials
    }
  ]
}
```

---

### Step 2: User Selects Merchant (Android UI)

**File**: `MerchantSelectionContent.kt`

User sees:
- "Activa: Main Account" (currently selected)
- Buttons: [Cuenta A] [Cuenta B]

User taps "Cuenta B" → calls:

```kotlin
viewModel.selectMerchant(merchantB)
```

---

### Step 3: Android Switches SDK Context (3-5 seconds)

**File**: `PaymentViewModel.kt` + `MultiMerchantSDKManager.kt`

```kotlin
fun selectMerchant(account: MerchantAccount) {
  viewModelScope.launch {
    try {
      _merchantSwitchingLoading.value = true
      
      // Switch Blumon SDK to use different merchant's credentials
      multiMerchantSDKManager.switchMerchant(account)
      
      // Update UI state
      _currentMerchant.value = account
      
      _merchantSwitchMessage.value = "Switched to ${account.displayName}"
    } catch (e: Exception) {
      _merchantSwitchMessage.value = "Error: ${e.message}"
    } finally {
      _merchantSwitchingLoading.value = false
    }
  }
}
```

**MultiMerchantSDKManager** internally:
1. Fetches credentials for new merchant (decrypts from app storage)
2. Calls Blumon `InitializerUseCase` with **new posId** ("378" for Merchant B)
3. Downloads new DUKPT keys for virtual serial "2841548418"
4. Updates SDK's internal state
5. Returns to ready state

---

### Step 4: Payment Processing (With Selected Merchant)

**Payment Flow**:
```
User inputs amount ($100)
    ↓
User selects merchant (Merchant B)
    ↓
Android shows: "Processing with Cuenta B (Virtual Serial 2841548418)"
    ↓
PreTrans → DetectCard → EMV Transaction
    ↓
SDK sends payment to Blumon Momentum API
    with posId = "378"  ← Routes to Merchant B's Momentum account
    ↓
Blumon routes to Merchant B's bank
    ↓
Transaction completes
```

---

### Step 5: Record Payment (Backend)

**Endpoint**: `POST /api/v1/tpv/venues/{venueId}/orders/{orderId}/payment`

**Request Body** (from Android):
```json
{
  "method": "CARD",
  "amount": 10000,          // cents
  "tip": 1000,
  "status": "COMPLETED",
  "cardBrand": "VISA",
  "last4": "4242",
  "mentaOperationId": "...",  // or Blumon transaction ID
  "staffId": "staff_123"
}
```

**Key Missing Field** ⚠️: The current payment recording does NOT include `merchantAccountId`. This needs to be added to track which merchant processed the payment.

---

## 4. Credential Management (The Technical Challenge)

### How Credentials Are Stored

**Per-Merchant Encryption** (`MerchantAccount.credentialsEncrypted`):

```
MerchantAccount A:
  credentialsEncrypted = {
    encrypted: "hex_string_...",
    iv: "hex_string_..."
  }
  Contents (when decrypted):
  {
    oauthAccessToken: "access_token_for_serial_2841548417",
    oauthRefreshToken: "refresh_token_...",
    rsaId: 123,
    rsaKey: "hex_rsa_public_key",
    dukptKsn: "key_serial_number_2841548417",
    dukptKey: "encrypted_base_derivation_key"
  }

MerchantAccount B:
  credentialsEncrypted = {
    encrypted: "hex_string_...",
    iv: "hex_string_..."
  }
  Contents (when decrypted):
  {
    oauthAccessToken: "access_token_for_serial_2841548418",
    oauthRefreshToken: "refresh_token_...",
    rsaId: 124,
    rsaKey: "hex_rsa_public_key",
    dukptKsn: "key_serial_number_2841548418",
    dukptKey: "encrypted_base_derivation_key"
  }
```

### OAuth Flow (Per Merchant)

**Blumon Service** (`blumon.service.ts`) - 3-step process:

```typescript
// Step 1: Get OAuth Token
const token = await blumonService.getAccessToken(
  serialNumber: "2841548417",  // OR "2841548418" for Merchant B
  brand: "PAX",
  model: "A910S"
);
// Returns: { accessToken, refreshToken, posId: "376" }

// Step 2: Get RSA Keys (for encrypting DUKPT requests)
const rsa = await blumonService.getRSAKeys(
  accessToken,
  posId: "376"  // ← Different per merchant
);

// Step 3: Get DUKPT Keys (for card data encryption)
const dukpt = await blumonService.getDUKPTKeys(
  accessToken,
  posId: "376",
  rsaKey
);
```

**Critical**: Each virtual serial number gets its own:
- OAuth tokens (tied to serial)
- RSA keys (tied to posId)
- DUKPT keys (tied to serial for card encryption)

---

## 5. Android TPV Implementation

### Model Classes

**MerchantAccount.kt** (Domain Model):
```kotlin
data class MerchantAccount(
    val id: String,
    val serialNumber: String,          // "2841548417" or "2841548418"
    val posId: String?,                // "376" or "378"
    val displayName: String,           // "Main Restaurant"
    val environment: MerchantEnvironment  // SANDBOX or PRODUCTION
)
```

**MerchantSelectionContent.kt** (UI):
- Shows list of available merchants
- User taps to select
- Shows current active merchant highlighted

### Payment ViewModel Flow

**PaymentViewModel.kt**:
```kotlin
// Multi-merchant state
val merchants: StateFlow<List<MerchantAccount>>
val currentMerchant: StateFlow<MerchantAccount?>

// User selects merchant
fun selectMerchant(account: MerchantAccount) {
  // Switches SDK context (3-5 seconds)
  // Updates currentMerchant
  // Enables payment button
}

// User initiates payment
fun startPayment() {
  // Uses currentMerchant's credentials
  // SDK knows to route via currentMerchant's posId
}
```

---

## 6. Payment Routing Logic

### How Blumon Routes Based on Virtual Serial

```
┌─────────────────────────────────────────────────────────────┐
│ Android App                                                  │
│ User selects "Cuenta B"                                     │
└────────────────────────┬──────────────────────────────────────┘
                         │
                         ▼
        ┌────────────────────────────────────┐
        │ Blumon SDK (Multi-Merchant)        │
        │                                    │
        │ Current Context:                   │
        │ - Serial: 2841548418              │
        │ - PosId: 378                      │
        │ - Credentials: Merchant B         │
        │ - DUKPT Keys: For Serial 2841548418│
        └────────────────────┬───────────────┘
                            │
                            ▼
             ┌──────────────────────────────┐
             │ Blumon Momentum API          │
             │ POST /sale                   │
             │                              │
             │ Headers:                     │
             │ posId: 378                   │
             │ OAuth: Merchant B token      │
             │                              │
             │ Body:                        │
             │ amount: 100.00 MXN           │
             │ currency: MXN                │
             │ encrypted_card_data: {...}   │
             └──────────────┬───────────────┘
                            │
                    ┌───────┴────────┐
                    │                │
                    ▼                ▼
            ┌─────────────┐  ┌─────────────┐
            │Merchant B's │  │ CLABE Bank  │
            │Bank Account │  │ (Merchant B)│
            │(BBVA)       │  │ 18-digit    │
            └─────────────┘  └─────────────┘
```

**Answer**: Routing is determined by:
1. **Virtual Serial Number** → OAuth username
2. **PosId** → Momentum API position
3. **Credentials** → Access token for that merchant
4. **DUKPT Keys** → Card encryption for that serial

---

## 7. Cost Structure Assignment

### Per-Merchant Costs

**ProviderCostStructure** is linked to **MerchantAccount**, not Terminal:

```
Terminal AVQD-2841548417
│
├── MerchantAccount A (Serial 2841548417)
│   └── ProviderCostStructure
│       ├── debitRate: 1.5%
│       ├── creditRate: 2.5%
│       ├── fixedCostPerTransaction: 0.50 MXN
│       └── effectiveFrom: 2025-01-01
│
└── MerchantAccount B (Serial 2841548418)
    └── ProviderCostStructure
        ├── debitRate: 1.8%        ← DIFFERENT!
        ├── creditRate: 2.8%       ← DIFFERENT!
        ├── fixedCostPerTransaction: 0.75 MXN  ← DIFFERENT!
        └── effectiveFrom: 2025-01-01
```

**Why Different Costs?**
- Merchant A: 100 transactions/month → 1.5% rate
- Merchant B: 10,000 transactions/month → 1.8% rate (volume discount)
- Blumon negotiates **per posId**, not per device

---

## 8. Admin Configuration (Superadmin Perspective)

### Creating Multi-Merchant Terminal

**Endpoint**: `POST /api/v1/superadmin/merchantAccounts`

**Step 1: Create Merchant Account A**
```json
{
  "providerId": "provider_blumon",
  "externalMerchantId": "ext_merchant_001",
  "displayName": "Main Account",
  "blumonSerialNumber": "2841548417",
  "blumonPosId": "376",
  "blumonEnvironment": "SANDBOX",
  "blumonMerchantId": "blumon_merchant_a",
  "credentials": {
    "oauthAccessToken": "...",
    "oauthRefreshToken": "...",
    "rsaId": 123,
    "dukptKsn": "...",
    "dukptKey": "..."
  }
}
```

**Step 2: Create Merchant Account B**
```json
{
  "providerId": "provider_blumon",
  "externalMerchantId": "ext_merchant_002",
  "displayName": "Ghost Kitchen",
  "blumonSerialNumber": "2841548418",  ← DIFFERENT virtual serial
  "blumonPosId": "378",                 ← DIFFERENT posId
  "blumonEnvironment": "SANDBOX",
  "blumonMerchantId": "blumon_merchant_b",
  "credentials": {
    "oauthAccessToken": "...",  ← DIFFERENT token
    "oauthRefreshToken": "...",
    "rsaId": 124,
    "dukptKsn": "...",           ← DIFFERENT KSN
    "dukptKey": "..."
  }
}
```

**Step 3: Assign to Terminal**
```typescript
// POST /api/v1/superadmin/terminals/:terminalId/merchants
await prisma.terminal.update({
  where: { id: "term_123" },
  data: {
    assignedMerchantIds: ["merchant_001", "merchant_002"]
  }
});
```

**Step 4: Set Cost Structures**
```typescript
// Create cost structure for Merchant A
await prisma.providerCostStructure.create({
  data: {
    merchantAccountId: "merchant_001",
    providerId: "provider_blumon",
    debitRate: 0.015,
    creditRate: 0.025,
    effectiveFrom: new Date()
  }
});

// Create different cost structure for Merchant B
await prisma.providerCostStructure.create({
  data: {
    merchantAccountId: "merchant_002",
    providerId: "provider_blumon",
    debitRate: 0.018,           // DIFFERENT!
    creditRate: 0.028,           // DIFFERENT!
    effectiveFrom: new Date()
  }
});
```

---

## 9. Real Example: Multi-Merchant Restaurant

### Business Setup
- **Restaurant**: "Casa Maria"
- **Main Location**: Main dining room (Merchant A)
- **Ghost Kitchen**: Off-premises delivery kitchen (Merchant B)

### Terminal Configuration

```
┌──────────────────────────────────┐
│ Terminal: AVQD-2841548417        │
│ Location: Casa Maria Main        │
│                                  │
│ Assigned Merchants:              │
│ 1. Merchant Account A            │
│    Display: "Casa Maria Dine-In" │
│    Serial: 2841548417            │
│    PosId: 376                    │
│    Rate: 1.5% + 0.50 MXN fee     │
│                                  │
│ 2. Merchant Account B            │
│    Display: "Casa Maria Delivery"│
│    Serial: 2841548418            │
│    PosId: 378                    │
│    Rate: 1.8% + 0.75 MXN fee     │
└──────────────────────────────────┘
```

### Payment Scenarios

**Scenario 1: Dine-in Customer**
1. Cashier enters amount: $500
2. Shows rating/tip screens
3. Before payment: "¿Cuál cuenta?" → Selects "Casa Maria Dine-In"
4. SDK reinitializes (3-5 seconds) with Serial 2841548417
5. Customer taps card
6. Payment routes to Merchant A's CLABE account
7. Fee calculated: $500 × 1.5% + $0.50 = $8.00

**Scenario 2: Delivery Order (Ghost Kitchen)**
1. Cashier enters amount: $300
2. Shows rating/tip screens
3. Before payment: "¿Cuál cuenta?" → Selects "Casa Maria Delivery"
4. SDK reinitializes (3-5 seconds) with Serial 2841548418
5. Customer taps card
6. Payment routes to Merchant B's CLABE account
7. Fee calculated: $300 × 1.8% + $0.75 = $6.15

---

## 10. Key Answers to Your Questions

### Q1: Is there a distinction between physical vs virtual serial?

✅ **YES**
- **Physical**: `AVQD-2841548417` (built-in PAX device serial)
- **Virtual**: `2841548417`, `2841548418` (Blumon registrations for multi-merchant routing)

### Q2: What are blumonPosId vs blumonSerialNumber vs blumonMerchantId?

| Field | Example | Purpose | Used By |
|---|---|---|---|
| `blumonSerialNumber` | `2841548417` | OAuth username + card encryption | Blumon SDK, Android app |
| `blumonPosId` | `376` | Momentum API position ID | Payment routing, cost lookup |
| `blumonMerchantId` | `merchant_blumon_a` | Blumon's internal identifier | Backend configuration |

### Q3: Cost structure per merchant or per device?

✅ **PER MERCHANT ACCOUNT**
- Merchant A: 1.5% rate
- Merchant B: 1.8% rate (on same device)
- Different `ProviderCostStructure` records linked to different `MerchantAccount` records

### Q4: Credential switching logic?

```
Select "Cuenta B"
  ↓
MultiMerchantSDKManager.switchMerchant(merchantB)
  ├─ Decrypt merchant B's credentials
  ├─ Call Blumon InitializerUseCase(posId=378)
  ├─ Download DUKPT keys for serial 2841548418
  └─ Update SDK context
  ↓
Ready for payment (3-5 seconds)
```

### Q5: How does payment know which merchant?

**Current Issue**: Payment recording (`recordOrderPayment`) doesn't include `merchantAccountId`.

**Should Add**:
```kotlin
// Android: Include merchant ID with payment
val paymentData = PaymentCreationData(
  amount = 10000,
  tip = 1000,
  merchantAccountId = currentMerchant.id,  // ← ADD THIS
  ...
)
```

---

## 11. Architecture Diagram (Complete)

```
┌─────────────────────────────────────────────────────────────────┐
│                    AVOQADO MULTI-MERCHANT SYSTEM                │
└─────────────────────────────────────────────────────────────────┘

                         ┌──────────────────┐
                         │  Restaurant      │
                         │  Casa Maria      │
                         └────────┬─────────┘
                                  │
                    ┌─────────────┴────────────────┐
                    │                              │
              ┌─────▼────────┐          ┌─────────▼──────┐
              │   Main        │          │  Ghost Kitchen │
              │ Dining Room   │          │   (Delivery)   │
              └──────┬────────┘          └────────┬───────┘
                     │                           │
                     └─────────────┬─────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │ PAX A910S Terminal           │
                    │ Serial: AVQD-2841548417      │
                    │ Location: Main Counter       │
                    └────────┬──────────────────────┘
                             │
                    ┌────────┴──────────┐
                    │                   │
              ┌─────▼──────────┐   ┌───▼────────────┐
              │ Merchant Acct A│   │ Merchant Acct B│
              │                │   │                │
              │ Serial:        │   │ Serial:        │
              │ 2841548417     │   │ 2841548418     │
              │                │   │                │
              │ PosId: 376     │   │ PosId: 378     │
              │                │   │                │
              │ Rate: 1.5%     │   │ Rate: 1.8%     │
              │ Fee: 0.50 MXN  │   │ Fee: 0.75 MXN  │
              │                │   │                │
              │ Credentials:   │   │ Credentials:   │
              │ Token A        │   │ Token B        │
              │ DUKPT A        │   │ DUKPT B        │
              └──────┬─────────┘   └────┬───────────┘
                     │                   │
                     │ (OAuth)           │ (OAuth)
                     │                   │
         ┌───────────┴───────────────────┴───────────┐
         │                                           │
         ▼                                           ▼
    ┌─────────────────────┐            ┌─────────────────────┐
    │ Blumon Momentum API │            │ Blumon Momentum API │
    │ PosId: 376          │            │ PosId: 378          │
    │ Merchant A Account  │            │ Merchant B Account  │
    └─────────┬───────────┘            └─────────┬───────────┘
              │                                  │
         ┌────▼──────────────────────────────────▼────┐
         │                                            │
         ▼                                            ▼
    ┌──────────────┐                          ┌──────────────┐
    │ BBVA México  │                          │ Santander    │
    │ (Merchant A) │                          │ (Merchant B) │
    │              │                          │              │
    │ CLABE:       │                          │ CLABE:       │
    │ 0021-2345... │                          │ 0142-5678... │
    └──────────────┘                          └──────────────┘
```

---

## 12. Technical Stack Summary

| Component | Technology | Purpose |
|---|---|---|
| **Backend** | Node.js + Prisma | Database + API |
| **Database** | PostgreSQL | Multi-merchant config storage |
| **Android** | Kotlin + Hilt | TPV app |
| **Payment SDK** | Blumon PAX | EMV + contactless processing |
| **Encryption** | AES-256-CBC | Credential storage |

---

## 13. Remaining Work

### Backend
- [ ] Verify Blumon API endpoints for terminal config
- [ ] Implement credential auto-refresh logic
- [ ] Add `merchantAccountId` to payment recording

### Android
- [ ] Test multi-merchant switching (3-5 second lag)
- [ ] Verify SDK state after merchant switch
- [ ] Handle network errors during switch

### Database
- [ ] Seed sample multi-merchant configuration
- [ ] Document cost structure creation workflow

---

**Document Version**: 2025-11-06
**Status**: Complete (Blumon Multi-Merchant Architecture Explained)
