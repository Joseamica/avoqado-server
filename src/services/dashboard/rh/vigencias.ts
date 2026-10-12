import { BadRequestError } from '../../../errors/AppError'
import { venueDayKey } from '../../../utils/venueDateKeys'
import { fechaComoDbDate, sumarDias } from '../staffPay/periodos'

/** Fecha civil de la sede, `AAAA-MM-DD`. Spec RH §3.2 y §7. */
export type Fecha = string
export interface Vigencia {
  desde: Fecha
  hasta: Fecha | null
}

const FIN_ABIERTO = '9999-12-31'

/** Ambos extremos inclusivos: una vigencia de un día (desde = hasta) es válida. */
export function seTraslapan(a: Vigencia, b: Vigencia): boolean {
  return a.desde <= (b.hasta ?? FIN_ABIERTO) && b.desde <= (a.hasta ?? FIN_ABIERTO)
}

/** Lanza `BadRequestError('Fecha inválida')` si `f` no es una fecha real del calendario (sumarDias la valida). */
export function diaAnterior(f: Fecha): Fecha {
  return sumarDias(f, -1)
}

export function hoyDeLaSede(timezone: string, ahora: Date = new Date()): Fecha {
  return venueDayKey(ahora, timezone)
}

/** Fase 1: sólo hoy o pasado. Los periodos cerrados los revisa el servicio con `assertFechaNoCerrada` (staffPay). */
export function validarFechaDeCambio(fecha: Fecha, hoy: Fecha): void {
  fechaComoDbDate(fecha) // valida formato Y que exista en el calendario (2026-02-31 no); lanza 'Fecha inválida'
  if (fecha > hoy) throw new BadRequestError('No se permiten fechas futuras. Usa la fecha de hoy o una anterior.')
}
