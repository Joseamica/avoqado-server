# Blumon Mock - Test Card Numbers

**Purpose**: When `USE_BLUMON_MOCK=true`, you can use these test card numbers to simulate different payment scenarios **without consuming
Blumon sandbox API limits**.

---

## ✅ Successful Payments

Use these cards to test successful payment flows:

| Card Number           | Brand      | CVV          | Expiry          | Result     |
| --------------------- | ---------- | ------------ | --------------- | ---------- |
| `4111 1111 1111 1111` | VISA       | Any 3 digits | Any future date | ✅ Success |
| `5555 5555 5555 4444` | Mastercard | Any 3 digits | Any future date | ✅ Success |
| `3782 822463 10005`   | AMEX       | Any 4 digits | Any future date | ✅ Success |

---

## ❌ Failed Payments - Different Error Scenarios

Use these cards to test error handling:

### Card Declined

| Card Number           | Brand | Result           |
| --------------------- | ----- | ---------------- |
| `4000 0000 0000 0002` | VISA  | ❌ Card declined |

**Error**:

```json
{
  "code": "CARD_DECLINED",
  "description": "LA TARJETA FUE RECHAZADA"
}
```

---

### Insufficient Funds

| Card Number           | Brand | Result                |
| --------------------- | ----- | --------------------- |
| `4000 0000 0000 9995` | VISA  | ❌ Insufficient funds |

**Error**:

```json
{
  "code": "INSUFFICIENT_FUNDS",
  "description": "FONDOS INSUFICIENTES"
}
```

---

### Expired Card

| Card Number           | Brand | Result          |
| --------------------- | ----- | --------------- |
| `4000 0000 0000 0069` | VISA  | ❌ Expired card |

**Error**:

```json
{
  "code": "EXPIRED_CARD",
  "description": "LA TARJETA HA EXPIRADO"
}
```

---

### Invalid CVV

| Card Number           | Brand | Result         |
| --------------------- | ----- | -------------- |
| `4000 0000 0000 0127` | VISA  | ❌ Invalid CVV |

**Error**:

```json
{
  "code": "INVALID_CVV",
  "description": "EL CVV ES INVÁLIDO"
}
```

---

### Monthly Limit Exceeded (TX_003)

| Card Number           | Brand      | Result                    |
| --------------------- | ---------- | ------------------------- |
| `5100 0000 0000 0016` | Mastercard | ❌ Monthly limit exceeded |

**Error**:

```json
{
  "code": "TX_003",
  "description": "LA TRANSACCIÓN EXCEDE EL MONTO MENSUAL PERMITIDO",
  "httpStatusCode": 409
}
```

---

### Transaction Limit Exceeded (TX_001)

| Card Number           | Brand | Result                        |
| --------------------- | ----- | ----------------------------- |
| `4242 4242 4242 4242` | VISA  | ❌ Transaction limit exceeded |

**Error**:

```json
{
  "code": "TX_001",
  "description": "LA TRANSACCIÓN EXCEDE EL MONTO PERMITIDO",
  "httpStatusCode": 409
}
```

---

## 💰 Amount-Based Errors

The mock also validates amounts:

| Amount        | Result                                 |
| ------------- | -------------------------------------- |
| ≤ $10,000 MXN | ✅ Success (if card is valid)          |
| > $10,000 MXN | ❌ TX_001 - Transaction limit exceeded |

---

## 🚀 How to Use

### 1. Enable Mock in `.env`

```bash
USE_BLUMON_MOCK=true
```

### 2. Create a Checkout Session

```bash
npm run blumon:create-session
```

### 3. Test with Different Cards

Open the generated URL and use any of the test card numbers above to simulate different scenarios.

**Example**:

```
# Test successful payment
Card: 4111 1111 1111 1111
CVV: 123
Expiry: 12/25

# Test card declined
Card: 4000 0000 0000 0002
CVV: 123
Expiry: 12/25

# Test monthly limit exceeded (like real Blumon!)
Card: 5100 0000 0000 0016
CVV: 123
Expiry: 12/25
```

---

## 🔄 Switch Between Mock and Real API

### Use Mock (Unlimited Testing)

```bash
# .env
USE_BLUMON_MOCK=true
```

### Use Real Blumon API

```bash
# .env
USE_BLUMON_MOCK=false

# Remember to authenticate first!
npm run blumon:auth
```

---

## 📊 Mock Behavior

The mock service simulates real Blumon API behavior:

- ✅ **Realistic delays**: 500-1000ms like real API
- ✅ **Proper error format**: Matches Blumon error structure
- ✅ **Token generation**: Generates mock tokens
- ✅ **Card brand detection**: Detects VISA/MC/AMEX
- ✅ **Masked PAN**: Returns masked card numbers
- ✅ **Authorization codes**: Generates realistic auth codes

---

## 🧪 Testing Recommendations

### For Development:

- ✅ **Always use mock** (`USE_BLUMON_MOCK=true`)
- ✅ Test all error scenarios
- ✅ Test success flow
- ✅ Test amount validation

### Before Production:

- ⚠️ **Switch to real API** (`USE_BLUMON_MOCK=false`)
- ⚠️ Test with real Blumon sandbox
- ⚠️ Verify webhooks work
- ⚠️ Test with real production credentials

---

## 🎯 Common Test Flows

### Test Flow 1: Happy Path

```
1. Use card: 4111 1111 1111 1111
2. Amount: $10 MXN
3. Expected: ✅ Payment succeeds
```

### Test Flow 2: Card Declined Recovery

```
1. Use card: 4000 0000 0000 0002 (declined)
2. See error message
3. Retry with: 5555 5555 5555 4444
4. Expected: ✅ Payment succeeds (Stripe pattern - retries allowed!)
```

### Test Flow 3: Amount Validation

```
1. Use card: 4111 1111 1111 1111
2. Amount: $15,000 MXN
3. Expected: ❌ TX_001 error
```

### Test Flow 4: Monthly Limit (like real Blumon!)

```
1. Use card: 5100 0000 0000 0016
2. Amount: $10 MXN
3. Expected: ❌ TX_003 error (monthly limit)
```

---

## 📝 Notes

- Mock service **does NOT** validate CVV correctness (any CVV works except for card `4000 0000 0000 0127`)
- Mock service **does NOT** validate expiry dates (any future date works except for card `4000 0000 0000 0069`)
- Mock service **does NOT** save payments to database (that's done by the controller)
- Mock service **does NOT** send webhooks (use webhook simulator for that)

---

**Quick Reference**: Keep this guide handy while developing to quickly grab test card numbers! 🚀
