// Decide si una versión instalada del POS está OK, es RECOMMENDED o REQUIRED actualizar.
// Funciones puras. El SERVIDOR nunca bloquea lo que no puede comparar.
import { compareVersionNames, normalizeVersionName } from './version'

export type PosPlatformParam = 'ANDROID' | 'IOS' | 'DESKTOP'
export type PosAppVersionStatus = 'OK' | 'RECOMMENDED' | 'REQUIRED'

export interface VersionThreshold {
  versionCode: number | null
  versionName: string | null
}

export interface PolicyLevels {
  required: VersionThreshold | null
  recommended: VersionThreshold | null
}

export interface InstalledVersion {
  versionCode?: number
  versionName?: string
}

/** ¿La versión instalada está por debajo del umbral? Igual al mínimo NO está por debajo. */
export function isBelow(platform: 'ANDROID' | 'IOS', installed: InstalledVersion, threshold: VersionThreshold): boolean {
  if (platform === 'ANDROID') {
    // ANDROID decide por versionCode (entero)
    if (typeof installed.versionCode !== 'number' || typeof threshold.versionCode !== 'number') return false
    return installed.versionCode < threshold.versionCode
  }
  // iOS decide por versionName
  if (!installed.versionName || !threshold.versionName) return false
  // Un nombre mal formado no se puede comparar: no se bloquea
  if (!normalizeVersionName(installed.versionName) || !normalizeVersionName(threshold.versionName)) return false
  return compareVersionNames(installed.versionName, threshold.versionName) < 0
}

export function decide(platform: PosPlatformParam, installed: InstalledVersion, policy: PolicyLevels | null): PosAppVersionStatus {
  if (platform === 'DESKTOP' || !policy) return 'OK'
  if (policy.required && isBelow(platform, installed, policy.required)) return 'REQUIRED'
  if (policy.recommended && isBelow(platform, installed, policy.recommended)) return 'RECOMMENDED'
  return 'OK'
}
