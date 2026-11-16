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

/** Forma válida para el esquema: un Date válido o un texto que `fechaHoraDelNegocio` entiende. */
export function esFechaHoraValida(raw: unknown): boolean {
  if (raw instanceof Date) return !Number.isNaN(raw.getTime())
  if (typeof raw !== 'string' || raw.trim() === '') return false
  // La zona no cambia si el texto es una fecha real; UTC basta para validarlo.
  return !Number.isNaN(fechaHoraDelNegocio(raw, 'UTC').getTime())
}
