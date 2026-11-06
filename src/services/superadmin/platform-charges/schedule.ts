/**
 * «Por cobrar» — fechas de calendario de CDMX (spec 2026-11-02-por-cobrar-superadmin §3.1).
 *
 * Todo es un día de calendario `'YYYY-MM-DD'` de CDMX, sin hora. La aritmética es de calendario sobre UTC y NO depende de la
 * zona del proceso: nada de `parseISO`, `new Date('YYYY-MM-DD')` ni `new Date(y, m, d)` (resuelven en la zona del servidor y
 * corren el día entero: `critical-warnings.md`, «A bare YYYY-MM-DD is a RUNTIME-TZ trap»).
 */
import type { PlatformChargeFrequency } from '@prisma/client'
import { fromZonedTime } from 'date-fns-tz'
import { formatInVenueTimezone } from '@/utils/datetime'
import type { CalendarDay } from './types'

const MS_PER_DAY = 86_400_000
const MEXICO_CITY_TZ = 'America/Mexico_City'
const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/** `'YYYY-MM-DD'` → `[año, mes (1-12), día]`. Lanza si no es un día real del calendario (un 30 de febrero, un instante, vacío). */
function parts(day: CalendarDay): [number, number, number] {
  const match = CALENDAR_DAY.exec(day)
  if (match) {
    const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])]
    // Si el día no existe, Date.UTC lo rueda al mes siguiente y la ida y vuelta ya no coincide.
    const check = new Date(Date.UTC(year, month - 1, date))
    if (check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === date) return [year, month, date]
  }
  throw new Error(`Día de calendario inválido: "${day}" (se espera AAAA-MM-DD)`)
}

const toUtcMs = (day: CalendarDay): number => {
  const [year, month, date] = parts(day)
  return Date.UTC(year, month - 1, date)
}
const fromUtcMs = (ms: number): CalendarDay => new Date(ms).toISOString().slice(0, 10)
const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/** Suma `n` días de calendario (negativo resta). UTC no tiene horario de verano: un día siempre son 24 h. */
export function addDays(day: CalendarDay, n: number): CalendarDay {
  return fromUtcMs(toUtcMs(day) + n * MS_PER_DAY)
}

/** El día de calendario de CDMX en este instante: las 23:30 de CDMX siguen siendo «hoy» aunque en UTC ya sea mañana. */
export function todayInMexico(now: Date): CalendarDay {
  return formatInVenueTimezone(now, MEXICO_CITY_TZ, 'yyyy-MM-dd')
}

/**
 * El mes de calendario de CDMX al que pertenece `day`, como instantes: `[from, to)`, de la medianoche de CDMX del día 1 a la del día 1
 * del mes siguiente. Sirve para filtrar columnas de INSTANTE (`paidAt`) por «este mes». Se arma con un texto sin desfase, que
 * `fromZonedTime` lee en CDMX sin importar la zona del proceso (nunca `new Date('YYYY-MM-DD')`).
 */
export function monthBoundsInMexico(day: CalendarDay): { from: Date; to: Date } {
  const [year, month] = parts(day)
  const midnight = (y: number, m: number): Date => fromZonedTime(`${pad(y, 4)}-${pad(m)}-01T00:00:00.000`, MEXICO_CITY_TZ)
  return month === 12
    ? { from: midnight(year, 12), to: midnight(year + 1, 1) }
    : { from: midnight(year, month), to: midnight(year, month + 1) }
}

/**
 * 🔴 No se modelan periodos: una fecha cuenta como periodo nuevo sólo si ya pasaron 3/4 del periodo desde lo último pagado u omitido.
 * Sin esto, mover a mañana una mensualidad pagada hoy la volvería a cobrar. El calendario normal nunca cae aquí: su menor distancia es
 * de 28 días (mensual) y 12 (quincenal, en febrero con ancla 31). `ponytail:` es una regla de distancia, no de periodos; si algún
 * cobro necesita otra cosa, se modela el periodo.
 */
const MIN_DAYS_AFTER_MARKED: Record<PlatformChargeFrequency, number> = {
  WEEKLY: 5,
  BIWEEKLY: 11,
  MONTHLY: 23,
  // Una sola vez: no hay periodos que cuidar (tiene una única fecha), así que nunca es «del mismo periodo». 0 lo vuelve siempre falso:
  // `day > marked && day < marked` no se cumple nunca.
  ONE_TIME: 0,
}

export function isSamePeriodAsMarked(frequency: PlatformChargeFrequency, marked: CalendarDay, day: CalendarDay): boolean {
  return day > marked && day < addDays(marked, MIN_DAYS_AFTER_MARKED[frequency])
}

/** El día como lo lee y lo escribe Prisma en una columna `@db.Date`: medianoche UTC. */
export function calendarDayToDb(day: CalendarDay): Date {
  return new Date(toUtcMs(day))
}

/** Lo inverso: Prisma entrega un `@db.Date` como medianoche UTC. */
export function dbToCalendarDay(date: Date): CalendarDay {
  return date.toISOString().slice(0, 10)
}

/**
 * Las fechas de cobro de `frequency` dentro de `[from, to]` (los dos extremos inclusivos), de la más vieja a la más nueva.
 * Nunca antes del ancla: la primera ocurrencia cae en `anchorDate`.
 *
 * - **Semanal:** `anchorDate` + 7·k días.
 * - **Mensual:** el día del ancla en cada mes; si el mes no lo tiene, su último día (31 ene, 28 feb, 31 mar). Siempre se cuenta
 *   desde el día del ANCLA, no desde la ocurrencia anterior (30 → 28 feb → 30 mar, no 28 mar).
 * - **Quincenal:** dos días fijos al mes, con el mismo tope al último día. Con D = día del ancla: D y D+15 si D ≤ 15, o D−15 y D
 *   si D > 15 (1 → 1 y 16 · 15 → 15 y 30 · 20 → 5 y 20 · 31 → 16 y 31).
 * - **Una sola vez:** no hay serie. Su única fecha es el ancla, si cae en el rango.
 *
 * El llamador acota el rango (el generador pide de max(ancla, hoy) a hoy+7): aquí se devuelven todas las fechas que caben.
 */
export function occurrenceDatesBetween(
  frequency: PlatformChargeFrequency,
  anchorDate: CalendarDay,
  from: CalendarDay,
  to: CalendarDay,
): CalendarDay[] {
  const [, , anchorDay] = parts(anchorDate)
  // Se validan los dos extremos aunque no hagan falta: un rango con un día inventado no debe contestar «ninguna» en silencio.
  parts(from)
  parts(to)

  // Una sola vez: no hay serie que recorrer, su única fecha es el ancla (comparar los textos es comparar los días, como abajo).
  if (frequency === 'ONE_TIME') return anchorDate >= from && anchorDate <= to ? [anchorDate] : []

  // Un 'YYYY-MM-DD' con ceros a la izquierda se ordena como el calendario: comparar los textos es comparar los días.
  const start = from > anchorDate ? from : anchorDate
  if (start > to) return []

  if (frequency === 'WEEKLY') {
    const weeksToStart = Math.ceil((toUtcMs(start) - toUtcMs(anchorDate)) / MS_PER_DAY / 7)
    const dates: CalendarDay[] = []
    for (let day = addDays(anchorDate, 7 * weeksToStart); day <= to; day = addDays(day, 7)) dates.push(day)
    return dates
  }

  // Mensual y quincenal: se recorre mes por mes de `start` a `to`, y cada mes aporta sus días fijos (con el tope).
  const fixedDays = frequency === 'MONTHLY' ? [anchorDay] : anchorDay <= 15 ? [anchorDay, anchorDay + 15] : [anchorDay - 15, anchorDay]
  const [startYear, startMonth] = parts(start)
  const [toYear, toMonth] = parts(to)
  const dates: CalendarDay[] = []
  for (let monthIndex = startYear * 12 + (startMonth - 1); monthIndex <= toYear * 12 + (toMonth - 1); monthIndex++) {
    const year = Math.floor(monthIndex / 12)
    const month = (monthIndex % 12) + 1
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
    for (const fixedDay of fixedDays) {
      const day = `${pad(year, 4)}-${pad(month)}-${pad(Math.min(fixedDay, lastDay))}`
      if (day >= start && day <= to) dates.push(day)
    }
  }
  return dates
}

/**
 * El próximo día de cobro de un cobro, para la columna «Próximo cobro» de la pestaña «Cobros» (las fechas se crean 7 días antes,
 * así que la lista de «Fechas de cobro» todavía no la tiene). Lo vencido sin pagar va primero: es lo que toca cobrar. Si no hay,
 * la primera fecha del calendario desde hoy que no esté ya pagada u omitida, con la MISMA regla de periodo que el generador
 * (`isSamePeriodAsMarked`): así esta columna dice la fecha que el generador va a crear. Una sola vez sin pendiente no tiene próximo.
 * El ancla vive a ±366 días de hoy: 400 días alcanzan para encontrar siempre la primera.
 */
export function nextDueDate(
  frequency: PlatformChargeFrequency,
  anchorDate: CalendarDay,
  today: CalendarDay,
  firstPending: CalendarDay | null,
  lastMarked: CalendarDay | null,
): CalendarDay | null {
  if (firstPending) return firstPending
  if (frequency === 'ONE_TIME') return null
  const dates = occurrenceDatesBetween(frequency, anchorDate, today, addDays(today, 400))
  return dates.find(day => !lastMarked || (day > lastMarked && !isSamePeriodAsMarked(frequency, lastMarked, day))) ?? null
}
