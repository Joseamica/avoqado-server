/**
 * Fase 8 del kiosco — "Mi clase ahora".
 *
 * Quien da la clase necesita UNA cosa: quién viene y quién ya llegó. Hoy, para verlo,
 * tendría que entrar a la agenda del negocio, que enseña todo lo demás — el resto del día,
 * otros instructores, cuánto pagó cada quien.
 *
 * Por eso este carril es estrecho y de SÓLO LECTURA:
 *   · sólo sesiones donde ELLA es la persona asignada,
 *   · sólo la que está ocurriendo (o la siguiente, si falta poco),
 *   · nombre y apellido inicial — nada de teléfono, correo ni dinero.
 *
 * Es el mismo criterio con el que la cara del cliente enseña la lista: lo mínimo para
 * hacer el trabajo, en una pantalla que otros pueden ver de reojo.
 */

import prisma from '@/utils/prismaClient'
import { KIOSK_EARLY_CHECK_IN_MIN } from './checkIn.service'

/** Cuánto antes aparece la clase que viene, y cuánto después sigue visible al terminar. */
const LOOKAHEAD_MIN = KIOSK_EARLY_CHECK_IN_MIN
const LINGER_MIN = 15

export interface CoachClassAttendee {
  reservationId: string
  displayName: string
  status: string
  checkedIn: boolean
  spotLabel: string | null
}

export interface CoachClassNow {
  sessionId: string
  productName: string
  startsAt: Date
  endsAt: Date
  capacity: number
  booked: number
  checkedIn: number
  attendees: CoachClassAttendee[]
}

/** "Ana Gómez" → "Ana G." — suficiente para reconocerla, insuficiente para identificarla. */
function displayName(first?: string | null, last?: string | null): string {
  const f = (first ?? '').trim()
  const l = (last ?? '').trim()
  if (!f && !l) return 'Invitado'
  return l ? `${f} ${l[0].toUpperCase()}.` : f
}

/** El invitado trae un solo campo con todo: "Ana Gómez" → "Ana G.". */
function displayNameFromFull(full?: string | null): string {
  const parts = (full ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'Invitado'
  return displayName(parts[0], parts.slice(1).join(' '))
}

function spotLabel(spotIds: unknown, layoutConfig: unknown): string | null {
  const ids = Array.isArray(spotIds) ? spotIds : []
  if (ids.length === 0) return null
  const layout = (layoutConfig ?? {}) as { spots?: Array<{ id?: string; label?: string }> }
  const labels = ids
    .map(id => layout.spots?.find(sp => sp.id === id)?.label ?? null)
    .filter((x): x is string => Boolean(x))
  return labels.length > 0 ? labels.join(', ') : null
}

export async function getMyClassNow(args: { venueId: string; staffId: string; now: Date }): Promise<CoachClassNow | null> {
  const from = new Date(args.now.getTime() - LINGER_MIN * 60_000)
  const to = new Date(args.now.getTime() + LOOKAHEAD_MIN * 60_000)

  const session = await prisma.classSession.findFirst({
    where: {
      venueId: args.venueId,
      assignedStaffId: args.staffId, // 🔴 la llave del carril: sólo lo SUYO
      status: { not: 'CANCELLED' },
      OR: [
        { startsAt: { lte: to }, endsAt: { gte: from } }, // en curso o por empezar
      ],
    },
    orderBy: { startsAt: 'asc' },
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      capacity: true,
      product: { select: { name: true, layoutConfig: true } },
      reservations: {
        where: { status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] } },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          status: true,
          spotIds: true,
          customer: { select: { firstName: true, lastName: true } },
          // Reserva de invitado (sin cuenta): el nombre vive completo en la propia reserva.
          guestName: true,
        },
      },
    },
  })

  if (!session) return null

  const attendees: CoachClassAttendee[] = session.reservations.map(r => ({
    reservationId: r.id,
    displayName: r.customer
      ? displayName(r.customer.firstName, r.customer.lastName)
      : displayNameFromFull(r.guestName),
    status: r.status,
    checkedIn: r.status === 'CHECKED_IN',
    spotLabel: spotLabel(r.spotIds, session.product?.layoutConfig),
  }))

  return {
    sessionId: session.id,
    productName: session.product?.name ?? 'Clase',
    startsAt: session.startsAt,
    endsAt: session.endsAt,
    capacity: session.capacity,
    booked: attendees.length,
    checkedIn: attendees.filter(a => a.checkedIn).length,
    attendees,
  }
}
