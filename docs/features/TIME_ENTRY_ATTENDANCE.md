# Time Entry & Attendance System

## Overview

The Time Entry system provides clock-in/clock-out functionality for venue staff, with PIN verification, break tracking, and anti-fraud photo
capture. This is essential for labor cost tracking, payroll processing, and compliance with Mexican labor regulations (Ley Federal del
Trabajo).

## Business Context

**Key Use Cases:**

- Staff clock in at start of shift via TPV terminal
- Break tracking for meal periods (comida/descanso)
- Clock out at end of shift with automatic hour calculation
- Photo verification to prevent "buddy punching" (anti-fraud)
- Manager reports on staff hours and attendance

## Database Models

### TimeEntry

```prisma
model TimeEntry {
  id      String @id @default(cuid())
  staffId String
  staff   Staff  @relation(...)
  venueId String
  venue   Venue  @relation(...)

  // Clock times
  clockInTime  DateTime
  clockOutTime DateTime?

  // Break tracking
  breaks TimeEntryBreak[]

  // Job role during this entry
  jobRole String?  // e.g., "Waiter", "Bartender", "Manager"

  // Calculated fields
  totalHours   Decimal? @db.Decimal(5, 2)
  breakMinutes Int?     @default(0)

  // Status
  status TimeEntryStatus @default(CLOCKED_IN)

  // Metadata
  notes    String?
  editedBy String?  // Admin who modified if applicable

  // Anti-fraud verification
  checkInPhotoUrl String?  // Firebase Storage URL

  @@index([staffId, venueId])
  @@index([venueId, clockInTime])
  @@index([status])
  @@map("time_entries")
}
```

### TimeEntryBreak

```prisma
model TimeEntryBreak {
  id          String    @id @default(cuid())
  timeEntryId String
  timeEntry   TimeEntry @relation(...)

  startTime DateTime
  endTime   DateTime?

  @@index([timeEntryId])
  @@map("time_entry_breaks")
}
```

### TimeEntryStatus Enum

```prisma
enum TimeEntryStatus {
  CLOCKED_IN   // Staff is working
  ON_BREAK     // Staff is on break
  CLOCKED_OUT  // Shift completed
}
```

## Architecture

### Service Layer

**File:** `src/services/tpv/time-entry.tpv.service.ts`

**Exported Functions:**

```typescript
export async function clockIn(params: ClockInParams)
export async function clockOut(params: ClockOutParams)
export async function startBreak(params: BreakParams)
export async function endBreak(params: BreakParams)
export async function getTimeEntries(params: TimeEntriesQueryParams)
export async function getStaffTimeSummary(params: TimeSummaryParams)
export async function getCurrentlyClockedInStaff(venueId: string)
```

### Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Time Entry State Machine                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  [Not Clocked In]                                                    │
│        │                                                             │
│        ▼ clockIn()                                                   │
│  ┌─────────────┐                                                    │
│  │ CLOCKED_IN  │◀──────────────────────────┐                        │
│  └─────────────┘                           │                        │
│        │                                   │                        │
│        │ startBreak()          endBreak()  │                        │
│        ▼                                   │                        │
│  ┌─────────────┐                           │                        │
│  │  ON_BREAK   │───────────────────────────┘                        │
│  └─────────────┘                                                    │
│        │                                                             │
│        │ clockOut() (ends any active break automatically)           │
│        ▼                                                             │
│  ┌─────────────┐                                                    │
│  │ CLOCKED_OUT │  (Terminal state - shift complete)                 │
│  └─────────────┘                                                    │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Implementation Details

### Clock In

**Parameters:**

```typescript
interface ClockInParams {
  venueId: string
  staffId: string
  pin: string
  jobRole?: string // Optional role for this shift
  checkInPhotoUrl?: string // Firebase Storage URL (anti-fraud)
}
```

**Business Logic:**

1. Verify PIN via `StaffVenue.pin`
2. Check for existing active entry (prevent double clock-in)
3. Create `TimeEntry` with status `CLOCKED_IN`
4. Optionally store check-in photo URL

**Example API call:**

```json
POST /api/v1/tpv/venues/:venueId/time-entries/clock-in
{
  "staffId": "staff-cuid",
  "pin": "1234",
  "jobRole": "Mesero",
  "checkInPhotoUrl": "https://storage.googleapis.com/avoqado/check-in/photo.jpg"
}
```

### Clock Out

**Parameters:**

```typescript
interface ClockOutParams {
  venueId: string
  staffId: string
  pin: string
}
```

**Business Logic:**

1. Verify PIN
2. Find active `TimeEntry` (CLOCKED_IN or ON_BREAK)
3. Auto-end any active break
4. Calculate total hours and break minutes
5. Update entry to `CLOCKED_OUT`

**Calculation Logic:**

```typescript
function calculateHours(clockInTime: Date, clockOutTime: Date, breakMinutes: number): number {
  const totalMinutes = (clockOutTime.getTime() - clockInTime.getTime()) / (1000 * 60)
  const workMinutes = totalMinutes - breakMinutes
  return Number((workMinutes / 60).toFixed(2))
}
```

### Break Management

**Start Break:**

- Requires CLOCKED_IN status
- Creates new `TimeEntryBreak` with `startTime`
- Updates entry status to ON_BREAK

**End Break:**

- Requires ON_BREAK status
- Sets `endTime` on active break
- Returns entry status to CLOCKED_IN

### PIN Verification

```typescript
async function verifyStaffPin(venueId: string, staffId: string, pin: string): Promise<boolean> {
  const staffVenue = await prisma.staffVenue.findFirst({
    where: {
      staffId,
      venueId,
      active: true,
      pin: pin,
    },
  })
  return !!staffVenue
}
```

**Security Note:** PIN is stored in `StaffVenue.pin` and is venue-specific. The same staff member can have different PINs at different
venues.

## API Endpoints

**TPV Routes:**

```
POST   /api/v1/tpv/venues/:venueId/time-entries/clock-in
POST   /api/v1/tpv/venues/:venueId/time-entries/clock-out
POST   /api/v1/tpv/venues/:venueId/time-entries/:timeEntryId/break/start
POST   /api/v1/tpv/venues/:venueId/time-entries/:timeEntryId/break/end
GET    /api/v1/tpv/venues/:venueId/time-entries
GET    /api/v1/tpv/venues/:venueId/time-entries/currently-clocked-in
```

**Dashboard Routes:**

```
GET    /api/v1/dashboard/venues/:venueId/time-entries
GET    /api/v1/dashboard/venues/:venueId/staff/:staffId/time-summary
```

## Query Parameters

**getTimeEntries:**

```typescript
interface TimeEntriesQueryParams {
  venueId: string
  staffId?: string // Filter by specific staff
  startDate?: string // ISO date string
  endDate?: string // ISO date string
  status?: TimeEntryStatus // Filter by status
  limit?: number // Default: 50
  offset?: number // Default: 0
}
```

## Time Summary

**Response:**

```typescript
{
  staffId: string
  startDate: string
  endDate: string
  totalHours: number        // Sum of all completed shifts
  totalBreakMinutes: number // Sum of all breaks
  totalShifts: number       // Count of completed entries
  averageHoursPerShift: number
  timeEntries: TimeEntry[]
}
```

## Anti-Fraud Features

### Photo Verification

The `checkInPhotoUrl` field supports anti-fraud photo capture:

1. TPV app captures photo during clock-in
2. Photo uploaded to Firebase Storage
3. URL stored in TimeEntry for audit purposes
4. Manager can review photos to prevent buddy punching

**Industry Pattern:** Toast, Square, and 7shifts all support photo verification.

### PIN Security

- PINs are 4-6 digit codes stored in `StaffVenue.pin`
- Each staff member has unique PIN per venue
- PIN required for both clock-in and clock-out

## Error Handling

| Error                                      | Cause                         | HTTP Status |
| ------------------------------------------ | ----------------------------- | ----------- |
| `Invalid PIN for this venue`               | Wrong PIN or inactive staff   | 401         |
| `Staff member is already clocked in`       | Duplicate clock-in attempt    | 400         |
| `Staff member is not currently clocked in` | Clock-out without clock-in    | 400         |
| `A break is already in progress`           | Starting break while on break | 400         |
| `No active break found`                    | Ending non-existent break     | 400         |

## Mexican Labor Law Compliance

### Ley Federal del Trabajo (LFT)

**Article 64:** Workers must have a minimum 30-minute break during continuous 6+ hour workdays.

The break tracking system supports compliance by:

- Recording all breaks with start/end times
- Calculating break minutes separately from work hours
- Providing audit trail for labor inspections

**Recommended Break Policy:**

```
6+ hour shift → 30 min unpaid meal break required
8+ hour shift → 30 min unpaid + 2x 15 min paid breaks
```

## Testing Scenarios

### Manual Testing

1. **Full shift cycle:**

   - Clock in → Work → Start break → End break → Clock out
   - Verify total hours exclude break time

2. **Edge cases:**

   - Clock out while on break (should auto-end break)
   - Try to clock in twice (should fail)
   - Clock in with wrong PIN (should fail)

3. **Query testing:**
   - Filter by date range
   - Get staff summary for week/month
   - Get currently clocked in staff

### Database Verification

```sql
-- Check active time entries
SELECT
  te.id,
  s."firstName",
  s."lastName",
  te."clockInTime",
  te.status,
  te."jobRole"
FROM time_entries te
JOIN "Staff" s ON te."staffId" = s.id
WHERE te.status IN ('CLOCKED_IN', 'ON_BREAK');

-- Calculate total hours per staff this week
SELECT
  s."firstName",
  s."lastName",
  SUM(te."totalHours") as total_hours,
  SUM(te."breakMinutes") as total_break_minutes,
  COUNT(te.id) as shift_count
FROM time_entries te
JOIN "Staff" s ON te."staffId" = s.id
WHERE te."clockInTime" >= NOW() - INTERVAL '7 days'
  AND te.status = 'CLOCKED_OUT'
GROUP BY s.id, s."firstName", s."lastName";
```

## Related Files

**Backend:**

- `prisma/schema.prisma` - TimeEntry, TimeEntryBreak models
- `src/services/tpv/time-entry.tpv.service.ts` - Business logic
- `src/controllers/tpv/time-entry.tpv.controller.ts` - API handlers
- `src/routes/tpv.routes.ts` - Route definitions

**Dashboard:**

- Time entry reports page
- Staff attendance summary

**TPV Android:**

- Clock in/out UI with PIN entry
- Photo capture component for anti-fraud

## Future Enhancements

1. **Geofencing:** Only allow clock-in within venue location
2. **Biometric:** Fingerprint or face recognition instead of PIN
3. **Scheduled shifts:** Compare actual vs scheduled times
4. **Overtime alerts:** Notify managers when staff approaches overtime
5. **Payroll export:** Direct integration with payroll systems
6. **Break reminders:** Push notification after 4+ hours without break
