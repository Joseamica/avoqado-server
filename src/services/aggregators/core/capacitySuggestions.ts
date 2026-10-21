import { formatInTimeZone } from 'date-fns-tz'
import prisma from '@/utils/prismaClient'

/**
 * Sugerencias de lugares para pases (decisión del founder 2-oct: «sugerencias desde el inicio»). Mira cuánto se
 * llena cada día+hora con CLIENTES PROPIOS (sin pases) en las últimas 8 semanas. Con < 3 semanas no sugiere.
 */
export type SlotHistory = { localWeekday: number; localStartMinute: number; capacity: number; ownOccupied: number; weekKey: string }
export type PassSuggestion = {
  localWeekday: number
  localStartMinute: number
  suggestedMaxSpots: number
  weeksOfData: number
  p75Occupancy: number
  capacity: number
}

const MARGIN = 1
export const SUGGESTION_WEEKS = 8
const MAX_SESSIONS_READ = 2000

function p75(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.ceil(0.75 * sorted.length) - 1
  return sorted[Math.max(0, idx)]
}

export function suggestPassCaps(history: SlotHistory[], minWeeks = 3): PassSuggestion[] {
  const groups = new Map<string, Map<string, SlotHistory>>()
  for (const h of history) {
    const key = `${h.localWeekday}:${h.localStartMinute}`
    const byWeek = groups.get(key) ?? new Map<string, SlotHistory>()
    const prev = byWeek.get(h.weekKey)
    // Dos sesiones iguales en la misma semana: se toma la más llena (conservador).
    if (!prev || h.ownOccupied > prev.ownOccupied) byWeek.set(h.weekKey, h)
    groups.set(key, byWeek)
  }
  const out: PassSuggestion[] = []
  for (const [key, byWeek] of groups) {
    if (byWeek.size < minWeeks) continue
    const rows = [...byWeek.values()]
    const capacity = Math.max(...rows.map(r => r.capacity))
    const occ = p75(rows.map(r => r.ownOccupied))
    const [wd, sm] = key.split(':').map(Number)
    out.push({
      localWeekday: wd,
      localStartMinute: sm,
      capacity,
      p75Occupancy: occ,
      weeksOfData: byWeek.size,
      suggestedMaxSpots: Math.max(0, capacity - occ - MARGIN),
    })
  }
  return out.sort((a, b) => a.localWeekday - b.localWeekday || a.localStartMinute - b.localStartMinute)
}

export async function loadPassSuggestions(venueId: string, now: Date): Promise<PassSuggestion[]> {
  const venue = await prisma.venue.findUniqueOrThrow({ where: { id: venueId }, select: { timezone: true } })
  const tz = venue.timezone || 'America/Mexico_City'
  const since = new Date(now.getTime() - SUGGESTION_WEEKS * 7 * 24 * 3600 * 1000)
  const sessions = await prisma.classSession.findMany({
    where: { venueId, startsAt: { gte: since, lt: now }, status: { in: ['SCHEDULED', 'COMPLETED'] } },
    select: {
      id: true,
      startsAt: true,
      capacity: true,
      reservations: {
        where: { status: { in: ['CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'NO_SHOW'] }, aggregatorBooking: { is: null } },
        select: { partySize: true },
        take: 500,
      },
    },
    orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    take: MAX_SESSIONS_READ,
  })
  const history: SlotHistory[] = sessions.map(s => {
    const [h, m] = formatInTimeZone(s.startsAt, tz, 'HH:mm').split(':').map(Number)
    return {
      localWeekday: Number(formatInTimeZone(s.startsAt, tz, 'i')) % 7, // ISO 1=lunes … 7=domingo ⇒ 0=domingo
      localStartMinute: h * 60 + m,
      capacity: s.capacity,
      ownOccupied: s.reservations.reduce((acc, r) => acc + r.partySize, 0),
      weekKey: formatInTimeZone(s.startsAt, tz, "RRRR-'W'II"),
    }
  })
  return suggestPassCaps(history)
}
