/**
 * Integration (REAL DB) — Fase 0.C, check-in puro + orden única por reserva.
 *
 * Spec §0.C tests 7 (ActivityLog HUMAN real cumple la constraint), 9 (dos check-ins
 * concurrentes ⇒ ambos 200, 1 statusLog, 1 ActivityLog, 1 Order viva; el perdedor recibe la
 * orden del ganador), 10 (orden CANCELLED previa ⇒ se crea reemplazo), 18 (índice parcial
 * real `Order_reservationId_alive_key`).
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test'

import '../../__helpers__/integration-setup'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { checkInReservation, checkInReservationAndOpenOrder, type CheckInActor } from '@/services/reservation/checkIn.service'

const RUN = Date.now()

describe('Fase 0.C — check-in (integration, real DB)', () => {
  let orgId: string | undefined
  let venueId: string | undefined
  let staffId: string | undefined
  let productId: string
  let actor: CheckInActor

  const mkReservation = async (status: 'PENDING' | 'CONFIRMED' = 'CONFIRMED') =>
    prisma.reservation.create({
      data: {
        venueId: venueId!,
        confirmationCode: `ITEST-0C-${RUN}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
        startsAt: new Date(Date.now() + 3600_000),
        endsAt: new Date(Date.now() + 7200_000),
        duration: 60,
        status,
        productId,
        guestName: 'Ana',
        guestPhone: '+525500000000',
        statusLog: [{ status, at: new Date().toISOString(), by: null }],
      },
    })

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'ITEST 0C Org', email: `itest-0c-${RUN}@test.com`, phone: '5550000000' },
    })
    orgId = org.id
    const venue = await prisma.venue.create({
      data: {
        name: 'ITEST 0C Venue',
        slug: `itest-0c-${RUN}`,
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
    const staff = await prisma.staff.create({
      data: { email: `coach-${RUN}@test.com`, firstName: 'Coach', lastName: 'ITEST' },
    })
    staffId = staff.id
    actor = { type: 'HUMAN', staffId: staff.id, organizationId: org.id }
    const category = await prisma.menuCategory.create({ data: { venueId: venue.id, name: 'Clases', slug: `clases-0c-${RUN}` } })
    const product = await prisma.product.create({
      data: { venueId: venue.id, sku: `0C-${RUN}`, name: 'Yoga', categoryId: category.id, price: new Prisma.Decimal(200) },
    })
    productId = product.id
  })

  afterAll(async () => {
    const step = (fn: () => Promise<unknown>) => fn().catch(() => {})
    if (venueId) {
      await step(() => prisma.orderItem.deleteMany({ where: { order: { venueId } } }))
      await step(() => prisma.order.deleteMany({ where: { venueId } }))
      await step(() => prisma.activityLog.deleteMany({ where: { venueId } }))
      await step(() => prisma.reservation.deleteMany({ where: { venueId } }))
      await step(() => prisma.product.deleteMany({ where: { venueId } }))
      await step(() => prisma.menuCategory.deleteMany({ where: { venueId } }))
      await step(() => prisma.venue.deleteMany({ where: { id: venueId } }))
    }
    if (staffId) await step(() => prisma.staff.deleteMany({ where: { id: staffId } }))
    if (orgId) await step(() => prisma.organization.deleteMany({ where: { id: orgId } }))
  })

  it('test 7: check-in puro escribe estado + statusLog + ActivityLog HUMAN que la constraint acepta (actorStaffId = staffId)', async () => {
    const r = await mkReservation('PENDING')

    const result = await prisma.$transaction(tx =>
      checkInReservation(tx, { reservationId: r.id, venueId: venueId!, actor, source: 'DASHBOARD', now: new Date() }),
    )

    expect(result.outcome).toBe('CHECKED_IN')
    const row = await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })
    expect(row.status).toBe('CHECKED_IN')
    expect(row.checkedInAt).toBeTruthy()
    expect((row.statusLog as any[]).at(-1)).toEqual(expect.objectContaining({ status: 'CHECKED_IN', by: staffId, source: 'DASHBOARD' }))
    const logs = await prisma.activityLog.findMany({ where: { entityId: r.id, action: 'RESERVATION_CHECKED_IN' } })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toEqual(expect.objectContaining({ actorType: 'HUMAN', staffId, actorStaffId: staffId, organizationId: orgId }))
    // PURO: ninguna orden.
    expect(await prisma.order.count({ where: { reservationId: r.id } })).toBe(0)
  })

  it('test 9/18: dos check-ins CONCURRENTES (wrapper) ⇒ ambos resuelven, 1 statusLog CHECKED_IN, 1 ActivityLog, 1 Order viva; el perdedor recibe la orden del ganador', async () => {
    const r = await mkReservation('CONFIRMED')
    const cmd = { reservationId: r.id, venueId: venueId!, actor, source: 'POS_ANDROID' as const, now: new Date() }

    const [a, b] = await Promise.all([checkInReservationAndOpenOrder(cmd), checkInReservationAndOpenOrder(cmd)])

    expect(a.status).toBe('CHECKED_IN')
    expect(b.status).toBe('CHECKED_IN')
    expect(a.orderId).toBeTruthy()
    expect(b.orderId).toBe(a.orderId) // el perdedor obtiene la del ganador
    expect([a.orderCreated, b.orderCreated].filter(Boolean)).toHaveLength(1)
    expect(a.orderError).toBeUndefined()
    expect(b.orderError).toBeUndefined()

    const row = await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })
    expect((row.statusLog as any[]).filter(e => e.status === 'CHECKED_IN')).toHaveLength(1)
    expect(await prisma.activityLog.count({ where: { entityId: r.id, action: 'RESERVATION_CHECKED_IN' } })).toBe(1)
    expect(await prisma.order.count({ where: { reservationId: r.id, status: { notIn: ['CANCELLED', 'DELETED'] } } })).toBe(1)
  })

  it('test 10: orden CANCELLED previa ⇒ el check-in crea un REEMPLAZO (el índice parcial lo permite; la cancelada no bloquea)', async () => {
    const r = await mkReservation('CONFIRMED')
    const first = await checkInReservationAndOpenOrder({
      reservationId: r.id,
      venueId: venueId!,
      actor,
      source: 'DASHBOARD',
      now: new Date(),
    })
    expect(first.orderCreated).toBe(true)
    await prisma.order.update({ where: { id: first.orderId! }, data: { status: 'CANCELLED' } })

    // Re-check-in: idempotente en estado (ALREADY), pero la orden viva ya no existe ⇒ reemplazo.
    const second = await checkInReservationAndOpenOrder({
      reservationId: r.id,
      venueId: venueId!,
      actor,
      source: 'DASHBOARD',
      now: new Date(),
    })
    expect(second.status).toBe('CHECKED_IN')
    expect(second.orderCreated).toBe(true)
    expect(second.orderId).not.toBe(first.orderId)
    expect(await prisma.order.count({ where: { reservationId: r.id } })).toBe(2)
    expect(await prisma.order.count({ where: { reservationId: r.id, status: { notIn: ['CANCELLED', 'DELETED'] } } })).toBe(1)
    // y sin segundo ActivityLog de check-in (idempotente)
    expect(await prisma.activityLog.count({ where: { entityId: r.id, action: 'RESERVATION_CHECKED_IN' } })).toBe(1)
  })

  it('test 18: el índice parcial real rechaza una segunda orden viva para la misma reserva (P2002) y acepta una cancelada al lado', async () => {
    const r = await mkReservation('CONFIRMED')
    const mkOrder = (status: 'PENDING' | 'CANCELLED') =>
      prisma.order.create({
        data: {
          venueId: venueId!,
          reservationId: r.id,
          orderNumber: `ITEST-${Math.random().toString(36).slice(2, 8)}`,
          status,
          subtotal: new Prisma.Decimal(0),
          taxAmount: new Prisma.Decimal(0),
          total: new Prisma.Decimal(0),
        },
      })
    await mkOrder('PENDING')
    await expect(mkOrder('PENDING')).rejects.toMatchObject({ code: 'P2002' })
    await expect(mkOrder('CANCELLED')).resolves.toBeTruthy()
  })

  it('NO_SHOW ⇒ 409 RESERVATION_NOT_CHECKINABLE sin escribir', async () => {
    const r = await prisma.reservation.create({
      data: {
        venueId: venueId!,
        confirmationCode: `ITEST-0C-${RUN}-NS`,
        startsAt: new Date(Date.now() - 3600_000),
        endsAt: new Date(),
        duration: 60,
        status: 'NO_SHOW',
        productId,
        guestName: 'No Show',
      },
    })
    await expect(
      checkInReservationAndOpenOrder({ reservationId: r.id, venueId: venueId!, actor, source: 'DASHBOARD', now: new Date() }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'RESERVATION_NOT_CHECKINABLE' })
    expect(await prisma.activityLog.count({ where: { entityId: r.id } })).toBe(0)
    expect(await prisma.order.count({ where: { reservationId: r.id } })).toBe(0)
  })
})
