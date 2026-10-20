import { formatInTimeZone } from 'date-fns-tz'
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
