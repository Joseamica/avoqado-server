import { Prisma, ReservationStatus } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'
import prisma from '@/utils/prismaClient'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import { withSerializableRetry } from '@/utils/serializableRetry'
import { logAction } from '@/services/dashboard/activity-log.service'
import { CapacityRuleInput, resolvePassCap } from './core/capacityRules'
import { loadPassSuggestions } from './core/capacitySuggestions'
import { enqueuePassSessionSync } from './core/sessionSync.service'
import { enqueueHorizonSessionsSync } from './passSessionSync'

/**
 * Lugares para pases (spec §6): regla general del venue, excepciones por día+hora y cupo de UNA sesión. Un solo tope
 * compartido por todos los proveedores. No hay índice único que impida dos reglas iguales: lo garantiza SERIALIZABLE.
 */
export const MAX_PASS_SPOTS = 500
/**
 * R45: tope de excepciones semanales por venue. Con 150 WEEKLY + 1 DEFAULT + 1 SESSION, las reglas de una sesión caben en
 * el `take` más chico de quien las lee (200 en el worker y en la aceptación), así que los tres resuelven igual.
 */
export const MAX_WEEKLY_PASS_RULES = 150
const RULES_TAKE = 500
const LINKED_PRODUCTS_TAKE = 200
/** Una liga por proveedor y producto (`@@unique([connectionId, productId])`, una conexión por proveedor). */
const LINKS_PER_PRODUCT_TAKE = 5

export type WeeklyRuleView = { id: string; weekday: number; startMinute: number | null; maxSpots: number }
export type PassCapacityView = {
  defaultMaxSpots: number | null
  weekly: WeeklyRuleView[]
  suggestions: Array<{
    weekday: number
    startMinute: number
    suggestedMaxSpots: number
    weeksOfData: number
    p75Occupancy: number
    capacity: number
    applied: boolean
  }>
}
export type SessionPasses = { taken: number; cap: number; sessionCap: number | null }

function assertSpots(maxSpots: number): void {
  if (!Number.isInteger(maxSpots) || maxSpots < 0 || maxSpots > MAX_PASS_SPOTS) {
    throw new BadRequestError(`Los lugares para pases van de 0 a ${MAX_PASS_SPOTS}.`)
  }
}

/** Rastro en ActivityLog, fuera de la transacción (`logAction` nunca lanza). */
function trail(venueId: string, staffId: string | null, action: string, data: Prisma.InputJsonObject): void {
  void logAction({ staffId: staffId ?? undefined, venueId, action, entity: 'AggregatorCapacityRule', data })
}

/** Las reglas son del venue y valen para todos los proveedores: cambia el cupo de todas las clases ligadas. */
async function enqueueLinkedSessions(tx: Prisma.TransactionClient, venueId: string, now: Date): Promise<void> {
  const links = await tx.aggregatorProductLink.findMany({
    where: { venueId, active: true, connection: { status: 'ACTIVE' } },
    select: { productId: true },
    distinct: ['productId'],
    orderBy: { productId: 'asc' },
    take: LINKED_PRODUCTS_TAKE,
  })
  await enqueueHorizonSessionsSync(
    tx,
    venueId,
    links.map(l => l.productId),
    now,
  )
}

export async function getPassCapacityRules(venueId: string): Promise<{ defaultMaxSpots: number | null; weekly: WeeklyRuleView[] }> {
  const rules = await prisma.aggregatorCapacityRule.findMany({
    where: { venueId, scope: { in: ['DEFAULT', 'WEEKLY'] } },
    select: { id: true, scope: true, weekday: true, startMinute: true, maxSpots: true },
    orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }, { id: 'asc' }],
    take: RULES_TAKE,
  })
  return {
    defaultMaxSpots: rules.find(r => r.scope === 'DEFAULT')?.maxSpots ?? null,
    weekly: rules
      .filter(r => r.scope === 'WEEKLY' && r.weekday !== null)
      .map(r => ({ id: r.id, weekday: r.weekday as number, startMinute: r.startMinute, maxSpots: r.maxSpots })),
  }
}

export async function getSessionPassCap(venueId: string, classSessionId: string): Promise<number | null> {
  const r = await prisma.aggregatorCapacityRule.findFirst({
    where: { venueId, scope: 'SESSION', classSessionId },
    select: { maxSpots: true },
  })
  return r?.maxSpots ?? null
}

/** Con sugerencias (lee 8 semanas de historia): sólo para la pantalla de reglas. El calendario usa `passesForSessions`. */
export async function getPassCapacity(venueId: string, now: Date = new Date()): Promise<PassCapacityView> {
  const { defaultMaxSpots, weekly } = await getPassCapacityRules(venueId)
  const raw = await loadPassSuggestions(venueId, now)
  return {
    defaultMaxSpots,
    weekly,
    suggestions: raw.map(s => ({
      weekday: s.localWeekday,
      startMinute: s.localStartMinute,
      suggestedMaxSpots: s.suggestedMaxSpots,
      weeksOfData: s.weeksOfData,
      p75Occupancy: s.p75Occupancy,
      capacity: s.capacity,
      applied: weekly.some(w => w.weekday === s.localWeekday && w.startMinute === s.localStartMinute && w.maxSpots === s.suggestedMaxSpots),
    })),
  }
}

/** `null` borra la regla general: vuelven a ofrecerse todos los lugares libres. */
export async function setDefaultPassCap(
  venueId: string,
  maxSpots: number | null,
  staffId: string | null,
  now: Date = new Date(),
): Promise<void> {
  if (maxSpots !== null) assertSpots(maxSpots)
  const changed = await withSerializableRetry(async tx => {
    const existing = await tx.aggregatorCapacityRule.findFirst({ where: { venueId, scope: 'DEFAULT' }, select: { id: true } })
    if (maxSpots === null) {
      if (!existing) return false
      await tx.aggregatorCapacityRule.delete({ where: { id: existing.id } })
    } else if (existing) {
      await tx.aggregatorCapacityRule.update({ where: { id: existing.id }, data: { maxSpots } })
    } else {
      await tx.aggregatorCapacityRule.create({ data: { venueId, scope: 'DEFAULT', maxSpots } })
    }
    await enqueueLinkedSessions(tx, venueId, now)
    return true
  })
  if (changed) trail(venueId, staffId, 'PASS_CAPACITY_DEFAULT_SET', { maxSpots })
}

/** La misma combinación día+hora actualiza la excepción existente en vez de duplicarla. */
export async function upsertWeeklyPassCap(
  venueId: string,
  input: { weekday: number; startMinute: number | null; maxSpots: number },
  staffId: string | null,
  now: Date = new Date(),
): Promise<WeeklyRuleView> {
  const { weekday, startMinute, maxSpots } = input
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new BadRequestError('El día va de domingo (0) a sábado (6).')
  if (startMinute !== null && (!Number.isInteger(startMinute) || startMinute < 0 || startMinute > 1439)) {
    throw new BadRequestError('Hora inválida.')
  }
  assertSpots(maxSpots)
  const select = { id: true, weekday: true, startMinute: true, maxSpots: true } as const
  const saved = await withSerializableRetry(async tx => {
    const existing = await tx.aggregatorCapacityRule.findFirst({
      where: { venueId, scope: 'WEEKLY', weekday, startMinute },
      select: { id: true },
    })
    if (!existing && (await tx.aggregatorCapacityRule.count({ where: { venueId, scope: 'WEEKLY' } })) >= MAX_WEEKLY_PASS_RULES) {
      throw new BadRequestError(
        `Ya tienes ${MAX_WEEKLY_PASS_RULES} excepciones de lugares. Borra alguna antes de agregar otra.`,
        'PASS_CAPACITY_TOO_MANY_RULES',
      )
    }
    const row = existing
      ? await tx.aggregatorCapacityRule.update({ where: { id: existing.id }, data: { maxSpots }, select })
      : await tx.aggregatorCapacityRule.create({ data: { venueId, scope: 'WEEKLY', weekday, startMinute, maxSpots }, select })
    await enqueueLinkedSessions(tx, venueId, now)
    return row
  })
  trail(venueId, staffId, 'PASS_CAPACITY_WEEKLY_SET', { weekday, startMinute, maxSpots })
  return { id: saved.id, weekday: saved.weekday as number, startMinute: saved.startMinute, maxSpots: saved.maxSpots }
}

/** Sólo reglas DEFAULT/WEEKLY del propio venue; el cupo de una sesión se quita con `setSessionPassCap(…, null)`. */
export async function deletePassCapRule(venueId: string, ruleId: string, staffId: string | null, now: Date = new Date()): Promise<void> {
  const rule = await withSerializableRetry(async tx => {
    const found = await tx.aggregatorCapacityRule.findFirst({
      where: { id: ruleId, venueId, scope: { in: ['DEFAULT', 'WEEKLY'] } },
      select: { id: true, scope: true, weekday: true, startMinute: true, maxSpots: true },
    })
    if (!found) throw new NotFoundError('Esa regla ya no existe.')
    await tx.aggregatorCapacityRule.delete({ where: { id: found.id } })
    await enqueueLinkedSessions(tx, venueId, now)
    return found
  })
  trail(venueId, staffId, 'PASS_CAPACITY_RULE_DELETED', {
    ruleId,
    scope: rule.scope,
    weekday: rule.weekday,
    startMinute: rule.startMinute,
    maxSpots: rule.maxSpots,
  })
}

/** Cupo de pases de UNA sesión (gana sobre las demás reglas). `null` lo quita. */
export async function setSessionPassCap(
  venueId: string,
  classSessionId: string,
  maxSpots: number | null,
  staffId: string | null,
): Promise<void> {
  if (maxSpots !== null) assertSpots(maxSpots)
  const changed = await withSerializableRetry(async tx => {
    const session = await tx.classSession.findFirst({ where: { id: classSessionId, venueId }, select: { id: true } })
    if (!session) throw new NotFoundError('Sesión no encontrada')
    const existing = await tx.aggregatorCapacityRule.findFirst({
      where: { venueId, scope: 'SESSION', classSessionId },
      select: { id: true },
    })
    if (maxSpots === null) {
      if (!existing) return false
      await tx.aggregatorCapacityRule.delete({ where: { id: existing.id } })
    } else if (existing) {
      await tx.aggregatorCapacityRule.update({ where: { id: existing.id }, data: { maxSpots } })
    } else {
      await tx.aggregatorCapacityRule.create({ data: { venueId, scope: 'SESSION', classSessionId, maxSpots } })
    }
    await enqueuePassSessionSync(tx, venueId, classSessionId)
    return true
  })
  if (changed) trail(venueId, staffId, 'PASS_CAPACITY_SESSION_SET', { classSessionId, maxSpots })
}

/** Reservas de pase que ocupan (o ya ocuparon) un lugar: las vivas y las ya completadas (el historial no las pierde). */
const PASS_TAKEN_STATUSES: ReservationStatus[] = ['PENDING', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED']

/**
 * Lugares de pase por sesión para el calendario, con UNA consulta de reglas y UNA de lugares tomados para todas. `null` =
 * el venue no tiene ninguna conexión ACTIVE (el calendario no muestra pases). Sólo entran al mapa las sesiones que el
 * proveedor ve: producto ligado a una conexión ACTIVE y no canceladas; las demás no aparecen.
 * Los lugares tomados no salen de las reservas del llamador (que sólo trae las vivas, para inscritos y disponibles): una
 * clase ya completada seguiría diciendo «Pases 0 de N».
 */
export async function passesForSessions(
  venueId: string,
  sessions: Array<{ id: string; productId: string | null; status: string; capacity: number; startsAt: Date }>,
  tz: string,
): Promise<Map<string, SessionPasses> | null> {
  const active = await prisma.aggregatorConnection.count({ where: { venueId, status: 'ACTIVE' } })
  if (active === 0) return null
  const out = new Map<string, SessionPasses>()
  const live = sessions.filter(s => s.status !== 'CANCELLED' && s.productId !== null)
  const productIds = [...new Set(live.map(s => s.productId as string))]
  if (productIds.length === 0) return out
  const links = await prisma.aggregatorProductLink.findMany({
    where: { active: true, productId: { in: productIds }, connection: { venueId, status: 'ACTIVE' } },
    select: { productId: true },
    orderBy: { id: 'asc' },
    take: productIds.length * LINKS_PER_PRODUCT_TAKE,
  })
  const linked = new Set(links.map(l => l.productId))
  const visible = live.filter(s => linked.has(s.productId as string))
  if (visible.length === 0) return out
  const ids = visible.map(s => s.id)
  const [rawRules, takenRows] = await Promise.all([
    prisma.aggregatorCapacityRule.findMany({
      where: { venueId, OR: [{ scope: { in: ['DEFAULT', 'WEEKLY'] } }, { classSessionId: { in: ids } }] },
      select: { scope: true, weekday: true, startMinute: true, classSessionId: true, maxSpots: true },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], // R6 del Plan 1: entre iguales gana la editada más reciente
      take: RULES_TAKE + ids.length,
    }),
    // Una fila por sesión: acotado por `ids`.
    prisma.reservation.groupBy({
      by: ['classSessionId'],
      where: { venueId, classSessionId: { in: ids }, status: { in: PASS_TAKEN_STATUSES }, aggregatorBooking: { isNot: null } },
      _sum: { partySize: true },
    }),
  ])
  const rules = rawRules as CapacityRuleInput[]
  const takenOf = new Map(takenRows.map(r => [r.classSessionId, r._sum.partySize ?? 0]))
  for (const s of visible) {
    const [hh, mm] = formatInTimeZone(s.startsAt, tz, 'HH:mm').split(':').map(Number)
    const cap = resolvePassCap(rules, {
      id: s.id,
      capacity: s.capacity,
      localWeekday: Number(formatInTimeZone(s.startsAt, tz, 'i')) % 7, // ISO 1=lunes … 7=domingo ⇒ 0=domingo
      localStartMinute: hh * 60 + mm,
    })
    const taken = takenOf.get(s.id) ?? 0
    const sessionCap = rules.find(r => r.scope === 'SESSION' && r.classSessionId === s.id)?.maxSpots ?? null
    out.set(s.id, { taken, cap, sessionCap })
  }
  return out
}
