import { Prisma } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'
import prisma from '@/utils/prismaClient'
import { sumOccupiedSeats, sumPassSeats } from '@/services/reservation/classBooking.service'
import { resolvePassCap, spotsToPublish } from './capacityRules'
// Ciclo de imports aceptado (ruling R2): outbox.service importa `buildSessionPublication` y este archivo importa
// `enqueuePassOutbox`. Los dos sólo se usan DENTRO de funciones (al llamarlas), nunca al cargar el módulo.
import { enqueuePassOutbox } from './outbox.service'
import { SessionPublication } from './types'

/** Reglas de cupo por venue: pocas en la práctica; el tope sólo protege de un venue patológico. */
const CAPACITY_RULES_TAKE = 200
const DEFAULT_TZ = 'America/Mexico_City'

export type SessionPublicationResult = {
  publication: SessionPublication | null
  spots: number
  providerActive: number
  reason?: 'NOT_LINKED' | 'CANCELLED' | 'PAST'
}

/**
 * Lo que hay que publicar de una sesión en UNA conexión (spec §6). Sin publicación, `reason` dice por qué:
 * - `CANCELLED`: la sesión ya no está programada, o ya no existe (se borró: no hay FK desde la bandeja).
 * - `NOT_LINKED`: su producto no está ligado a un plan del proveedor.
 * - `PAST`: ya empezó (se revisa primero, antes que cancelada o sin ligar). Una ocurrencia pasada NO se da de baja.
 *
 * Cupo publicado = reservas activas de este proveedor + lo que aún puede tomar dentro del tope compartido de pases.
 */
export async function buildSessionPublication(
  classSessionId: string,
  connectionId: string,
  now: Date = new Date(),
): Promise<SessionPublicationResult> {
  const s = await prisma.classSession.findFirst({
    where: { id: classSessionId },
    select: {
      id: true,
      venueId: true,
      productId: true,
      startsAt: true,
      duration: true,
      capacity: true,
      status: true,
      product: { select: { name: true } },
      assignedStaff: { select: { firstName: true, lastName: true } },
      venue: { select: { timezone: true } },
    },
  })
  if (!s) return { publication: null, spots: 0, providerActive: 0, reason: 'CANCELLED' }
  // PAST va antes que todo lo demás: una clase que ya empezó nunca se da de baja, aunque luego se haya cancelado o su
  // producto se haya desligado (darla de baja le cancelaría la reserva al socio que ya asistió).
  if (s.startsAt.getTime() <= now.getTime()) return { publication: null, spots: 0, providerActive: 0, reason: 'PAST' }
  const link = await prisma.aggregatorProductLink.findFirst({
    where: { connectionId, productId: s.productId, active: true },
    select: { externalPlanId: true },
  })
  if (!link) return { publication: null, spots: 0, providerActive: 0, reason: 'NOT_LINKED' }
  if (s.status !== 'SCHEDULED') return { publication: null, spots: 0, providerActive: 0, reason: 'CANCELLED' }

  const tz = s.venue.timezone || DEFAULT_TZ
  const occupied = await sumOccupiedSeats(prisma, s.id)
  const passOccupied = await sumPassSeats(prisma, s.id)
  const providerActive = await prisma.aggregatorBooking.count({
    where: {
      connectionId,
      classSessionId: s.id,
      decision: 'ACCEPTED',
      reservation: { status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] } },
    },
  })
  // Orden estable (R6): con dos reglas igual de específicas gana la más reciente (resolvePassCap toma la primera).
  const rules = await prisma.aggregatorCapacityRule.findMany({
    where: { venueId: s.venueId, OR: [{ scope: { in: ['DEFAULT', 'WEEKLY'] } }, { classSessionId: s.id }] },
    select: { scope: true, weekday: true, startMinute: true, classSessionId: true, maxSpots: true },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    take: CAPACITY_RULES_TAKE,
  })
  const [hh, mm] = formatInTimeZone(s.startsAt, tz, 'HH:mm').split(':').map(Number)
  // 'i' = día ISO (lunes 1 … domingo 7) ⇒ % 7 deja domingo = 0, como guarda la regla semanal.
  const localWeekday = Number(formatInTimeZone(s.startsAt, tz, 'i')) % 7
  const cap = resolvePassCap(rules, { id: s.id, capacity: s.capacity, localWeekday, localStartMinute: hh * 60 + mm })
  const spots = spotsToPublish({ capacity: s.capacity, occupied, passOccupied, cap, providerActive })
  const coachName = [s.assignedStaff?.firstName, s.assignedStaff?.lastName].filter(Boolean).join(' ') || 'Instructor'
  return {
    providerActive,
    spots,
    publication: {
      classSessionId: s.id,
      title: s.product.name,
      coachName,
      durationMin: s.duration,
      startsAt: s.startsAt,
      timezone: tz,
      spots,
      externalPlanId: link.externalPlanId,
      bookingClosesAt: new Date(s.startsAt.getTime() - 60e3),
      cancelUntil: null,
    },
  }
}

/** Conexiones por venue: una por proveedor (`@@unique([venueId, provider])`); el tope sólo es defensa. */
const CONNECTIONS_PER_VENUE_TAKE = 5

/** Llamar en la MISMA tx que cambia una sesión o su lista (junto a cada `UPDATE_ROSTER` de Google Calendar). */
export async function enqueuePassSessionSync(tx: Prisma.TransactionClient, venueId: string, classSessionId: string): Promise<void> {
  const conns = await tx.aggregatorConnection.findMany({
    where: { venueId, status: 'ACTIVE' },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: CONNECTIONS_PER_VENUE_TAKE,
  })
  for (const c of conns) await enqueuePassOutbox(tx, { venueId, connectionId: c.id, operation: 'SYNC_SESSION', classSessionId })
}
