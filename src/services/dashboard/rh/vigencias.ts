import { BadRequestError } from '../../../errors/AppError'
import { venueDayKey } from '../../../utils/venueDateKeys'

/** Fecha civil de la sede, `AAAA-MM-DD`. Spec RH §3.2 y §7. */
export type Fecha = string
export interface Vigencia {
  desde: Fecha
  hasta: Fecha | null
}

const FIN_ABIERTO = '9999-12-31'
const FORMATO = /^\d{4}-\d{2}-\d{2}$/

/** Ambos extremos inclusivos: una vigencia de un día (desde = hasta) es válida. */
export function seTraslapan(a: Vigencia, b: Vigencia): boolean {
  return a.desde <= (b.hasta ?? FIN_ABIERTO) && b.desde <= (a.hasta ?? FIN_ABIERTO)
}

export function diaAnterior(f: Fecha): Fecha {
  const d = new Date(`${f}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

export function hoyDeLaSede(timezone: string, ahora: Date = new Date()): Fecha {
  return venueDayKey(ahora, timezone)
}

/** Fase 1: sólo hoy o pasado. Los periodos cerrados los revisa el servicio con `assertFechaNoCerrada` (staffPay). */
export function validarFechaDeCambio(fecha: Fecha, hoy: Fecha): void {
  if (!FORMATO.test(fecha)) throw new BadRequestError('Fecha inválida (AAAA-MM-DD)')
  if (fecha > hoy) throw new BadRequestError('No se permiten fechas futuras. Usa la fecha de hoy o una anterior.')
}
