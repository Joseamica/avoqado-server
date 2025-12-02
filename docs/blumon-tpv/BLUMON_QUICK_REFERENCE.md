# Blumon Multi-Merchant System - Quick Reference Guide

## Key Insight (ONE SENTENCE)

**One physical PAX device can process payments for multiple merchants by registering different "virtual serial numbers" with Blumon, routing
each to a different Momentum API account.**

---

## Critical File Locations

### Backend (Node.js)

| File                                                     | Purpose                     | Key Content                                                                      |
| -------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------- |
| `/prisma/schema.prisma:1958`                             | MerchantAccount model       | `blumonSerialNumber`, `blumonPosId`, `blumonEnvironment`, `credentialsEncrypted` |
| `/prisma/schema.prisma:2116`                             | ProviderCostStructure model | **Costs per MerchantAccount** (not per Terminal)                                 |
| `/src/controllers/tpv/terminal.tpv.controller.ts:83`     | Terminal config endpoint    | Returns all merchants assigned to terminal                                       |
| `/src/services/tpv/blumon-tpv.service.ts:1`              | Blumon OAuth + DUKPT        | 3-step credential fetch (OAuth → RSA → DUKPT)                                    |
| `/src/services/superadmin/merchantAccount.service.ts:70` | Merchant account creation   | Handles multi-merchant setup                                                     |

---

### Android TPV (Kotlin)

| File                                                            | Purpose                  | Key Content                                           |
| --------------------------------------------------------------- | ------------------------ | ----------------------------------------------------- |
| `/features/payment/domain/model/MerchantAccount.kt:41`          | Domain model             | `serialNumber`, `posId`, `displayName`, `environment` |
| `/features/payment/presentation/MerchantSelectionContent.kt:32` | Merchant selection UI    | Shows available merchants, user selects one           |
| `/features/payment/presentation/PaymentViewModel.kt:113`        | Payment state management | `currentMerchant`, `merchants`, `selectMerchant()`    |
| `/features/payment/data/MultiMerchantSDKManager.kt`             | SDK switching            | Reinitializes Blumon SDK for new merchant (3-5 sec)   |

---

## The Three Serial Numbers (Confusion Clarifier)

```
┌─────────────────────────────────────────────────────────┐
│ Physical Device Serial (Hardware)                       │
│ AVQD-2841548417                                         │
│ (Built into PAX A910S device, fixed)                    │
└──────────────────────┬──────────────────────────────────┘
                       │
       ┌───────────────┴───────────────┐
       │                               │
       ▼                               ▼
┌──────────────────────┐       ┌──────────────────────┐
│ Virtual Serial A     │       │ Virtual Serial B     │
│ 2841548417           │       │ 2841548418           │
│ (Blumon registration)│       │ (Blumon registration)│
│ OAuth username       │       │ OAuth username       │
│ DUKPT key ID         │       │ DUKPT key ID         │
│ ↓                    │       │ ↓                    │
│ MerchantAccount A    │       │ MerchantAccount B    │
└──────────────────────┘       └──────────────────────┘
       │                               │
       ▼                               ▼
   PosId: 376                     PosId: 378
   (Momentum API)                 (Momentum API)
       │                               │
       ▼                               ▼
   Restaurant A                   Ghost Kitchen
   (BBVA account)                 (Santander account)
```

---

## Database Relationships (Entity Diagram)

```
Terminal (Physical Device)
├── id: "term_123"
├── serialNumber: "AVQD-2841548417" (unique, physical)
├── assignedMerchantIds: ["merchant_001", "merchant_002"]
│
└── Merchant Accounts (Virtual Routing)
    ├── MerchantAccount (merchant_001)
    │   ├── blumonSerialNumber: "2841548417"
    │   ├── blumonPosId: "376"
    │   ├── credentialsEncrypted: {...} ← OAuth Token A + DUKPT A
    │   │
    │   └── ProviderCostStructure
    │       ├── debitRate: 0.015 (1.5%)
    │       ├── creditRate: 0.025 (2.5%)
    │       └── effectiveFrom: 2025-01-01
    │
    └── MerchantAccount (merchant_002)
        ├── blumonSerialNumber: "2841548418"
        ├── blumonPosId: "378"
        ├── credentialsEncrypted: {...} ← OAuth Token B + DUKPT B
        │
        └── ProviderCostStructure
            ├── debitRate: 0.018 (1.8%) ← DIFFERENT RATE
            ├── creditRate: 0.028 (2.8%)
            └── effectiveFrom: 2025-01-01
```

---

## Payment Flow (5 Steps)

### 1. Fetch Terminal Config (App Startup)

```
GET /api/v1/tpv/terminals/AVQD-2841548417/config
    ↓
Backend returns:
{
  terminal: { serialNumber: "AVQD-2841548417", ... },
  merchantAccounts: [
    { id: "merchant_001", serialNumber: "2841548417", posId: "376", ... },
    { id: "merchant_002", serialNumber: "2841548418", posId: "378", ... }
  ]
}
```

### 2. Select Merchant (User Taps Button)

```
User: "Selecting Cuenta B"
    ↓
viewModel.selectMerchant(merchantB)
```

### 3. SDK Reinitializes (3-5 seconds)

```
MultiMerchantSDKManager.switchMerchant(merchantB)
    ├─ Decrypt merchant B credentials
    ├─ Call BlumonTpvService.getAccessToken(serial="2841548418")
    ├─ Call BlumonTpvService.getRSAKeys(posId="378")
    ├─ Call BlumonTpvService.getDUKPTKeys(serial="2841548418")
    └─ SDK ready for payment
```

### 4. Process Payment

```
User taps card
    ↓
SDK knows: "Use Merchant B (Serial 2841548418, PosId 378)"
    ↓
Encrypt card data with DUKPT keys for serial 2841548418
    ↓
Send to Blumon Momentum API with:
  - posId: 378
  - OAuth token: merchantB's token
```

### 5. Record Payment (Backend)

```
POST /api/v1/tpv/venues/{venueId}/orders/{orderId}/payment
Body: {
  amount: 10000,
  method: "CARD",
  cardBrand: "VISA",
  ...
  // ⚠️ MISSING: merchantAccountId (should be "merchant_002")
}
```

---

## Credential Flow (Technical Details)

### Storage (Encrypted)

```
MerchantAccount.credentialsEncrypted = {
  encrypted: "hex_string_...",  // AES-256-CBC encrypted
  iv: "hex_string_..."          // Initialization vector
}

When decrypted:
{
  oauthAccessToken: "access_...",     // Blumon token
  oauthRefreshToken: "refresh_...",   // Token refresh
  rsaId: 123,                         // RSA key ID
  rsaKey: "hex_rsa_...",              // RSA public key
  dukptKsn: "key_serial_number",      // DUKPT key serial
  dukptKey: "base_derivation_key"     // Card encryption key
}
```

### Usage (Per Merchant)

```
Merchant A: Uses credentials for serial 2841548417
Merchant B: Uses credentials for serial 2841548418
Merchant C: Uses credentials for serial 2841548419

Each credential set is INDEPENDENT and SEPARATE
```

---

## Field Definitions (Glossary)

| Field                  | Example                         | Meaning                                                                    |
| ---------------------- | ------------------------------- | -------------------------------------------------------------------------- |
| `blumonSerialNumber`   | `2841548417`                    | Virtual serial for OAuth + card encryption. Different per merchant.        |
| `blumonPosId`          | `376`                           | Momentum API position. Routes payment to specific merchant's bank account. |
| `blumonEnvironment`    | `SANDBOX`                       | Test or production environment.                                            |
| `blumonMerchantId`     | `merchant_a`                    | Blumon's internal merchant identifier.                                     |
| `credentialsEncrypted` | `{encrypted: "...", iv: "..."}` | AES-256 encrypted OAuth tokens + DUKPT keys.                               |
| `displayName`          | `"Main Account"`                | User-friendly name shown in UI.                                            |
| `displayOrder`         | `1`                             | Sort order in UI (ascending).                                              |

---

## Cost Structure Answer

### Q: Are costs per merchant or per device?

**Answer**: ✅ **PER MERCHANT ACCOUNT**

**Proof**:

```prisma
model ProviderCostStructure {
  merchantAccountId String  ← Links to MERCHANT, not TERMINAL
  merchantAccount   MerchantAccount @relation(...)
}
```

**Example**:

```
Terminal AVQD-2841548417
├── Merchant A (Serial 2841548417)
│   └── ProviderCostStructure: { debitRate: 0.015 (1.5%) }
│
└── Merchant B (Serial 2841548418)
    └── ProviderCostStructure: { debitRate: 0.018 (1.8%) } ← DIFFERENT
```

**Why?** Blumon negotiates rates **per posId**, not per physical device.

---

## Implementation Checklist

### Backend

- [x] MerchantAccount model with Blumon fields
- [x] Terminal.assignedMerchantIds array
- [x] ProviderCostStructure per merchant
- [x] Terminal config endpoint
- [x] Blumon OAuth service
- [ ] Merchant switching endpoint (if needed)
- [ ] **ADD: merchantAccountId to Payment recording**

### Android

- [x] MerchantAccount domain model
- [x] MerchantSelectionContent UI
- [x] PaymentViewModel merchant state
- [x] MultiMerchantSDKManager (SDK switching)
- [x] Terminal config fetch on startup
- [ ] **ADD: Include merchantAccountId in payment request**
- [ ] Handle merchant switch errors (network timeout, etc.)

---

## Common Questions

### Q: Can I use the same virtual serial number for different merchants?

**A**: No. Each merchant needs a unique virtual serial number registered with Blumon.

### Q: What happens if I switch merchants mid-payment?

**A**: The payment uses the merchant that was selected BEFORE the card was tapped. Switching mid-transaction is not supported.

### Q: How long does merchant switching take?

**A**: 3-5 seconds. The SDK must reinitialize with new DUKPT keys.

### Q: Do both merchants share the same DUKPT keys?

**A**: No. Each virtual serial has unique DUKPT keys for card data encryption.

### Q: What if the payment recording doesn't include merchantAccountId?

**A**: You'll lose track of which merchant processed the payment. Auditing and settlement becomes difficult.

---

## Integration Points

### Android → Backend

```kotlin
// When recording payment, MUST include:
val paymentData = PaymentCreationData(
  amount = 10000,
  merchantAccountId = currentMerchant.id,  // ← ADD THIS
  ...
)
```

### Backend → Blumon

```typescript
// When processing payment, use merchant's credentials:
const credentials = merchant.credentialsEncrypted // Decrypt
const oauth = await blumonService.getAccessToken(
  merchant.blumonSerialNumber, // Use merchant's virtual serial
  'PAX',
  'A910S',
)
```

---

## Files to Understand Multi-Merchant

### Must Read (In Order)

1. `/prisma/schema.prisma` → Terminal + MerchantAccount models
2. `/src/controllers/tpv/terminal.tpv.controller.ts` → Config endpoint
3. `/features/payment/domain/model/MerchantAccount.kt` → Android model
4. `/features/payment/presentation/PaymentViewModel.kt` → UI state
5. `/features/payment/data/MultiMerchantSDKManager.kt` → SDK switching

### Reference (If Debugging)

- `blumon-tpv.service.ts` → OAuth + DUKPT logic
- `merchantAccount.service.ts` → Backend merchant creation
- `MerchantSelectionContent.kt` → UI component

---

## Common Issues & Solutions

### Issue: "SDK initialized with wrong serial number"

**Cause**: Merchant switch didn't complete before payment start **Solution**: Verify merchantSwitchingLoading = false before enabling
payment button

### Issue: "Payment routes to wrong merchant"

**Cause**: SDK still using old merchant's posId **Solution**: Ensure MultiMerchantSDKManager.switchMerchant() completes successfully

### Issue: "Different merchants charged different fees"

**Cause**: Each merchant has separate ProviderCostStructure **Solution**: This is expected behavior. Verify cost structures in database.

### Issue: "Can't identify which merchant processed payment"

**Cause**: Payment record doesn't include merchantAccountId **Solution**: Add merchantAccountId field to payment recording

---

## Testing Checklist

- [ ] Terminal with 2 merchants configured
- [ ] Fetch config endpoint returns both merchants
- [ ] Select Merchant A → pay → verify routes to A's bank
- [ ] Select Merchant B → pay → verify routes to B's bank
- [ ] Cost calculations use correct merchant's rates
- [ ] Payment record includes merchantAccountId
- [ ] Switch merchants rapidly (stress test 3-5 sec delay)

---

**Last Updated**: 2025-11-06 **Confidence**: Very High (Code review complete)
