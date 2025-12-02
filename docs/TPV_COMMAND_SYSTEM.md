# TPV Command System Architecture

## Overview

Remote command system for TPV terminals following Square Terminal API patterns. Commands are queued in database and delivered via heartbeat
polling for maximum reliability.

## Flow Diagram

```
Dashboard                  Server                     TPV
   |                         |                         |
   |--POST /command--------->|                         |
   |                         |--Queue in DB (QUEUED)-->|
   |<--correlationId---------|                         |
   |                         |                         |
   |                         |<---Heartbeat (30s)------|
   |                         |---Commands in response->|
   |                         |                         |--Execute locally
   |                         |                         |
   |                         |<---HTTP POST /ack-------|
   |                         |--Update DB (COMPLETED)->|
   |<--Socket.IO broadcast---|                         |
   |                         |                         |
```

## Key Services

### TpvHealthService (`src/services/tpv/tpv-health.service.ts`)

Primary service for terminal health and command management:

| Method                 | Purpose                                           |
| ---------------------- | ------------------------------------------------- |
| `processHeartbeat()`   | Updates terminal status, returns pending commands |
| `sendCommand()`        | Queues command for terminal delivery              |
| `acknowledgeCommand()` | Processes command ACK from terminal               |
| `getPendingCommands()` | Returns QUEUED/SENT commands for delivery         |

### TpvCommandQueueService (`src/services/tpv/command-queue.service.ts`)

Manages command queue lifecycle:

| Method                  | Purpose                     |
| ----------------------- | --------------------------- |
| `queueCommand()`        | Creates command in database |
| `updateCommandStatus()` | Updates command status      |
| `getExpiredCommands()`  | Finds commands past timeout |

### Socket Broadcasts (`src/sockets/sockets.ts`)

Real-time notifications to dashboard:

| Function                             | Purpose                                      |
| ------------------------------------ | -------------------------------------------- |
| `broadcastTpvCommandStatusChanged()` | Notifies dashboard of command result         |
| `broadcastTpvStatusUpdate()`         | Notifies dashboard of terminal status change |

## Database Model

```prisma
model TpvCommandQueue {
  id              String                  @id @default(cuid())
  correlationId   String                  @unique @default(uuid())
  terminalId      String
  commandType     TpvCommandType
  status          TpvCommandStatus
  resultStatus    TpvCommandResultStatus?
  resultMessage   String?
  payload         Json?
  createdAt       DateTime                @default(now())
  updatedAt       DateTime                @updatedAt
  expiresAt       DateTime?
  acknowledgedAt  DateTime?
  terminal        Terminal                @relation(fields: [terminalId], references: [id])
}

enum TpvCommandType {
  LOCK
  UNLOCK
  MAINTENANCE_MODE
  EXIT_MAINTENANCE
  RESTART
  SHUTDOWN
  SYNC_DATA
  REFRESH_MENU
  FORCE_UPDATE
  UPDATE_STATUS
}

enum TpvCommandStatus {
  PENDING
  QUEUED
  SENT
  RECEIVED
  EXECUTING
  COMPLETED
  FAILED
  EXPIRED
}

enum TpvCommandResultStatus {
  SUCCESS
  PARTIAL_SUCCESS
  FAILED
  TIMEOUT
  REJECTED
}
```

## API Endpoints

### Send Command

```
POST /api/v1/dashboard/tpv/:terminalId/command
Body: { command: string, payload?: object }
Response: { correlationId: string, status: string }
```

### Heartbeat (TPV -> Server)

```
POST /api/v1/tpv/heartbeat
Body: { terminalId, status, timestamp, version?, systemInfo? }
Response: { success: true, commands: TpvCommand[] }
```

### Command ACK (TPV -> Server)

```
POST /api/v1/tpv/heartbeat/ack
Body: { commandId, terminalId, status, resultStatus?, resultMessage? }
Response: { success: true }
```

## Status Flow

```
PENDING ─┬─> QUEUED ─┬─> SENT ─┬─> RECEIVED ─> EXECUTING ─┬─> COMPLETED
         │           │         │                          │
         │           │         └─> EXPIRED                └─> FAILED
         │           │
         └───────────┴─> Command created and queued for delivery
```

## Important Design Decisions

### 1. Heartbeat Does NOT Change Terminal Status (2025-12-01)

**Problem Solved:** Race condition between heartbeat and command execution.

**Previous Behavior (BUG):**

```typescript
// Server would reset MAINTENANCE to ACTIVE via heartbeat
if (terminal.status === TerminalStatus.MAINTENANCE) {
  if (status === 'ACTIVE') {
    newStatus = TerminalStatus.ACTIVE // <-- THIS CAUSED THE BUG
  }
}
```

**Current Behavior (FIXED):**

```typescript
// Heartbeat only changes status for INACTIVE -> ACTIVE (terminal coming online)
let newStatus = terminal.status // Keep current status

if (terminal.status === TerminalStatus.INACTIVE && status === 'ACTIVE') {
  newStatus = TerminalStatus.ACTIVE
  logger.info(`Terminal ${terminal.id} came online (INACTIVE -> ACTIVE)`)
}
// MAINTENANCE status ONLY changes via EXIT_MAINTENANCE command
```

**Why:** Prevents this race condition:

1. Dashboard sends MAINTENANCE_MODE command
2. TPV heartbeat arrives with `status: ACTIVE` (before command processed)
3. Server resets terminal to ACTIVE (BUG!)
4. TPV processes command, enters maintenance locally
5. Server shows ACTIVE, TPV shows MAINTENANCE (mismatch!)

### 2. Dual ID System (id vs correlationId)

**Design:**

- `id`: Database CUID for internal operations
- `correlationId`: UUID for tracking across systems (Android <-> Server)

**Why:** Android may not know database ID when sending ACK. correlationId is returned in command delivery and used for ACK.

### 3. State Sync on REJECTED Commands (2025-12-01)

**Problem Solved:** Dashboard and TPV can get out of sync (dashboard shows MAINTENANCE, TPV is ACTIVE).

**Solution:** When a command is REJECTED, it means the terminal is in the opposite state. Server syncs accordingly:

| Command            | REJECTED Means                  | Server Syncs To        |
| ------------------ | ------------------------------- | ---------------------- |
| `EXIT_MAINTENANCE` | Terminal NOT in maintenance     | `status = ACTIVE`      |
| `MAINTENANCE_MODE` | Terminal already in maintenance | `status = MAINTENANCE` |
| `LOCK`             | Terminal already locked         | `isLocked = true`      |
| `UNLOCK`           | Terminal not locked             | `isLocked = false`     |

**Example Flow:**

1. Dashboard shows MAINTENANCE (wrong state in DB)
2. User toggles maintenance switch OFF
3. Server sends EXIT_MAINTENANCE
4. TPV responds: REJECTED "Terminal is not in maintenance mode"
5. Server syncs: `Terminal.status = ACTIVE`
6. Dashboard updates to show correct state

### 4. HTTP ACK is Primary (Socket.IO Deprecated)

**Design:** TPV sends ACK via HTTP POST only, not Socket.IO.

**Why:**

- Socket.IO may not be connected (login screen)
- HTTP is always available
- Single source of truth for command status
- Avoids race conditions from dual-path ACKs

### 5. Command Delivery via Heartbeat Response

**Design:** Commands are returned in heartbeat HTTP response body, not pushed via Socket.IO.

**Why:**

- Works even when Socket.IO is disconnected
- Guaranteed delivery (polling pattern)
- Follows Square Terminal API pattern
- Reliable on login screen

## Key File Locations

```
src/
├── services/tpv/
│   ├── tpv-health.service.ts      # Heartbeat processing, command delivery
│   └── command-queue.service.ts   # Command queue management
├── controllers/tpv/
│   └── heartbeat.tpv.controller.ts # Heartbeat + ACK endpoints
├── controllers/dashboard/
│   └── tpv.dashboard.controller.ts # Dashboard command endpoint
└── sockets/
    └── sockets.ts                  # Socket.IO broadcasts
```

## Dashboard Integration

### TpvId.tsx Loading States (2025-12-01)

Both Lock and Maintenance switches show loading indicators:

```tsx
// Track which command is pending
const [pendingCommand, setPendingCommand] = useState<string | null>(null)

const sendTpvCommand = (command: string) => {
  setPendingCommand(command)
  commandMutation.mutate(
    { command, payload },
    {
      onSettled: () => setPendingCommand(null),
    },
  )
}

// Show spinner instead of icon while pending
{
  pendingCommand === 'MAINTENANCE_MODE' ? <Loader2 className="animate-spin" /> : <Wrench />
}
```

## Debugging

### Check Terminal Status

```sql
SELECT id, serialNumber, status, lastHeartbeat, "isLocked"
FROM "Terminal"
WHERE id = 'xxx';
```

### Check Command History

```sql
SELECT id, correlationId, "commandType", status, "resultStatus",
       "createdAt", "acknowledgedAt"
FROM "TpvCommandQueue"
WHERE "terminalId" = 'xxx'
ORDER BY "createdAt" DESC
LIMIT 20;
```

### Server Logs

```bash
# Watch command flow
tail -f logs/development*.log | grep -E "(command|heartbeat|ACK|MAINTENANCE)"
```

## Common Issues

### 1. Command Not Delivered

- Check terminal lastHeartbeat < 2 minutes ago
- Check command status is QUEUED (not already SENT)
- Verify terminal is sending heartbeats

### 2. ACK Not Received

- Check Android logs for ACK HTTP errors
- Verify correlationId matches
- Check server ACK endpoint is reachable

### 3. Maintenance Mode Resets

- **Fixed 2025-12-01**: Heartbeat no longer overrides MAINTENANCE
- Check for other code paths changing status
- Verify EXIT_MAINTENANCE command isn't being sent

### 4. Dashboard Shows Wrong State

- Check Socket.IO connection
- Verify TanStack Query is invalidating after command
- Check broadcastTpvStatusUpdate is being called

## Socket.IO Events

### Emitted by Server

| Event                | Payload                                           | Trigger              |
| -------------------- | ------------------------------------------------- | -------------------- |
| `tpv:command:status` | `{ terminalId, commandId, status, resultStatus }` | Command ACK received |
| `tpv:status:update`  | `{ terminalId, status, lastHeartbeat }`           | Heartbeat processed  |

### Room Structure

- Dashboard clients join: `venue_{venueId}`
- Events broadcast to venue room for real-time updates
