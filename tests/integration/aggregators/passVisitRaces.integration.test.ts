/**
 * Integration (REAL DB) — conector de pases: carreras entre rechazar una visita y registrar la asistencia de su reserva.
 *
 * Lo que los mocks no pueden probar: el orden de los candados (visita → reserva) y el reintento de SERIALIZABLE contra
 * Postgres de verdad. Invariante: al final, visita REJECTED ⇒ su reserva NO está CHECKED_IN (la reserva es la fuente de
 * asistencia que ve el pago a coaches).
 *  1. Un check-in normal (POS) en curso mientras la recepción rechaza la visita.
 *  2. El cambio a AUTO marcando la asistencia mientras la recepción rechaza la visita.
 * Datos inventados; sin llaves reales.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test'
// Llave de cifrado inventada (sólo para esta base desechable): la credencial de la conexión va cifrada.
process.env.AGGREGATOR_TOKEN_KEY = process.env.AGGREGATOR_TOKEN_KEY || 'c'.repeat(64)

import '../../__helpers__/integration-setup'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ingestBookingRequested } from '@/services/aggregators/core/bookingIngestion.service'
import { ingestCheckin, requeueCheckedInVisits } from '@/services/aggregators/core/visit.service'
import * as registry from '@/services/aggregators/core/adapterRegistry'
import { decryptCredential, encryptCredential } from '@/services/aggregators/core/credentials'
import { runPassOutboxRow } from '@/services/aggregators/core/outbox.service'
import { setPassConfirmMode } from '@/services/aggregators/passIntegrations.service'
import { rejectPassVisit } from '@/services/aggregators/passVisits.service'
import { checkInReservation } from '@/services/reservation/checkIn.service'

// La bitácora del dashboard se escribe sin esperar (`void logAction`): aquí no se prueba y no debe correr tras la limpieza.
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))

const RUN = Date.now()
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Una puerta que la prueba abre a mano: para retener una transacción con sus candados tomados. */
function gate() {
  let open!: () => void
  const opened = new Promise<void>(r => (open = r))
  return { open, opened }
}

describe('Conector de pases — rechazo vs asistencia (integration, real DB)', () => {
  let orgId: string | undefined
  let venueId: string | undefined
  let staffId: string | undefined
  let connId: string
  let sessionId: string
  let n = 0

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'ITEST Pases Carreras Org', email: `itest-pases-race-${RUN}@test.com`, phone: '5550000000' },
    })
    orgId = org.id
    const venue = await prisma.venue.create({
      data: {
        name: 'ITEST Pases Carreras',
        slug: `itest-pases-race-${RUN}`,
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
    staffId = (
      await prisma.staff.create({ data: { email: `itest-pases-race-staff-${RUN}@test.com`, firstName: 'Recepción', lastName: 'Prueba' } })
    ).id
    const category = await prisma.menuCategory.create({ data: { venueId: venue.id, name: 'Clases', slug: `clases-race-${RUN}` } })
    const product = await prisma.product.create({
      data: {
        venueId: venue.id,
        sku: `RACE-${RUN}`,
        name: 'Spinning',
        type: 'CLASS',
        categoryId: category.id,
        price: new Prisma.Decimal(150),
      },
    })
    const startsAt = new Date(Date.now() + 10 * 60_000)
    sessionId = (
      await prisma.classSession.create({
        data: {
          venueId: venue.id,
          productId: product.id,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 3600_000),
          duration: 60,
          capacity: 20,
        },
      })
    ).id
    const c = await prisma.aggregatorConnection.create({
      data: {
        venueId: venue.id,
        provider: 'TOTALPASS',
        externalPlaceId: `place-race-${RUN}`,
        webhookToken: `tok-race-${RUN}`,
        status: 'ACTIVE',
        confirmMode: 'ON_VENUE_CHECKIN',
      },
    })
    connId = c.id
    await prisma.aggregatorProductLink.create({
      data: { connectionId: c.id, venueId: venue.id, productId: product.id, externalPlanId: '1' },
    })
    await prisma.aggregatorSessionLink.create({
      data: { connectionId: c.id, venueId: venue.id, classSessionId: sessionId, externalOccurrenceId: `occ-race-${RUN}` },
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
    if (staffId) await step(() => prisma.staff.deleteMany({ where: { id: staffId } }))
    if (orgId) await step(() => prisma.organization.deleteMany({ where: { id: orgId } }))
  })

  /** Un socio con reserva CONFIRMED en la clase (conexión en ON_VENUE_CHECKIN). */
  async function book(): Promise<{ reservationId: string; externalUserId: string }> {
    n += 1
    await prisma.aggregatorConnection.update({ where: { id: connId }, data: { confirmMode: 'ON_VENUE_CHECKIN' } })
    const b = await ingestBookingRequested(
      { id: connId, venueId: venueId!, provider: 'TOTALPASS' },
      {
        kind: 'BOOKING_REQUESTED',
        externalBookingId: `race-${RUN}-${n}`,
        externalOccurrenceId: `occ-race-${RUN}`,
        externalUserId: `URACE${RUN}-${n}`,
        externalPlanCode: null,
        placeId: null,
        user: { name: `Socio ${n}`, email: null, phone: null },
        seatRef: null,
      },
      new Date(),
    )
    expect(b.decision).toBe('ACCEPTED')
    return { reservationId: b.reservationId!, externalUserId: `URACE${RUN}-${n}` }
  }

  /** Un socio con reserva CONFIRMED en la clase y su visita PENDING en plazo (conexión en ON_VENUE_CHECKIN). */
  async function pendingVisit(): Promise<{ visitId: string; reservationId: string }> {
    const { reservationId } = await book()
    const now = new Date()
    const visit = await prisma.aggregatorVisit.create({
      data: {
        connectionId: connId,
        venueId: venueId!,
        provider: 'TOTALPASS',
        externalUserId: `URACE${RUN}-${n}`,
        externalCheckinId: `chk-race-${RUN}-${n}`,
        validationRef: `https://admin.totalpass.com/api/v1/webhook_confirmations/race-${RUN}-${n}`,
        reservationId,
        startedAt: now,
        deadlineAt: new Date(now.getTime() + 90 * 60_000),
      },
    })
    return { visitId: visit.id, reservationId }
  }

  async function finalState(visitId: string, reservationId: string) {
    const [v, r] = await Promise.all([
      prisma.aggregatorVisit.findUniqueOrThrow({ where: { id: visitId }, select: { status: true } }),
      prisma.reservation.findUniqueOrThrow({ where: { id: reservationId }, select: { status: true } }),
    ])
    return { visit: v.status, reservation: r.status }
  }

  // C2 (P1-2) — el rechazo leía la reserva sin candado y omitía el undo si su lectura aún decía CONFIRMED
  it('rechazo mientras un check-in normal está en curso ⇒ visita REJECTED y la reserva NO queda CHECKED_IN', async () => {
    const { visitId, reservationId } = await pendingVisit()
    const kioskHolds = gate()
    const release = gate()
    // El POS marca la asistencia y se queda con la transacción abierta (candado de la reserva tomado).
    const pos = prisma.$transaction(
      async tx => {
        await checkInReservation(tx, {
          reservationId,
          venueId: venueId!,
          actor: { type: 'SERVICE', servicePrincipalId: 'itest:pos' },
          source: 'POS_ANDROID',
          now: new Date(),
        })
        kioskHolds.open()
        await release.opened
      },
      { timeout: 30_000 },
    )
    await kioskHolds.opened
    const reject = rejectPassVisit(venueId!, visitId, staffId!, new Date())
    await sleep(700)
    release.open()
    await pos
    await reject
    expect(await finalState(visitId, reservationId)).toEqual({ visit: 'REJECTED', reservation: 'CONFIRMED' })
  })

  // C2 (P1-2) — el cambio a AUTO marcaba la asistencia de una visita que la recepción acababa de rechazar
  it('rechazo mientras el cambio a AUTO marca la asistencia ⇒ visita REJECTED y la reserva NO queda CHECKED_IN', async () => {
    const { visitId, reservationId } = await pendingVisit()
    const lockHeld = gate()
    const release = gate()
    // Retiene a AUTO justo antes de tocar la reserva: alguien más tiene su candado.
    const holder = prisma.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT id FROM "Reservation" WHERE id = ${reservationId} FOR UPDATE`
        lockHeld.open()
        await release.opened
      },
      { timeout: 30_000 },
    )
    await lockHeld.opened
    const auto = setPassConfirmMode(venueId!, 'TOTALPASS', 'AUTO', null, new Date())
    await sleep(700)
    const reject = rejectPassVisit(venueId!, visitId, staffId!, new Date())
    await sleep(700)
    release.open()
    await holder
    await Promise.all([auto, reject])
    expect(await finalState(visitId, reservationId)).toEqual({ visit: 'REJECTED', reservation: 'CONFIRMED' })
  })

  // R69 / Codex authz P1-3 — el procesador leyó ON_VENUE_CHECKIN antes de que terminara el cambio a AUTO y creó la visita
  // después: no estuvo en las tandas del cambio. El barrido le registra la asistencia además de encolar la validación.
  it('visita creada con el modo viejo tras el cambio a AUTO ⇒ el barrido la deja CHECKED_IN y con validación', async () => {
    const { reservationId, externalUserId } = await book()
    await setPassConfirmMode(venueId!, 'TOTALPASS', 'AUTO', null, new Date())
    const now = new Date()
    const r = await ingestCheckin(
      { id: connId, venueId: venueId!, provider: 'TOTALPASS', confirmMode: 'ON_VENUE_CHECKIN' }, // modo leído antes del cambio
      {
        kind: 'CHECKIN_CREATED',
        externalCheckinId: `chk-stale-${RUN}`,
        validationRef: `https://admin.totalpass.com/api/v1/webhook_confirmations/stale-${RUN}`,
        externalUserId,
        placeId: null,
        startedAt: now,
        deadlineAt: new Date(now.getTime() + 90 * 60_000),
        user: { name: 'Socio Tardío', email: null, phone: null },
      },
      now,
    )
    expect(r.queuedValidation).toBe(false)
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } })).status).toBe('CONFIRMED')

    await requeueCheckedInVisits(new Date())

    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } })).status).toBe('CHECKED_IN')
    const rows = await prisma.aggregatorOutbox.findMany({
      where: { coalesceKey: `VALIDATE_VISIT:${connId}:${r.visitId}` },
      select: { status: true },
      take: 5,
    })
    expect(rows.map(x => x.status)).toEqual(['PENDING'])
  })

  // R69 / Codex authz P1-4 — una validación salió con la llave vieja; mientras volaba, el refresco guardó la nueva. El 401
  // tardío de la vieja no apaga la conexión: sigue ACTIVE con la nueva y la fila queda para reintentar.
  it('401 tardío de la llave vieja ⇒ la conexión sigue ACTIVE con la llave nueva', async () => {
    await prisma.aggregatorConnection.update({
      where: { id: connId },
      data: { status: 'ACTIVE', credentialCiphertext: encryptCredential('llave-vieja-0000') },
    })
    const now = new Date()
    const visit = await prisma.aggregatorVisit.create({
      data: {
        connectionId: connId,
        venueId: venueId!,
        provider: 'TOTALPASS',
        externalUserId: `U401${RUN}`,
        externalCheckinId: `chk-401-${RUN}`,
        validationRef: `https://admin.totalpass.com/api/v1/webhook_confirmations/401-${RUN}`,
        startedAt: now,
        deadlineAt: new Date(now.getTime() + 90 * 60_000),
      },
    })
    const row = await prisma.aggregatorOutbox.create({
      data: {
        venueId: venueId!,
        connectionId: connId,
        operation: 'VALIDATE_VISIT',
        aggregatorVisitId: visit.id,
        coalesceKey: `VALIDATE_VISIT:${connId}:${visit.id}`,
        status: 'IN_PROGRESS',
        claimToken: `tk-401-${RUN}`,
        leaseUntil: new Date(now.getTime() + 120_000),
      },
    })
    const spy = jest.spyOn(registry, 'adapterFor').mockReturnValue({
      provider: 'TOTALPASS',
      validateVisit: async () => {
        // El refresco promueve la llave nueva mientras esta llamada (con la vieja) esperaba al proveedor.
        await prisma.aggregatorConnection.update({
          where: { id: connId },
          data: { credentialCiphertext: encryptCredential('llave-nueva-0000') },
        })
        return { ok: false, retryable: false, code: 'UNAUTHORIZED', message: 'TotalPass rechazó las llaves (401)' }
      },
    } as any)
    try {
      await runPassOutboxRow(row.id, `tk-401-${RUN}`, new Date())
    } finally {
      spy.mockRestore()
    }
    const c = await prisma.aggregatorConnection.findUniqueOrThrow({ where: { id: connId } })
    expect(c.status).toBe('ACTIVE')
    expect(decryptCredential(c.credentialCiphertext)).toBe('llave-nueva-0000')
    expect((await prisma.aggregatorOutbox.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('FAILED')
  })
})
