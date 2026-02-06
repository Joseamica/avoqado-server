# Avoqado Database Schema Documentation

## Overview

This document provides a comprehensive explanation of the Avoqado database schema, designed for a multi-tenant, multi-sector venue
management platform supporting restaurants, hotels, gyms, retail, services, and entertainment businesses. The schema supports multiple
organizations with multiple venues, payment processing, POS integration, staff management, and comprehensive cost tracking.

## Core Architecture

The schema follows a hierarchical multi-tenant architecture:

- **Organizations** (root level) → **Venues** → **Operations**
- Generic payment provider integration supporting multiple processors
- Comprehensive cost management and profit tracking system

---

## Models Documentation

### 🏢 **Core Multi-Tenant Architecture**

#### **Organization**

**Purpose**: Root-level entity for multi-tenant architecture. Represents a business group or franchise that owns multiple venues.

**Use Case**: A multi-location business group like "Grupo Avoqado Prime" that owns multiple venues (Avoqado Centro, Avoqado Sur). This could
be a restaurant chain, hotel group, gym franchise, or retail chain. Each organization has its own billing, staff, and venues but shares the
same Avoqado platform.

**Model Definition**:

```prisma
model Organization {
  id    String       @id @default(cuid())
  name  String
  email String
  phone String
  taxId String?
  type  BusinessType @default(RESTAURANT)

  // Billing configuration
  billingEmail   String?
  billingAddress Json?

  venues              Venue[]
  staffOrganizations  StaffOrganization[]
  invitations         Invitation[]
  invoices            Invoice[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

**Code Example**:

```typescript
// Create a new restaurant chain organization
const organization = await prisma.organization.create({
  data: {
    name: 'Grupo Tacos El Rey',
    email: 'admin@tacosdelrey.com',
    phone: '+52-55-1234-5678',
    taxId: 'TER123456ABC',
    type: 'RESTAURANT',
    billingEmail: 'billing@tacosdelrey.com',
    billingAddress: {
      street: 'Av. Revolución 1234',
      city: 'Mexico City',
      state: 'CDMX',
      zipCode: '03100',
      country: 'Mexico',
    },
  },
  include: {
    venues: true,
    staffOrganizations: { include: { staff: true } },
  },
})

// Get organization with all its venues
const orgWithVenues = await prisma.organization.findUnique({
  where: { id: organizationId },
  include: {
    venues: {
      include: {
        staff: true,
        orders: {
          where: { createdAt: { gte: startOfMonth } },
        },
      },
    },
    invoices: {
      where: { status: 'PENDING' },
    },
  },
})
```

**Key Relationships**:

- Has multiple `Venue` locations
- Has `Staff` members via `StaffOrganization` junction table (multi-org support)
- Receives consolidated `Invoice` billing
- Manages `Invitation` system for new staff

---

#### **Venue**

**Purpose**: Individual business location within an organization. The operational unit where actual business operations happen.

**Use Case**: "Avoqado Centro" venue in Mexico City (could be a restaurant, hotel, gym, or retail store). Each venue has its own
menu/catalog, staff assignments, orders/transactions, payments, and operational settings while belonging to the parent organization.

**Model Definition**:

```prisma
model Venue {
  id             String       @id @default(cuid())
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id])

  // Basic info
  name     String
  slug     String    @unique
  type     VenueType @default(RESTAURANT)
  timezone String    @default("America/Mexico_City")
  currency String    @default("MXN")

  // Location
  address   String
  city      String
  state     String
  country   String   @default("MX")
  zipCode   String
  latitude  Decimal? @db.Decimal(10, 8)
  longitude Decimal? @db.Decimal(11, 8)

  // POS Integration
  posType   PosType?
  posConfig Json?
  posStatus PosStatus @default(NOT_INTEGRATED)

  // Relations
  staff         StaffVenue[]
  orders        Order[]
  payments      Payment[]
  paymentConfig VenuePaymentConfig?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([organizationId])
  @@index([slug])
}
```

**Code Example**:

```typescript
// Create a new venue with payment configuration
const venue = await prisma.venue.create({
  data: {
    organizationId: 'org_123',
    name: 'Tacos El Rey - Roma Norte',
    slug: 'tacos-roma-norte',
    type: 'RESTAURANT',
    address: 'Álvaro Obregón 123',
    city: 'Mexico City',
    state: 'CDMX',
    zipCode: '06700',
    country: 'MX',
    posType: 'SOFTRESTAURANT',
    posStatus: 'CONNECTED',
    paymentConfig: {
      create: {
        primaryAccountId: mentaPrimaryAccount.id,
        secondaryAccountId: mentaSecondaryAccount.id,
        routingRules: {
          factura: 'secondary',
          amount_over: 1000,
          peak_hours: { start: '19:00', end: '22:00', account: 'secondary' },
        },
      },
    },
  },
  include: {
    paymentConfig: {
      include: {
        primaryAccount: true,
        secondaryAccount: true,
      },
    },
  },
})

// Get venue with today's sales summary
const venueWithSales = await prisma.venue.findUnique({
  where: { slug: 'tacos-roma-norte' },
  include: {
    orders: {
      where: {
        createdAt: { gte: startOfDay, lte: endOfDay },
        status: 'COMPLETED',
      },
    },
    payments: {
      where: { createdAt: { gte: startOfDay, lte: endOfDay } },
    },
    monthlyProfits: {
      where: { year: currentYear, month: currentMonth },
    },
  },
})
```

**Key Features**:

- Location and contact information
- POS integration status and configuration
- Fee structure and billing settings
- Branding (logo, colors)
- Operational status and settings

**Key Relationships**:

- Belongs to one `Organization`
- Has venue-specific `Staff` assignments via `StaffVenue`
- Contains `Menu`, `Product`, `Order`, and `Payment` data
- Has `Terminal` devices for POS operations

---

#### **VenueSettings**

**Purpose**: Configurable operational parameters for each venue.

**Use Case**: Avoqado Centro might allow reservations and track inventory, while Avoqado Sur might be cash-only with no inventory tracking.
Each venue can have different operational rules.

**Key Settings**:

- Shift management (auto-close, duration)
- Inventory tracking preferences
- Customer service options (reservations, takeout, delivery)
- Payment method acceptance
- Security settings (PIN requirements)

---

### 👥 **Staff Management System**

#### **Staff**

**Purpose**: Identity record representing a person on the platform. Staff can belong to **multiple organizations** via the
`StaffOrganization` junction table and be assigned to **multiple venues** via the `StaffVenue` junction table.

**Use Case**: Maria González works for "Grupo Avoqado Prime" (as ADMIN at Avoqado Centro, WAITER at Avoqado Sur) and is also invited to
"Restaurante La Cima" (different organization). She has one Staff record, two StaffOrganization records, and three StaffVenue records.

**Key Features**:

- Platform-wide authentication (email/password) — one account per person
- Google OAuth integration
- Employee information and contact details
- Multi-organization membership via `StaffOrganization`
- Multi-venue access via `StaffVenue`

**Key Relationships**:

- Belongs to one or more `Organization` via `StaffOrganization` (multi-org)
- Assigned to one or more `Venue` via `StaffVenue` (multi-venue)
- `StaffOrganization.isPrimary` marks the staff's primary organization
- Organization-level role (`OrgRole`: OWNER, ADMIN, MEMBER, VIEWER) is on `StaffOrganization`
- Venue-level role (`StaffRole`: ADMIN, MANAGER, CASHIER, WAITER, etc.) is on `StaffVenue`

---

#### **StaffOrganization**

**Purpose**: Junction table linking Staff to Organizations. Enables multi-org membership (industry pattern: Stripe, GitHub, Slack).

**Use Case**: Maria is an OWNER of "Grupo Avoqado Prime" (isPrimary: true) and a MEMBER of "Restaurante La Cima" (isPrimary: false). Each
membership tracks when she joined, who invited her, and whether it's active.

**Model Definition**:

```prisma
model StaffOrganization {
  id             String       @id @default(cuid())
  staffId        String
  staff          Staff        @relation(fields: [staffId], references: [id], onDelete: Cascade)
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  role       OrgRole  @default(MEMBER)  // OWNER, ADMIN, MEMBER, VIEWER
  isPrimary  Boolean  @default(false)
  isActive   Boolean  @default(true)
  joinedAt   DateTime @default(now())
  joinedById String?
  leftAt     DateTime?

  @@unique([staffId, organizationId])
  @@index([staffId])
  @@index([organizationId])
  @@index([isPrimary])
}
```

**Code Example**:

```typescript
// Get staff member's primary organization
const primaryOrg = await prisma.staffOrganization.findFirst({
  where: { staffId: 'staff_maria_123', isPrimary: true, isActive: true },
  include: { organization: true },
})

// Add staff to a new organization (cross-org invitation)
await prisma.staffOrganization.upsert({
  where: { staffId_organizationId: { staffId: 'staff_maria_123', organizationId: 'org_new' } },
  create: {
    staffId: 'staff_maria_123',
    organizationId: 'org_new',
    role: 'MEMBER',
    isPrimary: false,
    isActive: true,
  },
  update: { isActive: true, leftAt: null },
})

// List all organizations a staff member belongs to
const memberships = await prisma.staffOrganization.findMany({
  where: { staffId: 'staff_maria_123', isActive: true },
  include: { organization: { select: { name: true } } },
})
```

**Key Features**:

- Multi-org membership with org-level roles
- Primary organization flag for default context
- Active/inactive tracking with join/leave dates
- Audit trail (joinedById tracks who invited the member)

---

#### **StaffVenue**

**Purpose**: Junction table that defines a staff member's role and access at a specific venue.

**Use Case**: The same person can be an ADMIN at one venue but a WAITER at another. Each assignment has its own PIN, role, permissions, and
performance tracking.

**Model Definition**:

```prisma
model StaffVenue {
  id         String  @id @default(cuid())
  staffId    String
  staff      Staff   @relation(fields: [staffId], references: [id], onDelete: Cascade)
  venueId    String
  venue      Venue   @relation(fields: [venueId], references: [id], onDelete: Cascade)

  // Venue-specific PIN for TPV access
  pin String? // 4-6 digits for TPV access per venue

  role        StaffRole
  permissions Json? // Custom permissions override

  // Performance tracking (for waiters)
  totalSales    Decimal @default(0) @db.Decimal(12, 2)
  totalTips     Decimal @default(0) @db.Decimal(10, 2)
  averageRating Decimal @default(0) @db.Decimal(3, 2)
  totalOrders   Int     @default(0)

  active    Boolean   @default(true)
  startDate DateTime  @default(now())
  endDate   DateTime?

  @@unique([staffId, venueId])
  @@unique([venueId, pin])
  @@index([staffId])
  @@index([venueId])
}
```

**Code Example**:

```typescript
// Assign staff member to multiple venues with different roles
const assignments = await Promise.all([
  // Maria as Manager at Centro venue
  prisma.staffVenue.create({
    data: {
      staffId: 'staff_maria_123',
      venueId: 'venue_centro',
      role: 'MANAGER',
      pin: '2468',
      permissions: {
        canManageStaff: true,
        canViewReports: true,
        canProcessRefunds: true,
      },
    },
  }),

  // Same Maria as Waiter at Sur venue
  prisma.staffVenue.create({
    data: {
      staffId: 'staff_maria_123',
      venueId: 'venue_sur',
      role: 'WAITER',
      pin: '1357', // Different PIN for this venue
      permissions: {
        canTakeOrders: true,
        canProcessPayments: true,
      },
    },
  }),
])

// Update staff performance after completed order
await prisma.staffVenue.update({
  where: {
    staffId_venueId: {
      staffId: 'staff_maria_123',
      venueId: 'venue_centro',
    },
  },
  data: {
    totalSales: { increment: 250.0 },
    totalTips: { increment: 37.5 },
    totalOrders: { increment: 1 },
    averageRating: 4.2, // Calculated from customer reviews
  },
})

// Get staff member with all venue assignments
const staffWithVenues = await prisma.staff.findUnique({
  where: { id: 'staff_maria_123' },
  include: {
    venues: {
      include: {
        venue: {
          select: { name: true, slug: true },
        },
      },
      where: { active: true },
    },
  },
})
```

**Key Features**:

- Venue-specific PIN for TPV access
- Role-based permissions per venue
- Performance tracking (sales, tips, ratings)
- Active/inactive status per venue
- Custom permission overrides

---

#### **Invitation**

**Purpose**: Secure invitation system for adding new staff members to organizations or specific venues.

**Use Case**: Restaurant owner invites a new manager via email. The invitation includes role, venue assignment (if applicable), expiration
date, and can be tracked for acceptance/decline.

**Key Features**:

- Email-based invitations with secure tokens
- Role and venue specification
- Expiration and usage tracking
- Custom messages and permissions
- Audit trail for invitation attempts

---

### 🍽️ **Menu & Product Management**

#### **MenuCategory**

**Purpose**: Hierarchical categorization system for organizing menu items.

**Use Case**: "Entradas" → "Ensaladas" → "Ensaladas Calientes". Categories can have subcategories and are used to organize the menu display
and POS integration.

**Key Features**:

- Hierarchical structure (parent/child categories)
- Display ordering and visual styling
- Availability scheduling (time-based, day-based)
- POS synchronization support

---

#### **Menu**

**Purpose**: Collection of categories that define what's available during specific times or contexts.

**Use Case**: "Breakfast Menu" (7AM-11AM), "Lunch Menu" (11AM-4PM), "Dinner Menu" (4PM-11PM). Different menus can show different categories
and products based on time, season, or business rules.

---

#### **Product**

**Purpose**: Individual menu items that can be ordered by customers.

**Use Case**: "Hamburguesa Avoqado" priced at $150 MXN with specific ingredients, dietary tags, and preparation instructions. Can track
inventory and sync with POS systems.

**Key Features**:

- Pricing and cost management
- Dietary information and allergen tracking
- Inventory integration
- POS synchronization
- Image and description management
- Availability scheduling

---

### 🏪 **Operations Management**

#### **Area**

**Purpose**: Physical sections within a venue for organizing tables and operations.

**Use Case**: "Terraza", "Salón Principal", "Barra". Each area can have different service characteristics, and orders can be tracked by
location for operational efficiency.

---

#### **Table**

**Purpose**: Individual seating locations within areas, each with unique QR codes for customer ordering.

**Use Case**: Table "M5" in "Terraza" area seats 4 people and has QR code for customers to scan and place orders directly from their phones.

**Key Features**:

- Capacity management
- QR code generation for customer ordering
- Area assignment for organization
- POS integration for order tracking

---

#### **Shift**

**Purpose**: Work periods for staff members with cash management and performance tracking.

**Use Case**: Maria's evening shift from 6PM-2AM includes $500 starting cash, processes 25 orders totaling $3,200 in sales, and ends with
$520 cash (tracking the $20 difference).

**Key Features**:

- Cash management (starting/ending amounts)
- Sales and order tracking
- Staff performance metrics
- POS integration for data sync

---

### 🛒 **Order Processing System**

#### **Order**

**Purpose**: Customer purchase request containing multiple items, tracking the complete order lifecycle.

**Use Case**: Table 5 orders 2 burgers and 1 drink. Order tracks from "PENDING" → "PREPARING" → "READY" → "COMPLETED" with payment status,
kitchen status, and staff assignments.

**Key Features**:

- Multi-status tracking (order, kitchen, payment)
- Staff assignment (who created, who served)
- Customer information for guest checkout
- Financial calculations (subtotal, tax, tip, total)
- POS synchronization

---

#### **OrderItem**

**Purpose**: Individual product within an order with quantity, pricing, and modifications.

**Use Case**: "2x Hamburguesa Avoqado" at $150 each with "extra cheese" modifier, totaling $320 including tax and modifications.

**Key Features**:

- Quantity and unit pricing
- Discount applications
- Tax calculations
- Kitchen timing tracking
- Modifier support
- POS synchronization

---

### 🔧 **Modifiers System**

#### **ModifierGroup**

**Purpose**: Collection of related modifications that can be applied to products.

**Use Case**: "Aderezos" group containing "Ranch", "BBQ", "Chipotle Mayo" options. Group rules define if selection is required, allows
multiple choices, and sets minimum/maximum selections.

---

#### **Modifier**

**Purpose**: Individual modification option with pricing.

**Use Case**: "Extra Cheese" modifier adds $25 MXN to any burger. Can be required or optional based on group settings.

---

### 💳 **Payment Processing System**

#### **Payment**

**Purpose**: Financial transaction record for order completion with comprehensive payment details.

**Use Case**: $350 MXN credit card payment for Order #12345, processed via Menta with authorization #502511, including $50 tip and $8.75
processing fee (2.5%).

**Key Features**:

- Multiple payment methods (cash, card, digital wallet)
- Processing details (authorization numbers, card info)
- Split payment support with different types
- Fee calculation and profit tracking
- Digital receipt generation
- POS integration

---

#### **PaymentAllocation**

**Purpose**: Distribution of payment amounts across order items for split billing scenarios.

**Use Case**: Table of 4 people splits a $400 bill: Person A pays $120 for their items, Person B pays $280 for the rest. Each allocation
tracks which items were paid by which person.

---

#### **DigitalReceipt**

**Purpose**: Immutable digital receipt with public access via secure URL.

**Use Case**: Customer receives email with link to view/download their receipt. Data is stored as snapshot at time of payment to ensure
receipt never changes even if venue data is updated.

---

### 🏭 **Payment Provider Integration**

#### **PaymentProvider**

**Purpose**: Generic payment service provider (Menta, Clip, banks, etc.) with flexible configuration.

**Use Case**: Menta payment processor supporting Mexico and Argentina, with configuration schema defining required fields like API keys and
merchant IDs. Easy to add new providers without schema changes.

**Model Definition**:

```prisma
model PaymentProvider {
  id           String @id @default(cuid())
  code         String @unique // "MENTA", "CLIP", "BANORTE_DIRECT", etc.
  name         String         // "Menta", "Clip", "Banorte Direct"
  type         ProviderType   // PAYMENT_PROCESSOR, BANK_DIRECT, WALLET
  countryCode  String[]       // ["MX", "AR"]
  active       Boolean @default(true)

  // Provider-specific configuration schema
  configSchema Json? // JSON schema for validation

  // Relations
  merchants       MerchantAccount[]
  webhooks        MentaWebhookSubscription[]
  eventLogs       ProviderEventLog[]
  costStructures  ProviderCostStructure[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([code])
  @@index([type])
}
```

**Code Example**:

```typescript
// Create a new payment provider
const mentaProvider = await prisma.paymentProvider.create({
  data: {
    code: 'MENTA',
    name: 'Menta',
    type: 'PAYMENT_PROCESSOR',
    countryCode: ['MX', 'AR'],
    active: true,
    configSchema: {
      type: 'object',
      required: ['apiKey', 'merchantId'],
      properties: {
        apiKey: { type: 'string' },
        merchantId: { type: 'string' },
        environment: { type: 'string', enum: ['sandbox', 'production'] },
      },
    },
  },
})

// Get all active providers for a country
const mexicoProviders = await prisma.paymentProvider.findMany({
  where: {
    active: true,
    countryCode: { has: 'MX' },
  },
  include: {
    merchants: {
      include: {
        costStructures: {
          where: { active: true },
        },
      },
    },
  },
})
```

**Key Features**:

- Provider-agnostic design
- Country and currency support
- Configuration schema validation
- Active/inactive status management
- Multiple provider types (processor, bank, wallet, gateway)

---

#### **MerchantAccount**

**Purpose**: Specific merchant account with a payment provider, storing encrypted credentials and configuration.

**Use Case**: "Primary Menta Account" for Avoqado Centro with encrypted API keys, merchant ID, and terminal configuration. Multiple accounts
per provider for different use cases.

**Model Definition**:

```prisma
model MerchantAccount {
  id String @id @default(cuid())

  // Provider relationship
  providerId String
  provider   PaymentProvider @relation(fields: [providerId], references: [id])

  // Generic merchant info
  externalMerchantId String  // Provider's merchant ID
  alias              String?

  // Encrypted credentials (provider-agnostic)
  credentialsEncrypted Json // Different per provider

  // Provider-specific config
  providerConfig Json? // Flexible config per provider

  // Relations
  venueConfigsPrimary   VenuePaymentConfig[] @relation("PrimaryAccount")
  venueConfigsSecondary VenuePaymentConfig[] @relation("SecondaryAccount")
  venueConfigsTertiary  VenuePaymentConfig[] @relation("TertiaryAccount")
  costStructures        ProviderCostStructure[]
  transactionCosts      TransactionCost[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([providerId, externalMerchantId])
  @@index([providerId])
}
```

**Code Example**:

```typescript
// Create a new merchant account for Menta
const mentaMerchant = await prisma.merchantAccount.create({
  data: {
    providerId: mentaProvider.id,
    externalMerchantId: 'MENTA_MERCHANT_12345',
    alias: 'Avoqado Primary Account',
    credentialsEncrypted: {
      apiKey: encrypt('sk_live_abc123...'),
      merchantId: encrypt('merchant_123'),
    },
    providerConfig: {
      environment: 'production',
      webhookUrl: 'https://api.avoqado.com/webhooks/menta',
      supportedCardTypes: ['VISA', 'MASTERCARD', 'AMEX'],
    },
  },
})

// Get all merchant accounts with their cost structures
const accounts = await prisma.merchantAccount.findMany({
  include: {
    provider: true,
    costStructures: {
      where: { active: true },
      orderBy: { effectiveFrom: 'desc' },
      take: 1,
    },
  },
})
```

**Key Features**:

- Encrypted credential storage
- Provider-specific configuration
- Alias and identification
- Multiple accounts per provider

---

#### **VenuePaymentConfig**

**Purpose**: Payment routing configuration for each venue, defining which merchant accounts to use in different scenarios.

**Use Case**: Avoqado Centro uses Menta Primary for regular payments, Menta Secondary when customer needs invoice, and Clip for amounts over
$5,000 MXN or during peak hours (6-10PM).

**Model Definition**:

```prisma
model VenuePaymentConfig {
  id      String @id @default(cuid())
  venueId String @unique
  venue   Venue  @relation(fields: [venueId], references: [id], onDelete: Cascade)

  // Account hierarchy (flexible for any provider)
  primaryAccountId   String
  primaryAccount     MerchantAccount @relation("PrimaryAccount", fields: [primaryAccountId], references: [id])

  secondaryAccountId String?
  secondaryAccount   MerchantAccount? @relation("SecondaryAccount", fields: [secondaryAccountId], references: [id])

  tertiaryAccountId String?
  tertiaryAccount   MerchantAccount? @relation("TertiaryAccount", fields: [tertiaryAccountId], references: [id])

  // Routing rules (JSON for flexibility)
  routingRules Json? // { "factura": "secondary", "amount_over": 1000, "bin_routing": {...} }

  // Default processor preference
  preferredProcessor PaymentProcessor @default(AUTO)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([primaryAccountId])
  @@index([secondaryAccountId])
  @@index([tertiaryAccountId])
}
```

**Code Example**:

```typescript
// Configure payment routing for a venue
const paymentConfig = await prisma.venuePaymentConfig.create({
  data: {
    venueId: 'venue_centro',
    primaryAccountId: mentaPrimaryAccount.id,
    secondaryAccountId: mentaSecondaryAccount.id,
    tertiaryAccountId: clipAccount.id,
    routingRules: {
      // Use secondary account when customer needs invoice
      factura: 'secondary',
      // Use tertiary (Clip) for large amounts
      amount_over: 5000,
      // Use secondary during peak hours
      peak_hours: {
        start: '18:00',
        end: '22:00',
        account: 'secondary',
      },
      // BIN-based routing for specific card types
      bin_routing: {
        '4111': 'primary', // Visa cards starting with 4111
        '5555': 'tertiary', // Mastercard starting with 5555
      },
    },
    preferredProcessor: 'AUTO',
  },
  include: {
    primaryAccount: { include: { provider: true } },
    secondaryAccount: { include: { provider: true } },
    tertiaryAccount: { include: { provider: true } },
  },
})

// Get payment routing for a venue
const routing = await prisma.venuePaymentConfig.findUnique({
  where: { venueId: 'venue_centro' },
  include: {
    primaryAccount: {
      include: {
        provider: true,
        costStructures: {
          where: { active: true },
        },
      },
    },
    secondaryAccount: { include: { provider: true } },
    tertiaryAccount: { include: { provider: true } },
  },
})
```

**Key Features**:

- Primary/secondary/tertiary account hierarchy
- JSON-based routing rules for complex logic
- Account type flexibility
- Business rule implementation

---

### 💰 **Cost Management & Profit Tracking**

#### **ProviderCostStructure**

**Purpose**: Tracks what payment providers charge Avoqado for processing transactions.

**Use Case**: Menta charges Avoqado 1.5% for debit cards, 2.5% for credit cards, 3.5% for Amex, plus $0.50 MXN per transaction and $500 MXN
monthly fee. These costs are the basis for profit calculations.

**Model Definition**:

```prisma
model ProviderCostStructure {
  id String @id @default(cuid())

  // Provider relationship
  providerId String
  provider   PaymentProvider @relation(fields: [providerId], references: [id])

  // Merchant account (costs can vary by account type)
  merchantAccountId String
  merchantAccount   MerchantAccount @relation(fields: [merchantAccountId], references: [id])

  // Cost breakdown by transaction type
  debitRate        Decimal  @db.Decimal(5, 4)  // e.g., 0.0150 (1.5%)
  creditRate       Decimal  @db.Decimal(5, 4)  // e.g., 0.0250 (2.5%)
  amexRate         Decimal  @db.Decimal(5, 4)  // e.g., 0.0350 (3.5%)
  internationalRate Decimal @db.Decimal(5, 4)  // e.g., 0.0400 (4.0%)

  // Fixed costs per transaction (if applicable)
  fixedCostPerTransaction Decimal? @db.Decimal(8, 4) // e.g., 0.50 MXN

  // Monthly/volume-based costs
  monthlyFee      Decimal? @db.Decimal(10, 2)
  minimumVolume   Decimal? @db.Decimal(12, 2)
  volumeDiscount  Decimal? @db.Decimal(5, 4)

  // Period this cost structure is valid for
  effectiveFrom DateTime
  effectiveTo   DateTime?

  // Status
  active Boolean @default(true)

  // Metadata
  proposalReference String? // Reference to Menta's proposal
  notes            String?

  // Relations
  transactionCosts TransactionCost[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([merchantAccountId, effectiveFrom])
  @@index([providerId])
  @@index([merchantAccountId])
  @@index([effectiveFrom])
}
```

**Code Example**:

```typescript
// Create new provider cost structure when Menta sends updated rates
const newCostStructure = await prisma.providerCostStructure.create({
  data: {
    providerId: mentaProvider.id,
    merchantAccountId: mentaMerchantAccount.id,
    debitRate: 0.0155, // 1.55%
    creditRate: 0.0265, // 2.65%
    amexRate: 0.0375, // 3.75%
    internationalRate: 0.0425, // 4.25%
    fixedCostPerTransaction: 0.52, // $0.52 MXN per transaction
    monthlyFee: 525.0, // $525 MXN monthly
    effectiveFrom: new Date('2024-02-01'),
    active: true,
    proposalReference: 'MENTA-PROPOSAL-2024-001',
    notes: 'Updated rates for Q1 2024 - 5 basis points increase across all card types',
  },
})

// Get current active cost structure for a merchant account
const currentCosts = await prisma.providerCostStructure.findFirst({
  where: {
    merchantAccountId: mentaMerchantAccount.id,
    active: true,
    effectiveFrom: { lte: new Date() },
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: new Date() } }],
  },
  orderBy: { effectiveFrom: 'desc' },
  include: {
    provider: true,
    merchantAccount: true,
  },
})
```

**Key Features**:

- Card type-specific rates (debit, credit, Amex, international)
- Fixed fees per transaction and monthly
- Time-based validity periods
- Proposal reference tracking
- Multiple cost structures per merchant account

---

#### **VenuePricingStructure**

**Purpose**: Defines what Avoqado charges each venue, including profit margins over provider costs.

**Use Case**: Avoqado charges venue 2.0% for debit cards (0.5% margin over 1.5% cost), 3.0% for credit cards (0.5% margin), plus $0.75 per
transaction and $799 monthly fee.

**Model Definition**:

```prisma
model VenuePricingStructure {
  id String @id @default(cuid())

  venueId String
  venue   Venue  @relation(fields: [venueId], references: [id], onDelete: Cascade)

  // Account type this pricing applies to
  accountType AccountType // PRIMARY, SECONDARY, TERTIARY

  // Pricing by transaction type (with Avoqado's margin included)
  debitRate        Decimal  @db.Decimal(5, 4)  // e.g., 0.0200 (2.0% - includes margin)
  creditRate       Decimal  @db.Decimal(5, 4)  // e.g., 0.0300 (3.0% - includes margin)
  amexRate         Decimal  @db.Decimal(5, 4)  // e.g., 0.0400 (4.0% - includes margin)
  internationalRate Decimal @db.Decimal(5, 4)  // e.g., 0.0450 (4.5% - includes margin)

  // Fixed fees (with margin)
  fixedFeePerTransaction Decimal? @db.Decimal(8, 4) // e.g., 0.75 MXN
  monthlyServiceFee      Decimal? @db.Decimal(10, 2) // e.g., 299.00 MXN

  // Minimum transaction volumes or penalties
  minimumMonthlyVolume Decimal? @db.Decimal(12, 2)
  volumePenalty        Decimal? @db.Decimal(10, 2)

  // Period this pricing is valid for
  effectiveFrom DateTime
  effectiveTo   DateTime?

  // Status
  active Boolean @default(true)

  // Contract/agreement reference
  contractReference String?
  notes            String?

  // Relations
  transactionCosts TransactionCost[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([venueId, accountType, effectiveFrom])
  @@index([venueId])
  @@index([accountType])
  @@index([effectiveFrom])
}
```

**Code Example**:

```typescript
// Create pricing structure for a new venue
const venuePricing = await prisma.venuePricingStructure.create({
  data: {
    venueId: 'venue_centro',
    accountType: 'PRIMARY',
    debitRate: 0.02, // 2.0% (0.45% margin over 1.55% cost)
    creditRate: 0.0315, // 3.15% (0.50% margin over 2.65% cost)
    amexRate: 0.0425, // 4.25% (0.50% margin over 3.75% cost)
    internationalRate: 0.0485, // 4.85% (0.60% margin over 4.25% cost)
    fixedFeePerTransaction: 0.8, // $0.80 MXN (margin over $0.52 cost)
    monthlyServiceFee: 799.0, // $799 MXN monthly service fee
    effectiveFrom: new Date('2024-02-01'),
    active: true,
    contractReference: 'CONTRACT-CENTRO-2024-001',
    notes: 'Standard pricing tier for primary account',
  },
})

// Get pricing for venue by account type
const pricing = await prisma.venuePricingStructure.findFirst({
  where: {
    venueId: 'venue_centro',
    accountType: 'PRIMARY',
    active: true,
    effectiveFrom: { lte: new Date() },
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: new Date() } }],
  },
  orderBy: { effectiveFrom: 'desc' },
})
```

**Key Features**:

- Account type-specific pricing (primary/secondary/tertiary)
- Card type-specific rates with margins
- Contract reference tracking
- Volume-based pricing rules
- Time-based validity periods

---

#### **TransactionCost**

**Purpose**: Records actual costs and revenue for each transaction to track Avoqado's profit.

**Use Case**: $1,000 MXN credit card payment: Provider cost $25.50, Venue charge $30.75, Gross profit $5.25 (17.07% margin). Links to
specific cost structures used for audit trail.

**Model Definition**:

```prisma
model TransactionCost {
  id String @id @default(cuid())

  // Payment reference
  paymentId String @unique
  payment   Payment @relation(fields: [paymentId], references: [id], onDelete: Cascade)

  // Account used for this transaction
  merchantAccountId String
  merchantAccount   MerchantAccount @relation(fields: [merchantAccountId], references: [id])

  // Transaction details
  transactionType TransactionCardType
  amount         Decimal @db.Decimal(12, 2)

  // Costs (what we pay to provider)
  providerRate        Decimal @db.Decimal(5, 4)  // Rate charged by provider
  providerCostAmount  Decimal @db.Decimal(10, 4) // Actual cost amount
  providerFixedFee    Decimal @default(0) @db.Decimal(8, 4)

  // Revenue (what we charge venue)
  venueRate          Decimal @db.Decimal(5, 4)  // Rate we charge venue
  venueChargeAmount  Decimal @db.Decimal(10, 4) // What we charge venue
  venueFixedFee      Decimal @default(0) @db.Decimal(8, 4)

  // Profit calculation
  grossProfit    Decimal @db.Decimal(10, 4) // venueCharge - providerCost
  profitMargin   Decimal @db.Decimal(5, 4)  // grossProfit / venueCharge

  // References to cost structures used
  providerCostStructureId String?
  providerCostStructure   ProviderCostStructure? @relation(fields: [providerCostStructureId], references: [id])

  venuePricingStructureId String?
  venuePricingStructure   VenuePricingStructure? @relation(fields: [venuePricingStructureId], references: [id])

  createdAt DateTime @default(now())

  @@index([paymentId])
  @@index([merchantAccountId])
  @@index([transactionType])
  @@index([createdAt])
}
```

**Code Example**:

```typescript
// Calculate and record transaction cost when payment is processed
const transactionCost = await prisma.transactionCost.create({
  data: {
    paymentId: payment.id,
    merchantAccountId: merchantAccount.id,
    transactionType: 'CREDIT',
    amount: 1000.0,

    // Provider costs (what we pay)
    providerRate: 0.0265, // 2.65%
    providerCostAmount: 26.5, // $26.50 MXN
    providerFixedFee: 0.52, // $0.52 MXN

    // Venue charges (what we charge)
    venueRate: 0.0315, // 3.15%
    venueChargeAmount: 31.5, // $31.50 MXN
    venueFixedFee: 0.8, // $0.80 MXN

    // Profit calculation
    grossProfit: 5.28, // (31.50 + 0.80) - (26.50 + 0.52) = $5.28
    profitMargin: 0.1634, // 5.28 / 32.30 = 16.34%

    providerCostStructureId: currentCosts.id,
    venuePricingStructureId: currentPricing.id,
  },
  include: {
    payment: { include: { order: true } },
    merchantAccount: { include: { provider: true } },
  },
})

// Get profit analysis for a date range
const profitAnalysis = await prisma.transactionCost.findMany({
  where: {
    createdAt: {
      gte: startOfMonth,
      lte: endOfMonth,
    },
    payment: {
      venue: { id: venueId },
    },
  },
  include: {
    payment: {
      include: {
        order: { select: { orderNumber: true } },
        venue: { select: { name: true } },
      },
    },
  },
})
```

**Key Features**:

- Real-time profit calculation
- Provider cost vs venue charge comparison
- Profit margin tracking
- Card type and amount details
- Link to cost structures used

---

#### **MonthlyVenueProfit**

**Purpose**: Aggregated monthly profit summary per venue for business intelligence.

**Use Case**: Avoqado Centro processed 1,247 transactions in January 2024, total volume $186,420 MXN, provider costs $4,125, venue charges
$5,236, gross profit $1,111 (21.2% average margin).

**Model Definition**:

```prisma
model MonthlyVenueProfit {
  id String @id @default(cuid())

  venueId String
  venue   Venue  @relation(fields: [venueId], references: [id], onDelete: Cascade)

  // Period
  year  Int
  month Int

  // Volume metrics
  totalTransactions    Int
  totalVolume         Decimal @db.Decimal(15, 2)

  // By transaction type
  debitTransactions    Int     @default(0)
  debitVolume         Decimal @default(0) @db.Decimal(15, 2)
  creditTransactions  Int     @default(0)
  creditVolume        Decimal @default(0) @db.Decimal(15, 2)
  amexTransactions    Int     @default(0)
  amexVolume          Decimal @default(0) @db.Decimal(15, 2)
  internationalTransactions Int @default(0)
  internationalVolume Decimal @default(0) @db.Decimal(15, 2)

  // Financial summary
  totalProviderCosts  Decimal @db.Decimal(12, 4) // What we paid to providers
  totalVenueCharges   Decimal @db.Decimal(12, 4) // What we charged venue
  totalGrossProfit    Decimal @db.Decimal(12, 4) // Our profit
  averageProfitMargin Decimal @db.Decimal(5, 4)  // Average margin %

  // Monthly fees
  monthlyProviderFees Decimal @default(0) @db.Decimal(10, 2)
  monthlyServiceFees  Decimal @default(0) @db.Decimal(10, 2)

  // Status
  status ProfitStatus @default(CALCULATED)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([venueId, year, month])
  @@index([venueId])
  @@index([year, month])
  @@index([status])
}
```

**Code Example**:

```typescript
// Generate monthly profit summary for a venue
const monthlyProfit = await prisma.monthlyVenueProfit.create({
  data: {
    venueId: 'venue_centro',
    year: 2024,
    month: 1, // January

    // Volume metrics
    totalTransactions: 1247,
    totalVolume: 186420.0,

    // By card type
    debitTransactions: 523,
    debitVolume: 67890.5,
    creditTransactions: 612,
    creditVolume: 98234.25,
    amexTransactions: 89,
    amexVolume: 15623.75,
    internationalTransactions: 23,
    internationalVolume: 4671.5,

    // Financial summary
    totalProviderCosts: 4125.8, // What we paid providers
    totalVenueCharges: 5236.45, // What we charged venue
    totalGrossProfit: 1110.65, // Our profit
    averageProfitMargin: 0.2123, // 21.23% average

    // Monthly fees
    monthlyProviderFees: 525.0, // Provider monthly fees
    monthlyServiceFees: 799.0, // What we charge venue monthly

    status: 'CALCULATED',
  },
})

// Get profit trends for venue over time
const profitTrends = await prisma.monthlyVenueProfit.findMany({
  where: {
    venueId: 'venue_centro',
    year: 2024,
  },
  orderBy: { month: 'asc' },
  include: {
    venue: {
      select: { name: true, slug: true },
    },
  },
})

// Calculate year-over-year growth
const yearComparison = await prisma.$queryRaw`
  SELECT 
    year,
    SUM(total_gross_profit) as yearly_profit,
    SUM(total_volume) as yearly_volume,
    AVG(average_profit_margin) as avg_margin
  FROM "MonthlyVenueProfit"
  WHERE venue_id = ${venueId}
  GROUP BY year
  ORDER BY year DESC
`
```

**Key Features**:

- Transaction volume and count by card type
- Provider costs vs venue charges
- Profit margins and totals
- Monthly fee tracking
- Status management for verification

---

### 🔔 **Notifications System**

#### **Notification**

**Purpose**: In-app and external notification delivery system for staff communication.

**Use Case**: "New order #ORD-12345 received at table M5" notification sent to all waiters with HIGH priority via in-app and push channels.

**Model Definition**:

```prisma
model Notification {
  id String @id @default(cuid())

  // Recipient
  recipientId String
  recipient   Staff  @relation(fields: [recipientId], references: [id], onDelete: Cascade)

  // Context
  venueId String?
  venue   Venue?  @relation(fields: [venueId], references: [id], onDelete: Cascade)

  // Notification content
  type        NotificationType
  title       String
  message     String
  actionUrl   String? // Deep link or route
  actionLabel String? // Button text like "View Order"

  // Metadata
  entityType String? // "Order", "Payment", "Review", etc.
  entityId   String? // ID of related entity
  metadata   Json?   // Additional context data

  // Status
  isRead   Boolean              @default(false)
  readAt   DateTime?
  priority NotificationPriority @default(NORMAL)

  // Delivery channels
  channels NotificationChannel[] @default([IN_APP])

  // Tracking
  sentAt   DateTime?
  failedAt DateTime?
  errorMsg String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([recipientId])
  @@index([venueId])
  @@index([type])
  @@index([isRead])
  @@index([createdAt])
  @@index([entityType, entityId])
}
```

**Code Example**:

```typescript
// Send notification when new order is received
const orderNotification = await prisma.notification.create({
  data: {
    recipientId: 'staff_maria_123',
    venueId: 'venue_centro',
    type: 'NEW_ORDER',
    title: 'New Order Received',
    message: 'Order #ORD-12345 received at table M5 - 2 items, $150 MXN total',
    actionUrl: '/orders/ord-12345',
    actionLabel: 'View Order',
    entityType: 'Order',
    entityId: 'ord-12345',
    priority: 'HIGH',
    channels: ['IN_APP', 'PUSH'],
    metadata: {
      orderNumber: 'ORD-12345',
      tableNumber: 'M5',
      totalAmount: 150.0,
      itemCount: 2,
    },
  },
})

// Get unread notifications for staff member
const unreadNotifications = await prisma.notification.findMany({
  where: {
    recipientId: 'staff_maria_123',
    venueId: 'venue_centro',
    isRead: false,
  },
  orderBy: {
    createdAt: 'desc',
  },
  take: 20,
})

// Mark notification as read
await prisma.notification.update({
  where: { id: orderNotification.id },
  data: {
    isRead: true,
    readAt: new Date(),
  },
})
```

**Key Features**:

- Multiple delivery channels (in-app, email, SMS, push)
- Priority levels and read status tracking
- Rich content with action buttons
- Entity linking for context
- Delivery status tracking

---

#### **NotificationPreference**

**Purpose**: User and venue-specific notification settings for personalized communication.

**Use Case**: Waiter Maria wants order notifications via push but inventory alerts disabled. Manager Carlos wants all notifications via
email during quiet hours (10PM-8AM).

**Model Definition**:

```prisma
model NotificationPreference {
  id String @id @default(cuid())

  staffId String
  staff   Staff  @relation(fields: [staffId], references: [id], onDelete: Cascade)

  venueId String?
  venue   Venue?  @relation(fields: [venueId], references: [id], onDelete: Cascade)

  // Notification type settings
  type     NotificationType
  enabled  Boolean               @default(true)
  channels NotificationChannel[] @default([IN_APP])
  priority NotificationPriority  @default(NORMAL)

  // Scheduling
  quietStart String? // "22:00" - don't send notifications after this time
  quietEnd   String? // "08:00" - don't send notifications before this time

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([staffId, venueId, type])
  @@index([staffId])
  @@index([type])
}
```

**Code Example**:

```typescript
// Set notification preferences for staff member
const preferences = await Promise.all([
  // Maria wants order notifications via push and in-app
  prisma.notificationPreference.upsert({
    where: {
      staffId_venueId_type: {
        staffId: 'staff_maria_123',
        venueId: 'venue_centro',
        type: 'NEW_ORDER',
      },
    },
    update: {
      enabled: true,
      channels: ['IN_APP', 'PUSH'],
      priority: 'HIGH',
    },
    create: {
      staffId: 'staff_maria_123',
      venueId: 'venue_centro',
      type: 'NEW_ORDER',
      enabled: true,
      channels: ['IN_APP', 'PUSH'],
      priority: 'HIGH',
    },
  }),

  // But disable inventory notifications
  prisma.notificationPreference.upsert({
    where: {
      staffId_venueId_type: {
        staffId: 'staff_maria_123',
        venueId: 'venue_centro',
        type: 'LOW_INVENTORY',
      },
    },
    update: { enabled: false },
    create: {
      staffId: 'staff_maria_123',
      venueId: 'venue_centro',
      type: 'LOW_INVENTORY',
      enabled: false,
    },
  }),

  // Manager wants email notifications during quiet hours
  prisma.notificationPreference.upsert({
    where: {
      staffId_venueId_type: {
        staffId: 'staff_carlos_456',
        venueId: 'venue_centro',
        type: 'NEW_REVIEW',
      },
    },
    update: {
      channels: ['EMAIL'],
      quietStart: '22:00',
      quietEnd: '08:00',
    },
    create: {
      staffId: 'staff_carlos_456',
      venueId: 'venue_centro',
      type: 'NEW_REVIEW',
      enabled: true,
      channels: ['EMAIL'],
      quietStart: '22:00',
      quietEnd: '08:00',
    },
  }),
])
```

---

#### **NotificationTemplate**

**Purpose**: Reusable notification templates with variable substitution for consistent messaging.

**Use Case**: "New order #{{orderNumber}} received at table {{tableNumber}}" template with variables that get replaced with actual values
for each notification.

**Model Definition**:

```prisma
model NotificationTemplate {
  id String @id @default(cuid())

  type        NotificationType
  language    String           @default("es")
  title       String
  message     String
  actionLabel String?

  // Variables that can be used in templates
  // e.g., "{{customerName}} left a {{rating}}-star review"
  variables String[] @default([])

  active Boolean @default(true)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([type, language])
  @@index([type])
  @@index([active])
}
```

**Code Example**:

```typescript
// Create notification templates
const templates = await Promise.all([
  prisma.notificationTemplate.create({
    data: {
      type: 'NEW_ORDER',
      language: 'es',
      title: 'Nueva Orden',
      message: 'Orden #{{orderNumber}} recibida en mesa {{tableNumber}} - {{itemCount}} productos, ${{totalAmount}} MXN',
      actionLabel: 'Ver Orden',
      variables: ['orderNumber', 'tableNumber', 'itemCount', 'totalAmount'],
    },
  }),

  prisma.notificationTemplate.create({
    data: {
      type: 'NEW_REVIEW',
      language: 'es',
      title: 'Nueva Reseña',
      message: "{{customerName}} dejó una reseña de {{rating}} estrellas: '{{comment}}'",
      actionLabel: 'Ver Reseña',
      variables: ['customerName', 'rating', 'comment'],
    },
  }),

  prisma.notificationTemplate.create({
    data: {
      type: 'LOW_INVENTORY',
      language: 'es',
      title: 'Inventario Bajo',
      message: '{{productName}} tiene solo {{currentStock}} {{unit}} restantes (mínimo: {{minimumStock}})',
      actionLabel: 'Ver Inventario',
      variables: ['productName', 'currentStock', 'unit', 'minimumStock'],
    },
  }),
])

// Function to render notification with template
function renderNotification(template: NotificationTemplate, variables: Record<string, any>): { title: string; message: string } {
  let title = template.title
  let message = template.message

  // Replace variables in template
  template.variables.forEach(variable => {
    const value = variables[variable] || ''
    const regex = new RegExp(`{{${variable}}}`, 'g')
    title = title.replace(regex, value.toString())
    message = message.replace(regex, value.toString())
  })

  return { title, message }
}

// Use template to create notification
const template = await prisma.notificationTemplate.findUnique({
  where: { type_language: { type: 'NEW_ORDER', language: 'es' } },
})

if (template) {
  const rendered = renderNotification(template, {
    orderNumber: 'ORD-12345',
    tableNumber: 'M5',
    itemCount: 3,
    totalAmount: 245.5,
  })

  await prisma.notification.create({
    data: {
      recipientId: 'staff_maria_123',
      venueId: 'venue_centro',
      type: 'NEW_ORDER',
      title: rendered.title,
      message: rendered.message,
      // ... other notification data
    },
  })
}
```

---

### 🖥️ **Hardware Management**

#### **Terminal**

**Purpose**: TPV (Terminal Portátil de Ventas) devices used for POS operations with health monitoring.

**Use Case**: Android tablet "TPV-01" at Avoqado Centro running AvoqadoPOS v2.1.4, last heartbeat 30 seconds ago, battery 85%, WiFi signal
strong. Health monitoring detects issues automatically.

**Model Definition**:

```prisma
model Terminal {
  id      String @id @default(cuid())
  venueId String
  venue   Venue  @relation(fields: [venueId], references: [id])

  serialNumber String       @unique
  name         String
  type         TerminalType

  // Status
  status        TerminalStatus @default(INACTIVE)
  lastHeartbeat DateTime?

  // Health monitoring
  version       String? // AvoqadoPOS version
  systemInfo    Json?   // Platform, memory, uptime, etc.
  ipAddress     String? // Last known IP address

  // Configuration
  config Json?

  // Preferred processor for this TPV (LEGACY/MENTA/AUTO)
  preferredProcessor PaymentProcessor @default(AUTO)

  reviews Review[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([venueId])
  @@index([status])
}
```

**Code Example**:

```typescript
// Register new terminal for venue
const terminal = await prisma.terminal.create({
  data: {
    venueId: 'venue_centro',
    serialNumber: 'TPV-CENTRO-001',
    name: 'Terminal Principal',
    type: 'TPV_ANDROID',
    status: 'ACTIVE',
    version: '2.1.4',
    preferredProcessor: 'MENTA',
    systemInfo: {
      platform: 'Android 13',
      model: 'Samsung Galaxy Tab A8',
      screenSize: '10.5 inch',
      memory: '4GB RAM',
      storage: '64GB',
    },
    config: {
      autoLock: 300, // seconds
      printReceipts: true,
      collectReviews: true,
      language: 'es',
      timezone: 'America/Mexico_City',
    },
  },
})

// Update terminal health on heartbeat
const updateHeartbeat = await prisma.terminal.update({
  where: { id: terminal.id },
  data: {
    lastHeartbeat: new Date(),
    status: 'ACTIVE',
    systemInfo: {
      ...terminal.systemInfo,
      batteryLevel: 85,
      wifiSignal: 'Strong',
      memoryUsage: '2.1GB / 4GB',
      uptime: '2 days 14 hours',
      lastSync: new Date().toISOString(),
    },
    ipAddress: '192.168.1.115',
  },
})

// Check for offline terminals
const offlineTerminals = await prisma.terminal.findMany({
  where: {
    venueId: 'venue_centro',
    OR: [{ lastHeartbeat: { lt: fiveMinutesAgo } }, { status: 'INACTIVE' }],
  },
  include: {
    venue: { select: { name: true } },
  },
})

// Send alerts for offline terminals
for (const offlineTerminal of offlineTerminals) {
  await prisma.notification.create({
    data: {
      recipientId: 'manager_id',
      venueId: offlineTerminal.venueId,
      type: 'SYSTEM_ALERT',
      title: 'Terminal Sin Conexión',
      message: `Terminal ${offlineTerminal.name} (${offlineTerminal.serialNumber}) no ha enviado heartbeat desde ${offlineTerminal.lastHeartbeat}`,
      actionUrl: `/terminals/${offlineTerminal.id}`,
      actionLabel: 'Ver Terminal',
      priority: 'HIGH',
    },
  })
}

// Get terminal performance stats
const terminalStats = await prisma.$queryRaw`
  SELECT 
    t.id,
    t.name,
    t.serial_number,
    COUNT(r.id) as reviews_collected,
    AVG(r.overall_rating) as avg_rating,
    DATE_TRUNC('hour', t.last_heartbeat) as last_active
  FROM "Terminal" t
  LEFT JOIN "Review" r ON r.terminal_id = t.id 
    AND r.created_at >= NOW() - INTERVAL '30 days'
  WHERE t.venue_id = ${venueId}
  GROUP BY t.id, t.name, t.serial_number, t.last_heartbeat
  ORDER BY t.name
`
```

**Key Features**:

- Device health monitoring (heartbeat, system info)
- Version tracking and updates
- Network information
- Payment processor preferences
- Review collection integration

---

### 📊 **Reviews & Feedback**

#### **Review**

**Purpose**: Customer feedback collection with ratings and responses.

**Use Case**: Customer at Table 5 gives 4/5 stars with comment "Great food, slow service" linked to waiter Maria and payment #PAY-12345.
System can auto-respond or alert staff for manual response.

**Model Definition**:

```prisma
model Review {
  id      String @id @default(cuid())
  venueId String
  venue   Venue  @relation(fields: [venueId], references: [id])

  // Rating
  overallRating  Int // 1-5
  foodRating     Int?
  serviceRating  Int?
  ambienceRating Int?

  comment String?

  // Customer info
  customerName  String?
  customerEmail String?

  // Source
  source     ReviewSource @default(AVOQADO)
  externalId String? // Google review ID, etc.

  terminalId String?
  terminal   Terminal? @relation(fields: [terminalId], references: [id])

  paymentId String?  @unique // Un pago solo puede tener un review directo
  payment   Payment? @relation(fields: [paymentId], references: [id], onDelete: Cascade)

  servedById String? // Para ligar al mesero
  servedBy   Staff?  @relation(fields: [servedById], references: [id])

  // Response
  responseText      String?
  respondedAt       DateTime?
  responseAutomated Boolean   @default(false)

  createdAt DateTime @default(now())

  @@index([venueId])
  @@index([overallRating])
  @@index([createdAt])
  @@index([terminalId])
  @@index([paymentId])
  @@index([servedById])
}
```

**Code Example**:

```typescript
// Create review from customer feedback after payment
const review = await prisma.review.create({
  data: {
    venueId: 'venue_centro',
    paymentId: 'payment_12345',
    terminalId: 'terminal_tpv_01',
    servedById: 'staff_maria_123',

    // Ratings
    overallRating: 4,
    foodRating: 5,
    serviceRating: 3,
    ambienceRating: 4,

    // Customer feedback
    comment: 'La comida estuvo excelente, especialmente las quesadillas. El servicio fue un poco lento pero el mesero fue muy amable.',
    customerName: 'Ana García',
    customerEmail: 'ana.garcia@email.com',

    source: 'TPV',
  },
  include: {
    venue: { select: { name: true } },
    servedBy: { select: { firstName: true, lastName: true } },
    payment: {
      select: {
        amount: true,
        order: { select: { orderNumber: true } },
      },
    },
  },
})

// Auto-respond to good reviews
if (review.overallRating >= 4) {
  await prisma.review.update({
    where: { id: review.id },
    data: {
      responseText:
        '¡Gracias por tu reseña! Nos alegra saber que disfrutaste tu experiencia en nuestro restaurante. ¡Esperamos verte pronto!',
      respondedAt: new Date(),
      responseAutomated: true,
    },
  })
}

// Alert staff for bad reviews
if (review.overallRating <= 2) {
  await prisma.notification.create({
    data: {
      recipientId: review.servedById || 'manager_id',
      venueId: review.venueId,
      type: 'BAD_REVIEW',
      title: 'Reseña Negativa Recibida',
      message: `Reseña de ${review.overallRating} estrellas: "${review.comment}"`,
      actionUrl: `/reviews/${review.id}`,
      actionLabel: 'Responder Reseña',
      priority: 'HIGH',
    },
  })
}

// Get review analytics for venue
const reviewStats = await prisma.review.aggregate({
  where: {
    venueId: 'venue_centro',
    createdAt: { gte: startOfMonth },
  },
  _avg: {
    overallRating: true,
    foodRating: true,
    serviceRating: true,
    ambienceRating: true,
  },
  _count: {
    id: true,
  },
})

// Get staff performance from reviews
const staffPerformance = await prisma.review.groupBy({
  by: ['servedById'],
  where: {
    venueId: 'venue_centro',
    servedById: { not: null },
    createdAt: { gte: startOfMonth },
  },
  _avg: {
    overallRating: true,
    serviceRating: true,
  },
  _count: {
    id: true,
  },
})
```

**Key Features**:

- Multi-aspect ratings (food, service, ambience)
- Staff performance tracking
- Payment and terminal linking
- Automated response capabilities
- Multiple review sources (Avoqado, Google, etc.)

---

### 🧾 **Billing & Revenue**

#### **Invoice**

**Purpose**: Consolidated billing for organizations covering transaction fees and feature subscriptions.

**Use Case**: Monthly invoice for "Grupo Avoqado Prime" showing $1,234.56 in transaction fees and $99.99 in feature subscriptions, total
$1,534.67 including 16% tax.

---

#### **Feature & VenueFeature**

**Purpose**: Subscription-based feature system allowing venues to enable/disable premium capabilities.

**Use Case**: Avoqado Centro subscribes to "AI Assistant" ($39.99/month) and "Advanced Reports" ($19.99/month) while Avoqado Sur only has
basic features.

---

### 🔄 **POS Integration**

#### **PosConnectionStatus**

**Purpose**: Real-time monitoring of POS system connectivity and health.

**Use Case**: SoftRestaurant POS at venue shows ONLINE status, last heartbeat 45 seconds ago, instance ID changed (needs reconciliation),
running producer v1.2.3.

---

#### **PosCommand**

**Purpose**: Queue system for sending commands to POS systems with retry logic.

**Use Case**: When order is created in Avoqado, a CREATE command is queued to sync with SoftRestaurant. If it fails, system retries
automatically with exponential backoff.

---

### 📈 **Analytics & AI**

#### **ChatTrainingData**

**Purpose**: AI training data collection for improving the system's natural language processing capabilities.

**Use Case**: User asks "How much did we sell last week?" AI generates SQL query, returns results, and stores the interaction for training
improvement with user feedback on accuracy.

---

#### **ActivityLog**

**Purpose**: Comprehensive audit trail of all user actions for security and compliance.

**Use Case**: "Staff maria.gonzalez@avoqado.com updated Order ORD-12345 status from PENDING to CONFIRMED at 2024-01-15 14:30:25 from IP
192.168.1.100"

---

## Schema Evolution Guidelines

### When Modifying the Schema:

1. **Always update this documentation** when making schema changes
2. **Update CLAUDE.md** with references to schema changes
3. **Run migrations** in development and test environments first
4. **Update seed data** if new models are added
5. **Update API documentation** for affected endpoints
6. **Consider backward compatibility** for existing integrations

### Documentation Maintenance:

- Each model should have purpose and use case examples
- Update examples when business logic changes
- Keep relationships documentation current
- Document any business rules or constraints
- Include migration notes for breaking changes

---

## Technical Notes

### Performance Considerations:

- Indexes are optimized for common query patterns
- JSON fields used for flexible configuration
- Audit tables designed for high-volume inserts
- Partitioning considered for time-series data

### Security Considerations:

- Credentials are encrypted at rest
- Audit trails for all sensitive operations
- Role-based access control implementation
- Secure token generation for invitations

### Scalability Considerations:

- Multi-tenant architecture supports horizontal scaling
- Generic provider system allows easy integration expansion
- Flexible JSON configurations reduce schema migrations
- Event-driven architecture for real-time updates

---

_Last updated: January 2026_ _Schema version: v3.0.0 (Multi-Org StaffOrganization Junction Table + Generic Payment Providers + Cost
Management)_
