// src/services/storeCredit/posSinSoloSaldo.ts
/**
 * D1 (hz:130a3725:D1): ¿el POS que llama es una app publicada que no sabe de «Sólo saldo a favor»? Esas apps no mandan
 * `storeCreditOnlyException` ni ofrecen saldo a favor: con el interruptor prendido se quedaban atoradas al devolver a tarjeta en la
 * terminal, en el Reembolso y en el Cambio. Sólo lo preguntan las rutas del POS; el panel y el MCP nunca mandan la marca y siguen
 * respetando el interruptor.
 *
 * Viejas: ANDROID (y WINDOWS, que manda ANDROID) hasta el build 95, iOS hasta el 41, o sin cabeceras, con una plataforma sin corte o
 * con una versión ilegible. 🔴 El 95 es el número que Play inyecta al compilar (etiqueta v2.25.26-95), no el `versionCode` de
 * `app/build.gradle.kts`.
 */
import type { IncomingHttpHeaders } from 'http'
import { parsePlatform, parseVersionCode } from '@/utils/appHeaders'

/** El último build publicado que no sabe de «Sólo saldo a favor», por plataforma. */
const ULTIMO_BUILD_SIN_SOLO_SALDO = { ANDROID: 95, IOS: 41 } as const

export function esPosSinSoloSaldo(headers: IncomingHttpHeaders | undefined): boolean {
  const raw = headers?.['x-device-platform']
  const platform = parsePlatform(typeof raw === 'string' ? raw.trim() : undefined)
  const build = parseVersionCode(headers?.['x-app-version-code'])
  if (build === undefined || (platform !== 'ANDROID' && platform !== 'IOS')) return true
  return build <= ULTIMO_BUILD_SIN_SOLO_SALDO[platform]
}
