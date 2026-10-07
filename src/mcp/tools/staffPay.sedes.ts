// src/mcp/tools/staffPay.sedes.ts — B13 en el MCP de pago al personal (fase 3; diseño r5.1, r3.7(1); revisión de B12 #7): lo que la
// vista previa del cierre y la del ajuste ya devolvían crudo (por sede, devoluciones pendientes, el aviso) dicho en palabras del
// dueño, y TODO eso acotado a las sedes del alcance de la CONEXIÓN además del permiso del usuario. Pesos 1:1; fechas civiles.
import { Prisma } from '@prisma/client'
import type { Cuenta } from '@/services/dashboard/staffPay/participacion.vistaPrevia'
import type { Destino, DevolucionesPendientes } from '@/services/dashboard/staffPay/devolucionesPendientes'
import type { EstadoSede } from '@/services/dashboard/staffPay/estadoSede'
import { estadoSedes } from '@/services/dashboard/staffPay/sedes.service'
import type { McpScope } from '../scope'
import { text } from '../respond'
import { conSigno, lista, periodoLegible } from './staffPay.formato'

type PorDestino = DevolucionesPendientes['porDestino']
type Pendientes = { n: number; total: string; porDestino: PorDestino }
type SedeConCuentas = { venueId: string; nombre: string; estado: EstadoSede; entra: Cuenta; fuera: Cuenta }

/**
 * Revisión de B12 #7: `porSede` y las pendientes de una vista previa, acotadas a `permitidas` (las sedes del alcance de la
 * conexión). Las pendientes se rehacen con lo que queda: cada destino suma SUS sedes permitidas (agregados exactos de la base,
 * en `Prisma.Decimal`); un destino sin ninguna se quita. Lo demás de la vista previa no se toca.
 */
export function acotarAlAlcance<T extends { porSede?: Array<{ venueId: string }>; pendientes?: Pendientes }>(
  p: T,
  permitidas: readonly string[],
): T {
  const en = (v: string) => permitidas.includes(v)
  const out: T = { ...p }
  if (p.porSede) out.porSede = p.porSede.filter(s => en(s.venueId))
  if (p.pendientes) {
    const sumar = (xs: Array<{ n: number; total: string }>) => ({
      n: xs.reduce((a, x) => a + x.n, 0),
      total: xs.reduce((a, x) => a.plus(x.total), new Prisma.Decimal(0)).toFixed(2),
    })
    const porDestino = p.pendientes.porDestino.flatMap(d => {
      const porSede = d.porSede.filter(x => en(x.venueId))
      return porSede.length ? [{ ...d, ...sumar(porSede), porSede }] : []
    })
    out.pendientes = { ...p.pendientes, ...sumar(porDestino), porDestino }
  }
  return out
}

/**
 * Un 4xx del service (la huella cambió, periodo cerrado, sin permiso…) es una respuesta, no un 500. B14-fix F1 (Codex
 * participación r1 #1): la vista previa que trae un rechazo —el cierre la manda entera con `HUELLA_CAMBIO`— se acota a la
 * conexión IGUAL que la normal (`acotarAlAlcance`): antes este camino devolvía `porSede` y las pendientes de sedes fuera de ella.
 */
export const falloDelServicio =
  (scope: McpScope) =>
  (e: unknown, extra = '') => {
    const err = e as { statusCode?: number; message?: string; code?: string; details?: { preview?: unknown } }
    if (!err?.statusCode || err.statusCode >= 500) throw e
    const p = err.details?.preview
    const preview = p && typeof p === 'object' ? acotarAlAlcance(p as Parameters<typeof acotarAlAlcance>[0], scope.allowedVenueIds) : null
    return text({ ok: false, error: `${err.message}${extra}`, code: err.code ?? null, preview })
  }

/** Cuándo se descuenta una pendiente, en palabras: «al cerrar el periodo de octubre de 2026». */
export const destinoLegible = (d: Destino) =>
  d.tipo === 'AL_CERRAR'
    ? `al cerrar el periodo ${periodoLegible(d.periodo)}`
    : `al cerrar un periodo posterior al ${periodoLegible(d.origen)}`

const ESTADO: Record<EstadoSede, string> = {
  ACTIVA: 'activa',
  SIN_ACTIVAR: 'sin activar',
  ACTIVA_SIN_PLAN: 'activa sin el plan',
  SIN_PLAN: 'sin el plan',
}
/** Lo que tiene una cuenta, sólo lo que no es cero: «3 clase(s) ($1,500.00) y 1 comisión(es) ($100.00)». */
const partes = (c: Cuenta) => [
  ...(c.clases.n ? [`${c.clases.n} clase(s) (${conSigno(c.clases.total)})`] : []),
  ...(c.comisiones.n ? [`${c.comisiones.n} comisión(es) (${conSigno(c.comisiones.total)})`] : []),
  ...(c.propinas.n ? [`${c.propinas.n} propina(s) (${conSigno(c.propinas.total)})`] : []),
  ...(c.clases.pendientesDeValoracion ? [`${c.clases.pendientesDeValoracion} clase(s) que todavía no se pueden valorar`] : []),
]
const sedeEnPalabras = (s: SedeConCuentas) => {
  const entra = partes(s.entra)
  const fuera = partes(s.fuera)
  return `${s.nombre} (${ESTADO[s.estado]}): ${entra.length ? `entran ${lista(entra)}` : 'no entra nada'}${
    fuera.length ? `; quedan fuera ${lista(fuera)}` : ''
  }`
}

/**
 * El cierre por sede y sus devoluciones pendientes en palabras (r3.7(3), r6.2), para el mensaje de `close_service_pay_period`:
 * « Por sede — PN (activa): entran …; Condesa (sin activar): no entra nada; quedan fuera …. Devoluciones pendientes que este
 * cierre no descuenta: −$50.00 se descontará solo al cerrar el periodo de octubre de 2026.» Vacío si no hay nada que decir.
 */
export function detalleDelCierre(p: { porSede?: SedeConCuentas[]; pendientes?: Pendientes }): string {
  const sedes = (p.porSede ?? []).map(sedeEnPalabras)
  const pendientes = (p.pendientes?.porDestino ?? []).map(
    d =>
      `${conSigno(d.total)} se descontará solo ${destinoLegible(d.seDescuenta)}${d.seDescuenta.tipo === 'PERIODO_POSTERIOR_A' ? ' (ése ya se cerró)' : ''}`,
  )
  return `${sedes.length ? ` Por sede — ${sedes.join('. ')}.` : ''}${
    pendientes.length ? ` Devoluciones pendientes que este cierre no descuenta: ${pendientes.join('; ')}.` : ''
  }`
}

/**
 * El aviso del ajuste manual (r5.1): «Ana tiene −$50.00 en devoluciones que se descontarán solas al cerrar el periodo de
 * octubre de 2026. Si este ajuste es por eso, no lo registres.» Con varios destinos los nombra. Vacío sin pendientes y,
 * ronda 1 (R6), con un ajuste que no es un descuento: un bono no puede ser «por eso».
 */
export function avisoDePendientes(persona: string, a: Pendientes | undefined, monto: number): string {
  if (!(monto < 0) || !a?.n || !a.porDestino.length) return ''
  const cuando =
    a.porDestino.length === 1
      ? ` ${destinoLegible(a.porDestino[0].seDescuenta)}`
      : `: ${lista(a.porDestino.map(d => `${conSigno(d.total)} ${destinoLegible(d.seDescuenta)}`))}`
  return ` ${persona} tiene ${conSigno(a.total)} en devoluciones que se descontarán solas${cuando}. Si este ajuste es por eso, no lo registres.`
}

/** Topes de volumen y una foto vencida: la configuración responde igual, sin la pantalla de sedes (ronda 1, R1). */
const DE_VOLUMEN = new Set(['DEMASIADAS_SEDES', 'STAFF_PAY_DEMASIADAS_VENTANAS', 'LECTURA_VENCIDA'])

/**
 * La pantalla de sedes para `staff_service_pay_config` (r3.7(1)), acotada a las sedes de la conexión (revisión de B12 #7).
 * - R1: si no se puede leer por volumen (`DEMASIADAS_SEDES`, `STAFF_PAY_DEMASIADAS_VENTANAS`) o la foto vence, `sedes: null` con el
 *   motivo en palabras; el resto de la configuración sale igual. Cualquier otro error se propaga.
 * - R5: una conexión sin `mcp:write` no puede activar ni desactivar nada: `puedeActivar`/`puedeDesactivar` en false (la ruta HTTP
 *   no cambia: ahí manda el permiso de la persona).
 */
export async function sedesDeLaConfig(
  scope: McpScope,
  venueId: string,
): Promise<{
  sedes: Awaited<ReturnType<typeof estadoSedes>>['sedes'] | null
  periodoDeLasSedes: { start: string; end: string } | null
  sedesMotivo?: string
}> {
  try {
    const e = await estadoSedes({ userId: scope.staffId, venueId, soloSedes: scope.allowedVenueIds })
    const escribe = scope.scopes?.includes('mcp:write') === true
    return {
      sedes: escribe ? e.sedes : e.sedes.map(s => ({ ...s, puedeActivar: false, puedeDesactivar: false })),
      periodoDeLasSedes: e.periodo,
    }
  } catch (err) {
    const code = (err as { code?: string } | null)?.code
    if (!code || !DE_VOLUMEN.has(code)) throw err
    return { sedes: null, periodoDeLasSedes: null, sedesMotivo: `No se pudo leer el estado de las sedes: ${(err as Error).message}` }
  }
}
