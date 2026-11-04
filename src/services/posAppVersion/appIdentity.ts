// Actualizador del POS (r7, spec §4.7.3): de qué app del POS viene la petición del inicio, leído de sus cabeceras.
//
// El inicio (`GET /mobile/announcements/home` y `GET /dashboard/announcements/home`, el mismo controlador) sólo enseña el
// aviso de actualizar si sabe, sin duda, qué app pregunta y en qué versión va. Ante cualquier duda contesta `null` y el
// inicio sigue como hoy: nunca se le enseña el aviso al DASHBOARD, al WINDOWS ni a una app que no se puede comparar.
//
// Sólo lee, nunca registra nada y nunca lanza: cuelga del inicio de todas las apps y del DASHBOARD.
import type { IncomingHttpHeaders } from 'http'
import { parsePlatform, parseVersionCode } from '@/utils/appHeaders'
import { VERSION_NAME_RE } from './version'

export interface HomeAppIdentity {
  platform: 'ANDROID' | 'IOS'
  /** ANDROID decide por el número de compilación (`x-app-version-code`). */
  versionCode?: number
  /** iOS decide por el nombre de versión (`x-app-version`). */
  versionName?: string
}

/** Un texto de cabecera sin espacios. Una cabecera repetida (arreglo) es ambigua: se ignora. */
function texto(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const valor = raw.trim()
  return valor || undefined
}

/**
 * ¿Alguna forma declarada es DESKTOP? Se mira cada valor, también en una cabecera repetida (arreglo, o «A, B» como la
 * junta Node): basta una para no enseñar el aviso.
 */
function esEscritorio(raw: unknown): boolean {
  const valores = Array.isArray(raw) ? raw : [raw]
  return valores.some(v => typeof v === 'string' && v.split(',').some(parte => parte.trim().toUpperCase() === 'DESKTOP'))
}

/**
 * La app que pide el inicio, o `null` si no se sabe con certeza. Devuelve `null`:
 * - sin `x-device-platform` (el DASHBOARD), o con una plataforma desconocida o repetida;
 * - con `x-device-platform: DESKTOP`;
 * - con `x-device-form-factor: DESKTOP`, en cualquier mayúscula. 🔴 El WINDOWS puede mandar `ANDROID`
 *   (`posSinSoloSaldo.ts:8`); qué manda de verdad se confirma en la Mac antes de encender el primer aviso;
 * - si falta o no se lee el campo que decide: `x-app-version-code` en ANDROID, `x-app-version` (con `VERSION_NAME_RE`) en iOS.
 */
export function readHomeAppIdentity(headers: IncomingHttpHeaders | undefined): HomeAppIdentity | null {
  try {
    if (!headers) return null
    const platform = parsePlatform(texto(headers['x-device-platform']))
    if (platform !== 'ANDROID' && platform !== 'IOS') return null
    if (esEscritorio(headers['x-device-form-factor'])) return null

    if (platform === 'ANDROID') {
      const versionCode = parseVersionCode(headers['x-app-version-code'])
      return versionCode === undefined ? null : { platform, versionCode }
    }

    const versionName = texto(headers['x-app-version'])
    return versionName && VERSION_NAME_RE.test(versionName) ? { platform, versionName } : null
  } catch {
    // Unas cabeceras raras nunca tumban el inicio: sin identidad, el inicio sigue como hoy.
    return null
  }
}
