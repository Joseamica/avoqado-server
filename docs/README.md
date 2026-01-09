# Avoqado Documentation Hub

> **This is the SINGLE SOURCE OF TRUTH for cross-repo documentation.**
>
> Frontend-specific docs: `avoqado-web-dashboard/docs/`
> Android-specific docs: `avoqado-tpv/docs/`

---

## Quick Navigation

| I need to... | Go to |
|--------------|-------|
| Understand the architecture | [ARCHITECTURE_OVERVIEW.md](./ARCHITECTURE_OVERVIEW.md) |
| Work on Blumon payments | [BLUMON_TWO_INTEGRATIONS.md](./BLUMON_TWO_INTEGRATIONS.md) |
| Add a new VenueType | [BUSINESS_TYPES.md](./BUSINESS_TYPES.md) |
| Understand the database | [DATABASE_SCHEMA.md](./DATABASE_SCHEMA.md) |
| Work on inventory | [INVENTORY_REFERENCE.md](./INVENTORY_REFERENCE.md) |
| Work on serialized inventory | [features/SERIALIZED_INVENTORY.md](./features/SERIALIZED_INVENTORY.md) |
| Work on auto-reorder | [features/AUTO_REORDER.md](./features/AUTO_REORDER.md) |
| Work on suppliers | [features/SUPPLIER_MANAGEMENT.md](./features/SUPPLIER_MANAGEMENT.md) |
| Work on discounts | [features/DISCOUNT_ENGINE.md](./features/DISCOUNT_ENGINE.md) |
| Work on floor plans/tables | [features/FLOOR_TABLES.md](./features/FLOOR_TABLES.md) |
| Work on AI chatbot | [CHATBOT_TEXT_TO_SQL_REFERENCE.md](./CHATBOT_TEXT_TO_SQL_REFERENCE.md) |
| Work on permissions | [PERMISSIONS_SYSTEM.md](./PERMISSIONS_SYSTEM.md) |
| Work on split payments | [features/SPLIT_PAYMENTS.md](./features/SPLIT_PAYMENTS.md) |
| Work on refunds | [features/REFUNDS.md](./features/REFUNDS.md) |
| Work on time/attendance | [features/TIME_ENTRY_ATTENDANCE.md](./features/TIME_ENTRY_ATTENDANCE.md) |
| Deploy to production | [PRODUCTION_READINESS_CHECKLIST.md](./PRODUCTION_READINESS_CHECKLIST.md) |

---

## Architecture & Core

| Document | Description |
|----------|-------------|
| [ARCHITECTURE_OVERVIEW.md](./ARCHITECTURE_OVERVIEW.md) | Layered architecture, multi-tenant, control/application plane |
| [DATABASE_SCHEMA.md](./DATABASE_SCHEMA.md) | Complete Prisma schema reference |
| [BUSINESS_TYPES.md](./BUSINESS_TYPES.md) | VenueType enum, BusinessCategory, MCC mapping |
| [PERMISSIONS_SYSTEM.md](./PERMISSIONS_SYSTEM.md) | RBAC, permission format, override vs merge |
| [ENUM_SYNC_REFERENCE.md](./ENUM_SYNC_REFERENCE.md) | Keeping enums in sync across repos |

---

## Payments

### Blumon (Start Here)

| Document | Description |
|----------|-------------|
| [BLUMON_TWO_INTEGRATIONS.md](./BLUMON_TWO_INTEGRATIONS.md) | **READ FIRST**: TPV vs E-commerce distinction |
| [PAYMENT_ARCHITECTURE.md](./PAYMENT_ARCHITECTURE.md) | Money flow, merchant accounts, profit calculation |

### Blumon TPV (Android POS Terminals)

| Document | Description |
|----------|-------------|
| [blumon-tpv/README.md](./blumon-tpv/README.md) | TPV integration index |
| [blumon-tpv/BLUMON_QUICK_REFERENCE.md](./blumon-tpv/BLUMON_QUICK_REFERENCE.md) | Developer quick reference |
| [blumon-tpv/BLUMON_MULTI_MERCHANT_ANALYSIS.md](./blumon-tpv/BLUMON_MULTI_MERCHANT_ANALYSIS.md) | Multi-merchant deep dive |
| [blumon-tpv/BLUMON_WEBHOOK_PAYLOAD.md](./blumon-tpv/BLUMON_WEBHOOK_PAYLOAD.md) | Webhook payload structure |

### Blumon E-commerce (Web Payments)

| Document | Description |
|----------|-------------|
| [blumon-ecommerce/README.md](./blumon-ecommerce/README.md) | E-commerce integration index |
| [blumon-ecommerce/REFACTORING_COMPLETE.md](./blumon-ecommerce/REFACTORING_COMPLETE.md) | Direct charge implementation |
| [blumon-ecommerce/SDK_INTEGRATION_GUIDE.md](./blumon-ecommerce/SDK_INTEGRATION_GUIDE.md) | SDK integration guide |
| [blumon-ecommerce/SDK_SAQ_A_COMPLIANCE.md](./blumon-ecommerce/SDK_SAQ_A_COMPLIANCE.md) | PCI SAQ-A compliance |

### Stripe

| Document | Description |
|----------|-------------|
| [STRIPE_INTEGRATION.md](./STRIPE_INTEGRATION.md) | Subscriptions, feature gating, webhooks |
| [STRIPE_COMPLETE_IMPLEMENTATION_PLAN.md](./STRIPE_COMPLETE_IMPLEMENTATION_PLAN.md) | Full implementation plan |

### Merchant Accounts

| Document | Description |
|----------|-------------|
| [MERCHANT_MODELS_ARCHITECTURE.md](./MERCHANT_MODELS_ARCHITECTURE.md) | MerchantAccount vs EcommerceMerchant |
| [MERCHACCOUNTANALYSIS.md](./MERCHACCOUNTANALYSIS.md) | Merchant account analysis |

---

## Features

### Inventory & Purchasing

| Document | Description |
|----------|-------------|
| [INVENTORY_REFERENCE.md](./INVENTORY_REFERENCE.md) | FIFO batch system, stock deduction, recipes |
| [INVENTORY_TESTING.md](./INVENTORY_TESTING.md) | Integration tests, critical bugs fixed |
| [features/SERIALIZED_INVENTORY.md](./features/SERIALIZED_INVENTORY.md) | Unique barcode items (SIMs, jewelry), module system, mixed carts |
| [features/AUTO_REORDER.md](./features/AUTO_REORDER.md) | Auto-reorder suggestions, demand forecasting, urgency levels |
| [features/SUPPLIER_MANAGEMENT.md](./features/SUPPLIER_MANAGEMENT.md) | Supplier CRUD, pricing, recommendations, performance metrics |

### Orders & Payments

| Document | Description |
|----------|-------------|
| [features/DISCOUNT_ENGINE.md](./features/DISCOUNT_ENGINE.md) | Discount calculation, BOGO, time-based, stacking rules |
| [features/SPLIT_PAYMENTS.md](./features/SPLIT_PAYMENTS.md) | Split payment types, PaymentAllocation, transition rules |
| [features/REFUNDS.md](./features/REFUNDS.md) | Refund processing, partial refunds, multi-merchant routing |
| [features/DIGITAL_RECEIPTS.md](./features/DIGITAL_RECEIPTS.md) | Digital receipt generation, immutable snapshots, email delivery |
| [PAY_LATER_ORDER_CLASSIFICATION.md](./PAY_LATER_ORDER_CLASSIFICATION.md) | Pay later order classification logic |

### Venue & Operations

| Document | Description |
|----------|-------------|
| [features/FLOOR_TABLES.md](./features/FLOOR_TABLES.md) | Floor plans, table management, real-time status via Socket.IO |
| [features/TIME_ENTRY_ATTENDANCE.md](./features/TIME_ENTRY_ATTENDANCE.md) | Clock in/out, PIN verification, breaks, anti-fraud photos |
| [features/CASH_CLOSEOUT.md](./features/CASH_CLOSEOUT.md) | Cash reconciliation, variance detection, deposit methods |
| [SHIFT_MANAGEMENT_ROADMAP.md](./SHIFT_MANAGEMENT_ROADMAP.md) | Shift management implementation |
| [features/SETTLEMENT_INCIDENTS.md](./features/SETTLEMENT_INCIDENTS.md) | Settlement incident tracking for SOFOM |

### AI & Analytics

| Document | Description |
|----------|-------------|
| [CHATBOT_TEXT_TO_SQL_REFERENCE.md](./CHATBOT_TEXT_TO_SQL_REFERENCE.md) | 5-layer security, consensus voting |

### Customers & Promotions

| Document | Description |
|----------|-------------|
| [clients&promotions/CUSTOMER_LOYALTY_PROMOTIONS_REFERENCE.md](./clients&promotions/CUSTOMER_LOYALTY_PROMOTIONS_REFERENCE.md) | Customers & promotions reference |
| [clients&promotions/CUSTOMER_DISCOUNT_IMPLEMENTATION_PLAN.md](./clients&promotions/CUSTOMER_DISCOUNT_IMPLEMENTATION_PLAN.md) | Discount implementation plan |

---

## Terminal & TPV

| Document | Description |
|----------|-------------|
| [TERMINAL_IDENTIFICATION.md](./TERMINAL_IDENTIFICATION.md) | Serial numbers, activation, heartbeat |
| [TPV_COMMAND_SYSTEM.md](./TPV_COMMAND_SYSTEM.md) | Remote commands, polling, ACK flow |

---

## Industry Configuration (Multi-Vertical)

| Document | Description |
|----------|-------------|
| [industry-config/README.md](./industry-config/README.md) | Overview and index |
| [industry-config/ARCHITECTURE.md](./industry-config/ARCHITECTURE.md) | Configuration-driven architecture |
| [industry-config/IMPLEMENTATION_PLAN.md](./industry-config/IMPLEMENTATION_PLAN.md) | Phase-by-phase plan |
| [industry-config/BACKEND_SPEC.md](./industry-config/BACKEND_SPEC.md) | Backend specifications |
| [industry-config/TPV_SPEC.md](./industry-config/TPV_SPEC.md) | TPV Android specifications |
| [industry-config/REQUIREMENTS_TELECOM.md](./industry-config/REQUIREMENTS_TELECOM.md) | PlayTelecom requirements |

---

## Development & Operations

| Document | Description |
|----------|-------------|
| [ENVIRONMENT_SETUP_GUIDE.md](./ENVIRONMENT_SETUP_GUIDE.md) | Local development setup |
| [DEV_ENVIRONMENT_PERFECTION_CHECKLIST.md](./DEV_ENVIRONMENT_PERFECTION_CHECKLIST.md) | Environment checklist |
| [DATETIME_SYNC.md](./DATETIME_SYNC.md) | Timezone handling between frontend/backend |
| [CI_CD_SETUP.md](./CI_CD_SETUP.md) | GitHub Actions, deployment |
| [GITHUB_ENVIRONMENTS.md](./GITHUB_ENVIRONMENTS.md) | GitHub environment configuration |
| [PRODUCTION_READINESS_CHECKLIST.md](./PRODUCTION_READINESS_CHECKLIST.md) | Pre-deployment checklist |
| [DEPLOYMENT-OPTIMIZATION-SUMMARY.md](./DEPLOYMENT-OPTIMIZATION-SUMMARY.md) | Deployment optimization |
| [UNUSED_CODE_DETECTION.md](./UNUSED_CODE_DETECTION.md) | Dead code detection tools |
| [SEED_CREDENTIALS.md](./SEED_CREDENTIALS.md) | Test credentials |
| [COST_MANAGEMENT_IMPLEMENTATION.md](./COST_MANAGEMENT_IMPLEMENTATION.md) | Cost management |

---

## Cross-Repo Documentation Structure

```
avoqado-server/docs/           <- YOU ARE HERE (Central Hub)
├── README.md                  <- This index
├── architecture/              <- Cross-repo architecture
├── features/                  <- Cross-repo features
├── blumon-tpv/               <- Blumon TPV integration
├── blumon-ecommerce/         <- Blumon E-commerce integration
├── industry-config/          <- Multi-vertical configuration
└── clients&promotions/       <- Customer & promotions

avoqado-web-dashboard/docs/    <- Frontend-specific
├── architecture/             <- React routing, overview
├── features/                 <- i18n, theme, inventory UI
├── guides/                   <- UI patterns, performance
└── troubleshooting/          <- React-specific issues

avoqado-tpv/docs/              <- Android-specific
├── android/                  <- Kotlin/Compose patterns
├── devices/                  <- PAX hardware guides
└── build/                    <- Build variants
```

---

## Documentation Policy

### When to Update

| Change Type | Action |
|-------------|--------|
| New feature affecting multiple repos | Add to `docs/features/` |
| Architecture changes | Update relevant doc in `docs/` |
| New VenueType | Update `BUSINESS_TYPES.md` |
| API changes | Update `DATABASE_SCHEMA.md` |
| Payment flow changes | Update `PAYMENT_ARCHITECTURE.md` |
| Frontend-only changes | Update `avoqado-web-dashboard/docs/` |
| Android-only changes | Update `avoqado-tpv/docs/` |

### Naming Convention

- `UPPERCASE_WITH_UNDERSCORES.md` for main docs
- `lowercase-with-dashes/` for subdirectories
- Prefix with category if unclear: `BLUMON_*.md`, `STRIPE_*.md`

---

**Last Updated:** 2025-01-06
