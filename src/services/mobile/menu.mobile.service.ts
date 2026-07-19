/**
 * Menús por horario para el POS ("Menús" en el panel del cheque).
 *
 * El modelo `Menu` YA existía con todo lo necesario (availableFrom/Until,
 * availableDays, startDate/endDate, isDefault y sus categorías) — sólo no
 * estaba expuesto a las apps. Esto no agrega schema: resuelve QUÉ menú aplica
 * en este momento en la zona horaria DEL VENUE y devuelve, por menú, las
 * categorías que lo componen para que el POS filtre su cuadrícula.
 *
 * La hora se evalúa en la zona del venue, no la del servidor ni la del
 * dispositivo: un iPad en otra zona debe ver el mismo menú que la cocina.
 */

import { formatInTimeZone } from 'date-fns-tz'
import prisma from '../../utils/prismaClient'
import { NotFoundError } from '../../errors/AppError'

/** Índice de day-of-week → el código que guarda `availableDays`. */
const DAY_CODES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const

/** "11:00" → 660 minutos. Devuelve null si el string no sirve. */
function toMinutes(hhmm?: string | null): number | null {
  if (!hhmm) return null
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!match) return null
  const h = Number(match[1])
  const m = Number(match[2])
  if (h > 23 || m > 59) return null
  return h * 60 + m
}

/**
 * ¿Este menú aplica en `now` (hora del venue)? Un menú sin horario ni días
 * aplica siempre — así el "Menú Principal" de toda la vida sigue funcionando.
 */
function appliesNow(
  menu: {
    availableFrom: string | null
    availableUntil: string | null
    availableDays: string[]
    startDate: Date | null
    endDate: Date | null
  },
  nowUtc: Date,
  timezone: string,
): boolean {
  if (menu.startDate && nowUtc < menu.startDate) return false
  if (menu.endDate && nowUtc > menu.endDate) return false

  const dayCode = DAY_CODES[Number(formatInTimeZone(nowUtc, timezone, 'i')) % 7]
  if (menu.availableDays.length > 0 && !menu.availableDays.includes(dayCode)) return false

  const from = toMinutes(menu.availableFrom)
  const until = toMinutes(menu.availableUntil)
  if (from === null || until === null) return true // sin horario = todo el día

  const [h, m] = formatInTimeZone(nowUtc, timezone, 'HH:mm').split(':')
  const nowMinutes = Number(h) * 60 + Number(m)

  // Una franja que cruza medianoche (22:00–02:00) es válida y común en bares.
  return from <= until ? nowMinutes >= from && nowMinutes < until : nowMinutes >= from || nowMinutes < until
}

/**
 * Menús del venue con su horario, sus categorías y cuál aplica AHORA.
 * `activeMenuId` es el que el POS debe preseleccionar.
 */
export async function listMenus(venueId: string) {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  if (!venue) throw new NotFoundError('Venue no encontrado')

  const menus = await prisma.menu.findMany({
    where: { venueId, active: true },
    include: { categories: { select: { categoryId: true, displayOrder: true }, orderBy: { displayOrder: 'asc' } } },
    orderBy: [{ isDefault: 'desc' }, { displayOrder: 'asc' }, { name: 'asc' }],
  })

  const now = new Date()
  const timezone = venue.timezone || 'America/Mexico_City'

  const data = menus.map(m => ({
    id: m.id,
    name: m.name,
    description: m.description,
    isDefault: m.isDefault,
    availableFrom: m.availableFrom,
    availableUntil: m.availableUntil,
    availableDays: m.availableDays,
    categoryIds: m.categories.map(c => c.categoryId),
    appliesNow: appliesNow(m, now, timezone),
  }))

  // El que manda ahora: el primero programado que aplica; si ninguno tiene
  // horario propio, el default. Nunca null habiendo menús, para que el POS
  // jamás se quede sin cuadrícula.
  const scheduled = data.find(m => m.appliesNow && (m.availableFrom || m.availableDays.length > 0))
  const fallback = data.find(m => m.isDefault && m.appliesNow) || data.find(m => m.appliesNow) || data[0]
  const activeMenuId = (scheduled || fallback)?.id ?? null

  return { menus: data, activeMenuId, timezone }
}
