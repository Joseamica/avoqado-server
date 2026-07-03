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
