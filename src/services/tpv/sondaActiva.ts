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
 * Con una excepción, por compatibilidad con las TPV publicadas: ver `sondaVetaLaDeclaracion`.
 */

/**
 * 🔴 Falla CERRADO. Una marca presente veta hasta que llegue una respuesta POSTERIOR que resuelva ese intento
 * (`probeResolvedAt`). Una respuesta anterior no cuenta: llegó antes, no desmiente nada.
 */
export function sondaReportoActiva(
  row: { probeActiveAt?: Date | null; probeResolvedAt?: Date | null; resultJson?: unknown },
  _ahora?: Date,
): boolean {
  // 🔴 Codex r3 (P1-2): el formato ANTERIOR guardaba la marca dentro de `resultJson`, y al mover la columna
  // esas observaciones quedaban invisibles: el lector devolvía «no hay sonda activa» y la declaración pasaba
  // sobre un cobro que la terminal había dicho estar ejecutando. La migración `20260919020000` las traslada,
  // y este respaldo cubre la ventana del despliegue, en la que un proceso viejo todavía puede escribir ahí.
  // Cualquier valor presente cuenta como veto, incluso ilegible: falla CERRADO.
  const enElSobre =
    row.resultJson && typeof row.resultJson === 'object' && !Array.isArray(row.resultJson)
      ? (row.resultJson as Record<string, unknown>).probeActiveAt
      : undefined

  // 🔴 Ronda 4 de Codex: aquí había un `new Date(0)` como marca sintética, y era un defecto doble. 1970 es
  // anterior a CUALQUIER `probeResolvedAt`, así que una resolución vieja levantaba el veto de una observación
  // nueva; y el `??` hacía que una columna poblada ocultara una marca del sobre MÁS RECIENTE. Ahora se miran
  // las dos fuentes y manda la más nueva. Una marca del sobre ilegible veta siempre: falla CERRADO.
  let delSobre: Date | null = null
  if (enElSobre !== undefined && enElSobre !== null) {
    const t = typeof enElSobre === 'string' ? Date.parse(enElSobre) : NaN
    if (Number.isNaN(t)) return true // ilegible ⇒ no se puede desmentir ⇒ veta
    delSobre = new Date(t)
  }
  const deLaColumna = row.probeActiveAt ?? null
  const activa =
    deLaColumna && delSobre ? (deLaColumna.getTime() >= delSobre.getTime() ? deLaColumna : delSobre) : (deLaColumna ?? delSobre)
  if (!activa) return false
  const resuelta = row.probeResolvedAt
  if (!resuelta) return true
  // Sólo una respuesta posterior al ACTIVE lo levanta.
  return resuelta.getTime() <= activa.getTime()
}

/**
 * ¿El ACTIVE veta que una PERSONA declare «no se cobró»?
 *
 * 🔴 Compatibilidad (Codex, versiones viejas, 3-nov): la TPV publicada contesta ACTIVE mientras su intento siga en duda, y
 * espera NOT_CHARGED para soltarlo; no sabe certificar el cese. Antes la ventana de 30 s cerraba esa venta sola; desde A8, sin
 * aviso comprobado del banco, sólo suelta la ranura. Con esa TPV y la ranura ya suelta, el veto dejaba la venta sin poder
 * declararse nunca. Su ACTIVE deja de vetar SÓLO ahí: la TPV que sí sabe certificar, y la ranura apartada, siguen igual.
 */
export function sondaVetaLaDeclaracion(
  row: Parameters<typeof sondaReportoActiva>[0] & { deliveryProvenance?: unknown },
  ranuraYaSuelta: boolean,
): boolean {
  if (!sondaReportoActiva(row)) return false
  if (!ranuraYaSuelta) return true
  const entregas = (row.deliveryProvenance as { deliveries?: { executionVersion?: number }[] } | null)?.deliveries
  return Array.isArray(entregas) && entregas.some(e => Number(e?.executionVersion) >= 1)
}

/**
 * F1 · bloque 1 (18-nov): la versión de la capacidad de ejecución con la que la PAX, además del cese, acredita si ESTA solicitud se
 * puede declarar «no se cobró» (`declarable` en su respuesta a la sonda o a la disposición del cancel).
 */
export const EXECUTION_VERSION_DECLARABLE = 2

/**
 * ¿Esta solicitud se entregó a una terminal que sabe acreditar la declaración? Entonces una persona sólo la declara con el certificado
 * de esa terminal (`executionDeclarable === true`): el acuse de entrega sólo prueba que llegó. Una TPV vieja (v1, sin versión o
 * procedencia desconocida) nunca lo anunció y sigue exactamente como hoy, con la excepción del 3-nov incluida.
 */
export function exigeAcreditacionDeLaTerminal(row: { deliveryProvenance?: unknown }): boolean {
  const entregas = (row.deliveryProvenance as { deliveries?: { executionVersion?: number }[] } | null)?.deliveries
  return Array.isArray(entregas) && entregas.some(e => Number(e?.executionVersion) >= EXECUTION_VERSION_DECLARABLE)
}

/**
 * F1 · bloque 1 (18-nov): una solicitud entregada a una PAX v2 sólo la declara una persona con el certificado de esa terminal
 * (`executionDeclarable`). Sin certificado, o con uno que dice «terminé pero no se puede declarar», la firma se rechaza con estos
 * códigos; los comparten la firma del POS (`uncharged-reconciliation.service`) y «no presentó tarjeta» (`no-instrument-resolution.service`). Las apps pintan el `message`.
 */
export const TERMINAL_CONFIRMATION_PENDING = 'TERMINAL_CONFIRMATION_PENDING'
export const TERMINAL_HAS_RESULT = 'TERMINAL_HAS_RESULT'
export const TEXTO_TERMINAL_SIN_CONFIRMAR =
  'Esperando confirmación de la terminal. Déjala encendida y conectada: en cuanto confirme que terminó con este cobro, podrás firmar.'
export const TEXTO_TERMINAL_CON_RESULTADO =
  'La terminal tiene un resultado de este cobro que todavía no llega a Avoqado. No lo declares: déjala encendida y conectada para que lo envíe.'
