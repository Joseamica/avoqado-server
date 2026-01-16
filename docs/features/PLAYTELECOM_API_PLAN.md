# PlayTelecom Backend API Implementation Plan

## Overview

This document outlines the backend API endpoints needed to support the PlayTelecom white-label dashboard. The APIs are organized into two levels:
- **Venue-Level APIs**: Scoped to a single venue (store)
- **Organization-Level APIs**: Aggregate data across all venues in an organization

## Current State

### Existing Infrastructure
- `serializedInventory.routes.ts` - Basic serialized inventory endpoints (summary, items, recent-sales)
- `moduleService` - Module enable/disable system with `SERIALIZED_INVENTORY` module
- Authentication middleware with `authContext` providing `venueId`, `userId`, `orgId`, `role`

### Prisma Models (Existing)
```prisma
- SerializedItemCategory
- SerializedItem
- Order / OrderItem
- Staff
- Venue
- Organization
```

## Phase 5A: Venue-Level APIs

### 1. Command Center API (`/dashboard/venues/:venueId/command-center`)

**Purpose**: Real-time KPIs and activity feed for a single store.

```typescript
// GET /command-center/summary
// Returns: Today's sales, units sold, avg ticket, active promoters
{
  todaySales: number,
  unitsSold: number,
  avgTicket: number,
  activePromoters: number,
  weekSales: number,
  monthSales: number,
  activeStores: number // For managers viewing their stores
}

// GET /command-center/activity
// Returns: Recent activity feed (sales, check-ins, alerts)
{
  activities: [{
    id: string,
    type: 'SALE' | 'CHECK_IN' | 'CHECK_OUT' | 'DEPOSIT' | 'ALERT',
    timestamp: string,
    description: string,
    metadata: object
  }]
}

// GET /command-center/insights
// Returns: Operational alerts requiring attention
{
  insights: [{
    id: string,
    type: 'WARNING' | 'CRITICAL' | 'INFO',
    title: string,
    description: string,
    actionRequired: boolean
  }]
}

// GET /command-center/top-sellers
// Returns: Top performing sellers today
{
  sellers: [{
    id: string,
    name: string,
    sales: number,
    units: number
  }]
}

// GET /command-center/category-breakdown
// Returns: Sales by category
{
  categories: [{
    id: string,
    name: string,
    sales: number,
    units: number,
    percentage: number
  }]
}
```

### 2. Promoters Audit API (`/dashboard/venues/:venueId/promoters`)

**Purpose**: Individual promoter tracking with attendance, sales, and deposit management.

```typescript
// GET /promoters
// Returns: List of promoters with today's stats
{
  promoters: [{
    id: string,
    name: string,
    photo: string,
    status: 'ACTIVE' | 'INACTIVE' | 'ON_BREAK',
    store: { id: string, name: string },
    todaySales: number,
    todayUnits: number,
    commission: number,
    lastActivity: string
  }],
  summary: {
    total: number,
    active: number,
    onBreak: number,
    todayTotalSales: number,
    todayTotalCommissions: number
  }
}

// GET /promoters/:promoterId
// Returns: Detailed promoter info with performance history
{
  promoter: {
    id: string,
    name: string,
    photo: string,
    email: string,
    phone: string,
    manager: { id: string, name: string },
    level: string,
    joinDate: string
  },
  todayMetrics: {
    sales: number,
    units: number,
    commission: number,
    goalProgress: number,
    dailyGoal: number
  },
  checkIn: {
    time: string,
    method: 'GPS' | 'BIOMETRIC' | 'SELFIE',
    photo: string,
    location: { lat: number, lng: number },
    verified: boolean
  },
  attendance: {
    // Last 30 days calendar data
    days: [{
      date: string,
      status: 'PRESENT' | 'ABSENT' | 'LATE' | 'HALF_DAY'
    }]
  }
}

// GET /promoters/:promoterId/deposits
// Returns: Pending deposits for validation
{
  deposits: [{
    id: string,
    amount: number,
    method: 'CASH' | 'TRANSFER',
    timestamp: string,
    voucherImage: string,
    status: 'PENDING' | 'APPROVED' | 'REJECTED',
    rejectionReason?: string
  }]
}

// POST /promoters/:promoterId/deposits/:depositId/approve
// Body: { approvedBy: string }

// POST /promoters/:promoterId/deposits/:depositId/reject
// Body: { reason: string }
```

### 3. Stock Control API (extends existing)

**Existing endpoints in `serializedInventory.routes.ts`:**
- `GET /summary` - Category counts
- `GET /items` - Paginated items list
- `GET /recent-sales` - Recent sales

**New endpoints needed:**

```typescript
// GET /dashboard/venues/:venueId/stock/chart-data
// Returns: Stock vs Sales trend for last 7 days
{
  days: [{
    date: string,
    stockLevel: number,
    salesCount: number
  }]
}

// GET /dashboard/venues/:venueId/stock/alerts
// Returns: Low stock alerts
{
  alerts: [{
    categoryId: string,
    categoryName: string,
    currentStock: number,
    minimumStock: number,
    alertLevel: 'WARNING' | 'CRITICAL',
    coverageDays: number // Estimated days until stockout
  }]
}

// POST /dashboard/venues/:venueId/stock/bulk-upload
// Body: CSV file with serial numbers
// Returns: { imported: number, errors: [{ row: number, error: string }] }

// POST /dashboard/venues/:venueId/stock/request
// Body: { categoryId: string, quantity: number }
// Returns: { requestId: string, status: 'SUBMITTED' }
```

### 4. Users Management API (`/dashboard/venues/:venueId/users`)

**Purpose**: Manage users, roles, and permissions within a venue.

```typescript
// GET /users
// Returns: List of users with roles
{
  users: [{
    id: string,
    name: string,
    email: string,
    photo: string,
    role: 'ADMIN' | 'MANAGER' | 'PROMOTER',
    status: 'ACTIVE' | 'INACTIVE' | 'BLOCKED',
    stores: [{ id: string, name: string }],
    lastLogin: string
  }]
}

// GET /users/:userId
// Returns: Detailed user info with permissions
{
  user: {
    id: string,
    name: string,
    email: string,
    phone: string,
    photo: string,
    role: string,
    status: string,
    createdAt: string
  },
  scope: {
    zone: string | null,
    stores: [{ id: string, name: string }]
  },
  permissions: {
    // Permission matrix by category
    sales: { read: boolean, write: boolean },
    inventory: { read: boolean, write: boolean },
    team: { read: boolean, write: boolean, approve: boolean },
    reports: { read: boolean, export: boolean }
  },
  activityLog: [{
    timestamp: string,
    action: string,
    details: string
  }]
}

// PUT /users/:userId/role
// Body: { role: string, stores: string[] }

// PUT /users/:userId/permissions
// Body: { permissions: object }

// POST /users/:userId/block
// POST /users/:userId/unblock
```

### 5. TPV Configuration API (`/dashboard/venues/:venueId/tpv-config`)

**Purpose**: Configure product categories and pricing for the TPV app.

```typescript
// GET /tpv-config/categories
// Returns: Product categories with pricing
{
  categories: [{
    id: string,
    name: string,
    description: string,
    price: number,
    cost: number,
    margin: number,
    commission: number,
    status: 'ACTIVE' | 'INACTIVE',
    sortOrder: number
  }],
  summary: {
    totalCategories: number,
    activeCategories: number,
    avgMargin: number
  }
}

// PUT /tpv-config/categories/:categoryId
// Body: { name, description, price, cost, commission, status }

// POST /tpv-config/categories
// Body: { name, description, price, cost, commission }

// DELETE /tpv-config/categories/:categoryId

// PUT /tpv-config/categories/reorder
// Body: { order: [{ id: string, sortOrder: number }] }
```

## Phase 5B: Organization-Level APIs

### 1. Vision Global API (`/dashboard/organizations/:orgId/vision-global`)

**Purpose**: Aggregate KPIs across all venues in an organization.

```typescript
// GET /vision-global/summary
// Returns: Aggregated metrics across all venues
{
  todaySales: number,
  weekSales: number,
  monthSales: number,
  totalUnits: number,
  activeVenues: number,
  totalVenues: number,
  activePromoters: number,
  totalPromoters: number,
  avgTicket: number,
  trends: {
    salesVsLastWeek: number, // percentage change
    salesVsLastMonth: number
  }
}

// GET /vision-global/venues-ranking
// Returns: Venue performance ranking
{
  venues: [{
    id: string,
    name: string,
    slug: string,
    todaySales: number,
    weekSales: number,
    monthSales: number,
    activePromoters: number,
    rank: number,
    trend: 'UP' | 'DOWN' | 'STABLE'
  }]
}

// GET /vision-global/anomalies
// Returns: Cross-venue anomalies and alerts
{
  anomalies: [{
    id: string,
    venueId: string,
    venueName: string,
    type: 'LOW_STOCK' | 'MISSING_CHECKIN' | 'DEPOSIT_PENDING' | 'SALES_DROP',
    severity: 'WARNING' | 'CRITICAL',
    description: string,
    timestamp: string
  }]
}
```

### 2. Managers API (`/dashboard/organizations/:orgId/managers`)

**Purpose**: Manager performance and team oversight.

```typescript
// GET /managers
// Returns: All managers across the organization
{
  managers: [{
    id: string,
    name: string,
    photo: string,
    email: string,
    stores: [{ id: string, name: string }],
    teamSize: number,
    monthSales: number,
    monthGoal: number,
    goalCompletion: number, // percentage
    status: 'ACTIVE' | 'INACTIVE'
  }],
  summary: {
    totalManagers: number,
    activeManagers: number,
    avgGoalCompletion: number
  }
}

// GET /managers/:managerId
// Returns: Detailed manager performance
{
  manager: {
    id: string,
    name: string,
    email: string,
    phone: string,
    photo: string
  },
  stores: [{
    id: string,
    name: string,
    promoterCount: number,
    monthSales: number,
    performance: 'ABOVE_TARGET' | 'ON_TARGET' | 'BELOW_TARGET'
  }],
  teamMetrics: {
    totalPromoters: number,
    activeToday: number,
    avgAttendance: number,
    topPerformer: { id: string, name: string, sales: number }
  },
  performanceHistory: [{
    month: string,
    sales: number,
    goal: number,
    completion: number
  }]
}
```

### 3. Cross-Venue Reports API (`/dashboard/organizations/:orgId/reports`)

**Purpose**: Aggregate reporting across venues.

```typescript
// GET /reports/sales
// Query: { startDate, endDate, groupBy: 'day' | 'week' | 'month' }
{
  data: [{
    period: string,
    totalSales: number,
    totalUnits: number,
    byVenue: [{
      venueId: string,
      venueName: string,
      sales: number,
      units: number
    }],
    byCategory: [{
      categoryId: string,
      categoryName: string,
      sales: number,
      units: number
    }]
  }]
}

// GET /reports/attendance
// Query: { startDate, endDate }
{
  summary: {
    totalDays: number,
    avgAttendance: number,
    perfectDays: number
  },
  byVenue: [{
    venueId: string,
    venueName: string,
    attendanceRate: number,
    lateRate: number,
    absentRate: number
  }]
}

// GET /reports/export
// Query: { type: 'sales' | 'attendance' | 'inventory', startDate, endDate }
// Returns: CSV download
```

## Implementation Order

### Phase 5A Priority (Venue-Level)
1. **Command Center API** - Core dashboard data
2. **Extend Stock API** - Charts and alerts
3. **Promoters Audit API** - Team tracking
4. **TPV Config API** - Product management
5. **Users Management API** - Permission system

### Phase 5B Priority (Org-Level)
1. **Vision Global API** - Aggregate KPIs
2. **Managers API** - Supervision dashboard
3. **Reports API** - Cross-venue analytics

## Database Schema Changes

### Attendance Tracking

**Note:** Attendance tracking uses the existing `TimeEntry` model (not a separate `AttendanceRecord` model).
The TPV app writes check-in/check-out data to `TimeEntry` with:
- `clockInTime` - Check-in timestamp
- `clockOutTime` - Check-out timestamp
- `checkInPhotoUrl` - Selfie photo URL
- `status` - CLOCKED_IN, CLOCKED_OUT, ON_BREAK
- GPS coordinates stored in `gpsLatitude`, `gpsLongitude`, `gpsAccuracy` fields

### New Models Needed

```prisma
// Cash deposit tracking
model CashDeposit {
  id              String   @id @default(cuid())
  staffId         String
  venueId         String
  amount          Decimal
  method          DepositMethod
  timestamp       DateTime @default(now())
  voucherImageUrl String?
  status          DepositStatus @default(PENDING)
  approvedById    String?
  approvedAt      DateTime?
  rejectionReason String?

  staff           Staff    @relation(fields: [staffId], references: [id])
  venue           Venue    @relation(fields: [venueId], references: [id])
  approvedBy      Staff?   @relation("DepositApprover", fields: [approvedById], references: [id])
}

enum DepositMethod {
  CASH
  TRANSFER
}

enum DepositStatus {
  PENDING
  APPROVED
  REJECTED
}

// Stock alerts configuration
model StockAlertConfig {
  id           String   @id @default(cuid())
  venueId      String
  categoryId   String
  minimumStock Int
  alertEnabled Boolean  @default(true)

  venue        Venue                    @relation(fields: [venueId], references: [id])
  category     SerializedItemCategory   @relation(fields: [categoryId], references: [id])

  @@unique([venueId, categoryId])
}

// Performance goals
model PerformanceGoal {
  id          String   @id @default(cuid())
  staffId     String
  venueId     String
  month       DateTime // First day of month
  salesGoal   Decimal
  unitsGoal   Int?

  staff       Staff    @relation(fields: [staffId], references: [id])
  venue       Venue    @relation(fields: [venueId], references: [id])

  @@unique([staffId, venueId, month])
}
```

## File Structure

```
src/
├── routes/
│   └── dashboard/
│       ├── commandCenter.routes.ts      # NEW
│       ├── promotersAudit.routes.ts     # NEW
│       ├── usersManagement.routes.ts    # NEW
│       ├── tpvConfig.routes.ts          # NEW
│       └── serializedInventory.routes.ts # EXTEND
│
├── routes/
│   └── organization/
│       ├── visionGlobal.routes.ts       # NEW
│       ├── managers.routes.ts           # NEW
│       └── reports.routes.ts            # NEW
│
├── services/
│   ├── command-center/
│   │   └── commandCenter.service.ts     # NEW
│   ├── promoters/
│   │   ├── attendance.service.ts        # NEW
│   │   └── deposits.service.ts          # NEW
│   ├── organization/
│   │   ├── visionGlobal.service.ts      # NEW
│   │   └── managers.service.ts          # NEW
│   └── serialized-inventory/
│       └── serializedInventory.service.ts # EXTEND
│
└── controllers/
    ├── dashboard/
    │   ├── commandCenter.controller.ts   # NEW
    │   ├── promotersAudit.controller.ts  # NEW
    │   ├── usersManagement.controller.ts # NEW
    │   └── tpvConfig.controller.ts       # NEW
    └── organization/
        ├── visionGlobal.controller.ts    # NEW
        ├── managers.controller.ts        # NEW
        └── reports.controller.ts         # NEW
```

## Security Considerations

1. **Venue Isolation**: All venue-level APIs MUST filter by `venueId` from `authContext`
2. **Organization Access**: Org-level APIs MUST verify user has OWNER/ADMIN role for the organization
3. **Module Check**: APIs should verify `WHITE_LABEL_DASHBOARD` module is enabled
4. **Permission Gates**:
   - Deposit approval requires `promoters:approve` permission
   - User management requires `users:manage` permission
   - TPV config requires `tpv:configure` permission

## Next Steps

1. Create Prisma migration for new models
2. Implement services in order of priority
3. Add routes and controllers
4. Create integration tests
5. Update frontend to consume real APIs (Phase 6)
