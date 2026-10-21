/**
 * Integration (REAL DB) — conector de pases, reserva de un socio.
 *
 * Lo que los mocks no pueden probar: el candado de la clase (FOR UPDATE) y SERIALIZABLE contra Postgres de verdad,
 * el JOIN real de `sumOccupiedSeats`/`sumPassSeats`, y el SQL del reclamo de la bandeja de salida (FOR UPDATE SKIP LOCKED).
 *  1. Dos socios por el último lugar al mismo tiempo ⇒ exactamente un ACCEPTED (Review Focus 1).
 *  2. El MISMO externalBookingId dos veces a la vez ⇒ ACCEPTED + DUPLICATE, una sola reserva (nota de la Tarea 8).
 *  3. La bandeja de salida se reclama una vez: el segundo reclamo no devuelve las filas con lease vigente (nota de la Tarea 12).
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test'

import '../../__helpers__/integration-setup'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { cancelPassBookingsOfReplacedOccurrence, ingestBookingRequested } from '@/services/aggregators/core/bookingIngestion.service'
import { claimPassOutbox } from '@/services/aggregators/core/outbox.service'
import { expireVisits, ingestCheckin, requeueCheckedInVisits } from '@/services/aggregators/core/visit.service'
import { listPassVisits } from '@/services/aggregators/passVisits.service'

const RUN = Date.now()

describe('Conector de pases — reserva de un socio (integration, real DB)', () => {
  let orgId: string | undefined
  let venueId: string | undefined
  let connId: string
  let lastSeatSessionId: string
  let roomySessionId: string

  const conn = () => ({ id: connId, venueId: venueId!, provider: 'TOTALPASS' as const })
  const booking = (externalBookingId: string, externalOccurrenceId: string, n: number) => ({
    kind: 'BOOKING_REQUESTED' as const,
    externalBookingId,
    externalOccurrenceId,
    externalUserId: `U${RUN}-${n}`,
    externalPlanCode: null,
    placeId: null,
    user: { name: `Socio ${n}`, email: null, phone: null },
    seatRef: null,
  })

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'ITEST Pases Org', email: `itest-pases-${RUN}@test.com`, phone: '5550000000' },
    })
    orgId = org.id
    const venue = await prisma.venue.create({
      data: {
        name: 'ITEST Pases Venue',
        slug: `itest-pases-${RUN}`,
        organizationId: org.id,
        address: 'X',
        city: 'X',
        state: 'X',
        country: 'MX',
        zipCode: '00000',
        timezone: 'America/Mexico_City',
      },
    })
    venueId = venue.id
    const category = await prisma.menuCategory.create({ data: { venueId: venue.id, name: 'Clases', slug: `clases-pases-${RUN}` } })
    const product = await prisma.product.create({
      data: {
        venueId: venue.id,
        sku: `PASES-${RUN}`,
        name: 'Yoga',
        type: 'CLASS',
        categoryId: category.id,
        price: new Prisma.Decimal(200),
      },
    })
    const startsAt = new Date(Date.now() + 24 * 3600_000)
    const endsAt = new Date(startsAt.getTime() + 3600_000)
    const mkSession = (capacity: number) =>
      prisma.classSession.create({ data: { venueId: venue.id, productId: product.id, startsAt, endsAt, duration: 60, capacity } })
    lastSeatSessionId = (await mkSession(1)).id
    roomySessionId = (await mkSession(5)).id
    const c = await prisma.aggregatorConnection.create({
      data: { venueId: venue.id, provider: 'TOTALPASS', externalPlaceId: `place-${RUN}`, webhookToken: `tok-${RUN}`, status: 'ACTIVE' },
    })
    connId = c.id
    // La clase tiene que estar ligada a un plan: una reserva de una clase desligada se rechaza.
    await prisma.aggregatorProductLink.create({
      data: { connectionId: c.id, venueId: venue.id, productId: product.id, externalPlanId: '1' },
    })
    await prisma.aggregatorSessionLink.createMany({
      data: [
        { connectionId: c.id, venueId: venue.id, classSessionId: lastSeatSessionId, externalOccurrenceId: `occ-last-${RUN}` },
        { connectionId: c.id, venueId: venue.id, classSessionId: roomySessionId, externalOccurrenceId: `occ-roomy-${RUN}` },
      ],
    })
  })

  afterAll(async () => {
    const step = (fn: () => Promise<unknown>) => fn().catch(() => {})
    if (venueId) {
      await step(() => prisma.aggregatorOutbox.deleteMany({ where: { venueId } }))
      await step(() => prisma.aggregatorVisit.deleteMany({ where: { venueId } }))
      await step(() => prisma.aggregatorBooking.deleteMany({ where: { venueId } }))
      await step(() => prisma.aggregatorSessionLink.deleteMany({ where: { venueId } }))
      await step(() => prisma.aggregatorProductLink.deleteMany({ where: { venueId } }))
      await step(() => prisma.aggregatorInboundEvent.deleteMany({ where: { venueId } }))
      await step(() => prisma.activityLog.deleteMany({ where: { venueId } }))
      await step(() => prisma.reservation.deleteMany({ where: { venueId } }))
      await step(() => prisma.customerExternalIdentity.deleteMany({ where: { venueId } }))
      await step(() => prisma.customer.deleteMany({ where: { venueId } }))
      await step(() => prisma.aggregatorConnection.deleteMany({ where: { venueId } }))
      await step(() => prisma.classSession.deleteMany({ where: { venueId } }))
      await step(() => prisma.product.deleteMany({ where: { venueId } }))
      await step(() => prisma.menuCategory.deleteMany({ where: { venueId } }))
      await step(() => prisma.venue.deleteMany({ where: { id: venueId } }))
    }
    if (orgId) await step(() => prisma.organization.deleteMany({ where: { id: orgId } }))
  })

  // nuevo
  it('dos socios por el último lugar al mismo tiempo ⇒ exactamente un ACCEPTED', async () => {
    const occ = `occ-last-${RUN}`
    const r = await Promise.all([
      ingestBookingRequested(conn(), booking(`slot-last-1-${RUN}`, occ, 1), new Date()),
      ingestBookingRequested(conn(), booking(`slot-last-2-${RUN}`, occ, 2), new Date()),
    ])
    expect(r.map(x => x.decision).sort()).toEqual(['ACCEPTED', 'DENIED'])
    expect(r.find(x => x.decision === 'DENIED')?.reason).toBe('CLASS_FULL')
    expect(await prisma.reservation.count({ where: { classSessionId: lastSeatSessionId, status: 'CONFIRMED' } })).toBe(1)
    const reservation = await prisma.reservation.findFirstOrThrow({ where: { classSessionId: lastSeatSessionId } })
    expect(reservation).toMatchObject({ channel: 'THIRD_PARTY', partySize: 1 })
    expect(reservation.confirmedAt).not.toBeNull()
  })

  // nuevo
  it('el mismo externalBookingId dos veces a la vez ⇒ ACCEPTED + DUPLICATE y una sola reserva', async () => {
    const ev = booking(`slot-dup-${RUN}`, `occ-roomy-${RUN}`, 3)
    const r = await Promise.all([ingestBookingRequested(conn(), ev, new Date()), ingestBookingRequested(conn(), ev, new Date())])
    expect(r.map(x => x.decision).sort()).toEqual(['ACCEPTED', 'DUPLICATE'])
    expect(r[0].reservationId).toBe(r[1].reservationId)
    expect(await prisma.reservation.count({ where: { classSessionId: roomySessionId } })).toBe(1)
    expect(await prisma.aggregatorBooking.count({ where: { externalBookingId: ev.externalBookingId } })).toBe(1)
  })

  // nuevo
  it('la bandeja de salida se reclama una sola vez: con el lease vigente nadie más toma esas filas', async () => {
    const ours = await prisma.aggregatorOutbox.findMany({ where: { venueId }, select: { id: true }, take: 50 })
    expect(ours.length).toBeGreaterThan(0) // RESPOND_BOOKING + SYNC_SESSION de las reservas de arriba
    const now = new Date(Date.now() + 60_000) // por si alguna fila nació con un pequeño debounce
    const [first, second] = await Promise.all([claimPassOutbox(50, now), claimPassOutbox(50, now)])
    const ids = new Set(ours.map(o => o.id))
    const firstOurs = first.filter(r => ids.has(r.id))
    const secondOurs = second.filter(r => ids.has(r.id))
    // Entre los dos reclamos simultáneos, cada fila sale exactamente una vez.
    expect(firstOurs.length + secondOurs.length).toBe(ids.size)
    expect(new Set([...firstOurs, ...secondOurs].map(r => r.id)).size).toBe(ids.size)
    // Un tercer reclamo con el lease vigente no devuelve ninguna.
    const third = await claimPassOutbox(50, now)
    expect(third.filter(r => ids.has(r.id))).toEqual([])
    const claimed = await prisma.aggregatorOutbox.findMany({ where: { venueId }, select: { status: true, claimToken: true }, take: 50 })
    expect(claimed.every(o => o.status === 'IN_PROGRESS' && o.claimToken)).toBe(true)
  })

  // nuevo — revisión final I1: TotalPass da 5 min para contestar una reserva; no puede hacer fila detrás del horizonte.
  it('una respuesta de reserva recién creada sale antes que publicaciones de clase más viejas', async () => {
    // Las filas de las pruebas anteriores se dan por terminadas: aquí sólo compiten las de esta prueba.
    await prisma.aggregatorOutbox.updateMany({ where: { venueId }, data: { status: 'DONE', claimToken: null, leaseUntil: null } })
    const now = new Date()
    const old = new Date(now.getTime() - 10 * 60_000)
    const base = { venueId: venueId!, connectionId: connId, status: 'PENDING' as const }
    await prisma.aggregatorOutbox.createMany({
      data: [1, 2, 3].map(n => ({ ...base, operation: 'SYNC_SESSION' as const, coalesceKey: `prio-sync-${RUN}-${n}`, scheduledAt: old })),
    })
    const respond = await prisma.aggregatorOutbox.create({
      data: { ...base, operation: 'RESPOND_BOOKING', coalesceKey: `prio-respond-${RUN}`, scheduledAt: now },
    })
    const [first] = await claimPassOutbox(1, now)
    expect(first?.id).toBe(respond.id)
  })

  // nuevo — revisión final M7: el SQL crudo del barrido de visitas sólo se había probado con $queryRaw simulado
  it('el barrido de visitas y el vencimiento corren contra Postgres real', async () => {
    await expect(requeueCheckedInVisits(new Date())).resolves.toEqual(expect.any(Number))
    await expect(expireVisits(new Date())).resolves.toEqual(expect.any(Number))
  })

  // nuevo — Codex F1: en AUTO, una validación que el worker saltó (SKIPPED) mientras la conexión reconectaba quedaba sin
  // nadie que la volviera a encolar, y la visita vencía sin cobrarse.
  it('el barrido re-encola una visita AUTO cuya validación quedó SKIPPED; una con trabajo vivo no se repite', async () => {
    const now = new Date()
    const mkVisit = (n: number) =>
      prisma.aggregatorVisit.create({
        data: {
          connectionId: connId,
          venueId: venueId!,
          provider: 'TOTALPASS',
          externalUserId: `UV${RUN}-${n}`,
          externalCheckinId: `chk-${RUN}-${n}`,
          validationRef: `https://admin.totalpass.com/api/v1/webhook_confirmations/${RUN}-${n}`,
          startedAt: now,
          deadlineAt: new Date(now.getTime() + 60 * 60_000),
        },
      })
    const skipped = await mkVisit(1) // la conexión (AUTO por default) no tiene reserva ligada: gimnasio libre
    const live = await mkVisit(2)
    const key = (visitId: string) => `VALIDATE_VISIT:${connId}:${visitId}`
    const row = (visitId: string, status: 'SKIPPED' | 'PENDING') => ({
      venueId: venueId!,
      connectionId: connId,
      operation: 'VALIDATE_VISIT' as const,
      aggregatorVisitId: visitId,
      coalesceKey: key(visitId),
      status,
    })
    await prisma.aggregatorOutbox.createMany({ data: [row(skipped.id, 'SKIPPED'), row(live.id, 'PENDING')] })

    await requeueCheckedInVisits(now)

    const rows = await prisma.aggregatorOutbox.findMany({
      where: { coalesceKey: { in: [key(skipped.id), key(live.id)] } },
      select: { coalesceKey: true, status: true },
      take: 10,
    })
    expect(
      rows
        .filter(r => r.coalesceKey === key(skipped.id))
        .map(r => r.status)
        .sort(),
    ).toEqual(['PENDING', 'SKIPPED'])
    expect(rows.filter(r => r.coalesceKey === key(live.id))).toHaveLength(1)
  })

  // C6 (P1-6) — el estado de la validación sale de la ÚLTIMA fila VALIDATE_VISIT de cada visita (SQL real, DISTINCT ON)
  it('la lista de visitas dice el estado real de cada validación', async () => {
    const now = new Date()
    const mk = (tag: string) =>
      prisma.aggregatorVisit.create({
        data: {
          connectionId: connId,
          venueId: venueId!,
          provider: 'TOTALPASS',
          externalUserId: `UVAL${RUN}-${tag}`,
          externalCheckinId: `chk-val-${RUN}-${tag}`,
          validationRef: `https://admin.totalpass.com/api/v1/webhook_confirmations/val-${RUN}-${tag}`,
          startedAt: new Date(now.getTime() + 1000), // las más recientes: primera página
          deadlineAt: new Date(now.getTime() + 60 * 60_000),
        },
      })
    const retried = await mk('retried') // murió y se volvió a confirmar: manda la fila nueva
    const dead = await mk('dead')
    const none = await mk('none')
    const base = (visitId: string) => ({
      venueId: venueId!,
      connectionId: connId,
      operation: 'VALIDATE_VISIT' as const,
      aggregatorVisitId: visitId,
      coalesceKey: `VALIDATE_VISIT:${connId}:${visitId}`,
    })
    await prisma.aggregatorOutbox.create({
      data: { ...base(retried.id), status: 'DEAD_LETTER', createdAt: new Date(now.getTime() - 60_000) },
    })
    await prisma.aggregatorOutbox.create({ data: { ...base(retried.id), status: 'FAILED', createdAt: now } })
    await prisma.aggregatorOutbox.create({ data: { ...base(dead.id), status: 'DEAD_LETTER' } })
    const { items } = await listPassVisits(venueId!, { status: 'PENDING', limit: 100 }, now)
    const byId = new Map(items.map(i => [i.id, i]))
    expect(byId.get(retried.id)).toMatchObject({ validation: 'RETRYING', canConfirm: true })
    expect(byId.get(dead.id)).toMatchObject({ validation: 'FAILED', canConfirm: true })
    expect(byId.get(none.id)).toMatchObject({ validation: 'NONE' })
  })

  // C8 (P2-9) — primer check-in de un socio sin reserva ni identidad previa: aparece con su nombre, no como «sin nombre»
  it('un socio sin reserva aparece con el nombre que trae su check-in', async () => {
    const now = new Date()
    const r = await ingestCheckin(
      { id: connId, venueId: venueId!, provider: 'TOTALPASS', confirmMode: 'ON_VENUE_CHECKIN' },
      {
        kind: 'CHECKIN_CREATED',
        externalCheckinId: `chk-name-${RUN}`,
        validationRef: `https://admin.totalpass.com/api/v1/webhook_confirmations/name-${RUN}`,
        externalUserId: `UNAME${RUN}`,
        placeId: null,
        startedAt: now,
        deadlineAt: new Date(now.getTime() + 90 * 60_000),
        user: { name: 'Lucía Prueba Walkin', email: null, phone: null },
      },
      now,
    )
    const { items } = await listPassVisits(venueId!, { status: 'PENDING', limit: 100 }, now)
    expect(items.find(i => i.id === r.visitId)).toMatchObject({ memberName: 'Lucía Prueba Walkin', reservation: null })
  })

  // nuevo — decisión del founder (3-oct, opción A): la clase cambió de hora y TotalPass canceló a sus socios
  it('reemplazo de la ocurrencia: las reservas de pase de antes del corte quedan canceladas; las de después no', async () => {
    const replacedAt = new Date()
    await new Promise(r => setTimeout(r, 5)) // la reserva «de la ocurrencia nueva» nace después del corte
    const after = await ingestBookingRequested(conn(), booking(`slot-after-${RUN}`, `occ-roomy-${RUN}`, 9), new Date())
    expect(after.decision).toBe('ACCEPTED')
    const n = await cancelPassBookingsOfReplacedOccurrence(conn(), roomySessionId, replacedAt, new Date())
    expect(n).toBe(1) // la del socio 3 (prueba del duplicado), aceptada antes del corte
    const rows = await prisma.reservation.findMany({
      where: { classSessionId: roomySessionId },
      select: { id: true, status: true, cancelledBy: true },
      take: 10,
    })
    expect(rows.find(r => r.id === after.reservationId)?.status).toBe('CONFIRMED')
    const cancelled = rows.filter(r => r.status === 'CANCELLED')
    expect(cancelled).toHaveLength(1)
    expect(cancelled[0].cancelledBy).toBe('SYSTEM')
    // Volver a correrlo no cancela nada más (idempotente).
    await expect(cancelPassBookingsOfReplacedOccurrence(conn(), roomySessionId, replacedAt, new Date())).resolves.toBe(0)
  })
})
