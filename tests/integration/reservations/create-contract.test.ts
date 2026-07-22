import { Prisma, PrismaClient } from '@prisma/client'

jest.mock('@/communication/rabbitmq/gcal-push-consumer', () => ({
  __esModule: true,
  publishPushNotification: jest.fn().mockResolvedValue(undefined),
}))

import prisma from '@/utils/prismaClient'
import { BadRequestError } from '@/errors/AppError'
import { createReservation } from '@/services/dashboard/reservation.dashboard.service'

const fixtureKey = `reservation-create-contract-${process.pid}-${Date.now()}`
const inspector = new PrismaClient()
const venueIds: string[] = []
const staffIds: string[] = []
let organizationId: string
let venueId: string
let foreignVenueId: string
let productA: string
let productB: string
let foreignProduct: string
let modifierId: string
let staffA: string
let staffB: string
let sequence = 0

function nextWindow(durationMin: number) {
  sequence += 1
  const startsAt = new Date(Date.now() + (48 * 60 + sequence * 180) * 60_000)
  startsAt.setUTCSeconds(0, 0)
  return { startsAt, endsAt: new Date(startsAt.getTime() + durationMin * 60_000) }
}

function staffWindow(dayOffset = 0, durationMin = 60) {
  const today = new Date()
  const startsAt = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 10 + dayOffset, 12, 0, 0))
  return { startsAt, endsAt: new Date(startsAt.getTime() + durationMin * 60_000) }
}

async function createVenue(suffix: string) {
  const venue = await prisma.venue.create({
    data: {
      organizationId,
      name: `${fixtureKey}-${suffix}`,
      slug: `${fixtureKey}-${suffix}`,
      timezone: 'UTC',
    },
  })
  venueIds.push(venue.id)
  const category = await prisma.menuCategory.create({
    data: {
      venueId: venue.id,
      name: `${fixtureKey}-${suffix}-services`,
      slug: `${fixtureKey}-${suffix}-services`,
      availableDays: [],
    },
  })
  await prisma.reservationSettings.create({
    data: {
      venueId: venue.id,
      minNoticeMin: 0,
      maxAdvanceDays: 365,
      capacityMode: 'pacing',
      googleCalendarPushEnabled: false,
    },
  })
  return { venue, category }
}

async function createAppointment(args: { venueId: string; categoryId: string; suffix: string; duration: number; price: number }) {
  return prisma.product.create({
    data: {
      venueId: args.venueId,
      categoryId: args.categoryId,
      sku: `${fixtureKey}-${args.suffix}`,
      name: `${fixtureKey}-${args.suffix}`,
      type: 'APPOINTMENTS_SERVICE',
      duration: args.duration,
      price: new Prisma.Decimal(args.price),
      tags: [],
      allergens: [],
    },
  })
}

async function cleanupFixtures() {
  if (venueIds.length > 0) await prisma.venue.deleteMany({ where: { id: { in: venueIds } } })
  if (staffIds.length > 0) await prisma.staff.deleteMany({ where: { id: { in: staffIds } } })
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

    const local = await createVenue('local')
    const foreign = await createVenue('foreign')
    venueId = local.venue.id
    foreignVenueId = foreign.venue.id

    const [first, second, foreignRow] = await Promise.all([
      createAppointment({ venueId, categoryId: local.category.id, suffix: 'a', duration: 60, price: 500 }),
      createAppointment({ venueId, categoryId: local.category.id, suffix: 'b', duration: 30, price: 300 }),
      createAppointment({ venueId: foreignVenueId, categoryId: foreign.category.id, suffix: 'foreign', duration: 30, price: 200 }),
    ])
    productA = first.id
    productB = second.id
    foreignProduct = foreignRow.id

    const group = await prisma.modifierGroup.create({
      data: { venueId, name: `${fixtureKey}-extras`, required: false, allowMultiple: true },
    })
    const modifier = await prisma.modifier.create({
      data: { groupId: group.id, name: 'Tiempo extra', price: new Prisma.Decimal(25), durationMin: 15 },
    })
    modifierId = modifier.id
    await prisma.productModifierGroup.create({ data: { productId: productA, groupId: group.id } })

    const createdStaff = await Promise.all(
      ['a', 'b'].map(suffix =>
        prisma.staff.create({
          data: {
            email: `${fixtureKey}-staff-${suffix}@example.test`,
            firstName: `Staff ${suffix.toUpperCase()}`,
            lastName: fixtureKey,
            active: true,
          },
        }),
      ),
    )
    staffA = createdStaff[0].id
    staffB = createdStaff[1].id
    staffIds.push(staffA, staffB)
    const memberships = await Promise.all(
      createdStaff.map(staff => prisma.staffVenue.create({ data: { venueId, staffId: staff.id, role: 'MANAGER', active: true } })),
    )
    const allDay = Object.fromEntries(
      ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(day => [
        day,
        { enabled: true, ranges: [{ open: '00:00', close: '23:59' }] },
      ]),
    )
    await prisma.productStaff.createMany({
      data: memberships.flatMap(membership => [productA, productB].map(productId => ({ venueId, productId, staffVenueId: membership.id }))),
    })
    await Promise.all(
      memberships.map(membership => prisma.staffSchedule.create({ data: { venueId, staffVenueId: membership.id, weekly: allDay } })),
    )
  } catch (error) {
    await cleanupFixtures()
    throw error
  }
})

beforeEach(async () => {
  sequence = 0
  await prisma.slotHold.deleteMany({ where: { venueId } })
  await prisma.reservation.deleteMany({ where: { venueId } })
  await prisma.reservationSettings.update({
    where: { venueId },
    data: { capacityMode: 'pacing', showStaffPicker: false, pacingMaxPerSlot: null },
  })
})

afterAll(async () => {
  try {
    await cleanupFixtures()
  } finally {
    await inspector.$disconnect()
  }
})

describe('createReservation PostgreSQL contract', () => {
  it('stores scalar legacy identity as [] and an explicit list atomically in request order', async () => {
    const scalarWindow = nextWindow(60)
    const scalar = await createReservation(venueId, { ...scalarWindow, duration: 60, productId: productA }, { writeOrigin: 'DASHBOARD' })

    const listWindow = nextWindow(90)
    const explicit = await createReservation(
      venueId,
      {
        ...listWindow,
        duration: 5,
        productId: productA,
        productIds: [productA, productB],
      },
      { writeOrigin: 'DASHBOARD', windowSemantics: 'base' },
    )

    const rows = await inspector.reservation.findMany({
      where: { id: { in: [scalar.id, explicit.id] } },
      select: { id: true, productId: true, productIds: true, duration: true },
    })
    const byId = new Map(rows.map(row => [row.id, row]))
    expect(byId.get(scalar.id)).toMatchObject({ productId: productA, productIds: [], duration: 60 })
    expect(byId.get(explicit.id)).toMatchObject({ productId: productA, productIds: [productA, productB], duration: 90 })
  })

  it('persists one canonical modifier result and the final interval in the same transaction', async () => {
    const window = nextWindow(60)
    const created = await createReservation(
      venueId,
      {
        ...window,
        duration: 5,
        productId: productA,
        productIds: [productA],
        modifierSelections: [{ productId: productA, modifierId, quantity: 1 }],
      },
      { writeOrigin: 'DASHBOARD', windowSemantics: 'base' },
    )

    const stored = await inspector.reservation.findUniqueOrThrow({
      where: { id: created.id },
      include: { modifiers: true },
    })
    expect(stored.productIds).toEqual([productA])
    expect(stored.duration).toBe(75)
    expect(stored.endsAt).toEqual(new Date(window.startsAt.getTime() + 75 * 60_000))
    expect(stored.modifiers).toHaveLength(1)
    expect(stored.modifiers[0]).toMatchObject({ productId: productA, modifierId, name: 'Tiempo extra', quantity: 1 })
    expect(stored.modifiers[0].price.toString()).toBe('25')
  })

  it('rolls back a foreign second product before Reservation, modifier, or outbox writes', async () => {
    const window = nextWindow(90)

    await expect(
      createReservation(
        venueId,
        {
          ...window,
          duration: 90,
          productId: productA,
          productIds: [productA, foreignProduct],
          modifierSelections: [{ productId: productA, modifierId }],
        },
        { writeOrigin: 'DASHBOARD', windowSemantics: 'base' },
      ),
    ).rejects.toBeInstanceOf(BadRequestError)

    expect(await inspector.reservation.count({ where: { venueId } })).toBe(0)
    expect(await inspector.reservationModifier.count({ where: { reservation: { venueId } } })).toBe(0)
    expect(await inspector.calendarSyncOutbox.count({ where: { venueId } })).toBe(0)
  })

  it('returns the legacy staff-aware duration floor conflict with zero writes', async () => {
    await prisma.reservationSettings.update({ where: { venueId }, data: { capacityMode: 'per_staff' } })
    const window = nextWindow(5)

    await expect(
      createReservation(venueId, { ...window, duration: 60, productId: productA }, { writeOrigin: 'DASHBOARD' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'APPOINTMENT_WINDOW_CHANGED' })

    expect(await inspector.reservation.count({ where: { venueId } })).toBe(0)
    expect(await inspector.reservationModifier.count({ where: { reservation: { venueId } } })).toBe(0)
    expect(await inspector.calendarSyncOutbox.count({ where: { venueId } })).toBe(0)
  })

  it('excludes only its trusted own hold from staff and pacing checks at pacing one', async () => {
    await prisma.reservationSettings.update({
      where: { venueId },
      data: { capacityMode: 'per_staff', showStaffPicker: true, pacingMaxPerSlot: 1 },
    })
    const window = staffWindow(1)
    const hold = await prisma.slotHold.create({
      data: {
        venueId,
        startsAt: window.startsAt,
        endsAt: window.endsAt,
        productIds: [productA],
        staffId: staffA,
        partySize: 1,
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    })

    const created = await createReservation(
      venueId,
      {
        ...window,
        duration: 60,
        productId: productA,
        productIds: [productA],
        assignedStaffId: staffA,
      },
      { writeOrigin: 'PUBLIC', windowSemantics: 'base', validatedHoldId: hold.id },
    )

    expect(created.assignedStaffId).toBe(staffA)
    expect(await inspector.reservation.count({ where: { venueId, startsAt: window.startsAt, endsAt: window.endsAt } })).toBe(1)
    expect(await inspector.slotHold.count({ where: { id: hold.id } })).toBe(1)
  })

  it('still blocks on another live hold when the trusted own hold is excluded', async () => {
    await prisma.reservationSettings.update({
      where: { venueId },
      data: { capacityMode: 'per_staff', showStaffPicker: true, pacingMaxPerSlot: 1 },
    })
    const window = staffWindow(2)
    const [ownHold, competingHold] = await Promise.all(
      [staffA, staffB].map(staffId =>
        prisma.slotHold.create({
          data: {
            venueId,
            ...window,
            productIds: [productA],
            staffId,
            partySize: 1,
            expiresAt: new Date(Date.now() + 10 * 60_000),
          },
        }),
      ),
    )

    const failure = await createReservation(
      venueId,
      {
        ...window,
        duration: 60,
        productId: productA,
        productIds: [productA],
        assignedStaffId: staffA,
        modifierSelections: [{ productId: productA, modifierId }],
      },
      { writeOrigin: 'PUBLIC', windowSemantics: 'base', validatedHoldId: ownHold.id },
    ).catch(error => error)

    expect(failure).toMatchObject({ statusCode: 409, code: undefined, details: undefined })
    expect(await inspector.reservation.count({ where: { venueId, startsAt: window.startsAt, endsAt: window.endsAt } })).toBe(0)
    expect(await inspector.reservationModifier.count({ where: { reservation: { venueId } } })).toBe(0)
    expect(await inspector.calendarSyncOutbox.count({ where: { venueId } })).toBe(0)
    expect(await inspector.slotHold.count({ where: { id: { in: [ownHold.id, competingHold.id] } } })).toBe(2)
  })

  it('keeps resource and pacing independent by assigning B when A is busy and pacing is two', async () => {
    await prisma.reservationSettings.update({
      where: { venueId },
      data: { capacityMode: 'per_staff', showStaffPicker: true, pacingMaxPerSlot: 2 },
    })
    const window = staffWindow(2)
    await prisma.reservation.create({
      data: {
        venueId,
        confirmationCode: `CREATE-CONTRACT-A-${process.pid}`,
        status: 'CONFIRMED',
        channel: 'DASHBOARD',
        ...window,
        duration: 60,
        productId: productA,
        productIds: [productA],
        assignedStaffId: staffA,
        partySize: 1,
      },
    })

    const created = await createReservation(
      venueId,
      { ...window, duration: 60, productId: productA, productIds: [productA] },
      { writeOrigin: 'PUBLIC', windowSemantics: 'base' },
    )

    expect(created.assignedStaffId).toBe(staffB)
    expect(await inspector.reservation.count({ where: { venueId, startsAt: window.startsAt, endsAt: window.endsAt } })).toBe(2)
  })

  it('writes nothing on the recoverable dashboard conflict and returns overCapacity only after consent', async () => {
    await prisma.reservationSettings.update({
      where: { venueId },
      data: { capacityMode: 'per_staff', showStaffPicker: true, pacingMaxPerSlot: 1 },
    })
    const window = staffWindow(3)
    await prisma.reservation.create({
      data: {
        venueId,
        confirmationCode: `CREATE-CONTRACT-FULL-${process.pid}`,
        status: 'CONFIRMED',
        channel: 'DASHBOARD',
        ...window,
        duration: 60,
        productId: productA,
        productIds: [productA],
        assignedStaffId: staffA,
        partySize: 1,
      },
    })
    const attempted = {
      ...window,
      duration: 60,
      productId: productA,
      productIds: [productA],
      modifierSelections: [{ productId: productA, modifierId }],
    }

    await expect(createReservation(venueId, attempted, { writeOrigin: 'DASHBOARD', windowSemantics: 'base' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'OVER_CAPACITY_CONFIRMATION_REQUIRED',
      details: { preview: { occupancy: 1, limit: 1 } },
    })
    expect(await inspector.reservation.count({ where: { venueId, startsAt: window.startsAt } })).toBe(1)
    expect(await inspector.reservationModifier.count({ where: { reservation: { venueId } } })).toBe(0)
    expect(await inspector.calendarSyncOutbox.count({ where: { venueId } })).toBe(0)

    const consented = await createReservation(venueId, attempted, {
      writeOrigin: 'DASHBOARD',
      windowSemantics: 'base',
      allowOverCapacity: true,
    })
    expect(consented).toMatchObject({ assignedStaffId: staffB, overCapacity: true })
  })

  it('retries a real SQLSTATE 40001 and leaves exactly one reservation plus one modifier', async () => {
    const sqlName = `reservation_retry_${process.pid}_${Date.now()}`
    const sequenceName = `${sqlName}_seq`
    const functionName = `${sqlName}_fn`
    const triggerName = `${sqlName}_trigger`
    const escapedVenueId = venueId.replace(/'/g, "''")

    try {
      await inspector.$executeRawUnsafe(`CREATE SEQUENCE "${sequenceName}" START 1`)
      await inspector.$executeRawUnsafe(`
        CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
        BEGIN
          IF NEW."venueId" = '${escapedVenueId}' AND nextval('"${sequenceName}"') = 1 THEN
            RAISE EXCEPTION 'fixture serialization retry' USING ERRCODE = '40001';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `)
      await inspector.$executeRawUnsafe(
        `CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "Reservation" FOR EACH ROW EXECUTE FUNCTION "${functionName}"()`,
      )

      const window = nextWindow(60)
      const created = await createReservation(
        venueId,
        {
          ...window,
          duration: 60,
          productId: productA,
          productIds: [productA],
          modifierSelections: [{ productId: productA, modifierId }],
        },
        { writeOrigin: 'DASHBOARD', windowSemantics: 'base' },
      )

      const [rows, modifierRows, sequenceState] = await Promise.all([
        inspector.reservation.findMany({ where: { venueId }, select: { id: true, productId: true, productIds: true, duration: true } }),
        inspector.reservationModifier.findMany({ where: { reservation: { venueId } } }),
        inspector.$queryRawUnsafe<Array<{ last_value: bigint }>>(`SELECT last_value FROM "${sequenceName}"`),
      ])
      expect(rows).toEqual([{ id: created.id, productId: productA, productIds: [productA], duration: 75 }])
      expect(modifierRows).toHaveLength(1)
      expect(Number(sequenceState[0].last_value)).toBe(2)
    } finally {
      await inspector.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "Reservation"`)
      await inspector.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`)
      await inspector.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS "${sequenceName}"`)
    }
  })
})
