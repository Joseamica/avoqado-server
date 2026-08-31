/**
 * Revisión de la configuración crítica — la MISMA verdad que grita el arranque, pero preguntable.
 *
 * Por qué existe (founder, 2026-08-30): las variables que protegen algo se comprobaban sólo al
 * arrancar, con un `logger.error`. Saber si quedaron puestas obligaba a reiniciar el servicio y
 * leer el log — y si las líneas de arranque no llegan al drenaje de logs (pasa en Render: se
 * buscaron en Better Stack y no había ni una en 48 h), entonces ni la ausencia del error prueba
 * nada. Guardar una variable en el panel tampoco basta: sólo entra en vigor al reiniciar, así
 * que «se ve puesta» y «está puesta» pueden ser cosas distintas.
 *
 * 🔴 Este módulo es PURO y recibe el entorno por parámetro. No importa `config/env.ts` a
 * propósito: ése corre validación y `process.exit(1)` al importarse, así que importarlo desde un
 * test puede matar al worker de Jest. Es la misma regla que ya obligó a sacar `envHelpers.ts`.
 *
 * 🔴 Y la regla que de verdad importa: **NUNCA devuelve el valor de una variable**, sólo si está
 * en el estado esperado. Un secreto que viaja en una respuesta HTTP ya está comprometido — queda
 * en logs de proxy, en el historial y en cualquier captura. Hay una prueba que lo fija.
 */

/** Hosts del proveedor bancario que NO pueden ser el destino en producción. */
const BANCO_HOSTS_INSEGUROS_EN_PROD: Record<string, string> = {
  'qpaydev.xyz': 'entorno DEV del proveedor — no son datos reales del cliente',
  'moneygiver.xyz': 'dominio RETIRADO — redirige 301 a un host que ya no existe en DNS (2026-07)',
}

/** Entornos donde hay aparatos reales conectados y la configuración importa de verdad. */
export const ENTORNOS_DESPLEGADOS = ['production', 'staging'] as const

export type Revision = {
  clave: string
  /** `true` = está en el estado esperado. NUNCA lleva el valor. */
  ok: boolean
  /** Qué se rompe si no está bien — o la confirmación de que está bien. */
  detalle: string
}

export type EntornoRevisable = {
  NODE_ENV: string
  SESSION_SUCCESSOR_ENC_KEY?: string
  EXTERNAL_BANK_API_BASE?: string
}

export function revisarConfiguracionCritica(entorno: EntornoRevisable): {
  entorno: string
  todoBien: boolean
  revisiones: Revision[]
} {
  const desplegado = (ENTORNOS_DESPLEGADOS as readonly string[]).includes(entorno.NODE_ENV)
  const revisiones: Revision[] = []

  // ── La llave que cifra el sucesor del refresh token durante la ventana de 60 s.
  // Sin ella, un reintento del refresco por red intermitente se lee como robo y REVOCA la sesión
  // del cajero a media venta. En development no aplica: nadie despliega desde su Mac.
  const tieneLlave = Boolean(entorno.SESSION_SUCCESSOR_ENC_KEY)
  revisiones.push({
    clave: 'SESSION_SUCCESSOR_ENC_KEY',
    ok: !desplegado || tieneLlave,
    detalle:
      !desplegado || tieneLlave
        ? desplegado
          ? 'configurada: la ventana de retransmisión de 60 s está activa'
          : 'no aplica fuera de production/staging'
        : 'FALTA: sin ella la ventana de retransmisión de 60 s no existe, y un reintento del refresco por red intermitente se lee como robo y REVOCA la sesión del cajero a media venta',
  })

  // ── El destino del proveedor bancario. Sólo se juzga en producción, que es donde apuntar al
  // ambiente de pruebas significa operar con dinero contra datos que no son del cliente.
  //
  // 🔴 El `try` no es adorno: una URL ilegible haría que `new URL` lance, el endpoint devolviera
  // 500 y perdiéramos justo la herramienta que veníamos a usar para diagnosticar. El diagnóstico
  // nunca puede ser la cosa que falla.
  let bancoOk = true
  let bancoDetalle = entorno.NODE_ENV === 'production' ? 'apunta a un host de producción' : 'no se juzga fuera de producción'
  if (entorno.NODE_ENV === 'production') {
    try {
      const host = new URL(entorno.EXTERNAL_BANK_API_BASE ?? '').hostname
      const match = Object.keys(BANCO_HOSTS_INSEGUROS_EN_PROD).find(d => host === d || host.endsWith(`.${d}`))
      if (match) {
        bancoOk = false
        bancoDetalle = `apunta a "${host}" en PRODUCCIÓN: ${BANCO_HOSTS_INSEGUROS_EN_PROD[match]}. Conectar banco / saldos / SPEI van a fallar o a operar contra el ambiente equivocado`
      }
    } catch {
      bancoOk = false
      bancoDetalle = 'el valor no es una URL válida, así que no se puede saber a dónde apunta'
    }
  }
  revisiones.push({ clave: 'EXTERNAL_BANK_API_BASE', ok: bancoOk, detalle: bancoDetalle })

  return {
    entorno: entorno.NODE_ENV,
    todoBien: revisiones.every(r => r.ok),
    revisiones,
  }
}
