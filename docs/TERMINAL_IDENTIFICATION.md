# Terminal Identification & Activation

This document covers how Android TPV terminals are identified, activated, and monitored.

---

## Overview

**WHY**: Android TPV terminals need unique identification for activation, heartbeats, and payment processing.

**Design Decision**: Use device hardware serial number (`Build.SERIAL`) as the primary identifier. This persists across app reinstalls,
factory resets, and OS updates.

---

## Terminal Identification Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ Android Device                                                  │
│  1. Get Build.SERIAL from device (requires READ_PHONE_STATE)   │
│     - Android 8+: Build.getSerial() with permission            │
│     - Android 7-: Build.SERIAL (no permission needed)          │
│  2. Format: "AVQD-{Build.SERIAL}" (uppercase)                   │
│     Example: "AVQD-2841548417" (decimal hardware serial)       │
│  3. Fallback: If permission denied → use ANDROID_ID            │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Terminal Activation (first-time setup)                          │
│  1. Admin creates terminal in dashboard → generates 6-char code │
│  2. Android app sends: { serialNumber, activationCode }         │
│     serialNumber: "AVQD-2841548417" (with prefix)              │
│  3. Backend validates code & marks terminal as activated        │
│  4. Android stores venueId + serialNumber in SecureStorage      │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Heartbeat (every 30 seconds)                                    │
│  1. Android sends full serial WITH prefix                       │
│     Sends: { terminalId: "AVQD-2841548417", ... }             │
│  2. Backend lookup (CASE-INSENSITIVE):                          │
│     a. Try terminal.id (internal CUID)                         │
│     b. Try terminal.serialNumber = "AVQD-2841548417"          │
│     c. Try with/without prefix for backwards compatibility     │
│  3. Updates lastHeartbeat, status in database                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Serial Number Format

| Source            | Format                          | Example                  |
| ----------------- | ------------------------------- | ------------------------ |
| Android generates | `AVQD-{ANDROID_ID}` (uppercase) | `AVQD-6D52CB5103BB42DC`  |
| Database stores   | With prefix, uppercase          | `AVQD-6D52CB5103BB42DC`  |
| Heartbeat sends   | Without prefix, lowercase       | `6d52cb5103bb42dc`       |
| Backend matches   | Case-insensitive, tries both    | Works with any variation |

---

## Case-Insensitive Matching

**Critical fix (2025-01-05)**: All terminal lookups use case-insensitive matching.

```typescript
// ✅ CORRECT: Use mode: 'insensitive'
const terminal = await prisma.terminal.findFirst({
  where: {
    serialNumber: {
      equals: terminalId,
      mode: 'insensitive', // Handles lowercase/uppercase mismatch
    },
  },
})
```

---

## Heartbeat Timeout & Connection Status

**Design Decision**: Terminal considered OFFLINE if no heartbeat received in **2 minutes** (120 seconds).

```typescript
// Backend determines online status
const cutoff = new Date(Date.now() - 2 * 60 * 1000) // 2 minutes ago
const isOnline = terminal.lastHeartbeat && terminal.lastHeartbeat > cutoff
```

### Timing Configuration

| Setting            | Value          | Notes                         |
| ------------------ | -------------- | ----------------------------- |
| Heartbeat interval | 30 seconds     | Android sends every 30s       |
| Offline threshold  | 2 minutes      | 4 heartbeats missed = offline |
| Network timeout    | 10 seconds     | Per heartbeat request         |
| Retry on failure   | Immediate once | Then next scheduled heartbeat |

### Recommended Android Settings

- Heartbeat interval: 30 seconds (current)
- Retry on failure: Immediate retry once, then next scheduled heartbeat
- Network timeout: 10 seconds per heartbeat request
- Background restrictions: Disabled for app (to ensure heartbeats continue)

---

## Menta Integration (DISABLED)

**Status as of 2025-01-05**: Menta payment gateway integration is disabled.

- Previous design used `terminal.mentaTerminalId` from Menta API
- Generated fallback IDs like `fallback-6d52cb5103bb42dc` when API failed
- **Now**: Use `terminal.serialNumber` directly, no external API calls
- Code commented out in: `venue.tpv.service.ts:107-168`

---

## Key Files

| Purpose                   | File                                                           |
| ------------------------- | -------------------------------------------------------------- |
| Android serial generation | `avoqado-tpv/app/.../DeviceInfoManager.kt:55-62`               |
| Android heartbeat worker  | `avoqado-tpv/app/.../HeartbeatWorker.kt:137-140`               |
| Backend activation        | `src/services/dashboard/terminal-activation.service.ts:80-182` |
| Backend heartbeat         | `src/services/tpv/tpv-health.service.ts:51-151`                |
| Backend venue lookup      | `src/services/tpv/venue.tpv.service.ts:62-193`                 |

---

## Common Issues & Solutions

### 404 Error: Terminal with ID fallback-xxx not found

**Cause**: Android is sending the old Menta fallback ID instead of serial number.

**Fix**: Clear app data, re-activate terminal with fresh activation code.

### Case Mismatch: Heartbeat fails with exact serial match

**Cause**: Android sends lowercase, DB has uppercase.

**Fix**: Applied in 2025-01-05, all lookups now use `mode: 'insensitive'`.

### Intermittent "Offline" Status

**Troubleshooting steps**:

1. Check Android heartbeat worker logs for failed requests
2. Verify no battery optimization blocking background workers
3. Check backend logs for heartbeat gaps:
   ```sql
   SELECT serialNumber, lastHeartbeat FROM Terminal ORDER BY lastHeartbeat DESC;
   ```
4. Consider increasing timeout to 3 minutes if frequent false positives occur

---

## Testing Terminal Identification

```bash
# Check what terminals exist
psql -c "SELECT id, serialNumber, mentaTerminalId, status, activatedAt FROM Terminal;"

# Find terminal by serial (case-insensitive)
psql -c "SELECT * FROM Terminal WHERE LOWER(serialNumber) = LOWER('avqd-6d52cb5103bb42dc');"

# Check heartbeat history
psql -c "SELECT serialNumber, lastHeartbeat, status FROM Terminal WHERE lastHeartbeat > NOW() - INTERVAL '5 minutes';"
```

---

## Related Documentation

- `docs/TPV_COMMAND_SYSTEM.md` - TPV remote command architecture
- `docs/blumon-tpv/BLUMON_QUICK_REFERENCE.md` - Blumon SDK integration
