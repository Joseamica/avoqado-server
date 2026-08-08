import { TerminalType } from '@prisma/client'

/**
 * The Android TPV client (avoqado-tpv) always derives its hardware serial as
 * "AVQD-{raw serial}" uppercase — including NEXGO devices, which read the raw
 * serial from `ro.ums.manufacturer.info` (see DeviceInfoManager.kt). If a
 * terminal is registered with the bare raw serial (e.g. what's printed on the
 * device), the device's activation/heartbeat calls never match it and the app
 * reports "Terminal no registrado".
 *
 * Normalize at every write site so stored serials always match what the
 * device sends. Non-Android terminal types (iOS, printers, KDS) don't use
 * this scheme and are left untouched.
 */
export function normalizeTerminalSerialNumber(serialNumber: string, terminalType: TerminalType | string): string {
  if (terminalType !== TerminalType.TPV_ANDROID) return serialNumber

  const trimmed = serialNumber.trim().toUpperCase()
  return trimmed.startsWith('AVQD-') ? trimmed : `AVQD-${trimmed}`
}

/**
 * Detect a terminal id that looks like the Android `ANDROID_ID` fallback rather
 * than a real hardware serial.
 *
 * `DeviceInfoManager.getSerialNumber()` (avoqado-tpv) catches the
 * SecurityException from `Build.getSerial()` and silently falls back to
 * `Settings.Secure.ANDROID_ID` — a 64-bit value rendered as 16 hex chars. The
 * device then heartbeats under an identity that was never registered, gets a
 * 404 on every attempt, and after 10 consecutive 404s `HeartbeatWorker` wipes
 * its own activation. Real serials never look like this: PAX is all digits
 * (e.g. `2840744167`) and NEXGO is prefixed (e.g. `N860W173570`).
 *
 * Requires at least one A-F character so a hypothetical 16-digit numeric serial
 * is not misreported as a fallback id.
 */
export function looksLikeAndroidIdFallback(terminalId: string): boolean {
  const bare = terminalId
    .trim()
    .toUpperCase()
    .replace(/^AVQD-/, '')
  return /^[0-9A-F]{16}$/.test(bare) && /[A-F]/.test(bare)
}
