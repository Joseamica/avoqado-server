/**
 * Llaves de fecha en la zona horaria del venue — mes, día y semana ISO 8601.
 *
 * 🔴 POR QUÉ EXISTE ESTE MÓDULO (incidente 2026-08-04, dos bugs de un solo golpe):
 *
 * 1. COSTO. El patrón anterior era `new Date(d.toLocaleString('en-US', { timeZone }))`
 *    POR CADA FILA: construía un formateador ICU nuevo, formateaba a texto y volvía a
 *    parsear el texto. Con 5,446 ventas y dos llamadas por fila son ~10,900 conversiones
 *    por petición, medidas en 1,814 ms en una Mac (y ~13.5 s en el servidor de prod). Node
 *    corre en un solo hilo, así que ese tiempo dejaba al servidor entero sin atender a
 *    nadie: `/dashboard/auth/status` llegó a tardar 33.7 s. Aquí el formateador se cachea
 *    por zona y se leen las PARTES numéricas — sin texto intermedio.
 *
 * 2. CORRECCIÓN. Aquel patrón construía el Date en la zona del PROCESO y luego leía sus
 *    componentes con `getUTC*`. El epoch se recorría según el `TZ` del host, así que dev y
 *    prod daban semanas distintas para la misma venta. Medido hora por hora: bajo `TZ=UTC`
 *    (producción) 2027 divergía del ISO real en 8,320 de 8,760 horas; bajo
 *    `TZ=America/Mexico_City`, 2026 ya divergía en 312. Aquí toda la aritmética ocurre
 *    sobre la FECHA CIVIL (sin hora), en UTC puro, así que el resultado no depende del host.
 *    Misma familia que el bug de dinero del estado de resultados (`c41b03d6`, `a8aa70a0`)
 *    documentado en `.claude/rules/critical-warnings.md`.
 *
 * Estas llaves DEBEN coincidir carácter por carácter con lo que emite Postgres en
 * `src/services/dashboard/sale-verification.org.sql.ts`:
 *   mes    → to_char(..., 'YYYY-MM')
 *   día    → to_char(..., 'YYYY-MM-DD')
 *   semana → to_char(..., 'IYYY-"W"IW')
 *   etiqueta de semana → to_char(..., '"W"IW')
 */

const MS_PER_DAY = 86_400_000
const MS_PER_WEEK = 604_800_000

/** Un formateador por zona, construido una sola vez. Reconstruirlo por fila es el bug #1. */
const formatterCache = new Map<string, Intl.DateTimeFormat>()

function civilFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    formatterCache.set(timezone, formatter)
  }
  return formatter
}

export interface CivilDate {
  year: number
  /** 1-12 */
  month: number
  /** 1-31 */
  day: number
}

/**
 * La fecha de calendario que se ve en el venue en ese instante.
 *
 * Sin hora a propósito: la hora del día es justo lo que rompía la semana ISO en la
 * implementación anterior (dejaba un residuo fraccionario que corría la semana).
 */
export function venueCivilDate(date: Date, timezone: string): CivilDate {
  let year = 0
  let month = 0
  let day = 0
  for (const part of civilFormatter(timezone).formatToParts(date)) {
    if (part.type === 'year') year = Number(part.value)
    else if (part.type === 'month') month = Number(part.value)
    else if (part.type === 'day') day = Number(part.value)
  }
  return { year, month, day }
}

/** "YYYY-MM" — igual a to_char(..., 'YYYY-MM'). */
export function venueMonthKey(date: Date, timezone: string): string {
  const { year, month } = venueCivilDate(date, timezone)
  return `${year}-${String(month).padStart(2, '0')}`
}

/** "YYYY-MM-DD" — igual a to_char(..., 'YYYY-MM-DD'). */
export function venueDayKey(date: Date, timezone: string): string {
  const { year, month, day } = venueCivilDate(date, timezone)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * Semana ISO 8601: la semana 1 es la que contiene el primer jueves del año, y las semanas
 * empiezan en lunes. El año ISO puede diferir del calendario en los bordes — el 3 de enero
 * de 2027 pertenece a 2026-W53, y el 1 de enero de 2028 a 2027-W52.
 *
 * Se trabaja sobre la fecha civil a medianoche UTC: sin hora local no hay residuo
 * fraccionario, que era exactamente el defecto del código anterior.
 */
export function venueIsoWeek(date: Date, timezone: string): { isoYear: number; week: number } {
  const { year, month, day } = venueCivilDate(date, timezone)
  const civilUtc = Date.UTC(year, month - 1, day)
  const dayOfWeek = new Date(civilUtc).getUTCDay() || 7 // domingo 0 → 7
  const thursdayOfThisWeek = civilUtc + (4 - dayOfWeek) * MS_PER_DAY
  const isoYear = new Date(thursdayOfThisWeek).getUTCFullYear()
  const week = Math.floor((thursdayOfThisWeek - Date.UTC(isoYear, 0, 1)) / MS_PER_WEEK) + 1
  return { isoYear, week }
}

/** "Wxx" — sin año. Sólo para gráficas de un rango corto donde el año se sobreentiende. */
export function venueWeekLabel(date: Date, timezone: string): string {
  return `W${String(venueIsoWeek(date, timezone).week).padStart(2, '0')}`
}

/** "YYYY-Www" — ordenable entre años porque usa el año ISO. */
export function venueIsoWeekKey(date: Date, timezone: string): string {
  const { isoYear, week } = venueIsoWeek(date, timezone)
  return `${isoYear}-W${String(week).padStart(2, '0')}`
}
