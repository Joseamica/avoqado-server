/**
 * «La terminal dijo que ESTE cobro sigue ejecutándose» — el único veto que no viene del dinero, sino de la
 * EJECUCIÓN.
 *
 * 🔴 RONDA 2 de Codex (19-sep). La primera versión tenía dos defectos, y los dos venían de la misma premisa
 * equivocada: que un `ACTIVE` viejo ya no dice nada porque «cada barrido lo habría repetido».
 *
 *  1. **Esa premisa es FALSA.** El barrido periódico parte de filas `UNKNOWN` y la sonda acota sus candidatos
 *     a 25, así que a una `TIMED_OUT` puede no volver a preguntársele nunca. Dejar caducar el veto por reloj
 *     era afirmar «ya no está corriendo» sin que nadie lo desmintiera — exactamente lo que este módulo existe
 *     para no hacer. Ahora **el tiempo no levanta el veto**: sólo lo levanta una RESPUESTA POSTERIOR que
 *     resuelva ese intento.
 *  2. **La marca vivía en `resultJson`**, el sobre que cualquier resultado posterior reemplaza entero. Un
 *     timeout tardío borraba la evidencia de que el cobro seguía vivo. Ahora vive en columnas propias.
 *
 * Consecuencia asumida y declarada: una solicitud con `ACTIVE` sin desmentir **no se puede declarar**, ni
 * siquiera pasado mucho tiempo. Es el lado seguro: quien la destrabe tendrá que conseguir que la terminal
 * conteste, no esperar a que el reloj le dé la razón.
 */

/**
 * 🔴 Falla CERRADO. Una marca presente veta hasta que llegue una respuesta POSTERIOR que resuelva ese intento
 * (`probeResolvedAt`). Una respuesta anterior no cuenta: llegó antes, no desmiente nada.
 */
export function sondaReportoActiva(
  row: { probeActiveAt?: Date | null; probeResolvedAt?: Date | null },
  _ahora?: Date,
): boolean {
  const activa = row.probeActiveAt
  if (!activa) return false
  const resuelta = row.probeResolvedAt
  if (!resuelta) return true
  // Sólo una respuesta posterior al ACTIVE lo levanta.
  return resuelta.getTime() <= activa.getTime()
}
