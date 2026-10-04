import { fromZonedTime } from 'date-fns-tz'
import { BadRequestError } from '../../../errors/AppError'
import { venueDayKey } from '../../../utils/venueDateKeys'

export type Periodicidad = 'MONTHLY' | 'SEMIMONTHLY'
export interface PeriodoCanonico {
  start: string
  end: string
}

export const MESES_LARGOS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
]

const pad = (n: number) => String(n).padStart(2, '0')
const ultimoDia = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()

function partes(fecha: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha)
  if (!m) throw new BadRequestError('Fecha inválida')
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (mo < 1 || mo > 12 || d < 1 || d > ultimoDia(y, mo)) throw new BadRequestError('Fecha inválida')
  return [y, mo, d]
}

export function periodoQueContiene(fecha: string, periodicidad: Periodicidad): PeriodoCanonico {
  const [y, mo, d] = partes(fecha)
  const base = `${y}-${pad(mo)}`
  const fin = `${base}-${pad(ultimoDia(y, mo))}`
  if (periodicidad === 'MONTHLY') return { start: `${base}-01`, end: fin }
  return d <= 15 ? { start: `${base}-01`, end: `${base}-15` } : { start: `${base}-16`, end: fin }
}

export function diaCivilSiguiente(fecha: string): string {
  const [y, mo, d] = partes(fecha)
  const t = new Date(Date.UTC(y, mo - 1, d + 1))
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

export function venuePeriodRange(p: PeriodoCanonico, tz: string): { from: Date; to: Date } {
  return {
    from: fromZonedTime(`${p.start}T00:00:00.000`, tz),
    to: fromZonedTime(`${diaCivilSiguiente(p.end)}T00:00:00.000`, tz),
  }
}

/** Una fecha local (YYYY-MM-DD) como valor para columnas @db.Date. */
export function fechaComoDbDate(fecha: string): Date {
  partes(fecha)
  return new Date(`${fecha}T00:00:00.000Z`)
}

export function dbDateComoFecha(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function hoyLocal(tz: string, ahora: Date = new Date()): string {
  return venueDayKey(ahora, tz)
}
