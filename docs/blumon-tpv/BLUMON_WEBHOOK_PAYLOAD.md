# Blumon TPV Webhook Payload Reference

> **Last Updated**: 2025-12-03 **Source**: Real sandbox webhook captures **Endpoint**: `POST /api/v1/webhooks/blumon/tpv`

## Full Webhook Payload (Real Example)

```json
{
  "business": "AVOQADO",
  "businessRfc": "STA241210PW8",
  "lastFour": "7182",
  "cardType": "CREDITO",
  "brand": "MASTERCARD",
  "bank": "GENERAL",
  "amount": "10.00",
  "reference": "20251203122558",
  "realCounter": "3",
  "cardHolder": "CARDHOLDER",
  "authorizationCode": "V4GX82",
  "operationType": "VENTA",
  "operationNumber": 75249,
  "descriptionResponse": "APROBADA",
  "dateTransaction": "03/12/2025 12:26:02",
  "aid": "A0000000041010",
  "arqc": "447467E58D166919",
  "authentication": "signature",
  "bin": "512912",
  "serialNumber": "2841548417",
  "membership": "8226471",
  "provideResponse": "SB",
  "codeResponse": "00"
}
```

## Field Reference

### Merchant Identification

| Field          | Type   | Description                          | Example          |
| -------------- | ------ | ------------------------------------ | ---------------- |
| `business`     | string | Merchant name registered with Blumon | `"AVOQADO"`      |
| `businessRfc`  | string | Tax ID (RFC) of the merchant         | `"STA241210PW8"` |
| `membership`   | string | Blumon membership ID                 | `"8226471"`      |
| `serialNumber` | string | Terminal serial number               | `"2841548417"`   |

### Card Information

| Field        | Type   | Description                      | Example                  |
| ------------ | ------ | -------------------------------- | ------------------------ |
| `bin`        | string | Card BIN (first 6 digits)        | `"512912"`               |
| `lastFour`   | string | Last 4 digits of card            | `"7182"`                 |
| `brand`      | string | Card brand                       | `"MASTERCARD"`, `"VISA"` |
| `cardType`   | string | Card type                        | `"CREDITO"`, `"DEBITO"`  |
| `bank`       | string | Issuing bank                     | `"GENERAL"`, `"BANORTE"` |
| `cardHolder` | string | Cardholder name (PCI sensitive!) | `"CARDHOLDER"`           |

### Transaction Details

| Field               | Type   | Description                              | Example                   |
| ------------------- | ------ | ---------------------------------------- | ------------------------- |
| `amount`            | string | Transaction amount (string format)       | `"10.00"`                 |
| `reference`         | string | Blumon reference (YYYYMMDDHHMMSS format) | `"20251203122558"`        |
| `authorizationCode` | string | Bank authorization code                  | `"V4GX82"`                |
| `operationType`     | string | Type of operation                        | `"VENTA"`, `"DEVOLUCION"` |
| `operationNumber`   | number | Blumon operation ID                      | `75249`                   |
| `realCounter`       | string | Transaction counter                      | `"3"`                     |

### Response Codes

| Field                 | Type   | Description                       | Example                 |
| --------------------- | ------ | --------------------------------- | ----------------------- |
| `codeResponse`        | string | Response code (`"00"` = approved) | `"00"`                  |
| `descriptionResponse` | string | Human-readable response           | `"APROBADA"`            |
| `provideResponse`     | string | Provider code (`"SB"` = sandbox)  | `"SB"`                  |
| `dateTransaction`     | string | Transaction date/time             | `"03/12/2025 12:26:02"` |

### EMV/Chip Data

| Field            | Type   | Description                      | Example                    |
| ---------------- | ------ | -------------------------------- | -------------------------- |
| `aid`            | string | Application Identifier (EMV)     | `"A0000000041010"`         |
| `arqc`           | string | Authorization Request Cryptogram | `"447467E58D166919"`       |
| `authentication` | string | Authentication method            | `"signature"`, `"unknown"` |

## Response Codes

| Code | Description         |
| ---- | ------------------- |
| `00` | Approved            |
| `01` | Refer to issuer     |
| `05` | Do not honor        |
| `14` | Invalid card number |
| `51` | Insufficient funds  |
| `54` | Expired card        |
| `55` | Incorrect PIN       |
| `91` | Issuer unavailable  |

## Provider Response Codes

| Code | Description            |
| ---- | ---------------------- |
| `SB` | Sandbox environment    |
| `PR` | Production environment |

## Differences from Original Documentation

The original Blumon documentation showed a simpler payload. Real webhooks include additional fields:

| Field          | Original Docs     | Real Payload        |
| -------------- | ----------------- | ------------------- |
| `business`     | ❌ Not documented | ✅ Present          |
| `businessRfc`  | ❌ Not documented | ✅ Present          |
| `serialNumber` | ❌ Not documented | ✅ Present          |
| `realCounter`  | ❌ Not documented | ✅ Present          |
| `aid`          | ❌ Not documented | ✅ Present          |
| `arqc`         | ❌ Not documented | ✅ Present          |
| `bin`          | ✅ Documented     | ✅ Present          |
| `amount`       | `number` in docs  | `string` in reality |

## Payment Matching Strategy

Our backend matches Blumon webhooks to payments using these fields (in order of priority):

1. **`authorizationCode`** → `Payment.authorizationNumber`
2. **`reference`** → `Payment.referenceNumber`
3. **`operationNumber`** → `Payment.processorId`

If a match is found, we verify the amounts match and log discrepancies if they don't.

## Implementation Files

- **Controller**: `src/controllers/tpv/blumon-webhook.tpv.controller.ts`
- **Service**: `src/services/tpv/blumon-webhook.service.ts`
- **Route**: `src/routes/webhook.routes.ts`

## Security Considerations

1. **PCI Compliance**: Never log `cardHolder` or full card numbers
2. **Buffer Parsing**: Webhook arrives as Buffer due to `express.raw()` middleware (for Stripe compatibility)
3. **Idempotency**: Check `blumonWebhookReceived` in `processorData` to avoid duplicate processing
