# Architecture Overview

This document provides a comprehensive view of the avoqado-server architecture, design principles, and organizational patterns.

---

## Core Business Domains

- **Organizations** - Multi-tenant root entities
- **Venues** - Individual business locations
- **Staff Management** - Role-based access control with hierarchical permission system
- **Menu & Product Management** - Menu categories, products, and pricing
- **Order Processing** - Order lifecycle management
- **POS Integration** - Real-time synchronization with Point-of-Sale systems
- **Payment Processing** - Transaction and payment management
- **Inventory Management** - FIFO batch tracking, recipe costing, and profit analytics

---

## Layered Architecture

### Request Flow

```
Routes → Middleware → Controllers → Services → Prisma (Database)
```

### Design Principles

- **Separation of Concerns** - Each layer has a single responsibility
- **Unidirectional Dependency Flow** - Dependencies flow inward (controllers depend on services, not vice versa)
- **HTTP Agnostic Core** - Business logic (services) knows nothing about HTTP
- **Thin Controllers** - Controllers orchestrate, services contain logic

### Layer Responsibilities

| Layer | Purpose | What it does | What it does NOT do |
|-------|---------|--------------|---------------------|
| **Routes** (`/src/routes/`) | HTTP endpoint definitions | Attach middleware chains to URLs | Business logic, data access |
| **Controllers** (`/src/controllers/`) | HTTP orchestration (thin layer) | Extract req data, call services, send responses | Business validation, database access |
| **Services** (`/src/services/`) | Business logic (core layer) | Validations, calculations, database operations | HTTP concerns (req/res), status codes |
| **Middlewares** (`/src/middlewares/`) | Cross-cutting concerns | Auth, validation, logging, permissions | Business logic, data persistence |
| **Schemas** (`/src/schemas/`) | Data validation | Zod schemas for request/response validation | Business rules enforcement |
| **Prisma** | Database access layer | ORM for type-safe database queries | Business logic |

### Why This Architecture?

- Business logic reusable (CLI, tests, background jobs)
- Easier testing (mock services, not HTTP)
- Framework independent (could switch Express → Fastify)
- Clear boundaries reduce coupling

### Code Examples

See code comments in:
- `src/controllers/dashboard/venue.dashboard.controller.ts:1-21` - Thin controller pattern explained
- `src/services/dashboard/venue.dashboard.service.ts:1-24` - HTTP-agnostic service pattern explained
- `src/utils/prismaClient.ts:3-21` - Singleton pattern for database connection pooling

---

## Multi-Tenant Architecture

All operations are scoped to:
- **Organization** - Top-level tenant
- **Venue** - Individual business location

**Critical**: All database queries MUST filter by `venueId` or `orgId`.

---

## Control Plane vs Application Plane (API Routes)

Industry-standard pattern for multi-tenant SaaS ([AWS](https://docs.aws.amazon.com/whitepapers/latest/saas-architecture-fundamentals/control-plane-vs.-application-plane.html), [Microsoft](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/considerations/control-planes)).

```
┌─────────────────────────────────────────────────────────────────┐
│ CONTROL PLANE (routes/superadmin.routes.ts)                     │
│ NOT multi-tenant. Manages ALL venues globally.                  │
├─────────────────────────────────────────────────────────────────┤
│ /api/v1/superadmin/revenue        → Platform-wide revenue       │
│ /api/v1/superadmin/features       → Global feature catalog      │
│ /api/v1/superadmin/kyc            → KYC queue for ALL venues    │
│ /api/v1/superadmin/venues         → All venues management       │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ APPLICATION PLANE (routes/dashboard.routes.ts)                  │
│ Multi-tenant. Venue-specific operations.                        │
├─────────────────────────────────────────────────────────────────┤
│ /api/v1/dashboard/venues/:venueId/*  → Venue-specific ops       │
│ Including SUPERADMIN actions for THIS venue:                    │
│   - POST /venues/:venueId/kyc/approve  (approve THIS venue)     │
│   - POST /venues/:venueId/features     (enable for THIS venue)  │
└─────────────────────────────────────────────────────────────────┘
```

### Decision Rule for New Endpoints

| Question | Answer | Where to add route |
|----------|--------|-------------------|
| Affects ALL venues/platform? | Yes | `superadmin.routes.ts` |
| Affects ONE specific venue? | Yes | `dashboard.routes.ts` with venueId param |

**Example:** Creating a new KYC endpoint
- `GET /superadmin/kyc` → List KYC queue for ALL venues (Control Plane)
- `POST /dashboard/venues/:venueId/kyc/approve` → Approve THIS venue's KYC (Application Plane)

---

## Technical Stack

| Component | Technology |
|-----------|------------|
| **Framework** | Express.js with TypeScript |
| **Database** | PostgreSQL with Prisma ORM |
| **Real-time** | Socket.IO for live updates |
| **Message Queue** | RabbitMQ for POS command processing |
| **Session** | Redis-backed sessions |
| **Authentication** | JWT with refresh tokens |
| **Validation** | Zod schemas |
| **Testing** | Jest with unit, API, and workflow tests |

---

## Service Organization

| Directory | Purpose |
|-----------|---------|
| `src/services/dashboard/` | Admin interface operations |
| `src/services/tpv/` | Point-of-sale terminal operations |
| `src/services/pos-sync/` | Legacy POS integration (SoftRestaurant) |
| `src/services/onboarding/` | Demo data seeding and cleanup |
| `src/services/sdk/` | Blumon E-commerce SDK |

---

## Real-Time Communication

- **Socket.IO** server for live updates
- **Room-based broadcasting**: `venue_{venueId}`
- **Event types**: order updates, payment completed, inventory changes

---

## POS Integration

- **RabbitMQ** message queue for legacy POS systems
- **Windows Service** producer → Backend consumer
- **Bidirectional sync** with SoftRestaurant

---

## Error Handling

- Custom error classes: `AppError`, `NotFoundError`, `BadRequestError`
- Global error handler in `app.ts`
- Structured error responses with correlation IDs

---

## Logging

- **Winston** logger with pino-pretty formatting
- **Correlation IDs** for request tracing
- **Log levels**: debug, info, warn, error
- **Structured logging** with metadata

### Log Files Location

- **Directory**: `logs/`
- **Naming**: `development.log`, `development1.log`, ..., `developmentN.log`
- **Rotation**: When logs reach max size, they rotate to numbered files

### Debugging Commands

```bash
# Check most recent log file (highest number = newest)
ls -t logs/development*.log | head -1 | xargs tail -n 100

# Live tail
tail -f logs/$(ls -t logs/development*.log | head -1)

# Search for errors
ls -t logs/development*.log | head -1 | xargs grep -i "error"
```

---

## Related Documentation

- `docs/PERMISSIONS_SYSTEM.md` - Complete permission system architecture
- `docs/PAYMENT_ARCHITECTURE.md` - Payment processing and money flow
- `docs/INVENTORY_REFERENCE.md` - FIFO batch system
- `docs/TPV_COMMAND_SYSTEM.md` - TPV remote command architecture
