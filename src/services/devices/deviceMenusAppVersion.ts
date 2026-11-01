/**
 * «Menú del aparato»: desde qué versión de cada app la cuadrícula aplica los menús elegidos.
 *
 * `null` = ninguna app lo aplica todavía: se fija en la Parte E, al publicar ANDROID, iOS y WINDOWS. Mientras tanto la página
 * del DASHBOARD dice «Actualiza la app para que lo aplique» en cada aparato.
 */

import type { TerminalType } from '@prisma/client'

export const DEVICE_MENUS_MIN_APP_VERSION: Record<'POS_ANDROID' | 'POS_IOS' | 'POS_DESKTOP', string | null> = {
  POS_ANDROID: null,
  POS_IOS: null,
  POS_DESKTOP: null,
}

/** Sólo el prefijo numérico: `2.25.24-escritorio` y `2.25.24-dev` valen `2.25.24`. */
function numeros(version: string): number[] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** ¿La app de este aparato ya aplica el menú del aparato? Sin versión, sin mínima o sin prefijo numérico: no. */
export function appliesDeviceMenus(type: TerminalType, version: string | null): boolean {
  const minima = (DEVICE_MENUS_MIN_APP_VERSION as Partial<Record<TerminalType, string | null>>)[type]
  const v = version ? numeros(version) : null
  const m = minima ? numeros(minima) : null
  if (!v || !m) return false
  for (let i = 0; i < 3; i++) if (v[i] !== m[i]) return v[i] > m[i]
  return true
}
