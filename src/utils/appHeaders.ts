import type { DevicePlatformHeader } from '../services/mobile/deviceRegistry.service'

/**
 * Lectores de las cabeceras de identidad de la app, en un módulo propio (D1): los usan `registerDevice.middleware.ts` y
 * `posSinSoloSaldo.ts`, y muchas pruebas simulan el middleware entero, así que no pueden vivir ahí.
 */
const VALID_PLATFORMS: readonly DevicePlatformHeader[] = ['IOS', 'ANDROID', 'DESKTOP']

export function parsePlatform(value: string | undefined): DevicePlatformHeader | undefined {
  if (!value) return undefined
  const upper = value.toUpperCase() as DevicePlatformHeader
  return VALID_PLATFORMS.includes(upper) ? upper : undefined
}

/**
 * El número de compilación de la app (F0-B, Task 11): `x-app-version-code`, el MISMO nombre que ya manda la TPV
 * (`tpv-version-gate.middleware.ts:137`). Sólo un entero positivo de 32 bits sin ceros a la izquierda; cualquier otra cosa
 * se ignora, nunca truena (esto cuelga del camino del cobro). Una cabecera repetida (arreglo, o «55, 56» como la junta Node)
 * es ambigua: se ignora, a diferencia de las de texto, que toman la primera.
 */
export function parseVersionCode(raw: string | string[] | undefined): number | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  if (!/^[1-9]\d{0,9}$/.test(value)) return undefined
  const n = Number(value)
  return n <= 2_147_483_647 ? n : undefined
}
