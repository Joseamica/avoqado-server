// src/services/customer-display/customerDisplayAckView.ts
/**
 * «¿Qué muestra la tablet?», decidido AL LEER (spec §5.7.2, §6.1), para el MCP. PURO.
 *
 * 🔴 LA MISMA regla, en el MISMO orden, que la tarjeta del dashboard (F1:
 * `avoqado-web-dashboard/src/pages/Tpv/customer-display/estado.ts`, `leerAcuse` e `historialDe`). Si una de las dos cambia,
 * cambian las dos: la IA y el panel no pueden decir cosas distintas del mismo aparato.
 */
export type EstadoEnLaTablet =
  | 'APP_SIN_DISENOS'
  | 'SIN_ACUSE'
  | 'PENDIENTE'
  | 'NO_SOPORTADO'
  | 'KIOSCO'
  | 'MOSTRADO'
  | 'GUARDADO'
  | 'RECIBIDO'

export interface EnLaTablet {
  estado: EstadoEnLaTablet
  /** La hora del SERVIDOR (`receivedAt`), nunca la de la tablet; null cuando el estado no la afirma. */
  fecha: string | null
  imagenesDescargandose: number
  imagenesFallidas: number
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/
/** Una fecha ISO legible; cualquier otra cosa (vacía, basura, el `now()::text` de Postgres) no es evidencia: null. */
const fechaISO = (v: unknown): string | null => (typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(v)) ? v : null)
const cuenta = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0)

/**
 * ¿Hay acuse? LA regla de F1 (`leerAcuse`): un objeto con huella y `receivedAt` ISO. La usan esta vista y el ack (que sólo
 * deja bloquear un reemplazo a lo que esta regla reconoce, Codex r1 #3).
 */
export function acuseLegible(ack: unknown): ack is Record<string, unknown> & { fingerprint: string; receivedAt: string } {
  if (!ack || typeof ack !== 'object' || Array.isArray(ack)) return false
  const a = ack as Record<string, unknown>
  return typeof a.fingerprint === 'string' && fechaISO(a.receivedAt) !== null
}

export function enLaTablet(ack: unknown, fingerprintVigente: string, designVersion: number | null | undefined): EnLaTablet {
  const vacio = { fecha: null, imagenesDescargandose: 0, imagenesFallidas: 0 }
  if (designVersion == null) return { estado: 'APP_SIN_DISENOS', ...vacio }
  if (!acuseLegible(ack)) return { estado: 'SIN_ACUSE', ...vacio }
  const a = ack
  const recibido = a.receivedAt
  const cuentas = { imagenesDescargandose: cuenta(a.imagesPending), imagenesFallidas: cuenta(a.imagesFailed) }
  // «Pendiente» se decide AL LEER (spec §5.7.2): el acuse es de otra huella que la ficha de ahora.
  if (a.fingerprint !== fingerprintVigente) return { estado: 'PENDIENTE', fecha: null, ...cuentas }
  if (a.unsupportedSchema === true) return { estado: 'NO_SOPORTADO', fecha: null, ...cuentas }
  const guardado = fechaISO(a.storedAt)
  if (a.surface === 'kiosk')
    return guardado ? { estado: 'KIOSCO', fecha: recibido, ...cuentas } : { estado: 'RECIBIDO', fecha: null, ...cuentas }
  if (fechaISO(a.shownAt)) return { estado: 'MOSTRADO', fecha: recibido, ...cuentas }
  if (guardado) return { estado: 'GUARDADO', fecha: recibido, ...cuentas }
  return { estado: 'RECIBIDO', fecha: null, ...cuentas }
}
