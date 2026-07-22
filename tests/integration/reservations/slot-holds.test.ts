import { Prisma, PrismaClient, type Reservation } from '@prisma/client'

jest.mock('@/services/whatsapp.service', () => ({
  sendReservationRescheduleWhatsApp: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/services/email.service', () => ({
  __esModule: true,
  default: { sendReservationRescheduledEmail: jest.fn().mockResolvedValue(undefined) },
}))

import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { createReservation, rescheduleAppointmentReservation, updateReservation } from '@/services/dashboard/reservation.dashboard.service'
import { countAppointmentOccupancy } from '@/services/dashboard/reservationAvailability.service'
import { mintRescheduleAppointmentHold } from '@/services/reservation/appointmentSlotHold.service'

const fixtureKey = `slot-holds-${process.pid}-${Date.now()}`
const inspector = new PrismaClient()
const lockHolder = new PrismaClient()
const allDay = Object.fromEntries(
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(day => [
    day,
    { enabled: true, ranges: [{ open: '00:00', close: '23:59' }] },
  ]),
)

let organizationId = ''
let venueId = ''
let productA = ''
let productB = ''
let sequence = 0

type Window = { startsAt: Date; endsAt: Date }

function futureWindow(dayOffset: number, durationMin = 60, hour = 12, minute = 0): Window {
  const now = new Date()
  const startsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset, hour, minute, 0, 0))
  return { startsAt, endsAt: new Date(startsAt.getTime() + durationMin * 60_000) }
}

function confirmationCode(prefix = 'HOLD'): string {
  sequence += 1
  return `${prefix}-${process.pid}-${sequence}`
}

async function createAppointmentReservation(
  args: {
    window?: Window
    duration?: number
    productId?: string
    productIds?: string[]
    partySize?: number
    status?: 'PENDING' | 'CONFIRMED' | 'CANCELLED'
  } = {},
): Promise<Reservation> {
  const duration = args.duration ?? 60
  const window = args.window ?? futureWindow(10 + sequence, duration)
  return prisma.reservation.create({
    data: {
      venueId,
      confirmationCode: confirmationCode(),
      status: args.status ?? 'CONFIRMED',
      channel: 'DASHBOARD',
      startsAt: window.startsAt,
      endsAt: window.endsAt,
      duration,
      productId: args.productId ?? productA,
      productIds: args.productIds ?? [],
      assignedStaffId: null,
      partySize: args.partySize ?? 1,
      guestName: null,
      guestPhone: null,
      guestEmail: null,
    },
  })
}

async function createLegacyRescheduleHold(args: { reservation: Reservation; window: Window; productIds: string[] }) {
  return prisma.slotHold.create({
    data: {
      venueId,
      startsAt: args.window.startsAt,
      endsAt: args.window.endsAt,
      productIds: args.productIds,
      classSessionId: null,
      staffId: null,
      heldForReservationId: null,
      windowSemantics: null,
      partySize: args.reservation.partySize,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      fingerprint: null,
    },
  })
}

function consume(reservationId: string, holdId: string, startsAt: Date) {
  return rescheduleAppointmentReservation({
    venueId,
    reservationId,
    newStartsAt: startsAt,
    holdId,
    rescheduledBy: 'CUSTOMER',
    writeOrigin: 'PUBLIC',
  })
}

async function cleanupFixtures(): Promise<void> {
  if (venueId) await prisma.venue.deleteMany({ where: { id: venueId } })
  if (organizationId) await prisma.organization.deleteMany({ where: { id: organizationId } })
}

beforeAll(async () => {
  try {
    const organization = await prisma.organization.create({
      data: {
        name: fixtureKey,
        slug: fixtureKey,
        email: `${fixtureKey}@example.test`,
        phone: '5500000000',
      },
    })
    organizationId = organization.id

    const venue = await prisma.venue.create({
      data: {
        organizationId,
        name: fixtureKey,
        slug: fixtureKey,
        timezone: 'UTC',
        seatCapExempt: true,
      },
    })
    venueId = venue.id

    const category = await prisma.menuCategory.create({
      data: {
        venueId,
        name: `${fixtureKey}-services`,
        slug: `${fixtureKey}-services`,
        availableDays: [],
      },
    })
    const [first, second] = await Promise.all([
      prisma.product.create({
        data: {
          venueId,
          categoryId: category.id,
          sku: `${fixtureKey}-a`,
          name: `${fixtureKey}-a`,
          type: 'APPOINTMENTS_SERVICE',
          duration: 60,
          price: new Prisma.Decimal(100),
          eventCapacity: null,
          tags: [],
          allergens: [],
        },
      }),
      prisma.product.create({
        data: {
          venueId,
          categoryId: category.id,
          sku: `${fixtureKey}-b`,
          name: `${fixtureKey}-b`,
          type: 'APPOINTMENTS_SERVICE',
          duration: 30,
          price: new Prisma.Decimal(50),
          eventCapacity: null,
          tags: [],
          allergens: [],
        },
      }),
    ])
    productA = first.id
    productB = second.id

    await prisma.reservationSettings.create({
      data: {
        venueId,
        minNoticeMin: 0,
        maxAdvanceDays: 365,
        capacityMode: 'pacing',
        pacingMaxPerSlot: 1,
        publicBookingEnabled: true,
        allowCustomerReschedule: true,
        minHoursBeforeCancel: null,
        googleCalendarPushEnabled: false,
        operatingHours: allDay as Prisma.InputJsonValue,
      },
    })
  } catch (error) {
    await cleanupFixtures()
    throw error
  }
})

beforeEach(async () => {
  jest.clearAllMocks()
  sequence = 0
  await prisma.slotHold.deleteMany({ where: { venueId } })
  await prisma.reservation.deleteMany({ where: { venueId } })
  await prisma.venue.update({ where: { id: venueId }, data: { seatCapExempt: true } })
  await prisma.reservationSettings.update({
    where: { venueId },
    data: {
      minNoticeMin: 0,
      maxAdvanceDays: 365,
      capacityMode: 'pacing',
      pacingMaxPerSlot: 1,
      publicBookingEnabled: true,
      allowCustomerReschedule: true,
      minHoursBeforeCancel: null,
      operatingHours: allDay as Prisma.InputJsonValue,
    },
  })
  await Promise.all([
    prisma.product.update({ where: { id: productA }, data: { duration: 60 } }),
    prisma.product.update({ where: { id: productB }, data: { duration: 30 } }),
  ])
})

afterAll(async () => {
  try {
    await cleanupFixtures()
  } finally {
    await Promise.allSettled([inspector.$disconnect(), lockHolder.$disconnect()])
  }
})

describe('reschedule SlotHold PostgreSQL contract', () => {
  it('replaces H1 at pacing one and leaves at most one tagged sibling', async () => {
    const reservation = await createAppointmentReservation()
    const target = futureWindow(20)
    const first = await mintRescheduleAppointmentHold({
      venueId,
      reservationId: reservation.id,
      requestedStartsAt: target.startsAt,
    })
    const second = await mintRescheduleAppointmentHold({
      venueId,
      reservationId: reservation.id,
      requestedStartsAt: target.startsAt,
    })

    expect(second.id).not.toBe(first.id)
    expect(await inspector.slotHold.findUnique({ where: { id: first.id } })).toBeNull()
    expect(
      await inspector.slotHold.findMany({
        where: { venueId, heldForReservationId: reservation.id },
        select: { id: true, heldForReservationId: true },
      }),
    ).toEqual([{ id: second.id, heldForReservationId: reservation.id }])
  })

  it('restores H1 when replacement deletes it and then fails the target pacing gate', async () => {
    const reservation = await createAppointmentReservation()
    const firstTarget = futureWindow(21)
    const blockedTarget = futureWindow(22)
    const first = await mintRescheduleAppointmentHold({
      venueId,
      reservationId: reservation.id,
      requestedStartsAt: firstTarget.startsAt,
    })
    await createAppointmentReservation({ window: blockedTarget })

    await expect(
      mintRescheduleAppointmentHold({
        venueId,
        reservationId: reservation.id,
        requestedStartsAt: blockedTarget.startsAt,
      }),
    ).rejects.toMatchObject({ statusCode: 409 })

    expect(await inspector.slotHold.findUnique({ where: { id: first.id } })).toMatchObject({
      id: first.id,
      heldForReservationId: reservation.id,
      startsAt: firstTarget.startsAt,
    })
    expect(await inspector.slotHold.count({ where: { venueId, heldForReservationId: reservation.id } })).toBe(1)
  })

  it('rejects off-grid replacement before deleting H1', async () => {
    const reservation = await createAppointmentReservation()
    const firstTarget = futureWindow(23)
    const first = await mintRescheduleAppointmentHold({
      venueId,
      reservationId: reservation.id,
      requestedStartsAt: firstTarget.startsAt,
    })
    const offGrid = futureWindow(24, 60, 12, 7)

    await expect(
      mintRescheduleAppointmentHold({
        venueId,
        reservationId: reservation.id,
        requestedStartsAt: offGrid.startsAt,
      }),
    ).rejects.toMatchObject({ statusCode: 409, message: 'Ese horario ya no está disponible, elige otro.' })
    expect(await inspector.slotHold.findUnique({ where: { id: first.id } })).not.toBeNull()
  })

  it.each([
    ['60→90', 60, 90],
    ['90→60', 90, 60],
  ])('keeps historical Reservation.duration after Product changes %s', async (_label, reservationDuration, currentDuration) => {
    const reservation = await createAppointmentReservation({ duration: reservationDuration })
    await prisma.product.update({ where: { id: productA }, data: { duration: currentDuration } })
    const target = futureWindow(25, reservationDuration)

    const hold = await mintRescheduleAppointmentHold({
      venueId,
      reservationId: reservation.id,
      requestedStartsAt: target.startsAt,
    })
    const stored = await inspector.slotHold.findUniqueOrThrow({ where: { id: hold.id } })

    expect(stored.endsAt).toEqual(new Date(target.startsAt.getTime() + reservationDuration * 60_000))
    expect(stored.productIds).toEqual([productA])
    expect(stored.heldForReservationId).toBe(reservation.id)
  })

  it('allows exactly one winner when two consumers race for the same tagged hold', async () => {
    const reservation = await createAppointmentReservation()
    const target = futureWindow(27)
    const hold = await mintRescheduleAppointmentHold({
      venueId,
      reservationId: reservation.id,
      requestedStartsAt: target.startsAt,
    })

    const results = await Promise.allSettled([
      consume(reservation.id, hold.id, target.startsAt),
      consume(reservation.id, hold.id, target.startsAt),
    ])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ statusCode: 409 })
    expect(await inspector.slotHold.count({ where: { id: hold.id } })).toBe(0)
    expect(await inspector.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).toMatchObject({
      startsAt: target.startsAt,
      endsAt: target.endsAt,
      duration: 60,
    })
  })

  it('consumes after an operator overfills pacing because the valid hold owns that promise', async () => {
    const reservation = await createAppointmentReservation()
    const target = futureWindow(28)
    const hold = await mintRescheduleAppointmentHold({
      venueId,
      reservationId: reservation.id,
      requestedStartsAt: target.startsAt,
    })
    await createAppointmentReservation({ window: target })

    await expect(consume(reservation.id, hold.id, target.startsAt)).resolves.toMatchObject({
      startsAt: target.startsAt,
      endsAt: target.endsAt,
    })
    expect(await inspector.reservation.count({ where: { venueId, startsAt: target.startsAt } })).toBe(2)
    expect(await inspector.slotHold.count({ where: { id: hold.id } })).toBe(0)
  })

  it('checks expiry after waiting on the venue lock and preserves the expired token', async () => {
    const reservation = await createAppointmentReservation()
    const target = futureWindow(29)
    const hold = await mintRescheduleAppointmentHold({
      venueId,
      reservationId: reservation.id,
      requestedStartsAt: target.startsAt,
    })

    let signalReady!: () => void
    const ready = new Promise<void>(resolve => {
      signalReady = resolve
    })
    let release!: () => void
    const permit = new Promise<void>(resolve => {
      release = resolve
    })
    const holder = lockHolder.$transaction(
      async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'apt-hold:' + venueId}))`
        signalReady()
        await permit
      },
      { timeout: 5_000 },
    )

    let consuming:
      | Promise<{ status: 'fulfilled'; value: Awaited<ReturnType<typeof consume>> } | { status: 'rejected'; reason: unknown }>
      | undefined
    try {
      await ready
      await prisma.slotHold.update({
        where: { id: hold.id },
        data: { expiresAt: new Date(Date.now() + 400) },
      })
      const liveBeforeConsume = await inspector.slotHold.findUniqueOrThrow({ where: { id: hold.id } })
      expect(liveBeforeConsume.expiresAt.getTime()).toBeGreaterThan(Date.now())
      consuming = consume(reservation.id, hold.id, target.startsAt).then(
        value => ({ status: 'fulfilled' as const, value }),
        reason => ({ status: 'rejected' as const, reason }),
      )
      await new Promise(resolve => setTimeout(resolve, 650))
    } finally {
      release()
      await holder
    }

    const result = await consuming!
    expect(result.status).toBe('rejected')
    if (result.status === 'rejected') expect(result.reason).toMatchObject({ statusCode: 409 })
    expect(await inspector.slotHold.count({ where: { id: hold.id } })).toBe(1)
    expect(await inspector.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).toMatchObject({
      startsAt: reservation.startsAt,
      endsAt: reservation.endsAt,
    })
  })

  it('accepts the exact single-service Release A null-tag shape and emits its metric once', async () => {
    const reservation = await createAppointmentReservation({ productIds: [] })
    const target = futureWindow(30)
    const hold = await createLegacyRescheduleHold({ reservation, window: target, productIds: [productA] })

    await consume(reservation.id, hold.id, target.startsAt)

    const metricCalls = (logger.warn as jest.Mock).mock.calls.filter(
      ([message]) => message === '[slot-hold] Release A legacy reschedule hold consumed',
    )
    expect(metricCalls).toEqual([
      [
        '[slot-hold] Release A legacy reschedule hold consumed',
        {
          metric: 'reservation_reschedule_hold_release_a_grace',
          venueId,
          reservationId: reservation.id,
          holdId: hold.id,
        },
      ],
    ])
    expect(await inspector.slotHold.count({ where: { id: hold.id } })).toBe(0)
  })

  it('accepts multi-service R[A,B]+legacy[A] but rejects a null-tag canonical [A,B]', async () => {
    const acceptedReservation = await createAppointmentReservation({
      duration: 90,
      productIds: [productA, productB],
    })
    const acceptedTarget = futureWindow(31, 90)
    const acceptedHold = await createLegacyRescheduleHold({
      reservation: acceptedReservation,
      window: acceptedTarget,
      productIds: [productA],
    })
    await expect(consume(acceptedReservation.id, acceptedHold.id, acceptedTarget.startsAt)).resolves.toBeDefined()

    const rejectedReservation = await createAppointmentReservation({
      window: futureWindow(12, 90),
      duration: 90,
      productIds: [productA, productB],
    })
    const rejectedTarget = futureWindow(32, 90)
    const rejectedHold = await createLegacyRescheduleHold({
      reservation: rejectedReservation,
      window: rejectedTarget,
      productIds: [productA, productB],
    })

    await expect(consume(rejectedReservation.id, rejectedHold.id, rejectedTarget.startsAt)).rejects.toMatchObject({ statusCode: 409 })
    expect(await inspector.slotHold.count({ where: { id: rejectedHold.id } })).toBe(1)
    expect(await inspector.reservation.findUniqueOrThrow({ where: { id: rejectedReservation.id } })).toMatchObject({
      startsAt: rejectedReservation.startsAt,
      endsAt: rejectedReservation.endsAt,
    })
  })

  it('does not let a tagged R1 token move R2 and preserves the candidate', async () => {
    const first = await createAppointmentReservation()
    const second = await createAppointmentReservation({ window: futureWindow(13) })
    const target = futureWindow(33)
    const hold = await mintRescheduleAppointmentHold({
      venueId,
      reservationId: first.id,
      requestedStartsAt: target.startsAt,
    })

    await expect(consume(second.id, hold.id, target.startsAt)).rejects.toMatchObject({ statusCode: 409 })
    expect(await inspector.slotHold.count({ where: { id: hold.id } })).toBe(1)
    expect(await inspector.reservation.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({
      startsAt: second.startsAt,
      endsAt: second.endsAt,
    })
  })

  it('does not let a normal create consume a tagged reschedule token', async () => {
    const reservation = await createAppointmentReservation()
    const target = futureWindow(33)
    const hold = await mintRescheduleAppointmentHold({
      venueId,
      reservationId: reservation.id,
      requestedStartsAt: target.startsAt,
    })
    await prisma.reservationSettings.update({
      where: { venueId },
      data: { pacingMaxPerSlot: 2 },
    })

    await expect(
      createReservation(
        venueId,
        {
          startsAt: target.startsAt,
          endsAt: target.endsAt,
          duration: 60,
          productId: productA,
        },
        { writeOrigin: 'PUBLIC', appointmentHoldId: hold.id },
      ),
    ).rejects.toMatchObject({ statusCode: 409 })

    expect(await inspector.reservation.count({ where: { venueId, startsAt: target.startsAt } })).toBe(0)
    expect(await inspector.slotHold.count({ where: { id: hold.id } })).toBe(1)
  })

  it('preserves R/H during Feature downgrade and consumes the same token after reactivation', async () => {
    const reservation = await createAppointmentReservation()
    const target = futureWindow(34)
    const hold = await mintRescheduleAppointmentHold({
      venueId,
      reservationId: reservation.id,
      requestedStartsAt: target.startsAt,
    })
    await prisma.venue.update({ where: { id: venueId }, data: { seatCapExempt: false } })

    await expect(consume(reservation.id, hold.id, target.startsAt)).rejects.toMatchObject({
      statusCode: 403,
      code: 'PLAN_REQUIRED',
    })
    expect(await inspector.slotHold.count({ where: { id: hold.id } })).toBe(1)
    expect(await inspector.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).toMatchObject({
      startsAt: reservation.startsAt,
    })

    await prisma.venue.update({ where: { id: venueId }, data: { seatCapExempt: true } })
    await expect(consume(reservation.id, hold.id, target.startsAt)).resolves.toMatchObject({ startsAt: target.startsAt })
    expect(await inspector.slotHold.count({ where: { id: hold.id } })).toBe(0)
  })

  it('preserves tagged holds for metadata, then deletes them atomically on a successful identity update', async () => {
    const reservation = await createAppointmentReservation()
    const heldTarget = futureWindow(35)
    const hold = await mintRescheduleAppointmentHold({
      venueId,
      reservationId: reservation.id,
      requestedStartsAt: heldTarget.startsAt,
    })

    await updateReservation(venueId, reservation.id, { guestName: 'Metadata' }, { writeOrigin: 'DASHBOARD' }, 'integration-actor')
    expect(await inspector.slotHold.count({ where: { id: hold.id } })).toBe(1)

    const administrativeTarget = futureWindow(36)
    await updateReservation(
      venueId,
      reservation.id,
      { ...administrativeTarget, duration: 60 },
      { writeOrigin: 'DASHBOARD' },
      'integration-actor',
    )
    expect(await inspector.slotHold.count({ where: { id: hold.id } })).toBe(0)
    expect(await inspector.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).toMatchObject({
      startsAt: administrativeTarget.startsAt,
      endsAt: administrativeTarget.endsAt,
    })
  })

  it('rolls back tagged-hold invalidation when the later identity update fails', async () => {
    const reservation = await createAppointmentReservation()
    const heldTarget = futureWindow(37)
    const hold = await mintRescheduleAppointmentHold({
      venueId,
      reservationId: reservation.id,
      requestedStartsAt: heldTarget.startsAt,
    })
    const administrativeTarget = futureWindow(38)

    await expect(
      updateReservation(
        venueId,
        reservation.id,
        {
          ...administrativeTarget,
          duration: 60,
          // PostgreSQL rejects NUL in text only when the Reservation UPDATE
          // executes, after the tagged hold was deleted inside the tx.
          guestEmail: 'rollback\u0000@example.test',
        },
        { writeOrigin: 'DASHBOARD' },
        'integration-actor',
      ),
    ).rejects.toBeDefined()

    expect(await inspector.slotHold.count({ where: { id: hold.id } })).toBe(1)
    expect(await inspector.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).toMatchObject({
      startsAt: reservation.startsAt,
      endsAt: reservation.endsAt,
      guestEmail: null,
    })
  })

  it('treats a cancelled parent hold as non-live and refuses to consume it', async () => {
    const reservation = await createAppointmentReservation()
    const otherReservation = await createAppointmentReservation({ window: futureWindow(14) })
    const target = futureWindow(39)
    const hold = await mintRescheduleAppointmentHold({
      venueId,
      reservationId: reservation.id,
      requestedStartsAt: target.startsAt,
    })
    await prisma.reservation.update({
      where: { id: reservation.id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: 'SYSTEM' },
    })

    await expect(
      countAppointmentOccupancy(prisma, {
        venueId,
        startsAt: target.startsAt,
        endsAt: target.endsAt,
        checkedAt: new Date(),
      }),
    ).resolves.toEqual({ reservations: 0, holds: 0 })
    const otherHold = await mintRescheduleAppointmentHold({
      venueId,
      reservationId: otherReservation.id,
      requestedStartsAt: target.startsAt,
    })
    await expect(consume(reservation.id, hold.id, target.startsAt)).rejects.toMatchObject({ statusCode: 409 })
    expect(await inspector.slotHold.count({ where: { id: hold.id } })).toBe(1)
    expect(await inspector.slotHold.count({ where: { id: otherHold.id } })).toBe(1)
  })
})
