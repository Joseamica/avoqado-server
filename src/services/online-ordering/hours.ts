import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'
import type { HorarioSemanal } from '@/services/delivery-channels/core/deliveryHours.service'
import { toMinutes } from '@/services/mobile/menu.mobile.service'

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const

/** «HH:MM» de 00:00 a 23:59, con dos dígitos. El MISMO patrón usa el Zod de ajustes (tarea 13). */
export const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/
export const MAX_RANGES_PER_DAY = 4

/**
 * H5 (r2): la ÚNICA validación del horario de PEDIDOS; la usan la precarga (tarea 4) y el Zod de ajustes (tarea 13).
 * Como `esHorarioValido` de reparto, pero el cierre PUEDE ser menor que la apertura: 22:00–02:00 sigue abierto en la
 * madrugada del día siguiente (igual que `isWithinHours`). El contrato de reparto no se toca.
 */
export function isValidOrderingHours(v: unknown): v is HorarioSemanal {
  if (!v || typeof v !== 'object') return false
  const semana = v as Record<string, { enabled?: unknown; ranges?: unknown } | undefined>
  return DAY_KEYS.every(dia => {
    const d = semana[dia]
    if (!d || typeof d.enabled !== 'boolean' || !Array.isArray(d.ranges) || d.ranges.length > MAX_RANGES_PER_DAY) return false
    // Un día abierto sin franjas abriría «de nunca a nunca»: se rechaza el horario entero (misma regla que reparto).
    if (d.enabled && d.ranges.length === 0) return false
    return (d.ranges as Array<{ open?: unknown; close?: unknown } | null>).every(
      r =>
        typeof r?.open === 'string' &&
        typeof r?.close === 'string' &&
        HHMM_PATTERN.test(r.open) &&
        HHMM_PATTERN.test(r.close) &&
        r.open !== r.close, // una franja de largo cero no abre nunca
    )
  })
}

/**
 * ¿`now` cae dentro del horario semanal, en la hora de pared del venue? `null` = sin restricción.
 * La franja que cruza la medianoche (20:00–02:00) sigue vigente en la madrugada del día siguiente.
 */
export function isWithinHours(hours: HorarioSemanal | null | undefined, now: Date, timezone: string): boolean {
  if (!hours) return true
  const todayIdx = Number(formatInTimeZone(now, timezone, 'i')) % 7 // 'i': 1 = lunes … 7 = domingo → 0 = domingo
  const yesterdayIdx = (todayIdx + 6) % 7
  const [h, m] = formatInTimeZone(now, timezone, 'HH:mm').split(':').map(Number)
  const nowMin = h * 60 + m

  const today = hours[DAY_KEYS[todayIdx]]
  if (today?.enabled) {
    for (const r of today.ranges ?? []) {
      const open = toMinutes(r.open)
      const close = toMinutes(r.close)
      if (open === null || close === null) continue
      if (open <= close ? nowMin >= open && nowMin < close : nowMin >= open) return true
    }
  }

  const yesterday = hours[DAY_KEYS[yesterdayIdx]]
  if (yesterday?.enabled) {
    for (const r of yesterday.ranges ?? []) {
      const open = toMinutes(r.open)
      const close = toMinutes(r.close)
      if (open === null || close === null) continue
      if (open > close && nowMin < close) return true
    }
  }
  return false
}

/**
 * T4: ¿a qué hora cierra la franja vigente? `null` si no hay horario o `now` está fuera de horario.
 * R32: junta las franjas contiguas (09–13 + 13–17 ⇒ cierra 17:00; martes 20–00 + miércoles 00–02 ⇒ 02:00).
 * Trabaja en minutos desde la medianoche local de hoy (ayer = −1440, mañana = +1440).
 */
export function closesAt(hours: HorarioSemanal | null | undefined, now: Date, timezone: string): Date | null {
  if (!hours) return null
  const todayIdx = Number(formatInTimeZone(now, timezone, 'i')) % 7
  const [h, m] = formatInTimeZone(now, timezone, 'HH:mm').split(':').map(Number)
  const nowMin = h * 60 + m

  const spans: Array<[number, number]> = []
  for (const offset of [-1, 0, 1]) {
    const day = hours[DAY_KEYS[(todayIdx + 7 + offset) % 7]]
    if (!day?.enabled) continue
    for (const r of day.ranges ?? []) {
      const open = toMinutes(r.open)
      const close = toMinutes(r.close)
      if (open === null || close === null || open === close) continue
      spans.push([offset * 1440 + open, offset * 1440 + (open < close ? close : close + 1440)])
    }
  }
  spans.sort((a, b) => a[0] - b[0])

  let end: number | null = null
  for (const [open, close] of spans) {
    if (end === null) {
      if (open <= nowMin && nowMin < close) end = close
    } else if (open <= end) end = Math.max(end, close)
    else break
  }
  if (end === null) return null

  // Hora de pared del venue (respeta el DST): fecha local de hoy + días que se pasó + hh:mm.
  const dayShift = Math.floor(end / 1440)
  const endMin = end - dayShift * 1440
  const date = new Date(`${formatInTimeZone(now, timezone, 'yyyy-MM-dd')}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + dayShift)
  const hh = String(Math.floor(endMin / 60)).padStart(2, '0')
  const mm = String(endMin % 60).padStart(2, '0')
  return fromZonedTime(`${date.toISOString().slice(0, 10)}T${hh}:${mm}:00`, timezone)
}
