import { Prisma } from '@prisma/client'
import { type CivilDate, venueCivilDate } from '@/utils/venueDateKeys'

/** Los formatos de los huecos de la B. Puras; las usan template() y checkRendered(). Tablas fijas: no dependen de la versión de ICU. */

const WEEKDAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb']
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
/** Miles con coma, como es-MX. */
const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')

function validDate(d: unknown): Date {
  // null daría 1970 y undefined daría «ahora» sin error: aquí sólo pasa una fecha de verdad
  if (Object.prototype.toString.call(d) !== '[object Date]' || Number.isNaN((d as Date).getTime())) {
    throw new Error('Se esperaba una fecha válida')
  }
  return d as Date
}

/** '$12,345.60'; negativo, '−$150.00' (U+2212 delante del signo de pesos); −0 es '$0.00'. Lanza sólo si no es un número. */
export function fmtMoney(v: number | string | Prisma.Decimal): string {
  const amount = new Prisma.Decimal(v)
  if (!amount.isFinite()) throw new Error('El importe no es un número')
  const fixed = amount.toFixed(2) // en decimal, redondeo a la mitad hacia afuera: nunca pasa por float
  const [int, cents] = fixed.replace('-', '').split('.')
  return `${fixed.startsWith('-') && fixed !== '-0.00' ? '−' : ''}$${group(int)}.${cents}`
}

/** Entero ≥ 0 con miles como es-MX: '1,234'. */
export function fmtCount(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('El conteo no es un entero mayor o igual a 0')
  return group(String(n))
}

const clocks = new Map<string, Intl.DateTimeFormat>()

/** 'HH:mm', 24 h, en la hora de la sucursal. */
export function fmtTime(d: Date, timezone: string): string {
  let clock = clocks.get(timezone)
  if (!clock) {
    clock = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    clocks.set(timezone, clock)
  }
  const parts = clock.formatToParts(validDate(d))
  const part = (type: 'hour' | 'minute') => Number(parts.find(p => p.type === type)?.value)
  return `${String(part('hour') % 24).padStart(2, '0')}:${String(part('minute')).padStart(2, '0')}`
}

/** 'jue 12-nov': el día de la semana del calendario real, en la sucursal. */
export function fmtShortDay(d: Date, timezone: string): string {
  const { year, month, day } = venueCivilDate(validDate(d), timezone)
  return `${WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]} ${day}-${MONTHS[month - 1]}`
}

/** Un día 'yyyy-mm-dd' ya es de la sucursal; una fecha con hora necesita su zona, porque sin ella la pondría el servidor. */
function civilDateOf(s: string, timezone: string): CivilDate {
  const bare = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (bare) {
    const [year, month, day] = bare.slice(1).map(Number)
    if (new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) !== s) throw new Error('El día no existe')
    return { year, month, day }
  }
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) throw new Error('La fecha con hora no dice su zona')
  return venueCivilDate(validDate(new Date(s)), timezone)
}

/** '16-nov-2026', en la sucursal. */
export function fmtDate(d: Date | string, timezone: string): string {
  const { year, month, day } = typeof d === 'string' ? civilDateOf(d, timezone) : venueCivilDate(validDate(d), timezone)
  return `${day}-${MONTHS[month - 1]}-${year}`
}
