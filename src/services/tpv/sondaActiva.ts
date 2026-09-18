/**
 * «La terminal dijo hace poco que ESTE cobro sigue ejecutándose» — el único veto que no viene del dinero, sino
 * de la EJECUCIÓN.
 *
 * 🔴 Por qué es un módulo y no una línea del log: la sonda (`terminal:payment_probe`) ya preguntaba y la terminal
 * ya contestaba `ACTIVE`, pero esa respuesta sólo se registraba y la función retornaba. No quedaba ningún dato
 * durable, así que la declaración del cajero «revisé la terminal y no se cobró» no tenía cómo consultarla: el
 * veto existía en el diseño y no en el código (Codex, 18-sep).
 *
 * Vive aparte del servicio —como `estadoBancario`, `evidenciaPositivaSql` y `candadoDeIntento`— porque es PURO:
 * se prueba sin base, sin sockets y sin arrastrar las ~7 000 líneas de `terminal-payment.service`.
 */

/**
 * 15 minutos. No es un plazo de seguridad sino de VIGENCIA: la sonda se manda al conectar y en cada barrido, así
 * que un cobro que siguiera corriendo lo habría vuelto a declarar dentro de esa ventana. Pasado ese tiempo la
 * marca ya no dice nada del presente — y quien decide sigue siendo la evidencia de dinero, que se comprueba aparte.
 */
export const VENTANA_SONDA_ACTIVA_MS = 15 * 60 * 1000

/**
 * 🔴 Falla CERRADO. Una marca que no se puede leer (texto basura, número, objeto) se trata como «sigue activo»:
 * el costo de equivocarse hacia el otro lado es dejar declarar «no se cobró» encima de un cobro en curso, que es
 * exactamente el camino del cobro doble del 2026-08-10. Una marca del FUTURO (reloj adelantado) también veta.
 */
export function sondaReportoActiva(
  row: { resultJson?: unknown },
  ahora: Date,
  ventanaMs: number = VENTANA_SONDA_ACTIVA_MS,
): boolean {
  const sobre =
    row.resultJson && typeof row.resultJson === 'object' && !Array.isArray(row.resultJson)
      ? (row.resultJson as Record<string, unknown>)
      : null
  if (!sobre) return false
  const marca = sobre.probeActiveAt
  if (marca === undefined || marca === null) return false
  if (typeof marca !== 'string') return true
  const t = Date.parse(marca)
  if (Number.isNaN(t)) return true
  return ahora.getTime() - t < ventanaMs
}
