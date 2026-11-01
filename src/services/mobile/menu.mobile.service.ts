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
import logger from '../../config/logger'
import { NotFoundError } from '../../errors/AppError'
import { conDescendientes } from '../menus/categoryTree'

/** Índice de day-of-week → el código que guarda `availableDays`. */
const DAY_CODES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const

/** "11:00" → 660 minutos. Devuelve null si el string no sirve. */
export function toMinutes(hhmm?: string | null): number | null {
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
 *
 * Una franja que cruza medianoche (22:00–02:00) pertenece al día en que EMPIEZA:
 * la parte de después de medianoche se evalúa contra el día anterior en
 * `availableDays` (el viernes 22:00–02:00 sigue el sábado a la 01:00 y no
 * aplica el viernes a la 01:00). Lo usan el POS y la tienda en línea.
 */
export function appliesNow(
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

  const from = toMinutes(menu.availableFrom)
  const until = toMinutes(menu.availableUntil)
  const [h, m] = formatInTimeZone(nowUtc, timezone, 'HH:mm').split(':')
  const nowMinutes = Number(h) * 60 + Number(m)

  // Una franja que cruza medianoche (22:00–02:00) es válida y común en bares; su madrugada es del día anterior.
  const afterMidnightOfYesterday = from !== null && until !== null && from > until && nowMinutes < until
  const todayIdx = Number(formatInTimeZone(nowUtc, timezone, 'i')) % 7
  const dayCode = DAY_CODES[afterMidnightOfYesterday ? (todayIdx + 6) % 7 : todayIdx]
  if (menu.availableDays.length > 0 && !menu.availableDays.includes(dayCode)) return false

  if (from === null || until === null) return true // sin horario = todo el día
  return from <= until ? nowMinutes >= from && nowMinutes < until : nowMinutes >= from || nowMinutes < until
}

/** Con más categorías activas que éstas no se arma el árbol: cada menú se queda con las suyas directas y se avisa. */
const MAX_CATEGORIAS_PARA_SUBCATEGORIAS = 2000

/**
 * Las categorías activas del negocio (sólo su id y de quién cuelgan) para sumarle a cada menú las subcategorías de las suyas.
 * Se leen con 1 de más sobre el tope, para saber si sobró alguna.
 *
 * Esta función va ARRIBA de `listMenus` a propósito. El candado de `findMany` sin tope
 * (tests/unit/architecture/findManySinTopeGuard.test.ts) busca el `take` en los 1200 caracteres que siguen a cada lectura: si este
 * quedara debajo de la lectura de menús (que sigue sin tope), el candado la daría por acotada y pediría bajar su cupo en el inventario.
 */
function leerCategoriasActivas(venueId: string) {
  return prisma.menuCategory.findMany({
    where: { venueId, active: true },
    select: { id: true, parentId: true },
    orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
    take: MAX_CATEGORIAS_PARA_SUBCATEGORIAS + 1,
  })
}

/**
 * Menús del venue con su horario, sus categorías y cuál aplica AHORA.
 * `activeMenuId` es el que el POS debe preseleccionar.
 *
 * Sólo los menús marcados «Aparatos» (`appliesToDevices`): uno de «Sólo tienda en línea» no se ofrece en Mesas. El `categoryIds`
 * de cada menú trae sus categorías directas y, después, las subcategorías ACTIVAS de ellas a cualquier profundidad: antes un padre
 * sin productos con una hija vendible dejaba la cuadrícula vacía. La forma de la respuesta no cambia, así que las apps viejas
 * también ganan.
 */
export async function listMenus(venueId: string) {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  if (!venue) throw new NotFoundError('Venue no encontrado')

  const [menus, categorias] = await Promise.all([
    prisma.menu.findMany({
      where: { venueId, active: true, appliesToDevices: true },
      include: { categories: { select: { categoryId: true, displayOrder: true }, orderBy: { displayOrder: 'asc' } } },
      orderBy: [{ isDefault: 'desc' }, { displayOrder: 'asc' }, { name: 'asc' }],
    }),
    leerCategoriasActivas(venueId),
  ])

  const now = new Date()
  const timezone = venue.timezone || 'America/Mexico_City'

  // Pasado el tope no se arma el árbol: cada menú se queda con sus categorías directas, como antes de las subcategorías.
  const sumarSubcategorias = categorias.length <= MAX_CATEGORIAS_PARA_SUBCATEGORIAS
  if (!sumarSubcategorias) {
    logger.warn('[MobileMenus] demasiadas categorías activas: Mesas recibe sólo las categorías directas de cada menú', {
      venueId,
      tope: MAX_CATEGORIAS_PARA_SUBCATEGORIAS,
    })
  }

  const data = menus.map(m => {
    const directas = m.categories.map(c => c.categoryId)
    return {
      id: m.id,
      name: m.name,
      description: m.description,
      isDefault: m.isDefault,
      availableFrom: m.availableFrom,
      availableUntil: m.availableUntil,
      availableDays: m.availableDays,
      // Las directas van primero y en su orden, aunque una esté apagada (es lo que se asignó, como siempre); sólo lo que se SUMA
      // sale de las activas.
      categoryIds: sumarSubcategorias ? [...new Set([...directas, ...conDescendientes(directas, categorias)])] : directas,
      appliesNow: appliesNow(m, now, timezone),
    }
  })

  // El que manda ahora: el primero programado que aplica; si ninguno tiene
  // horario propio, el default. Nunca null habiendo menús, para que el POS
  // jamás se quede sin cuadrícula.
  const scheduled = data.find(m => m.appliesNow && (m.availableFrom || m.availableDays.length > 0))
  const fallback = data.find(m => m.isDefault && m.appliesNow) || data.find(m => m.appliesNow) || data[0]
  const activeMenuId = (scheduled || fallback)?.id ?? null

  return { menus: data, activeMenuId, timezone }
}
