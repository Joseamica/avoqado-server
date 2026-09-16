/**
 * Codex R1/R2 (P2): una POSIBLE SEGUNDA CAPTURA es evidencia, no una venta — también en un REPLAY. El registrador devuelve
 * la marca transitoria `possibleSecondCapture` sólo la primera vez; el retorno idempotente (misma llave) trae el Payment
 * PENDING con su `processorData.reconciliation`. Se decide por lo DURABLE, con la marca transitoria sólo como atajo.
 * Lo comparten el controlador de la terminal (SaleVerification) y el webhook (clasificación del evento).
 */
export function esEvidenciaDeSegundaCaptura(result: unknown): boolean {
  return tipoDeEvidencia(result) === 'POSSIBLE_SECOND_CAPTURE'
}

/**
 * Codex R4-6: también la COLISIÓN DE REFERENCIA (misma referencia/importe/terminal, pero el candidato contradice al
 * entrante bajo el candado) es evidencia PENDING y no una venta. Lo que no debe pasar con una segunda captura (verificación
 * de venta, lealtad, costo, turno) tampoco debe pasar con ella.
 */
export function esEvidenciaDeConciliacion(result: unknown): boolean {
  return tipoDeEvidencia(result) !== null
}

export function tipoDeEvidencia(result: unknown): 'POSSIBLE_SECOND_CAPTURE' | 'POSSIBLE_REFERENCE_COLLISION' | null {
  if (!result || typeof result !== 'object') return null
  const r = result as Record<string, unknown>
  if ('possibleSecondCapture' in r) return 'POSSIBLE_SECOND_CAPTURE'
  if ('possibleReferenceCollision' in r) return 'POSSIBLE_REFERENCE_COLLISION'
  const datos = r.processorData
  const reconciliation = datos && typeof datos === 'object' ? (datos as Record<string, unknown>).reconciliation : null
  if (r.status !== 'PENDING' || !reconciliation || typeof reconciliation !== 'object') return null
  const kind = (reconciliation as Record<string, unknown>).kind
  return kind === 'POSSIBLE_SECOND_CAPTURE' || kind === 'POSSIBLE_REFERENCE_COLLISION' ? kind : null
}
