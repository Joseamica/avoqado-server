# Digital Receipts System

## Overview

The Digital Receipts system generates and delivers electronic receipts to customers after payment. Receipts are immutable snapshots of the transaction at the moment of creation, accessible via unique URLs and optionally delivered via email.

## Business Context

**Key Use Cases:**
- QR code on printed receipt linking to digital version
- Email receipt to customer for expense tracking
- Digital-first customers who refuse paper receipts
- Business record keeping and audit trail
- Customer review/rating flow integration

**Industry Standards:**
- Toast: "Digital Receipt" via email/SMS
- Square: "Digital Receipts" with item details
- Stripe: "Receipt URL" in payment response

## Database Model

### DigitalReceipt

```prisma
model DigitalReceipt {
  id        String @id @default(cuid())

  // Secure, non-sequential identifier for public URL
  accessKey String @unique @default(cuid())

  // Link to payment
  paymentId String
  payment   Payment @relation(...)

  // Immutable snapshot of data at creation time
  dataSnapshot Json

  // Delivery tracking
  status         ReceiptStatus @default(PENDING)
  recipientEmail String?
  sentAt         DateTime?
  viewedAt       DateTime?  // Updated when link is accessed

  createdAt DateTime @default(now())

  @@index([accessKey])
  @@index([paymentId])
}
```

### ReceiptStatus Enum

```prisma
enum ReceiptStatus {
  PENDING   // Created but not sent/viewed
  SENT      // Email sent to customer
  VIEWED    // Customer accessed the URL
  FAILED    // Email delivery failed
}
```

## Architecture

### Immutable Data Snapshot

**Critical Design Decision:** The receipt stores a complete snapshot of all data at creation time. This ensures:

1. **Legal compliance:** Receipt accurately reflects transaction
2. **Data integrity:** Changes to venue/products don't alter historical receipts
3. **Audit trail:** Receipts are tamper-proof records
4. **Performance:** No need to join multiple tables when viewing

### Data Snapshot Interface

```typescript
interface ReceiptDataSnapshot {
  payment: {
    id: string
    amount: number
    tipAmount: number
    method: string
    status: string
    splitType: string
    cardBrand?: string
    maskedPan?: string          // e.g., "****1234"
    entryMode?: string          // CONTACTLESS, CHIP, etc.
    authorizationNumber?: string
    referenceNumber?: string
    createdAt: string           // ISO timestamp
  }
  venue: {
    id: string
    name: string
    address?: string
    city?: string
    state?: string
    phone?: string
    email?: string
    logo?: string               // URL to logo
    primaryColor?: string       // Brand color
  }
  order: {
    id: string
    orderNumber: string
    type: string                // DINE_IN, TAKEOUT, DELIVERY
    source: string              // TPV, QR, WEB
    subtotal: number
    taxAmount: number
    tipAmount: number
    total: number
    table?: {
      number: string
      area?: string
    }
  }
  items: Array<{
    id: string
    productName: string
    quantity: number
    unitPrice: number
    total: number
    modifiers?: Array<{
      name: string
      quantity: number
      price: number
    }>
  }>
  processedBy?: {
    firstName: string
    lastName: string
  }
  receiptInfo: {
    generatedAt: string         // ISO timestamp
    currency: string            // "MXN"
    taxRate: number             // 0.16
  }
}
```

## Service Layer

**File:** `src/services/tpv/digitalReceipt.tpv.service.ts`

### Generate Receipt

```typescript
export async function generateDigitalReceipt(paymentId: string): Promise<DigitalReceipt>
```

1. Fetches complete payment data with all relations
2. Creates immutable `dataSnapshot` JSON
3. Generates unique `accessKey` for public URL
4. Returns `DigitalReceipt` record

### Get Receipt by Access Key

```typescript
export async function getDigitalReceiptByAccessKey(accessKey: string): Promise<DigitalReceipt | null>
```

1. Finds receipt by `accessKey`
2. **Updates `viewedAt`** timestamp when accessed
3. **Updates `status`** to `VIEWED`
4. Returns receipt with snapshot data

### Generate Receipt URL

```typescript
export function generateReceiptUrl(accessKey: string, baseUrl: string): string {
  return `${baseUrl}/receipts/public/${accessKey}`
}
```

## Integration Points

### Payment Flow Integration

Receipts are generated automatically after payment completion:

```typescript
// In payment.tpv.service.ts
const payment = await tx.payment.create({ ... })

// Generate digital receipt
const receipt = await generateDigitalReceipt(payment.id)

// Include in response
return {
  ...payment,
  digitalReceipt: {
    accessKey: receipt.accessKey,
    url: generateReceiptUrl(receipt.accessKey, process.env.FRONTEND_URL),
  }
}
```

### TPV Response

The TPV app receives receipt URL in payment response:

```json
{
  "payment": {
    "id": "pay_abc123",
    "amount": 450.00,
    "status": "COMPLETED"
  },
  "digitalReceipt": {
    "accessKey": "clrcp_xyz789",
    "url": "https://dashboard.avoqado.io/receipts/public/clrcp_xyz789"
  }
}
```

### QR Code Generation

TPV app generates QR code from receipt URL:

```kotlin
// Android - TPV
val qrCodeBitmap = QRCodeGenerator.generate(receiptUrl)
// Print QR on physical receipt
printer.printImage(qrCodeBitmap)
```

## API Endpoints

```
POST   /api/v1/tpv/venues/:venueId/payments/:paymentId/receipt
GET    /api/v1/receipts/public/:accessKey
POST   /api/v1/dashboard/venues/:venueId/receipts/:receiptId/email
```

### Public Receipt Access

The `/receipts/public/:accessKey` endpoint is **unauthenticated** - anyone with the link can view the receipt. Security relies on:

1. **Non-guessable access key:** CUID is random and unique
2. **No sensitive data:** Masked card number, no full details
3. **Read-only:** Cannot modify receipt via public endpoint

## Email Delivery

### Email Service Integration

```typescript
// In email.service.ts
export async function sendReceiptEmail(
  receiptId: string,
  recipientEmail: string
): Promise<void>
```

Uses configured email provider (SendGrid, Postmark, etc.) to deliver formatted receipt.

### Email Template

The receipt email includes:
- Venue branding (logo, colors)
- Transaction summary
- Line items breakdown
- Link to full digital receipt
- Review/rating prompt

## Security Considerations

### Access Key Design

```
accessKey: clrcp_abc123def456
           └── CUID: Collision-resistant, URL-safe
```

**Why CUID instead of auto-increment:**
- Cannot enumerate receipts (`/receipts/1`, `/receipts/2`)
- Unpredictable - attackers can't guess valid URLs
- URL-safe without encoding

### Data Privacy

| Data | Visibility | Reason |
|------|------------|--------|
| Card Number | Masked (****1234) | PCI compliance |
| Customer Email | Hidden | Privacy |
| Staff Name | Visible | Customer service |
| Transaction ID | Visible | Reference for disputes |

## Testing Scenarios

### Manual Testing

1. **Generate receipt:**
   - Process a payment
   - Verify `digitalReceipt` in response
   - Access URL in browser

2. **View tracking:**
   - Access receipt URL
   - Verify `viewedAt` is updated
   - Verify `status` changes to `VIEWED`

3. **Data snapshot integrity:**
   - Generate receipt
   - Modify venue name
   - View receipt - should show OLD venue name

### Database Verification

```sql
-- Check receipt for a payment
SELECT
  dr.id,
  dr."accessKey",
  dr.status,
  dr."viewedAt",
  dr."dataSnapshot"->>'venue' as venue_name,
  dr."createdAt"
FROM "DigitalReceipt" dr
WHERE dr."paymentId" = 'your-payment-id';

-- Count receipts by status
SELECT status, COUNT(*) as count
FROM "DigitalReceipt"
GROUP BY status;
```

## Related Files

**Backend:**
- `prisma/schema.prisma` - DigitalReceipt model, ReceiptStatus enum
- `src/services/tpv/digitalReceipt.tpv.service.ts` - Generation logic
- `src/services/email.service.ts` - Email delivery
- `src/services/dashboard/receipt.dashboard.service.ts` - Dashboard queries
- `src/controllers/tpv/receipt.tpv.controller.ts` - API handlers

**TPV Android:**
- QR code generation from receipt URL
- Print receipt with embedded QR

**Dashboard:**
- Public receipt viewer page (`/receipts/public/:accessKey`)
- Receipt management in payment details

## Industry Standards Reference

| Platform | Feature | Key Differences |
|----------|---------|-----------------|
| **Toast** | Digital Receipt | SMS + Email delivery |
| **Square** | Digital Receipt | Includes loyalty points |
| **Stripe** | Receipt URL | Simple, no items list |
| **Clover** | Digital Receipt | Integrates with Clover app |

## Future Enhancements

1. **SMS delivery:** Send receipt via WhatsApp/SMS
2. **PDF generation:** Downloadable PDF version
3. **E-invoice (CFDI):** Mexican tax compliance integration
4. **Return receipt:** Link for generating return/refund
5. **Receipt templates:** Venue-customizable formats
6. **Multi-language:** Receipt in customer's preferred language
7. **Apple/Google Wallet:** Add receipt to digital wallet
