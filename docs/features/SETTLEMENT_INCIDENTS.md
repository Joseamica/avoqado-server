# Settlement Incident Tracking System

## Overview

The Settlement Incident Tracking System is designed to monitor payment processor settlement reliability for the SOFOM (Mexican lending institution) partnership. It automatically detects when expected settlements don't arrive on time and enables manual confirmation workflows to track processor performance.

## Business Context

**Critical for SOFOM Partnership**: Avoqado is partnering with a SOFOM that provides credit to venues based on guaranteed future cash flow from settlements. The SOFOM needs:
- **Precise settlement date projections** to calculate lending capacity
- **Real-time detection** when processors fail to settle on expected dates
- **Confidence metrics** on settlement reliability per processor
- **Risk alerting** when delays occur that affect credit decisions

## How It Works

### 1. Detection by Absence Strategy

**Daily Cron Job** (9:00 AM Mexico City time):
1. Finds all transactions with `estimatedSettlementDate = yesterday`
2. Checks if `actualSettlementDate` is still `null`
3. Creates `SettlementIncident` for each missing settlement
4. Notifies venue for manual confirmation

**Why this approach?**
- Processors like Blumonpay don't have settlement APIs
- Bank integration is complex and not always available
- Manual confirmation builds historical accuracy data

### 2. Manual Confirmation Workflow

**Venue View** (`/venues/:slug/available-balance`):
- Orange alert appears when pending incidents detected
- Shows list of expected settlements that haven't arrived
- Click "Confirm" button opens dialog:
  - **"Did this money arrive in your bank account?"**
  - **YES** → Select actual arrival date
  - **NO** → Confirms delay, alerts SOFOM

**Outcome**:
- **If YES**: Transaction marked as SETTLED, incident RESOLVED, variance calculated
- **If NO**: Incident marked as CONFIRMED_DELAY, SOFOM alerted

### 3. SuperAdmin Tools

**Endpoints** (permission: `system:admin`):
```
GET    /api/v1/dashboard/superadmin/settlement-incidents
GET    /api/v1/dashboard/superadmin/settlement-incidents/stats
POST   /api/v1/dashboard/superadmin/settlement-incidents/:incidentId/escalate
```

**Use Cases**:
- View all incidents across all venues
- See global processor reliability statistics
- Escalate incidents requiring investigation

## Architecture

### Database Models

**SettlementIncident**
```typescript
{
  id: string
  transactionId: string | null
  venueId: string
  estimatedSettlementDate: DateTime
  actualSettlementDate: DateTime | null
  delayDays: number | null  // Calculated when resolved
  processorName: string  // e.g., "Blumonpay", "Menta"
  cardType: TransactionCardType
  transactionDate: DateTime
  amount: Decimal
  status: IncidentStatus  // PENDING_CONFIRMATION, CONFIRMED_DELAY, RESOLVED, ESCALATED
  notes: string | null
  alertedSOFOM: boolean
}
```

**SettlementConfirmation**
```typescript
{
  id: string
  incidentId: string | null
  transactionId: string | null
  venueId: string
  confirmedBy: string  // Staff ID
  confirmationDate: DateTime
  settlementArrived: boolean
  actualDate: DateTime | null
  notes: string | null
}
```

**ProcessorReliabilityMetric**
```typescript
{
  id: string
  processorName: string
  cardType: TransactionCardType
  periodStart: DateTime
  periodEnd: DateTime
  totalTransactions: number
  onTimeSettlements: number
  delayedSettlements: number
  averageDelayDays: Decimal
  reliabilityScore: Decimal  // % on-time
  confidence: ConfidenceLevel  // HIGH, MEDIUM, LOW
}
```

### Backend Services

**`settlementIncident.service.ts`** (`src/services/dashboard/`)
```typescript
// Core functions:
detectMissingSettlements()  // Runs daily via cron
confirmSettlementIncident(incidentId, userId, settlementArrived, actualDate, notes)
getPendingIncidents(venueId?)
getActiveIncidents(venueId?)
escalateIncident(incidentId, notes)
getIncidentStats(venueId?)
```

**`settlement-detection.job.ts`** (`src/jobs/`)
```typescript
class SettlementDetectionJob {
  constructor() {
    this.job = new CronJob('0 9 * * *', ...) // Daily 9 AM Mexico City
  }

  async detectMissingSettlements() {
    // 1. Find transactions expected yesterday
    // 2. Check if actualSettlementDate is null
    // 3. Create incidents
    // 4. Log summary by processor
  }
}
```

### Frontend Components

**`PendingIncidentsAlert.tsx`**
- Displays orange alert banner when incidents exist
- Shows list of pending confirmations
- Total pending amount summary
- Refetches every 60 seconds

**`ConfirmIncidentDialog.tsx`**
- Modal dialog for confirmation
- Radio buttons: "Yes, it arrived" / "No, not yet"
- Date picker if YES selected
- Notes field (optional)
- Validates before submission

### API Endpoints

**For Venues** (permission: `settlements:read`, `settlements:write`):
```
GET    /api/v1/dashboard/venues/:venueId/settlement-incidents
GET    /api/v1/dashboard/venues/:venueId/settlement-incidents/stats
POST   /api/v1/dashboard/venues/:venueId/settlement-incidents/:incidentId/confirm
```

**For SuperAdmin** (permission: `system:admin`):
```
GET    /api/v1/dashboard/superadmin/settlement-incidents
GET    /api/v1/dashboard/superadmin/settlement-incidents/stats
POST   /api/v1/dashboard/superadmin/settlement-incidents/:incidentId/escalate
```

## Translations

**Namespaces**: `settlementIncidents`, `common`

**Files**:
- `/src/locales/en/settlementIncidents.json`
- `/src/locales/es/settlementIncidents.json`
- `/src/locales/fr/settlementIncidents.json`

**Key Translations**:
```json
{
  "pendingAlert.title": "{{count}} Pending Settlement Confirmation",
  "confirmDialog.question": "Did this money arrive in your bank account?",
  "confirmDialog.yes": "Yes, it arrived",
  "confirmDialog.no": "No, it hasn't arrived yet"
}
```

## Example Scenario

**Transaction Flow**:
1. **Oct 29**: Customer pays $5,000 via Blumonpay Visa Debit
2. **Oct 29**: System calculates `estimatedSettlementDate = Oct 31` (2 business days)
3. **Nov 1, 9 AM**: Detection job runs, finds settlement didn't arrive Oct 31
4. **Nov 1, 9:01 AM**: Creates `SettlementIncident`, status = PENDING_CONFIRMATION
5. **Nov 1, 10 AM**: Venue manager opens Available Balance page
6. **Nov 1, 10:05 AM**: Sees orange alert: "1 Pending Settlement Confirmation"
7. **Nov 1, 10:06 AM**: Clicks "Confirm", sees dialog: "Did $5,000 from Blumonpay arrive?"
8. **Nov 1, 10:07 AM**: Selects "Yes, it arrived" + actual date = Nov 1
9. **Nov 1, 10:07 AM**: System updates:
   - Transaction: `actualSettlementDate = Nov 1`, `settlementVarianceDays = 1`
   - Transaction: `status = SETTLED`, `confirmationMethod = MANUAL`
   - Incident: `status = RESOLVED`, `delayDays = 1`
10. **Nov 1, 10:07 AM**: ProcessorReliabilityMetric updated:
    - Blumonpay DEBIT: 1 delayed settlement, avg delay 1 day

## Permissions

**Required Permissions**:
- `settlements:read` - View incidents and stats
- `settlements:write` - Confirm incidents
- `system:admin` - View global stats, escalate incidents

**Default Access**:
- **MANAGER, ADMIN, OWNER** - Can confirm incidents
- **SUPERADMIN** - Can escalate, view global stats

## Testing Locally

### 1. Create Test Transaction with Estimated Settlement Date
```typescript
// In seed or via API
await prisma.venueTransaction.create({
  data: {
    estimatedSettlementDate: new Date(Date.now() - 24 * 60 * 60 * 1000), // Yesterday
    actualSettlementDate: null,
    status: 'PENDING',
    // ... other fields
  }
})
```

### 2. Run Detection Job Manually
```bash
# In backend console/REPL
import { settlementDetectionJob } from './src/jobs/settlement-detection.job'
await settlementDetectionJob.runNow()
```

### 3. Check Results
```bash
# Query incidents
npx prisma studio
# Navigate to SettlementIncident table
```

### 4. Test Frontend
- Navigate to `/venues/:slug/available-balance`
- Should see orange alert if incidents exist
- Click "Confirm" to test dialog

## Future Enhancements (Phase 2+)

### Phase 2: SOFOM Risk Dashboard
- **Processor Reliability Scores**: % on-time settlements per processor
- **Venue Risk Scoring**: Based on transaction volume + processor mix
- **Lending Capacity Calculator**: Safe credit limit with safety margins
- **Active Incident Monitoring**: Real-time delays affecting credit decisions

### Phase 3: Automation
- **Webhook Integration**: When processors add settlement APIs
- **Bank Integration**: Verify settlements via bank API (Open Banking)
- **SMS Alerts**: Critical delays notify SOFOM analysts immediately

### Phase 4: Analytics
- **Seasonal Patterns**: End-of-month, holiday effects
- **Anomaly Detection**: Unusual processor behavior
- **ML Predictions**: Improve settlement date accuracy over time

## Related Files

**Backend**:
- `prisma/schema.prisma` - Models: `SettlementIncident`, `SettlementConfirmation`, `ProcessorReliabilityMetric`, `HolidayCalendar`
- `src/services/dashboard/settlementIncident.service.ts` - Business logic
- `src/controllers/dashboard/settlementIncident.dashboard.controller.ts` - API handlers
- `src/routes/dashboard.routes.ts` - Search for `settlement` routes
- `src/schemas/dashboard/settlementIncident.schema.ts` - Validation schemas
- `src/jobs/settlement-detection.job.ts` - Cron job (`SettlementDetectionJob` class)
- `src/server.ts` - Job registration (search for `settlementDetectionJob`)

**Frontend**:
- `src/services/settlementIncident.service.ts` - API client
- `src/components/SettlementIncident/PendingIncidentsAlert.tsx` - Alert banner
- `src/components/SettlementIncident/ConfirmIncidentDialog.tsx` - Confirmation modal
- `src/pages/AvailableBalance/AvailableBalance.tsx` - Main page (uses `PendingIncidentsAlert`)
- `src/locales/{en,es,fr}/settlementIncidents.json` - Translations
- `src/i18n.ts` - Translation registration (search for `settlementIncidents`)

## Migration

**Applied**: `20251031213624_add_settlement_tracking_and_risk_management`

**Changes**:
- Created 4 new tables: `SettlementIncident`, `SettlementConfirmation`, `ProcessorReliabilityMetric`, `HolidayCalendar`
- Added fields to `VenueTransaction`: `settlementVarianceDays`, `confirmationMethod`
- Created 4 new enums: `IncidentStatus`, `ConfidenceLevel`, `HolidayType`, `ConfirmationMethod`
