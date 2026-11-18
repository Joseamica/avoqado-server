import { fromZonedTime } from 'date-fns-tz'

/**
 * Hora que llega de un cliente → instante real (UTC), sin depender de la zona del proceso.
 *
 * - Con `Z` o un desfase (`-06:00`, `+0000`): ya es un instante; se respeta tal cual.
 *   Así mandan ANDROID e iOS.
 * - Sin zona (`2026-11-12T15:00`, lo que da un `<input type="datetime-local">`): es la hora
 *   que la persona vio en el reloj del NEGOCIO, y se lee en `timezone`.
 *
 * Antes se usaba `new Date(raw)`, que lee la hora sin zona en la zona del proceso: en Render
 * no hay `TZ`, así que las 15:00 de un negocio en CDMX quedaban como 09:00 (encargo e781ce).
 */
const SIN_ZONA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/

/** `true` si es un texto de hora del negocio sin zona (`2026-11-12T15:00`). */
export function esHoraSinZona(raw: unknown): boolean {
  return typeof raw === 'string' && SIN_ZONA.test(raw.trim())
}

export function fechaHoraDelNegocio(raw: string | Date, timezone: string): Date {
  if (raw instanceof Date) return raw
  const texto = raw.trim()
  if (SIN_ZONA.test(texto)) return fromZonedTime(texto, timezone)
  return new Date(texto)
}

/**
 * `true` si es un texto SIN zona cuya hora no existe en `timezone` porque el reloj se la salta (cambio de horario de
 * primavera: en Tijuana, el 14-mar-2027 de 02:00 brinca a 03:00). Convertirla daría otra hora (01:30 o 03:30) sin que nadie
 * lo pidiera (tarjeta naa485b3). Se compara la hora de vuelta en la zona con la escrita. La hora que pasa DOS veces
 * (otoño) sí existe: se toma una y no se rechaza. Una hora con `Z`, con desfase o un `Date` ya es un instante: nunca.
 *
 * No usa date-fns-tz: arma la fecha con la zona del PROCESO y su `getTimezoneOffset` se equivoca junto al salto (medido:
 * −7 h a las 01:59 de Tijuana, que todavía es −8 h). Aquí todo se mide con `Intl` en la zona pedida.
 */
export function horaQueNoExiste(raw: string | Date, timezone: string): boolean {
  if (typeof raw !== 'string') return false
  const texto = raw.trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(texto)
  if (!m || !SIN_ZONA.test(texto)) return false
  // «24:00» y otras horas fuera del reloj las sigue resolviendo la conversión de siempre (Codex r4 #1).
  if (+m[4] > 23 || +m[5] > 59 || +(m[6] ?? 0) > 59) return false
  // Hasta el segundo: hay zonas viejas con desfase de segundos (Asia/Colombo en 1906, Codex r2 #8).
  const comoUtc = utc(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] ?? 0))
  if (Number.isNaN(comoUtc)) return false
  // Una fecha que no existe en el calendario (día 32, 30 de febrero) no es «hora del cambio de horario»: la decide el
  // esquema como siempre (Codex r5).
  const d = new Date(comoUtc)
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return false
  try {
    // Desfase de la zona en el instante tentativo y, si cambia ahí, en el corregido.
    const primero = relojDeLaZonaComoUtc(comoUtc, timezone) - comoUtc
    let instante = comoUtc - primero
    const segundo = relojDeLaZonaComoUtc(instante, timezone) - instante
    if (segundo !== primero) instante = comoUtc - segundo
    return relojDeLaZonaComoUtc(instante, timezone) !== comoUtc
  } catch {
    return false // zona desconocida: no es «hora inexistente»; la conversión de siempre decide
  }
}

/** La hora del reloj de `timezone` en el instante `ms`, escrita como si fuera UTC (al segundo). */
function relojDeLaZonaComoUtc(ms: number, timezone: string): number {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    era: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    calendar: 'gregory',
  }).formatToParts(new Date(Math.floor(ms / 1000) * 1000))
  const v = (tipo: string) => Number(partes.find(p => p.type === tipo)?.value)
  // El año 0 Intl lo escribe «1 a. C.»: con la era se vuelve al año astronómico.
  const anio = partes.find(p => p.type === 'era')?.value === 'BC' ? 1 - v('year') : v('year')
  return utc(anio, v('month'), v('day'), v('hour'), v('minute'), v('second'))
}

/** `Date.UTC` sin su trampa: lee los años 0–99 como 1900–1999 (Codex r5); aquí el año es el que se escribió. */
function utc(anio: number, mes: number, dia: number, hora: number, minuto: number, segundo: number): number {
  const d = new Date(0)
  d.setUTCFullYear(anio, mes - 1, dia)
  d.setUTCHours(hora, minuto, segundo, 0)
  return d.getTime()
}

/** Forma válida para el esquema: un Date válido o un texto que `fechaHoraDelNegocio` entiende. */
export function esFechaHoraValida(raw: unknown): boolean {
  if (raw instanceof Date) return !Number.isNaN(raw.getTime())
  if (typeof raw !== 'string' || raw.trim() === '') return false
  // La zona no cambia si el texto es una fecha real; UTC basta para validarlo.
  return !Number.isNaN(fechaHoraDelNegocio(raw, 'UTC').getTime())
}
