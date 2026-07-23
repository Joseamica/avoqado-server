/**
 * Re-empuja a Google Calendar las reservas FUTURAS de UN venue, para que
 * adopten el formato de evento nuevo (todos los servicios, extras, duración,
 * total). Spec §7, decisión (b).
 *
 * Construir este script NO modifica ningún calendario — solo ejecutarlo con
 * `--confirm` lo hace. Sin `--confirm` es un DRY RUN que únicamente cuenta.
 *
 * Uso:
 *   npx tsx scripts/repush-google-calendar-events.ts <venueId>
 *   npx tsx scripts/repush-google-calendar-events.ts <venueId> --confirm
 *
 * Sin --confirm solo cuenta y no escribe nada. Con --confirm encola en el
 * outbox existente (`CalendarSyncOutbox`) vía `resolveReservationPushTargets`
 * + `enqueuePush` — nunca inserta a mano — así hereda reintentos,
 * dead-letter, rate limiting, y el kill switch `googleCalendarPushEnabled`
 * ya probados en esos helpers. El worker del outbox drena las filas en su
 * siguiente pasada; este script NO habla con la API de Google directamente.
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { enqueuePush, resolveReservationPushTargets } from '@/services/google-calendar/outbox.service'

async function main() {
  const venueId = process.argv[2]
  const confirm = process.argv.includes('--confirm')

  if (!venueId) {
    console.error('Falta el venueId.\n  Uso: npx tsx scripts/repush-google-calendar-events.ts <venueId> [--confirm]')
    process.exit(1)
  }

  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { id: true, name: true, slug: true } })
  if (!venue) {
    console.error(`No existe el venue "${venueId}". Verifica el id (no el slug).`)
    process.exit(1)
  }

  // Las reservas de CLASE (classSessionId != null) se excluyen a propósito.
  // La plataforma NUNCA las empuja a Google como evento individual: crea UN
  // SOLO evento por ClassSession (compartido entre todos los asistentes),
  // por un camino aparte (kind:'class', operation:'UPDATE_ROSTER'; ver
  // outbox.service.ts ~línea 63 "one event per class, not per attendee" y
  // reservation.dashboard.service.ts ~línea 638). Si este script les hiciera
  // enqueuePush({ kind: 'reservation' }) igual que a una cita normal, el
  // worker no encontraría mapping por reservationId, lo promovería a CREATE,
  // no encontraría el evento de clase (indexado por avoqadoClassSessionId,
  // no por avoqadoReservationId), y crearía un evento espurio por CADA
  // asistente — en un gym con clases llenas, decenas de eventos basura.
  const reservationWhere: Prisma.ReservationWhereInput = {
    venueId,
    startsAt: { gte: new Date() },
    status: { in: ['PENDING', 'CONFIRMED'] },
  }

  const [reservations, classReservationsExcluded] = await Promise.all([
    prisma.reservation.findMany({
      where: { ...reservationWhere, classSessionId: null },
      select: { id: true, confirmationCode: true, startsAt: true, assignedStaffId: true },
      orderBy: { startsAt: 'asc' },
    }),
    prisma.reservation.count({
      where: { ...reservationWhere, classSessionId: { not: null } },
    }),
  ])

  console.log(`Venue: ${venue.name} (${venue.slug})`)
  console.log(`Reservas futuras PENDING/CONFIRMED (citas individuales): ${reservations.length}`)
  console.log(
    `${classReservationsExcluded} reservas de clase omitidas (las clases usan otro mecanismo de sincronización: un evento por sesión vía UPDATE_ROSTER).`,
  )

  if (reservations.length === 0) {
    console.log('Nada que re-empujar.')
    return
  }

  if (!confirm) {
    console.log('\nDRY RUN — no se escribió nada. Repite con --confirm para encolar en el outbox.')
    for (const r of reservations.slice(0, 10)) {
      console.log(`  ${r.confirmationCode}  ${r.startsAt.toISOString()}`)
    }
    if (reservations.length > 10) console.log(`  ... y ${reservations.length - 10} más`)
    return
  }

  // Se reusan los helpers del outbox en vez de insertar a mano: ellos derivan
  // el syncKey (`reservation:<id>:<connId>`), el idempotencyKey obligatorio, y
  // una fila POR CONEXIÓN destino. `resolveReservationPushTargets` también
  // respeta el kill switch `googleCalendarPushEnabled` del venue (devuelve []
  // si el push está pausado) — por eso una reserva sin conexión activa o con
  // el push apagado se cuenta como "omitida", nunca se encola a mano.
  let queued = 0
  let skipped = 0
  let failed = 0
  for (const r of reservations) {
    // Cada reserva en su propio try/catch: si una falla (borrada entre el
    // findMany y aquí, timeout, constraint), NO debe tumbar el proceso antes
    // de imprimir el resumen — el operador se quedaría ciego sobre cuántas
    // sí alcanzaron a encolarse. Se loggea y se sigue con la siguiente.
    try {
      const rowIds = await prisma.$transaction(async tx => {
        const targets = await resolveReservationPushTargets(tx, { venueId, assignedStaffId: r.assignedStaffId })
        if (targets.length === 0) return []
        return enqueuePush(tx, {
          source: { kind: 'reservation', reservationId: r.id },
          venueId,
          operation: 'UPDATE',
          // PushTarget expone `id` (el id de la conexión), NO `connectionId`.
          targetConnectionIds: targets.map(t => t.id),
        })
      })
      if (rowIds.length === 0) skipped++
      else queued += rowIds.length
    } catch (e) {
      failed++
      console.error(`  ERROR al encolar reserva ${r.confirmationCode} (${r.id}):`, e)
    }
  }

  console.log(`\nEncoladas ${queued} filas de outbox.`)
  console.log(`${skipped} reservas omitidas (sin calendario conectado o push pausado para el venue).`)
  console.log(`${failed} reservas fallidas (ver errores arriba).`)
  console.log('El worker del outbox las empuja en su siguiente pasada.')
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
