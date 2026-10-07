// src/mcp/tools/staffPay.sedes.ts — B13 en el MCP de pago al personal (fase 3; diseño r5.1, r3.7(1); revisión de B12 #7): lo que la
// vista previa del cierre y la del ajuste ya devolvían crudo (por sede, devoluciones pendientes, el aviso) dicho en palabras del
// dueño, y TODO eso acotado a las sedes del alcance de la CONEXIÓN además del permiso del usuario. Pesos 1:1; fechas civiles.
import { Prisma } from '@prisma/client'
import type { Cuenta } from '@/services/dashboard/staffPay/participacion.vistaPrevia'
import type { Destino, DevolucionesPendientes } from '@/services/dashboard/staffPay/devolucionesPendientes'
import type { EstadoSede } from '@/services/dashboard/staffPay/estadoSede'

const pesos = (s: string) => Number(s).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
/** «−$50.00» (con el signo de menos) o «$50.00». Sólo para mostrar: las sumas van con `Prisma.Decimal`. */
const conSigno = (s: string) => `${Number(s) < 0 ? '−' : ''}$${pesos(String(Math.abs(Number(s))))}`
const lista = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`)

/** `YYYY-MM-DD` (fecha local) como fecha UTC: sólo para darle formato, nunca como instante. */
const diaUTC = (f: string) => {
  const [y, m, d] = f.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}
export const diaLegible = (f: string) =>
  diaUTC(f).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
/** «de septiembre de 2026» si es el mes completo; si no, «del 1 sep 2026 al 15 sep 2026». */
export const periodoLegible = (p: { start: string; end: string }) =>
  p.start.endsWith('-01') &&
  p.start.slice(0, 7) === p.end.slice(0, 7) &&
  diaUTC(p.end).getUTCMonth() !== new Date(diaUTC(p.end).getTime() + 86_400_000).getUTCMonth()
    ? `de ${diaUTC(p.start).toLocaleDateString('es-MX', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`
    : `del ${diaLegible(p.start)} al ${diaLegible(p.end)}`

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
  ...(c.clases.n ? [`${c.clases.n} clase(s) ($${pesos(c.clases.total)})`] : []),
  ...(c.comisiones.n ? [`${c.comisiones.n} comisión(es) ($${pesos(c.comisiones.total)})`] : []),
  ...(c.propinas.n ? [`${c.propinas.n} propina(s) ($${pesos(c.propinas.total)})`] : []),
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
 * octubre de 2026. Si este ajuste es por eso, no lo registres.» Con varios destinos los nombra. Vacío sin pendientes.
 */
export function avisoDePendientes(persona: string, a: Pendientes | undefined): string {
  if (!a?.n || !a.porDestino.length) return ''
  const cuando =
    a.porDestino.length === 1
      ? ` ${destinoLegible(a.porDestino[0].seDescuenta)}`
      : `: ${lista(a.porDestino.map(d => `${conSigno(d.total)} ${destinoLegible(d.seDescuenta)}`))}`
  return ` ${persona} tiene ${conSigno(a.total)} en devoluciones que se descontarán solas${cuando}. Si este ajuste es por eso, no lo registres.`
}
