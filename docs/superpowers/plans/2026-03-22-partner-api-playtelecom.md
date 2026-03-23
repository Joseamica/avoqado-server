# Partner API (PlayTelecom Sales Export) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose read-only API endpoints for PlayTelecom to query serialized inventory sales data (SIM transactions, photos, portability evidence) using API key authentication scoped to their organization.

**Architecture:** Reuse the existing Stripe-like API key pattern (`sk_live_*`) from `sdk-auth.middleware.ts` but scoped to an Organization (not a Venue). A new `PartnerAPIKey` Prisma model stores the hashed key + org reference. A new middleware authenticates partner requests and attaches `req.partnerContext`. A single `GET /api/v1/partner/sales` endpoint joins SerializedItem → OrderItem → Order → Payment → SaleVerification → Terminal → Venue → Staff to return all fields PlayTelecom needs. Photos are returned as the existing public Firebase Storage URLs (same pattern as `SaleVerification.photos[]` already stores).

**Tech Stack:** Express + Prisma + TypeScript (existing stack). No new dependencies.

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `prisma/schema.prisma` (add model) | `PartnerAPIKey` model with organizationId + hashed key |
| Create | `src/middlewares/partner-auth.middleware.ts` | Authenticate partner API keys, attach `req.partnerContext` |
| Create | `src/routes/partner.routes.ts` | `GET /sales` endpoint with query params |
| Create | `src/services/partner/partner.service.ts` | Query logic: join all tables, format response |
| Create | `src/routes/superadmin/partnerKey.routes.ts` | Superadmin endpoint to generate partner API keys |
| Modify | `src/routes/index.ts` | Mount `/partner` routes |
| Modify | `src/routes/superadmin.routes.ts` | Mount partner key sub-routes |
| Modify | `src/types/express.d.ts` | Add `partnerContext` to Express.Request |

---

## Task 1: Prisma Model — `PartnerAPIKey`

**Files:**
- Modify: `prisma/schema.prisma` (add model at end, before enums section)

- [ ] **Step 1: Add PartnerAPIKey model to schema.prisma**

Add after the `EcommerceMerchant` model (around line 3120):

```prisma
// ============================================================
// PARTNER API KEYS (External system access)
// ============================================================
// Organization-scoped API keys for external partners (e.g., PlayTelecom)
// to query sales data, inventory, and verification evidence.
// Uses same Stripe-like key format as EcommerceMerchant (pk_/sk_ + live/test).
model PartnerAPIKey {
  id             String       @id @default(cuid())
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  // Partner info
  name           String       // "PlayTelecom Production", "PlayTelecom Test"
  contactEmail   String?

  // API Credentials (same format as EcommerceMerchant)
  secretKeyHash  String       @unique // SHA-256 hash of sk_live_xxx / sk_test_xxx

  // Scoping
  sandboxMode    Boolean      @default(true) // true = sk_test_, false = sk_live_

  // Status
  active         Boolean      @default(true)

  // Audit
  createdById    String?      // Superadmin staff ID who created this key
  lastUsedAt     DateTime?
  lastUsedIp     String?

  createdAt      DateTime     @default(now())
  updatedAt      DateTime     @updatedAt

  @@index([organizationId])
}
```

- [ ] **Step 2: Add relation to Organization model**

Find the `Organization` model and add:

```prisma
  partnerAPIKeys PartnerAPIKey[]
```

- [ ] **Step 3: Run prisma generate + migrate**

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx prisma generate
npx prisma migrate dev --name add-partner-api-key
```

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat: add PartnerAPIKey model for external partner API access"
```

---

## Task 2: Type Declaration — `partnerContext`

**Files:**
- Modify: `src/types/express.d.ts`

- [ ] **Step 1: Add partnerContext to Express.Request**

Add to the existing `Request` interface augmentation:

```typescript
partnerContext?: {
  partnerId: string
  partnerName: string
  organizationId: string
  sandboxMode: boolean
}
```

- [ ] **Step 2: Commit**

```bash
git add src/types/express.d.ts
git commit -m "feat: add partnerContext type to Express Request"
```

---

## Task 3: Partner Auth Middleware

**Files:**
- Create: `src/middlewares/partner-auth.middleware.ts`

- [ ] **Step 1: Create the middleware**

```typescript
/**
 * Partner API Authentication Middleware
 *
 * Authenticates API requests from external partners (e.g., PlayTelecom)
 * using organization-scoped API keys.
 *
 * Key format: sk_{mode}_{random} (same as EcommerceMerchant)
 * Only secret keys accepted (server-to-server).
 *
 * Flow:
 * 1. Extract key from Authorization: Bearer sk_live_xxx
 * 2. SHA-256 hash the key
 * 3. Lookup PartnerAPIKey by secretKeyHash
 * 4. Verify active + mode matches
 * 5. Attach req.partnerContext
 */

import { Request, Response, NextFunction } from 'express'
import prisma from '@/utils/prismaClient'
import { UnauthorizedError, BadRequestError } from '@/errors/AppError'
import crypto from 'crypto'
import logger from '@/config/logger'

function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex')
}

function parsePartnerKey(apiKey: string): {
  mode: 'live' | 'test'
  isValid: boolean
} {
  const parts = apiKey.split('_')
  if (parts.length !== 3) return { mode: 'test', isValid: false }

  const [prefix, mode, random] = parts
  if (prefix !== 'sk') return { mode: 'test', isValid: false }
  if (mode !== 'live' && mode !== 'test') return { mode: 'test', isValid: false }
  if (!random || random.length < 16) return { mode: 'test', isValid: false }

  return { mode: mode as 'live' | 'test', isValid: true }
}

export function authenticatePartner() {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authHeader = req.headers.authorization
      if (!authHeader) {
        throw new UnauthorizedError('Missing Authorization header')
      }

      const parts = authHeader.split(' ')
      if (parts.length !== 2 || parts[0] !== 'Bearer') {
        throw new UnauthorizedError('Invalid Authorization header format. Expected: Bearer <api_key>')
      }

      const apiKey = parts[1]
      const { mode, isValid } = parsePartnerKey(apiKey)

      if (!isValid) {
        throw new UnauthorizedError('Invalid API key format. Expected: sk_live_xxx or sk_test_xxx')
      }

      const keyHash = hashKey(apiKey)
      const partner = await prisma.partnerAPIKey.findUnique({
        where: { secretKeyHash: keyHash },
        include: {
          organization: { select: { id: true, name: true } },
        },
      })

      if (!partner) {
        throw new UnauthorizedError('Invalid API key')
      }

      if (!partner.active) {
        throw new UnauthorizedError('API key is inactive')
      }

      const sandboxMode = mode === 'test'
      if (partner.sandboxMode !== sandboxMode) {
        throw new BadRequestError(
          `API key mode (${mode}) does not match partner environment (${partner.sandboxMode ? 'test' : 'live'})`
        )
      }

      // Update last used tracking (fire-and-forget)
      prisma.partnerAPIKey
        .update({
          where: { id: partner.id },
          data: {
            lastUsedAt: new Date(),
            lastUsedIp: req.ip || req.socket.remoteAddress,
          },
        })
        .catch(() => {}) // Non-blocking

      req.partnerContext = {
        partnerId: partner.id,
        partnerName: partner.name,
        organizationId: partner.organizationId,
        sandboxMode,
      }

      logger.debug('Partner API request authenticated', {
        partnerId: partner.id,
        partnerName: partner.name,
        organizationId: partner.organizationId,
        sandboxMode,
      })

      next()
    } catch (error) {
      next(error)
    }
  }
}

export const requirePartnerKey = authenticatePartner()
```

- [ ] **Step 2: Commit**

```bash
git add src/middlewares/partner-auth.middleware.ts
git commit -m "feat: add partner API key authentication middleware"
```

---

## Task 4: Partner Service — Sales Query

**Files:**
- Create: `src/services/partner/partner.service.ts`

- [ ] **Step 1: Create the service**

This is the core query that joins all tables to produce the PlayTelecom response format.

```typescript
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'

// Map PlayTelecom status names to our TransactionStatus enum values
const STATUS_MAP: Record<string, string[]> = {
  exitosa: ['COMPLETED'],
  fallida: ['FAILED'],
  cancelada: ['REFUNDED'],
}

interface PartnerSalesQuery {
  organizationId: string
  from: Date
  to: Date
  venueId?: string
  status?: string // exitosa | fallida | cancelada
  page: number
  limit: number
}

interface PartnerSaleRecord {
  transaction_id: string
  fecha_venta: string
  tpv_id: string | null
  tienda_id: string
  tienda: string
  vendedor_id: string | null
  vendedor: string | null
  ciudad: string | null
  producto: string | null
  precio: number
  metodo_pago: string | null
  iccid: string
  portabilidad: boolean
  estado_transaccion: string
  registro_url: string | null
  latitud: string | null
  longitud: string | null
  evidencia_portabilidad_url: string | null
}

interface PartnerSalesResponse {
  data: PartnerSaleRecord[]
  pagination: {
    page: number
    limit: number
    total: number
  }
}

class PartnerService {
  async getSales(query: PartnerSalesQuery): Promise<PartnerSalesResponse> {
    const { organizationId, from, to, venueId, status, page, limit } = query
    const skip = (page - 1) * limit

    // Build where clause: all sold SerializedItems in this org's venues
    const where: any = {
      status: 'SOLD',
      soldAt: {
        gte: from,
        lte: to,
      },
      // Org-scoped: items that belong to the org OR items in org's venues
      OR: [
        { organizationId },
        { venue: { organizationId } },
      ],
    }

    if (venueId) {
      // Filter by specific selling venue
      where.sellingVenueId = venueId
    }

    // Filter by payment status at DB level (not post-query)
    if (status && STATUS_MAP[status]) {
      where.orderItem = {
        order: {
          payments: {
            some: {
              status: { in: STATUS_MAP[status] },
            },
          },
        },
      }
    }

    // Count total for pagination
    const total = await prisma.serializedItem.count({ where })

    // Main query with all joins
    const items = await prisma.serializedItem.findMany({
      where,
      skip,
      take: limit,
      orderBy: { soldAt: 'desc' },
      include: {
        category: { select: { name: true } },
        sellingVenue: { select: { id: true, name: true, city: true } },
        venue: { select: { id: true, name: true, city: true } },
        orderItem: {
          select: {
            unitPrice: true,
            order: {
              select: {
                orderNumber: true,
                createdById: true,
                createdBy: {
                  select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                  },
                },
                terminal: {
                  select: {
                    serialNumber: true,
                    lastLatitude: true,
                    lastLongitude: true,
                  },
                },
                payments: {
                  select: {
                    method: true,
                    status: true,
                    saleVerification: {
                      select: {
                        photos: true,
                        isPortabilidad: true,
                      },
                    },
                  },
                  take: 1, // Primary payment
                },
              },
            },
          },
        },
      },
    })

    // Map to PlayTelecom response format
    const data: PartnerSaleRecord[] = items.map((item) => {
      const order = item.orderItem?.order
      const payment = order?.payments?.[0]
      const verification = payment?.saleVerification
      const terminal = order?.terminal
      const venue = item.sellingVenue || item.venue

      // Map payment status to PlayTelecom format
      let estadoTransaccion = 'exitosa'
      if (payment?.status === 'FAILED') estadoTransaccion = 'fallida'
      else if (payment?.status === 'REFUNDED') estadoTransaccion = 'cancelada'

      return {
        transaction_id: order?.orderNumber || item.id,
        fecha_venta: item.soldAt?.toISOString() || '',
        tpv_id: terminal?.serialNumber || null,
        tienda_id: venue?.id || '',
        tienda: venue?.name || '',
        vendedor_id: order?.createdBy?.id || null,
        vendedor: order?.createdBy
          ? `${order.createdBy.firstName} ${order.createdBy.lastName}`
          : null,
        ciudad: venue?.city || null,
        producto: item.category?.name || null,
        precio: item.orderItem?.unitPrice ? Number(item.orderItem.unitPrice) : 0,
        metodo_pago: payment?.method || null,
        iccid: item.serialNumber,
        portabilidad: verification?.isPortabilidad || false,
        estado_transaccion: estadoTransaccion,
        registro_url: verification?.photos?.[0] || null,
        latitud: terminal?.lastLatitude ? String(terminal.lastLatitude) : null,
        longitud: terminal?.lastLongitude ? String(terminal.lastLongitude) : null,
        evidencia_portabilidad_url:
          verification?.isPortabilidad && verification?.photos?.[1]
            ? verification.photos[1]
            : null,
      }
    })

    return {
      data,
      pagination: {
        page,
        limit,
        total,
      },
    }
  }
}

export const partnerService = new PartnerService()
```

- [ ] **Step 2: Commit**

```bash
git add src/services/partner/partner.service.ts
git commit -m "feat: add partner service with sales query joining all tables"
```

---

## Task 5: Partner Routes

**Files:**
- Create: `src/routes/partner.routes.ts`

- [ ] **Step 1: Create the route file**

```typescript
import { Router, Request, Response, NextFunction } from 'express'
import { requirePartnerKey } from '@/middlewares/partner-auth.middleware'
import { partnerService } from '@/services/partner/partner.service'
import { BadRequestError } from '@/errors/AppError'

const router = Router()

/**
 * GET /api/v1/partner/sales
 *
 * Query params:
 *   from (required) - ISO date string, start of range
 *   to   (required) - ISO date string, end of range
 *   venue_id        - Filter by specific venue
 *   status          - exitosa | cancelada | fallida
 *   page            - Page number (default: 1)
 *   limit           - Items per page (default: 50, max: 100)
 */
router.get('/sales', requirePartnerKey, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { from, to, venue_id, status, page: pageStr, limit: limitStr } = req.query

    // Validate required params
    if (!from || !to) {
      throw new BadRequestError('Query params "from" and "to" are required (ISO date format)')
    }

    const fromDate = new Date(from as string)
    const toDate = new Date(to as string)

    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      throw new BadRequestError('Invalid date format. Use ISO 8601 (e.g., 2026-03-01)')
    }

    if (fromDate > toDate) {
      throw new BadRequestError('"from" must be before "to"')
    }

    // Max range: 90 days
    const diffDays = (toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24)
    if (diffDays > 90) {
      throw new BadRequestError('Date range cannot exceed 90 days')
    }

    // Validate status if provided
    const validStatuses = ['exitosa', 'cancelada', 'fallida']
    if (status && !validStatuses.includes(status as string)) {
      throw new BadRequestError(`Invalid status. Valid values: ${validStatuses.join(', ')}`)
    }

    const page = Math.max(1, parseInt(pageStr as string) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(limitStr as string) || 50))

    const result = await partnerService.getSales({
      organizationId: req.partnerContext!.organizationId,
      from: fromDate,
      to: toDate,
      venueId: venue_id as string | undefined,
      status: status as string | undefined,
      page,
      limit,
    })

    res.json(result)
  } catch (error) {
    next(error)
  }
})

export default router
```

- [ ] **Step 2: Commit**

```bash
git add src/routes/partner.routes.ts
git commit -m "feat: add GET /partner/sales endpoint for external partner queries"
```

---

## Task 6: Mount Routes in Main Router

**Files:**
- Modify: `src/routes/index.ts`

- [ ] **Step 1: Import and mount partner routes**

Add import at top:
```typescript
import partnerRoutes from './partner.routes'
```

Add mount alongside existing SDK routes:
```typescript
router.use('/partner', partnerRoutes) // Partner API (PlayTelecom, etc.) under /api/v1/partner
```

- [ ] **Step 2: Commit**

```bash
git add src/routes/index.ts
git commit -m "feat: mount partner routes at /api/v1/partner"
```

---

## Task 7: Key Generation Utility (Superadmin)

**Files:**
- Create: `src/routes/superadmin/partnerKey.routes.ts`
- Modify: `src/routes/superadmin.routes.ts` (mount sub-route)

Note: `superadmin.routes.ts` already applies `authenticateTokenMiddleware` + `authorizeRole([StaffRole.SUPERADMIN])` at the router level, so individual routes don't need auth checks.

- [ ] **Step 1: Create the partner key route file**

```typescript
// src/routes/superadmin/partnerKey.routes.ts
import { Router, Request, Response, NextFunction } from 'express'
import prisma from '@/utils/prismaClient'
import { BadRequestError } from '@/errors/AppError'
import crypto from 'crypto'

const router = Router()

/**
 * POST /api/v1/superadmin/partner-keys
 * Body: { organizationId, name, sandboxMode? }
 *
 * Generates a new partner API key for an organization.
 * Returns the secret key ONCE — it cannot be retrieved again.
 */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { organizationId, name, sandboxMode = true } = req.body

    if (!organizationId || !name) {
      throw new BadRequestError('organizationId and name are required')
    }

    // Verify org exists
    const org = await prisma.organization.findUnique({ where: { id: organizationId } })
    if (!org) {
      throw new BadRequestError('Organization not found')
    }

    // Generate key using same pattern as EcommerceMerchant
    const mode = sandboxMode ? 'test' : 'live'
    const randomPart = crypto.randomBytes(32).toString('hex')
    const secretKey = `sk_${mode}_${randomPart}`
    const secretKeyHash = crypto.createHash('sha256').update(secretKey).digest('hex')

    const partnerKey = await prisma.partnerAPIKey.create({
      data: {
        organizationId,
        name,
        secretKeyHash,
        sandboxMode,
        createdById: req.authContext?.userId,
      },
    })

    // Return secret key ONCE — it cannot be retrieved again
    res.status(201).json({
      success: true,
      data: {
        id: partnerKey.id,
        name: partnerKey.name,
        secretKey, // !! Show only once !!
        sandboxMode,
        message: 'Store this key securely. It cannot be retrieved again.',
      },
    })
  } catch (error) {
    next(error)
  }
})

/**
 * GET /api/v1/superadmin/partner-keys
 * Query: { organizationId? }
 *
 * List partner API keys (without the secret).
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { organizationId } = req.query
    const where = organizationId ? { organizationId: organizationId as string } : {}

    const keys = await prisma.partnerAPIKey.findMany({
      where,
      select: {
        id: true,
        name: true,
        organizationId: true,
        organization: { select: { name: true } },
        sandboxMode: true,
        active: true,
        lastUsedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    })

    res.json({ success: true, data: keys })
  } catch (error) {
    next(error)
  }
})

/**
 * DELETE /api/v1/superadmin/partner-keys/:id
 * Deactivate (soft-delete) a partner API key.
 */
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await prisma.partnerAPIKey.update({
      where: { id: req.params.id },
      data: { active: false },
    })
    res.json({ success: true, message: 'Partner API key deactivated' })
  } catch (error) {
    next(error)
  }
})

export default router
```

- [ ] **Step 2: Mount in superadmin.routes.ts**

Add import:
```typescript
import partnerKeyRoutes from './superadmin/partnerKey.routes'
```

Add mount:
```typescript
router.use('/partner-keys', partnerKeyRoutes)
```

- [ ] **Step 3: Commit**

```bash
git add src/routes/superadmin/partnerKey.routes.ts src/routes/superadmin.routes.ts
git commit -m "feat: add superadmin endpoints to manage partner API keys"
```

---

## Task 8: Build + Smoke Test

- [ ] **Step 1: Verify TypeScript compiles**

```bash
cd /Users/amieva/Documents/Programming/Avoqado/avoqado-server
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 2: Test with curl (after server running)**

```bash
# 1. Create a key via superadmin endpoint (or directly in DB for testing)
# 2. Test the endpoint:
curl -s -H "Authorization: Bearer sk_test_<key>" \
  "http://localhost:3000/api/v1/partner/sales?from=2026-03-01&to=2026-03-22" | jq .
```

Expected: JSON response with `data` array and `pagination` object.

- [ ] **Step 3: Test error cases**

```bash
# No auth header
curl -s "http://localhost:3000/api/v1/partner/sales?from=2026-03-01&to=2026-03-22"
# Expected: 401

# Missing dates
curl -s -H "Authorization: Bearer sk_test_<key>" \
  "http://localhost:3000/api/v1/partner/sales"
# Expected: 400

# Invalid key
curl -s -H "Authorization: Bearer sk_test_invalidkey123456" \
  "http://localhost:3000/api/v1/partner/sales?from=2026-03-01&to=2026-03-22"
# Expected: 401
```

- [ ] **Step 4: Final commit**

```bash
git add .
git commit -m "feat: complete partner API for PlayTelecom sales export"
```
