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

/**
 * Llave de identidad de una terminal para COMPARAR: sin `AVQD-`, sin espacios, en minúsculas.
 *
 * El mismo serial circula en producción como `AVQD-N860W173570`, `N860W173570` y
 * `n860w173570` (la base lo guarda con prefijo — `normalizeTerminalSerialNumber` —, la app lo
 * manda como lo lee del hardware, y el dashboard lo teclea como puede). Es la MISMA regla que
 * usa el registro de sockets (`terminal-registry.ts`), que delega aquí.
 */
export function terminalIdentityKey(serial: string): string {
  return serial
    .trim()
    .replace(/^AVQD-/i, '')
    .toLowerCase()
}

/**
 * ¿`a` y `b` nombran la MISMA terminal? Única definición — la usan el guardia de propiedad del
 * ACK (`tpv-health.service.ts`) y el carril de sockets que entrega un comando SÓLO a su
 * destinataria (`broadcasting.service.ts`). Antes cada uno comparaba a su manera: el guardia
 * del ACK tenía una comparación a tres vías que aceptaba «base sin prefijo, acuse con prefijo»
 * pero rechazaba la dirección contraria.
 *
 * Un serial vacío nunca coincide con nada: un aparato sin identidad no es dueño de ningún comando.
 */
export function sameTerminalSerial(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const ka = terminalIdentityKey(a)
  return ka.length > 0 && ka === terminalIdentityKey(b)
}
