import { formatInTimeZone } from 'date-fns-tz'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import prisma from '@/utils/prismaClient'

/** Código estable cuando un venue sin ADVANCED_REPORTS pide más que «hoy» del resumen de ventas. */
export const PLAN_LIMIT_RANGE_CODE = 'PLAN_LIMIT_RANGE'

export const RESPUESTA_RANGO_FUERA_DEL_PLAN = {
  error: 'Plan limit',
  message: 'El histórico de ventas requiere el plan Pro. El plan Gratis incluye el resumen de ventas de hoy.',
  code: PLAN_LIMIT_RANGE_CODE,
  featureCode: 'ADVANCED_REPORTS',
  subscriptionRequired: true,
} as const

/**
 * true ⇒ el plan del venue no le deja ese rango (sólo «hoy» en su zona). Fechas inválidas ⇒ false: las rechaza quien valida (400).
 * La usan el middleware del GET viejo y el exportador de ventas detalladas: el mismo candado en los dos caminos.
 */
export async function rangoBloqueadoPorPlan(venueId: string, startDate: string, endDate: string): Promise<boolean> {
  if (await venueHasFeatureAccess(venueId, 'ADVANCED_REPORTS')) return false
  const start = new Date(startDate)
  const end = new Date(endDate)
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return false
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  const timezone = venue?.timezone || 'America/Mexico_City'
  const hoy = formatInTimeZone(new Date(), timezone, 'yyyy-MM-dd')
  return !(formatInTimeZone(start, timezone, 'yyyy-MM-dd') === hoy && formatInTimeZone(end, timezone, 'yyyy-MM-dd') === hoy)
}
