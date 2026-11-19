/**
 * F1 · cierre bloque 7 (18-nov, `plan-cierre-familias.md` I4 y §5): el COMPROBANTE de una declaración «no se cobró» / «no presentó
 * tarjeta» ya guardada. UNA forma para el POST de la declaración (por intento y por solicitud), S6 y el GET por solicitud de la
 * terminal, en la llave `declarationReceipt` (aditiva: un cliente viejo la ignora).
 *
 * 🔴 Dice lo que CONSTA, nunca lo que el cliente quisiera leer: una firma HUMANA sólo la acredita una clase humana, con `by`
 * `SESSION` (histórico, antes de F1) o `SUPERVISOR_PIN`, autor y hora. Sin autor, `AUTOMATIC`, el rechazo del banco o un `by`
 * desconocido salen con `humanSignature: false`. El texto lo decide el cliente.
 *
 * `alreadyStored`: `false` sólo en el POST que ESCRIBIÓ la declaración. En la repetición (respuesta perdida, o un segundo gerente
 * con el mismo `resolutionId`) y en las consultas es `true`: firmante y hora son los del guardado, y el cliente dice «Avoqado tiene
 * guardada una declaración de este cobro», no «quedó tu firma».
 */
export interface DeclarationReceipt {
  id: string
  /** `NO_INSTRUMENT_PRESENTED` · `UNCHARGED_VERIFIED` (humanas) · `NO_BANK_TRACE_AFTER_WINDOW` (terminal) · `BANK_DECLINED` (banco). */
  kind: string
  by: 'SESSION' | 'SUPERVISOR_PIN' | 'AUTOMATIC' | null
  /** Con `SUPERVISOR_PIN`, el gerente que firmó; con `SESSION`, la sesión que declaró (histórico). */
  staffId: string | null
  acceptedAt: string | null
  /** Dónde vive: la del INTENTO (vínculo o Pago rápido) o la de la SOLICITUD (`operatorReconciliation`). */
  scope: 'ATTEMPT' | 'REQUEST'
  attemptId: string | null
  requestId: string | null
  humanSignature: boolean
  alreadyStored: boolean
}

const CLASES_HUMANAS = new Set(['NO_INSTRUMENT_PRESENTED', 'UNCHARGED_VERIFIED'])
const FIRMANTES = new Set(['SESSION', 'SUPERVISOR_PIN', 'AUTOMATIC'])

export function comprobanteDeDeclaracion(
  guardada: unknown,
  alcance: { scope: DeclarationReceipt['scope']; attemptId: string | null; requestId: string | null },
  alreadyStored = true,
): DeclarationReceipt | null {
  if (!guardada || typeof guardada !== 'object' || Array.isArray(guardada)) return null
  const g = guardada as Record<string, unknown>
  if (typeof g.id !== 'string' || !g.id || typeof g.kind !== 'string' || !g.kind) return null
  const by = typeof g.by === 'string' && FIRMANTES.has(g.by) ? (g.by as DeclarationReceipt['by']) : null
  const staffId = typeof g.staffId === 'string' && g.staffId.trim() ? g.staffId : null
  const acceptedAt = typeof g.acceptedAt === 'string' && !Number.isNaN(Date.parse(g.acceptedAt)) ? g.acceptedAt : null
  return {
    id: g.id,
    kind: g.kind,
    by,
    staffId,
    acceptedAt,
    scope: alcance.scope,
    attemptId: alcance.attemptId,
    requestId: alcance.requestId,
    humanSignature: CLASES_HUMANAS.has(g.kind) && (by === 'SESSION' || by === 'SUPERVISOR_PIN') && !!staffId && !!acceptedAt,
    alreadyStored,
  }
}
